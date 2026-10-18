import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  Points,
  PointsMaterial,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from "three";
import { clamp01, type Vec3 } from "../color/convert";
import type { ColorSpace } from "../color/spaces";
import type { Sample } from "../path/paths";
import type { SolidStyle } from "../state";
import { CameraRig, type SnapView } from "../viewport/cameras";
import { ViewControls } from "../viewport/controls";
import { Flythrough } from "../viewport/flythrough";
import { Navigation } from "../viewport/navigation";
import { unproject, type Plane } from "./plane";

/** Embed space is ~[-1,1]³; this is its size in world units. */
const S = 2.2;
const v3 = (p: Vec3) => new Vector3(p[0] * S, p[1] * S, p[2] * S);

interface PathInput {
  dense: Sample[];
  stops: Sample[];
  A: Vec3;
  B: Vec3;
  aColor: string;
  bColor: string;
  points: Vec3[];
  showPolygon: boolean;
  plane: Plane;
}

/**
 * 3D view of the sRGB gamut as it sits in the current space, with the path
 * running through it. Camera navigation is the house scheme (middle/right
 * drag orbit, wheel dolly, trackpad gestures, ` for flythrough).
 */
export class View3D {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private rig: CameraRig;
  private controls: ViewControls;
  private nav: Navigation;
  private fly: Flythrough;
  private gamut = new Group();
  private pathGroup = new Group();
  private planeGroup = new Group();
  private solidObjects: Object3D[] = [];
  private gamutKey = "";
  private last = performance.now();

  constructor(private container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    const canvas = this.renderer.domElement;
    canvas.className = "view3d-canvas";
    canvas.tabIndex = 0;

    this.rig = new CameraRig(1);
    this.rig.persp.position.set(6.5, -7.5, 4.5);
    this.rig.persp.lookAt(0, 0, 0);
    this.controls = new ViewControls(this.rig, canvas);
    this.nav = new Navigation(canvas, this.rig, this.controls, {
      solidObjects: this.solidObjects,
      contentCenter: (out) => out.set(0, 0, 0),
    });
    this.fly = new Flythrough(canvas, this.rig, this.controls, container, {
      onActiveChange: (active) => {
        this.nav.enabled = !active;
        this.controls.enabled = !active;
      },
      onProjectionChange: () => this.controls.onCameraToggled(),
    });

    this.scene.add(this.gamut, this.pathGroup, this.planeGroup);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(this.frame);
  }

  private resize() {
    const r = this.container.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.renderer.setSize(r.width, r.height, false);
    this.renderer.domElement.style.width = `${r.width}px`;
    this.renderer.domElement.style.height = `${r.height}px`;
    this.rig.setAspect(r.width / r.height);
  }

