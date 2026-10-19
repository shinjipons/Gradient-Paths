export interface Series {
  name: string;
  color: string;
  values: (number | null)[];
  dashed?: boolean;
  /** Shown in the tooltip instead of the plotted (normalized) value. */
  format?: (i: number) => string;
}

export interface ChartInput {
  series: Series[];
  /** Colors under the plot, one per x sample (the gradient itself). */
  band: string[];
  yMin: number;
  yMax: number;
  yTicks: { v: number; label: string }[];
  /** Optional dashed reference line (e.g. the mean). */
  ref?: { v: number; label: string };
  area?: boolean;
}

const PAD = { l: 38, r: 64, t: 10, b: 26 };
const BAND = 8;

/**
 * Small line chart over gradient position (0..1) with a crosshair tooltip.
 * Series are direct-labeled at the right edge and listed in a legend above.
 */
export class LineChart {
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private tip = document.createElement("div");
  private legend = document.createElement("div");
  private input: ChartInput | null = null;
  private hoverX: number | null = null;

  /** `padRight` is the gutter for the direct labels at the right end of each line. */
  constructor(
    private host: HTMLElement,
    private padRight = PAD.r,
  ) {
    this.legend.className = "chart-legend";
    this.tip.className = "chart-tip";
    this.tip.hidden = true;
    const wrap = document.createElement("div");
    wrap.className = "chart-wrap";
    wrap.append(this.canvas, this.tip);
    host.append(this.legend, wrap);
    new ResizeObserver(() => this.draw()).observe(wrap);
    this.canvas.addEventListener("pointermove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.draw();
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.hoverX = null;
      this.tip.hidden = true;
      this.draw();
    });
  }

  update(input: ChartInput) {
    this.input = input;
    this.legend.innerHTML = input.series
      .map(
        (s) =>
          `<span class="lg"><i style="background:${s.color}${s.dashed ? ";height:0;border-top:2px dashed " + s.color : ""}"></i>${s.name}</span>`,
      )
      .join("");
    this.draw();
  }

  private draw() {
    const inp = this.input;
    if (!inp) return;
    const box = this.canvas.parentElement!.getBoundingClientRect();
    const w = box.width;
    const h = box.height;
    if (w < 10 || h < 10) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue("--grid").trim() || "rgba(255,255,255,0.08)";
    const muted = css.getPropertyValue("--text-muted").trim() || "#8a8a85";
    const surface = css.getPropertyValue("--surface-1").trim() || "#1a1a19";

    const x0 = PAD.l;
    const x1 = w - this.padRight;
    const y0 = PAD.t;
    const y1 = h - PAD.b - BAND - 4;
    const X = (u: number) => x0 + u * (x1 - x0);
    const Y = (v: number) => y1 - ((v - inp.yMin) / (inp.yMax - inp.yMin || 1)) * (y1 - y0);

    // Grid + y ticks.
    ctx.font = "10px ui-sans-serif, system-ui";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (const t of inp.yTicks) {
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(Y(t.v)) + 0.5);
      ctx.lineTo(x1, Math.round(Y(t.v)) + 0.5);
      ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(t.label, x0 - 6, Y(t.v));
    }
    // X ticks.
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const u of [0, 0.25, 0.5, 0.75, 1]) ctx.fillText(`${u * 100}%`, X(u), y1 + BAND + 8);

    // Gradient band.
    const bw = (x1 - x0) / inp.band.length;
    inp.band.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(x0 + i * bw, y1 + 3, bw + 0.6, BAND);
    });

    if (inp.ref) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = muted;
      ctx.beginPath();
      ctx.moveTo(x0, Y(inp.ref.v));
      ctx.lineTo(x1, Y(inp.ref.v));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = muted;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(inp.ref.label, x1 + 6, Y(inp.ref.v) + 12);
    }

    // Series.
    const labelYs: number[] = [];
    for (const s of inp.series) {
      const n = s.values.length;
      if (inp.area) {
        ctx.beginPath();
        ctx.moveTo(X(0), y1);
        s.values.forEach((v, i) => ctx.lineTo(X(i / (n - 1)), Y(v ?? inp.yMin)));
        ctx.lineTo(X(1), y1);
        ctx.closePath();
        ctx.fillStyle = s.color + "33";
        ctx.fill();
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(s.dashed ? [5, 4] : []);
      ctx.lineJoin = "round";
      ctx.beginPath();
      let pen = false;
      s.values.forEach((v, i) => {
        if (v === null) {
          pen = false;
          return;
        }
        const px = X(i / (n - 1));
        if (pen) ctx.lineTo(px, Y(v));
        else ctx.moveTo(px, Y(v));
        pen = true;
      });
      ctx.stroke();
      ctx.setLineDash([]);
      // Direct label at the right end, nudged apart.
      const last = [...s.values].reverse().find((v) => v !== null);
      if (last != null && inp.series.length > 1) {
        let ly = Y(last);
        for (const o of labelYs) if (Math.abs(o - ly) < 11) ly = o + (ly >= o ? 11 : -11);
        labelYs.push(ly);
        ctx.fillStyle = css.getPropertyValue("--text-secondary").trim() || "#c3c2b7";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(s.name, x1 + 6, ly);
      }
    }

    // Crosshair + tooltip.
    if (this.hoverX !== null && this.hoverX >= x0 && this.hoverX <= x1) {
      const u = (this.hoverX - x0) / (x1 - x0);
      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.hoverX + 0.5, y0);
      ctx.lineTo(this.hoverX + 0.5, y1);
      ctx.stroke();
      const rows: string[] = [];
      for (const s of inp.series) {
        const n = s.values.length;
        const i = Math.round(u * (n - 1));
        const v = s.values[i];
        if (v === null) continue;
        ctx.beginPath();
        ctx.arc(X(i / (n - 1)), Y(v), 4, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = surface;
        ctx.lineWidth = 2;
        ctx.stroke();
        rows.push(`<div><i style="background:${s.color}"></i>${s.name}<b>${s.format ? s.format(i) : v.toFixed(2)}</b></div>`);
      }
      const bi = Math.min(inp.band.length - 1, Math.round(u * (inp.band.length - 1)));
      this.tip.innerHTML = `<div class="tip-head"><span style="background:${inp.band[bi]}"></span>${Math.round(u * 100)}%</div>${rows.join("")}`;
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = `${this.hoverX + 12 + tw > w ? this.hoverX - tw - 12 : this.hoverX + 12}px`;
      this.tip.style.top = `${y0}px`;
    }
  }
}
