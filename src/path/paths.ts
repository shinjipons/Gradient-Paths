import { clamp01, inUnitCube, rgbToHex, srgbToOklab, oklabToSrgb, type Vec3 } from "../color/convert";
import { isRealColor, type ColorSpace } from "../color/spaces";
import { add, cross, dist, dot, len, lerp, norm, perpendicular, rotate, scale, sub } from "./vec";

export type PathMode =
  | "native"
  | "line"
  | "cylindrical"
  | "arc"
  | "quadratic"
  | "cubic"
  | "polyline"
  | "spline";

export type HueMode = "shorter" | "longer" | "increasing" | "decreasing";
export type Spacing = "parameter" | "space" | "perceptual";
export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "smoother";
export type GamutMap = "clip" | "chroma";

export interface ModeInfo {
  id: PathMode;
  label: string;
  hint: string;
  /** How many control points the mode reads: exact count, or "many" (≥1). */
  points: 0 | 1 | 2 | "many";
  usesHue?: boolean;
}

export const MODES: ModeInfo[] = [
  { id: "native", label: "Native interpolation", hint: "Lerp each channel of the space directly — what CSS `in <space>` does. In polar spaces this sweeps the hue.", points: 0, usesHue: true },
  { id: "line", label: "Straight line", hint: "Shortest path in the drawn (Cartesian) frame. In a cylinder it cuts through the gray core.", points: 0 },
  { id: "cylindrical", label: "Orbit the gray axis", hint: "Interpolate angle, distance and height around the neutral axis, so the path swings around gray instead of through it.", points: 0, usesHue: true },
  { id: "arc", label: "Circular arc", hint: "A circle segment from start to end. Bend sets how far it bows out; roll turns the plane it bows in.", points: 0 },
  { id: "quadratic", label: "Quadratic Bézier", hint: "One control point pulls the curve towards it. Drag the square handle in the slice view.", points: 1 },
  { id: "cubic", label: "Cubic Bézier", hint: "Two control points shape the departure and arrival separately.", points: 2 },
  { id: "polyline", label: "Via waypoints", hint: "Straight segments through intermediate colors — the \"BETTER\" path from the color wheel reference.", points: "many" },
  { id: "spline", label: "Smooth spline", hint: "A centripetal Catmull–Rom spline passing smoothly through every waypoint.", points: "many" },
];

export const modeInfo = (m: PathMode) => MODES.find((x) => x.id === m)!;

export interface PathParams {
  mode: PathMode;
  hueMode: HueMode;
  /** Control points / waypoints in the space's embed frame. */
  points: Vec3[];
  arcBend: number; // -1..1, 1 = semicircle
  arcRoll: number; // degrees
}

// --- hue -----------------------------------------------------------------

export function hueLerp(h1: number, h2: number, t: number, mode: HueMode): number {
  if (Number.isNaN(h1) && Number.isNaN(h2)) return NaN;
  if (Number.isNaN(h1)) return h2;
  if (Number.isNaN(h2)) return h1;
  let d = h2 - h1;
  switch (mode) {
    case "shorter":
      if (d > 180) d -= 360;
      else if (d < -180) d += 360;
      break;
    case "longer":
      if (d > 0 && d < 180) d -= 360;
      else if (d > -180 && d <= 0) d += 360;
      break;
    case "increasing":
      if (d < 0) d += 360;
      break;
    case "decreasing":
      if (d > 0) d -= 360;
      break;
  }
  return (((h1 + d * t) % 360) + 360) % 360;
}

// --- path construction ---------------------------------------------------

export interface PathPoint {
  embed: Vec3;
  native: Vec3;
}
export type PathFn = (t: number) => PathPoint;

/**
 * The direction (perpendicular to A→B) a curve should bow in: the one that
 * keeps a bow of height `bow` comfortably inside sRGB while staying farthest
 * from gray — the "go around, not through" route from the color-wheel
 * reference. Ties (e.g. a symmetric gamut) resolve to the first candidate.
 */
