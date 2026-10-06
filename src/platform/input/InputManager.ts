/**
 * InputManager: WebXR controllers + hand tracking + desktop keyboard/mouse -> one InputFrame.
 *
 * Responsibilities (see IInputManager in platform/types):
 *  - Applies ROTATION only: desktop yaw on the rig + pitch on the camera; VR snap turn rotates the
 *    rig around the head (which also shifts rig.position so the head doesn't swing). All other
 *    translation is the game loop's job.
 *  - Produces world-space head + canonical-frame hand poses that are current for this frame.
 *  - Edges (gripPressed, triggerPressed, usePressed, menuPressed, ...) are true for exactly one
 *    update() call.
 *
 * XR space convention: three.js treats the XR reference space as the local space of the camera's
 * parent (= ctx.rig). Controller grip / hand groups are added under the rig too; their local
 * matrices are reference-space poses. Poses are always converted with `rig.matrixWorld * local`
 * explicitly, so they stay correct even if another module re-parents those groups.
 */

import * as THREE from 'three';
import type { XRGripSpace, XRHandSpace, XRTargetRaySpace } from 'three';
import { PLAYER } from '../../config';
import { clamp, yawFromQuat } from '../../core/math';
import type { FingerCurls, Handedness, HandPose, HeadPose, Quat, Vec3 } from '../../core/types';
import type { IInputManager, InputFrame, RenderContext } from '../types';
import {
  analyzeHandJoints,
  buttonValue,
  controllerCurls,
  FIST_OFF,
  FIST_ON,
  fistAmount,
  hysteresisAbove,
  hysteresisBelow,
  PINCH_MAX_INDEX_CURL,
  PINCH_OFF_M,
  PINCH_ON_M,
  radialDeadzone,
  USED_JOINTS,
  wristFromGrip,
  XR_AXIS,
  XR_BUTTON,
  type HandJointPositions,
  PINCH_WALK_DELAY,
  pinchWalkMove,
} from './handMath';
import { desktopHandTarget, REST_CURLS, SIGN_MIN_SECONDS, signForCode, type SignPreset } from './signs';

// ---------------------------------------------------------------------------------------------
// Tunables (module-private feel numbers; exported so they can be tweaked / shown in debug UI)
// ---------------------------------------------------------------------------------------------

/** Left-stick radial deadzone. */
export const STICK_DEADZONE = 0.15;
/** Right-stick snap turn fires above ON and re-arms below OFF (|x|). */
export const SNAP_TURN_ON = 0.6;
export const SNAP_TURN_OFF = 0.3;
/** Squeeze (grip) hysteresis on the analog value. */
export const GRIP_PRESS = 0.6;
export const GRIP_RELEASE = 0.4;
/** Trigger hysteresis on the analog value. */
export const TRIGGER_PRESS = 0.6;
export const TRIGGER_RELEASE = 0.4;
/** VR sprint (toggled by left-stick click) turns off after the stick rests this long (s). */
export const SPRINT_RELEASE_GRACE = 0.35;
/**
 * XR "menu" button: Quest doesn't expose the system menu buttons to WebXR, so the left
 * controller's Y button (xr-standard buttons[5]) acts as menu.
 */
export const XR_MENU_HAND: Handedness = 'left';
export const XR_MENU_BUTTON = XR_BUTTON.b;
/** Desktop mouse-look sensitivity (radians per pixel). */
export const MOUSE_SENSITIVITY = 0.0022;
/** Desktop pitch limit (radians). */
export const MAX_PITCH = (85 * Math.PI) / 180;
/** Desktop crouch easing rate (1/s). */
export const CROUCH_EASE_RATE = 10;
/** Desktop synthesized hand easing rate (1/s) when moving between rest pose and signs. */
export const DESKTOP_HAND_EASE_RATE = 14;
/** Ignore single mouse deltas bigger than this (px): some browsers spike when the lock engages. */
const MAX_MOUSE_DELTA = 250;
/** Escape and pointer-lock loss within this window (ms) count as one menu press. */
const MENU_DEBOUNCE_MS = 350;

const HANDS: readonly Handedness[] = ['left', 'right'];

const MOVE_KEYS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['KeyC', 'ControlLeft', 'ControlRight'],
} as const;

