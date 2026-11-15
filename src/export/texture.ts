/**
 * Procedural textures for the SVG and PNG exports. A black-to-white ramp in the
 * export's shape is distorted by SVG filter noise, then each gray level is
 * recolored with the gradient: in the SVG by an feComponentTransfer table of the
 * stops, in the PNG by mapping the rasterized grays through the gradient itself.
 * Both draw the same filter, so the two look alike.
 */
import type { Gradient } from "../path/paths";
import { colorLut, linearLine, positionAt, radialRadius, type Geometry } from "./formats";

export type TextureKind = "none" | "clouds" | "streaks";

export interface Texture {
  kind: TextureKind;
  /** 0–1: how far the noise pushes the ramp. */
  amount: number;
  /** 0–1: from a few broad features to many small ones. */
  detail: number;
  /** 0–1: fine, pixel-sized speckle on top. */
  grain: number;
  seed: number;
}

export const hasTexture = (t: Texture) => (t.kind !== "none" && t.amount > 0) || t.grain > 0;

const r3 = (x: number) => +x.toFixed(3);
/** Four significant digits: noise frequencies are small numbers. */
const sig = (x: number) => +x.toPrecision(4);

/** Displacements, in user units, for a size × size square. */
function strengths(t: Texture, size: number) {
  // Fractal noise mostly stays near its middle, so the full scale is large: at 100% the ramp moves up to about a third of the square.
  const warp = t.kind === "none" ? 0 : t.amount * size * 1.5;
  return { warp };
}

/**
 * The textured square as SVG. With a gradient, the grays are recolored with its stops
 * (smooth: blended table; bands: a flat value per stop). Without one, it stays grayscale,
 * for the PNG to map through the exact path. Conic ramps have no SVG gradient: pass
 * `rampHref`, a grayscale image of the ramp covering the overscan (see conicRamp).
 */
