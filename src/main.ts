import { Object3D } from "three";
import { hexToRgb, rgbToHex, type Vec3 } from "./color/convert";
import { SPACES, spaceById } from "./color/spaces";
import {
  MODES,
  buildPath,
  computeGradient,
  ensurePoints,
  mapToGamut,
  modeInfo,
  type GamutMap,
  type HueMode,
  type PathMode,
  type Spacing,
} from "./path/paths";
import { add, dist, dot, scale } from "./path/vec";
import { convertPoints, deserialize, serialize, type PlaneKind, type SolidStyle } from "./state";
import { LineChart, type Series } from "./views/charts";
import { makePlane, type Plane } from "./views/plane";
import { SliceView } from "./views/slice2d";
import { View3D } from "./views/view3d";

// Z-up world. Must be set before any Object3D is constructed.
Object3D.DEFAULT_UP.set(0, 0, 1);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const state = deserialize(location.hash);
let space = spaceById(state.space);
/** The slice plane is held still while a handle is dragged on it. */
let frozenPlane: Plane | null = null;

// --- static UI ---------------------------------------------------------------

const PRESETS: [string, string][] = [
  ["#0000ff", "#ffff00"],
  ["#ff0000", "#00ffff"],
  ["#ff00ff", "#00ff00"],
  ["#000000", "#ffffff"],
  ["#ff6a00", "#0066ff"],
  ["#2f0f5d", "#ffd166"],
  ["#00a6a6", "#f72585"],
];
$("presets").append(
  ...PRESETS.map(([a, b]) => {
    const btn = document.createElement("button");
    btn.className = "preset";
    btn.title = `${a} → ${b}`;
    btn.style.background = `linear-gradient(90deg, ${a}, ${b})`;
    btn.onclick = () => {
      state.a = hexToRgb(a)!;
      state.b = hexToRgb(b)!;
      render();
    };
    return btn;
  }),
);

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

seg($("space-seg"), SPACES.map((s) => ({ v: s.id, label: s.label })), (id) => {
  const next = spaceById(id);
  state.points = convertPoints(state.points, space, next);
  space = next;
  state.space = id;
  render();
});

const modeSel = $<HTMLSelectElement>("mode");
modeSel.innerHTML = MODES.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
modeSel.onchange = () => {
  state.mode = modeSel.value as PathMode;
  render();
};

seg<HueMode>($("hue-seg"), [
  { v: "shorter", label: "Shorter" },
  { v: "longer", label: "Longer" },
  { v: "increasing", label: "↻ Incr." , title: "Increasing hue" },
  { v: "decreasing", label: "↺ Decr.", title: "Decreasing hue" },
], (v) => { state.hueMode = v; render(); });

seg<Spacing>($("spacing-seg"), [
  { v: "parameter", label: "Curve t", title: "Evenly spaced in the curve's own parameter" },
  { v: "space", label: "Distance", title: "Evenly spaced by distance in the drawn space" },
  { v: "perceptual", label: "Perceptual", title: "Evenly spaced by OKLab ΔE — every step looks equally big" },
], (v) => { state.spacing = v; render(); });

seg<GamutMap>($("gamut-seg"), [
  { v: "chroma", label: "Reduce chroma", title: "Keep lightness and hue, lower chroma until it fits sRGB" },
  { v: "clip", label: "Clip", title: "Clamp each RGB channel to 0–1" },
], (v) => { state.gamut = v; render(); });

seg<PlaneKind>($("plane-seg"), [
  { v: "path", label: "Path plane", title: "The plane the curve bends in" },
  { v: "horizontal", label: "Horizontal" },
  { v: "vertical", label: "Vertical" },
], (v) => { state.plane.kind = v; fitPlane(); render(); });

const bind = (id: string, apply: (v: number) => void) => {
  const el = $<HTMLInputElement>(id);
  el.oninput = () => { apply(Number(el.value)); render(); };
};
bind("bend", (v) => (state.arcBend = v));
bind("roll", (v) => (state.arcRoll = v));
bind("stops", (v) => (state.stops = v));
bind("offset", (v) => (state.plane.offset = v));
bind("angle", (v) => (state.plane.angle = v));
bind("opacity", (v) => (state.opacity = v));
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
$("swap").onclick = () => {
  [state.a, state.b] = [state.b, state.a];
  state.points.reverse();
  render();
};

