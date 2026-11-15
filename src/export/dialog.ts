/**
 * The Export dialog: one modal with a tab per target (CSS, SVG, PNG, Figma,
 * Blender, stop lists). The gradient's shape (type, angle, radial size, blend)
 * is shared by every tab; each tab previews exactly what it copies.
 */
import type { Gradient } from "../path/paths";
import {
  blenderScript,
  cssGradient,
  cssRule,
  renderSquare,
  stopsText,
  svgSquare,
  type Blend,
  type CssColor,
  type CssForm,
  type CssInterp,
  type Geometry,
  type GradientType,
  type RadialSize,
  type StopsFormat,
} from "./formats";

type Tab = "css" | "svg" | "png" | "figma" | "blender" | "stops";

interface Settings extends Geometry {
  tab: Tab;
  cssColor: CssColor;
  cssInterp: CssInterp;
  cssForm: CssForm;
  svgSize: number;
  pngSize: number;
  pngSource: "path" | "stops";
  blenderApply: boolean;
  stopsFormat: StopsFormat;
}

const DEFAULTS: Settings = {
  tab: "css",
  type: "linear",
  angle: 90,
  radialSize: "farthest-corner",
  blend: "smooth",
  cssColor: "hex",
  cssInterp: "srgb",
  cssForm: "background",
  svgSize: 512,
  pngSize: 1024,
  pngSource: "path",
  blenderApply: true,
  stopsFormat: "hex",
};

// Export choices are a per-viewer preference, remembered in this browser rather than kept in the shared link.
const STORE_KEY = "gp.export";
function load(): Settings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* storage blocked or bad JSON */ }
  return { ...DEFAULTS };
}

const TABS: { v: Tab; label: string; hint: string; experimental?: boolean }[] = [
  { v: "css", label: "CSS", hint: "A CSS gradient: linear, radial or conic" },
  { v: "svg", label: "SVG", hint: "A square SVG image" },
  { v: "png", label: "PNG", hint: "A square PNG image, at the resolution you pick" },
  { v: "figma", label: "Figma", hint: "A rectangle with the gradient fill, pasted onto the Figma canvas" },
  { v: "blender", label: "Blender", hint: "Experimental: a Python script that builds a material with the stops in a Color Ramp", experimental: true },
  { v: "stops", label: "Stops", hint: "The stop colors as a list, CSS variables or JSON" },
];

/** Tabs that draw through SVG, which has no conic gradient. */
const NO_CONIC: Tab[] = ["svg", "figma"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Text as highlighted HTML: each rule is a pattern and the class its matches get, tried in
 * order at every position. Text no rule matches is left plain (escaped).
 */
function highlight(text: string, rules: [RegExp, string][]): string {
  const re = new RegExp(rules.map(([r]) => `(${r.source})`).join("|"), "gm");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.slice(1).findIndex((g) => g !== undefined);
    if (i < 0 || !m[0]) continue;
    out += esc(text.slice(last, m.index)) + `<span class="${rules[i][1]}">${esc(m[0])}</span>`;
    last = m.index! + m[0].length;
  }
  return out + esc(text.slice(last));
}

