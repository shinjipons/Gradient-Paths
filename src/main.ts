import "@fontsource-variable/inter";
import { inject } from "@vercel/analytics";
import { Object3D } from "three";
import {
  Blend,
  Camera,
  ChartSpline,
  createElement,
  GitFork,
  Globe,
  Orbit,
  Rainbow,
  Route,
  Slash,
  Spline,
  SplinePointer,
  SquareDashed,
  type IconNode,
} from "lucide";
import { clamp01, hexToRgb, oklabToSrgb, rgbToHex, srgbToOklab, type Vec3 } from "./color/convert";
import { SPACES, spaceById } from "./color/spaces";
import {
  MODES,
  buildPath,
  computeGradient,
  ensurePoints,
  mapToGamut,
  modeInfo,
  type HueMode,
  type PathMode,
  type Spacing,
} from "./path/paths";
import { add, dist, dot, scale, sub } from "./path/vec";
import { UndoHistory } from "./history";
import { convertPoints, deserialize, serialize, type SolidStyle } from "./state";
import { LineChart, type Series } from "./views/charts";
import { makePlane, type Plane } from "./views/plane";
import { SliceView } from "./views/slice2d";
import { View3D, type TranslateSpace } from "./views/view3d";

// Vercel Web Analytics. Its route tracking only hooks pushState, and the app
// writes its state with replaceState, so editing a gradient adds no page
// views. The hash (the whole gradient state) is dropped from the reported URL.
inject({
  beforeSend: (event) => ({ ...event, url: event.url.split("#")[0] }),
});

// Z-up world. Must be set before any Object3D is constructed.
Object3D.DEFAULT_UP.set(0, 0, 1);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const state = deserialize(location.hash);
let space = spaceById(state.space);
/**
 * The slice plane is locked once a handle is dragged on it, and stays locked
 * after the drag, so editing in 2D never re-orients the view. Any change made
 * elsewhere (pickers, space, path settings) unlocks it.
 */
let lockedPlane: Plane | null = null;

// --- static UI ---------------------------------------------------------------

function seg<T extends string>(host: HTMLElement, opts: { v: T; label: string; title?: string }[], onPick: (v: T) => void) {
  host.innerHTML = "";
  for (const o of opts) {
    const b = document.createElement("button");
    b.textContent = o.label;
    b.dataset.v = o.v;
    if (o.title) b.title = o.title;
    b.onclick = () => onPick(o.v);
    host.append(b);
  }
}
function segSet(host: HTMLElement, v: string, disabled = false) {
  host.querySelectorAll("button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.v === v));
    b.disabled = disabled;
  });
}

// Grouped by family; the current space's blurb shows in Options and the tooltip.
const spaceSel = $<HTMLSelectElement>("space");
spaceSel.innerHTML = [...new Set(SPACES.map((s) => s.family))]
  .map(
    (fam) =>
      `<optgroup label="${fam}">${SPACES.filter((s) => s.family === fam)
        .map((s) => `<option value="${s.id}">${s.label}</option>`)
        .join("")}</optgroup>`,
  )
  .join("");
spaceSel.onchange = () => {
  const next = spaceById(spaceSel.value);
  state.points = convertPoints(state.points, space, next);
  space = next;
  state.space = next.id;
  render();
};

