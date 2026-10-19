import { hexToRgb, rgbToHex, type Vec3 } from "./color/convert";
import { spaceById, type ColorSpace } from "./color/spaces";
import type { Easing, GamutMap, HueMode, PathMode, Spacing } from "./path/paths";

export type SolidStyle = "surface" | "points" | "wire" | "none";

export interface AppState {
  a: Vec3;
  b: Vec3;
  space: string;
  mode: PathMode;
  hueMode: HueMode;
  /** Control points in the current space's embed frame. */
  points: Vec3[];
  arcBend: number;
  arcRoll: number;
  stops: number;
  spacing: Spacing;
  easing: Easing;
  gamut: GamutMap;
  solid: SolidStyle;
  opacity: number;
}

export const DEFAULT_STATE: AppState = {
  a: [0, 0, 1],
  b: [1, 1, 0],
  space: "srgb",
  mode: "line",
  hueMode: "shorter",
  points: [],
  arcBend: 0.35,
  arcRoll: 0,
  stops: 9,
  spacing: "parameter",
  easing: "linear",
  gamut: "chroma",
  solid: "surface",
  opacity: 0.35,
};

/** Re-express control points when the space changes, via (unclamped) sRGB. */
export function convertPoints(points: Vec3[], from: ColorSpace, to: ColorSpace): Vec3[] {
  return points.map((p) => {
    const rgb = from.toRGB(from.unembed(p));
    const e = to.embed(to.fromRGB(rgb));
    return e.every(Number.isFinite) ? e : ([0, 0, 0] as Vec3);
  });
}

// --- URL hash persistence ---------------------------------------------------

export function serialize(s: AppState): string {
  const q = new URLSearchParams({
    a: rgbToHex(s.a).slice(1),
    b: rgbToHex(s.b).slice(1),
    s: s.space,
    m: s.mode,
    h: s.hueMode,
    p: s.points.map((p) => p.map((v) => v.toFixed(3)).join(",")).join(";"),
    ab: String(s.arcBend),
    ar: String(s.arcRoll),
    n: String(s.stops),
    sp: s.spacing,
    e: s.easing,
    g: s.gamut,
  });
  return q.toString();
}

export function deserialize(hash: string): AppState {
  const s: AppState = structuredClone(DEFAULT_STATE);
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const a = hexToRgb(q.get("a") ?? "");
  const b = hexToRgb(q.get("b") ?? "");
  if (a) s.a = a;
  if (b) s.b = b;
  if (q.get("s")) s.space = spaceById(q.get("s")!).id;
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = q.get(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  };
  s.mode = pick("m", ["native", "line", "cylindrical", "arc", "quadratic", "cubic", "polyline", "spline"], s.mode);
  s.hueMode = pick("h", ["shorter", "longer", "increasing", "decreasing"], s.hueMode);
  s.spacing = pick("sp", ["parameter", "space", "perceptual"], s.spacing);
  s.easing = pick("e", ["linear", "ease-in", "ease-out", "ease-in-out", "smoother"], s.easing);
  s.gamut = pick("g", ["clip", "chroma"], s.gamut);
  const p = q.get("p");
  if (p) {
    s.points = p
      .split(";")
      .map((t) => t.split(",").map(Number) as Vec3)
      .filter((v) => v.length === 3 && v.every(Number.isFinite));
  }
  const num = (key: string, lo: number, hi: number, fallback: number) => {
    const v = Number(q.get(key));
    return q.has(key) && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  };
  s.arcBend = num("ab", -1, 1, s.arcBend);
  s.arcRoll = num("ar", -180, 180, s.arcRoll);
  s.stops = Math.round(num("n", 2, 32, s.stops));
  return s;
}
