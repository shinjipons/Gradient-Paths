import type { Vec3 } from "../color/convert";
import type { ColorSpace } from "../color/spaces";
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

/**
 * The slice's bounds wear this color and dot pattern in both views, so the 3D
 * plane and the 2D frame read as the same object.
 */
export const PLANE_EDGE = "#ffb347";

export const project = (pl: Plane, p: Vec3): [number, number] => {
  const r = sub(p, pl.origin);
  return [dot(r, pl.u), dot(r, pl.v)];
};

export const unproject = (pl: Plane, s: number, t: number): Vec3 => [
  pl.origin[0] + pl.u[0] * s + pl.v[0] * t,
  pl.origin[1] + pl.u[1] * s + pl.v[1] * t,
  pl.origin[2] + pl.u[2] * s + pl.v[2] * t,
];

/**
 * The plane the path bends in: through A and B, containing the path point
 * farthest from the chord (or the gray axis direction for a straight path).
 */
export function makePlane(space: ColorSpace, A: Vec3, B: Vec3, path: Vec3[], prev?: Plane): Plane {
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
  if (prev ? dot(v, prev.v) < 0 : dot(v, axis) < -1e-6) v = scale(v, -1);
  const n = cross(safeU, v);
  const origin = scale(n, dot(n, A));
  // Fixed bounds, centered on the space: the whole gamut fits (the RGB cube's
  // corners sit at √3), so the view never refits as the path changes.
  return { origin, u: safeU, v, n, view: [-1.8, 1.8, -1.8, 1.8], uLabel: "start → end", vLabel: "bend" };
}
