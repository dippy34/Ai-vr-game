/**
 * Desktop hand-sign presets (keys 1–6) and the synthesized desktop hand layout.
 *
 * Pure data + math (no three.js / DOM) so the table can be shown in UI help text and unit tested.
 * Poses are given in CAMERA-LOCAL space (x right, y up, -z forward, meters); the InputManager puts
 * them into world space with the camera's world transform. Rotations are built with
 * `frameFromFingersBack`, so they're already in the canonical hand frame (see HandPose).
 */

import type { FingerCurls, Handedness, Quat, Vec3 } from '../../core/types';
import { frameFromFingersBack } from './handMath';

export type SignId = 'point' | 'stop' | 'thumbsUp' | 'fist' | 'three' | 'comeHere';

export interface SignPreset {
  id: SignId;
  /** The key the player presses ('1'..'6'). */
  key: string;
  /** KeyboardEvent.code for that key ('Digit1'..). The numpad equivalent also works. */
  code: string;
  /** Short label for UI help text. */
  name: string;
  /** One-line description for UI help text. */
  description: string;
  /** [thumb, index, middle, ring, pinky], 0 = straight, 1 = curled. For animated signs: the base pose. */
  curls: FingerCurls;
  /** True when the curls animate over time (see signCurlsAt). */
  animated: boolean;
  /** Right-hand wrist position, camera-local. */
  position: Vec3;
  /** Direction the fingers extend (canonical local -Z), camera-local. */
  fingers: Vec3;
  /** Direction the back of the hand faces (canonical local +Y), camera-local. */
  back: Vec3;
}

/** A sign stays up at least this long after a key tap (seconds). Holding the key keeps it up. */
export const SIGN_MIN_SECONDS = 1.5;
/** "Come here" finger wave frequency (Hz). */
export const COME_HERE_HZ = 1.4;

// Hand raised in front of the face: wrist ~0.4 m ahead, a little right and below eye level, so the
// fingers (pointing up) end up right in front of the face.
const RAISED: Vec3 = { x: 0.1, y: -0.14, z: -0.4 };

export const SIGN_PRESETS: readonly SignPreset[] = [
  {
    id: 'point',
    key: '1',
    code: 'Digit1',
    name: 'Point',
    description: 'Index finger points where you are looking ("it\'s there", "go that way").',
    curls: [0.75, 0, 1, 1, 1],
    animated: false,
    position: { x: 0.12, y: -0.1, z: -0.3 },
    fingers: { x: -0.05, y: 0.12, z: -1 },
    back: { x: 0.6, y: 0.8, z: 0 },
  },
  {
    id: 'stop',
    key: '2',
    code: 'Digit2',
    name: 'Stop',
    description: 'Open palm facing forward, fingers up ("stop", "wait", "freeze").',
    curls: [0.05, 0, 0, 0, 0],
    animated: false,
    position: RAISED,
    fingers: { x: 0, y: 1, z: 0.08 },
    back: { x: 0, y: 0, z: 1 },
  },
  {
    id: 'thumbsUp',
    key: '3',
    code: 'Digit3',
    name: 'Thumbs up',
    description: 'Fist with the thumb pointing up ("OK", "yes", "got it").',
    curls: [0, 1, 1, 1, 1],
    animated: false,
    position: { x: 0.12, y: -0.12, z: -0.36 },
    fingers: { x: -0.1, y: 0, z: -1 },
    back: { x: 1, y: 0, z: 0 },
  },
  {
    id: 'fist',
    key: '4',
    code: 'Digit4',
    name: 'Fist',
    description: 'Raised closed fist ("hold", "danger", "it\'s coming").',
    curls: [0.8, 1, 1, 1, 1],
    animated: false,
    position: RAISED,
    fingers: { x: 0, y: 1, z: 0.08 },
    back: { x: 0, y: 0, z: 1 },
  },
  {
    id: 'three',
    key: '5',
    code: 'Digit5',
    name: 'Three',
    description: 'Index, middle and ring fingers up: count three ("3 fuses left").',
    curls: [0.9, 0, 0, 0, 1],
    animated: false,
    position: RAISED,
    fingers: { x: 0, y: 1, z: 0.08 },
    back: { x: 0, y: 0, z: 1 },
  },
  {
    id: 'comeHere',
    key: '6',
    code: 'Digit6',
    name: 'Come here',
    description: 'Palm up, fingers curling and uncurling ("come here", "follow me").',
    curls: [0.3, 0.15, 0.15, 0.15, 0.15],
    animated: true,
    position: { x: 0.12, y: -0.16, z: -0.32 },
    fingers: { x: 0, y: 0.1, z: -1 },
    back: { x: 0, y: -1, z: 0 },
  },
];

/** Find a preset by KeyboardEvent.code ('Digit1'..'Digit6' or 'Numpad1'..'Numpad6'). */
export function signForCode(code: string): SignPreset | null {
  const c = code.startsWith('Numpad') ? `Digit${code.slice(6)}` : code;
  return SIGN_PRESETS.find((p) => p.code === c) ?? null;
}

/** Curls for a preset `t` seconds after it started (animates "come here"). */
export function signCurlsAt(preset: SignPreset, t: number): FingerCurls {
  if (preset.id !== 'comeHere') return [...preset.curls] as FingerCurls;
  // 0 -> 1 -> 0 wave starting open; fingers lag slightly from index to pinky for a natural wave.
  const c: number[] = [preset.curls[0]];
  for (let i = 1; i < 5; i++) {
    const phase = 2 * Math.PI * COME_HERE_HZ * t - (i - 1) * 0.25;
    const w = 0.5 - 0.5 * Math.cos(Math.max(0, phase));
    c.push(0.15 + 0.75 * w);
  }
  return c as FingerCurls;
}

/** A hand pose in camera-local space. */
export interface LocalHandPose {
  position: Vec3;
  rotation: Quat;
  curls: FingerCurls;
}

/** Relaxed finger curls for resting desktop hands. */
export const REST_CURLS: FingerCurls = [0.3, 0.3, 0.3, 0.3, 0.3];

/**
 * Resting desktop hands: lower-right / lower-left of the view, fingers forward, back of hand up
 * and slightly outward. Right-hand values; the left hand is mirrored (x -> -x).
 */
export const REST_POSE_RIGHT = {
  position: { x: 0.17, y: -0.2, z: -0.32 } as Vec3,
  fingers: { x: -0.15, y: 0.1, z: -1 } as Vec3,
  back: { x: 0.35, y: 1, z: 0 } as Vec3,
};

const mirrorX = (v: Vec3): Vec3 => ({ x: -v.x, y: v.y, z: v.z });

/** Target camera-local pose for a desktop hand: a sign (right hand only) or the resting pose. */
export function desktopHandTarget(hand: Handedness, sign: SignPreset | null, signTime: number): LocalHandPose {
  if (hand === 'right' && sign) {
    return {
      position: { ...sign.position },
      rotation: frameFromFingersBack(sign.fingers, sign.back),
      curls: signCurlsAt(sign, signTime),
    };
  }
  const r = REST_POSE_RIGHT;
  const m = hand === 'right' ? (v: Vec3) => ({ ...v }) : mirrorX;
  return {
    position: m(r.position),
    rotation: frameFromFingersBack(m(r.fingers), m(r.back)),
    curls: [...REST_CURLS] as FingerCurls,
  };
}
