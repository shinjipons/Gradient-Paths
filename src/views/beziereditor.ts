import type { Bezier } from "../path/paths";
import { CANVAS_SANS } from "./fonts";

/** Inset of the unit square inside the plot, in CSS px, so the handles are never clipped. */
const PAD = 10;

export interface BezierEditorOptions {
  /** Called on every change, possibly many times a frame while dragging. */
  onInput: (b: Bezier) => void;
  /** A drag starts or ends. */
  onGesture?: (active: boolean) => void;
  /** A drag is released. */
  onCommit: () => void;
}

/**
 * Editor for the custom easing, a CSS-style cubic Bézier: a plot of the curve
 * from (0,0) to (1,1) with its two control points draggable. The CSS value
 * shows in a corner while dragging.
 */
export class BezierEditor {
  private b: Bezier = [0, 0, 1, 1];
  private canvas: HTMLCanvasElement;
  private dragging: 0 | 1 | null = null;

  constructor(host: HTMLElement, private opts: BezierEditorOptions) {
    const plot = document.createElement("div");
    plot.className = "bz-plot";
    this.canvas = document.createElement("canvas");
    plot.append(this.canvas);
    host.append(plot);

    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    new ResizeObserver(() => this.draw()).observe(plot);
  }

  /** Show a curve, after a change from anywhere. */
  set(b: Bezier) {
    this.b = [...b];
    this.draw();
  }

  // --- coordinates -----------------------------------------------------------

  private box() {
    const r = this.canvas.getBoundingClientRect();
    return { w: r.width - 2 * PAD, h: r.height - 2 * PAD, r };
  }
  private toPx(x: number, y: number): [number, number] {
    const { w, h } = this.box();
    return [PAD + x * w, PAD + (1 - y) * h];
  }
  private fromEvent(e: PointerEvent): [number, number] {
    const { w, h, r } = this.box();
    const x = (e.clientX - r.left - PAD) / w;
    const y = 1 - (e.clientY - r.top - PAD) / h;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  }

  // --- dragging ----------------------------------------------------------------

  private down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const { r } = this.box();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const d = [0, 1].map((k) => {
      const [hx, hy] = this.toPx(this.b[2 * k], this.b[2 * k + 1]);
      return Math.hypot(px - hx, py - hy);
    });
    // The nearer handle, even for a press far from both: it jumps there, so any spot is one drag away.
    this.dragging = d[0] <= d[1] ? 0 : 1;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer (a synthetic event): drag without capture.
    }
    this.opts.onGesture?.(true);
    const move = (ev: PointerEvent) => {
      const [x, y] = this.fromEvent(ev);
      const k = this.dragging!;
      const next = [...this.b] as Bezier;
      next[2 * k] = round(x);
      next[2 * k + 1] = round(y);
      this.b = next;
      this.draw();
      this.opts.onInput(this.b);
    };
    const up = () => {
      this.canvas.removeEventListener("pointermove", move);
      this.canvas.removeEventListener("pointerup", up);
      this.canvas.removeEventListener("pointercancel", up);
      this.dragging = null;
      this.opts.onGesture?.(false);
      this.opts.onCommit();
      this.draw();
    };
    move(e);
    this.canvas.addEventListener("pointermove", move);
    this.canvas.addEventListener("pointerup", up);
    this.canvas.addEventListener("pointercancel", up);
  }

  // --- drawing -------------------------------------------------------------------

  private draw() {
    const cv = this.canvas;
    const { r } = this.box();
    if (!(r.width > 0 && r.height > 0)) return; // hidden
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) {
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
    }
    const g = cv.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue("--accent").trim() || "#fff";
    const muted = css.getPropertyValue("--text-muted").trim() || "#888";
    const [x1, y1, x2, y2] = this.b;
    const P = (x: number, y: number) => this.toPx(x, y);

    // Frame and the linear reference.
    const [l, b] = P(0, 0);
    const [rr, t] = P(1, 1);
    g.strokeStyle = "rgba(255,255,255,0.12)";
    g.lineWidth = 1;
    g.strokeRect(l + 0.5, t + 0.5, rr - l - 1, b - t - 1);
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(l, b);
    g.lineTo(rr, t);
    g.stroke();
    g.setLineDash([]);

    // Handle arms.
    g.strokeStyle = muted;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(l, b);
    g.lineTo(...P(x1, y1));
    g.moveTo(rr, t);
    g.lineTo(...P(x2, y2));
    g.stroke();

    // The curve.
    g.strokeStyle = accent;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(l, b);
    g.bezierCurveTo(...P(x1, y1), ...P(x2, y2), rr, t);
    g.stroke();

    // Handles: white rings, the grabbed one filled with the accent.
    [0, 1].forEach((k) => {
      const [hx, hy] = P(this.b[2 * k], this.b[2 * k + 1]);
      g.beginPath();
      g.arc(hx, hy, 6, 0, Math.PI * 2);
      g.fillStyle = this.dragging === k ? accent : "#111";
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = "#fff";
      g.stroke();
    });

    // While dragging, the CSS value in the corner.
    if (this.dragging !== null) {
      g.font = `600 10px ${CANVAS_SANS}`;
      g.fillStyle = muted;
      g.textAlign = "left";
      g.textBaseline = "top";
      g.fillText(`cubic-bezier(${this.b.map(fmt).join(", ")})`, l + 4, t + 4);
    }
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
const fmt = (v: number) => (+v.toFixed(2)).toFixed(2);
