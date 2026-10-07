import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { aimFrame, aimQuat, basisQuat, solveTwoBone } from './ik';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('solveTwoBone', () => {
  const root = v(0, 1, 0);
  const mid = new THREE.Vector3();
  const end = new THREE.Vector3();

  it('reaches a reachable target with both bones at their lengths', () => {
    for (const target of [v(0.3, 0.2, -0.4), v(0, 0.2, 0), v(-0.5, 1.2, 0.3), v(0.6, 0.6, 0)]) {
      const ratio = solveTwoBone(root, target, 0.6, 0.55, v(0, 0, -1), mid, end, 0);
      expect(ratio).toBeLessThan(1);
      expect(end.distanceTo(target)).toBeLessThan(1e-6);
      expect(mid.distanceTo(root)).toBeCloseTo(0.6, 6);
      expect(end.distanceTo(mid)).toBeCloseTo(0.55, 6);
    }
  });

  it('bends the middle joint toward the pole', () => {
    const target = v(0, 0.1, 0);
    for (const pole of [v(0, 0, -1), v(1, 0, 0), v(-0.3, 0.2, 0.9)]) {
      solveTwoBone(root, target, 0.6, 0.55, pole, mid, end, 0);
      // Offset of the knee from the root->target line points along the pole's perpendicular part.
      const axis = target.clone().sub(root).normalize();
      const off = mid.clone().sub(root);
      off.addScaledVector(axis, -off.dot(axis));
      const perp = pole.clone().addScaledVector(axis, -pole.dot(axis)).normalize();
      expect(off.normalize().dot(perp)).toBeGreaterThan(0.999);
    }
  });

  it('falls short of an unreachable target along its direction, never past full length', () => {
    const target = v(0, 1, -3);
    const ratio = solveTwoBone(root, target, 0.6, 0.55, v(0, -1, 0), mid, end);
    expect(ratio).toBeGreaterThan(1);
    expect(end.distanceTo(root)).toBeLessThan(1.15);
    expect(end.clone().sub(root).normalize().dot(v(0, 0, -1))).toBeGreaterThan(0.9999);
  });

  it('eases into full extension without a jump (soft limit)', () => {
    let prev = -1;
    let maxStep = 0;
    for (let d = 0.9; d <= 1.4; d += 0.005) {
      solveTwoBone(root, v(0, 1 - d, 0), 0.6, 0.55, v(0, 0, -1), mid, end, 0.04);
      const reach = root.y - end.y;
      if (prev >= 0) maxStep = Math.max(maxStep, Math.abs(reach - prev));
      prev = reach;
    }
    expect(maxStep).toBeLessThan(0.0055);
  });

  it('handles a pole along the chain axis', () => {
    solveTwoBone(root, v(0, 0.2, 0), 0.6, 0.55, v(0, -1, 0), mid, end, 0);
    expect(Number.isFinite(mid.x + mid.y + mid.z)).toBe(true);
    expect(mid.distanceTo(root)).toBeCloseTo(0.6, 6);
  });
});

describe('aim rotations', () => {
  it('basisQuat maps X to the axis and Y toward the reference', () => {
    const q = basisQuat(v(0, 0, -2), v(0, 1, 0.3), new THREE.Quaternion());
    expect(v(1, 0, 0).applyQuaternion(q).distanceTo(v(0, 0, -1))).toBeLessThan(1e-6);
    expect(v(0, 1, 0).applyQuaternion(q).distanceTo(v(0, 1, 0))).toBeLessThan(1e-6);
  });

  it('aimQuat turns a bone so its local aim axis and reference land where asked', () => {
    const frame = aimFrame(v(0, 1, 0), v(0, 0, -1));
    const axis = v(1, -1, 0).normalize();
    const ref = v(0, 0, 1);
    const q = aimQuat(frame, axis, ref, new THREE.Quaternion());
    expect(v(0, 1, 0).applyQuaternion(q).distanceTo(axis)).toBeLessThan(1e-6);
    expect(v(0, 0, -1).applyQuaternion(q).dot(ref)).toBeGreaterThan(0.999);
  });
});
