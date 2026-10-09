import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createLevel } from '../../core/level';
import type { MonsterState } from '../../core/types';
import type { ModelAsset } from './assets';
import { fixtureSkeleton } from './monster/__fixtures__/rig';
import { SkinnedMonster } from './SkinnedMonster';

/** The monster skeleton with a tiny skinned mesh: one triangle rigidly on the left hand. */
function asset(): { asset: ModelAsset; instance: THREE.Group; hand: THREE.Bone } {
  const instance = fixtureSkeleton();
  const bones: THREE.Bone[] = [];
  instance.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
  });
  const hand = bones.find((b) => b.name === 'hand_L')!;
  const hi = bones.indexOf(hand);
  const p = hand.getWorldPosition(new THREE.Vector3());
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([p.x, p.y, p.z, p.x + 0.01, p.y, p.z, p.x, p.y + 0.01, p.z], 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([hi, 0, 0, 0, hi, 0, 0, 0, hi, 0, 0, 0], 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
  instance.add(mesh);
  instance.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  return { asset: { name: 'monster', scene: instance, animations: [], extras: { height: 2.62 } }, instance, hand };
}

const state = (x: number, z: number): MonsterState => ({
  position: { x, y: 0, z }, yaw: -Math.PI / 2, mode: 'wander', target: null, targetPlayer: null, speed: 1, alert: 0.4,
  gait: 'walk', posture: 'tall', act: 'none', actStart: 0, focus: null,
});

describe('SkinnedMonster (procedural body)', () => {
  it('drives a rig with no locomotion clips, follows the sim, and bakes the procedural pose', () => {
    const { asset: a, instance, hand } = asset();
    expect(SkinnedMonster.usable(a)).toBe(true);
    const m = new SkinnedMonster(a, instance);
    m.setLevel(createLevel(1));
    const rest = hand.getWorldPosition(new THREE.Vector3());
    for (let i = 0; i < 90; i++) m.update(state(-9 + i / 60, 0), 1 / 60);
    // It walked there (object follows the smoothed sim position).
    expect(m.object.position.distanceTo(new THREE.Vector3(-9 + 89 / 60, 0, 0))).toBeLessThan(0.3);
    // The hand moved off its bind pose (the procedural pose is on the bones)...
    m.object.updateMatrixWorld(true);
    const posed = hand.getWorldPosition(new THREE.Vector3());
    expect(posed.distanceTo(rest.clone().add(m.object.position))).toBeGreaterThan(0.05);
    // ...and the afterimage bake captures exactly that pose.
    const out: THREE.BufferGeometry[] = [];
    m.bake(out);
    expect(out.length).toBe(1);
    const v = new THREE.Vector3().fromBufferAttribute(out[0].getAttribute('position') as THREE.BufferAttribute, 0);
    expect(v.distanceTo(posed)).toBeLessThan(1e-4);
  });

  it('survives a catch without an Attack clip and returns to the sim', () => {
    const { asset: a, instance } = asset();
    const m = new SkinnedMonster(a, instance);
    m.setLevel(createLevel(1));
    for (let i = 0; i < 10; i++) m.update(state(-9, 0), 1 / 60);
    const target = new THREE.Vector3(-8, 1.6, 0.5);
    m.setCatch(0.4, 'face', target, 0, 0.1, 1);
    m.update(state(-9, 0), 1 / 60);
    expect(new THREE.Vector3().setFromMatrixPosition(m.object.matrixWorld).distanceTo(m.object.position)).toBeLessThan(1e-6);
    m.clearCatch();
    m.update(state(-9, 0), 1 / 60);
    expect(m.object.position.distanceTo(new THREE.Vector3(-9, 0, 0))).toBeLessThan(0.05);
    expect(m.lungeReach).toBeGreaterThan(0);
    expect((m as unknown as { mixer: unknown }).mixer).toBeTruthy();
  });

  it('keeps its charging face outside the prey camera until the catch', () => {
    const { asset: a, instance } = asset();
    const m = new SkinnedMonster(a, instance);
    m.setLevel(createLevel(1));
    const target = { x: 8.6, y: 1.6, z: 0.05 };
    const eye = new THREE.Vector3(target.x, target.y, target.z);
    const jaw = instance.getObjectByName('jaw')!;
    const face = new THREE.Vector3();
    for (let f = 0; f < 80; f++) {
      const x = 1.2 + 3.3 * f / 30;
      if (target.x - x < 0.75) break;
      m.update({ ...state(x, 0.05), mode: 'chase', target, focus: target, gait: 'run', speed: 3.3, alert: 1 }, 1 / 30);
      jaw.localToWorld(face.set(0, 0.05, 0.015));
      expect(face.distanceTo(eye), `camera clearance frame ${f}`).toBeGreaterThanOrEqual(0.649);
    }
  });
});
