import { MathUtils, Quaternion, Vector3 } from "three";
import type { CameraRig, Projection } from "./cameras";
import type { ViewControls } from "./controls";

/** World units per second at the normal pace. */
const BASE_SPEED = 4;
/** Shift multiplier. */
const BOOST = 5;
/** Yaw and pitch per pixel of mouse travel. */
const RAD_PER_PX = 0.0022;
/** How close the look direction may get to straight up/down (~1.1°). Stopping
 *  short of the pole is what keeps the view from tipping over into a roll. */
const PITCH_LIMIT = 0.02;
/** Z-up world: Q/E and the mouse yaw all work off this. */
const WORLD_UP = new Vector3(0, 0, 1);

/**
 * Movement keys by PHYSICAL position, which is what `KeyboardEvent.code`
 * reports: 'KeyW' is the key one row above and one column right of Tab
 * whatever it is labelled, so the WASD block stays a block on AZERTY
 * (ZQSD), Dvorak (,AOE) and the rest. The HUD asks the browser for the
 * labels those physical keys carry on the current layout.
 */
const MOVE_CODES = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE"] as const;
/** Toggle key: `code` names keys after their US position, so this is always
 *  the one above Tab — `²` on French, `<` on some Nordic layouts, `~` on US. */
const TOGGLE_CODE = "Backquote";

const _move = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _back = new Vector3();
const _forward = new Vector3();
const _yaw = new Quaternion();
const _pitch = new Quaternion();

interface CameraState {
  position: Vector3;
  quaternion: Quaternion;
}

function captureCamera(out: CameraState, camera: { position: Vector3; quaternion: Quaternion }): void {
  out.position.copy(camera.position);
  out.quaternion.copy(camera.quaternion);
}

function restoreCamera(camera: { position: Vector3; quaternion: Quaternion }, from: CameraState): void {
  camera.position.copy(from.position);
  camera.quaternion.copy(from.quaternion);
}

export interface FlythroughDelegate {
  /** Entering/leaving: the app gates gizmo picking and orbit navigation. */
  onActiveChange(active: boolean): void;
  /** The rig's projection changed — flying always uses the perspective camera. */
  onProjectionChange(): void;
}

/**
 * Game-style flythrough on the key above Tab: WASD to move, Q/E down/up in
 * world Z, Shift to go 5× faster, mouse to look around. A left click or Enter
 * keeps the new viewpoint; a right click or Escape puts the camera back
 * exactly where it was.
 *
 * The camera is driven directly here, so while this is active the app leaves
 * OrbitControls' per-frame `lookAt` out of the loop — it would re-aim at the
 * orbit target every frame and undo the steering. On commit the orbit target
 * is planted back in front of the camera, at the distance it had on entry, so
 * orbiting afterwards pivots around what the pilot is looking at.
 */
export class Flythrough {
  active = false;

  private held = new Set<string>();
  private hud: HTMLDivElement;
  private keyLabels: Record<string, string> = {};
  /** Set while WE release the pointer lock, to tell it from the user pressing
   *  Escape — browsers eat that keydown and just drop the lock. */
  private releasingLock = false;

