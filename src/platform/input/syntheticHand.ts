/**
 * Synthetic WebXR-style hand joint positions for a given set of finger curls (pure, no three.js).
 *
 * Used by the unit tests (curl computation, canonical frame) and handy for debug visuals. The hand
 * is built in its own canonical frame (wrist at the origin, fingers along -Z, back of hand +Y,
 * thumb on -X for the right hand / +X for the left) and can be moved anywhere with
 * `transformJoints`.
 */

import type { FingerCurls, Handedness, Quat, Vec3 } from '../../core/types';
import { add3, normalize3, rotate3, scale3 } from '../../core/math';
import { cross3, FINGER_CHAINS, FINGER_NAMES, quatFromAxisAngle, THUMB_CHAIN, type HandJointPositions } from './handMath';

const DEG = Math.PI / 180;

/** Right-hand layout: metacarpal base, knuckle (proximal joint), phalanx lengths. */
const FINGER_LAYOUT: Record<(typeof FINGER_NAMES)[number], { base: Vec3; knuckle: Vec3; lengths: [number, number, number] }> = {
  index: { base: { x: -0.02, y: 0, z: -0.01 }, knuckle: { x: -0.025, y: 0, z: -0.09 }, lengths: [0.045, 0.027, 0.02] },
  middle: { base: { x: 0, y: 0, z: -0.01 }, knuckle: { x: 0, y: 0, z: -0.092 }, lengths: [0.05, 0.03, 0.021] },
  ring: { base: { x: 0.018, y: 0, z: -0.01 }, knuckle: { x: 0.022, y: 0, z: -0.088 }, lengths: [0.046, 0.028, 0.02] },
  pinky: { base: { x: 0.034, y: 0, z: -0.012 }, knuckle: { x: 0.042, y: 0, z: -0.08 }, lengths: [0.036, 0.02, 0.018] },
};
/** Flexion at MCP / PIP / DIP for curl = 1. */
const FULL_FLEX = [90 * DEG, 100 * DEG, 70 * DEG];

const THUMB_CMC: Vec3 = { x: -0.022, y: -0.012, z: -0.018 };
const THUMB_LENGTHS = [0.045, 0.032, 0.026];
const THUMB_DIR_OUT: Vec3 = normalize3({ x: -0.6, y: 0.05, z: -0.8 });
const THUMB_DIR_IN: Vec3 = normalize3({ x: 0.35, y: -0.45, z: -0.82 });
const THUMB_FULL_FLEX = [55 * DEG, 60 * DEG];

/** Joint positions (meters) of a hand with the given curls, in the hand's canonical frame. */
export function syntheticHandJoints(handedness: Handedness, curls: FingerCurls = [0, 0, 0, 0, 0]): HandJointPositions {
  const j: HandJointPositions = { wrist: { x: 0, y: 0, z: 0 } };

  // Long fingers: flexion rotates the bone direction from -Z toward -Y (palm), i.e. about -X.
  const flexAxis: Vec3 = { x: -1, y: 0, z: 0 };
  FINGER_NAMES.forEach((name, fi) => {
    const c = curls[fi + 1];
    const lay = FINGER_LAYOUT[name];
    const chain = FINGER_CHAINS[name];
    j[chain[0]] = { ...lay.base };
    j[chain[1]] = { ...lay.knuckle };
    let dir = normalize3({ x: lay.knuckle.x - lay.base.x, y: lay.knuckle.y - lay.base.y, z: lay.knuckle.z - lay.base.z });
    let p = lay.knuckle;
    for (let b = 0; b < 3; b++) {
      dir = rotate3(quatFromAxisAngle(flexAxis, c * FULL_FLEX[b]), dir);
      p = add3(p, scale3(dir, lay.lengths[b]));
      j[chain[b + 2]] = p;
    }
  });

  // Thumb: the metacarpal swings from "out" (thumbs up / open) to "across the palm", then bends.
  const tc = curls[0];
  let dir = normalize3({
    x: THUMB_DIR_OUT.x + (THUMB_DIR_IN.x - THUMB_DIR_OUT.x) * tc,
    y: THUMB_DIR_OUT.y + (THUMB_DIR_IN.y - THUMB_DIR_OUT.y) * tc,
    z: THUMB_DIR_OUT.z + (THUMB_DIR_IN.z - THUMB_DIR_OUT.z) * tc,
  });
  const bendAxis = normalize3(cross3(dir, { x: 1, y: 0, z: 0 }));
  let p = { ...THUMB_CMC };
  j[THUMB_CHAIN[0]] = p;
  for (let b = 0; b < 3; b++) {
    if (b > 0) dir = rotate3(quatFromAxisAngle(bendAxis, tc * THUMB_FULL_FLEX[b - 1]), dir);
    p = add3(p, scale3(dir, THUMB_LENGTHS[b]));
    j[THUMB_CHAIN[b + 1]] = p;
  }

  if (handedness === 'left') {
    for (const k of Object.keys(j) as (keyof HandJointPositions)[]) {
      const v = j[k]!;
      j[k] = { x: -v.x, y: v.y, z: v.z };
    }
  }
  return j;
}

/** Apply rotation `q` then translation `t` to every joint. */
export function transformJoints(j: HandJointPositions, q: Quat, t: Vec3): HandJointPositions {
  const out: HandJointPositions = {};
  for (const k of Object.keys(j) as (keyof HandJointPositions)[]) out[k] = add3(rotate3(q, j[k]!), t);
  return out;
}
