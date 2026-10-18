// Low-level color conversions. All functions are pure and unclamped, so
// out-of-gamut values survive round trips (needed for curves that leave sRGB).

export type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

const mul = (m: Mat3, v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

// --- sRGB transfer function (sign-extended like CSS Color 4) ---------------

const toLinear = (c: number): number => {
  const a = Math.abs(c);
  return Math.sign(c) * (a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4);
};
const toGamma = (c: number): number => {
  const a = Math.abs(c);
  return Math.sign(c) * (a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055);
};

export const srgbToLinear = (c: Vec3): Vec3 => [toLinear(c[0]), toLinear(c[1]), toLinear(c[2])];
export const linearToSrgb = (c: Vec3): Vec3 => [toGamma(c[0]), toGamma(c[1]), toGamma(c[2])];

// --- XYZ -------------------------------------------------------------------

const LIN_TO_XYZ65: Mat3 = [
  [0.4123907992659595, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151036, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559185, 0.11919477979462599, 0.9505321522496606],
];
const XYZ65_TO_LIN: Mat3 = [
  [3.2409699419045213, -1.5373831775700935, -0.4986107602930033],
  [-0.9692436362808798, 1.8759675015077206, 0.04155505740717561],
  [0.05563007969699361, -0.20397695888897657, 1.0569715142428786],
];
// Bradford chromatic adaptation, as used by CSS for lab()/lch() (D50).
const D65_TO_D50: Mat3 = [
  [1.0479298208405488, 0.022946793341019088, -0.05019222954313557],
  [0.029627815688159344, 0.990434484573249, -0.01707382502938514],
  [-0.009243058152591178, 0.015055144896577895, 0.7518742899580008],
];
const D50_TO_D65: Mat3 = [
  [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
  [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
  [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
];
const D50_WHITE: Vec3 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

// --- OKLab (Björn Ottosson) ------------------------------------------------

export const linearToOklab = ([r, g, b]: Vec3): Vec3 => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

export const oklabToLinear = ([L, a, b]: Vec3): Vec3 => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
};

export const srgbToOklab = (c: Vec3): Vec3 => linearToOklab(srgbToLinear(c));
export const oklabToSrgb = (c: Vec3): Vec3 => linearToSrgb(oklabToLinear(c));

// --- CIELAB (D50, matches CSS lab()) ---------------------------------------

const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

export const linearToLab = (c: Vec3): Vec3 => {
  const xyz = mul(D65_TO_D50, mul(LIN_TO_XYZ65, c));
  const f = xyz.map((v, i) => {
    const t = v / D50_WHITE[i];
    return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
  });
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
};

export const labToLinear = ([L, a, b]: Vec3): Vec3 => {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = fx ** 3 > EPS ? fx ** 3 : (116 * fx - 16) / KAPPA;
  const y = L > KAPPA * EPS ? fy ** 3 : L / KAPPA;
  const z = fz ** 3 > EPS ? fz ** 3 : (116 * fz - 16) / KAPPA;
  const xyz: Vec3 = [x * D50_WHITE[0], y * D50_WHITE[1], z * D50_WHITE[2]];
  return mul(XYZ65_TO_LIN, mul(D50_TO_D65, xyz));
};

// --- Polar helpers ---------------------------------------------------------

/** Chroma below this is treated as achromatic: the hue is "powerless" (NaN). */
export const ACHROMATIC = 1e-4;

export const toPolar = (a: number, b: number, eps: number): [number, number] => {
  const c = Math.hypot(a, b);
  if (c < eps) return [c, NaN];
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [c, h];
};

export const fromPolar = (c: number, h: number): [number, number] => {
  const r = ((Number.isNaN(h) ? 0 : h) * Math.PI) / 180;
  return [c * Math.cos(r), c * Math.sin(r)];
};

// --- HSL / HSV (hue in degrees, s/l/v in 0..1) -----------------------------

export const srgbToHsl = ([r, g, b]: Vec3): Vec3 => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-7) return [NaN, 0, l];
  const s = l === 0 || l === 1 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [rgbHue(r, g, b, max, d), s, l];
};

export const hslToSrgb = ([h, s, l]: Vec3): Vec3 => {
  const hh = Number.isNaN(h) ? 0 : h;
  const k = (n: number) => (n + hh / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
};

export const srgbToHsv = ([r, g, b]: Vec3): Vec3 => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-7) return [NaN, 0, max];
  return [rgbHue(r, g, b, max, d), max === 0 ? 0 : d / max, max];
};

export const hsvToSrgb = ([h, s, v]: Vec3): Vec3 => {
  const hh = Number.isNaN(h) ? 0 : h;
  const f = (n: number) => {
    const k = (n + hh / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
};

function rgbHue(r: number, g: number, b: number, max: number, d: number): number {
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

// --- Hex -------------------------------------------------------------------

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export const rgbToHex = (c: Vec3): string =>
  "#" +
  c
    .map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0"))
    .join("");

export const hexToRgb = (hex: string): Vec3 | null => {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = [...h].map((ch) => ch + ch).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Vec3;
};

export const inUnitCube = (c: Vec3, eps = 1e-4): boolean =>
  c.every((v) => v >= -eps && v <= 1 + eps);
