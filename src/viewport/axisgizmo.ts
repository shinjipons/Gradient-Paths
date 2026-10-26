import { Quaternion, Vector3, type Camera } from "three";
import type { SnapView } from "./cameras";

export interface AxisGizmoCallbacks {
  /** An axis end was clicked: look down that axis. */
  onSnap(view: SnapView): void;
  /** The gizmo was dragged by this many CSS px since the last call. */
  onOrbit(dx: number, dy: number): void;
}

interface End {
  view: SnapView;
  dir: Vector3;
  color: string;
  positive: boolean;
}

/** Blender's axis colors; each end is one flat color; the negative end is slightly darker. */
const X = "#ff3352";
const Y = "#8bdc00";
const Z = "#2890ff";

/** Brightness of the negative ends relative to the positive ones. */
const DARKEN = 0.72;

const ENDS: End[] = [
  { view: "right", dir: new Vector3(1, 0, 0), color: X, positive: true },
  { view: "left", dir: new Vector3(-1, 0, 0), color: shade(X, DARKEN), positive: false },
  { view: "back", dir: new Vector3(0, 1, 0), color: Y, positive: true },
  { view: "front", dir: new Vector3(0, -1, 0), color: shade(Y, DARKEN), positive: false },
  { view: "top", dir: new Vector3(0, 0, 1), color: Z, positive: true },
  { view: "bottom", dir: new Vector3(0, 0, -1), color: shade(Z, DARKEN), positive: false },
];

/** CSS px: widget size, axis length from the center, half the end cubes' edge. */
const SIZE = 96;
const ARM = 34;
const CUBE_H = 4.2;
/** Hit radius around an end's center. */
const PICK_R = 8;
/** A press that moves less than this is a click (snap), not a drag (orbit). */
const CLICK_SLOP_PX = 3;

const _q = new Quaternion();
const _v = new Vector3();

/**
 * Blender-style navigation gizmo: a small cube at each end of each world axis,
 * drawn from the camera's orientation. Click an end to look down that axis;
 * drag anywhere on the widget to orbit.
 */
export class AxisGizmo {
  readonly element: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hover: End | null = null;
  private inside = false;
  private press: { x: number; y: number; lx: number; ly: number; dragged: boolean } | null = null;
  /** Screen positions from the last draw, nearest last; for hit testing. */
  private placed: { end: End; x: number; y: number; depth: number }[] = [];
  private lastKey = "";

  constructor(private cb: AxisGizmoCallbacks) {
    const c = document.createElement("canvas");
    c.className = "axis-gizmo";
    c.style.width = c.style.height = `${SIZE}px`;
    c.setAttribute("role", "img");
    c.setAttribute("aria-label", "View axes: click an axis to look along it, drag to orbit");
    this.element = c;
    this.ctx = c.getContext("2d")!;
    c.addEventListener("pointerdown", this.onDown);
    c.addEventListener("pointermove", this.onMove);
    c.addEventListener("pointerup", this.onUp);
    c.addEventListener("pointercancel", this.onUp);
    c.addEventListener("pointerleave", () => {
      this.inside = false;
      if (!this.press) this.hover = null;
      this.lastKey = "";
    });
    // Keep the view's own navigation from seeing these presses and wheels.
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("wheel", (e) => e.stopPropagation());
  }