export function texturedSvg(grad: Gradient | null, g: Geometry, size: number, t: Texture, rampHref?: string): string {
  const c = size / 2;
  const { warp } = strengths(t, size);
  // The ramp reaches past the square by the farthest any pixel can be pushed, so the edges never sample emptiness.
  const H = overscan(size, t);
  // Noise runs in a frame turned so its x axis follows the gradient: streaks lie along it.
  const theta = g.angle - 90;
  const th = (theta * Math.PI) / 180;
  const E = r3(H * (Math.abs(Math.cos(th)) + Math.abs(Math.sin(th))) + 2);

  let ramp: string;
  let fill = "";
  if (g.type === "conic") {
    ramp = `<image href="${rampHref}" x="${r3(-H)}" y="${r3(-H)}" width="${r3(2 * H)}" height="${r3(2 * H)}" preserveAspectRatio="none"/>`;
  } else {
    if (g.type === "radial") {
      fill = `<radialGradient id="ramp" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${r3(radialRadius(g.radialSize, size))}"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient>`;
    } else {
      const { x1, y1, x2, y2 } = linearLine(g.angle, size);
      fill = `<linearGradient id="ramp" gradientUnits="userSpaceOnUse" x1="${r3(x1 - c)}" y1="${r3(y1 - c)}" x2="${r3(x2 - c)}" y2="${r3(y2 - c)}"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>`;
    }
    ramp = `<rect x="${r3(-H)}" y="${r3(-H)}" width="${r3(2 * H)}" height="${r3(2 * H)}" fill="url(#ramp)"/>`;
  }

  // Noise frequencies per user unit, scaled to the square so the look holds at any size.
  const f = (1.5 + 14 * t.detail) / size;
  // Opaque noise, so displacement reads straight channel values. Streaks keep G at 0.5: they move only along the gradient.
  const opaque = (keepG: boolean) =>
    `values="1 0 0 0 0  0 ${keepG ? 1 : 0} 0 0 ${keepG ? 0 : 0.5}  0 0 0 0 0  0 0 0 0 1"`;
  const prims: string[] = [];
  let last = "SourceGraphic";
  if (warp > 0) {
    const freq = t.kind === "streaks" ? `${sig(f * 0.15)} ${sig(f * 4)}` : `${sig(f)}`;
    const oct = t.kind === "streaks" ? 2 : 3;
    prims.push(
      `<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${oct}" seed="${t.seed}" result="noise"/>`,
      `<feColorMatrix in="noise" type="matrix" ${opaque(t.kind !== "streaks")} result="warpMap"/>`,
      `<feDisplacementMap in="${last}" in2="warpMap" scale="${r3(warp)}" xChannelSelector="R" yChannelSelector="G" result="warped"/>`,
    );
    last = "warped";
  }
  if (t.grain > 0) {
    // Grain adds pixel-sized noise to the gray level itself. Fractal noise mostly sits in
    // 0.33–0.67, so it is stretched to 0–1 (and copied to all channels) before it is added.
    const a = r3(t.grain * 0.5);
    prims.push(
      `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${t.seed + 1}" result="speckle"/>`,
      `<feColorMatrix in="speckle" type="matrix" values="3 0 0 0 -1  3 0 0 0 -1  3 0 0 0 -1  0 0 0 0 1" result="grainMap"/>`,
      `<feComposite in="${last}" in2="grainMap" operator="arithmetic" k1="0" k2="1" k3="${a}" k4="${r3(-a / 2)}" result="grained"/>`,
    );
    last = "grained";
  }
  if (grad) {
    const vals = (ch: number) => grad.stops.map((s) => r3(s.display[ch])).join(" ");
    const type = g.blend === "bands" ? "discrete" : "table";
    prims.push(
      `<feComponentTransfer in="${last}"><feFuncR type="${type}" tableValues="${vals(0)}"/><feFuncG type="${type}" tableValues="${vals(1)}"/><feFuncB type="${type}" tableValues="${vals(2)}"/></feComponentTransfer>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<defs>
${fill ? `  ${fill}\n` : ""}  <filter id="texture" filterUnits="userSpaceOnUse" x="${-E}" y="${-E}" width="${2 * E}" height="${2 * E}" color-interpolation-filters="sRGB">
${prims.map((p) => `    ${p}`).join("\n")}
  </filter>
</defs>
<g transform="translate(${c} ${c}) rotate(${r3(theta)})">
  <g filter="url(#texture)">
    <g transform="rotate(${r3(-theta)})">${ramp}</g>
  </g>
</g>
</svg>
`;
}

/** Half the side of the ramp drawn under the filter, centered on the square. */
function overscan(size: number, t: Texture) {
  const { warp } = strengths(t, size);
  return size / 2 + warp / 2 + 2;
}

/** A grayscale image of a conic ramp over the overscan square, as a PNG data URL. */
export function conicRamp(g: Geometry, size: number, t: Texture): string {
  const H = overscan(size, t);
  const side = Math.ceil(2 * H);
  const cv = document.createElement("canvas");
  cv.width = cv.height = side;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(side, side);
  const off = size / 2 - H;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const v = Math.round(Math.min(1, Math.max(0, positionAt(g, size, off + x + 0.5, off + y + 0.5))) * 255);
      const o = (y * side + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL("image/png");
}

/**
 * The textured square as pixels: the grayscale SVG rasterized, then each gray mapped
 * through the gradient ("path": its exact path; "stops": the stops blended in sRGB).
 */
export async function renderTexturedSquare(
  canvas: HTMLCanvasElement,
  grad: Gradient,
  g: Geometry,
  size: number,
  source: "path" | "stops",
  t: Texture,
) {
  const svg = texturedSvg(null, g, size, t, g.type === "conic" ? conicRamp(g, size, t) : undefined);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size);
    const lut = colorLut(grad, g.blend, source, 256);
    const d = data.data;
    for (let o = 0; o < d.length; o += 4) {
      const k = d[o] * 3;
      d[o] = lut[k];
      d[o + 1] = lut[k + 1];
      d[o + 2] = lut[k + 2];
      d[o + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
  } finally {
    URL.revokeObjectURL(url);
  }
}
