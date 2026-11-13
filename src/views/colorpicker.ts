import {
  fromPolar,
  hexToRgb,
  hslToSrgb,
  hsvToSrgb,
  inUnitCube,
  oklabToSrgb,
  rgbToHex,
  srgbToHsl,
  srgbToHsv,
  srgbToOklab,
  toPolar,
  type Vec3,
} from "../color/convert";
import { selectAllOnFocus } from "./inputs";

export type Endpoint = "a" | "b";
type Model = "rgb" | "hsl" | "oklch";

interface Channel {
  name: string;
  max: number;
  step: number;
  /** Shown value = stored value × scale. */
  scale: number;
  unit?: string;
}

const MODELS: Record<Model, { label: string; channels: Channel[] }> = {
  rgb: {
    label: "RGB",
    channels: [
      { name: "R", max: 1, step: 1, scale: 255 },
      { name: "G", max: 1, step: 1, scale: 255 },
      { name: "B", max: 1, step: 1, scale: 255 },
    ],
  },
  hsl: {
    label: "HSL",
    channels: [
      { name: "H", max: 360, step: 1, scale: 1, unit: "°" },
      { name: "S", max: 1, step: 1, scale: 100, unit: "%" },
      { name: "L", max: 1, step: 1, scale: 100, unit: "%" },
    ],
  },
  oklch: {
    label: "OKLCH",
    channels: [
      { name: "L", max: 1, step: 0.1, scale: 100, unit: "%" },
      { name: "C", max: 0.37, step: 0.001, scale: 1 },
      { name: "H", max: 360, step: 1, scale: 1, unit: "°" },
    ],
  },
};

const MODEL_KEY = "gp.picker.model";
/** Samples per channel track; the track canvas is this many pixels wide and stretched. */
const TRACK_RES = 96;

const toOklch = (rgb: Vec3): Vec3 => {
  const [L, a, b] = srgbToOklab(rgb);
  const [C, h] = toPolar(a, b, 2e-4);
  return [L, C, h];
};
const oklchToRgb = ([L, C, h]: Vec3): Vec3 => {
  const [a, b] = fromPolar(C, h);
  return oklabToSrgb([L, a, b]);
};
/** OKLCH to sRGB, lowering chroma at fixed lightness and hue until it fits. */
const oklchToRgbFit = (lch: Vec3): Vec3 => {
  const rgb = oklchToRgb(lch);
  if (inUnitCube(rgb, 1e-6)) return rgb;
  let lo = 0;
  let hi = lch[1];
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (inUnitCube(oklchToRgb([lch[0], mid, lch[2]]), 1e-6)) lo = mid;
    else hi = mid;
  }
  return oklchToRgb([lch[0], lo, lch[2]]).map((v) => Math.min(1, Math.max(0, v))) as Vec3;
};

/** NaN hues (grays) keep the hue they had, so dragging through gray never snaps the hue to 0. */
const keepHue = (next: Vec3, prev: Vec3, i: number): Vec3 => {
  if (Number.isNaN(next[i])) next[i] = Number.isNaN(prev[i]) ? 0 : prev[i];
  return next;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.append(e);
  return e;
};

export interface ColorPickerOptions {
  /** Called on every change, possibly many times a frame while dragging. */
  onInput: (which: Endpoint, rgb: Vec3) => void;
  /** Called when a gesture ends (pointer up, key, typed value): a good point to finish expensive work. */
  onCommit: (which: Endpoint) => void;
  /** Called when the picker starts or stops a continuous gesture. */
  onGesture?: (active: boolean) => void;
  /** Read the endpoint's current color. */
  get: (which: Endpoint) => Vec3;
  /** Where to anchor the popover for an endpoint. */
  anchor: (which: Endpoint) => HTMLElement;
}

