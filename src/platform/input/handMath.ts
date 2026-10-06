/**
 * Pure hand / controller math for the input module (no three.js, no DOM, no WebXR objects).
 *
 * Everything here works on plain `Vec3` / `Quat` objects from core/types so it can be unit tested
 * in node and ported as-is. The InputManager feeds it WebXR joint positions / gamepad buttons and
 * converts the results to world space.
 *
 * Canonical hand frame (see HandPose in core/types): position = wrist, local -Z = toward the
 * middle fingertip, local +Y = out of the BACK of the hand, thumb on -X (right) / +X (left).
 */

import type { FingerCurls, Handedness, Quat, Vec3 } from '../../core/types';
import { add3, clamp, dot3, len3, rotate3, scale3, sub3 } from '../../core/math';

// ---------------------------------------------------------------------------------------------
// Small vector / quaternion helpers
// ---------------------------------------------------------------------------------------------

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function unit(a: Vec3): Vec3 | null {
  const l = len3(a);
  return l > 1e-9 ? scale3(a, 1 / l) : null;
}

/** Unsigned angle (radians) between two vectors. */
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.atan2(len3(cross3(a, b)), dot3(a, b));
}

/** Signed angle (radians) from `a` to `b` around `axis` (right-hand rule). */
export function signedAngle(a: Vec3, b: Vec3, axis: Vec3): number {
  return Math.atan2(dot3(cross3(a, b), axis), dot3(a, b));
}

/** Quaternion of the rotation whose matrix has columns x, y, z (must be orthonormal, right-handed). */
export function quatFromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  const m00 = x.x, m01 = y.x, m02 = z.x;
  const m10 = x.y, m11 = y.y, m12 = z.y;
  const m20 = x.z, m21 = y.z, m22 = z.z;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = { w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s };
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
  }
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

/** Hamilton product a * b (apply b first, then a). */
export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) };
}

/**
 * Mirror a rotation across the local YZ plane (x -> -x). Turns a right-hand canonical rotation
 * into the matching left-hand one (the left hand is the mirror image of the right; its thumb axis
 * flips sign by convention, which is exactly what this conjugation does).
 */
export function mirrorQuatX(q: Quat): Quat {
  return { x: q.x, y: -q.y, z: -q.z, w: q.w };
}

/**
 * Rotation of a canonical hand frame whose fingers point along `fingers` (local -Z) and whose
 * back of hand faces `back` (local +Y, orthogonalized against `fingers`).
 */