export function bowDirection(space: ColorSpace, a: Vec3, b: Vec3, bow: number): Vec3 {
  const chord = sub(b, a);
  const cn = norm(chord);
  const [o, w] = space.neutral;
  const axis = norm(sub(w, o));
  const ref = perpendicular(chord);
  const radial = (p: Vec3) => {
    const r = sub(p, o);
    return len(sub(r, scale(axis, dot(r, axis))));
  };
  let best = ref;
  let bestScore = -Infinity;
  for (let k = 0; k < 24; k++) {
    const dir = rotate(ref, cn, (k / 24) * Math.PI * 2);
    let inside = 0;
    let far = 0;
    for (let s = 1; s < 12; s++) {
      const u = s / 12;
      const q = add(lerp(a, b, u), scale(dir, bow * 4 * u * (1 - u)));
      const nat = space.unembed(q);
      const rgb = space.toRGB(nat);
      // A small margin, so curves that pass *through* points don't graze the edge.
      const roomy = rgb.every((v) => v >= 0.01 && v <= 0.99) || inUnitCube(rgb, 0);
      if (rgb.every(Number.isFinite) && isRealColor(space, nat, rgb)) inside += roomy ? 1 : 0.6;
      far += radial(q);
    }
    const score = inside * 10 + far;
    if (score > bestScore + 1e-6) {
      bestScore = score;
      best = dir;
    }
  }
  return best;
}

/** A default for control point i of n. `through`: the curve passes through it. */
export function defaultPoint(space: ColorSpace, a: Vec3, b: Vec3, i: number, n: number, through: boolean): Vec3 {
  const t = (i + 1) / (n + 1);
  const L = len(sub(b, a));
  // A Bézier only reaches halfway to its control point; a spline hits it.
  // A cubic's two handles bow it 1.5× as far as one quadratic handle would.
  const mag = through ? Math.max(0.15, L * 0.22) : Math.max(0.25, L * 0.4) * (n === 2 ? 2 / 3 : 1);
  const dir = bowDirection(space, a, b, through ? mag : mag / 2);
  return add(lerp(a, b, t), scale(dir, mag * (through ? 4 * t * (1 - t) : 1)));
}

export function ensurePoints(space: ColorSpace, a: Vec3, b: Vec3, p: PathParams): Vec3[] {
  const need = modeInfo(p.mode).points;
  const n = need === "many" ? Math.max(1, p.points.length) : need;
  const pts = p.points.slice(0, Math.max(n, p.points.length));
  for (let i = pts.length; i < n; i++) pts.push(defaultPoint(space, a, b, i, n, need === "many"));
  return pts;
}

