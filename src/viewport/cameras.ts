import { OrthographicCamera, Vector3 } from "three";

export type SnapView = "top" | "bottom" | "front" | "back" | "right" | "left";

/** Near-axis directions; 'top' and 'bottom' are tilted a hair so lookAt with a
 *  Z up-vector stays well-defined. The tilt is along -Y only: that is what puts
 *  world +X right on screen (and +Y up from the top, down from below). Tilting
 *  X too would roll the view 45°. */
export const SNAP_DIRS: Record<SnapView, Vector3> = {
  top: new Vector3(0, -1e-4, 1).normalize(),
  bottom: new Vector3(0, -1e-4, -1).normalize(),
  front: new Vector3(0, -1, 0),
  back: new Vector3(0, 1, 0),
  right: new Vector3(1, 0, 0),
  left: new Vector3(-1, 0, 0),
};

/** Fixed base frustum half-height; zoom does the rest. */
const ORTHO_BASE_HALF_H = 5;
/** How far the camera sits from its target. Ortho framing ignores it; it only
 *  has to keep the whole scene between the clip planes. */
const EYE_DISTANCE = 20;

/**
 * Owns the view's orthographic camera. Constructed lazily (after
 * Object3D.DEFAULT_UP is set to Z-up).
 */
export class CameraRig {
  readonly camera: OrthographicCamera;

  constructor(aspect: number) {
    this.camera = new OrthographicCamera(
      -ORTHO_BASE_HALF_H * aspect,
      ORTHO_BASE_HALF_H * aspect,
      ORTHO_BASE_HALF_H,
      -ORTHO_BASE_HALF_H,
      -1000,
      2000,
    );
    this.camera.position.set(7, -7, 5);
    this.camera.lookAt(0, 0, 0);
  }

  /**
   * Which way is up for the camera.
   *
   * Not decoration: it is the axis orbiting yaws about, it is what tells a
   * crossing of the pole from an approach to it, and it is what OrbitControls
   * levels the roll against every frame.
   *
   * `Navigation` also writes it, flipping it as the camera crosses a pole;
   * tell `ViewControls.onUpChanged` whenever it changes, or the levelling
   * will still be working from the up this was built with.
   */
  setUp(up: Vector3): void {
    this.camera.up.copy(up).normalize();
  }

  setAspect(aspect: number): void {
    this.camera.left = -ORTHO_BASE_HALF_H * aspect;
    this.camera.right = ORTHO_BASE_HALF_H * aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Look at `target` from direction `dir`, showing `halfH` world units above and below it. */
  frame(target: Vector3, dir: Vector3, halfH: number): void {
    this.camera.position.copy(target).addScaledVector(dir, EYE_DISTANCE);
    this.camera.lookAt(target);
    this.camera.zoom = ORTHO_BASE_HALF_H / halfH;
    this.camera.updateProjectionMatrix();
  }

  /** Aim straight down a world axis (CAD plan/front/side view), keeping the zoom. */
  snap(view: SnapView, target: Vector3): void {
    this.setUp(new Vector3(0, 0, 1)); // a pole crossing may have flipped it
    this.camera.position.copy(target).addScaledVector(SNAP_DIRS[view], EYE_DISTANCE);
    this.camera.lookAt(target);
  }

  /**
   * World units per CSS pixel — the scale factor that makes px-authored
   * geometry render at constant screen size.
   */
  worldPerPixel(cssHeightPx: number): number {
    const o = this.camera;
    return (o.top - o.bottom) / (o.zoom * cssHeightPx);
  }
}