export function frameFromFingersBack(fingers: Vec3, back: Vec3): Quat {
  const z = unit(scale3(fingers, -1)) ?? { x: 0, y: 0, z: 1 };
  let y = sub3(back, scale3(z, dot3(back, z)));
  const yu = unit(y);
  if (!yu) {
    // `back` parallel to fingers: pick anything perpendicular.
    y = Math.abs(z.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    y = unit(sub3(y, scale3(z, dot3(y, z))))!;
  } else {
    y = yu;
  }
  const x = cross3(y, z);
  return quatFromBasis(x, y, z);
}

// ---------------------------------------------------------------------------------------------
// Hand tracking: canonical frame + finger curls from joint positions
// ---------------------------------------------------------------------------------------------

/** WebXR hand joint names (same strings as the WebXR `XRHandJoint` enum). */
export type HandJointName =
  | 'wrist'
  | 'thumb-metacarpal' | 'thumb-phalanx-proximal' | 'thumb-phalanx-distal' | 'thumb-tip'
  | 'index-finger-metacarpal' | 'index-finger-phalanx-proximal' | 'index-finger-phalanx-intermediate'
  | 'index-finger-phalanx-distal' | 'index-finger-tip'
  | 'middle-finger-metacarpal' | 'middle-finger-phalanx-proximal' | 'middle-finger-phalanx-intermediate'
  | 'middle-finger-phalanx-distal' | 'middle-finger-tip'
  | 'ring-finger-metacarpal' | 'ring-finger-phalanx-proximal' | 'ring-finger-phalanx-intermediate'
  | 'ring-finger-phalanx-distal' | 'ring-finger-tip'
  | 'pinky-finger-metacarpal' | 'pinky-finger-phalanx-proximal' | 'pinky-finger-phalanx-intermediate'
  | 'pinky-finger-phalanx-distal' | 'pinky-finger-tip';

/** Joint positions, all in one common space (any space: results come out in that space). */
export type HandJointPositions = Partial<Record<HandJointName, Vec3>>;

export const FINGER_NAMES = ['index', 'middle', 'ring', 'pinky'] as const;

/** Joint chain (base -> tip) for each long finger. */
export const FINGER_CHAINS: Record<(typeof FINGER_NAMES)[number], HandJointName[]> = {
  index: ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  middle: ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ring: ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  pinky: ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
};

export const THUMB_CHAIN: HandJointName[] = ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'];

/** All joints the input module reads. */
export const USED_JOINTS: HandJointName[] = [
  'wrist',
  ...THUMB_CHAIN,
  ...FINGER_CHAINS.index,
  ...FINGER_CHAINS.middle,
  ...FINGER_CHAINS.ring,
  ...FINGER_CHAINS.pinky,
];

/**
 * Long-finger curl normalization: the summed flexion at MCP + PIP + DIP (radians).
 * <= STRAIGHT -> curl 0, >= CURLED -> curl 1. An anatomical full fist is ~260°, Quest tracking
 * tends to report a bit less, so 220° counts as fully curled.
 */
export const FINGER_STRAIGHT_RAD = (15 * Math.PI) / 180;
export const FINGER_CURLED_RAD = (220 * Math.PI) / 180;
/** Thumb bend (MCP + IP, radians) normalization. */
export const THUMB_STRAIGHT_RAD = (15 * Math.PI) / 180;
export const THUMB_CURLED_RAD = (100 * Math.PI) / 180;
/**
 * Thumb "across the palm" measure: how far the thumb tip sits on the thumb side of the wrist,
 * in palm lengths (wrist -> middle knuckle). Extended / thumbs-up ≈ 0.9+, tucked over the
 * fingers ≈ 0.1. Mapped so OUT -> 0 and IN -> 1.
 */
export const THUMB_TIP_OUT = 0.75;
export const THUMB_TIP_IN = 0.15;

export interface HandFrame {
  position: Vec3;
  rotation: Quat;
  /** Frame axes in the input space (unit, right-handed). */
  axisX: Vec3;
  axisY: Vec3;
  axisZ: Vec3;
}

/**
 * Canonical hand frame from joint POSITIONS only (joint orientations are ignored on purpose:
 * runtimes disagree on joint-space axis conventions).
 *  - forward (local -Z) = wrist -> middle-finger-phalanx-proximal
 *  - back of hand (local +Y) = ±cross(index-proximal - pinky-proximal, forward), sign per hand,
 *    orthogonalized against forward
 *  - position = wrist
 * Returns null if the needed joints are missing or degenerate.
 */
export function handFrameFromJoints(j: HandJointPositions, handedness: Handedness): HandFrame | null {
  const wrist = j['wrist'];
  const mid = j['middle-finger-phalanx-proximal'];
  const idx = j['index-finger-phalanx-proximal'];
  const pky = j['pinky-finger-phalanx-proximal'];
  if (!wrist || !mid || !idx || !pky) return null;
  const fwd = unit(sub3(mid, wrist));
  if (!fwd) return null;
  const lateral = sub3(idx, pky); // points toward the thumb side
  // Right hand: thumb side is -X, so cross(lateral, fwd) points out of the PALM -> negate.
  let n = cross3(lateral, fwd);
  if (handedness === 'right') n = scale3(n, -1);
  const z = scale3(fwd, -1);
  const y = unit(sub3(n, scale3(z, dot3(n, z))));
  if (!y) return null;
  const x = cross3(y, z);
  return { position: { x: wrist.x, y: wrist.y, z: wrist.z }, rotation: quatFromBasis(x, y, z), axisX: x, axisY: y, axisZ: z };
}

/**
 * Curl of one long finger from its 5 joints: sum of the flexion angles between successive bone
 * directions (MCP, PIP, DIP). With a hand frame, bones are projected onto the plane perpendicular
 * to the hand's lateral (flexion) axis and the angles are signed, so sideways spread and
 * hyperextension don't count as curl; without a frame, plain unsigned angles are used.
 */
export function fingerCurlFromChain(points: Vec3[], flexAxis: Vec3 | null): number {
  let sum = 0;
  let prev: Vec3 | null = null;
  for (let i = 1; i < points.length; i++) {
    let bone = sub3(points[i], points[i - 1]);
    if (flexAxis) bone = sub3(bone, scale3(flexAxis, dot3(bone, flexAxis)));
    const b = unit(bone);
    if (!b) continue;
    if (prev) {
      const a = flexAxis ? signedAngle(prev, b, flexAxis) : angleBetween(prev, b);
      sum += Math.max(0, a);
    }
    prev = b;
  }
  return clamp((sum - FINGER_STRAIGHT_RAD) / (FINGER_CURLED_RAD - FINGER_STRAIGHT_RAD), 0, 1);
}

/**
 * Thumb curl: half from how bent the thumb is (MCP + IP), half from how far its tip has swung
 * across the palm toward the pinky side (thumbs up / open palm = 0, tucked over a fist = 1).
 */
export function thumbCurlFromJoints(j: HandJointPositions, frame: HandFrame | null, handedness: Handedness): number | null {
  const pts = THUMB_CHAIN.map((n) => j[n]);
  if (pts.some((p) => !p)) return null;
  const p = pts as Vec3[];
  const b0 = unit(sub3(p[1], p[0]));
  const b1 = unit(sub3(p[2], p[1]));
  const b2 = unit(sub3(p[3], p[2]));
  let bend = 0;
  if (b0 && b1) bend += angleBetween(b0, b1);
  if (b1 && b2) bend += angleBetween(b1, b2);
  const bendN = clamp((bend - THUMB_STRAIGHT_RAD) / (THUMB_CURLED_RAD - THUMB_STRAIGHT_RAD), 0, 1);
  if (!frame) return bendN;
  const mid = j['middle-finger-phalanx-proximal'];
  const palmLen = mid ? len3(sub3(mid, frame.position)) : 0;
  if (palmLen < 1e-4) return bendN;
  const xLocal = dot3(sub3(p[3], frame.position), frame.axisX);
  const thumbSide = (handedness === 'right' ? -xLocal : xLocal) / palmLen;
  const acrossN = clamp((THUMB_TIP_OUT - thumbSide) / (THUMB_TIP_OUT - THUMB_TIP_IN), 0, 1);
  return clamp(0.5 * bendN + 0.5 * acrossN, 0, 1);
}

/** All 5 curls [thumb, index, middle, ring, pinky]; null if joints are missing. */
export function fingerCurlsFromJoints(j: HandJointPositions, frame: HandFrame | null, handedness: Handedness): FingerCurls | null {
  // Flexion (curling toward the palm) rotates local -Z toward local -Y: a positive rotation about local -X.
  const flexAxis = frame ? scale3(frame.axisX, -1) : null;
  const out: number[] = [];
  const thumb = thumbCurlFromJoints(j, frame, handedness);
  if (thumb === null) return null;
  out.push(thumb);
  for (const f of FINGER_NAMES) {
    const pts = FINGER_CHAINS[f].map((n) => j[n]);
    if (pts.some((p) => !p)) return null;
    out.push(fingerCurlFromChain(pts as Vec3[], flexAxis));
  }
  return out as FingerCurls;
}

export interface TrackedHandResult {
  position: Vec3;
  rotation: Quat;
  curls: FingerCurls;
  /** Thumb tip <-> index tip distance (m). */
  pinchDistance: number;
}

/** Everything the input module needs from one tracked hand, in the joints' space. */
export function analyzeHandJoints(j: HandJointPositions, handedness: Handedness): TrackedHandResult | null {
  const frame = handFrameFromJoints(j, handedness);
  if (!frame) return null;
  const curls = fingerCurlsFromJoints(j, frame, handedness);
  if (!curls) return null;
  const tt = j['thumb-tip']!;
  const it = j['index-finger-tip']!;
  return { position: frame.position, rotation: frame.rotation, curls, pinchDistance: len3(sub3(tt, it)) };
}

// ---------------------------------------------------------------------------------------------
// Gestures (hand tracking) + generic hysteresis
// ---------------------------------------------------------------------------------------------

/** Pinch (thumb tip <-> index tip) = trigger. Press below ON, release above OFF (meters). */
export const PINCH_ON_M = 0.02;
export const PINCH_OFF_M = 0.035;
/** A pinch only counts while the index isn't fully curled (a fist can bring the tips close). */
export const PINCH_MAX_INDEX_CURL = 0.85;
/** Fist (avg middle/ring/pinky curl) = grip. Press above ON, release below OFF. */
export const FIST_ON = 0.7;
export const FIST_OFF = 0.5;

/** Boolean with hysteresis: turns on above `on`, off below `off` (on > off). */
export function hysteresisAbove(prev: boolean, value: number, on: number, off: number): boolean {
  return prev ? value > off : value > on;
}

/** Boolean with hysteresis: turns on below `on`, off above `off` (on < off). */
export function hysteresisBelow(prev: boolean, value: number, on: number, off: number): boolean {
  return prev ? value < off : value < on;
}

export function fistAmount(curls: FingerCurls): number {
  return (curls[2] + curls[3] + curls[4]) / 3;
}

// ---------------------------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------------------------

/** Minimal GamepadButton shape (so tests don't need the DOM type). */
export interface ButtonLike {
  pressed: boolean;
  touched?: boolean;
  value: number;
}

/** xr-standard gamepad mapping. */
export const XR_BUTTON = { trigger: 0, squeeze: 1, touchpad: 2, stick: 3, a: 4, b: 5, thumbrest: 6 } as const;
export const XR_AXIS = { stickX: 2, stickY: 3 } as const;

/** Index curl when the finger rests on the trigger without pulling it. */
export const CONTROLLER_INDEX_TOUCH_CURL = 0.35;
/** Thumb curl while it rests on a face button / stick / thumbrest. */
export const CONTROLLER_THUMB_REST_CURL = 0.8;

/**
 * Analog value of a button. Uses `value` when the runtime reports one (Quest's `pressed` flips at
 * its own threshold, so it must not override the analog value); digital buttons fall back to 0/1.
 */
export function buttonValue(b: ButtonLike | null | undefined): number {
  if (!b) return 0;
  const v = Number.isFinite(b.value) ? b.value : 0;
  return v > 0 ? clamp(v, 0, 1) : b.pressed ? 1 : 0;
}

function btnTouched(b: ButtonLike | null | undefined): boolean {
  return !!b && (!!b.touched || b.pressed || b.value > 0.02);
}

/**
 * Finger curls approximated from controller buttons:
 *  - index: trigger (untouched = 0 -> pointing, touched = 0.35, pulled -> 1)
 *  - middle/ring/pinky: squeeze value
 *  - thumb: 0.8 when resting on any thumb control (touchpad/stick/A/B/thumbrest), else 0 (thumbs up)
 */
export function controllerCurls(buttons: readonly (ButtonLike | null | undefined)[]): FingerCurls {
  const trig = buttons[XR_BUTTON.trigger];
  const tv = buttonValue(trig);
  const index = btnTouched(trig) ? CONTROLLER_INDEX_TOUCH_CURL + (1 - CONTROLLER_INDEX_TOUCH_CURL) * tv : 0;
  const sq = clamp(buttonValue(buttons[XR_BUTTON.squeeze]), 0, 1);
  let thumbDown = false;
  for (let i = XR_BUTTON.touchpad; i <= XR_BUTTON.thumbrest; i++) {
    if (btnTouched(buttons[i])) thumbDown = true;
  }
  return [thumbDown ? CONTROLLER_THUMB_REST_CURL : 0, clamp(index, 0, 1), sq, sq, sq];
}

/** Radial deadzone: zero inside `dz`, rescaled so the edge of the deadzone maps to 0 and full tilt to 1. */
export function radialDeadzone(x: number, y: number, dz: number): { x: number; y: number } {
  const m = Math.hypot(x, y);
  if (m <= dz || m < 1e-9) return { x: 0, y: 0 };
  const s = Math.min(1, (m - dz) / (1 - dz)) / m;
  return { x: x * s, y: y * s };
}

// ---------------------------------------------------------------------------------------------
// Controller grip space -> canonical wrist pose
// ---------------------------------------------------------------------------------------------
//
// ASSUMPTION (WebXR spec, "gripSpace"): if the hand holds a straight rod, the grip origin is at
// the centroid of the curled fingers, -Z points along the rod toward the THUMB, +X is
// perpendicular to the back of the hand (right hand: back of hand = +X, left hand: back = -X),
// and +Y = Z × X points roughly up the user's ARM (toward the elbow).
//
// So with zero tweaks the canonical hand axes, in grip coordinates, are (right hand):
//   back of hand (+Y_h) = +X_g,  toward forearm (+Z_h) = +Y_g,  X_h = Y_h × Z_h = +Z_g
// i.e. fingers (-Z_h) point along -Y_g, the thumb (-X_h) along -Z_g (the rod's top). The left hand
// is the mirror image (see mirrorQuatX). A real power grip holds the handle diagonally across the
// palm, so the handle's thumb end leans toward the fingertips: GRIP_HAND_TILT rotates the hand
// about the back-of-hand axis to account for that. All numbers below are first guesses for Quest
// Touch controllers and should be tuned in a headset.

/** Radians the fingers lean toward the handle's thumb end (rotation about the back-of-hand axis). */
export const GRIP_HAND_TILT = 0.35;
/** Extra rotation about the hand's lateral axis (+ = fingertips swing toward the back of the hand). */
export const GRIP_HAND_PITCH = 0;
/** Extra roll about the forearm axis (right-hand rule about local +Z, which points toward the forearm). */
export const GRIP_HAND_ROLL = 0;
/**
 * Wrist position relative to the grip origin, in the canonical hand frame of the RIGHT hand
 * (+Y = back of hand, +Z = toward the forearm). The wrist sits ~7.5 cm behind the curled fingers
 * and ~2.5 cm toward the back of the hand (the handle is held in front of the palm).
 * The left hand uses the same offset with x mirrored.
 */
export const GRIP_TO_WRIST_RIGHT: Vec3 = { x: 0, y: 0.025, z: 0.075 };

/** Rotation from grip space to the canonical hand frame (wristRotation = gripRotation * this). */
export function gripToHandRotation(
  handedness: Handedness,
  tilt = GRIP_HAND_TILT,
  pitch = GRIP_HAND_PITCH,
  roll = GRIP_HAND_ROLL,
): Quat {
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  // Right-hand axes in grip coordinates (derived in the comment above, then tilted about Y_h).
  const xh = { x: 0, y: -s, z: c };
  const yh = { x: 1, y: 0, z: 0 };
  const zh = { x: 0, y: c, z: s };
  let q = quatFromBasis(xh, yh, zh);
  if (pitch) q = quatMul(q, quatFromAxisAngle({ x: 1, y: 0, z: 0 }, pitch));
  if (roll) q = quatMul(q, quatFromAxisAngle({ x: 0, y: 0, z: 1 }, roll));
  return handedness === 'right' ? q : mirrorQuatX(q);
}

/** Wrist offset from the grip origin in the hand frame of `handedness`. */
export function gripToWristOffset(handedness: Handedness, right: Vec3 = GRIP_TO_WRIST_RIGHT): Vec3 {
  return handedness === 'right' ? { ...right } : { x: -right.x, y: right.y, z: right.z };
}

/** Canonical wrist pose from a grip pose (any common space). */
export function wristFromGrip(gripPos: Vec3, gripRot: Quat, handedness: Handedness): { position: Vec3; rotation: Quat } {
  const rotation = quatMul(gripRot, gripToHandRotation(handedness));
  const position = add3(gripPos, rotate3(rotation, gripToWristOffset(handedness)));
  return { position, rotation };
}