  private savedPersp: CameraState = { position: new Vector3(), quaternion: new Quaternion() };
  private savedOrtho: CameraState = { position: new Vector3(), quaternion: new Quaternion() };
  private savedZoom = 1;
  private savedProjection: Projection = "persp";
  private savedTarget = new Vector3();
  /** Camera→target distance on entry; the committed target keeps it. */
  private savedDistance = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private rig: CameraRig,
    private controls: ViewControls,
    private viewportEl: HTMLElement,
    private delegate: FlythroughDelegate,
  ) {
    this.hud = document.createElement("div");
    this.hud.className = "flythrough-hud";
    this.hud.style.display = "none";
    this.viewportEl.appendChild(this.hud);
    void this.loadKeyLabels();

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onWindowBlur);
    document.addEventListener("mousemove", this.onMouseMove);
    // Capture, so a left click that lands a flight cannot also reach the
    // selection handler underneath: the flight is over the moment this runs,
    // and a press that both commits and picks something is one press doing
    // two things the user only asked once for.
    document.addEventListener("mousedown", this.onMouseDown, { capture: true });
    document.addEventListener("contextmenu", this.onContextMenu);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
  }

  // -- entering / leaving ----------------------------------------------------

  enter(): void {
    if (this.active) return;
    // Panel fields must not eat the movement keys.
    (document.activeElement as HTMLElement | null)?.blur();

    this.savedProjection = this.rig.projection;
    captureCamera(this.savedPersp, this.rig.persp);
    captureCamera(this.savedOrtho, this.rig.ortho);
    this.savedZoom = this.rig.ortho.zoom;
    this.savedTarget.copy(this.controls.target);
    this.savedDistance = Math.max(
      0.5,
      this.rig.camera.position.distanceTo(this.controls.target),
    );

    // Flying an orthographic camera is a no-op forwards — take over the view
    // with the perspective one, framing preserved.
    if (this.rig.projection === "ortho") {
      this.rig.toggle(this.controls.target);
      this.delegate.onProjectionChange();
    }

    this.active = true;
    this.held.clear();
    this.hud.style.display = "block";
    this.delegate.onActiveChange(true);
    this.requestLock();
  }

  /** Keep the new viewpoint (Enter, or the toggle key again). */
  commit(): void {
    if (!this.active) return;
    // Re-plant the orbit pivot ahead of the camera so orbiting still works.
    this.rig.camera.getWorldDirection(_forward);
    this.controls.target
      .copy(this.rig.camera.position)
      .addScaledVector(_forward, this.savedDistance);
    this.stop();
  }

  /** Put the camera back exactly as it was before entering (Escape). */
  cancel(): void {
    if (!this.active) return;
    restoreCamera(this.rig.persp, this.savedPersp);
    restoreCamera(this.rig.ortho, this.savedOrtho);
    this.rig.ortho.zoom = this.savedZoom;
    this.rig.ortho.updateProjectionMatrix();
    this.controls.target.copy(this.savedTarget);
    const projectionChanged = this.rig.projection !== this.savedProjection;
    this.rig.projection = this.savedProjection;
    this.stop();
    if (projectionChanged) this.delegate.onProjectionChange();
  }

  private stop(): void {
    this.active = false;
    this.held.clear();
    this.hud.style.display = "none";
    this.releaseLock();
    this.delegate.onActiveChange(false);
  }

  // -- per-frame -------------------------------------------------------------

  update(dt: number): void {
    if (!this.active) return;
    const camera = this.rig.camera;
    camera.matrixWorld.extractBasis(_right, _up, _back);

    _move.set(0, 0, 0);
    if (this.held.has("KeyW")) _move.sub(_back); // -Z of the camera = forward
    if (this.held.has("KeyS")) _move.add(_back);
    if (this.held.has("KeyD")) _move.add(_right);
    if (this.held.has("KeyA")) _move.sub(_right);
    if (this.held.has("KeyE")) _move.add(WORLD_UP);
    if (this.held.has("KeyQ")) _move.sub(WORLD_UP);
    if (_move.lengthSq() === 0) return;

    const boosted = this.held.has("ShiftLeft") || this.held.has("ShiftRight");
    _move.normalize().multiplyScalar(BASE_SPEED * (boosted ? BOOST : 1) * dt);
    camera.position.add(_move);
    camera.updateMatrixWorld(true);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onWindowBlur);
    document.removeEventListener("mousemove", this.onMouseMove);
    // The flag has to match the one it went on with, or this detaches nothing
    // and the listener outlives the flight.
    document.removeEventListener("mousedown", this.onMouseDown, {
      capture: true,
    } as EventListenerOptions);
    document.removeEventListener("contextmenu", this.onContextMenu);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    this.hud.remove();
  }

  // -- input -----------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === TOGGLE_CODE && !isTyping(e.target)) {
      e.preventDefault();
      if (this.active) this.commit();
      else this.enter();
      return;
    }
    if (!this.active) return;
    if (e.code === "Escape") {
      e.preventDefault();
      this.cancel();
      return;
    }
    if (e.code === "Enter" || e.code === "NumpadEnter") {
      e.preventDefault();
      this.commit();
      return;
    }
    if (MOVE_CODES.includes(e.code as (typeof MOVE_CODES)[number]) || e.key === "Shift") {
      e.preventDefault();
      this.held.add(e.code);
    }
  };

  /**
   * Land or abandon the flight with the hand already on the mouse.
   *
   * The pilot is steering with the mouse and moving with the other hand, so
   * reaching for Enter or Escape means letting go of one of them. Left
   * commits, right puts the camera back — the two answers a flight can end
   * with, on the device already being held. The keys still work; this is a
   * second way in, not a replacement.
   *
   * Left is safe to claim here in a way it never is elsewhere in this app:
   * the pointer is locked, there is nothing under it to select, and no gizmo
   * is pickable while flying.
   */
  private onMouseDown = (e: MouseEvent): void => {
    if (!this.active) return;
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.button === 0) this.commit();
    else this.cancel();
  };

  /** Right-click means "put it back" while flying, so the menu must not open.
   *  OrbitControls suppresses this itself, but only while it is enabled — and
   *  it is switched off for the duration of a flight. */
  private onContextMenu = (e: MouseEvent): void => {
    if (!this.active) return;
    e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  /** Alt-tabbing away must not leave a key stuck down. */
  private onWindowBlur = (): void => {
    this.held.clear();
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.active) return;
    const dx = e.movementX ?? 0;
    const dy = e.movementY ?? 0;
    if (!dx && !dy) return;
    const camera = this.rig.camera;

    // Yaw about world up, applied in world space, so the horizon stays level.
    if (dx) {
      _yaw.setFromAxisAngle(WORLD_UP, -dx * RAD_PER_PX);
      camera.quaternion.premultiply(_yaw).normalize();
      camera.updateMatrixWorld(true);
    }

    if (dy) {
      // Pitch about the camera's own right axis, which the yaw above leaves
      // horizontal — so pitching adds no roll. The axis is perpendicular to
      // world up, so the polar angle moves one radian per radian of pitch:
      // clamp the angle we are aiming at, then rotate by whatever is left.
      camera.matrixWorld.extractBasis(_right, _up, _back);
      camera.getWorldDirection(_forward);
      const polar = _forward.angleTo(WORLD_UP);
      const limited = MathUtils.clamp(
        polar + dy * RAD_PER_PX, // mouse down looks down
        PITCH_LIMIT,
        Math.PI - PITCH_LIMIT,
      );
      const applied = polar - limited;
      if (applied !== 0) {
        _pitch.setFromAxisAngle(_right, applied);
        camera.quaternion.premultiply(_pitch).normalize();
        camera.updateMatrixWorld(true);
      }
    }
  };

  private onPointerLockChange = (): void => {
    if (!this.active || document.pointerLockElement === this.canvas) return;
    // The lock went away on its own. Escape is the usual reason and browsers
    // swallow that keydown, so treat any unexpected loss the same way: put the
    // camera back, which is the recoverable outcome.
    if (!this.releasingLock) this.cancel();
  };

  private requestLock(): void {
    this.releasingLock = false;
    // Not fatal if it is refused — mouse steering still works unlocked, it
    // just stops at the edge of the screen.
    try {
      void Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
    } catch {
      // Older signature, or refused outright.
    }
  }

  private releaseLock(): void {
    if (document.pointerLockElement !== this.canvas) return;
    this.releasingLock = true;
    document.exitPointerLock();
  }

  // -- HUD -------------------------------------------------------------------

  /**
   * Label the physical keys the way this keyboard does. Chromium exposes the
   * mapping; anywhere else the US labels stand in.
   */
  private async loadKeyLabels(): Promise<void> {
    const fallback: Record<string, string> = {
      KeyW: "W", KeyA: "A", KeyS: "S", KeyD: "D", KeyQ: "Q", KeyE: "E",
    };
    this.keyLabels = fallback;
    this.renderHud();
    const keyboard = (
      navigator as Navigator & {
        keyboard?: { getLayoutMap(): Promise<Map<string, string>> };
      }
    ).keyboard;
    if (!keyboard) return;
    try {
      const map = await keyboard.getLayoutMap();
      for (const code of MOVE_CODES) {
        const label = map.get(code);
        if (label) this.keyLabels[code] = label.toUpperCase();
      }
      this.renderHud();
    } catch {
      // Layout unavailable — the US labels are already in place.
    }
  }

  private renderHud(): void {
    const l = this.keyLabels;
    this.hud.textContent =
      `Flythrough · ${l.KeyW}${l.KeyA}${l.KeyS}${l.KeyD} move · ` +
      `${l.KeyQ}/${l.KeyE} down/up · mouse looks · Shift ${BOOST}× · ` +
      `click or Enter keeps it · right-click or Esc puts it back`;
  }
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
  );
}
