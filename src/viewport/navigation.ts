import {
  Box3,
  MathUtils,
  OrthographicCamera,
  Plane,
  Quaternion,
  Raycaster,
  Sphere,
  Vector2,
  Vector3,
  type Object3D,
} from "three";
import type { CameraRig } from "./cameras";
import type { ViewControls } from "./controls";

/**
 * What Navigation needs from the scene. Keep this narrow on purpose: the only
 * things pivot resolution asks about are "what can the cursor land on" and
 * "where is the middle of everything" — anything more couples camera movement
 * to the rest of the app.
 *
 * `solidObjects` should exclude gizmos, overlays and helper chrome: orbiting
 * around the handle you are hovering rather than the model under it is a
 * uniquely disorienting bug.
 */
export interface NavigationHost {
  /**
   * Raycast targets for pivot picking: the level's geometry, and nothing
   * standing in for it — not the ground it sits on, not chrome.
   *
   * Geometry only, on purpose. A drag begun over open ground turns about
   * the face you were just orbiting, where there is one, and otherwise
   * about the middle of what has been built — never about the patch of
   * floor under the cursor, a place that moves half a level for a few
   * pixels. See `resolvePivot`.
   */
  solidObjects: Object3D[];
  /** Pivot when nothing is under the cursor: the center of the level's bounds. */
  contentCenter(out: Vector3): Vector3;
}

/** The three camera movements, on the middle mouse button or the trackpad. */
export type NavAction = "orbit" | "dolly" | "truck";

/**
 * The reach a level sets nothing for: slightly more than 1, so the halo just
 * off the object still counts — which is where a cursor that has slipped off
 * an edge usually is. See `Navigation.faceReach`.
 */
const DEFAULT_FACE_REACH = 1.5;

/** Just the cursor position — all a pivot needs from an event. */
type ScreenPoint = { clientX: number; clientY: number };

/** A full drag across the viewport height sweeps this much orbit. */
const ORBIT_SWEEP = Math.PI * 2;
/** Dolly is exponential in drag distance; e-fold per this many pixels. */
const DOLLY_PIXELS = 220;
/**
 * A pause this long ends a trackpad gesture. A wheel stream has no press to
 * hang a pivot on, so the gap stands in for one: the next event after it
 * re-resolves the pivot the way a middle-press would.
 */
const GESTURE_GAP_MS = 140;
/**
 * A delta at least this big is a wheel notch rather than a gesture delta.
 *
 * This only ever picks a dolly *rate*, never which movement runs — a notch is
 * a coarse quantum where a pinch delta is a fine continuous one, so the two
 * need gains an order of magnitude apart. Getting it wrong costs speed, which
 * is a far softer failure than the wrong movement; deciding the movement from
 * magnitude is what used to make high-resolution wheels orbit.
 */
const WHEEL_NOTCH_MIN = 40;
/**
 * One wheel notch reports ~100, which is a step count and not a pixel count:
 * fed to `dolly` raw it would e-fold the distance to the pivot every two
 * notches. This brings a notch to a ~1.12x step, and it lands there whether
 * the wheel reports one coarse delta per notch or a high-resolution wheel
 * spreads the same ~100 over a handful of fine ones.
 */
const WHEEL_DOLLY_GAIN = 0.25;
/**
 * `deltaMode` is a unit, and only the pixel one is safe to read as a number.
 * Firefox reports a notch as 3 lines where Chromium reports 100 pixels, so a
 * line is worth 100/3 of them; a page is a notch that scrolls a screenful.
 * Without this the wheel still dollies on Firefox, just imperceptibly.
 *
 * A trackpad always reports pixels, so this never touches that path.
 */
