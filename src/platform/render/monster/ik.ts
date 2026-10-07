/**
 * Analytic two-bone IK and the rotation helpers the monster rig uses to turn solved joint
 * positions into bone orientations. Pure three.js math (no scene objects), allocation-free.
 */

import * as THREE from 'three';

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Solve a two-bone chain (root -> mid -> end) for `target`. The middle joint bends toward `pole`
 * (a direction; only its part perpendicular to root->target matters). Writes the solved middle
 * and end joint positions. A target out of reach is approached softly (no snap to straight):
 * the last `soft` fraction of the reach eases in exponentially. Returns the reach ratio
 * |target - root| / (lenA + lenB) (> 1 means the end fell short of the target).
 */
export function solveTwoBone(
  root: THREE.Vector3,
  target: THREE.Vector3,
  lenA: number,
  lenB: number,
  pole: THREE.Vector3,
  outMid: THREE.Vector3,
  outEnd: THREE.Vector3,
  soft = 0.04,
): number {
  const reach = lenA + lenB;
  _d.subVectors(target, root);
  const dist = _d.length();
  const ratio = dist / reach;
  if (dist < 1e-6) _d.set(0, -1, 0);
  else _d.multiplyScalar(1 / dist);
  // Soft limit: distances past (1 - soft) * reach are compressed so the chain never fully locks.
  const minD = Math.abs(lenA - lenB) + 1e-4;
  const softStart = reach * (1 - soft);
  let d = dist;
  if (soft > 0 && d > softStart) {
    const s = reach * soft;
    d = softStart + s * (1 - Math.exp(-(d - softStart) / s));
  }
  d = Math.min(Math.max(d, minD), reach * 0.99999);
  outEnd.copy(root).addScaledVector(_d, d);
  // Law of cosines for the angle at the root.
  const cosA = THREE.MathUtils.clamp((lenA * lenA + d * d - lenB * lenB) / (2 * lenA * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  // Bend direction: the pole's component perpendicular to the chain axis.
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_p.lengthSq() < 1e-10) {
    // Pole along the axis: any perpendicular will do.
    _p.set(Math.abs(_d.y) < 0.9 ? 0 : 1, Math.abs(_d.y) < 0.9 ? 1 : 0, 0);
    _p.addScaledVector(_d, -_p.dot(_d));
  }
  _p.normalize();
  outMid.copy(root).addScaledVector(_d, cosA * lenA).addScaledVector(_p, sinA * lenA);
  return ratio;
}

/**
 * Orientation whose X axis is `axis` and whose Y axis is `ref` made perpendicular to it (Z
 * completes a right-handed frame). `axis` must be non-zero; a `ref` parallel to it falls back to
 * an arbitrary perpendicular.
 */
export function basisQuat(axis: THREE.Vector3, ref: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _x.copy(axis).normalize();
  _y.copy(ref).addScaledVector(_x, -ref.dot(_x));
  if (_y.lengthSq() < 1e-10) {
    _y.set(Math.abs(_x.y) < 0.9 ? 0 : 1, Math.abs(_x.y) < 0.9 ? 1 : 0, 0);
    _y.addScaledVector(_x, -_y.dot(_x));
  }
  _y.normalize();
  _z.crossVectors(_x, _y);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

/**
 * A bone's frame relation for "aim" solving: in the bone's own (local) frame, `axis` points at
 * its child joint and `ref` is a perpendicular reference (e.g. the direction the knee bends).
 * `inv` is the inverse of basisQuat(axis, ref), precomputed once.
 */
export interface AimFrame {
  readonly axis: THREE.Vector3;
  readonly ref: THREE.Vector3;
  readonly inv: THREE.Quaternion;
}

export function aimFrame(axisLocal: THREE.Vector3, refLocal: THREE.Vector3): AimFrame {
  const axis = axisLocal.clone().normalize();
  const ref = refLocal.clone().addScaledVector(axis, -refLocal.dot(axis));
  if (ref.lengthSq() < 1e-10) ref.set(Math.abs(axis.y) < 0.9 ? 0 : 1, Math.abs(axis.y) < 0.9 ? 1 : 0, 0);
  ref.normalize();
  const inv = basisQuat(axis, ref, new THREE.Quaternion()).invert();
  return { axis, ref, inv };
}

/**
 * The orientation (in the same space as `axis`/`ref`) that turns the bone so its local aim axis
 * points along `axis` and its local reference lies toward `ref`.
 */
export function aimQuat(frame: AimFrame, axis: THREE.Vector3, ref: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  return basisQuat(axis, ref, out).multiply(frame.inv);
}

const _qa = new THREE.Quaternion();

/** Rotate `q` (an orientation) by `angle` around the (unit) axis, applied in the outer frame. */
export function preRotate(q: THREE.Quaternion, axis: THREE.Vector3, angle: number): THREE.Quaternion {
  if (angle === 0) return q;
  return q.premultiply(_qa.setFromAxisAngle(axis, angle));
}

/** Rotate `q` by `angle` around a (unit) axis given in q's own frame. */
export function postRotate(q: THREE.Quaternion, axis: THREE.Vector3, angle: number): THREE.Quaternion {
  if (angle === 0) return q;
  return q.multiply(_qa.setFromAxisAngle(axis, angle));
}