  /** Redraw for this camera; cheap when nothing changed. */
  update(camera: Camera) {
    const dpr = window.devicePixelRatio || 1;
    const q = camera.getWorldQuaternion(_q).invert();
    const key = `${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)},${q.w.toFixed(4)}|${this.hover?.view}|${this.inside}|${dpr}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const px = Math.round(SIZE * dpr);
    if (this.element.width !== px) this.element.width = this.element.height = px;
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, SIZE, SIZE);
    const c = SIZE / 2;

    // Translucent disc while hovered, as in Blender: shows the drag area.
    if (this.inside || this.press) {
      g.fillStyle = "rgba(255,255,255,0.08)";
      g.beginPath();
      g.arc(c, c, SIZE / 2 - 1, 0, Math.PI * 2);
      g.fill();
    }

    // The world axes in view space (x right, y up, z toward the viewer): the
    // cubes' edges, and the directions the ends sit in.
    const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].map((a) => a.applyQuaternion(q));

    this.placed = ENDS.map((end) => {
      _v.copy(end.dir).applyQuaternion(q);
      return { end, x: c + _v.x * ARM, y: c - _v.y * ARM, depth: _v.z };
    }).sort((a, b) => a.depth - b.depth);

    for (const p of this.placed) {
      const { end } = p;
      if (end.positive) {
        g.strokeStyle = end.color;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(c, c);
        g.lineTo(p.x, p.y);
        g.stroke();
      }
      drawCube(g, p.x, p.y, axes, end.color, this.hover === end ? 1.25 : 1);
    }
  }

  private local(e: PointerEvent): [number, number] {
    const r = this.element.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** The nearest end under (x, y), or null. */
  private pick(x: number, y: number): End | null {
    for (let i = this.placed.length - 1; i >= 0; i--) {
      const p = this.placed[i];
      if (Math.hypot(x - p.x, y - p.y) <= PICK_R) return p.end;
    }
    return null;
  }

  private onDown = (e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    this.element.setPointerCapture(e.pointerId);
    this.press = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, dragged: false };
    this.lastKey = "";
  };

  private onMove = (e: PointerEvent) => {
    e.stopPropagation();
    this.inside = true;
    const p = this.press;
    if (!p) {
      const h = this.pick(...this.local(e));
      if (h !== this.hover) this.hover = h;
      this.element.style.cursor = h ? "pointer" : "grab";
      this.lastKey = "";
      return;
    }
    if (!p.dragged && Math.hypot(e.clientX - p.x, e.clientY - p.y) < CLICK_SLOP_PX) return;
    if (!p.dragged) {
      p.dragged = true;
      this.hover = null;
      this.element.style.cursor = "grabbing";
    }
    this.cb.onOrbit(e.clientX - p.lx, e.clientY - p.ly);
    p.lx = e.clientX;
    p.ly = e.clientY;
  };

  private onUp = (e: PointerEvent) => {
    e.stopPropagation();
    const p = this.press;
    this.press = null;
    this.lastKey = "";
    if (!p || e.type === "pointercancel") return;
    this.element.style.cursor = "grab";
    if (p.dragged) return;
    const end = this.pick(...this.local(e));
    if (end) this.cb.onSnap(end.view);
  };
}

/**
 * A world-aligned cube centered on (x, y): its three camera-facing faces,
 * flat-filled (emissive, no shading). No outline.
 */
function drawCube(g: CanvasRenderingContext2D, x: number, y: number, axes: Vector3[], color: string, boost: number) {
  const pt = (v: Vector3): [number, number] => [x + v.x * CUBE_H, y - v.y * CUBE_H];
  const faces: { corners: [number, number][] }[] = [];
  for (let k = 0; k < 3; k++) {
    for (const s of [1, -1]) {
      const n = axes[k].clone().multiplyScalar(s);
      if (n.z <= 0) continue;
      const a = axes[(k + 1) % 3];
      const b = axes[(k + 2) % 3];
      const corners = [
        [1, 1],
        [1, -1],
        [-1, -1],
        [-1, 1],
      ].map(([i, j]) => pt(n.clone().addScaledVector(a, i).addScaledVector(b, j)));
      faces.push({ corners });
    }
  }
  for (const f of faces) {
    g.fillStyle = boost === 1 ? color : shade(color, boost);
    g.beginPath();
    g.moveTo(...f.corners[0]);
    for (const p of f.corners.slice(1)) g.lineTo(...p);
    g.closePath();
    g.fill();
  }
}

// Function declarations, not consts: ENDS calls these while the module loads.
function parseHex(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(c: number[]): string {
  return `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}

/** `hex` scaled in brightness by `f` (1 = unchanged). */
function shade(hex: string, f: number): string {
  return toHex(parseHex(hex).map((v) => v * f));
}