const WHEEL_LINE_PX = 100 / 3;
const WHEEL_PAGE_PX = 800;
/**
 * Pinch deltas are not pixels either — they are a zoom quantity an order of
 * magnitude smaller than the drag distance that should produce the same
 * dolly. This brings a comfortable pinch up to roughly the e-fold that
 * `DOLLY_PIXELS` of drag gives.
 *
 * Unlike the orbit and truck rates, which are 1:1 with the gesture's own
 * pixels, this one is a judgement rather than an identity. It is the dial to
 * turn if pinching feels too eager or too slow.
 */
const PINCH_DOLLY_GAIN = 5;

const _v = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _flip = new Vector3();
const _pan = new Vector3();
const _ndcBefore = new Vector3();
const _ndcAfter = new Vector3();
const _pivot = new Vector3();
const _reachBox = new Box3();
const _normal = new Vector3();
const _qYaw = new Quaternion();
const _qPitch = new Quaternion();
const _rotation = new Quaternion();

/**
 * Ctrl, or Cmd, which is the same key.
 *
 * Nothing here wants to tell them apart. The modifier means "dolly" and a
 * Mac keyboard puts that meaning under the thumb rather than the little
 * finger — so reading `ctrlKey` alone is not a decision about Macs, it is
 * a decision that Mac users hold down the wrong key. The rest of the app
 * already answers to either (undo is Cmd+Z and Ctrl+Z), and navigation is
 * the one place that did not.
 *
 * The browser sets `ctrlKey` itself on a trackpad pinch, with no key held
 * at all. That still arrives here as a dolly, which is what it is.
 */