/** Keys whose browser default we suppress while the pointer is locked (scrolling, Ctrl+S/D...). */
const GAME_KEYS = new Set<string>([
  ...MOVE_KEYS.forward, ...MOVE_KEYS.back, ...MOVE_KEYS.left, ...MOVE_KEYS.right,
  ...MOVE_KEYS.sprint, ...MOVE_KEYS.crouch, 'KeyE', 'Space',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6',
]);

// ---------------------------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------------------------

interface XRSlot {
  index: number;
  ray: XRTargetRaySpace;
  grip: XRGripSpace;
  hand: XRHandSpace;
  source: XRInputSource | null;
}

interface XRSideState {
  /** Input source used last frame (detects controller <-> hand switches / disconnects). */
  source: XRInputSource | null;
  grip: boolean;
  trigger: boolean;
  menu: boolean;
  stickClick: boolean;
  /** Controller curls computed in the gamepad pass, used in the pose pass. */
  curls: FingerCurls;
  /** Last known pose (kept while untracked, flagged tracked=false). */
  pose: HandPose;
}

interface DesktopHandState {
  init: boolean;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  curls: FingerCurls;
}

type Edges = Record<Handedness, boolean>;

const edges = (): Edges => ({ left: false, right: false });
const v3 = (v: { x: number; y: number; z: number }): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const q4 = (q: { x: number; y: number; z: number; w: number }): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });
const restCurls = (): FingerCurls => [...REST_CURLS] as FingerCurls;
const untrackedPose = (): HandPose => ({
  tracked: false,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  curls: restCurls(),
});
const copyPose = (p: HandPose): HandPose => ({
  tracked: p.tracked,
  position: v3(p.position),
  rotation: q4(p.rotation),
  curls: [...p.curls] as FingerCurls,
});
const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || typeof (t as HTMLElement).tagName !== 'string') return false;
  const el = t as HTMLElement;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

// Scratch objects (no per-frame allocation for three math).
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q2 = new THREE.Quaternion();
const _rigQ = new THREE.Quaternion();

/** WebXR controllers + hand tracking + desktop keyboard/mouse. */
export class InputManager implements IInputManager {
  get mode(): 'xr' | 'desktop' {
    return this.ctx.renderer.xr.isPresenting ? 'xr' : 'desktop';
  }

  private enabled = true;
  private time = 0;
  private wasPresenting = false;

  // --- XR ---
  private readonly slots: XRSlot[] = [];
  /** How long the left hand has been pinching (hand-tracking walk). */
  private pinchWalkTime = 0;
  private readonly sides: Record<Handedness, XRSideState> = {
    left: { source: null, grip: false, trigger: false, menu: false, stickClick: false, curls: restCurls(), pose: untrackedPose() },
    right: { source: null, grip: false, trigger: false, menu: false, stickClick: false, curls: restCurls(), pose: untrackedPose() },
  };
  private sprintLatched = false;
  private sprintIdle = 0;
  private snapArmed = true;
  private lastXRHead: HeadPose | null = null;
  private readonly jointBuf: HandJointPositions = {};

