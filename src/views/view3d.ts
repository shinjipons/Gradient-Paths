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
  Raycaster,
  Vector2,
  PointsMaterial,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
  Object3D,
} from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { clamp01, type Vec3 } from "../color/convert";
import type { ColorSpace } from "../color/spaces";
import type { Sample } from "../path/paths";
import type { SolidStyle } from "../state";
import { CameraRig, type SnapView } from "../viewport/cameras";
import { ViewControls } from "../viewport/controls";
import { Flythrough } from "../viewport/flythrough";
import { Navigation } from "../viewport/navigation";
import { PLANE_EDGE, unproject, type Plane } from "./plane";

/** Embed space is ~[-1,1]³; this is its size in world units. */
const S = 2.2;
const HOME_DIR = new Vector3(6.5, -7.5, 4.5).normalize();
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

export interface View3DCallbacks {
  onDragStart(): void;
  onDragEnd(): void;
  /** An endpoint was moved with the gizmo; `rgb` is already clamped to sRGB. */
  onEndpoint(which: "a" | "b", rgb: Vec3): void;
  /** A control point / waypoint was moved with the gizmo (embed coords, unclamped). */
  onPoint(index: number, embed: Vec3): void;
}

/** A press that moves less than this is a click (select), not a drag. */
const CLICK_SLOP_PX = 4;
/** Single-axis drags snap to another handle's coordinate within this many px. */
const SNAP_PX = 10;
const AXIS_INDEX: Record<string, 0 | 1 | 2> = { X: 0, Y: 1, Z: 2 };

/**
 * 3D view of the sRGB gamut as it sits in the current space, with the path
 * running through it. Camera navigation is the house scheme (middle/right
 * drag orbit, wheel dolly, trackpad gestures, ` for flythrough).
 */
export class View3D {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  /**
   * Drawn after the scene with a fresh depth buffer: the path, its handles and
   * the gizmo always show on top of the gamut, yet still occlude themselves.
   */
  private overlay = new Scene();
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
  private space: ColorSpace | null = null;

