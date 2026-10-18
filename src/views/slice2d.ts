import { clamp01, type Vec3 } from "../color/convert";
import { isRealColor, type ColorSpace } from "../color/spaces";
import type { Sample } from "../path/paths";
import { project, unproject, type Plane } from "./plane";

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

const RES = 240;

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
  private drag: { handle: Handle; start: Vec3; sx: number; sy: number } | null = null;
  private hover: Handle | null = null;

  constructor(
    private container: HTMLElement,
    private cb: SliceCallbacks,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "slice-canvas";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.bg.width = this.bg.height = RES;
    new ResizeObserver(() => this.draw()).observe(container);
    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("pointercancel", this.onUp);
    this.canvas.addEventListener("dblclick", this.onDbl);
  }

  get dragging() {
    return this.drag !== null;
  }

  update(input: DrawInput) {
    this.input = input;
    this.draw();
  }

  // --- coordinates -----------------------------------------------------------

  private size() {
    const r = this.container.getBoundingClientRect();
    const s = Math.max(120, Math.min(r.width, r.height));
    return { w: r.width, h: r.height, s, ox: (r.width - s) / 2, oy: (r.height - s) / 2 };
  }

  private toPx(pl: Plane, uv: [number, number]): [number, number] {
    const { s, ox, oy } = this.size();
    const [u0, u1, v0, v1] = pl.view;
    return [ox + ((uv[0] - u0) / (u1 - u0)) * s, oy + (1 - (uv[1] - v0) / (v1 - v0)) * s];
  }

  private toPlane(pl: Plane, x: number, y: number): [number, number] {
    const { s, ox, oy } = this.size();
    const [u0, u1, v0, v1] = pl.view;
    return [u0 + ((x - ox) / s) * (u1 - u0), v0 + (1 - (y - oy) / s) * (v1 - v0)];
  }

  // --- background ------------------------------------------------------------

  private renderBackground(space: ColorSpace, pl: Plane) {
    const key = JSON.stringify([space.id, pl.origin, pl.u, pl.v, pl.view].flat(2).map((x) => (typeof x === "number" ? x.toFixed(4) : x)));
    if (key === this.bgKey) return;
    this.bgKey = key;
    const g = this.bg.getContext("2d")!;
    const img = g.createImageData(RES, RES);
    const [u0, u1, v0, v1] = pl.view;
    for (let j = 0; j < RES; j++) {
      for (let i = 0; i < RES; i++) {
        const s = u0 + ((i + 0.5) / RES) * (u1 - u0);
        const t = v1 - ((j + 0.5) / RES) * (v1 - v0);
        const native = space.unembed(unproject(pl, s, t));
        const rgb = space.toRGB(native);
        const k = (j * RES + i) * 4;
        if (rgb.every(Number.isFinite) && isRealColor(space, native, rgb)) {
          img.data[k] = clamp01(rgb[0]) * 255;
          img.data[k + 1] = clamp01(rgb[1]) * 255;
          img.data[k + 2] = clamp01(rgb[2]) * 255;
          img.data[k + 3] = 255;
        } else {
          const hatch = ((i + j) >> 2) % 2 === 0;
          img.data[k] = img.data[k + 1] = img.data[k + 2] = hatch ? 34 : 28;
          img.data[k + 3] = 255;
        }
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
    const { w, h, s, ox, oy } = this.size();
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pl = inp.plane;

    this.renderBackground(inp.space, pl);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.bg, ox, oy, s, s);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.strokeRect(ox + 0.5, oy + 0.5, s - 1, s - 1);

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
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "11px ui-sans-serif, system-ui";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    if (pl.uLabel) ctx.fillText(`${pl.uLabel} →`, ox + s - 6, oy + s - 6);
    ctx.save();
    ctx.translate(ox + 14, oy + 8);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    if (pl.vLabel) ctx.fillText(`${pl.vLabel} →`, 0, -10);
    ctx.restore();
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
    if (e.button !== 0 || !this.input) return;
    const [x, y] = this.local(e);
    const h = this.pick(x, y);
    if (!h) return;
    const start =
      h.kind === "point" ? this.input.points[h.index] : h.kind === "a" ? this.input.A : this.input.B;
    this.drag = { handle: h, start, sx: x, sy: y };
    this.canvas.setPointerCapture(e.pointerId);
    this.cb.onDragStart();
  };

  private onMove = (e: PointerEvent) => {
    if (!this.input) return;
    const [x, y] = this.local(e);
    if (!this.drag) {
      const h = this.pick(x, y);
      if (JSON.stringify(h) !== JSON.stringify(this.hover)) {
        this.hover = h;
        this.canvas.style.cursor = h ? "grab" : "default";
        this.draw();
      }
      return;
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
  };

  private onUp = () => {
    if (!this.drag) return;
    this.drag = null;
    this.cb.onDragEnd();
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
