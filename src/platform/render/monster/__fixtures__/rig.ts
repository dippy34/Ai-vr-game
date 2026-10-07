/** Test helper: the monster skeleton (bind pose from monster-rig.json) as three.js Bones. */

import * as THREE from 'three';
import data from './monster-rig.json';

interface BoneData {
  name: string;
  parent: string | null;
  t: number[];
  r: number[];
}

/** A Group holding the bone hierarchy, like a loaded GLB instance (no mesh). */
export function fixtureSkeleton(): THREE.Group {
  const root = new THREE.Group();
  const byName = new Map<string, THREE.Bone>();
  for (const b of data.bones as BoneData[]) {
    const bone = new THREE.Bone();
    bone.name = b.name;
    bone.position.fromArray(b.t);
    bone.quaternion.fromArray(b.r);
    byName.set(b.name, bone);
  }
  for (const b of data.bones as BoneData[]) {
    const bone = byName.get(b.name)!;
    const p = b.parent ? byName.get(b.parent) : undefined;
    (p ?? root).add(bone);
  }
  root.updateMatrixWorld(true);
  return root;
}
