import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Plane as MathPlane,
  Points,
  Quaternion,
  Raycaster,
  Vector2,
  PointsMaterial,
  Scene,
  SRGBColorSpace,
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
import { AxisGizmo } from "../viewport/axisgizmo";
import { CameraRig, type SnapView } from "../viewport/cameras";
import { ViewControls } from "../viewport/controls";
import { Navigation } from "../viewport/navigation";
import { PLANE_EDGE, unproject, type Plane } from "./plane";

/** Embed space is ~[-1,1]³; this is its size in world units. */
const S = 2.2;
const HOME_DIR = new Vector3(6.5, -7.5, 4.5).normalize();
const v3 = (p: Vec3) => new Vector3(p[0] * S, p[1] * S, p[2] * S);

// Shared by every rebuild of the path: dots are unit-radius, and sizeLabels
// scales them to their `dotPx` screen size.
const STOP_GEO = new SphereGeometry(1, 16, 12);
const END_GEO = new SphereGeometry(1, 24, 16);
/** Dark outline, back faces only, slightly larger than what it outlines. */
const CASING_MAT = new MeshBasicMaterial({ color: 0x000000, side: 1 /* BackSide */ });

type Dot = Mesh<BufferGeometry, MeshBasicMaterial>;

const dot = <T extends Object3D>(o: T, px: number): T => {
  o.userData.dotPx = px;
  return o;
};

/** A handle's label, which sizeLabels hangs `px` screen pixels above `userData.base`. */
const lifted = (l: Sprite, px: number): Sprite => {
  l.userData.base = new Vector3();
  l.userData.liftPx = px;
  return l;
};

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
 * The axes the selection gizmo moves a handle along: the space's own X/Y/Z;
 * the camera's right/up; the section plane's two axes and its normal; or, for
 * a control point, its two control-polygon edges and their bisector.
 */
export type TranslateSpace = "world" | "camera" | "plane" | "slide";

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
/** TransformControls' size; the slide arrows are drawn at the same scale. */
const GIZMO_SIZE = 0.6;
const HOVER_COLOR = 0xffff00;

