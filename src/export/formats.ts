/**
 * Export formats for a computed gradient: CSS, SVG, PNG pixels, a Blender
 * Python script and plain stop lists. Pure functions of the gradient and the
 * export settings, so the dialog can preview exactly what it copies.
 */
import { srgbToLinear, srgbToOklab, type Vec3 } from "../color/convert";
import type { Gradient, Sample } from "../path/paths";

export type GradientType = "linear" | "radial" | "conic";
export type RadialSize = "closest-side" | "farthest-corner";
/** Smooth: colors blend between stops. Bands: each stop is a flat, hard-edged band. */
export type Blend = "smooth" | "bands";
export type CssColor = "hex" | "oklch" | "rgb";
export type CssInterp = "srgb" | "oklab";
export type CssForm = "background" | "background-image" | "variable";
export type StopsFormat = "hex" | "css-vars" | "json";

export interface Geometry {
  type: GradientType;
  /** Degrees, CSS convention: 0 points up, clockwise. Direction for linear, start for conic. */
  angle: number;
  radialSize: RadialSize;
  blend: Blend;
}

const round = (x: number, d: number) => +x.toFixed(d);
const pct = (x: number) => `${round(x * 100, 2)}%`;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Position (0–1) and color of each stop as drawn: one per stop, or two per band. */
export function stopList(stops: Sample[], blend: Blend): { pos: number; s: Sample }[] {
  const n = stops.length;
  if (blend === "bands") {
    return stops.flatMap((s, i) => [{ pos: i / n, s }, { pos: (i + 1) / n, s }]);
  }
  return stops.map((s, i) => ({ pos: n > 1 ? i / (n - 1) : 0, s }));
}

// --- colors ------------------------------------------------------------------

export function oklchOf(rgb: Vec3): { L: number; C: number; h: number } {
  const [L, a, b] = srgbToOklab(rgb);
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h: C < 1e-4 ? 0 : h };
}

export function cssColor(s: Sample, fmt: CssColor): string {
  if (fmt === "hex") return s.hex;
  if (fmt === "rgb") {
    const [r, g, b] = s.display.map((c) => Math.round(c * 255));
    return `rgb(${r} ${g} ${b})`;
  }
  const { L, C, h } = oklchOf(s.display);
  return `oklch(${round(L * 100, 2)}% ${round(C, 4)} ${round(h, 2)})`;
}

// --- CSS ---------------------------------------------------------------------

export function cssGradient(grad: Gradient, g: Geometry, fmt: CssColor, interp: CssInterp): string {
  const list = stopList(grad.stops, g.blend)
    .map(({ pos, s }) => `${cssColor(s, fmt)} ${pct(pos)}`)
    .join(", ");
  // Only smooth blends interpolate; "in srgb" is the default, so it is left out.
  const inSpace = interp === "oklab" && g.blend === "smooth" ? " in oklab" : "";
  const angle = round(((g.angle % 360) + 360) % 360, 1);
  if (g.type === "linear") return `linear-gradient(${angle}deg${inSpace}, ${list})`;
  if (g.type === "radial") return `radial-gradient(circle ${g.radialSize} at 50% 50%${inSpace}, ${list})`;
  return `conic-gradient(from ${angle}deg at 50% 50%${inSpace}, ${list})`;
}

export function cssRule(value: string, form: CssForm): string {
  if (form === "variable") return `--gradient: ${value};`;
  return `${form}: ${value};`;
}

// --- geometry shared by SVG and PNG -------------------------------------------

/** The CSS gradient line of a linear gradient in a size × size square (y down): its ends. */
export function linearLine(angle: number, size: number) {
  const t = rad(angle);
  const dx = Math.sin(t);
  const dy = -Math.cos(t);
  const half = (size / 2) * (Math.abs(dx) + Math.abs(dy));
  const c = size / 2;
  return { x1: c - dx * half, y1: c - dy * half, x2: c + dx * half, y2: c + dy * half };
}

export const radialRadius = (size: RadialSize, side: number) => (size === "closest-side" ? side / 2 : (side / 2) * Math.SQRT2);

/** Gradient position (unclamped) at pixel center (x, y) of a size × size square. */
export function positionAt(g: Geometry, size: number, x: number, y: number): number {
  const c = size / 2;
  const px = x - c;
  const py = y - c;
  if (g.type === "linear") {
    const t = rad(g.angle);
    const dx = Math.sin(t);
    const dy = -Math.cos(t);
    const half = (size / 2) * (Math.abs(dx) + Math.abs(dy));
    return (px * dx + py * dy) / (2 * half) + 0.5;
  }
  if (g.type === "radial") return Math.hypot(px, py) / radialRadius(g.radialSize, size);
  // Conic: clockwise from up, starting at the angle.
  const a = (Math.atan2(px, -py) * 180) / Math.PI - g.angle;
  return (((a % 360) + 360) % 360) / 360;
}