$("add-point").onclick = () => {
  const pts = state.points;
  const B = space.embed(space.fromRGB(state.b));
  const from = pts.length ? pts[pts.length - 1] : space.embed(space.fromRGB(state.a));
  pts.push(scale(add(from, B), 0.5));
  render();
};

$("fit-plane").onclick = () => { fitPlane(); render(); };

$("copy").onclick = async () => {
  const btn = $("copy");
  try {
    await navigator.clipboard.writeText($("css").textContent ?? "");
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy CSS"), 1200);
};

// --- views -------------------------------------------------------------------

const view3d = new View3D($("view3d"));
$("proj").onclick = () => { $("proj").textContent = view3d.toggleProjection() === "persp" ? "Persp" : "Ortho"; };
document.querySelectorAll<HTMLButtonElement>("[data-snap]").forEach((b) => {
  b.onclick = () => {
    view3d.snap(b.dataset.snap as "top" | "front" | "right");
    $("proj").textContent = "Ortho";
  };
});
$("reset-cam").onclick = () => { view3d.reset(); $("proj").textContent = "Persp"; };

const slice = new SliceView($("slice"), {
  onDragStart: () => (frozenPlane = currentPlane ?? null),
  onDragEnd: () => { frozenPlane = null; render(); },
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
    render();
  },
});

const chartChannels = new LineChart($("chart-channels"));
const chartSpeed = new LineChart($("chart-speed"));

// --- render ------------------------------------------------------------------

let currentPlane: Plane | undefined;
let lastDense: Vec3[] = [];

function fitPlane() {
  const A = space.embed(space.fromRGB(state.a));
  const B = space.embed(space.fromRGB(state.b));
  if (state.plane.kind === "horizontal") {
    const zs = lastDense.length ? lastDense.map((p) => p[2]) : [A[2], B[2]];
    state.plane.offset = round2(zs.reduce((s, z) => s + z, 0) / zs.length);
  } else if (state.plane.kind === "vertical") {
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    let ang = Math.hypot(dx, dy) > 1e-3 ? (Math.atan2(dy, dx) * 180) / Math.PI : 45;
    ang = ((ang % 180) + 180) % 180;
    const r = (ang * Math.PI) / 180;
    state.plane.angle = Math.round(ang);
    state.plane.offset = round2(dot([Math.sin(r), -Math.cos(r), 0], A));
  }
}
const round2 = (x: number) => Math.round(Math.max(-1, Math.min(1, x)) * 100) / 100;

let raf = 0;
function scheduleRender() {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
}