/**
 * A popover color picker for the two endpoints: a saturation/value square,
 * a hue strip, channel sliders in RGB, HSL or OKLCH (OKLCH tracks show where
 * the color leaves sRGB), a hex field and, where supported, an eyedropper.
 *
 * The picker keeps its own HSV and per-model values so hue survives grays
 * and an OKLCH chroma beyond sRGB stays where it was dragged; the color
 * reported is always in sRGB.
 */
export class ColorPicker {
  readonly root: HTMLElement;
  private which: Endpoint = "a";
  private rgb: Vec3 = [0, 0, 0];
  private hsv: Vec3 = [0, 0, 0];
  private models: Record<Model, Vec3> = { rgb: [0, 0, 0], hsl: [0, 0, 0], oklch: [0, 0, 0] };
  private model: Model;

  private tabs: HTMLButtonElement[] = [];
  private sv: HTMLCanvasElement;
  private svThumb: HTMLElement;
  private hue: HTMLElement;
  private hueThumb: HTMLElement;
  private preview: HTMLElement;
  private hex: HTMLInputElement;
  private modelBtns = new Map<Model, HTMLButtonElement>();
  private rows: { track: HTMLCanvasElement; thumb: HTMLElement; num: HTMLInputElement; label: HTMLElement; wrap: HTMLElement }[] = [];
  private svDrawnHue = NaN;

