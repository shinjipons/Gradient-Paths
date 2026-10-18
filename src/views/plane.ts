import type { Vec3 } from "../color/convert";
import type { ColorSpace } from "../color/spaces";
import type { PlaneKind } from "../state";
import { cross, dot, len, norm, perpendicular, scale, sub } from "../path/vec";

/** A slicing plane in embed space: origin + orthonormal in-plane axes. */
export interface Plane {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  n: Vec3;
  /** Visible window in plane coords: [uMin, uMax, vMin, vMax]. */
  view: [number, number, number, number];
  uLabel: string;
  vLabel: string;
}

export const project = (pl: Plane, p: Vec3): [number, number] => {
  const r = sub(p, pl.origin);
  return [dot(r, pl.u), dot(r, pl.v)];
};

export const unproject = (pl: Plane, s: number, t: number): Vec3 => [
  pl.origin[0] + pl.u[0] * s + pl.v[0] * t,
  pl.origin[1] + pl.u[1] * s + pl.v[1] * t,
  pl.origin[2] + pl.u[2] * s + pl.v[2] * t,
];

const SQUARE: [number, number, number, number] = [-1.2, 1.2, -1.2, 1.2];

export function makePlane(
  kind: PlaneKind,
  offset: number,
  angleDeg: number,
  space: ColorSpace,
  A: Vec3,
  B: Vec3,
  path: Vec3[],
  prev?: Plane,
): Plane {
  const ch = space.channels;
  const rgbish = space.family === "RGB";
  if (kind === "horizontal") {
    return {
      origin: [0, 0, offset],
      u: [1, 0, 0],
      v: [0, 1, 0],
      n: [0, 0, 1],
      view: SQUARE,
      uLabel: rgbish ? ch[0].name : space.hueIndex >= 0 ? "hue wheel" : ch[1].name,
      vLabel: rgbish ? ch[1].name : space.hueIndex >= 0 ? "" : ch[2].name,
    };
  }
  if (kind === "vertical") {
    const r = (angleDeg * Math.PI) / 180;
    const u: Vec3 = [Math.cos(r), Math.sin(r), 0];
    const v: Vec3 = [0, 0, 1];
    const n = cross(u, v);
    return {
      origin: scale(n, offset),
      u,
      v,
      n,
      view: SQUARE,
      uLabel: `${Math.round(angleDeg)}° direction`,
      vLabel: rgbish ? ch[2].name : ch[space.id.startsWith("hs") ? 2 : 0].name,
    };
  }

  // Path plane: contains A, B and the path point farthest from the chord.
  const u = norm(sub(B, A));
  const safeU = len(u) > 0 ? u : ([1, 0, 0] as Vec3);
  let far: Vec3 = [0, 0, 0];
  let best = 0;
  for (const p of path) {
    const r = sub(p, A);
    const off = sub(r, scale(safeU, dot(r, safeU)));
    const d = len(off);
    if (d > best) {
      best = d;
      far = off;
    }
  }
  const axis = norm(sub(space.neutral[1], space.neutral[0]));
  let v: Vec3;
  if (best > 1e-3) v = norm(far);
  else {
    const off = sub(axis, scale(safeU, dot(axis, safeU)));
    v = len(off) > 1e-3 ? norm(off) : perpendicular(safeU);
  }
  // Keep the side the curve bows to stable between frames; else favor "up".
  if (prev && prev.vLabel === "bend" ? dot(v, prev.v) < 0 : dot(v, axis) < -1e-6) v = scale(v, -1);
  const n = cross(safeU, v);
  const origin = scale(n, dot(n, A));
  const pl: Plane = { origin, u: safeU, v, n, view: SQUARE, uLabel: "start → end", vLabel: "bend" };

  // Frame the path (plus a margin) rather than the whole space.
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of [A, B, ...path]) {
    const [s, t] = project(pl, p);
    u0 = Math.min(u0, s); u1 = Math.max(u1, s);
    v0 = Math.min(v0, t); v1 = Math.max(v1, t);
  }
  const half = Math.max(0.9, (u1 - u0) / 2, (v1 - v0) / 2) * 1.25;
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  pl.view = [cu - half, cu + half, cv - half, cv + half];
  return pl;
}
