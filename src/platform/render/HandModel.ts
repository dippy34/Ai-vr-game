/**
 * Procedural hand: palm + 5 fingers x 3 phalanges, drawn as ONE InstancedMesh of capsules (one draw
 * call per hand), driven by a HandPose in the canonical hand frame (see core/types):
 *   origin = wrist, -Z toward the fingertips, +Y out of the back of the hand,
 *   thumb on -X for the right hand and +X for the left hand.
 *
 * Finger curl 0..1 bends the three joints of a finger (MCP, PIP, DIP) toward the palm (-Y). The
 * thumb sits on its own rolled axis so its curl folds it across the palm.
 */

import * as THREE from 'three';
import type { Handedness, HandPose } from '../../core/types';
import { positionNormalOnly, setQ, setV, unitCapsuleLo } from './util';

interface PartSpec {
  /** Center (right hand), meters. */
  p: [number, number, number];
  /** Euler 'YXZ' (pitch, yaw, roll) for right hand. */
  r: [number, number, number];
  /** Full extents (width x, thickness y, length z). */
  s: [number, number, number];
}

interface FingerSpec {
  base: [number, number, number];
  /** Rest orientation (pitch, yaw, roll), right hand. */
  rest: [number, number, number];
  /** Extra (pitch, yaw) applied at full curl (thumb opposition). */
  curlBase: [number, number];
  len: [number, number, number];
  radius: number;
  /** Joint flexion at curl = 1 (radians). */
  flex: [number, number, number];
}

const D = THREE.MathUtils.degToRad;

/** Static palm parts (right hand). Overlapping capsules give an organic, squarish palm. */
const PALM: PartSpec[] = [
  { p: [0, 0.0, 0.026], r: [0, 0, 0], s: [0.058, 0.036, 0.07] }, // wrist / forearm stub
  { p: [-0.017, 0.001, -0.05], r: [0, 0.03, 0], s: [0.05, 0.031, 0.1] }, // radial half
  { p: [0.016, 0.0, -0.048], r: [0, -0.04, 0], s: [0.047, 0.029, 0.094] }, // ulnar half
  { p: [0.0, 0.002, -0.086], r: [0, Math.PI / 2, 0], s: [0.026, 0.026, 0.084] }, // knuckle line
  { p: [-0.024, -0.009, -0.03], r: [0, 0.55, 0], s: [0.032, 0.03, 0.062] }, // thenar (thumb pad)
];

const FINGERS: FingerSpec[] = [
  // Thumb: rolled so its flexion folds across the palm toward the pinky side.
  { base: [-0.026, -0.012, -0.014], rest: [-0.22, 0.68, 0.95], curlBase: [-0.2, -0.42], len: [0.044, 0.032, 0.027], radius: 0.0118, flex: [D(18), D(42), D(55)] },
  { base: [-0.027, 0.002, -0.092], rest: [0, 0.07, 0], curlBase: [0, 0], len: [0.043, 0.025, 0.021], radius: 0.0094, flex: [D(78), D(95), D(58)] },
  { base: [-0.009, 0.003, -0.097], rest: [0, 0.0, 0], curlBase: [0, 0], len: [0.047, 0.029, 0.022], radius: 0.0097, flex: [D(80), D(95), D(58)] },
  { base: [0.0095, 0.002, -0.094], rest: [0, -0.05, 0], curlBase: [0, 0], len: [0.044, 0.027, 0.021], radius: 0.0092, flex: [D(82), D(95), D(58)] },
  { base: [0.0265, 0.0, -0.085], rest: [0, -0.13, 0], curlBase: [0, 0], len: [0.034, 0.021, 0.019], radius: 0.0082, flex: [D(85), D(95), D(58)] },
];

export const HAND_PART_COUNT = PALM.length + FINGERS.length * 3;

const _cursor = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _s = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _sc = new THREE.Vector3();

