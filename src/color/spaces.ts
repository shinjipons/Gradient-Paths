import {
  ACHROMATIC,
  fromPolar,
  hslToSrgb,
  hsvToSrgb,
  inUnitCube,
  labToLinear,
  linearToLab,
  linearToSrgb,
  oklabToSrgb,
  srgbToHsl,
  srgbToHsv,
  srgbToLinear,
  srgbToOklab,
  toPolar,
  type Vec3,
} from "./convert";

export interface Channel {
  name: string;
  min: number;
  max: number;
  /** Shown value = raw * scale (e.g. 0..1 -> 0..100%). */
  scale?: number;
  unit?: string;
  hue?: boolean;
}

/**
 * A color space as the app sees it.
 *
 * `native` coordinates are the space's own channels; interpolating them
 * directly is what CSS does with `in <space>`. `embed` maps them into a
 * Cartesian display frame (Z up = lightness-ish, roughly [-1, 1]³) where the
 * geometric curves (lines, arcs, Béziers) are built and drawn.
 */
export interface ColorSpace {
  id: string;
  label: string;
  family: "RGB" | "Cylindrical" | "Perceptual";
  blurb: string;
  channels: [Channel, Channel, Channel];
  /** Index of the hue channel, or -1. */
  hueIndex: number;
  toRGB(c: Vec3): Vec3;
  fromRGB(rgb: Vec3): Vec3;
  embed(c: Vec3): Vec3;
  unembed(p: Vec3): Vec3;
  /** Extra validity beyond "converts into the sRGB cube" (e.g. HSL s ≤ 1). */
  valid?(c: Vec3): boolean;
  /** CSS <color-interpolation-method> space name, for the browser comparison. */
  css: string | null;
  /** The gray axis in embed space: from black to white. */
  neutral: [Vec3, Vec3];
  /** Parametric surfaces (u, v ∈ [0,1]) of the sRGB gamut, in native coords. */
  gamutFaces: ((u: number, v: number) => Vec3)[];
  axisLabels: { pos: Vec3; text: string }[];
}

// sRGB cube faces, as sRGB triples.
const CUBE_FACES: ((u: number, v: number) => Vec3)[] = [
  (u, v) => [0, u, v],
  (u, v) => [1, v, u],
  (u, v) => [v, 0, u],
  (u, v) => [u, 1, v],
  (u, v) => [u, v, 0],
  (u, v) => [v, u, 1],
];
const cubeFacesVia = (fromRGB: (c: Vec3) => Vec3) =>
  CUBE_FACES.map((f) => (u: number, v: number) => fromRGB(f(u, v)));

const polarUnembed = (p: Vec3, rScale: number): [number, number] => {
  const [c, h] = toPolar(p[0], p[1], 1e-6);
  return [c * rScale, h];
};

const rgbLike = (
  id: string,
  label: string,
  blurb: string,
  toRGB: (c: Vec3) => Vec3,
  fromRGB: (c: Vec3) => Vec3,
  css: string,
): ColorSpace => ({
  id,
  label,
  family: "RGB",
  blurb,
  channels: [
    { name: "R", min: 0, max: 1, scale: 255 },
    { name: "G", min: 0, max: 1, scale: 255 },
    { name: "B", min: 0, max: 1, scale: 255 },
  ],
  hueIndex: -1,
  toRGB,
  fromRGB,
  embed: (c) => [2 * c[0] - 1, 2 * c[1] - 1, 2 * c[2] - 1],
  unembed: (p) => [(p[0] + 1) / 2, (p[1] + 1) / 2, (p[2] + 1) / 2],
  css,
  neutral: [
    [-1, -1, -1],
    [1, 1, 1],
  ],
  gamutFaces: cubeFacesVia(fromRGB),
  axisLabels: [
    { pos: [1.25, -1, -1], text: "Red" },
    { pos: [-1, 1.25, -1], text: "Green" },
    { pos: [-1, -1, 1.25], text: "Blue" },
  ],
});

const SRGB = rgbLike(
  "srgb",
  "sRGB",
  "The cube from the reference: gamma-encoded red, green and blue. A straight line through it often passes near gray.",
  (c) => c,
  (c) => c,
  "srgb",
);