  private frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.fly.active) this.fly.update(dt);
    else this.controls.update();
    // Keep labels and markers facing the camera.
    this.renderer.render(this.scene, this.rig.camera);
  };

  // --- toolbar actions ---------------------------------------------------------

  toggleProjection(): string {
    const p = this.rig.toggle(this.controls.target);
    this.controls.onCameraToggled();
    return p;
  }

  snap(view: SnapView) {
    this.rig.snapOrtho(view, this.controls.target);
    this.controls.onCameraToggled();
  }

  reset() {
    if (this.rig.projection === "ortho") this.rig.toggle(this.controls.target);
    this.controls.target.set(0, 0, 0);
    this.rig.persp.up.set(0, 0, 1);
    this.rig.ortho.up.set(0, 0, 1);
    this.rig.persp.position.set(6.5, -7.5, 4.5);
    this.rig.persp.lookAt(0, 0, 0);
    this.controls.onCameraToggled();
  }

  get projection() {
    return this.rig.projection;
  }

  // --- gamut solid -----------------------------------------------------------

  setGamut(space: ColorSpace, style: SolidStyle, opacity: number) {
    const key = `${space.id}|${style}|${opacity}`;
    if (key === this.gamutKey) return;
    this.gamutKey = key;
    disposeChildren(this.gamut);
    this.solidObjects.length = 0;

    if (style === "surface" || style === "wire") {
      const mesh = new Mesh(
        gamutGeometry(space, style === "wire" ? 16 : 40),
        new MeshBasicMaterial({
          vertexColors: true,
          side: DoubleSide,
          transparent: style === "surface" && opacity < 1,
          opacity: style === "surface" ? opacity : 1,
          depthWrite: style === "wire" || opacity >= 0.99,
          wireframe: style === "wire",
        }),
      );
      this.gamut.add(mesh);
      this.solidObjects.push(mesh);
    } else if (style === "points") {
      const pts = gamutCloud(space, 24000);
      this.gamut.add(pts);
      this.solidObjects.push(pts);
    }

    // Neutral axis, black → white.
    const [n0, n1] = space.neutral;
    const ax = new BufferGeometry().setFromPoints([v3(n0), v3(n1)]);
    ax.setAttribute("color", new Float32BufferAttribute([0.15, 0.15, 0.15, 1, 1, 1], 3));
    this.gamut.add(new Line(ax, new LineBasicMaterial({ vertexColors: true })));

    if (space.family === "RGB") this.gamut.add(cubeEdges());
    else this.gamut.add(ringAt(space));

    for (const l of space.axisLabels) this.gamut.add(label(l.text, v3(l.pos)));
  }

  // --- path ------------------------------------------------------------------

  setPath(inp: PathInput) {
    disposeChildren(this.pathGroup);
    const pts = inp.dense.map((d) => v3(d.embed));
    // Collapse duplicates so the tube's Frenet frames stay finite.
    const uniq = pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 1e-5);
    if (uniq.length >= 2) {
      const curve = new CatmullRomCurve3(uniq, false, "catmullrom", 0);
      const segs = 300;
      const radial = 8;
      const tube = new TubeGeometry(curve, segs, 0.035, radial, false);
      const colors = new Float32Array(tube.attributes.position.count * 3);
      const c = new Color();
      for (let i = 0; i <= segs; i++) {
        const s = inp.dense[Math.round((i / segs) * (inp.dense.length - 1))];
        c.setRGB(s.display[0], s.display[1], s.display[2], "srgb");
        for (let j = 0; j <= radial; j++) {
          const k = (i * (radial + 1) + j) * 3;
          colors[k] = c.r;
          colors[k + 1] = c.g;
          colors[k + 2] = c.b;
        }
      }
      tube.setAttribute("color", new BufferAttribute(colors, 3));
      this.pathGroup.add(new Mesh(tube, new MeshBasicMaterial({ vertexColors: true })));
      // Dark casing, slightly larger, back faces only: reads as an outline.
      const casing = new TubeGeometry(curve, segs, 0.05, radial, false);
      this.pathGroup.add(
        new Mesh(casing, new MeshBasicMaterial({ color: 0x000000, side: 1 /* BackSide */ })),
      );
    }

    const stopGeo = new SphereGeometry(0.07, 16, 12);
    for (const st of inp.stops) {
      const m = new Mesh(stopGeo, new MeshBasicMaterial({ color: new Color().setStyle(st.hex, "srgb") }));
      m.position.copy(v3(st.embed));
      this.pathGroup.add(m);
    }
    const endGeo = new SphereGeometry(0.13, 24, 16);
    for (const [p, col, txt] of [
      [inp.A, inp.aColor, "A"],
      [inp.B, inp.bColor, "B"],
    ] as const) {
      const m = new Mesh(endGeo, new MeshBasicMaterial({ color: new Color().setStyle(col, "srgb") }));
      m.position.copy(v3(p));
      this.pathGroup.add(m);
      const ring = new Mesh(
        new SphereGeometry(0.16, 24, 16),
        new MeshBasicMaterial({ color: 0xffffff, side: 1 }),
      );
      ring.position.copy(m.position);
      this.pathGroup.add(ring);
      const l = label(txt, m.position.clone().add(new Vector3(0, 0, 0.32)));
      this.pathGroup.add(l);
    }

    if (inp.points.length) {
      const og = new OctahedronGeometry(0.09);
      inp.points.forEach((p, i) => {
        const m = new Mesh(og, new MeshBasicMaterial({ color: 0xffffff }));
        m.position.copy(v3(p));
        this.pathGroup.add(m);
        this.pathGroup.add(label(String(i + 1), m.position.clone().add(new Vector3(0, 0, 0.25)), 0.35));
      });
      if (inp.showPolygon) {
        const g = new BufferGeometry().setFromPoints([inp.A, ...inp.points, inp.B].map(v3));
        const line = new Line(
          g,
          new LineDashedMaterial({ color: 0xffffff, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.7 }),
        );
        line.computeLineDistances();
        this.pathGroup.add(line);
      }
    }

    this.setPlane(inp.plane);
  }

  private setPlane(pl: Plane) {
    disposeChildren(this.planeGroup);
    const [u0, u1, v0, v1] = pl.view;
    const corners = [
      unproject(pl, u0, v0),
      unproject(pl, u1, v0),
      unproject(pl, u1, v1),
      unproject(pl, u0, v1),
    ].map(v3);
    const g = new BufferGeometry().setFromPoints([...corners, corners[0]]);
    this.planeGroup.add(
      new Line(g, new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })),
    );
    const fill = new BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);
    this.planeGroup.add(
      new Mesh(
        fill,
        new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.04, side: DoubleSide, depthWrite: false }),
      ),
    );
  }
}