// Path modes live in the 3D view's vertical toolbar, one icon button each.
const MODE_ICONS: Record<PathMode, IconNode> = {
  native: Blend,
  line: Slash,
  cylindrical: Orbit,
  arc: Rainbow,
  quadratic: Spline,
  cubic: SplinePointer,
  polyline: Route,
  spline: ChartSpline,
};
const modeBtns = new Map<PathMode, HTMLButtonElement>();
for (const m of MODES) {
  const b = document.createElement("button");
  b.className = "tool-btn";
  b.title = `${m.label}: ${m.hint.replace(/`/g, "")}`;
  b.setAttribute("aria-label", m.label);
  b.append(createElement(MODE_ICONS[m.id], { width: 18, height: 18 }));
  b.onclick = () => { state.mode = m.id; render(); };
  modeBtns.set(m.id, b);
  $("view3d-tools").append(b);
}

seg<HueMode>($("hue-seg"), [
  { v: "shorter", label: "Shorter arc" },
  { v: "longer", label: "Longer arc" },
  { v: "increasing", label: "Increasing hue" },
  { v: "decreasing", label: "Decreasing hue" },
], (v) => { state.hueMode = v; render(); });

seg<Spacing>($("spacing-seg"), [
  { v: "parameter", label: "Curve t", title: "Evenly spaced in the curve's own parameter" },
  { v: "space", label: "Distance", title: "Evenly spaced by distance in the drawn space" },
  { v: "perceptual", label: "Perceptual", title: "Evenly spaced by OKLab ΔE — every step looks equally big" },
], (v) => { state.spacing = v; render(); });



const bind = (id: string, apply: (v: number) => void) => {
  const el = $<HTMLInputElement>(id);
  el.oninput = () => { apply(Number(el.value)); render(); };
};
bind("bend", (v) => (state.arcBend = v));
bind("roll", (v) => (state.arcRoll = v));
bind("stops", (v) => (state.stops = v));
$<HTMLSelectElement>("easing").onchange = (e) => { state.easing = (e.target as HTMLSelectElement).value as typeof state.easing; render(); };
$<HTMLSelectElement>("solid").onchange = (e) => { state.solid = (e.target as HTMLSelectElement).value as SolidStyle; render(); };

for (const which of ["a", "b"] as const) {
  const picker = $<HTMLInputElement>(`${which}-color`);
  const text = $<HTMLInputElement>(`${which}-hex`);
  picker.oninput = () => { state[which] = hexToRgb(picker.value)!; render(); };
  text.onchange = () => {
    const rgb = hexToRgb(text.value);
    if (rgb) state[which] = rgb;
    render();
  };
}

$("add-point").onclick = () => {
  const pts = state.points;
  const B = space.embed(space.fromRGB(state.b));
  const from = pts.length ? pts[pts.length - 1] : space.embed(space.fromRGB(state.a));
  pts.push(scale(add(from, B), 0.5));
  render();
};

// Clicking a button over the 3D view (either toolbar, the path options panel) must not leave it
// focused: Shift, a 3D-view modifier, would then light up its keyboard focus ring. Tab still focuses them.
document.addEventListener("mousedown", (e) => {
  if ((e.target as Element).closest?.(".vtoolbar button, .mode-panel button")) e.preventDefault();
});

// Flatten the curve into the section plane: each control point drops along the plane's normal.
$("planarize").onclick = () => {
  const pl = currentPlane;
  if (!pl) return;
  state.points = state.points.map((p) => sub(p, scale(pl.n, dot(sub(p, pl.origin), pl.n))));
  render();
};


/** The gradient's stops as a CSS background, refreshed on every render. */
let gradientCss = "";
$("copy-css").onclick = async () => {
  const btn = $("copy-css");
  try {
    await navigator.clipboard.writeText(gradientCss);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy CSS"), 1200);
};

// --- top bar popovers ----------------------------------------------------------

const popButtons = [...document.querySelectorAll<HTMLButtonElement>(".pop-btn")];
const closePops = (except?: HTMLButtonElement) =>
  popButtons.forEach((b) => b !== except && b.setAttribute("aria-expanded", "false"));
popButtons.forEach((btn) => {
  btn.onclick = () => {
    const open = btn.getAttribute("aria-expanded") !== "true";
    closePops(btn);
    btn.setAttribute("aria-expanded", String(open));
  };
});
document.addEventListener("pointerdown", (e) => {
  if (!(e.target as Element).closest(".pop")) closePops();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePops();
});

// --- views -------------------------------------------------------------------

// --- undo / redo -------------------------------------------------------------

const undoBtn = $<HTMLButtonElement>("undo");
const redoBtn = $<HTMLButtonElement>("redo");
const undoHistory = new UndoHistory(() => {
  undoBtn.disabled = !undoHistory.canUndo;
  redoBtn.disabled = !undoHistory.canRedo;
});
function stepHistory(redo: boolean) {
  if (!(redo ? undoHistory.redo(state) : undoHistory.undo(state))) return;
  // A focused range input is skipped when syncing controls; let the restored value show.
  const f = document.activeElement;
  if (f instanceof HTMLInputElement && f.type === "range") f.blur();
  space = spaceById(state.space);
  render();
}
undoBtn.onclick = () => stepHistory(false);
redoBtn.onclick = () => stepHistory(true);
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k !== "z" && k !== "y") return;
  // Text fields keep their own undo.
  const t = e.target as HTMLElement;
  if (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && (t as HTMLInputElement).type === "text")) return;
  e.preventDefault();
  stepHistory(k === "y" || e.shiftKey);
});

const view3d = new View3D($("view3d"), {
  // The slice keeps re-orienting live, which re-rasterizes it every frame: a draft one while dragging.
  onDragStart: () => { slice.setDraft(true); undoHistory.holding = true; },
  onDragEnd: () => { undoHistory.holding = false; slice.setDraft(false); render(); },
  onEndpoint: (which, rgb) => { state[which] = rgb; scheduleRender(); },
  onPoint: (i, e) => { state.points[i] = e; scheduleRender(); },
});
$("reset-cam").onclick = () => view3d.reset();

// Right-edge tools: which axes the selection gizmo moves a handle along.
const SPACE_TOOLS: { v: TranslateSpace; label: string; hint: string; icon: IconNode }[] = [
  { v: "world", label: "World axes", hint: "Move along the color space's own X, Y and Z axes", icon: Globe },
  { v: "camera", label: "Camera axes", hint: "Move across the screen, left–right and up–down", icon: Camera },
  { v: "plane", label: "Section plane axes", hint: "Move within the section plane, or along its normal", icon: SquareDashed },
  {
    v: "slide",
    label: "Slide along edges",
    hint: "Control points: slide along either control-polygon edge, or along their bisector. Endpoints use world axes",
    icon: GitFork,
  },
];
const spaceBtns = SPACE_TOOLS.map(({ v, label, hint, icon }) => {
  const b = document.createElement("button");
  b.className = "tool-btn";
  b.title = `${label}: ${hint}`;
  b.setAttribute("aria-label", label);
  b.append(createElement(icon, { width: 18, height: 18 }));
  b.onclick = () => setTranslateSpace(v);
  $("view3d-tools-right").append(b);
  return b;
});
function setTranslateSpace(v: TranslateSpace) {
  view3d.setTranslateSpace(v);
  spaceBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(SPACE_TOOLS[i].v === v)));
}
setTranslateSpace("world");

const slice = new SliceView($("slice"), {
  onDragStart: () => { lockedPlane = currentPlane ?? null; undoHistory.holding = true; },
  onDragEnd: () => { undoHistory.holding = false; render({ keepPlane: true }); },
  onEndpoint: (which, rgb) => { state[which] = rgb; scheduleRender(); },
  onPoint: (i, e) => { state.points[i] = e; scheduleRender(); },
  onAddPoint: (e) => {
    const A = space.embed(space.fromRGB(state.a));
    const B = space.embed(space.fromRGB(state.b));
    const chain = [A, ...state.points, B];
    let best = 0;
    let bestCost = Infinity;
    for (let i = 0; i < chain.length - 1; i++) {
      const cost = dist(chain[i], e) + dist(e, chain[i + 1]) - dist(chain[i], chain[i + 1]);
      if (cost < bestCost) { bestCost = cost; best = i; }
    }
    state.points.splice(best, 0, e);
    render({ keepPlane: true });
  },
});

// Keep the slice plot clear of the floating UI: its header above, the speed
// chart below.
const updateSliceInset = () => {
  const box = $("slice").getBoundingClientRect();
  let top = 0;
  const view = $("slice").closest(".view")!;
  const head = view.querySelector(".view-head")!.getBoundingClientRect();
  if (head.height > 0) top = head.bottom - box.top + 8;
  // The charts are always open, so reserving all of the taller one never resizes the plot.
  let bottom = 0;
  for (const chart of view.querySelectorAll<HTMLElement>(".pinned-chart")) {
    if (getComputedStyle(chart).position === "absolute") {
      bottom = Math.max(bottom, box.bottom - chart.getBoundingClientRect().top + 8);
    }
  }
  slice.setInsets(Math.max(0, top), Math.max(0, bottom));
};
const insetObserver = new ResizeObserver(updateSliceInset);
insetObserver.observe($("slice"));
for (const chart of $("slice").closest(".view")!.querySelectorAll(".pinned-chart")) insetObserver.observe(chart);

$("reset-slice").onclick = () => slice.resetView();

// Its direct labels are short channel names ("OK L" at most), so a narrow gutter fits.
const chartChannels = new LineChart($("chart-channels"), 36);
const chartSpeed = new LineChart($("chart-speed"));

// --- render ------------------------------------------------------------------

let currentPlane: Plane | undefined;
let lastDense: Vec3[] = [];


let raf = 0;
function scheduleRender() {
  // Only drags and resizes come through here. A 2D drag holds the slice still (lockedPlane);
  // a 3D drag leaves it unlocked, so it re-orients as the path moves.
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; render({ keepPlane: true }); });
}

function render(opts: { keepPlane?: boolean } = {}) {
  if (!opts.keepPlane) lockedPlane = null;
  const info = modeInfo(state.mode);
  const A = space.embed(space.fromRGB(state.a));
  const B = space.embed(space.fromRGB(state.b));
  state.points = ensurePoints(space, A, B, { ...state, points: state.points });
  const used = info.points === "many" ? state.points : state.points.slice(0, info.points);

  const path = buildPath(space, state.a, state.b, { ...state, points: used });
  const grad = computeGradient(space, path, state);
  lastDense = grad.dense.map((d) => d.embed);
  const plane = lockedPlane ?? makePlane(space, A, B, lastDense, currentPlane);
  currentPlane = plane;
  const aHex = rgbToHex(state.a);
  const bHex = rgbToHex(state.b);

  // Controls.
  $<HTMLInputElement>("a-color").value = aHex;
  $<HTMLInputElement>("b-color").value = bHex;
  for (const [id, hex] of [["a-hex", aHex], ["b-hex", bHex]]) {
    const el = $<HTMLInputElement>(id);
    if (document.activeElement !== el) el.value = hex;
  }
  spaceSel.value = space.id;
  spaceSel.title = `${space.label} — ${space.blurb}`;
  for (const [id, b] of modeBtns) b.setAttribute("aria-pressed", String(id === state.mode));
  $("mode-title").textContent = info.label;
  const hueApplies = !!info.usesHue && (state.mode === "cylindrical" || space.hueIndex >= 0);
  $("hue-field").hidden = !info.usesHue;
  segSet($("hue-seg"), state.hueMode, !hueApplies);
  $("arc-fields").hidden = state.mode !== "arc";
  setRange("bend", state.arcBend, `${Math.round(state.arcBend * 100)}%`);
  setRange("roll", state.arcRoll, `${Math.round(state.arcRoll)}°`);
  setRange("stops", state.stops, String(state.stops));
  const spacingName = { parameter: "even t", space: "even distance", perceptual: "perceptual" }[state.spacing];
  $("sampling-btn").textContent = `Spacing · ${spacingName}`;
  segSet($("spacing-seg"), state.spacing);
  $<HTMLSelectElement>("easing").value = state.easing;
  $<HTMLSelectElement>("solid").value = state.solid;

  // Control point list.
  $("points-field").hidden = info.points === 0;
  $("add-point").hidden = info.points !== "many";
  $("points").innerHTML = "";
  used.forEach((p, i) => {
    const native = space.unembed(p);
    const rgb = space.toRGB(native);
    // Control points steer the curve and may sit outside sRGB; only the path and its stops are flagged for it.
    const disp = rgbToHex(mapToGamut(rgb.every(Number.isFinite) ? rgb : [0, 0, 0]));
    const li = document.createElement("li");
    li.innerHTML = `<span class="n">${i + 1}</span><span class="sw" style="background:${disp}"></span><code>${formatNative(native)}</code>`;
    if (info.points === "many" && used.length > 1) {
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "Remove";
      del.onclick = () => { state.points.splice(i, 1); render(); };
      li.append(del);
    }
    $("points").append(li);
  });

  // Gradient strip.
  const strip = $<HTMLCanvasElement>("strip");
  const sw = strip.clientWidth;
  const sh = strip.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  strip.width = Math.max(1, Math.round(sw * dpr));
  strip.height = Math.max(1, Math.round(sh * dpr));
  const sctx = strip.getContext("2d")!;
  const cols = Math.max(2, Math.round(sw));
  for (let x = 0; x < cols; x++) {
    const s = grad.at(x / (cols - 1));
    sctx.fillStyle = s.hex;
    sctx.fillRect(Math.floor((x * strip.width) / cols), 0, Math.ceil(strip.width / cols) + 1, strip.height);
    // Out of gamut: black and white stripes over the strip's whole height, so the invalid stretch is unmissable.
    if (!s.inGamut) {
      sctx.fillStyle = (x >> 1) % 2 ? "rgba(255,255,255,.9)" : "rgba(0,0,0,.9)";
      sctx.fillRect(Math.floor((x * strip.width) / cols), 0, Math.ceil(strip.width / cols) + 1, strip.height);
    }
  }

  // Stops.
  $("stops-label").textContent = `${grad.stops.length} stops`;
  $("stop-swatches").innerHTML = "";
  for (const st of grad.stops) {
    const d = document.createElement("div");
    d.style.background = st.hex;
    d.title = `${st.hex}${st.inGamut ? "" : " (outside sRGB, clipped)"} — click to copy`;
    if (!st.inGamut) d.className = "oog-stop";
    const label = document.createElement("span");
    label.textContent = st.hex.slice(1).toUpperCase();
    // An out-of-gamut stop's label sits on a dark chip over the stripes; see .oog-stop.
    if (st.inGamut) label.style.color = labelInk(st.display);
    d.append(label);
    d.onclick = () => navigator.clipboard?.writeText(st.hex).catch(() => {});
    $("stop-swatches").append(d);
  }

  const n = grad.stops.length;
  gradientCss = `background: linear-gradient(90deg, ${grad.stops
    .map((s, i) => `${s.hex} ${+((i / (n - 1)) * 100).toFixed(2)}%`)
    .join(", ")});`;

  // Stats.
  const K = 201;
  const along = Array.from({ length: K }, (_, i) => grad.at(i / (K - 1)));
  const speed = along.slice(1).map((s, i) => dist(s.oklab, along[i].oklab) * 100 / (100 / (K - 1)));
  const mean = speed.reduce((a, b) => a + b, 0) / speed.length;
  const maxS = Math.max(...speed);
  const minS = Math.min(...speed);
  $("stats").innerHTML = [
    `Perceptual length <b>${grad.deltaE.toFixed(1)}</b> ΔE`,
    `Straight-line ΔE <b>${(dist(grad.dense[0].oklab, grad.dense[grad.dense.length - 1].oklab) * 100).toFixed(1)}</b>`,
    `Speed range <b>${minS.toFixed(2)}–${maxS.toFixed(2)}</b>`,
    `Outside sRGB <b>${Math.round(grad.outOfGamut * 100)}%</b>`,
  ].map((s) => `<span>${s}</span>`).join("");

  // 3D + slice.
  const showPolygon = state.mode === "quadratic" || state.mode === "cubic" || state.mode === "spline";
  view3d.setGamut(space, state.solid, state.opacity);
  view3d.setPath({ dense: grad.dense, stops: grad.stops, A, B, aColor: aHex, bColor: bHex, points: used, showPolygon, plane });
  slice.update({
    space, plane, A, B, aColor: aHex, bColor: bHex, points: used, showPolygon,
    canAdd: info.points === "many", dense: grad.dense, stops: grad.stops,
  });

  // Charts.
  const band = along.map((s) => s.hex);
  const rgbColors = ["#e5484d", "#30a46c", "#3987e5"];
  const catColors = ["#3987e5", "#d95926", "#199e70"];
  const series: Series[] = space.channels.map((ch, ci) => {
    const vals: (number | null)[] = [];
    along.forEach((s, i) => {
      const raw = s.native[ci];
      if (!Number.isFinite(raw)) return vals.push(null);
      // Break the line where the hue wraps 360 → 0 rather than drawing a vertical jump.
      const prev = i > 0 ? along[i - 1].native[ci] : NaN;
      const wraps = ch.hue && Number.isFinite(prev) && Math.abs(raw - prev) > 180;
      vals.push(wraps ? null : (raw - ch.min) / (ch.max - ch.min));
    });
    return {
      name: ch.name,
      color: (space.family === "RGB" ? rgbColors : catColors)[ci],
      values: vals,
      format: (i: number) => fmtChannel(along[Math.min(K - 1, i)].native[ci], ch),
    };
  });
  series.push({
    name: "OK L",
    color: "#c3c2b7",
    dashed: true,
    values: along.map((s) => s.oklab[0]),
    format: (i) => `${(along[i].oklab[0] * 100).toFixed(1)}%`,
  });
  $("channels-sub").textContent = `${space.label}, each scaled to its range`;
  chartChannels.update({
    series,
    band,
    yMin: -0.02,
    yMax: 1.02,
    yTicks: [0, 0.5, 1].map((v) => ({ v, label: v === 0 ? "min" : v === 1 ? "max" : "" })),
  });
  const top = niceMax(maxS * 1.15);
  chartSpeed.update({
    series: [{ name: "ΔE / 1%", color: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(), values: [speed[0], ...speed], format: (i) => (speed[Math.max(0, i - 1)]).toFixed(2) }],
    band,
    yMin: 0,
    yMax: top,
    yTicks: [0, top / 2, top].map((v) => ({ v, label: v.toFixed(v < 2 ? 2 : 1) })),
    ref: { v: mean, label: `avg ${mean.toFixed(2)}` },
    area: true,
  });

  history.replaceState(null, "", `#${serialize(state)}`);
  undoHistory.record(state);
}