export function buildPath(space: ColorSpace, aRGB: Vec3, bRGB: Vec3, p: PathParams): PathFn {
  const an = space.fromRGB(aRGB);
  const bn = space.fromRGB(bRGB);
  const A = space.embed(an);
  const B = space.embed(bn);
  const fromEmbed = (e: Vec3): PathPoint => ({ embed: e, native: space.unembed(e) });
  const pts = p.points;

  switch (p.mode) {
    case "native": {
      const h = space.hueIndex;
      return (t) => {
        const native = [0, 1, 2].map((i) =>
          i === h ? hueLerp(an[i], bn[i], t, p.hueMode) : an[i] + (bn[i] - an[i]) * t,
        ) as Vec3;
        return { native, embed: space.embed(native) };
      };
    }
    case "line":
      return (t) => fromEmbed(lerp(A, B, t));

    case "cylindrical": {
      const [o, w] = space.neutral;
      const axis = norm(sub(w, o));
      const e1 = perpendicular(axis);
      const e2 = cross(axis, e1);
      const polar = (q: Vec3) => {
        const r = sub(q, o);
        const hgt = dot(r, axis);
        const x = dot(r, e1);
        const y = dot(r, e2);
        const rad = Math.hypot(x, y);
        const ang = rad < 1e-4 ? NaN : (((Math.atan2(y, x) * 180) / Math.PI) % 360 + 360) % 360;
        return { hgt, rad, ang };
      };
      const pa = polar(A);
      const pb = polar(B);
      return (t) => {
        const ang = hueLerp(pa.ang, pb.ang, t, p.hueMode);
        const rad = pa.rad + (pb.rad - pa.rad) * t;
        const hgt = pa.hgt + (pb.hgt - pa.hgt) * t;
        const r = (((Number.isNaN(ang) ? 0 : ang) * Math.PI) / 180);
        const e = add(add(o, scale(axis, hgt)), add(scale(e1, rad * Math.cos(r)), scale(e2, rad * Math.sin(r))));
        return fromEmbed(e);
      };
    }

    case "arc": {
      const chord = sub(B, A);
      const c = len(chord) / 2;
      const h = p.arcBend * c;
      if (c < 1e-6 || Math.abs(h) < 1e-6) return (t) => fromEmbed(lerp(A, B, t));
      const cx = norm(chord);
      const mid = lerp(A, B, 0.5);
      // Roll 0 bows the way that stays in gamut and away from gray.
      const bow = bowDirection(space, A, B, Math.abs(h));
      const cy = rotate(bow, cx, (p.arcRoll * Math.PI) / 180);
      const R = (c * c + h * h) / (2 * h);
      const alpha = 2 * Math.atan(h / c);
      return (t) => {
        const ang = -alpha + 2 * alpha * t;
        const lx = R * Math.sin(ang);
        const ly = h - R + R * Math.cos(ang);
        return fromEmbed(add(mid, add(scale(cx, lx), scale(cy, ly))));
      };
    }

    case "quadratic": {
      const P = pts[0];
      return (t) => {
        const s = 1 - t;
        return fromEmbed(add(add(scale(A, s * s), scale(P, 2 * s * t)), scale(B, t * t)));
      };
    }

    case "cubic": {
      const [P, Q] = pts;
      return (t) => {
        const s = 1 - t;
        return fromEmbed(
          add(
            add(scale(A, s * s * s), scale(P, 3 * s * s * t)),
            add(scale(Q, 3 * s * t * t), scale(B, t * t * t)),
          ),
        );
      };
    }

    case "polyline": {
      const all = [A, ...pts, B];
      const cum = [0];
      for (let i = 1; i < all.length; i++) cum.push(cum[i - 1] + dist(all[i - 1], all[i]));
      const total = cum[cum.length - 1] || 1;
      return (t) => {
        const target = t * total;
        let i = 1;
        while (i < cum.length - 1 && cum[i] < target) i++;
        const seg = cum[i] - cum[i - 1] || 1;
        return fromEmbed(lerp(all[i - 1], all[i], (target - cum[i - 1]) / seg));
      };
    }

    case "spline": {
      const all = [A, ...pts, B];
      const ext = [sub(scale(A, 2), all[1]), ...all, sub(scale(B, 2), all[all.length - 2])];
      const segs = all.length - 1;
      const w = Array.from({ length: segs }, (_, i) => Math.sqrt(dist(all[i], all[i + 1])) + 1e-6);
      const cum = [0];
      for (const x of w) cum.push(cum[cum.length - 1] + x);
      const total = cum[segs];
      return (t) => {
        const target = t * total;
        let i = 0;
        while (i < segs - 1 && cum[i + 1] < target) i++;
        const lt = (target - cum[i]) / w[i];
        return fromEmbed(catmullRom(ext[i], ext[i + 1], ext[i + 2], ext[i + 3], Math.min(1, Math.max(0, lt))));
      };
    }
  }
}