const CSS_RULES: [RegExp, string][] = [
  [/^[\w-]+(?=:)/, "hl-attr"], // property, or the custom property's name
  [/#[0-9a-fA-F]{3,8}\b/, "hl-str"], // hex color
  [/[\w-]+(?=\()/, "hl-tag"], // function: linear-gradient, rgb, oklch
  [/-?\d*\.?\d+(?:%|deg|[a-z]+)?/, "hl-num"], // number, with its unit
  [/\b(?:in|at|from|to|circle|ellipse|closest-side|farthest-corner|oklab|srgb)\b/, "hl-kw"],
  [/[(),:;]/, "hl-punct"],
];

const PY_RULES: [RegExp, string][] = [
  [/#.*$/, "hl-comment"],
  [/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/, "hl-str"],
  [/\b(?:import|from|def|return|for|in|if|else|elif|is|not|and|or|None|True|False)\b/, "hl-kw"],
  [/\b\w+(?=\()/, "hl-tag"], // call
  [/\b\d+(?:\.\d+)?\b/, "hl-num"],
];

/**
 * SVG/XML markup as highlighted HTML: tag names, attribute names, attribute values
 * and the brackets around them each get a class. Text between tags is left plain.
 */
function highlightXml(xml: string): string {
  return xml.replace(/<(\/?)([\w:-]+)([^>]*?)(\/?)>|([^<]+)/g, (_m, close, name, attrs, selfClose, text) => {
    if (text !== undefined) return esc(text);
    const a = (attrs as string).replace(/([\w:-]+)(=)("[^"]*")|(\s+)/g, (_x, k, eq, v, ws) =>
      ws !== undefined ? ws : `<span class="hl-attr">${esc(k)}</span><span class="hl-punct">${eq}</span><span class="hl-str">${esc(v)}</span>`,
    );
    return `<span class="hl-punct">&lt;${close}</span><span class="hl-tag">${esc(name)}</span>${a}<span class="hl-punct">${selfClose}&gt;</span>`;
  });
}

export class ExportDialog {
  private dlg: HTMLDialogElement;
  private s = load();
  private preview: HTMLElement;
  private code: HTMLElement;
  private note: HTMLElement;
  private actions: HTMLElement;
  private opts: HTMLElement;
  private shapeHost: HTMLElement;

  private stopsSlider!: { set(v: number): void };

  constructor(private app: {
    gradient: () => Gradient;
    /** The app's stop count (the Sampling panel's), read on open and set live by the dialog's slider. */
    stops: () => number;
    setStops: (n: number) => void;
  }) {
    const dlg = document.createElement("dialog");
    dlg.className = "export-dialog";
    dlg.setAttribute("aria-labelledby", "export-title");
    dlg.innerHTML = `
      <div class="ex-head">
        <h2 id="export-title">Export</h2>
        <button type="button" class="ex-close" aria-label="Close" title="Close (Esc)">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="ex-body">
        <nav class="ex-tabs" role="tablist" aria-label="Export format"></nav>
        <div class="ex-main">
          <div class="ex-top">
            <div class="ex-preview" aria-hidden="true"></div>
            <div class="ex-opts">
              <div class="ex-shape"></div>
              <div class="ex-tab-opts"></div>
            </div>
          </div>
          <p class="ex-note"></p>
          <pre class="ex-code"></pre>
          <div class="ex-foot">
            <div class="ex-stops"></div>
            <div class="ex-actions"></div>
          </div>
        </div>
      </div>`;
    document.body.append(dlg);
    this.dlg = dlg;
    this.preview = dlg.querySelector(".ex-preview")!;
    this.code = dlg.querySelector(".ex-code")!;
    this.note = dlg.querySelector(".ex-note")!;
    this.actions = dlg.querySelector(".ex-actions")!;
    // The stop count is the app's own state, shared with the Sampling panel; it lives outside the
    // per-tab controls so a drag never rebuilds it under the pointer.
    const stops = this.slider("Stops", 2, 32, 1, app.stops(), String, (v) => {
      app.setStops(v);
      this.renderOutput();
    }, true);
    this.stopsSlider = stops;
    dlg.querySelector(".ex-stops")!.append(stops.el);
    this.opts = dlg.querySelector(".ex-tab-opts")!;
    this.shapeHost = dlg.querySelector(".ex-shape")!;

    const nav = dlg.querySelector(".ex-tabs")!;
    for (const t of TABS) {
      const b = document.createElement("button");
      b.type = "button";
      b.role = "tab";
      b.dataset.v = t.v;
      b.textContent = t.label;
      if (t.experimental) {
        const tag = document.createElement("span");
        tag.className = "ex-tag";
        tag.textContent = "Experimental";
        b.append(tag);
      }
      b.title = t.hint;
      b.onclick = () => this.set({ tab: t.v });
      nav.append(b);
    }
    dlg.querySelector<HTMLButtonElement>(".ex-close")!.onclick = () => dlg.close();
    // A press on the backdrop (outside the dialog's box) closes it.
    dlg.addEventListener("mousedown", (e) => {
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    });
  }

  open() {
    this.stopsSlider.set(this.app.stops());
    this.render();
    this.dlg.showModal();
    this.dlg.querySelector<HTMLButtonElement>(`.ex-tabs [data-v="${this.s.tab}"]`)?.focus();
  }

  private set(patch: Partial<Settings>) {
    Object.assign(this.s, patch);
    this.save();
    this.render();
  }

  /**
   * The shape the current tab draws. Tabs drawn through SVG have no conic gradient: a conic
   * choice falls back to linear there, and stays saved, so it comes back on the other tabs.
   */
  private geometry(): Geometry {
    const s = this.s;
    return s.type === "conic" && NO_CONIC.includes(s.tab) ? { ...s, type: "linear" } : s;
  }

  private save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.s)); } catch { /* storage blocked */ }
  }

  // --- controls ----------------------------------------------------------------

  private field(label: string, control: HTMLElement): HTMLElement {
    const f = document.createElement("div");
    f.className = "ex-field";
    const l = document.createElement("span");
    l.className = "ex-label";
    l.textContent = label;
    f.append(l, control);
    return f;
  }

  private seg<T extends string | number>(
    opts: { v: T; label: string; title?: string; disabled?: boolean }[],
    value: T,
    pick: (v: T) => void,
  ): HTMLElement {
    const host = document.createElement("div");
    host.className = "seg small ex-seg";
    host.role = "group";
    for (const o of opts) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = o.label;
      if (o.title) b.title = o.title;
      b.disabled = !!o.disabled;
      b.setAttribute("aria-pressed", String(o.v === value));
      b.onclick = () => pick(o.v);
      host.append(b);
    }
    return host;
  }

  /**
   * A bar slider. Its label sits outside it, in a field's label column, unless `innerLabel`
   * puts it inside the bar. `live` runs on every step of a drag; the slider is never rebuilt by it.
   */
  private slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, live: (v: number) => void, innerLabel = false) {
    const wrap = document.createElement("label");
    wrap.className = "slider";
    // The label sits in the field's label column, like the other rows; the bar holds only the value.
    wrap.classList.add("ex-slider");
    wrap.classList.toggle("ex-slider-labeled", innerLabel);
    wrap.innerHTML = `${innerLabel ? `<span class="slider-label">${label}</span>` : ""}<output></output><input type="range" min="${min}" max="${max}" step="${step}" aria-label="${label}">`;
    const input = wrap.querySelector("input")!;
    const out = wrap.querySelector("output")!;
    const show = (v: number) => {
      out.textContent = fmt(v);
      wrap.style.setProperty("--p", `${((v - min) / (max - min)) * 100}%`);
    };
    const set = (v: number) => {
      input.value = String(v);
      show(v);
    };
    set(value);
    input.oninput = () => {
      const v = Number(input.value);
      show(v);
      live(v);
    };
    return { el: wrap, set };
  }

  private check(label: string, value: boolean, pick: (v: boolean) => void): HTMLElement {
    const l = document.createElement("label");
    l.className = "ex-check";
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = value;
    c.onchange = () => pick(c.checked);
    l.append(c, document.createTextNode(label));
    return l;
  }

  // --- render -------------------------------------------------------------------

  private render() {
    const s = this.s;
    this.dlg.querySelectorAll<HTMLButtonElement>(".ex-tabs button").forEach((b) => {
      const on = b.dataset.v === s.tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });

    // Shape, shared by every tab. The stop list has no shape.
    this.shapeHost.innerHTML = "";
    this.shapeHost.hidden = s.tab === "stops";
    const noConic = NO_CONIC.includes(s.tab);
    const type = this.geometry().type;
    this.shapeHost.append(
      this.field("Type", this.seg<GradientType>([
        { v: "linear", label: "Linear" },
        { v: "radial", label: "Radial" },
        // SVG has no conic gradient: tabs drawn through SVG leave the option out.
        ...(noConic ? [] : [{ v: "conic" as const, label: "Conic" }]),
      ], type, (v) => this.set({ type: v }))),
    );
    if (type === "radial") {
      this.shapeHost.append(this.field("Size", this.seg<RadialSize>([
        { v: "closest-side", label: "Fit inside", title: "closest-side: the last stop touches the square's sides" },
        { v: "farthest-corner", label: "Cover", title: "farthest-corner: the last stop reaches the corners" },
      ], s.radialSize, (v) => this.set({ radialSize: v }))));
    } else {
      const label = type === "linear" ? "Angle" : "From";
      this.shapeHost.append(this.field(label, this.slider(label, 0, 360, 1, s.angle, (v) => `${v}°`, (v) => {
        // Live, without rebuilding the controls under the pointer; saved like any other setting.
        this.s.angle = v;
        this.save();
        this.renderOutput();
      }).el));
    }
    this.shapeHost.append(this.field("Blend", this.seg<Blend>([
      { v: "smooth", label: "Smooth", title: "Colors blend from stop to stop" },
      { v: "bands", label: "Hard bands", title: "Each stop is a flat band with hard edges" },
    ], s.blend, (v) => this.set({ blend: v }))));

    // Options of the current tab.
    this.opts.innerHTML = "";
    if (s.tab === "css") {
      this.opts.append(
        this.field("Colors", this.seg<CssColor>([
          { v: "hex", label: "Hex" },
          { v: "oklch", label: "OKLCH" },
          { v: "rgb", label: "rgb()" },
        ], s.cssColor, (v) => this.set({ cssColor: v }))),
        this.field("Blend in", this.seg<CssInterp>([
          { v: "srgb", label: "sRGB", title: "The browser's default: blends between stops in sRGB" },
          { v: "oklab", label: "OKLab", title: "Adds “in oklab”: blends between stops in OKLab. Needs a 2023+ browser", disabled: s.blend === "bands" },
        ], s.cssInterp, (v) => this.set({ cssInterp: v }))),
        this.field("Output", this.seg<CssForm>([
          { v: "background", label: "background" },
          { v: "background-image", label: "background-image" },
          { v: "variable", label: "--variable" },
        ], s.cssForm, (v) => this.set({ cssForm: v }))),
      );
    } else if (s.tab === "svg" || s.tab === "figma") {
      this.opts.append(this.field("Size", this.seg<number>(
        [256, 512, 1024].map((v) => ({ v, label: `${v}px` })),
        s.svgSize,
        (v) => this.set({ svgSize: v }),
      )));
    } else if (s.tab === "png") {
      this.opts.append(
        this.field("Resolution", this.seg<number>(
          [256, 512, 1024, 2048, 4096].map((v) => ({ v, label: v >= 1024 ? `${v / 1024}K` : String(v), title: `${v} × ${v} px` })),
          s.pngSize,
          (v) => this.set({ pngSize: v }),
        )),
        this.field("Colors", this.seg<"path" | "stops">([
          { v: "path", label: "Exact path", title: "Every pixel sampled along the gradient's path: no stops at all", disabled: s.blend === "bands" },
          { v: "stops", label: "Stops", title: "The sampled stops blended in sRGB, like the CSS and SVG" },
        ], s.pngSource, (v) => this.set({ pngSource: v }))),
      );
    } else if (s.tab === "blender") {
      this.opts.append(this.check("Assign to the active object", s.blenderApply, (v) => this.set({ blenderApply: v })));
    } else {
      this.opts.append(this.field("Format", this.seg<StopsFormat>([
        { v: "hex", label: "Hex list" },
        { v: "css-vars", label: "CSS variables" },
        { v: "json", label: "JSON" },
      ], s.stopsFormat, (v) => this.set({ stopsFormat: v }))));
    }

    this.renderOutput();
  }

  /** Preview, code, note and actions: everything that depends on the values but not the controls. */
  private renderOutput() {
    const s = this.s;
    const grad = this.app.gradient();
    const n = grad.stops.length;
    const pngSource = s.blend === "bands" ? "stops" : s.pngSource;
    this.actions.innerHTML = "";
    this.preview.innerHTML = "";
    this.preview.style.background = "";
    this.code.hidden = false;
    let note = "";

    const previewCanvas = (source: "path" | "stops") => {
      const c = document.createElement("canvas");
      const px = Math.round(this.preview.clientWidth * (window.devicePixelRatio || 1)) || 400;
      renderSquare(c, grad, s, px, source);
      this.preview.append(c);
    };

    if (s.tab === "css") {
      const value = cssGradient(grad, s, s.cssColor, s.cssInterp);
      this.preview.style.background = value;
      const text = cssRule(value, s.cssForm);
      this.code.innerHTML = highlight(text, CSS_RULES);
      this.button("Copy CSS", true, () => copyText(text));
    } else if (s.tab === "svg" || s.tab === "figma") {
      const svg = svgSquare(grad, this.geometry(), s.svgSize);
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      img.alt = "";
      this.preview.append(img);
      this.code.innerHTML = highlightXml(svg);
      if (s.tab === "figma") {
        note = `Copies an SVG of ${n} stops. In Figma, click the canvas and paste (⌘V / Ctrl V): you get a ${s.svgSize} × ${s.svgSize} frame with the gradient as an editable fill.`;
        this.button("Copy for Figma", true, () => copySvg(svg));
      } else {
        this.button("Copy SVG", true, () => copySvg(svg));
        this.button("Download SVG", false, () => download(new Blob([svg], { type: "image/svg+xml" }), "gradient.svg"));
      }
    } else if (s.tab === "png") {
      this.code.hidden = true;
      previewCanvas(pngSource);
      note = pngSource === "path"
        ? `${s.pngSize} × ${s.pngSize} px. Every pixel is sampled along the path itself, so it is smoother than any stop list.`
        : `${s.pngSize} × ${s.pngSize} px, from the ${n} stops.`;
      const blob = () => pngBlob(grad, s, s.pngSize, pngSource);
      this.button("Copy PNG", true, () => navigator.clipboard.write([new ClipboardItem({ "image/png": blob() })]));
      this.button("Download PNG", false, async () => download(await blob(), `gradient-${s.pngSize}.png`));
    } else if (s.tab === "blender") {
      previewCanvas("stops");
      const py = blenderScript(grad, s, s.blenderApply);
      this.code.innerHTML = highlight(py, PY_RULES);
      note = "In Blender, open the Scripting workspace, click New in the Text Editor, paste, and Run Script (Alt P). It adds a “Gradient Paths” material mapped over the object's bounding box.";
      if (n > 32) note += " Blender's Color Ramp holds at most 32 stops.";
      this.button("Copy script", true, () => copyText(py));
      this.button("Download script", false, () => download(new Blob([py], { type: "text/x-python" }), "gradient_paths.py"));
    } else {
      // A plain strip of the stops, flat, in order.
      this.preview.style.background = cssGradient(grad, { ...s, type: "linear", angle: 90, blend: "bands" }, "hex", "srgb");
      const text = stopsText(grad, s.stopsFormat);
      this.showCode(text);
      this.button("Copy stops", true, () => copyText(text));
    }
    this.note.textContent = note;
    this.note.hidden = !note;
  }

  private showCode(text: string) {
    this.code.innerHTML = esc(text);
  }

  private button(label: string, primary: boolean, run: () => Promise<unknown> | void) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "primary-btn" : "text-btn ex-secondary";
    b.textContent = label;
    b.onclick = async () => {
      // Hold the width while the feedback text shows, so neither button resizes.
      b.style.width = `${b.getBoundingClientRect().width}px`;
      try {
        await run();
        b.textContent = primary ? "Copied" : "Saved";
      } catch (err) {
        console.error(err);
        b.textContent = primary ? "Copy failed" : "Failed";
      }
      setTimeout(() => {
        b.textContent = label;
        b.style.width = "";
      }, 1200);
    };
    // Secondary (download) actions sit left of the primary copy action.
    if (primary) this.actions.append(b);
    else this.actions.prepend(b);
  }
}

// --- clipboard and files ---------------------------------------------------------

function copyText(text: string) {
  return navigator.clipboard.writeText(text);
}

/** The SVG as text (what Figma and code editors read), plus as an image where the browser supports it. */
async function copySvg(svg: string) {
  const supports = typeof ClipboardItem !== "undefined" && "supports" in ClipboardItem
    && (ClipboardItem as unknown as { supports(t: string): boolean }).supports("image/svg+xml");
  if (supports) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([svg], { type: "text/plain" }),
        "image/svg+xml": new Blob([svg], { type: "image/svg+xml" }),
      })]);
      return;
    } catch { /* fall back to text */ }
  }
  await navigator.clipboard.writeText(svg);
}

function pngBlob(grad: Gradient, g: Geometry, size: number, source: "path" | "stops"): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const c = document.createElement("canvas");
    renderSquare(c, grad, g, size, source);
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png");
  });
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