/**
 * 3D view of the sRGB gamut as it sits in the current space, with the path
 * running through it, always in orthographic projection. Camera navigation is
 * the house scheme (middle-drag orbit, right-drag pan, wheel zoom, trackpad gestures).
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
  private gamut = new Group();
  private pathGroup = new Group();
  private planeGroup = new Group();
  private solidObjects: Object3D[] = [];
  private gamutKey = "";
  private space: ColorSpace | null = null;

  // Handle selection (A, B, control points) + translate gizmo. The gizmo drives a persistent proxy
  // object, since handle meshes come and go with the control points.
  private gizmo: TransformControls;
  /** Blender-style axis widget in the top-right corner. */
  private axisGizmo: AxisGizmo;
  private proxy = new Object3D();
  /** Selected handle: "a", "b", or "p<i>" for control point i. */
  private selected: string | null = null;
  private handleMeshes: Object3D[] = [];
  private handles = new Map<string, Vec3>();
  private raycaster = new Raycaster();
  private press: { x: number; y: number } | null = null;
  /**
   * A left press on a handle: once it moves past CLICK_SLOP_PX it drags the
   * handle in the camera-facing plane through it, no gizmo needed. `offset`
   * keeps the grab point under the cursor.
   */
  private screenDrag: { id: string; plane: MathPlane; offset: Vector3; pointerId: number; started: boolean } | null = null;
  private translateSpace: TranslateSpace = "world";
  /** The section plane and the control polygon [A, ...points, B], as of the last setPath. */
  private plane: Plane | null = null;
  private chain: Vec3[] = [];
  /** Slide space's own gizmo: arrows toward the previous and next polygon vertex, and their bisector. */
  private slide = new Group();
  private slideArrows = [slideArrow(0xff0000), slideArrow(0x00ff00), slideArrow(0x0000ff)];
  /** A drag on a slide arrow: the handle moves along that arrow's line, fixed for the whole drag. */
  private slideDrag: { arrow: SlideArrow; start: Vector3; t0: number; pointerId: number } | null = null;
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
    new Navigation(canvas, this.rig, this.controls, {
      solidObjects: this.solidObjects,
      contentCenter: (out) => out.set(0, 0, 0),
    });

    this.gizmo = new TransformControls(this.rig.camera, canvas);
    this.gizmo.setMode("translate");
    this.gizmo.setSize(GIZMO_SIZE);
    faceGizmoToCamera(this.gizmo);
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
      this.snapToOther();
      this.moveSelectedToProxy();
    });
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointermove", this.onHover);
    canvas.addEventListener("pointermove", this.onScreenDrag);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.selected) this.select(null);
    });

    this.axisGizmo = new AxisGizmo({
      onSnap: (view) => this.snap(view),
      onOrbit: (dx, dy) => this.orbitBy(dx, dy),
    });
    container.appendChild(this.axisGizmo.element);

    this.scene.add(this.gamut, this.planeGroup);
    this.slide.add(...this.slideArrows.map((a) => a.group));
    this.slide.visible = false;
    this.overlay.add(this.pathGroup, this.proxy, this.gizmo.getHelper(), this.snapGuide, this.slide);
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
    const cam = this.rig.camera;
    if (this.homeView && cam.position.distanceTo(this.homeView.pos) < 1e-6 && cam.zoom === this.homeView.zoom) {
      this.home();
    }
  }

  private homeView: { pos: Vector3; zoom: number } | null = null;

  /** Default three-quarter view, zoomed to fit the gamut at this aspect. */
  private home() {
    const cam = this.rig.camera;
    const radius = S * 1.9;
    const aspect = (cam.right - cam.left) / (cam.top - cam.bottom);
    this.rig.frame(new Vector3(), HOME_DIR, radius / Math.min(1, aspect));
    this.homeView = { pos: cam.position.clone(), zoom: cam.zoom };
  }

  private frame = () => {
    this.controls.update();
    this.orientGizmo();
    this.sizeLabels();
    this.axisGizmo.update(this.rig.camera);
    this.renderer.clear();
    this.renderer.render(this.scene, this.rig.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.overlay, this.rig.camera);
  };

  /** Keep labels, dots and their lifts at a fixed size on screen. */
  private sizeLabels() {
    const cssH = this.renderer.domElement.clientHeight || 1;
    const fit = (o: Object3D) => {
      const wpp = this.rig.worldPerPixel(cssH);
      const dot = o.userData.dotPx as number | undefined;
      if (dot !== undefined) o.scale.setScalar(dot * wpp); // unit-radius geometry
      const lift = o.userData.liftPx as number | undefined;
      if (lift !== undefined) o.position.copy(o.userData.base).z += lift * wpp;
      const px = o.userData.labelPx as number | undefined;
      if (px === undefined) return;
      const h = px * wpp;
      o.scale.set(h * o.userData.labelAspect, h, 1);
    };
    this.scene.traverse(fit);
    this.overlay.traverse(fit);
  }

  // --- handle selection (A, B, control points) -------------------------------

  private select(id: string | null) {
    this.selected = id && this.handles.has(id) ? id : null;
    this.followSelected();
    this.syncGizmo();
  }

  setTranslateSpace(space: TranslateSpace) {
    this.translateSpace = space;
    this.snapGuide.visible = false;
    this.syncGizmo();
  }

  /** Slide space only applies to control points; endpoints keep the regular gizmo, on world axes. */
  private get sliding() {
    return this.translateSpace === "slide" && !!this.selected?.startsWith("p");
  }

  /** Show the gizmo that fits the selection and the translation space: TransformControls, or the slide arrows. */
  private syncGizmo() {
    const local = this.translateSpace === "camera" || this.translateSpace === "plane";
    this.gizmo.setSpace(local ? "local" : "world");
    if (this.selected && !this.sliding) this.gizmo.attach(this.proxy);
    else this.gizmo.detach();
  }

  /**
   * Every frame: turn the proxy, and so the gizmo's axes in local space, to the
   * camera or the section plane, and place the slide arrows. Nothing turns mid-drag.
   */
  private orientGizmo() {
    const q = this.proxy.quaternion;
    if (!this.gizmo.dragging) {
      if (this.translateSpace === "camera") q.copy(this.rig.camera.quaternion);
      else if (this.translateSpace === "plane" && this.plane) {
        const u = new Vector3(...this.plane.u);
        const v = new Vector3(...this.plane.v);
        q.setFromRotationMatrix(new Matrix4().makeBasis(u, v, u.clone().cross(v)));
      } else q.identity();
    }

    this.slide.visible = this.sliding;
    if (!this.slide.visible) return;
    const cam = this.rig.camera;
    this.slide.position.copy(this.proxy.position);
    this.slide.scale.setScalar((((cam.top - cam.bottom) / cam.zoom) * GIZMO_SIZE) / 4);
    if (this.slideDrag) {
      // Mid-drag, only the dragged arrow stays.
      for (const a of this.slideArrows) a.group.visible = a === this.slideDrag.arrow;
      return;
    }
    // Control point i is chain[i + 1], between chain[i] and chain[i + 2].
    const i = Number(this.selected!.slice(1));
    const toward = (k: number) => v3(this.chain[k]).sub(this.proxy.position).normalize();
    const prev = toward(i);
    const next = toward(i + 2);
    let bisector = prev.clone().add(next);
    // Edges pointing straight apart: any direction across them will do.
    if (bisector.lengthSq() < 1e-8) bisector = prev.clone().cross(cam.getWorldDirection(new Vector3()));
    const dirs = [prev, next, bisector.normalize()];
    this.slideArrows.forEach((a, k) => {
      a.dir.copy(dirs[k]);
      a.group.visible = dirs[k].lengthSq() > 0.5; // a zero-length edge has no direction
      if (a.group.visible) a.group.quaternion.setFromUnitVectors(UP, dirs[k]);
    });
  }

  private pickSlide(e: PointerEvent): SlideArrow | null {
    if (!this.slide.visible) return null;
    this.aim(e);
    this.slide.updateMatrixWorld(true);
    const pickers = this.slideArrows.filter((a) => a.group.visible).map((a) => a.picker);
    const hit = this.raycaster.intersectObjects(pickers, false)[0];
    return this.slideArrows.find((a) => a.picker === hit?.object) ?? null;
  }

  /** How far along `origin + t·dir` the cursor's ray passes closest; null when the two run parallel. */
  private alongLine(e: PointerEvent, origin: Vector3, dir: Vector3): number | null {
    this.aim(e);
    const { origin: o, direction: r } = this.raycaster.ray;
    const w = origin.clone().sub(o);
    const b = dir.dot(r);
    const den = 1 - b * b;
    if (den < 1e-6) return null;
    return (b * r.dot(w) - dir.dot(w)) / den;
  }

  /** Report the selected handle as moved to the proxy's position (gizmo and screen drags alike). */
  private moveSelectedToProxy() {
    if (!this.selected || !this.space) return;
    const p = this.proxy.position;
    const e: Vec3 = [p.x / S, p.y / S, p.z / S];
    if (this.selected.startsWith("p")) {
      this.cb.onPoint(Number(this.selected.slice(1)), e);
      return;
    }
    const rgb = this.space.toRGB(this.space.unembed(e));
    if (rgb.every(Number.isFinite)) this.cb.onEndpoint(this.selected as "a" | "b", rgb.map(clamp01) as Vec3);
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
    // Other handles' coordinates only line up with an axis in world space.
    if (i === undefined || !this.selected || this.translateSpace !== "world") return;
    const cssH = this.renderer.domElement.clientHeight || 1;
    const tol = SNAP_PX * this.rig.worldPerPixel(cssH);
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

  /** Point the raycaster through the cursor. */
  private aim(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.rig.camera);
  }

  private pickHandle(e: PointerEvent): string | null {
    this.aim(e);
    const hit = this.raycaster.intersectObjects(this.handleMeshes, false)[0];
    return (hit?.object.userData.handle as string | undefined) ?? null;
  }

  // Left button only: it never navigates, so it is free for picking and dragging handles.
  private onPointerDown = (e: PointerEvent) => {
    const arrow = e.button === 0 ? this.pickSlide(e) : null;
    const t0 = arrow && this.alongLine(e, this.proxy.position, arrow.dir);
    if (arrow && t0 !== null) {
      this.press = null;
      this.screenDrag = null;
      this.slideDrag = { arrow, start: this.proxy.position.clone(), t0, pointerId: e.pointerId };
      this.renderer.domElement.setPointerCapture(e.pointerId);
      arrow.mat.color.set(HOVER_COLOR);
      this.cb.onDragStart();
      return;
    }
    // TransformControls listens first, so `axis` already says whether this
    // press landed on one of its handles; such a press belongs to the gizmo.
    const onGizmo = this.gizmo.axis !== null;
    this.press = e.button === 0 && !onGizmo ? { x: e.clientX, y: e.clientY } : null;
    this.screenDrag = null;
    const id = this.press && this.pickHandle(e);
    if (!id) return;
    const at = v3(this.handles.get(id)!);
    const plane = new MathPlane().setFromNormalAndCoplanarPoint(this.rig.camera.getWorldDirection(new Vector3()), at);
    const grab = this.raycaster.ray.intersectPlane(plane, new Vector3());
    if (grab) this.screenDrag = { id, plane, offset: at.sub(grab), pointerId: e.pointerId, started: false };
  };

  private onScreenDrag = (e: PointerEvent) => {
    const s = this.slideDrag;
    if (s) {
      if (e.pointerId !== s.pointerId) return;
      const t = this.alongLine(e, s.start, s.arrow.dir);
      if (t === null) return;
      this.proxy.position.copy(s.start).addScaledVector(s.arrow.dir, t - s.t0);
      this.moveSelectedToProxy();
      return;
    }
    const d = this.screenDrag;
    const p = this.press;
    if (!d || !p || e.pointerId !== d.pointerId) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) <= CLICK_SLOP_PX) return;
      d.started = true;
      this.select(d.id);
      this.renderer.domElement.setPointerCapture(e.pointerId);
      this.renderer.domElement.style.cursor = "grabbing";
      this.cb.onDragStart();
    }
    this.aim(e);
    const hit = this.raycaster.ray.intersectPlane(d.plane, new Vector3());
    if (!hit) return;
    this.proxy.position.copy(hit.add(d.offset));
    this.moveSelectedToProxy();
  };

  private onPointerUp = (e: PointerEvent) => {
    const s = this.slideDrag;
    if (s) {
      this.slideDrag = null;
      s.arrow.mat.color.set(s.arrow.color);
      this.cb.onDragEnd();
      this.followSelected();
      return;
    }
    const p = this.press;
    const d = this.screenDrag;
    this.press = null;
    this.screenDrag = null;
    if (d?.started) {
      this.renderer.domElement.style.cursor = "";
      this.cb.onDragEnd();
      // Snap back onto where the handle ended up (endpoints are clamped to sRGB).
      this.followSelected();
      return;
    }
    if (!p || e.button !== 0 || this.gizmo.dragging) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP_PX) return;
    this.select(this.pickHandle(e));
  };

  private onHover = (e: PointerEvent) => {
    if (e.buttons !== 0) return;
    const arrow = this.pickSlide(e);
    for (const a of this.slideArrows) a.mat.color.set(a === arrow ? HOVER_COLOR : a.color);
    const over = arrow !== null || (!this.gizmo.axis && this.pickHandle(e) !== null);
    this.renderer.domElement.style.cursor = over ? "grab" : "";
  };

  // --- toolbar actions ---------------------------------------------------------

  snap(view: SnapView) {
    this.rig.snap(view, this.controls.target);
    this.controls.onUpChanged();
  }

  /**
   * Turntable orbit about the target, Z up, as when dragging the axis gizmo:
   * the scene follows the pointer. Stops just short of the poles.
   */
  private orbitBy(dx: number, dy: number) {
    const RAD_PER_PX = 0.01;
    const target = this.controls.target;
    const offset = this.rig.camera.position.clone().sub(target);
    const r = offset.length();
    const theta = Math.atan2(offset.y, offset.x) - dx * RAD_PER_PX;
    const phi = Math.min(Math.PI - 1e-3, Math.max(1e-3, Math.acos(offset.z / r) - dy * RAD_PER_PX));
    offset.set(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi)).multiplyScalar(r);
    const cam = this.rig.camera;
    if (cam.up.z !== 1) {
      this.rig.setUp(new Vector3(0, 0, 1));
      this.controls.onUpChanged();
    }
    cam.position.copy(target).add(offset);
    cam.lookAt(target);
  }

  reset() {
    this.controls.target.set(0, 0, 0);
    this.rig.setUp(new Vector3(0, 0, 1));
    this.home();
    this.controls.onUpChanged();
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

  // Made once and reused: a drag calls setPath every frame, and each new
  // material or label texture costs the renderer a setup on its next draw.
  // Only the tube and the control polygon get new geometry.
  private tube: Mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ vertexColors: true }));
  private tubeCasing: Mesh = new Mesh(new BufferGeometry(), CASING_MAT);
  private stopDots: { dot: Dot; casing: Mesh }[] = [];
  private ends: Partial<Record<"a" | "b", { dot: Dot; ring: Mesh; label: Sprite }>> = {};
  private pointHandles: Sprite[] = [];
  private polygon = new Line(
    new BufferGeometry(),
    new LineDashedMaterial({ color: 0xffffff, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.7 }),
  );

  setPath(inp: PathInput) {
    this.plane = inp.plane;
    this.chain = [inp.A, ...inp.points, inp.B];
    this.pathGroup.clear();
    this.handleMeshes = [];
    this.handles = new Map<string, Vec3>([["a", inp.A], ["b", inp.B]]);
    inp.points.forEach((p, i) => this.handles.set(`p${i}`, p));
    // Follow the handle when it changes elsewhere; during a drag the gizmo owns it.
    if (!this.gizmo.dragging) this.followSelected();
    const pts = inp.dense.map((d) => v3(d.embed));
    // Collapse duplicates so the tube's Frenet frames stay finite.
    const keep = pts.map((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 1e-5);
    const uniq = pts.filter((_, i) => keep[i]);
    const uniqIdx = pts.flatMap((_, i) => (keep[i] ? [i] : []));
    // The tube is parameterized by arc length, the samples by t; where the path's speed varies
    // (spirals, easing) the two disagree, so colors are looked up by distance along the curve.
    const cum = [0];
    for (let i = 1; i < uniq.length; i++) cum.push(cum[i - 1] + uniq[i].distanceTo(uniq[i - 1]));
    const total = cum[cum.length - 1] || 1;
    const denseAtArc = (u: number) => {
      const target = u * total;
      let lo = 0;
      let hi = cum.length - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (cum[m] < target) lo = m;
        else hi = m;
      }
      return inp.dense[uniqIdx[target - cum[lo] < cum[hi] - target ? lo : hi]];
    };
    if (uniq.length >= 2) {
      const curve = new CatmullRomCurve3(uniq, false, "catmullrom", 0);
      const segs = 300;
      const radial = 8;
      const tube = new TubeGeometry(curve, segs, 0.035, radial, false);
      const colors = new Float32Array(tube.attributes.position.count * 3);
      const c = new Color();
      for (let i = 0; i <= segs; i++) {
        const s = denseAtArc(i / segs);
        c.setRGB(s.display[0], s.display[1], s.display[2], "srgb");
        for (let j = 0; j <= radial; j++) {
          const k = (i * (radial + 1) + j) * 3;
          colors[k] = c.r;
          colors[k + 1] = c.g;
          colors[k + 2] = c.b;
        }
      }
      tube.setAttribute("color", new BufferAttribute(colors, 3));
      this.tube.geometry.dispose();
      this.tube.geometry = tube;
      // Dark casing, slightly larger, back faces only: reads as an outline.
      this.tubeCasing.geometry.dispose();
      this.tubeCasing.geometry = new TubeGeometry(curve, segs, 0.05, radial, false);
      this.pathGroup.add(this.tube, this.tubeCasing);
    }

    // Stops get the same dark outline as the tube, so the line stays legible
    // where it runs over gamut colors identical to its own.
    inp.stops.forEach((st, i) => {
      const s = (this.stopDots[i] ??= {
        dot: dot(new Mesh(STOP_GEO, new MeshBasicMaterial()), 3.5),
        casing: dot(new Mesh(STOP_GEO, CASING_MAT), 5),
      });
      s.dot.material.color.setStyle(st.hex, "srgb");
      s.dot.position.copy(v3(st.embed));
      s.casing.position.copy(s.dot.position);
      this.pathGroup.add(s.casing, s.dot);
    });
    for (const [p, col, key] of [
      [inp.A, inp.aColor, "a"],
      [inp.B, inp.bColor, "b"],
    ] as const) {
      const e = (this.ends[key] ??= {
        dot: dot(new Mesh(END_GEO, new MeshBasicMaterial()), 9),
        ring: dot(new Mesh(END_GEO, CASING_MAT), 11),
        label: lifted(label(key.toUpperCase(), new Vector3(), 13, true), 13),
      });
      e.dot.material.color.setStyle(col, "srgb");
      e.dot.position.copy(v3(p));
      e.dot.userData.handle = key;
      e.ring.position.copy(e.dot.position);
      e.label.userData.base.copy(e.dot.position);
      e.label.position.copy(e.dot.position);
      this.handleMeshes.push(e.dot);
      this.pathGroup.add(e.dot, e.ring, e.label);
    }

    inp.points.forEach((p, i) => {
      const h = (this.pointHandles[i] ??= pointBadge(i + 1));
      h.position.copy(v3(p));
      h.userData.handle = `p${i}`;
      this.handleMeshes.push(h);
      this.pathGroup.add(h);
    });
    if (inp.points.length && inp.showPolygon) {
      this.polygon.geometry.dispose();
      this.polygon.geometry = new BufferGeometry().setFromPoints([inp.A, ...inp.points, inp.B].map(v3));
      this.polygon.computeLineDistances();
      this.pathGroup.add(this.polygon);
    }

    this.setPlane(inp.plane);
  }

  /** Fat-line materials need the viewport size to draw their pixel widths. */
  private lineMaterials: LineMaterial[] = [];
  private planeLines: LineSegments2[] = [];
  private planeKey = "";

  /**
   * The outline's lines and materials are made once: a new LineMaterial is a
   * large shader the renderer sets up again on its next draw. Only the
   * geometry follows the plane, and only when its corners move.
   */
  private setPlane(pl: Plane) {
    const [u0, u1, v0, v1] = pl.view;
    const corners = [
      unproject(pl, u0, v0),
      unproject(pl, u1, v0),
      unproject(pl, u1, v1),
      unproject(pl, u0, v1),
    ].map(v3);
    // Bounds dotted in the same color as the 2D slice's frame.
    // Drawn through the gamut, with a dark casing, so the whole outline shows.
    const order = [0, 1, 1, 2, 2, 3, 3, 0];
    const positions = order.flatMap((i) => corners[i].toArray());
    const key = positions.join();
    if (key === this.planeKey) return;
    this.planeKey = key;
    if (!this.planeLines.length) {
      const size = this.renderer.getSize(new Vector2());
      for (const [width, colored, order] of [[5, false, 1], [2.5, true, 2]] as const) {
        const mat = new LineMaterial({
          linewidth: width,
          color: colored ? new Color().setStyle(PLANE_EDGE, "srgb") : 0x000000,
          transparent: true,
          opacity: colored ? 1 : 0.6,
          depthTest: false,
          dashed: true,
          dashSize: 0.012,
          gapSize: 0.03,
        });
        mat.resolution.copy(size);
        this.lineMaterials.push(mat);
        const line = new LineSegments2(new LineSegmentsGeometry(), mat);
        line.renderOrder = order;
        this.planeLines.push(line);
      }
      this.planeGroup.add(...this.planeLines);
    }
    for (const line of this.planeLines) {
      line.geometry.dispose();
      line.geometry = new LineSegmentsGeometry().setPositions(positions);
      line.computeLineDistances();
    }
  }
}

