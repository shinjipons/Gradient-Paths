import { clamp01, type Vec3 } from "../color/convert";
import { isRealColor, type ColorSpace } from "../color/spaces";
import type { Sample } from "../path/paths";
import { PLANE_EDGE, project, unproject, type Plane } from "./plane";

export type Handle = { kind: "a" | "b" } | { kind: "point"; index: number };

export interface SliceCallbacks {
  onDragStart(): void;
  onDragEnd(): void;
  onEndpoint(which: "a" | "b", rgb: Vec3): void;
  onPoint(index: number, embed: Vec3): void;
  onAddPoint(embed: Vec3): void;
}

interface DrawInput {
  space: ColorSpace;
  plane: Plane;
  A: Vec3;
  B: Vec3;
  aColor: string;
  bColor: string;
  points: Vec3[];
  showPolygon: boolean;
  canAdd: boolean;
  dense: Sample[];
  stops: Sample[];
}

/** Background raster: at most this many columns, at least 2 screen px each. */
const MAX_COLS = 360;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 40;
/** Wheel deltas this big (pixel mode) are mouse notches, not trackpad scrolls. */
const WHEEL_NOTCH_MIN = 40;

/**
 * 2D slice through the current space. The background is the slice itself
 * (pixels outside sRGB are hatched); the path is drawn projected onto it, and
 * endpoints / control points are draggable within the plane.
 */