// --- SVG -----------------------------------------------------------------------

/** A square SVG. Conic gradients have no SVG equivalent: the caller must not ask for one. */
export function svgSquare(grad: Gradient, g: Geometry, size: number): string {
  const stops = stopList(grad.stops, g.blend)
    .map(({ pos, s }) => `    <stop offset="${round(pos, 5)}" stop-color="${s.hex}"/>`)
    .join("\n");
  let def: string;
  if (g.type === "radial") {
    const r = round(radialRadius(g.radialSize, size), 3);
    def = `  <radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${size / 2}" cy="${size / 2}" r="${r}">\n${stops}\n  </radialGradient>`;
  } else {
    const { x1, y1, x2, y2 } = linearLine(g.angle, size);
    def = `  <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${round(x1, 3)}" y1="${round(y1, 3)}" x2="${round(x2, 3)}" y2="${round(y2, 3)}">\n${stops}\n  </linearGradient>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">\n<defs>\n${def}\n</defs>\n<rect width="${size}" height="${size}" fill="url(#g)"/>\n</svg>\n`;
}

// --- PNG -----------------------------------------------------------------------

/**
 * Pixels of a size × size square. "path" samples the gradient's exact path at
 * every position; "stops" blends the sampled stops in sRGB, as CSS and SVG do.
 */
export function renderSquare(
  canvas: HTMLCanvasElement,
  grad: Gradient,
  g: Geometry,
  size: number,
  source: "path" | "stops",
) {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  // A lookup table along the gradient, fine enough that neighboring entries never differ by a visible step.
  const LUT = 2048;
  const lut = colorLut(grad, g.blend, source, LUT);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = Math.min(1, Math.max(0, positionAt(g, size, x + 0.5, y + 0.5)));
      const k = Math.min(LUT - 1, Math.round(t * (LUT - 1))) * 3;
      const o = (y * size + x) * 4;
      d[o] = lut[k];
      d[o + 1] = lut[k + 1];
      d[o + 2] = lut[k + 2];
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * RGB bytes for `count` evenly spaced gradient positions, 0 to 1. Bands: each stop flat over
 * its band. Otherwise "path" samples the gradient's exact path and "stops" blends the stops in sRGB.
 */
export function colorLut(grad: Gradient, blend: Blend, source: "path" | "stops", count: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(count * 3);
  const n = grad.stops.length;
  for (let i = 0; i < count; i++) {
    const u = i / (count - 1);
    let c: Vec3;
    if (blend === "bands") {
      c = grad.stops[Math.min(n - 1, Math.floor(u * n))].display;
    } else if (source === "path") {
      c = grad.at(u).display;
    } else {
      const x = u * (n - 1);
      const k = Math.min(n - 2, Math.floor(x));
      const f = x - k;
      const a = grad.stops[k].display;
      const b = grad.stops[k + 1].display;
      c = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
    lut[i * 3] = Math.round(c[0] * 255);
    lut[i * 3 + 1] = Math.round(c[1] * 255);
    lut[i * 3 + 2] = Math.round(c[2] * 255);
  }
  return lut;
}

// --- Blender ---------------------------------------------------------------------

/**
 * A Python script for Blender's Text Editor: a material whose Color Ramp holds
 * the stops (in linear RGB, as Blender expects), driven by the object's
 * generated coordinates in the same shape as the CSS gradient.
 */
export function blenderScript(grad: Gradient, g: Geometry, applyToActive: boolean): string {
  const n = grad.stops.length;
  // Bands: constant interpolation, each stop placed where its band starts.
  const elements = g.blend === "bands"
    ? grad.stops.map((s, i) => ({ pos: i / n, s }))
    : stopList(grad.stops, "smooth");
  const rows = elements
    .map(({ pos, s }) => {
      const [r, gg, b] = srgbToLinear(s.display).map((c) => round(c, 6));
      return `    (${round(pos, 6)}, (${r}, ${gg}, ${b}, 1.0)),  # ${s.hex}`;
    })
    .join("\n");

  const t = rad(g.angle);
  // Generated coordinates have y up; CSS angles are clockwise from up.
  const ext = Math.abs(Math.sin(t)) + Math.abs(Math.cos(t));
  const dir = [round(Math.sin(t) / ext, 6), round(Math.cos(t) / ext, 6)];
  const radius = g.radialSize === "closest-side" ? 0.5 : round(Math.SQRT1_2, 6);

  let shape: string;
  if (g.type === "linear") {
    shape = `# Linear, ${round(g.angle, 1)}°: project onto the gradient direction.
dot = node("ShaderNodeVectorMath", -400, 0)
dot.operation = "DOT_PRODUCT"
dot.inputs[1].default_value = (${dir[0]}, ${dir[1]}, 0.0)
links.new(centered.outputs[0], dot.inputs[0])
fac = node("ShaderNodeMath", -200, 0)
fac.operation = "ADD"
fac.inputs[1].default_value = 0.5
links.new(dot.outputs["Value"], fac.inputs[0])`;
  } else if (g.type === "radial") {
    shape = `# Radial (${g.radialSize}): distance from the center.
length = node("ShaderNodeVectorMath", -400, 0)
length.operation = "LENGTH"
links.new(centered.outputs[0], length.inputs[0])
fac = node("ShaderNodeMath", -200, 0)
fac.operation = "DIVIDE"
fac.inputs[1].default_value = ${radius}
links.new(length.outputs["Value"], fac.inputs[0])`;
  } else {
    shape = `# Conic, from ${round(g.angle, 1)}°: angle around the center, clockwise from up.
sep = node("ShaderNodeSeparateXYZ", -600, 0)
links.new(centered.outputs[0], sep.inputs[0])
ang = node("ShaderNodeMath", -450, 0)
ang.operation = "ARCTAN2"
links.new(sep.outputs["X"], ang.inputs[0])
links.new(sep.outputs["Y"], ang.inputs[1])
turns = node("ShaderNodeMath", -300, 0)
turns.operation = "MULTIPLY_ADD"
turns.inputs[1].default_value = 1 / (2 * math.pi)
turns.inputs[2].default_value = ${round(-g.angle / 360, 6)}
links.new(ang.outputs[0], turns.inputs[0])
fac = node("ShaderNodeMath", -150, 0)
fac.operation = "WRAP"
fac.inputs[1].default_value = 1.0
fac.inputs[2].default_value = 0.0
links.new(turns.outputs[0], fac.inputs[0])`;
  }

  return `# Gradient Paths: ${n} stops as a Blender material.
# Run it from the Scripting workspace: Text > New, paste, then Run Script (Alt P).
import bpy
import math

STOPS = [
${rows}
]

mat = bpy.data.materials.new("Gradient Paths")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
nodes.clear()

def node(kind, x, y):
    n = nodes.new(kind)
    n.location = (x, y)
    return n

coords = node("ShaderNodeTexCoord", -1000, 0)
offset = node("ShaderNodeVectorMath", -850, 0)
offset.operation = "SUBTRACT"
offset.inputs[1].default_value = (0.5, 0.5, 0.5)
links.new(coords.outputs["Generated"], offset.inputs[0])
# Centered on the bounding box and flattened onto XY, so depth never shifts the gradient.
centered = node("ShaderNodeVectorMath", -700, 0)
centered.operation = "MULTIPLY"
centered.inputs[1].default_value = (1.0, 1.0, 0.0)
links.new(offset.outputs[0], centered.inputs[0])

${shape}

ramp = node("ShaderNodeValToRGB", 0, 0)
cr = ramp.color_ramp
cr.interpolation = "${g.blend === "bands" ? "CONSTANT" : "LINEAR"}"
cr.elements[0].position = STOPS[0][0]
cr.elements[1].position = STOPS[-1][0]
for pos, _ in STOPS[1:-1]:
    cr.elements.new(pos)
for el, (_, color) in zip(cr.elements, STOPS):
    el.color = color
links.new(fac.outputs[0], ramp.inputs["Fac"])

bsdf = node("ShaderNodeBsdfPrincipled", 350, 0)
links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
out = node("ShaderNodeOutputMaterial", 700, 0)
links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
${applyToActive ? `
obj = bpy.context.active_object
if obj is not None and hasattr(obj.data, "materials"):
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)
` : ""}`;
}

// --- stop lists ------------------------------------------------------------------

export function stopsText(grad: Gradient, fmt: StopsFormat): string {
  const n = grad.stops.length;
  if (fmt === "hex") return grad.stops.map((s) => s.hex).join("\n");
  if (fmt === "css-vars") {
    return `:root {\n${grad.stops.map((s, i) => `  --gradient-${i + 1}: ${s.hex};`).join("\n")}\n}`;
  }
  const json = grad.stops.map((s, i) => {
    const { L, C, h } = oklchOf(s.display);
    return {
      position: round(n > 1 ? i / (n - 1) : 0, 5),
      hex: s.hex,
      oklch: [round(L, 4), round(C, 4), round(h, 2)],
      inGamut: s.inGamut,
    };
  });
  return JSON.stringify(json, null, 2);
}