function ctrlOrCmd(e: MouseEvent | WheelEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

/**
 * Mode 1.b — classic 3-button navigation. Every movement is on the middle
 * button: drag to orbit, Ctrl/Cmd+drag to dolly, Shift+drag to truck. The wheel
 * dollies, through the same pivot-under-cursor path.
 *
 * A two-button mouse has no middle button, so the right button is one: the
 * same three movements under the same modifiers, handed to the same code. The
 * unmodified drag orbits, because orbit is what the unmodified drag is
 * everywhere else here — on the middle button and on two trackpad fingers —
 * and a mouse with one button fewer should not have to learn a different
 * scheme to get the movement it reaches for most.
 *
 * The same three movements are on the trackpad, reached by gesture instead of
 * by modifier: two-finger drag orbits, pinch dollies, Shift+two-finger drag
 * trucks. They run through the identical movement and pivot code, so a laptop
 * and a mouse navigate the same scene the same way.
 *
 * Orbit and dolly resolve a pivot, in priority order:
 *   1. The geometry exactly under the cursor.
 *   2. Orbiting only: if the last orbit was about a face, the point where the
 *      cursor's ray meets that face's own plane — so the cursor still names a
 *      point on the surface you were just turning about, even once it has
 *      slipped off the edge of it. Only while the cursor stays near the
 *      object that face belongs to, though: the plane runs on forever, and
 *      out past `faceReach` the point it offers is no longer anywhere you
 *      were working.
 *   3. Failing that, the center of the box round every object in the level.
 *
 * The step-2 plane is scratch state: only an orbit that lands on a face arms
 * it, and a truck drops it, since sliding the view sideways is leaving the
 * place. So a drag begun over open ground, or over the sky, turns about the
 * face you were working on or else about the middle of what has been built —
 * never about a point read off a surface nobody meant to name.
 *
 * Camera and target move together as a rigid frame about the pivot, so the
 * pivot holds its place on screen instead of snapping to the middle of the
 * view. Truck needs no pivot — it is always relative to the camera.
 */
export class Navigation {
  /** Off while the flythrough owns the camera. */
  enabled = true;
  /**
   * How far the remembered face plane is still believed once the cursor has
   * left the face, as a multiple of the orbited object's own radius.
   *
   * The plane itself is infinite, and a cursor out over the sky meets it a
   * street away — the same failure the ground has, arriving by a different
   * road. So the memory is given an edge: past it the plane is no longer
   * about anything you were looking at, and the middle of the level is the
   * better answer. At 0 the memory is off and a cursor off the face goes
   * straight to the middle; large enough and the plane is believed wherever
   * the ray meets it, which is the behaviour this replaced.
   *
   * A field rather than a constant because it is a knob the level tunes, and
   * a field rather than a host method because it is one number that does not
   * change between frames — whoever owns the config writes it. See
   * `ViewportConfig.orbitPivot.faceReach`.
   */
  faceReach = DEFAULT_FACE_REACH;

  private raycaster = new Raycaster();
  private ndc = new Vector2();
  private action: NavAction | null = null;
  private pointerId = -1;
  /** The wheel-borne gesture in flight, and the timestamp it last moved at. */
  private wheelAction: NavAction | null = null;
  private wheelAt = 0;
  /** Whether the gesture in flight has proved itself a trackpad. */
  private wheelTrackpad = false;
  private lastX = 0;
  private lastY = 0;
  private readonly pivot = new Vector3();
  /** The plane of the face the last orbit pivoted on, while one is held. */
  private readonly facePlane = new Plane();
  private hasFacePlane = false;
  /** The extent of the object that face belongs to, which `faceReach` scales. */
  private readonly faceExtent = new Sphere();

  constructor(
    private canvas: HTMLCanvasElement,
    private rig: CameraRig,
    private controls: ViewControls,
    private environment: NavigationHost,
  ) {
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    // Chrome opens autoscroll on a middle press unless the mousedown is eaten.
    canvas.addEventListener("mousedown", this.onMouseDown);
    // Both the wheel and every trackpad gesture arrive as wheel events, and
    // both are ours. Listening on the parent in the capture phase is what
    // lets this decide first: the capture phase runs over ancestors before
    // any listener on the canvas itself, so a claimed event is stopped before
    // OrbitControls — or anything else on the canvas — can see it.
    (canvas.parentElement ?? canvas).addEventListener("wheel", this.onWheel, {
      capture: true,
      passive: false,
    });
    // A drag can outlive the press that opened it. A menu the browser puts up
    // on its own — Firefox does, on Shift+right, without asking the page —
    // leaves with the pointerup that would have closed it, and what is left
    // behind moves the camera on a button nobody is holding. Nothing
    // announces that; the next move reporting no buttons at all is the only
    // sign of it. On the document, so a move that has wandered off the canvas
    // still arrives — the stray drag follows the pointer everywhere.
    canvas.ownerDocument.addEventListener("pointermove", this.onStrayMove);
    // The right button is ours whole, and OrbitControls listens on the canvas
    // — so, like the wheel, claimed in the capture phase over it.
    (canvas.parentElement ?? canvas).addEventListener(
      "pointerdown",
      this.onCapturedPointerDown,
      { capture: true },
    );
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault();
  };

  /**
   * A move with no button down ends whatever is still open — ours, and the
   * pan that is OrbitControls'.
   *
   * Only for events the browser itself made. The dev hook drives tools by
   * dispatching PointerEvents of its own, and a synthetic one reports no
   * buttons whether or not the gesture it is acting out has any: trusting it
   * would cancel the very drag it is trying to perform.
   */
  private onStrayMove = (e: PointerEvent): void => {
    if (e.buttons !== 0 || !e.isTrusted) return;
    if (this.action) this.onPointerUp(e);
    this.controls.endStrayDrag();
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 1 || !this.enabled) return;
    e.preventDefault();
    this.startDrag(ctrlOrCmd(e) ? "dolly" : e.shiftKey ? "truck" : "orbit", e);
  };

  /**
   * The right button, which is the middle button.
   *
   * It is the only one free to stand in for it — the left belongs to
   * selection and the tools, and the viewport has no context menu wanting the
   * right — so it takes the whole of the middle button's vocabulary rather
   * than some corner of it, and hands it to the same `startDrag`. A
   * two-button mouse and a three-button one then move the camera through
   * identical code, about identically resolved pivots.
   *
   * Claimed in the capture phase on the parent, for the reason the wheel is:
   * OrbitControls is constructed before this and its listener sits on the
   * canvas, so bubbling would reach it first. The capture phase runs over
   * ancestors before any listener on the canvas at all, which is the only
   * place a decision can be made ahead of it. Its `mouseButtons` is empty as
   * well — the two together mean there is no second path to the camera if
   * either ever stops being true.
   */
  private onCapturedPointerDown = (e: PointerEvent): void => {
    if (e.button !== 2 || !this.enabled) return;
    if (e.target !== this.canvas) return;
    e.preventDefault();
    // Stopped here rather than merely defaulted: the point is that nothing
    // else on the canvas sees the press at all.
    e.stopPropagation();
    this.startDrag(ctrlOrCmd(e) ? "dolly" : e.shiftKey ? "truck" : "orbit", e);
  };

  /** Open a drag: what it does, where it started, and the pivot it turns on. */
  private startDrag(action: NavAction, e: PointerEvent): void {
    this.action = action;
    this.pointerId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.beginGesture(action, e);

    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events (tests/tooling) have no capturable pointer — fine.
    }
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.action || e.pointerId !== this.pointerId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (dx === 0 && dy === 0) return;

    if (this.action === "orbit") this.orbit(dx, dy);
    else if (this.action === "dolly") this.dolly(dy);
    else this.truck(dx, dy);
  };

  /**
   * Open a movement: fix the pivot it will turn about, and drop the
   * remembered face plane where the movement means it no longer applies.
   *
   * Shared by the middle button and the trackpad, which differ only in what
   * counts as the start of a gesture — a press for one, a gap in the event
   * stream for the other.
   */
  private beginGesture(action: NavAction, at: ScreenPoint): void {
    // Truck is camera-relative; there is no pivot to resolve. It is also the
    // one movement that forgets the face: panning is leaving the place.
    if (action === "truck") {
      this.hasFacePlane = false;
      return;
    }
    this.setNDC(at);
    this.pivot.copy(this.resolvePivot(action));
  }

  /**
   * Everything that arrives as a wheel event: the wheel itself, which dollies,
   * and the trackpad's two-finger drag to orbit, pinch to dolly, Shift and two
   * fingers to truck.
   *
   * A wheel notch and a two-finger drag are the same event and no field on it
   * names the device, so the ambiguous case — a plain vertical delta — has to
   * be awarded to one of them by decree. It goes to the wheel: scrolling
   * dollies. A wheel that does anything else reads as broken, and it is the
   * one input a mouse has left once the middle button is spoken for, where a
   * trackpad still has three gestures.
   *
   * So the trackpad is what has to prove itself, via the one thing a wheel
   * cannot fake — see `isTrackpadEvent` — and the verdict latches for the rest
   * of the gesture. Awarding the ambiguous case this way round is also the
   * cheap one: the opening events of a trackpad drag carry deltas of a couple
   * of units, so the dolly they buy before the latch trips is invisible, where
   * a misread wheel notch is a hundred units of the wrong movement.
   *
   * Pinch needs no heuristic — every browser reports it as ctrl+wheel. That
   * arm also catches a genuine Ctrl/Cmd+wheel from a mouse, which dollies
   * too: exactly what the modifier and the middle button do.
   */
  private onWheel = (e: WheelEvent): void => {
    if (!this.enabled || e.target !== this.canvas) return;

    const stale = e.timeStamp - this.wheelAt > GESTURE_GAP_MS;
    if (stale) this.wheelTrackpad = false;
    if (this.isTrackpadEvent(e)) this.wheelTrackpad = true;

    let action: NavAction;
    if (ctrlOrCmd(e)) action = "dolly";
    else if (this.wheelTrackpad) action = e.shiftKey ? "truck" : "orbit";
    else action = "dolly";

    // Claimed: keep the page from scrolling or pinch-zooming itself, and keep
    // the event away from any other wheel listener on the canvas.
    e.preventDefault();
    e.stopPropagation();

    if (action !== this.wheelAction || stale) this.beginGesture(action, e);
    this.wheelAction = action;
    this.wheelAt = e.timeStamp;

    const unit =
      e.deltaMode === 1
        ? WHEEL_LINE_PX
        : e.deltaMode === 2
          ? WHEEL_PAGE_PX
          : 1;
    const deltaX = e.deltaX * unit;
    const deltaY = e.deltaY * unit;

    if (action === "dolly") {
      // Scrolling in and spreading both report a negative delta, and `dolly`
      // takes a positive number to move closer.
      // Only a small delta under the modifier is a pinch; everything else
      // on this arm is the wheel, at whatever resolution it reports.
      const pinch = ctrlOrCmd(e) && Math.abs(deltaY) < WHEEL_NOTCH_MIN;
      this.dolly(-deltaY * (pinch ? PINCH_DOLLY_GAIN : WHEEL_DOLLY_GAIN));
      return;
    }
    // The content follows the fingers, so a two-finger drag is the negative
    // of the pointer drag that would move the scene the same way. Rates are
    // left 1:1 with the gesture's pixels, which is what makes a sweep across
    // the viewport orbit as far as a middle-drag across it.
    if (action === "orbit") this.orbit(-deltaX, -deltaY);
    else this.truck(-deltaX, -deltaY);
  };

  /**
   * Does this event carry positive proof of a trackpad?
   *
   * Only one thing qualifies: a horizontal component. A scroll wheel has no
   * horizontal axis, so `deltaX` is the single number it cannot produce, and
   * any two-finger drag that is not dead vertical produces one within an event
   * or two — after which the caller's latch carries the verdict through the
   * rest of the gesture, including the perfectly vertical stretches in the
   * middle of it.
   *
   * Nothing else is evidence. Fine deltas, fractional deltas, sub-pixel
   * deltas: a high-resolution scroll wheel reports all three, which is exactly
   * how such wheels ended up orbiting when magnitude was allowed to decide.
   * `deltaMode !== 0` (lines or pages) is a wheel, and never a trackpad.
   *
   * The cost is a dead-vertical two-finger drag, which dollies instead of
   * orbiting — the same thing that gesture does in every other web app, and
   * the price of a wheel that is never wrong.
   */
  private isTrackpadEvent(e: WheelEvent): boolean {
    return e.deltaMode === 0 && e.deltaX !== 0;
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.action = null;
    this.pointerId = -1;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Never captured (synthetic pointer) — nothing to release.
    }
  };

  /**
   * Where the movement in flight is turning about, or null when there is
   * none — for the mark that shows it.
   *
   * A drag is in flight for as long as its button is down. A wheel-borne
   * gesture has no button, so it is in flight for the same gap that would
   * start a new one: the pause that ends a gesture is the pause that ends
   * the mark. Truck has no pivot and never shows one.
   */
  get activePivot(): Vector3 | null {
    if (this.action === "orbit" || this.action === "dolly") return this.pivot;
    if (
      this.wheelAction !== null &&
      this.wheelAction !== "truck" &&
      performance.now() - this.wheelAt <= GESTURE_GAP_MS
    ) {
      return this.pivot;
    }
    return null;
  }

  // -- movements ------------------------------------------------------------

  /**
   * Rotate the camera *and* its target rigidly about the pivot: yaw around
   * the up axis, pitch around the camera's own right axis. Rotating the
   * target too keeps it on the view axis, so the pivot stays put on screen
   * and OrbitControls' per-frame `lookAt(target)` stays a no-op.
   *
   * Pitch is taken as given. It used to be shortened to stop a thousandth of
   * a radian short of the poles, which made the top of the model a place you
   * could get near and never over — and getting over it meant letting go,
   * yawing half a turn, and coming at it from the other side.
   */
  private orbit(dx: number, dy: number): void {
    const camera = this.rig.camera;
    const height = this.canvas.clientHeight || 1;
    const up = camera.up;
    camera.matrixWorld.extractBasis(_right, _up, _v);

    _qYaw.setFromAxisAngle(up, (-ORBIT_SWEEP * dx) / height);
    _qPitch.setFromAxisAngle(_right, (-ORBIT_SWEEP * dy) / height);

    _rotation.copy(_qYaw).multiply(_qPitch);
    this.rotateAboutPivot(camera.position, _rotation);
    this.rotateAboutPivot(this.controls.target, _rotation);
    camera.quaternion.premultiply(_rotation).normalize();
    camera.updateMatrixWorld(true);
    this.followOverThePole();
  }

  /**
   * Turn the up axis over once the camera has gone over the top.
   *
   * Crossing a pole leaves the camera upside down with respect to the axis it
   * is orbiting, and two things read that axis on the next frame.
   * OrbitControls levels the roll against it, which would stand the view back
   * up — a 180° snap that bounces you off the pole you had just crossed. And
   * yaw turns about it, so dragging sideways would suddenly send the model
   * the other way.
   *
   * Flipping the axis settles both. It says nothing about where the camera is
   * or how it is turned, so nothing moves when it happens: it only means the
   * levelling now agrees with the view it is levelling, and that a drag keeps
   * taking the model the way the cursor goes.
   *
   * Read off the camera's own up rather than off the polar angle. Halfway
   * over, that vector is square to the axis and its sign is what the crossing
   * *is*; an angle would have to be compared against a pole it has already
   * passed, which is the ambiguity the old clamp existed to dodge.
   */
  private followOverThePole(): void {
    const camera = this.rig.camera;
    camera.matrixWorld.extractBasis(_right, _up, _v);
    if (_up.dot(camera.up) >= 0) return;
    this.rig.setUp(_flip.copy(camera.up).negate());
    this.controls.onUpChanged();
  }

  private rotateAboutPivot(point: Vector3, rotation: Quaternion): void {
    point.sub(this.pivot).applyQuaternion(rotation).add(this.pivot);
  }

  /**
   * Move toward or away from the pivot. In perspective that is a uniform
   * scaling of camera and target about the pivot; in orthographic it is a zoom
   * plus the lateral shift that keeps the pivot under the cursor.
   */
  private dolly(dy: number): void {
    const camera = this.rig.camera;
    // Negated: dragging up pulls the camera back, down pushes it in.
    const scale = Math.exp(-dy / DOLLY_PIXELS);

    if (!(camera instanceof OrthographicCamera)) {
      camera.position.sub(this.pivot).multiplyScalar(scale).add(this.pivot);
      this.controls.target.sub(this.pivot).multiplyScalar(scale).add(this.pivot);
      camera.updateMatrixWorld(true);
      return;
    }

    _ndcBefore.copy(this.pivot).project(camera);
    camera.zoom = MathUtils.clamp(camera.zoom / scale, 1e-3, 1e4);
    camera.updateProjectionMatrix();
    _ndcAfter.copy(this.pivot).project(camera);

    // Ortho projection is linear, so undo the pivot's drift by translating the
    // camera by the world-space equivalent of the NDC it moved.
    camera.matrixWorld.extractBasis(_right, _up, _v);
    const halfW = (camera.right - camera.left) / (2 * camera.zoom);
    const halfH = (camera.top - camera.bottom) / (2 * camera.zoom);
    _pan
      .copy(_right)
      .multiplyScalar((_ndcAfter.x - _ndcBefore.x) * halfW)
      .addScaledVector(_up, (_ndcAfter.y - _ndcBefore.y) * halfH);
    camera.position.add(_pan);
    this.controls.target.add(_pan);
    camera.updateMatrixWorld(true);
  }

  /** Slide camera and target across the screen plane, keeping the view angle. */
  private truck(dx: number, dy: number): void {
    const camera = this.rig.camera;
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    camera.matrixWorld.extractBasis(_right, _up, _v);

    let perPixelX: number;
    let perPixelY: number;
    if (camera instanceof OrthographicCamera) {
      perPixelX = (camera.right - camera.left) / (camera.zoom * width);
      perPixelY = (camera.top - camera.bottom) / (camera.zoom * height);
    } else {
      const distance = camera.position.distanceTo(this.controls.target);
      perPixelY =
        (2 * distance * Math.tan(MathUtils.degToRad(camera.fov) / 2)) / height;
      perPixelX = perPixelY;
    }

    _pan
      .copy(_right)
      .multiplyScalar(-dx * perPixelX)
      .addScaledVector(_up, dy * perPixelY);
    camera.position.add(_pan);
    this.controls.target.add(_pan);
    camera.updateMatrixWorld(true);
  }

  // -- pivot ----------------------------------------------------------------

  private setNDC(e: ScreenPoint): void {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  }

  private resolvePivot(action: NavAction): Vector3 {
    this.raycaster.setFromCamera(this.ndc, this.rig.camera);

    // 1. The geometry exactly under the cursor.
    //
    // Both movements ask only about the level's solids. Orbiting about the
    // patch of ground under the cursor sounds right — you are turning around
    // a place, and the ground is where the places are — but the ground runs
    // out to the horizon, so a cursor a few pixels further out names a point
    // half a level away and the view swings about that instead. Dollying at
    // it is worse: the step size becomes however far off that piece of floor
    // happens to be. With nothing built under the cursor there is no such
    // thing as the depth you meant, so the honest answer is the middle of
    // what there is.
    const hits = this.raycaster.intersectObjects(
      this.environment.solidObjects,
      true,
    );
    if (hits.length > 0) {
      const hit = hits[0]!;
      // Only an orbit arms the plane, and only when it landed on a face: the
      // plane is a memory of the surface you were turning about.
      if (action === "orbit" && hit.face) {
        _normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
        this.facePlane.setFromNormalAndCoplanarPoint(_normal, hit.point);
        // The object's own bounds, not the face's: a face is remembered as a
        // place on a thing, and the thing is what the cursor is still near or
        // has left. Measured here, at the one moment the object is known.
        _reachBox.setFromObject(hit.object);
        _reachBox.getBoundingSphere(this.faceExtent);
        this.hasFacePlane = true;
      }
      return _pivot.copy(hit.point);
    }

    // 2. The plane of the face the last orbit was about, where the cursor's
    //    ray still meets it near enough to the object that face is on.
    //    Orbiting only: a dolly towards a point on an extended plane has the
    //    ground's problem — the step becomes however far off that patch of
    //    plane happens to be. And far enough out the plane has that problem
    //    too, which is what the reach test is for: the memory is of a
    //    surface, and a point a level away is not on it in any sense that
    //    matters, so step 3 takes over.
    if (action === "orbit" && this.hasFacePlane) {
      const reach = this.faceExtent.radius * this.faceReach;
      if (
        this.raycaster.ray.intersectPlane(this.facePlane, _pivot) &&
        _pivot.distanceTo(this.faceExtent.center) <= reach
      ) {
        return _pivot;
      }
    }

    // 3. The center of the level's geometry — the box round every object in
    //    it, which is what `contentCenter` measures.
    //
    // The centre itself, not a point under the cursor at the centre's depth.
    // That alternative was tried, and it is the more obvious one: it keeps
    // the mark where you are pointing, where the centre puts it in mid-air a
    // long way off — measured at up to 480px, and jumping there and back as
    // the cursor crossed on and off the model. But a pivot under an off-axis
    // cursor swings the level out of frame, and keeping the level in frame is
    // the whole reason there is a step 3: it is the answer for a drag that
    // named nothing, and the level as a whole is the only thing such a drag
    // can be about. So the mark travelling is the cost, and it is the right
    // cost — it is the mark reporting honestly that the pivot has left the
    // cursor, which is exactly what has happened.
    return this.environment.contentCenter(_pivot);
  }
}
