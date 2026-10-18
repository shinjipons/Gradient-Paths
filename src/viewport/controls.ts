import { Vector3 } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { CameraRig } from "./cameras";

/**
 * Thin OrbitControls wrapper. Recreated on camera toggle (OrbitControls keeps
 * internal spherical state tied to one camera) while preserving the target.
 *
 * Mouse navigation lives in `Navigation`, not here — all of it. Left belongs
 * to selection and gizmo drags; the middle and right buttons both need to
 * orbit about an arbitrary pivot, which OrbitControls cannot do (it always
 * re-aims at `target`); and the wheel has to dolly about the point under the
 * cursor rather than zoom about `target`. So no mouse button and no wheel is
 * left with this.
 *
 * What it is still here for is `target` — which the camera rig and the snap
 * views both read — kept normalized every frame, the touch gestures, and
 * eating the canvas's context menu, which it does for as long as it is
 * `enabled` and nothing here has to ask for.
 */
export class ViewControls {
  private controls: OrbitControls;
  /** Whether a drag is open — OrbitControls' own `start`/`end` say so. */
  private dragging = false;

  constructor(
    private rig: CameraRig,
    private dom: HTMLElement,
  ) {
    this.controls = this.create(new Vector3(0, 0, 0));
  }

  private create(target: Vector3): OrbitControls {
    const c = new OrbitControls(this.rig.camera, this.dom);
    c.target.copy(target);
    c.enableDamping = false;
    // `Navigation` claims every wheel event over the canvas before this can
    // see it; turning zoom off as well means there is no second path to the
    // camera if that ever stops being true.
    c.enableZoom = false;
    // Empty on purpose: OrbitControls reads a missing entry as "no action",
    // so this leaves all three buttons to us.
    c.mouseButtons = {};
    // The two events that say whether a drag of its own is in flight — a
    // touch one, now that no mouse button reaches it. Asking the library
    // directly would mean reading a field it does not publish; these are the
    // same answer, in the part of it that is ours to use.
    c.addEventListener("start", this.onDragStart);
    c.addEventListener("end", this.onDragEnd);
    c.update();
    return c;
  }

  private onDragStart = (): void => {
    this.dragging = true;
  };

  private onDragEnd = (): void => {
    this.dragging = false;
  };

  /**
   * Drop a drag the browser never ended.
   *
   * A drag closes on the pointerup it is owed, and a press that opens
   * something outside the page can leave with it — a menu the browser puts up
   * without asking. What is left behind moves the camera on a finger or a
   * button nobody is holding. `Navigation` guards its own drags; this is the
   * same guard for whatever gets this far, which is now touch.
   *
   * There is no way to tell OrbitControls that one is over — the state and
   * the document listeners keeping it open are both private, and only that
   * pointerup unwinds them. So the rebuild the camera toggle already does
   * stands in for one: disposing takes the listeners down, and what comes
   * back is idle, aimed at the same target.
   *
   * `Navigation` decides when this has happened; it owns the pointer.
   */
  endStrayDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.onCameraToggled();
  }

  get target(): Vector3 {
    return this.controls.target;
  }

  set enabled(v: boolean) {
    this.controls.enabled = v;
  }

  get enabled(): boolean {
    return this.controls.enabled;
  }

  /**
   * Rebuild against the camera's current up vector.
   *
   * OrbitControls reads `object.up` once, when it is constructed, to build
   * the quaternion its spherical maths runs in — an up that changes later is
   * not something it notices. Same rebuild as a camera toggle; different
   * reason for needing one.
   */
  onUpChanged(): void {
    this.onCameraToggled();
  }

  onCameraToggled(): void {
    const target = this.controls.target.clone();
    const enabled = this.controls.enabled;
    this.controls.dispose();
    this.controls = this.create(target);
    this.controls.enabled = enabled;
  }

  update(): void {
    this.controls.update();
  }
}