function fmtChannel(v: number, ch: { scale?: number; unit?: string }): string {
  if (!Number.isFinite(v)) return "—";
  const x = v * (ch.scale ?? 1);
  const digits = Math.abs(x) < 2 && !ch.scale ? 3 : 1;
  return `${x.toFixed(digits)}${ch.unit ?? ""}`;
}

function formatNative(n: Vec3): string {
  return space.channels.map((ch, i) => `${ch.name} ${fmtChannel(n[i], ch)}`).join("  ");
}

/**
 * Text color for a label on a swatch: the swatch's own hue, pushed dark on
 * light swatches and light on dark ones, like a palette card.
 */
function labelInk(rgb: Vec3): string {
  const [L, a, b] = srgbToOklab(rgb);
  const ink: Vec3 = L > 0.68 ? [0.32, a * 0.9, b * 0.9] : [0.96, a * 0.25, b * 0.25];
  return rgbToHex(oklabToSrgb(ink).map(clamp01) as Vec3);
}

function niceMax(x: number): number {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

function setRange(id: string, v: number, text: string) {
  const el = $<HTMLInputElement>(id);
  if (document.activeElement !== el) el.value = String(v);
  const [lo, hi] = [Number(el.min), Number(el.max)];
  el.parentElement!.style.setProperty("--p", `${((v - lo) / (hi - lo)) * 100}%`);
  const out = document.getElementById(`${id}-out`);
  if (out) out.textContent = text;
}

window.addEventListener("resize", scheduleRender);
// A pasted or edited link: replaceState above never fires this.
window.addEventListener("hashchange", () => {
  Object.assign(state, deserialize(location.hash));
  space = spaceById(state.space);
  render();
});
render();