/** Fill `out` (HAND_PART_COUNT matrices) with part matrices relative to the wrist frame. */
export function computeHandParts(hand: Handedness, curls: ArrayLike<number>, out: THREE.Matrix4[]): void {
  const mx = hand === 'left' ? -1 : 1;
  let k = 0;
  for (const part of PALM) {
    _e.set(part.r[0], part.r[1] * mx, part.r[2] * mx, 'YXZ');
    _q.setFromEuler(_e);
    out[k++].compose(_p.set(part.p[0] * mx, part.p[1], part.p[2]), _q, _sc.set(part.s[0], part.s[1], part.s[2] / 2));
  }
  for (let f = 0; f < FINGERS.length; f++) {
    const spec = FINGERS[f];
    const c = Math.min(1, Math.max(0, curls[f] ?? 0));
    _e.set(spec.rest[0] + spec.curlBase[0] * c, (spec.rest[1] + spec.curlBase[1] * c) * mx, spec.rest[2] * mx, 'YXZ');
    _q.setFromEuler(_e);
    _cursor.compose(_p.set(spec.base[0] * mx, spec.base[1], spec.base[2]), _q, _sc.set(1, 1, 1));
    for (let j = 0; j < 3; j++) {
      _cursor.multiply(_r.makeRotationX(-spec.flex[j] * c));
      const L = spec.len[j];
      const rad = spec.radius * (j === 2 ? 0.88 : j === 1 ? 0.95 : 1) * (f === 0 && j === 0 ? 1.18 : 1);
      out[k++]
        .copy(_cursor)
        .multiply(_t.makeTranslation(0, 0, -L / 2))
        .multiply(_s.makeScale(rad * 2, rad * 1.8, (L * 1.16) / 2));
      _cursor.multiply(_t.makeTranslation(0, 0, -L));
    }
  }
}

export class HandModel {
  readonly mesh: THREE.InstancedMesh;
  readonly handedness: Handedness;
  /** Current wrist transform (world) and curls. */
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly curls: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  private readonly parts: THREE.Matrix4[] = [];
  private readonly root = new THREE.Matrix4();
  private readonly tmp = new THREE.Matrix4();

  constructor(handedness: Handedness, material: THREE.Material) {
    this.handedness = handedness;
    this.mesh = new THREE.InstancedMesh(unitCapsuleLo(), material, HAND_PART_COUNT);
    this.mesh.name = `hand-${handedness}`;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    for (let i = 0; i < HAND_PART_COUNT; i++) this.parts.push(new THREE.Matrix4());
    this.refresh();
  }

  get visible(): boolean { return this.mesh.visible; }
  set visible(v: boolean) { this.mesh.visible = v; }

  setMaterial(m: THREE.Material): void {
    this.mesh.material = m;
  }

  /** Apply a canonical HandPose (hides the hand when not tracked). */
  setPose(pose: HandPose): void {
    this.mesh.visible = pose.tracked;
    if (!pose.tracked) return;
    setV(this.position, pose.position);
    setQ(this.quaternion, pose.rotation);
    for (let i = 0; i < 5; i++) this.curls[i] = pose.curls[i];
    this.refresh();
  }

  /** Apply wrist transform + curls directly (used for smoothed remote hands). */
  setTransform(position: THREE.Vector3, quaternion: THREE.Quaternion, curls: ArrayLike<number>): void {
    this.position.copy(position);
    this.quaternion.copy(quaternion);
    for (let i = 0; i < 5; i++) this.curls[i] = curls[i];
    this.refresh();
  }

  private refresh(): void {
    computeHandParts(this.handedness, this.curls, this.parts);
    this.root.compose(this.position, this.quaternion, _sc.set(1, 1, 1));
    for (let i = 0; i < HAND_PART_COUNT; i++) {
      this.mesh.setMatrixAt(i, this.tmp.multiplyMatrices(this.root, this.parts[i]));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** World matrix of a point given in the hand frame (e.g. where a held item sits). */
  frameMatrix(out: THREE.Matrix4): THREE.Matrix4 {
    return out.compose(this.position, this.quaternion, _sc.set(1, 1, 1));
  }

  /** Append world-space copies of the current pose (position + normal only) for afterimages. */
  bake(out: THREE.BufferGeometry[]): void {
    HandModel.bakePose(this.handedness, this.position, this.quaternion, this.curls, out);
  }

  /** Bake any pose without needing a HandModel instance. */
  static bakePose(
    hand: Handedness,
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
    curls: ArrayLike<number>,
    out: THREE.BufferGeometry[],
    inflate = 1,
  ): void {
    const parts: THREE.Matrix4[] = [];
    for (let i = 0; i < HAND_PART_COUNT; i++) parts.push(new THREE.Matrix4());
    computeHandParts(hand, curls, parts);
    const root = new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));
    const infl = new THREE.Matrix4().makeScale(inflate, inflate, inflate);
    const base = unitCapsuleLo();
    for (const p of parts) {
      const g = positionNormalOnly(base.clone());
      const m = new THREE.Matrix4().multiplyMatrices(root, p);
      if (inflate !== 1) m.multiply(infl);
      g.applyMatrix4(m);
      out.push(g);
    }
  }

  dispose(): void {
    this.mesh.dispose();
  }
}