const LINEAR = rgbLike(
  "srgb-linear",
  "Linear sRGB",
  "Same cube, but in physical light intensity. Mixes like light does: blends tend to look too bright.",
  linearToSrgb,
  srgbToLinear,
  "srgb-linear",
);

const HSL: ColorSpace = {
  id: "hsl",
  label: "HSL",
  family: "Cylindrical",
  blurb: "Hue as an angle, saturation as radius, lightness as height. Native interpolation walks around the hue wheel.",
  channels: [
    { name: "H", min: 0, max: 360, unit: "°", hue: true },
    { name: "S", min: 0, max: 1, scale: 100, unit: "%" },
    { name: "L", min: 0, max: 1, scale: 100, unit: "%" },
  ],
  hueIndex: 0,
  toRGB: hslToSrgb,
  fromRGB: srgbToHsl,
  embed: ([h, s, l]) => {
    const [x, y] = fromPolar(s, h);
    return [x, y, 2 * l - 1];
  },
  unembed: (p) => {
    const [s, h] = polarUnembed(p, 1);
    return [h, s, (p[2] + 1) / 2];
  },
  valid: ([, s, l]) => s <= 1 + 1e-4 && l >= -1e-4 && l <= 1 + 1e-4,
  css: "hsl",
  neutral: [
    [0, 0, -1],
    [0, 0, 1],
  ],
  gamutFaces: [
    (u, v) => [u * 360, 1, v],
    (u, v) => [u * 360, v, 1],
    (u, v) => [u * 360, v, 0],
  ],
  axisLabels: [
    { pos: [1.2, 0, 0], text: "0° red" },
    { pos: [-0.6, 1.04, 0], text: "120°" },
    { pos: [0, 0, 1.2], text: "L" },
  ],
};

const HSV: ColorSpace = {
  id: "hsv",
  label: "HSV (cone)",
  family: "Cylindrical",
  blurb: "Hue, saturation, value drawn as the classic hexcone: black is the tip, the brightest colors sit on the rim.",
  channels: [
    { name: "H", min: 0, max: 360, unit: "°", hue: true },
    { name: "S", min: 0, max: 1, scale: 100, unit: "%" },
    { name: "V", min: 0, max: 1, scale: 100, unit: "%" },
  ],
  hueIndex: 0,
  toRGB: hsvToSrgb,
  fromRGB: srgbToHsv,
  embed: ([h, s, v]) => {
    const [x, y] = fromPolar(s * v, h);
    return [x, y, 2 * v - 1];
  },
  unembed: (p) => {
    const v = (p[2] + 1) / 2;
    const [r, h] = polarUnembed(p, 1);
    return [h, v > 1e-6 ? r / v : r > 1e-6 ? Infinity : 0, v];
  },
  valid: ([, s, v]) => s <= 1 + 1e-4 && v >= -1e-4 && v <= 1 + 1e-4,
  css: null,
  neutral: [
    [0, 0, -1],
    [0, 0, 1],
  ],
  gamutFaces: [
    (u, v) => [u * 360, 1, v],
    (u, v) => [u * 360, v, 1],
  ],
  axisLabels: [
    { pos: [1.2, 0, 1], text: "0° red" },
    { pos: [0, 0, 1.25], text: "V" },
  ],
};

const OK_R = 0.4; // OKLab a/b range mapped to ±1
const OKLAB: ColorSpace = {
  id: "oklab",
  label: "OKLab",
  family: "Perceptual",
  blurb: "A perceptual space: equal distances look roughly equally different. Straight lines here give even, natural blends.",
  channels: [
    { name: "L", min: 0, max: 1, scale: 100, unit: "%" },
    { name: "a", min: -0.4, max: 0.4 },
    { name: "b", min: -0.4, max: 0.4 },
  ],
  hueIndex: -1,
  toRGB: oklabToSrgb,
  fromRGB: srgbToOklab,
  embed: ([L, a, b]) => [a / OK_R, b / OK_R, 2 * L - 1],
  unembed: (p) => [(p[2] + 1) / 2, p[0] * OK_R, p[1] * OK_R],
  css: "oklab",
  neutral: [
    [0, 0, -1],
    [0, 0, 1],
  ],
  gamutFaces: cubeFacesVia(srgbToOklab),
  axisLabels: [
    { pos: [1.15, 0, 0], text: "+a" },
    { pos: [0, 1.15, 0], text: "+b" },
    { pos: [0, 0, 1.2], text: "L" },
  ],
};

