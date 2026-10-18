# Gradient Paths

Explore how a gradient between two colors changes with the color space it travels through and the shape of the route it takes.

```bash
npm install
npm run dev
```

## What's in it

- **Color spaces:** sRGB, linear sRGB, HSL (cylinder), HSV (cone), OKLab, OKLCH, CIELAB, CIE LCh. Each space defines its own conversions, plus an *embedding*: a Cartesian, Z-up frame (`src/color/spaces.ts`) where the curves are built and drawn.
- **Path shapes** (`src/path/paths.ts`):
  - native per-channel interpolation, which is what CSS `in <space>` does, with hue direction
  - a straight line
  - an orbit around the gray axis
  - a circular arc (bend and roll)
  - quadratic and cubic Béziers
  - a polyline through waypoints
  - a centripetal Catmull–Rom spline
- **Sampling:** stops can be spaced by the curve parameter, by distance in the space, or by perceptual distance (OKLab ΔE). Easing goes on top. Colors outside sRGB are shown either clipped or with their chroma reduced.
- **Views:**
  - 3D: the sRGB gamut as a surface, point cloud or wireframe, with the path through it
  - 2D slice: horizontal, vertical, or the plane the path bends in, with draggable handles
  - channel and perceptual-speed charts
  - a CSS output, and the browser's own interpolation next to it for comparison

The URL hash holds the current state, so you can share a link to it.

## 3D navigation

Right- or middle-drag to orbit. Add Shift to truck, or Ctrl to dolly. Use the wheel or a pinch to zoom toward the cursor, and a two-finger drag to orbit. Press <kbd>`</kbd> to fly with WASD. The left button never moves the camera.