// --- geometry builders --------------------------------------------------------

function gamutGeometry(space: ColorSpace, n: number): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new Color();
  for (const face of space.gamutFaces) {
    const base = pos.length / 3;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const native = face(i / n, j / n);
        const e = space.embed(native);
        pos.push(e[0] * S, e[1] * S, e[2] * S);
        const rgb = space.toRGB(native);
        c.setRGB(clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2]), "srgb");
        col.push(c.r, c.g, c.b);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = base + j * (n + 1) + i;
        const b = a + 1;
        const d = a + n + 1;
        idx.push(a, b, d + 1, a, d + 1, d);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

function gamutCloud(space: ColorSpace, count: number): Points {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new Color();
  for (let i = 0; i < count; i++) {
    const rgb: Vec3 = [Math.random(), Math.random(), Math.random()];
    const e = space.embed(space.fromRGB(rgb));
    pos.set([e[0] * S, e[1] * S, e[2] * S], i * 3);
    c.setRGB(rgb[0], rgb[1], rgb[2], "srgb");
    col.set([c.r, c.g, c.b], i * 3);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("color", new BufferAttribute(col, 3));
  return new Points(
    g,
    new PointsMaterial({ size: 0.045, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false }),
  );
}

function cubeEdges(): LineSegments {
  const k = S;
  const v = [-k, k];
  const segs: number[] = [];
  for (const a of v) for (const b of v) {
    segs.push(-k, a, b, k, a, b);
    segs.push(a, -k, b, a, k, b);
    segs.push(a, b, -k, a, b, k);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(segs, 3));
  return new LineSegments(g, new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 }));
}

function ringAt(space: ColorSpace): Line {
  const pts: Vector3[] = [];
  const z = space.id === "hsv" ? 1 : 0;
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    pts.push(new Vector3(Math.cos(a) * S, Math.sin(a) * S, z * S));
  }
  return new Line(
    new BufferGeometry().setFromPoints(pts),
    new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18 }),
  );
}

function label(text: string, pos: Vector3, size = 0.45): Sprite {
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d")!;
  const fs = 48;
  ctx.font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  cv.width = w;
  cv.height = fs + 20;
  ctx.font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(text, 12, cv.height / 2);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, 12, cv.height / 2);
  const tex = new CanvasTexture(cv);
  const sp = new Sprite(new SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set((size * cv.width) / cv.height, size, 1);
  sp.position.copy(pos);
  sp.renderOrder = 10;
  return sp;
}

function disposeChildren(g: Group) {
  for (const ch of [...g.children]) {
    g.remove(ch);
    ch.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      const mat = m.material as { dispose?: () => void; map?: { dispose(): void } } | undefined;
      mat?.map?.dispose();
      mat?.dispose?.();
    });
  }
}