const oklchFromLab = ([L, a, b]: Vec3): Vec3 => {
  const [c, h] = toPolar(a, b, ACHROMATIC);
  return [L, c, h];
};
const labFromOklch = ([L, c, h]: Vec3): Vec3 => {
  const [a, b] = fromPolar(c, h);
  return [L, a, b];
};

const OKLCH: ColorSpace = {
  ...OKLAB,
  id: "oklch",
  label: "OKLCH",
  family: "Perceptual",
  blurb: "OKLab in polar form: lightness, chroma, hue. Native interpolation keeps chroma up by going around the hue circle.",
  channels: [
    { name: "L", min: 0, max: 1, scale: 100, unit: "%" },
    { name: "C", min: 0, max: 0.4 },
    { name: "H", min: 0, max: 360, unit: "°", hue: true },
  ],
  hueIndex: 2,
  toRGB: (c) => oklabToSrgb(labFromOklch(c)),
  fromRGB: (c) => oklchFromLab(srgbToOklab(c)),
  embed: (c) => OKLAB.embed(labFromOklch(c)),
  unembed: (p) => oklchFromLab(OKLAB.unembed(p)),
  css: "oklch",
  gamutFaces: cubeFacesVia((c) => oklchFromLab(srgbToOklab(c))),
};

const LAB_R = 125;
const srgbToLab = (c: Vec3) => linearToLab(srgbToLinear(c));
const labToSrgb = (c: Vec3) => linearToSrgb(labToLinear(c));

const LAB: ColorSpace = {
  id: "lab",
  label: "CIELAB",
  family: "Perceptual",
  blurb: "The 1976 perceptual space (D50, as in CSS lab()). Less uniform than OKLab, notably in blues, which drift purple.",
  channels: [
    { name: "L", min: 0, max: 100 },
    { name: "a", min: -125, max: 125 },
    { name: "b", min: -125, max: 125 },
  ],
  hueIndex: -1,
  toRGB: labToSrgb,
  fromRGB: srgbToLab,
  embed: ([L, a, b]) => [a / LAB_R, b / LAB_R, L / 50 - 1],
  unembed: (p) => [(p[2] + 1) * 50, p[0] * LAB_R, p[1] * LAB_R],
  css: "lab",
  neutral: [
    [0, 0, -1],
    [0, 0, 1],
  ],
  gamutFaces: cubeFacesVia(srgbToLab),
  axisLabels: [
    { pos: [1.15, 0, 0], text: "+a" },
    { pos: [0, 1.15, 0], text: "+b" },
    { pos: [0, 0, 1.2], text: "L" },
  ],
};

const lchFromLab = ([L, a, b]: Vec3): Vec3 => {
  const [c, h] = toPolar(a, b, 0.01);
  return [L, c, h];
};

const LCH: ColorSpace = {
  ...LAB,
  id: "lch",
  label: "CIE LCh",
  blurb: "CIELAB in polar form. Hue-preserving blends, with CIELAB's non-uniformity.",
  channels: [
    { name: "L", min: 0, max: 100 },
    { name: "C", min: 0, max: 150 },
    { name: "H", min: 0, max: 360, unit: "°", hue: true },
  ],
  hueIndex: 2,
  toRGB: (c) => labToSrgb(labFromOklch(c)),
  fromRGB: (c) => lchFromLab(srgbToLab(c)),
  embed: (c) => LAB.embed(labFromOklch(c)),
  unembed: (p) => lchFromLab(LAB.unembed(p)),
  css: "lch",
  gamutFaces: cubeFacesVia((c) => lchFromLab(srgbToLab(c))),
};

export const SPACES: ColorSpace[] = [SRGB, LINEAR, HSL, HSV, OKLAB, OKLCH, LAB, LCH];
export const spaceById = (id: string): ColorSpace => SPACES.find((s) => s.id === id) ?? SRGB;

export const isRealColor = (space: ColorSpace, native: Vec3, rgb: Vec3): boolean =>
  inUnitCube(rgb) && (space.valid ? space.valid(native) : true);