/** Centripetal Catmull–Rom (Barry–Goldman), segment p1→p2, t ∈ [0,1]. */
function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, u: number): Vec3 {
  const k = (a: Vec3, b: Vec3) => Math.max(1e-6, Math.sqrt(dist(a, b)));
  const t0 = 0;
  const t1 = t0 + k(p0, p1);
  const t2 = t1 + k(p1, p2);
  const t3 = t2 + k(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const L = (a: Vec3, b: Vec3, ta: number, tb: number) => lerp(a, b, (t - ta) / (tb - ta));
  const A1 = L(p0, p1, t0, t1);
  const A2 = L(p1, p2, t1, t2);
  const A3 = L(p2, p3, t2, t3);
  const B1 = L(A1, A2, t0, t2);
  const B2 = L(A2, A3, t1, t3);
  return L(B1, B2, t1, t2);
}

// --- sampling --------------------------------------------------------------

export const EASINGS: Record<Easing, (x: number) => number> = {
  linear: (x) => x,
  "ease-in": (x) => x * x * x,
  "ease-out": (x) => 1 - (1 - x) ** 3,
  "ease-in-out": (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  smoother: (x) => x * x * x * (x * (x * 6 - 15) + 10),
};

export interface Sample {
  t: number;
  embed: Vec3;
  native: Vec3;
  /** sRGB, unclamped: may be outside [0,1]. */
  rgb: Vec3;
  /** sRGB after gamut mapping, safe to display. */
  display: Vec3;
  hex: string;
  inGamut: boolean;
  oklab: Vec3;
}

export function mapToGamut(rgb: Vec3, method: GamutMap): Vec3 {
  if (inUnitCube(rgb, 0) || method === "clip") return rgb.map(clamp01) as Vec3;
  const [L, a, b] = srgbToOklab(rgb);
  if (!(L > 0)) return [0, 0, 0];
  if (L >= 1) return [1, 1, 1];
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inUnitCube(oklabToSrgb([L, a * mid, b * mid]), 0)) lo = mid;
    else hi = mid;
  }
  return oklabToSrgb([L, a * lo, b * lo]).map(clamp01) as Vec3;
}

export interface Gradient {
  dense: Sample[];
  /** Sample at gradient position u ∈ [0,1], after spacing + easing. */
  at(u: number): Sample;
  stops: Sample[];
  /** Total perceptual length (ΔE OK × 100). */
  deltaE: number;
  outOfGamut: number;
}

export function computeGradient(
  space: ColorSpace,
  path: PathFn,
  opts: { spacing: Spacing; easing: Easing; gamut: GamutMap; stops: number },
): Gradient {
  const sampleAt = (t: number): Sample => {
    const { embed, native } = path(t);
    const rgb = space.toRGB(native);
    const finite = rgb.every(Number.isFinite);
    const safe: Vec3 = finite ? rgb : [0, 0, 0];
    const display = mapToGamut(safe, opts.gamut);
    return {
      t,
      embed,
      native,
      rgb: safe,
      display,
      hex: rgbToHex(display),
      inGamut: finite && isRealColor(space, native, rgb),
      oklab: srgbToOklab(safe),
    };
  };

  const N = 600;
  const dense = Array.from({ length: N + 1 }, (_, i) => sampleAt(i / N));

  // Cumulative arc length in the chosen metric, to reparameterize t.
  const metric = (s: Sample) => (opts.spacing === "perceptual" ? s.oklab : s.embed);
  const cum = [0];
  for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + dist(metric(dense[i - 1]), metric(dense[i])));
  const okLen = dense.reduce((acc, s, i) => (i ? acc + dist(dense[i - 1].oklab, s.oklab) : 0), 0);
  const total = cum[N];

  const tFor = (x: number): number => {
    if (opts.spacing === "parameter" || total < 1e-9) return x;
    const target = x * total;
    let lo = 0;
    let hi = N;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] < target) lo = m;
      else hi = m;
    }
    const seg = cum[hi] - cum[lo] || 1;
    return (lo + (target - cum[lo]) / seg) / N;
  };

  const ease = EASINGS[opts.easing];
  const at = (u: number) => sampleAt(tFor(Math.min(1, Math.max(0, ease(u)))));
  const n = Math.max(2, opts.stops);
  const stops = Array.from({ length: n }, (_, i) => at(i / (n - 1)));
  return {
    dense,
    at,
    stops,
    deltaE: okLen * 100,
    outOfGamut: dense.filter((s) => !s.inGamut).length / dense.length,
  };
}