export class SliceView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bg = document.createElement("canvas");
  private bgKey = "";
  private input: DrawInput | null = null;
  /** `sx`/`sy`: where the drag began; `x`/`y`: the latest pointer position. */
  private drag: { handle: Handle; start: Vec3; sx: number; sy: number; x: number; y: number } | null = null;
  private pan: { x: number; y: number } | null = null;
  private hover: Handle | null = null;
  /** View transform over the fitted layout: screen = fitted * zoom + offset. */
  private zoom = 1;
  private tx = 0;
  private ty = 0;

  constructor(
    private container: HTMLElement,
    private cb: SliceCallbacks,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "slice-canvas";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    new ResizeObserver(() => {
      this.sizeCache = null;
      this.draw();
    }).observe(container);
    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("pointercancel", this.onUp);
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);
    this.canvas.addEventListener("dblclick", this.onDbl);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    // Middle press opens autoscroll in Chrome; right press opens the menu.
    this.canvas.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /** Back to the fitted view. */
  resetView() {
    this.zoom = 1;
    this.tx = this.ty = 0;
    this.draw();
  }

  private zoomAt(x: number, y: number, factor: number) {
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    const f = k / this.zoom;
    // Keep the point under the cursor fixed.
    this.tx = x - (x - this.tx) * f;
    this.ty = y - (y - this.ty) * f;
    this.zoom = k;
    this.draw();
  }

  /** Pixels at the top and bottom covered by floating UI; the plot centers between them. */
  private insetTop = 0;
  private insetBottom = 0;
  setInsets(top: number, bottom: number) {
    if (Math.abs(top - this.insetTop) < 1 && Math.abs(bottom - this.insetBottom) < 1) return;
    this.insetTop = top;
    this.insetBottom = bottom;
    this.sizeCache = null;
    this.draw();
  }

  get dragging() {
    return this.drag !== null;
  }

  update(input: DrawInput) {
    this.input = input;
    this.draw();
  }

  // --- coordinates -----------------------------------------------------------

  private sizeCache: { w: number; h: number; s: number; ox: number; oy: number } | null = null;

  /** Fitted plot layout; cached because every coordinate conversion needs it. */
  private size() {
    return (this.sizeCache ??= this.measure());
  }

  private measure() {
    const r = this.container.getBoundingClientRect();
    // Use the uncovered area, unless that would leave the plot too small.
    let top = this.insetTop;
    let visH = r.height - this.insetTop - this.insetBottom;
    if (visH < 200) {
      top = 0;
      visH = r.height;
    }
    const s = Math.max(120, Math.min(r.width, visH) - 16);
    return { w: r.width, h: r.height, s, ox: (r.width - s) / 2, oy: top + (visH - s) / 2 };
  }

  private toPx(pl: Plane, uv: [number, number]): [number, number] {
    const { s, ox, oy } = this.size();
    const [u0, u1, v0, v1] = pl.view;
    const fx = ox + ((uv[0] - u0) / (u1 - u0)) * s;
    const fy = oy + (1 - (uv[1] - v0) / (v1 - v0)) * s;
    return [fx * this.zoom + this.tx, fy * this.zoom + this.ty];
  }

  private toPlane(pl: Plane, x: number, y: number): [number, number] {
    const { s, ox, oy } = this.size();
    const [u0, u1, v0, v1] = pl.view;
    const fx = (x - this.tx) / this.zoom;
    const fy = (y - this.ty) / this.zoom;
    return [u0 + ((fx - ox) / s) * (u1 - u0), v0 + (1 - (fy - oy) / s) * (v1 - v0)];
  }

  // --- background ------------------------------------------------------------

  /** Rasterize the slice under the whole canvas, at the current pan and zoom. */
  private renderBackground(space: ColorSpace, pl: Plane, w: number, h: number) {
    if (!(w > 0 && h > 0)) return; // container not laid out yet
    const cols = Math.max(2, Math.min(MAX_COLS, Math.ceil(w / 2)));
    const rows = Math.max(2, Math.round((cols * h) / w));
    const { s: fs, ox, oy } = this.size();
    const key = JSON.stringify(
      [space.id, pl.origin, pl.u, pl.v, pl.view, cols, rows, this.zoom, this.tx, this.ty, fs, ox, oy]
        .flat(2)
        .map((x) => (typeof x === "number" ? x.toFixed(4) : x)),
    );
    if (key === this.bgKey) return;
    this.bgKey = key;
    this.bg.width = cols;
    this.bg.height = rows;
    const g = this.bg.getContext("2d")!;
    const img = g.createImageData(cols, rows);
    // Screen → plane is affine, so step it instead of converting every pixel.
    const [s0, t0] = this.toPlane(pl, 0, 0);
    const [sx, tx] = this.toPlane(pl, 1, 0);
    const [sy, ty] = this.toPlane(pl, 0, 1);
    // Color of the slice at fractional pixel (fi, fj); `inside` is false off the gamut.
    const out: [number, number, number] = [0, 0, 0];
    const sample = (fi: number, fj: number): boolean => {
      const x = (fi / cols) * w;
      const y = (fj / rows) * h;
      const s = s0 + (sx - s0) * x + (sy - s0) * y;
      const t = t0 + (tx - t0) * x + (ty - t0) * y;
      const native = space.unembed(unproject(pl, s, t));
      const rgb = space.toRGB(native);
      if (!(rgb.every(Number.isFinite) && isRealColor(space, native, rgb))) return false;
      out[0] = clamp01(rgb[0]) * 255;
      out[1] = clamp01(rgb[1]) * 255;
      out[2] = clamp01(rgb[2]) * 255;
      return true;
    };
    const hatchAt = (i: number, j: number) => (((i + j) >> 2) % 2 === 0 ? 34 : 28);

    // Pass 1: one sample per pixel at its center.
    const inside = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const ok = sample(i + 0.5, j + 0.5);
        inside[k] = ok ? 1 : 0;
        const d = k * 4;
        if (ok) {
          img.data[d] = out[0];
          img.data[d + 1] = out[1];
          img.data[d + 2] = out[2];
        } else {
          img.data[d] = img.data[d + 1] = img.data[d + 2] = hatchAt(i, j);
        }
        img.data[d + 3] = 255;
      }
    }

    // Pass 2: pixels on the gamut's edge are supersampled, so the boundary gets
    // partial coverage instead of a staircase.
    const N = 4;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const v = inside[k];
        const edge =
          (i > 0 && inside[k - 1] !== v) ||
          (i < cols - 1 && inside[k + 1] !== v) ||
          (j > 0 && inside[k - cols] !== v) ||
          (j < rows - 1 && inside[k + cols] !== v);
        if (!edge) continue;
        let r = 0, gr = 0, b = 0;
        const hatch = hatchAt(i, j);
        for (let m = 0; m < N; m++) {
          for (let n = 0; n < N; n++) {
            if (sample(i + (n + 0.5) / N, j + (m + 0.5) / N)) {
              r += out[0]; gr += out[1]; b += out[2];
            } else {
              r += hatch; gr += hatch; b += hatch;
            }
          }
        }
        const d = k * 4;
        img.data[d] = r / (N * N);
        img.data[d + 1] = gr / (N * N);
        img.data[d + 2] = b / (N * N);
      }
    }
    g.putImageData(img, 0, 0);
  }

  // --- drawing ---------------------------------------------------------------

  private handles(): { h: Handle; p: Vec3 }[] {
    const inp = this.input!;
    return [
      ...inp.points.map((p, index) => ({ h: { kind: "point", index } as Handle, p })),
      { h: { kind: "a" }, p: inp.A },
      { h: { kind: "b" }, p: inp.B },
    ];
  }

  draw() {
    const inp = this.input;
    if (!inp) return;
    const { w, h } = this.size();
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pl = inp.plane;

    this.renderBackground(inp.space, pl, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.bg, 0, 0, w, h);

    // The plane's bounds, dotted in the same color as the plane outline in 3D.
    {
      const [u0, u1, v0, v1] = pl.view;
      const c = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map((uv) => this.toPx(pl, uv as [number, number]));
      ctx.lineCap = "round";
      ctx.setLineDash([0, 6]);
      for (const [width, color] of [[5, "rgba(0,0,0,0.6)"], [2.5, PLANE_EDGE]] as const) {
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(...c[0]);
        for (const p of c.slice(1)) ctx.lineTo(...p);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineCap = "butt";
    }

    // Neutral axis, projected.
    const [n0, n1] = inp.space.neutral;
    const a0 = this.toPx(pl, project(pl, n0));
    const a1 = this.toPx(pl, project(pl, n1));
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(...a0);
    ctx.lineTo(...a1);
    ctx.stroke();
    ctx.setLineDash([]);

    // Control polygon.
    if (inp.showPolygon && inp.points.length) {
      const chain = [inp.A, ...inp.points, inp.B].map((p) => this.toPx(pl, project(pl, p)));
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      chain.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Path: dark casing, then colored core, then dashes where out of gamut.
    const pts = inp.dense.map((d) => this.toPx(pl, project(pl, d.embed)));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.lineWidth = 7;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
    ctx.stroke();
    ctx.lineWidth = 4;
    for (let i = 1; i < pts.length; i++) {
      ctx.strokeStyle = inp.dense[i].hex;
      ctx.beginPath();
      ctx.moveTo(...pts[i - 1]);
      ctx.lineTo(...pts[i]);
      ctx.stroke();
    }
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5;
    for (let i = 1; i < pts.length; i++) {
      if (inp.dense[i].inGamut) continue;
      ctx.beginPath();
      ctx.moveTo(...pts[i - 1]);
      ctx.lineTo(...pts[i]);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Stops.
    for (const st of inp.stops) {
      const p = this.toPx(pl, project(pl, st.embed));
      ctx.beginPath();
      ctx.arc(p[0], p[1], 3.5, 0, Math.PI * 2);
      ctx.fillStyle = st.hex;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Handles.
    for (const { h: hd, p } of this.handles()) {
      const [x, y] = this.toPx(pl, project(pl, p));
      const hot = this.hover && sameHandle(this.hover, hd);
      ctx.lineWidth = hot ? 3 : 2;
      ctx.strokeStyle = "#fff";
      if (hd.kind === "point") {
        const r = hot ? 7 : 6;
        ctx.fillStyle = "#111";
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
        ctx.strokeRect(x - r, y - r, r * 2, r * 2);
        ctx.fillStyle = "#fff";
        ctx.font = "600 9px ui-sans-serif, system-ui";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(hd.index + 1), x, y + 0.5);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, hot ? 10 : 9, 0, Math.PI * 2);
        ctx.fillStyle = hd.kind === "a" ? inp.aColor : inp.bColor;
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, (hot ? 10 : 9) + 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Axis captions.
    ctx.font = "600 11px ui-sans-serif, system-ui";
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 3;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    // Pinned to the uncovered area, not the plot, so they stay put while panning.
    const top = this.insetTop;
    const bottom = h - this.insetBottom;
    ctx.fillStyle = PLANE_EDGE;
    if (pl.uLabel) ctx.fillText(`${pl.uLabel} →`, w - 12, bottom - 6);
    ctx.save();
    ctx.translate(14, top + 12);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    if (pl.vLabel) ctx.fillText(`${pl.vLabel} →`, 0, -10);
    ctx.restore();
    ctx.shadowBlur = 0;
  }

  // --- interaction -----------------------------------------------------------

  private pick(x: number, y: number): Handle | null {
    if (!this.input) return null;
    const pl = this.input.plane;
    let best: Handle | null = null;
    let bestD = 14;
    for (const { h, p } of this.handles()) {
      const [px, py] = this.toPx(pl, project(pl, p));
      const d = Math.hypot(px - x, py - y);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  private local(e: PointerEvent | MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private onDown = (e: PointerEvent) => {
    if (!this.input) return;
    const [x, y] = this.local(e);
    const h = e.button === 0 ? this.pick(x, y) : null;
    // Middle or right drag pans anywhere; left drag pans on empty canvas.
    if (!h && (e.button === 0 || e.button === 1 || e.button === 2)) {
      e.preventDefault();
      this.pan = { x, y };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = "grabbing";
      return;
    }
    if (!h) return;
    const start =
      h.kind === "point" ? this.input.points[h.index] : h.kind === "a" ? this.input.A : this.input.B;
    this.drag = { handle: h, start, sx: x, sy: y, x, y };
    this.canvas.setPointerCapture(e.pointerId);
    this.cb.onDragStart();
  };

  private onMove = (e: PointerEvent) => {
    if (!this.input) return;
    const [x, y] = this.local(e);
    if (this.pan) {
      this.tx += x - this.pan.x;
      this.ty += y - this.pan.y;
      this.pan = { x, y };
      this.draw();
      return;
    }
    if (!this.drag) {
      const h = this.pick(x, y);
      if (JSON.stringify(h) !== JSON.stringify(this.hover)) {
        this.hover = h;
        this.canvas.style.cursor = h ? "grab" : "default";
        this.draw();
      }
      return;
    }
    this.drag.x = x;
    this.drag.y = y;
    this.applyDrag(e.shiftKey);
  };

  /** Pressing or releasing Shift mid-drag re-snaps the handle without a pointer move. */
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Shift" && this.drag) this.applyDrag(e.type === "keydown");
  };

  /** Move the dragged handle to the pointer; Shift locks it to the screen's dominant axis. */
  private applyDrag(shift: boolean) {
    if (!this.input || !this.drag) return;
    let { x, y } = this.drag;
    if (shift) {
      if (Math.abs(x - this.drag.sx) >= Math.abs(y - this.drag.sy)) y = this.drag.sy;
      else x = this.drag.sx;
    }
    const pl = this.input.plane;
    const [s0, t0] = this.toPlane(pl, this.drag.sx, this.drag.sy);
    const [s1, t1] = this.toPlane(pl, x, y);
    const p = this.drag.start;
    const moved: Vec3 = [
      p[0] + pl.u[0] * (s1 - s0) + pl.v[0] * (t1 - t0),
      p[1] + pl.u[1] * (s1 - s0) + pl.v[1] * (t1 - t0),
      p[2] + pl.u[2] * (s1 - s0) + pl.v[2] * (t1 - t0),
    ];
    const h = this.drag.handle;
    if (h.kind === "point") this.cb.onPoint(h.index, moved);
    else {
      const sp = this.input.space;
      const rgb = sp.toRGB(sp.unembed(moved));
      if (rgb.every(Number.isFinite)) this.cb.onEndpoint(h.kind, rgb.map(clamp01) as Vec3);
    }
  }

  private onUp = () => {
    if (this.pan) {
      this.pan = null;
      this.canvas.style.cursor = "default";
      return;
    }
    if (!this.drag) return;
    this.drag = null;
    this.cb.onDragEnd();
  };

  /**
   * Pinch (reported with ctrlKey) and mouse-wheel notches zoom about the
   * cursor; two-finger trackpad scrolling pans.
   */
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [x, y] = this.local(e);
    const LINE = 100 / 3;
    const unit = e.deltaMode === 1 ? LINE : e.deltaMode === 2 ? 800 : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.ctrlKey) this.zoomAt(x, y, Math.exp(-dy * 0.01));
    else if (e.deltaMode !== 0 || (dx === 0 && Math.abs(dy) >= WHEEL_NOTCH_MIN)) this.zoomAt(x, y, Math.exp(-dy * 0.0015));
    else {
      this.tx -= dx;
      this.ty -= dy;
      this.draw();
    }
  };

  private onDbl = (e: MouseEvent) => {
    if (!this.input?.canAdd) return;
    const [x, y] = this.local(e);
    const [s, t] = this.toPlane(this.input.plane, x, y);
    this.cb.onAddPoint(unproject(this.input.plane, s, t));
  };
}

const sameHandle = (a: Handle, b: Handle) =>
  a.kind === b.kind && (a.kind !== "point" || (b.kind === "point" && a.index === b.index));