/**
 * Point the translate gizmo at the camera: each axis keeps one arrow (its
 * negative-side arrow and picker are removed), and the arrows and plane
 * handles are mirrored into the octant facing the camera every frame, so
 * nothing hides behind the handle (three r170 dropped its own axis flip).
 */
function faceGizmoToCamera(controls: TransformControls) {
  type Gizmo = Object3D & {
    eye: Vector3;
    space: string;
    worldQuaternion: Quaternion;
    axis: string | null;
    dragging: boolean;
    gizmo: Record<string, Object3D>;
    picker: Record<string, Object3D>;
    helper: Record<string, Object3D>;
  };
  const g = (controls as unknown as { _gizmo: Gizmo })._gizmo;
  const groups = [g.gizmo.translate, g.picker.translate];

  // The geometry is baked in place, so a part's side is where its bounds sit.
  const AXIS: Record<string, 0 | 1 | 2> = { X: 0, Y: 1, Z: 2 };
  const center = new Vector3();
  for (const group of groups) {
    for (const part of [...group.children]) {
      const i = AXIS[part.name];
      const geo = (part as Mesh).geometry;
      if (i === undefined || !geo) continue;
      geo.computeBoundingBox();
      if (geo.boundingBox!.getCenter(center).getComponent(i) < -0.1) group.remove(part);
    }
  }

  // Drop the light-gray infinite line drawn along the hovered or dragged axis.
  for (const part of [...g.helper.translate.children]) if (part.name in AXIS) g.helper.translate.remove(part);

  const update = g.updateMatrixWorld.bind(g);
  g.updateMatrixWorld = (force?: boolean) => {
    update(force);
    // In local space the handles turn with the object, so read the eye in its frame.
    const eye = g.eye.clone();
    if (g.space === "local") eye.applyQuaternion(g.worldQuaternion.clone().invert());
    // An axis square to the view (both camera-space axes) reads ±0 here; rounding
    // noise must not flip it, so only a clearly negative component does.
    const flipped = (c: number) => (c < -1e-6 ? -1 : 1);
    const sx = flipped(eye.x);
    const sy = flipped(eye.y);
    const sz = flipped(eye.z);
    const flips: Record<string, [number, number, number]> = {
      X: [sx, 1, 1],
      Y: [1, sy, 1],
      Z: [1, 1, sz],
      XY: [sx, sy, 1],
      YZ: [1, sy, sz],
      XZ: [sx, 1, sz],
    };
    for (const group of groups) {
      for (const handle of group.children) {
        const flip = flips[handle.name];
        if (!flip || (flip[0] > 0 && flip[1] > 0 && flip[2] > 0)) continue;
        handle.scale.multiply(new Vector3(...flip));
        handle.updateMatrixWorld(true);
      }
    }
    // Mid-drag, only the handle being dragged stays: one arrow for an axis, one square for a plane.
    // TransformControls makes every handle visible again on its next update.
    if (g.dragging && g.axis) for (const handle of g.gizmo.translate.children) handle.visible &&= handle.name === g.axis;
  };
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

const UP = new Vector3(0, 1, 0);

interface SlideArrow {
  group: Group;
  mat: MeshBasicMaterial;
  color: number;
  /** World direction it points, set each frame while not dragging. */
  dir: Vector3;
  picker: Mesh;
}

/**
 * One arrow of the slide gizmo, shaped like TransformControls' translate
 * arrows: along +Y in its group, which is turned to point along `dir`.
 */
function slideArrow(color: number): SlideArrow {
  const mat = new MeshBasicMaterial({ color, depthTest: false, transparent: true, toneMapped: false });
  const shaft = new Mesh(new CylinderGeometry(0.0075, 0.0075, 0.5, 6), mat);
  shaft.position.y = 0.25;
  const head = new Mesh(new CylinderGeometry(0, 0.04, 0.1, 12), mat);
  head.position.y = 0.55;
  // Wider than the arrow and invisible, so it is easy to grab.
  const picker = new Mesh(new CylinderGeometry(0.06, 0.06, 0.6, 6), new MeshBasicMaterial({ visible: false }));
  picker.position.y = 0.3;
  for (const m of [shaft, head]) m.renderOrder = 12;
  const group = new Group();
  group.add(shaft, head, picker);
  return { group, mat, color, dir: new Vector3(), picker };
}

/**
 * A control point's handle, drawn like the 2D slice draws it: a dark square
 * with a white ring and its number inside. It faces the camera, stays the
 * same size on screen (14px across, ring included) and is never hidden.
 */
function pointBadge(n: number): Sprite {
  const k = 4; // canvas pixels per CSS pixel, so it stays crisp
  const outer = 14;
  const r = 6;
  const cv = document.createElement("canvas");
  cv.width = cv.height = outer * k;
  const ctx = cv.getContext("2d")!;
  const c = (outer * k) / 2;
  ctx.fillStyle = "#111";
  ctx.fillRect(c - r * k, c - r * k, 2 * r * k, 2 * r * k);
  ctx.lineWidth = 2 * k;
  ctx.strokeStyle = "#fff";
  ctx.strokeRect(c - r * k, c - r * k, 2 * r * k, 2 * r * k);
  ctx.fillStyle = "#fff";
  ctx.font = `600 ${9 * k}px ui-sans-serif, system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(n), c, c + 0.5 * k);
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace; // so #111 stays #111
  const sp = new Sprite(new SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.userData.labelPx = outer;
  sp.userData.labelAspect = 1;
  sp.renderOrder = 10;
  return sp;
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