  // --- Desktop ---
  private readonly keys = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  private pitch = 0;
  private eyeY: number = PLAYER.eyeHeight;
  private pendingUse = false;
  private pendingTrigger = false;
  private pendingMenu = false;
  /** Desktop key codes pressed since the last update (InputFrame.keysPressed). */
  private pendingKeys: string[] = [];
  private lastMenuAt = -1e9;
  /** Set when WE release the pointer lock (setEnabled(false) / entering XR): not a menu press. */
  private suppressUnlockMenu = false;
  private wasLocked = false;
  private sign: { preset: SignPreset; start: number; held: boolean } | null = null;
  private readonly deskHands: Record<Handedness, DesktopHandState> = {
    left: { init: false, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), curls: restCurls() },
    right: { init: false, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), curls: restCurls() },
  };

  private readonly listeners: Array<() => void> = [];

  /** `domElement` receives pointer lock / mouse events on desktop. */
  constructor(private readonly ctx: RenderContext, private readonly domElement: HTMLElement) {
    this.setupXR();
    this.setupDesktop();
  }

  // =============================================================================================
  // Public API
  // =============================================================================================

  update(dt: number): InputFrame {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    this.time += step;
    const presenting = this.ctx.renderer.xr.isPresenting;
    if (presenting !== this.wasPresenting) {
      if (presenting) this.onEnterXR();
      else this.onExitXR();
      this.wasPresenting = presenting;
    }
    const frame = presenting ? this.updateXR(step) : this.updateDesktop(step);
    if (this.exitReleases) {
      for (const h of HANDS) if (this.exitReleases[h]) frame.gripReleased[h] = true;
      this.exitReleases = null;
    }
    return frame;
  }

  /**
   * Desktop only (XR input is unaffected). Disabling releases pointer lock and zeroes desktop
   * input. Enabling also tries to grab pointer lock, which succeeds when called from a user
   * gesture (e.g. the menu's Play/Resume click) and is silently ignored otherwise.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.releasePointerLock();
      this.clearDesktopInput();
    } else {
      this.lockPointer();
    }
  }

  /**
   * Request pointer lock (desktop). Call it from a user-gesture handler (e.g. a "Resume" button)
   * so the player doesn't have to click the canvas again. No-op while disabled or in XR.
   */
  lockPointer(): void {
    if (!this.enabled || this.ctx.renderer.xr.isPresenting || this.isLocked()) return;
    try {
      const r: unknown = this.domElement.requestPointerLock();
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      /* not allowed right now (no user gesture / too soon after unlock) */
    }
  }

  /** Remove DOM listeners and detach XR groups. */
  dispose(): void {
    this.releasePointerLock();
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    for (const s of this.slots) {
      s.ray.removeFromParent();
      s.grip.removeFromParent();
      s.hand.removeFromParent();
    }
  }

  /**
   * The XR spaces for controller slot `index` (0/1), already parented to the rig. Handy for
   * debug visuals; which hand a slot belongs to depends on connection order.
   */
  getXRSpaces(index: number): { ray: XRTargetRaySpace; grip: XRGripSpace; hand: XRHandSpace } | null {
    const s = this.slots[index];
    return s ? { ray: s.ray, grip: s.grip, hand: s.hand } : null;
  }

  // =============================================================================================
  // XR
  // =============================================================================================

  private exitReleases: Edges | null = null;

  private setupXR(): void {
    const xr = this.ctx.renderer.xr;
    for (let i = 0; i < 2; i++) {
      const slot: XRSlot = {
        index: i,
        ray: xr.getController(i),
        grip: xr.getControllerGrip(i),
        hand: xr.getHand(i),
        source: null,
      };
      this.ctx.rig.add(slot.ray, slot.grip, slot.hand);
      // three dispatches connected/disconnected to all three groups; listen on one.
      const onConnected = (e: { data: XRInputSource }) => {
        slot.source = e.data ?? null;
      };
      const onDisconnected = (e: { data: XRInputSource }) => {
        if (!e.data || slot.source === e.data) slot.source = null;
      };
      slot.ray.addEventListener('connected', onConnected);
      slot.ray.addEventListener('disconnected', onDisconnected);
      this.listeners.push(() => {
        slot.ray.removeEventListener('connected', onConnected);
        slot.ray.removeEventListener('disconnected', onDisconnected);
      });
      this.slots.push(slot);
    }
  }

  private findSlot(side: Handedness): XRSlot | null {
    for (const s of this.slots) if (s.source && s.source.handedness === side) return s;
    return null;
  }

  private onEnterXR(): void {
    this.releasePointerLock();
    this.clearDesktopInput();
    this.pendingMenu = false;
    for (const h of HANDS) this.deskHands[h].init = false;
    this.sprintLatched = false;
    this.sprintIdle = 0;
    this.snapArmed = true;
  }

  private onExitXR(): void {
    const { rig, camera } = this.ctx;
    // Release anything still held so the game never sees a press without a release.
    const rel = edges();
    for (const h of HANDS) {
      const st = this.sides[h];
      if (st.grip) rel[h] = true;
      st.grip = st.trigger = st.menu = st.stickClick = false;
      st.source = null;
      st.pose.tracked = false;
    }
    this.exitReleases = rel;
    // Continue on desktop where the XR head was: same XZ, same facing, level pitch.
    const head = this.lastXRHead;
    if (head) {
      rig.rotation.y = wrapAngle(yawFromQuat(head.rotation));
      _v.set(head.position.x, head.position.y, head.position.z);
      if (rig.parent) {
        rig.parent.updateWorldMatrix(true, false);
        rig.parent.worldToLocal(_v);
      }
      rig.position.x = _v.x;
      rig.position.z = _v.z;
    }
    this.pitch = 0;
    this.eyeY = PLAYER.eyeHeight;
    camera.position.set(0, this.eyeY, 0);
    camera.rotation.set(0, 0, 0);
    camera.scale.set(1, 1, 1);
    this.lastXRHead = null;
    this.sprintLatched = false;
  }

  private updateXR(dt: number): InputFrame {
    const { renderer, rig, camera } = this.ctx;
    const xr = renderer.xr;
    // Desktop-only events are meaningless here.
    this.pendingUse = this.pendingTrigger = this.pendingMenu = false;
    this.pendingKeys.length = 0;
    this.mouseDX = this.mouseDY = 0;

    const gripPressed = edges();
    const gripReleased = edges();
    const triggerPressed = edges();
    let menuPressed = false;
    let move = { x: 0, y: 0 };
    let turn = 0;

    // ---- 1. sources + gamepad pass (anything that can rotate the rig happens before poses) ----
    const slotFor: Record<Handedness, XRSlot | null> = { left: null, right: null };
    for (const side of HANDS) {
      const slot = this.findSlot(side);
      slotFor[side] = slot;
      const src = slot?.source ?? null;
      const st = this.sides[side];
      if (src !== st.source) {
        if (st.grip) gripReleased[side] = true;
        st.grip = st.trigger = st.menu = st.stickClick = false;
        st.source = src;
        if (side === 'left') this.sprintLatched = false;
        if (side === 'right') this.snapArmed = true;
      }
      if (!src || src.hand) continue;
      const gp = src.gamepad;
      if (!gp) {
        st.curls = restCurls();
        continue;
      }
      const b = gp.buttons;
      st.curls = controllerCurls(b);

      const g = hysteresisAbove(st.grip, buttonValue(b[XR_BUTTON.squeeze]), GRIP_PRESS, GRIP_RELEASE);
      if (g && !st.grip) gripPressed[side] = true;
      if (!g && st.grip) gripReleased[side] = true;
      st.grip = g;

      const t = hysteresisAbove(st.trigger, buttonValue(b[XR_BUTTON.trigger]), TRIGGER_PRESS, TRIGGER_RELEASE);
      if (t && !st.trigger) triggerPressed[side] = true;
      st.trigger = t;

      const ax = gp.axes;
      const sx = ax.length >= 4 ? ax[XR_AXIS.stickX] : (ax[0] ?? 0);
      const sy = ax.length >= 4 ? ax[XR_AXIS.stickY] : (ax[1] ?? 0);

      if (side === XR_MENU_HAND) {
        const m = !!b[XR_MENU_BUTTON]?.pressed;
        if (m && !st.menu) menuPressed = true;
        st.menu = m;
      }

      if (side === 'left') {
        const dz = radialDeadzone(sx || 0, sy || 0, STICK_DEADZONE);
        move = { x: dz.x || 0, y: -dz.y || 0 }; // stick forward is -Y on xr-standard
        const click = !!b[XR_BUTTON.stick]?.pressed;
        if (click && !st.stickClick) {
          this.sprintLatched = !this.sprintLatched;
          this.sprintIdle = 0;
        }
        st.stickClick = click;
      } else {
        const x = sx || 0;
        if (this.snapArmed && Math.abs(x) > SNAP_TURN_ON) {
          turn = x > 0 ? -1 : 1; // stick right = turn right = negative yaw
          this.snapArmed = false;
        } else if (!this.snapArmed && Math.abs(x) < SNAP_TURN_OFF) {
          this.snapArmed = true;
        }
      }
    }

    const moving = move.x !== 0 || move.y !== 0;
    if (moving) this.sprintIdle = 0;
    else if (this.sprintLatched) {
      this.sprintIdle += dt;
      if (this.sprintIdle > SPRINT_RELEASE_GRACE) this.sprintLatched = false;
    }

    // ---- 2. snap turn around the head ----
    const xrFrame = (xr.getFrame() as XRFrame | null) ?? null;
    const refSpace = xr.getReferenceSpace();
    const viewer = xrFrame && refSpace ? xrFrame.getViewerPose(refSpace) : null;
    if (turn !== 0) {
      // Head position in rig-local (= reference) space.
      if (viewer) {
        const p = viewer.transform.position;
        _v.set(p.x, p.y, p.z);
      } else {
        _v.copy(camera.position);
      }
      _v2.copy(_v).applyQuaternion(rig.quaternion).add(rig.position); // pivot in rig-parent space
      rig.rotation.y = wrapAngle(rig.rotation.y + turn * PLAYER.snapTurnAngle);
      _v.applyQuaternion(rig.quaternion);
      rig.position.x = _v2.x - _v.x;
      rig.position.z = _v2.z - _v.z;
    }
    rig.updateWorldMatrix(true, false);

    // ---- 3. head (world) ----
    let head: HeadPose;
    if (viewer) {
      _m.fromArray(viewer.transform.matrix);
      _m.premultiply(rig.matrixWorld);
      _m.decompose(_p, _q, _s);
      head = { position: v3(_p), rotation: q4(_q) };
    } else if (this.lastXRHead) {
      head = { position: v3(this.lastXRHead.position), rotation: q4(this.lastXRHead.rotation) };
    } else {
      xr.updateCamera(camera);
      camera.matrixWorld.decompose(_p, _q, _s);
      head = { position: v3(_p), rotation: q4(_q) };
    }
    this.lastXRHead = { position: v3(head.position), rotation: q4(head.rotation) };

    // ---- 4. hands (world) ----
    for (const side of HANDS) {
      const slot = slotFor[side];
      const st = this.sides[side];
      const src = slot?.source ?? null;
      if (!slot || !src) {
        st.pose.tracked = false;
        continue;
      }
      if (src.hand) {
        const res = this.readHandJoints(slot.hand, side, rig.matrixWorld);
        if (!res) {
          st.pose.tracked = false; // keep gesture state through brief tracking loss
          continue;
        }
        st.pose = { tracked: true, position: res.position, rotation: res.rotation, curls: res.curls };
        const pinchOk = res.curls[1] < PINCH_MAX_INDEX_CURL;
        const pinch = pinchOk && hysteresisBelow(st.trigger, res.pinchDistance, PINCH_ON_M, PINCH_OFF_M);
        if (pinch && !st.trigger) triggerPressed[side] = true;
        st.trigger = pinch;
        const fist = hysteresisAbove(st.grip, fistAmount(res.curls), FIST_ON, FIST_OFF);
        if (fist && !st.grip) gripPressed[side] = true;
        if (!fist && st.grip) gripReleased[side] = true;
        st.grip = fist;
      } else {
        const grip = slot.grip;
        if (!grip.visible) {
          st.pose.tracked = false;
          st.pose.curls = [...st.curls] as FingerCurls;
          continue;
        }
        _m.multiplyMatrices(rig.matrixWorld, grip.matrix);
        _m.decompose(_p, _q, _s);
        const w = wristFromGrip(v3(_p), q4(_q), side);
        st.pose = { tracked: true, position: w.position, rotation: w.rotation, curls: [...st.curls] as FingerCurls };
      }
    }

    // ---- 5. hand-tracking locomotion: hold a left-hand pinch and point where to go ----
    const lh = this.sides.left;
    if (!moving && lh.source?.hand && lh.trigger && lh.pose.tracked) {
      this.pinchWalkTime += dt;
      if (this.pinchWalkTime >= PINCH_WALK_DELAY) move = pinchWalkMove(lh.pose.rotation, head.rotation);
    } else {
      this.pinchWalkTime = 0;
    }

    // Keep ctx.camera current for anyone reading it before render() (render updates it again).
    xr.updateCamera(camera);

    return {
      mode: 'xr',
      move,
      sprint: this.sprintLatched && moving,
      sneak: false,
      head,
      left: copyPose(this.sides.left.pose),
      right: copyPose(this.sides.right.pose),
      grip: { left: this.sides.left.grip, right: this.sides.right.grip },
      gripPressed,
      gripReleased,
      triggerPressed,
      usePressed: false,
      menuPressed,
      keysPressed: [],
    };
  }

  /** Read tracked joints (reference space), analyze, and convert to world space. */
  private readHandJoints(
    hand: XRHandSpace,
    side: Handedness,
    rigWorld: THREE.Matrix4,
  ): { position: Vec3; rotation: Quat; curls: FingerCurls; pinchDistance: number } | null {
    if (!hand.visible) return null;
    const joints = hand.joints;
    for (const name of USED_JOINTS) {
      const j = joints[name as XRHandJoint];
      if (!j || !j.visible) return null;
      const buf = this.jointBuf[name];
      if (buf) {
        buf.x = j.position.x;
        buf.y = j.position.y;
        buf.z = j.position.z;
      } else {
        this.jointBuf[name] = v3(j.position);
      }
    }
    const res = analyzeHandJoints(this.jointBuf, side);
    if (!res) return null;
    // Joint positions are reference-space (= rig-local; three never sets the hand group's matrix).
    _p.set(res.position.x, res.position.y, res.position.z).applyMatrix4(rigWorld);
    rigWorld.decompose(_v, _rigQ, _s);
    _q.set(res.rotation.x, res.rotation.y, res.rotation.z, res.rotation.w).premultiply(_rigQ);
    return { position: v3(_p), rotation: q4(_q), curls: res.curls, pinchDistance: res.pinchDistance };
  }

  // =============================================================================================
  // Desktop
  // =============================================================================================

  private setupDesktop(): void {
    const el = this.domElement;
    const doc = el.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
    const win = doc?.defaultView ?? (typeof window !== 'undefined' ? window : null);
    if (!doc || !win) return;

    const on = (target: EventTarget, type: string, fn: (e: never) => void) => {
      const l = fn as EventListener;
      target.addEventListener(type, l);
      this.listeners.push(() => target.removeEventListener(type, l));
    };

    on(el, 'click', () => {
      if (!this.isLocked()) this.lockPointer();
    });
    on(el, 'contextmenu', (e: MouseEvent) => {
      if (this.isLocked()) e.preventDefault();
    });
    on(el, 'mousedown', (e: MouseEvent) => {
      if (e.button === 0 && this.enabled && this.isLocked() && !this.ctx.renderer.xr.isPresenting) {
        this.pendingTrigger = true;
      }
    });
    on(doc, 'mousemove', (e: MouseEvent) => {
      if (!this.enabled || !this.isLocked()) return;
      const dx = e.movementX || 0;
      const dy = e.movementY || 0;
      if (Math.abs(dx) > MAX_MOUSE_DELTA || Math.abs(dy) > MAX_MOUSE_DELTA) return;
      this.mouseDX += dx;
      this.mouseDY += dy;
    });
    on(doc, 'pointerlockchange', () => {
      const locked = this.isLocked();
      if (!locked && this.wasLocked) {
        if (!this.suppressUnlockMenu && !this.ctx.renderer.xr.isPresenting) this.requestMenu();
        // The pointer is free again: drop pending mouse-look deltas (keys keep working unlocked).
        this.mouseDX = this.mouseDY = 0;
      }
      this.suppressUnlockMenu = false;
      this.wasLocked = locked;
    });
    on(win, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    on(win, 'keyup', (e: KeyboardEvent) => this.onKeyUp(e));
    on(win, 'blur', () => {
      this.keys.clear();
      if (this.sign) this.sign.held = false;
    });
  }

  private isLocked(): boolean {
    const doc = this.domElement.ownerDocument;
    return !!doc && doc.pointerLockElement === this.domElement;
  }

  private releasePointerLock(): void {
    if (this.isLocked()) {
      this.suppressUnlockMenu = true;
      try {
        this.domElement.ownerDocument.exitPointerLock();
      } catch {
        /* ignore */
      }
    }
  }

  private requestMenu(): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastMenuAt < MENU_DEBOUNCE_MS) return;
    this.lastMenuAt = now;
    this.pendingMenu = true;
  }

  private clearDesktopInput(): void {
    this.keys.clear();
    this.mouseDX = this.mouseDY = 0;
    this.pendingUse = false;
    this.pendingTrigger = false;
    this.pendingKeys.length = 0;
    this.sign = null;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (isEditableTarget(e.target)) return;
    if (e.code === 'Escape') {
      // Works even while disabled so the game can use it to close its menu.
      if (!e.repeat) this.requestMenu();
      return;
    }
    if (!this.enabled || this.ctx.renderer.xr.isPresenting) return;
    if (this.isLocked() && GAME_KEYS.has(e.code)) e.preventDefault();
    this.keys.add(e.code);
    if (e.repeat) return;
    if (this.pendingKeys.length < 16) this.pendingKeys.push(e.code);
    if (e.code === 'KeyE') this.pendingUse = true;
    const preset = signForCode(e.code);
    if (preset) this.sign = { preset, start: this.time, held: true };
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
    const preset = signForCode(e.code);
    if (preset && this.sign && this.sign.preset.id === preset.id) this.sign.held = false;
  }

  private anyKey(codes: readonly string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  private updateDesktop(dt: number): InputFrame {
    const { rig, camera } = this.ctx;

    // ---- look ----
    if (this.enabled && this.isLocked()) {
      rig.rotation.y = wrapAngle(rig.rotation.y - this.mouseDX * MOUSE_SENSITIVITY);
      this.pitch = clamp(this.pitch - this.mouseDY * MOUSE_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
    }
    this.mouseDX = this.mouseDY = 0;

    // ---- crouch / eye height ----
    const crouch = this.enabled && this.anyKey(MOVE_KEYS.crouch);
    const targetEye = crouch ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight;
    this.eyeY += (targetEye - this.eyeY) * (1 - Math.exp(-CROUCH_EASE_RATE * dt));
    if (Math.abs(this.eyeY - targetEye) < 1e-4) this.eyeY = targetEye;
    camera.position.set(0, this.eyeY, 0);
    camera.rotation.set(this.pitch, 0, 0);
    camera.updateWorldMatrix(true, false);
    camera.matrixWorld.decompose(_p, _q, _s);
    const head: HeadPose = { position: v3(_p), rotation: q4(_q) };
    const camPos = _v2.copy(_p);
    const camQuat = _q2.copy(_q);

    // ---- move ----
    let mx = 0;
    let my = 0;
    if (this.enabled) {
      if (this.anyKey(MOVE_KEYS.right)) mx += 1;
      if (this.anyKey(MOVE_KEYS.left)) mx -= 1;
      if (this.anyKey(MOVE_KEYS.forward)) my += 1;
      if (this.anyKey(MOVE_KEYS.back)) my -= 1;
    }
    const ml = Math.hypot(mx, my);
    if (ml > 1) {
      mx /= ml;
      my /= ml;
    }
    const sprint = this.enabled && !crouch && this.anyKey(MOVE_KEYS.sprint);

    // ---- sign timing ----
    if (this.sign && !this.sign.held && this.time - this.sign.start >= SIGN_MIN_SECONDS) this.sign = null;
    const sign = this.enabled ? this.sign : null;

    // ---- synthesized hands (camera-local target -> eased -> world) ----
    const k = 1 - Math.exp(-DESKTOP_HAND_EASE_RATE * dt);
    const kCurl = 1 - Math.exp(-DESKTOP_HAND_EASE_RATE * 1.8 * dt);
    const hands = {} as Record<Handedness, HandPose>;
    for (const side of HANDS) {
      const target = desktopHandTarget(side, sign ? sign.preset : null, sign ? this.time - sign.start : 0);
      const hs = this.deskHands[side];
      _v.set(target.position.x, target.position.y, target.position.z);
      _q.set(target.rotation.x, target.rotation.y, target.rotation.z, target.rotation.w);
      if (!hs.init) {
        hs.position.copy(_v);
        hs.quaternion.copy(_q);
        hs.curls = [...target.curls] as FingerCurls;
        hs.init = true;
      } else {
        hs.position.lerp(_v, k);
        hs.quaternion.slerp(_q, k);
        for (let i = 0; i < 5; i++) hs.curls[i] += (target.curls[i] - hs.curls[i]) * kCurl;
      }
      _v.copy(hs.position).applyQuaternion(camQuat).add(camPos);
      _q.copy(camQuat).multiply(hs.quaternion);
      hands[side] = { tracked: true, position: v3(_v), rotation: q4(_q), curls: [...hs.curls] as FingerCurls };
    }

    // ---- edges ----
    const triggerPressed = edges();
    triggerPressed.right = this.enabled && this.pendingTrigger;
    const usePressed = this.enabled && this.pendingUse;
    const menuPressed = this.pendingMenu;
    const keysPressed = this.enabled ? this.pendingKeys.slice() : [];
    this.pendingTrigger = this.pendingUse = this.pendingMenu = false;
    this.pendingKeys.length = 0;

    return {
      mode: 'desktop',
      move: { x: mx, y: my },
      sprint,
      sneak: crouch,
      head,
      left: hands.left,
      right: hands.right,
      grip: edges(),
      gripPressed: edges(),
      gripReleased: edges(),
      triggerPressed,
      usePressed,
      menuPressed,
      keysPressed,
    };
  }
}