function render() {
  const info = modeInfo(state.mode);
  const A = space.embed(space.fromRGB(state.a));
  const B = space.embed(space.fromRGB(state.b));
  state.points = ensurePoints(space, A, B, { ...state, points: state.points });
  const used = info.points === "many" ? state.points : state.points.slice(0, info.points);

  const path = buildPath(space, state.a, state.b, { ...state, points: used });
  const grad = computeGradient(space, path, state);
  lastDense = grad.dense.map((d) => d.embed);
  const plane = frozenPlane ?? makePlane(state.plane.kind, state.plane.offset, state.plane.angle, space, A, B, lastDense, currentPlane);
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
  segSet($("space-seg"), space.id);
  $("space-blurb").textContent = space.blurb;
  modeSel.value = state.mode;
  $("mode-hint").innerHTML = info.hint.replace(/`([^`]+)`/g, "<code>$1</code>");
  const hueApplies = !!info.usesHue && (state.mode === "cylindrical" || space.hueIndex >= 0);
  $("hue-field").hidden = !info.usesHue;
  segSet($("hue-seg"), state.hueMode, !hueApplies);
  $("arc-fields").hidden = state.mode !== "arc";
  setRange("bend", state.arcBend, `${Math.round(state.arcBend * 100)}%`);
  setRange("roll", state.arcRoll, `${Math.round(state.arcRoll)}°`);
  setRange("stops", state.stops, String(state.stops));
  segSet($("spacing-seg"), state.spacing);
  $<HTMLSelectElement>("easing").value = state.easing;
  segSet($("gamut-seg"), state.gamut);
  segSet($("plane-seg"), state.plane.kind);
  $("offset-field").hidden = state.plane.kind === "path";
  $("angle-field").hidden = state.plane.kind !== "vertical";
  $("fit-plane").hidden = state.plane.kind === "path";
  setRange("offset", state.plane.offset, state.plane.offset.toFixed(2));
  setRange("angle", state.plane.angle, `${Math.round(state.plane.angle)}°`);
  $<HTMLSelectElement>("solid").value = state.solid;
  setRange("opacity", state.opacity, "");
  $<HTMLInputElement>("opacity").hidden = state.solid !== "surface";

  // Control point list.
  $("points-field").hidden = info.points === 0;
  $("add-point").hidden = info.points !== "many";
  $("points").innerHTML = "";
  used.forEach((p, i) => {
    const native = space.unembed(p);
    const rgb = space.toRGB(native);
    const ok = rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
    const disp = rgbToHex(mapToGamut(rgb.every(Number.isFinite) ? rgb : [0, 0, 0], state.gamut));
    const li = document.createElement("li");
    li.innerHTML = `<span class="n">${i + 1}</span><span class="sw${ok ? "" : " oog"}" style="background:${disp}"></span><code>${formatNative(native)}${ok ? "" : " · outside sRGB"}</code>`;
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
    if (!s.inGamut) {
      sctx.fillStyle = (x >> 1) % 2 ? "rgba(255,255,255,.9)" : "rgba(0,0,0,.9)";
      sctx.fillRect(Math.floor((x * strip.width) / cols), strip.height - 5 * dpr, Math.ceil(strip.width / cols) + 1, 5 * dpr);
    }
  }

  // Stops.
  $("stops-label").textContent = `${grad.stops.length} stops`;
  $("stop-swatches").innerHTML = "";
  for (const st of grad.stops) {
    const d = document.createElement("div");
    d.style.background = st.hex;
    d.title = `${st.hex}${st.inGamut ? "" : " (mapped from outside sRGB)"} — click to copy`;
    if (!st.inGamut) d.className = "oog-stop";
    d.onclick = () => navigator.clipboard?.writeText(st.hex).catch(() => {});
    $("stop-swatches").append(d);
  }

  // Browser's own interpolation, for comparison.
  const native = $("native");
  if (space.css) {
    const hue = space.hueIndex >= 0 ? ` ${state.hueMode} hue` : "";
    const g = `linear-gradient(to right in ${space.css}${hue}, ${aHex}, ${bHex})`;
    native.style.background = CSS.supports("background-image", g) ? g : "none";
    $("native-label").textContent = `CSS in ${space.css}`;
    native.title = g;
  } else {
    native.style.background = "repeating-linear-gradient(45deg, #1f1f1d 0 6px, #191918 6px 12px)";
    $("native-label").textContent = "No CSS space";
    native.title = `${space.label} has no CSS interpolation space`;
  }

  // Stats + CSS.
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
  const n = grad.stops.length;
  $("css").textContent = `background: linear-gradient(90deg, ${grad.stops
    .map((s, i) => `${s.hex} ${+((i / (n - 1)) * 100).toFixed(2)}%`)
    .join(", ")});`;

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
    series: [{ name: "ΔE / 1%", color: "#3987e5", values: [speed[0], ...speed], format: (i) => (speed[Math.max(0, i - 1)]).toFixed(2) }],
    band,
    yMin: 0,
    yMax: top,
    yTicks: [0, top / 2, top].map((v) => ({ v, label: v.toFixed(v < 2 ? 2 : 1) })),
    ref: { v: mean, label: `avg ${mean.toFixed(2)}` },
    area: true,
  });

  history.replaceState(null, "", `#${serialize(state)}`);
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

function niceMax(x: number): number {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

function setRange(id: string, v: number, text: string) {
  const el = $<HTMLInputElement>(id);
  if (document.activeElement !== el) el.value = String(v);
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
if (state.plane.kind !== "path") fitPlane();
render();