  // Handle selection (A, B, control points) + translate gizmo. The gizmo drives a persistent proxy
  // object, since the path meshes are rebuilt on every update.
  private gizmo: TransformControls;
  private proxy = new Object3D();
  /** Selected handle: "a", "b", or "p<i>" for control point i. */
  private selected: string | null = null;
  private handleMeshes: Mesh[] = [];
  private handles = new Map<string, Vec3>();
  private raycaster = new Raycaster();
  private press: { x: number; y: number } | null = null;
  /** Dashed guide to the handle snapped to, shown while an axis drag is snapped. */
  private snapGuide = new Line(
    new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]),
    new LineDashedMaterial({ color: 0xffffff, dashSize: 0.08, gapSize: 0.06, depthTest: false, transparent: true }),
  );

  constructor(
    private container: HTMLElement,
    private cb: View3DCallbacks,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.autoClear = false;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    const canvas = this.renderer.domElement;
    canvas.className = "view3d-canvas";
    canvas.tabIndex = 0;

    this.rig = new CameraRig(1);
    this.controls = new ViewControls(this.rig, canvas);
    this.nav = new Navigation(canvas, this.rig, this.controls, {
      solidObjects: this.solidObjects,
      contentCenter: (out) => out.set(0, 0, 0),
    });
    this.fly = new Flythrough(canvas, this.rig, this.controls, container, {
      onActiveChange: (active) => {
        this.nav.enabled = !active;
        this.controls.enabled = !active;
        this.gizmo.enabled = !active;
      },
      onProjectionChange: () => this.controls.onCameraToggled(),
    });

    this.gizmo = new TransformControls(this.rig.camera, canvas);
    this.gizmo.setMode("translate");
    this.gizmo.setSize(0.6);
    this.snapGuide.visible = false;
    this.snapGuide.renderOrder = 11;
    this.snapGuide.frustumCulled = false; // its geometry changes every drag
    this.gizmo.addEventListener("dragging-changed", (e) => {
      if (e.value) this.cb.onDragStart();
      else {
        this.snapGuide.visible = false;
        this.cb.onDragEnd();
        // Snap back onto where the handle ended up (endpoints are clamped to sRGB).
        this.followSelected();
      }
    });
    this.gizmo.addEventListener("objectChange", () => {
      if (!this.selected || !this.space) return;
      this.snapToOther();
      const p = this.proxy.position;
      const e: Vec3 = [p.x / S, p.y / S, p.z / S];
      if (this.selected.startsWith("p")) {
        this.cb.onPoint(Number(this.selected.slice(1)), e);
        return;
      }
      const rgb = this.space.toRGB(this.space.unembed(e));
      if (rgb.every(Number.isFinite)) this.cb.onEndpoint(this.selected as "a" | "b", rgb.map(clamp01) as Vec3);
    });
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointermove", this.onHover);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.selected && !this.fly.active) this.select(null);
    });

    this.scene.add(this.gamut, this.planeGroup);
    this.overlay.add(this.pathGroup, this.proxy, this.gizmo.getHelper(), this.snapGuide);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.home();
    this.renderer.setAnimationLoop(this.frame);
  }

  private resize() {
    const r = this.container.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.renderer.setSize(r.width, r.height, false);
    this.renderer.domElement.style.width = `${r.width}px`;
    this.renderer.domElement.style.height = `${r.height}px`;
    this.rig.setAspect(r.width / r.height);
    for (const m of this.lineMaterials) m.resolution.set(r.width, r.height);
    // Until the user moves the camera, keep the whole gamut framed.
    if (this.homePos && this.rig.projection === "persp" && this.rig.persp.position.distanceTo(this.homePos) < 1e-6) {
      this.home();
    }
  }

  private homePos: Vector3 | null = null;

  /** Default three-quarter view, far enough back to fit the gamut at this aspect. */
  private home() {
    const cam = this.rig.persp;
    const half = (cam.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(half) * cam.aspect);
    const radius = S * 1.55;
    const d = radius / Math.sin(Math.min(half, hHalf));
    cam.position.copy(HOME_DIR).multiplyScalar(d);
    cam.lookAt(0, 0, 0);
    this.homePos = cam.position.clone();
  }

  private frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.fly.active) this.fly.update(dt);
    else this.controls.update();
    // The rig swaps cameras on projection toggles and snaps.
    if (this.gizmo.camera !== this.rig.camera) this.gizmo.camera = this.rig.camera;
    this.sizeLabels();
    this.renderer.clear();
    this.renderer.render(this.scene, this.rig.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.overlay, this.rig.camera);
  };

  private readonly labelPos = new Vector3();

  /** Scale every label so its text keeps a fixed pixel height on screen. */
  private sizeLabels() {
    const cssH = this.renderer.domElement.clientHeight || 1;
    const fit = (o: Object3D) => {
      const px = o.userData.labelPx as number | undefined;
      if (px === undefined) return;
      const h = px * this.rig.worldPerPixel(o.getWorldPosition(this.labelPos), cssH);
      o.scale.set(h * o.userData.labelAspect, h, 1);
    };
    this.scene.traverse(fit);
    this.overlay.traverse(fit);
  }

  // --- handle selection (A, B, control points) -------------------------------

  private select(id: string | null) {
    this.selected = id && this.handles.has(id) ? id : null;
    if (this.selected) {
      this.followSelected();
      this.gizmo.attach(this.proxy);
    } else this.gizmo.detach();
  }

  /** Put the gizmo on the selected handle, or drop it if the handle is gone. */
  private followSelected() {
    if (!this.selected) return;
    const p = this.handles.get(this.selected);
    if (p) this.proxy.position.copy(v3(p));
    else this.select(null);
  }

  /**
   * On a single-axis drag, lock that coordinate to the nearest other handle's
   * (A, B or another control point) when it comes within SNAP_PX on screen,
   * and draw a guide between the two.
   */
  private snapToOther() {
    const i = AXIS_INDEX[this.gizmo.axis ?? ""];
    const p = this.proxy.position;
    this.snapGuide.visible = false;
    if (i === undefined || !this.selected) return;
    const cssH = this.renderer.domElement.clientHeight || 1;
    const tol = SNAP_PX * this.rig.worldPerPixel(p, cssH);
    let other: Vector3 | null = null;
    let best = tol;
    for (const [id, h] of this.handles) {
      if (id === this.selected) continue;
      const q = v3(h);
      const d = Math.abs(p.getComponent(i) - q.getComponent(i));
      if (d <= best) {
        best = d;
        other = q;
      }
    }
    if (!other) return;
    p.setComponent(i, other.getComponent(i));
    const g = this.snapGuide.geometry;
    g.setFromPoints([p.clone(), other]);
    this.snapGuide.computeLineDistances();
    this.snapGuide.visible = true;
  }

  private pickHandle(e: PointerEvent): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.rig.camera);
    const hit = this.raycaster.intersectObjects(this.handleMeshes, false)[0];
    return (hit?.object.userData.handle as string | undefined) ?? null;
  }

  // Left button only: it never navigates, so it is free for picking.
  private onPointerDown = (e: PointerEvent) => {
    // TransformControls listens first, so `axis` already says whether this
    // press landed on one of its handles; such a press belongs to the gizmo.
    const onGizmo = this.gizmo.axis !== null;
    this.press = e.button === 0 && !this.fly.active && !onGizmo ? { x: e.clientX, y: e.clientY } : null;
  };

  private onPointerUp = (e: PointerEvent) => {
    const p = this.press;
    this.press = null;
    if (!p || e.button !== 0 || this.gizmo.dragging) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP_PX) return;
    this.select(this.pickHandle(e));
  };

  private onHover = (e: PointerEvent) => {
    if (e.buttons !== 0 || this.fly.active) return;
    const over = !this.gizmo.axis && this.pickHandle(e) !== null;
    this.renderer.domElement.style.cursor = over ? "pointer" : "";
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
    this.home();
    this.controls.onCameraToggled();
  }

  get projection() {
    return this.rig.projection;
  }

  // --- gamut solid -----------------------------------------------------------

  setGamut(space: ColorSpace, style: SolidStyle, opacity: number) {
    this.space = space;
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
    this.handleMeshes = [];
    this.handles = new Map<string, Vec3>([["a", inp.A], ["b", inp.B]]);
    inp.points.forEach((p, i) => this.handles.set(`p${i}`, p));
    // Follow the handle when it changes elsewhere; during a drag the gizmo owns it.
    if (!this.gizmo.dragging) this.followSelected();
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

    // Stops get the same dark outline as the tube, so the line stays legible
    // where it runs over gamut colors identical to its own.
    const stopGeo = new SphereGeometry(0.07, 16, 12);
    const stopCasingGeo = new SphereGeometry(0.09, 16, 12);
    const casingMat = new MeshBasicMaterial({ color: 0x000000, side: 1 /* BackSide */ });
    for (const st of inp.stops) {
      const m = new Mesh(stopGeo, new MeshBasicMaterial({ color: new Color().setStyle(st.hex, "srgb") }));
      m.position.copy(v3(st.embed));
      const casing = new Mesh(stopCasingGeo, casingMat);
      casing.position.copy(m.position);
      this.pathGroup.add(casing, m);
    }
    const endGeo = new SphereGeometry(0.13, 24, 16);
    for (const [p, col, txt, key] of [
      [inp.A, inp.aColor, "A", "a"],
      [inp.B, inp.bColor, "B", "b"],
    ] as const) {
      const m = new Mesh(endGeo, new MeshBasicMaterial({ color: new Color().setStyle(col, "srgb") }));
      m.position.copy(v3(p));
      m.userData.handle = key;
      this.handleMeshes.push(m);
      this.pathGroup.add(m);
      const ring = new Mesh(
        new SphereGeometry(0.16, 24, 16),
        new MeshBasicMaterial({ color: 0xffffff, side: 1 }),
      );
      ring.position.copy(m.position);
      this.pathGroup.add(ring);
      const l = label(txt, m.position.clone().add(new Vector3(0, 0, 0.17)), 13, true);
      this.pathGroup.add(l);
    }

    if (inp.points.length) {
      const og = new OctahedronGeometry(0.09);
      inp.points.forEach((p, i) => {
        const m = new Mesh(og, new MeshBasicMaterial({ color: 0xffffff }));
        m.position.copy(v3(p));
        m.userData.handle = `p${i}`;
        this.handleMeshes.push(m);
        this.pathGroup.add(m);
        this.pathGroup.add(label(String(i + 1), m.position.clone().add(new Vector3(0, 0, 0.11)), 11, true));
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

  /** Fat-line materials need the viewport size to draw their pixel widths. */
  private lineMaterials: LineMaterial[] = [];

  private setPlane(pl: Plane) {
    disposeChildren(this.planeGroup);
    const [u0, u1, v0, v1] = pl.view;
    const corners = [
      unproject(pl, u0, v0),
      unproject(pl, u1, v0),
      unproject(pl, u1, v1),
      unproject(pl, u0, v1),
    ].map(v3);
    // Bounds in the same hues as the 2D slice's frame: u edges, then v edges.
    // Drawn through the gamut, with a dark casing, so the whole outline shows.
    const order = [0, 1, 2, 3, 1, 2, 3, 0];
    const positions = order.flatMap((i) => corners[i].toArray());
    const u = new Color().setStyle(PLANE_EDGE.u, "srgb");
    const v = new Color().setStyle(PLANE_EDGE.v, "srgb");
    const colors = [u, u, u, u, v, v, v, v].flatMap((c) => [c.r, c.g, c.b]);
    const size = this.renderer.getSize(new Vector2());
    this.lineMaterials = [];
    for (const [width, colored, order] of [[5, false, 1], [2, true, 2]] as const) {
      const geo = new LineSegmentsGeometry().setPositions(positions);
      if (colored) geo.setColors(colors);
      const mat = new LineMaterial({
        linewidth: width,
        vertexColors: colored,
        color: colored ? 0xffffff : 0x000000,
        transparent: true,
        opacity: colored ? 1 : 0.6,
        depthTest: false,
      });
      mat.resolution.copy(size);
      this.lineMaterials.push(mat);
      const line = new LineSegments2(geo, mat);
      line.renderOrder = order;
      this.planeGroup.add(line);
    }
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

/**
 * A text label that stays the same size on screen however far the camera is:
 * `px` is the text height in CSS pixels; View3D rescales it every frame.
 * `anchorBottom` hangs the label above its point instead of centering on it.
 */
function label(text: string, pos: Vector3, px = 12, anchorBottom = false): Sprite {
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d")!;
  const fs = 48;
  const font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  cv.width = w;
  cv.height = fs + 20;
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(text, 12, cv.height / 2);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, 12, cv.height / 2);
  const tex = new CanvasTexture(cv);
  const sp = new Sprite(new SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.userData.labelPx = (px * cv.height) / fs;
  sp.userData.labelAspect = cv.width / cv.height;
  if (anchorBottom) sp.center.set(0.5, 0);
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
