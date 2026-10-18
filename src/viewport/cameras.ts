import {
  MathUtils,
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
} from "three";

export type Projection = "persp" | "ortho";
export type SnapView = "top" | "front" | "right";

/** Near-axis directions; 'top' is tilted a hair so lookAt with a Z up-vector
 *  stays well-defined. The tilt is along -Y only: that is what puts world +Y
 *  up and +X right on screen. Tilting X too would roll the view 45°. */
const SNAP_DIRS: Record<SnapView, Vector3> = {
  top: new Vector3(0, -1e-4, 1).normalize(),
  front: new Vector3(0, -1, 0),
  right: new Vector3(1, 0, 0),
};

const FOV = 45;
/** Fixed base frustum half-height for the ortho camera; zoom does the rest. */
const ORTHO_BASE_HALF_H = 5;

const _v = new Vector3();
const _dir = new Vector3();
const _axisDir = new Vector3();

/** |component| above which a view direction counts as straight down an axis.
 *  The snap dirs are nudged off-axis by 1e-4, so this has room to spare. */
const AXIS_ALIGNED = 0.999;

/**
 * Owns both cameras and the view-preserving toggle between them.
 * Cameras are constructed lazily (after Object3D.DEFAULT_UP is set to Z-up).
 */
export class CameraRig {
  readonly persp: PerspectiveCamera;
  readonly ortho: OrthographicCamera;
  projection: Projection = "persp";

  constructor(aspect: number) {
    this.persp = new PerspectiveCamera(FOV, aspect, 0.1, 1000);
    this.persp.position.set(7, -7, 5);
    this.persp.lookAt(0, 0, 0);

    this.ortho = new OrthographicCamera(
      -ORTHO_BASE_HALF_H * aspect,
      ORTHO_BASE_HALF_H * aspect,
      ORTHO_BASE_HALF_H,
      -ORTHO_BASE_HALF_H,
      -1000,
      2000,
    );
    this.ortho.position.copy(this.persp.position);
    this.ortho.lookAt(0, 0, 0);
  }

  get camera(): PerspectiveCamera | OrthographicCamera {
    return this.projection === "persp" ? this.persp : this.ortho;
  }

  /**
   * Which way is up for both cameras.
   *
   * Not decoration: it is the axis orbiting yaws about, it is what tells a
   * crossing of the pole from an approach to it, and it is what OrbitControls
   * levels the roll against every frame. Handing it a construction plane's Z
   * is what puts navigation in that plane's terms rather than the world's —
   * you orbit around the plane and go over *its* poles, not the ground's.
   *
   * `Navigation` also writes it, flipping it as the camera crosses a pole;
   * tell `ViewControls.onUpChanged` whenever it changes, or the levelling
   * will still be working from the up this was built with.
   */
  setUp(up: Vector3): void {
    this.persp.up.copy(up).normalize();
    this.ortho.up.copy(up).normalize();
  }

  setAspect(aspect: number): void {
    this.persp.aspect = aspect;
    this.persp.updateProjectionMatrix();
    this.ortho.left = -ORTHO_BASE_HALF_H * aspect;
    this.ortho.right = ORTHO_BASE_HALF_H * aspect;
    this.ortho.updateProjectionMatrix();
  }

  /** Switch projection while keeping the framing of `target` the same. */
  toggle(target: Vector3): Projection {
    const halfFovTan = Math.tan(MathUtils.degToRad(FOV / 2));
    if (this.projection === "persp") {
      const dist = this.persp.position.distanceTo(target);
      const halfH = halfFovTan * dist;
      this.ortho.position.copy(this.persp.position);
      this.ortho.quaternion.copy(this.persp.quaternion);
      this.ortho.zoom = ORTHO_BASE_HALF_H / halfH;
      this.ortho.updateProjectionMatrix();
      this.projection = "ortho";
    } else {
      const halfH = ORTHO_BASE_HALF_H / this.ortho.zoom;
      const dist = halfH / halfFovTan;
      _dir.subVectors(target, this.ortho.position).normalize();
      this.persp.position.copy(target).addScaledVector(_dir, -dist);
      this.persp.quaternion.copy(this.ortho.quaternion);
      this.projection = "persp";
    }
    return this.projection;
  }

  /**
   * Aim the orthographic camera straight down a world axis (CAD plan/front/
   * side view), preserving the current framing size, and make it active.
   */
  snapOrtho(view: SnapView, target: Vector3): void {
    const halfFovTan = Math.tan(MathUtils.degToRad(FOV / 2));
    const halfH =
      this.projection === "persp"
        ? halfFovTan * this.persp.position.distanceTo(target)
        : ORTHO_BASE_HALF_H / this.ortho.zoom;
    const dist = halfH / halfFovTan; // keeps persp round-trips consistent
    this.ortho.position.copy(target).addScaledVector(SNAP_DIRS[view], dist);
    this.ortho.lookAt(target);
    this.ortho.zoom = ORTHO_BASE_HALF_H / halfH;
    this.ortho.updateProjectionMatrix();
    this.projection = "ortho";
  }

  /**
   * World units per CSS pixel at `worldPos` — the scale factor that makes
   * px-authored gizmo geometry render at constant screen size.
   */
  worldPerPixel(worldPos: Vector3, cssHeightPx: number): number {
    if (this.projection === "persp") {
      const p = this.persp;
      // Distance along the view direction (stays correct at screen edges).
      const dist = _v.subVectors(worldPos, p.position).dot(p.getWorldDirection(_dir));
      return (
        (2 * Math.max(dist, p.near) * Math.tan(MathUtils.degToRad(p.fov) / 2)) /
        cssHeightPx
      );
    }
    const o = this.ortho;
    // OrbitControls dollies ortho cameras via `zoom`, not position.
    return (o.top - o.bottom) / (o.zoom * cssHeightPx);
  }

  /**
   * True in the standard CAD views: orthographic and aimed straight down a
   * world axis (the Top/Front/Right snaps, or an ortho orbit that lands on
   * one). Elements that are exactly edge-on there are expected, not noise.
   */
  isStandardOrthoView(): boolean {
    if (this.projection !== "ortho") return false;
    this.ortho.getWorldDirection(_axisDir);
    const dominant = Math.max(
      Math.abs(_axisDir.x),
      Math.abs(_axisDir.y),
      Math.abs(_axisDir.z),
    );
    return dominant >= AXIS_ALIGNED;
  }

  /** Unified view direction for fade math (position-independent in ortho). */
  viewDirTo(worldPos: Vector3, out: Vector3): Vector3 {
    if (this.projection === "persp") {
      return out.subVectors(worldPos, this.persp.position).normalize();
    }
    return this.ortho.getWorldDirection(out);
  }
}