  constructor(private opts: ColorPickerOptions) {
    let saved: string | null = null;
    try { saved = localStorage.getItem(MODEL_KEY); } catch { /* storage blocked */ }
    this.model = saved && saved in MODELS ? (saved as Model) : "oklch";

    const root = (this.root = el("div", "cp"));
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Color picker");
    root.hidden = true;

    // A / B tabs: switch endpoint without closing.
    const head = el("div", "cp-head", root);
    const tabs = el("div", "cp-tabs", head);
    tabs.setAttribute("role", "tablist");
    for (const w of ["a", "b"] as const) {
      const b = el("button", "cp-tab", tabs);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.dataset.v = w;
      b.innerHTML = `<i></i>${w === "a" ? "Start" : "End"}`;
      b.onclick = () => this.open(w);
      this.tabs.push(b);
    }

    // Saturation / value square.
    const svWrap = el("div", "cp-sv", root);
    this.sv = el("canvas", "", svWrap);
    this.sv.width = 256;
    this.sv.height = 160;
    this.svThumb = el("div", "cp-thumb", svWrap);
    svWrap.tabIndex = 0;
    svWrap.setAttribute("role", "slider");
    svWrap.setAttribute("aria-label", "Saturation and brightness");
    this.drag(svWrap, (x, y) => this.setHsv([this.hsv[0], x, 1 - y]));
    svWrap.onkeydown = (e) => {
      const d = e.shiftKey ? 0.1 : 0.01;
      const [h, s, v] = this.hsv;
      const m: Record<string, Vec3> = {
        ArrowLeft: [h, s - d, v], ArrowRight: [h, s + d, v], ArrowUp: [h, s, v + d], ArrowDown: [h, s, v - d],
      };
      if (!m[e.key]) return;
      e.preventDefault();
      this.setHsv(m[e.key].map((x, i) => (i ? Math.min(1, Math.max(0, x)) : x)) as Vec3);
      this.commit();
    };

    // Hue strip, with a preview swatch beside it.
    const hueRow = el("div", "cp-hue-row", root);
    this.preview = el("div", "cp-preview", hueRow);
    this.hue = el("div", "cp-hue", hueRow);
    this.hueThumb = el("div", "cp-thumb", this.hue);
    this.hue.tabIndex = 0;
    this.hue.setAttribute("role", "slider");
    this.hue.setAttribute("aria-label", "Hue");
    this.hue.setAttribute("aria-valuemin", "0");
    this.hue.setAttribute("aria-valuemax", "360");
    this.drag(this.hue, (x) => this.setHsv([Math.min(359.999, x * 360), this.hsv[1], this.hsv[2]]));
    this.hue.onkeydown = (e) => {
      const d = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
      if (!d) return;
      e.preventDefault();
      this.setHsv([(this.hsv[0] + d * (e.shiftKey ? 10 : 1) + 360) % 360, this.hsv[1], this.hsv[2]]);
      this.commit();
    };

    // Model switch.
    const seg = el("div", "cp-models", root);
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Channel model");
    for (const m of Object.keys(MODELS) as Model[]) {
      const b = el("button", "", seg);
      b.type = "button";
      b.textContent = MODELS[m].label;
      b.onclick = () => this.setModel(m);
      this.modelBtns.set(m, b);
    }

    // Channel sliders.
    const chans = el("div", "cp-channels", root);
    for (let i = 0; i < 3; i++) {
      const wrap = el("div", "cp-ch", chans);
      const label = el("span", "cp-ch-name", wrap);
      const trackWrap = el("div", "cp-track", wrap);
      const track = el("canvas", "", trackWrap);
      track.width = TRACK_RES;
      track.height = 1;
      const thumb = el("div", "cp-thumb", trackWrap);
      trackWrap.tabIndex = 0;
      trackWrap.setAttribute("role", "slider");
      this.drag(trackWrap, (x) => this.setChannel(i, x * this.channel(i).max));
      trackWrap.onkeydown = (e) => {
        const d = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
        if (!d) return;
        e.preventDefault();
        const ch = this.channel(i);
        const unit = ch.step / ch.scale;
        this.setChannel(i, this.models[this.model][i] + d * unit * (e.shiftKey ? 10 : 1));
        this.commit();
      };
      const num = el("input", "cp-num", wrap);
      num.type = "number";
      num.onchange = () => {
        const ch = this.channel(i);
        const v = Number(num.value);
        if (Number.isFinite(v)) this.setChannel(i, v / ch.scale);
        this.commit();
      };
      this.rows.push({ track, thumb, num, label, wrap: trackWrap });
    }

    // Hex and eyedropper.
    const foot = el("div", "cp-foot", root);
    const hexWrap = el("label", "cp-hex", foot);
    el("span", "", hexWrap).textContent = "#";
    this.hex = el("input", "", hexWrap);
    this.hex.spellcheck = false;
    selectAllOnFocus(this.hex);
    this.hex.maxLength = 7;
    this.hex.setAttribute("aria-label", "Hex");
    this.hex.onchange = () => {
      const rgb = hexToRgb(this.hex.value);
      if (rgb) this.setRgb(rgb, null);
      else this.paint();
      this.commit();
    };
    this.hex.onkeydown = (e) => { if (e.key === "Enter") this.hex.blur(); };
    const Dropper = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (Dropper) {
      const eye = el("button", "cp-eye", foot);
      eye.type = "button";
      eye.title = "Pick a color from the screen";
      eye.setAttribute("aria-label", "Pick a color from the screen");
      eye.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>`;
      eye.onclick = async () => {
        try {
          const { sRGBHex } = await new Dropper().open();
          const rgb = hexToRgb(sRGBHex);
          if (rgb) { this.setRgb(rgb, null); this.commit(); }
        } catch { /* cancelled */ }
      };
    }

    document.body.append(root);

    // Dismiss on an outside press or Escape. Presses on the anchors toggle via their own handlers.
    document.addEventListener("pointerdown", (e) => {
      if (root.hidden) return;
      const t = e.target as Node;
      if (root.contains(t) || this.opts.anchor("a").contains(t) || this.opts.anchor("b").contains(t)) return;
      this.close();
    }, true);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !root.hidden) { this.close(); this.opts.anchor(this.which).focus(); }
    });
    window.addEventListener("resize", () => { if (!root.hidden) this.place(); });
  }

  get isOpen() { return !this.root.hidden; }
  get target() { return this.which; }

  toggle(which: Endpoint) {
    if (this.isOpen && this.which === which) this.close();
    else this.open(which);
  }

  open(which: Endpoint) {
    this.which = which;
    this.root.hidden = false;
    this.tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.v === which)));
    for (const w of ["a", "b"] as const) this.opts.anchor(w).setAttribute("aria-expanded", String(this.isOpen && w === which));
    this.rgb = [NaN, NaN, NaN];
    this.sync();
    this.place();
  }

  close() {
    this.root.hidden = true;
    for (const w of ["a", "b"] as const) this.opts.anchor(w).setAttribute("aria-expanded", "false");
  }

  /** Pull the endpoint's color in, after it changed elsewhere (a drag, undo). Cheap when unchanged. */
  sync() {
    if (!this.isOpen) return;
    this.tabs.forEach((t) => (t.querySelector("i") as HTMLElement).style.background = rgbToHex(this.opts.get(t.dataset.v as Endpoint)));
    const rgb = this.opts.get(this.which);
    if (rgbToHex(rgb) === rgbToHex(this.rgb)) return;
    this.setRgb(rgb, null, false);
  }

  // --- model updates ---------------------------------------------------------

  private channel(i: number) { return MODELS[this.model].channels[i]; }

  private setModel(m: Model) {
    this.model = m;
    try { localStorage.setItem(MODEL_KEY, m); } catch { /* storage blocked */ }
    this.paint();
  }

  /** Recompute every model from sRGB, except `from`, which already holds what the user set. */
  private setRgb(rgb: Vec3, from: Model | "hsv" | null, emit = true) {
    this.rgb = rgb;
    if (from !== "hsv") this.hsv = keepHue(srgbToHsv(rgb), this.hsv, 0);
    if (from !== "rgb") this.models.rgb = [...rgb];
    if (from !== "hsl") this.models.hsl = keepHue(srgbToHsl(rgb), this.models.hsl, 0);
    if (from !== "oklch") this.models.oklch = keepHue(toOklch(rgb), this.models.oklch, 2);
    // An HSV edit at zero saturation or value has no effect on sRGB; keep the HSL hue in step anyway.
    if (from === "hsv" && Number.isNaN(srgbToHsl(rgb)[0])) this.models.hsl[0] = this.hsv[0];
    this.paint();
    if (emit) this.opts.onInput(this.which, rgb);
  }

  private setHsv(hsv: Vec3) {
    this.hsv = hsv;
    this.setRgb(hsvToSrgb(hsv), "hsv");
  }

  private setChannel(i: number, v: number) {
    const ch = this.channel(i);
    const vals = [...this.models[this.model]] as Vec3;
    vals[i] = Math.min(ch.max, Math.max(0, v));
    if (ch.max === 360) vals[i] = Math.min(359.999, vals[i]);
    this.models[this.model] = vals;
    const rgb = this.model === "rgb" ? vals : this.model === "hsl" ? hslToSrgb(vals) : oklchToRgbFit(vals);
    this.setRgb(rgb.map((x) => Math.min(1, Math.max(0, x))) as Vec3, this.model);
  }

  private commit() { this.opts.onCommit(this.which); }

  /** Pointer drag over an element, reporting the position as fractions of its box. */
  private drag(host: HTMLElement, onMove: (x: number, y: number) => void) {
    host.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      host.focus({ preventScroll: true });
      host.setPointerCapture(e.pointerId);
      this.opts.onGesture?.(true);
      const r = host.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        const y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
        onMove(x, y);
      };
      const up = () => {
        host.removeEventListener("pointermove", move);
        host.removeEventListener("pointerup", up);
        host.removeEventListener("pointercancel", up);
        this.opts.onGesture?.(false);
        this.commit();
      };
      move(e);
      host.addEventListener("pointermove", move);
      host.addEventListener("pointerup", up);
      host.addEventListener("pointercancel", up);
    });
  }

  // --- drawing ---------------------------------------------------------------

  /**
   * Centered across the window, just below the swatches. The position does not
   * depend on which endpoint is open, so switching Start/End never moves it.
   */
  private place() {
    const bottom = Math.max(...(["a", "b"] as const).map((w) => this.opts.anchor(w).getBoundingClientRect().bottom));
    const w = this.root.offsetWidth;
    this.root.style.left = `${Math.max(8, (window.innerWidth - w) / 2)}px`;
    this.root.style.top = `${bottom + 8}px`;
  }

  private paint() {
    const [h, s, v] = this.hsv;
    const hex = rgbToHex(this.rgb);

    // The square only changes with hue.
    if (h !== this.svDrawnHue) {
      this.svDrawnHue = h;
      const g = this.sv.getContext("2d")!;
      const { width: W, height: H } = this.sv;
      g.fillStyle = rgbToHex(hsvToSrgb([h, 1, 1]));
      g.fillRect(0, 0, W, H);
      const wg = g.createLinearGradient(0, 0, W, 0);
      wg.addColorStop(0, "#fff");
      wg.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = wg;
      g.fillRect(0, 0, W, H);
      const bg = g.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "rgba(0,0,0,0)");
      bg.addColorStop(1, "#000");
      g.fillStyle = bg;
      g.fillRect(0, 0, W, H);
    }
    this.svThumb.style.left = `${s * 100}%`;
    this.svThumb.style.top = `${(1 - v) * 100}%`;
    this.svThumb.style.background = hex;
    this.sv.parentElement!.setAttribute("aria-valuetext", `Saturation ${Math.round(s * 100)}%, brightness ${Math.round(v * 100)}%`);
    this.hueThumb.style.left = `${(h / 360) * 100}%`;
    this.hueThumb.style.background = rgbToHex(hsvToSrgb([h, 1, 1]));
    this.hue.setAttribute("aria-valuenow", String(Math.round(h)));
    this.preview.style.background = hex;

    for (const [m, b] of this.modelBtns) b.setAttribute("aria-pressed", String(m === this.model));
    const vals = this.models[this.model];
    MODELS[this.model].channels.forEach((ch, i) => {
      const row = this.rows[i];
      row.label.textContent = ch.name;
      row.wrap.setAttribute("aria-label", `${MODELS[this.model].label} ${ch.name}`);
      row.wrap.setAttribute("aria-valuetext", `${fmt(vals[i] * ch.scale, ch)}${ch.unit ?? ""}`);
      row.thumb.style.left = `${(vals[i] / ch.max) * 100}%`;
      row.num.min = "0";
      row.num.max = String(ch.max * ch.scale);
      row.num.step = String(ch.step);
      if (document.activeElement !== row.num) row.num.value = fmt(vals[i] * ch.scale, ch);
      this.paintTrack(row.track, i, vals);
      row.thumb.style.background = hex;
    });
    if (document.activeElement !== this.hex) this.hex.value = hex.slice(1);
    for (const t of this.tabs) if (t.dataset.v === this.which) (t.querySelector("i") as HTMLElement).style.background = hex;
  }

  /** One channel's track: the color as that channel sweeps, others fixed. Outside sRGB is transparent (stripes show through). */
  private paintTrack(track: HTMLCanvasElement, i: number, vals: Vec3) {
    const g = track.getContext("2d")!;
    const img = g.createImageData(TRACK_RES, 1);
    const ch = this.channel(i);
    const v = [...vals] as Vec3;
    for (let x = 0; x < TRACK_RES; x++) {
      v[i] = (x / (TRACK_RES - 1)) * ch.max;
      const rgb = this.model === "rgb" ? v : this.model === "hsl" ? hslToSrgb(v) : oklchToRgb(v);
      const d = x * 4;
      if (inUnitCube(rgb, 1e-4)) {
        img.data[d] = rgb[0] * 255;
        img.data[d + 1] = rgb[1] * 255;
        img.data[d + 2] = rgb[2] * 255;
        img.data[d + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }
}

function fmt(v: number, ch: Channel): string {
  const digits = ch.step < 0.01 ? 3 : ch.step < 1 ? 1 : 0;
  return v.toFixed(digits);
}
