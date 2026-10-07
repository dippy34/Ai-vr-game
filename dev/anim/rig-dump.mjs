// Dump the monster rig (bind pose): node name, world position, local axes. Usage:
//   node dev/anim/rig-dump.mjs [public/models/monster.glb] [--fingers]
import fs from 'fs';
import * as THREE from 'three';

const file = process.argv.find((a) => a.endsWith('.glb')) ?? 'public/models/monster.glb';
const fingers = process.argv.includes('--fingers');
const b = fs.readFileSync(file);
const len = b.readUInt32LE(12);
const j = JSON.parse(b.subarray(20, 20 + len).toString());
const objs = j.nodes.map((n) => {
  const o = new THREE.Object3D();
  o.name = n.name;
  if (n.translation) o.position.fromArray(n.translation);
  if (n.rotation) o.quaternion.fromArray(n.rotation);
  if (n.scale) o.scale.fromArray(n.scale);
  return o;
});
j.nodes.forEach((n, i) => (n.children || []).forEach((c) => objs[i].add(objs[c])));
const root = objs[j.scenes[0].nodes[0]];
root.updateMatrixWorld(true);
const v = new THREE.Vector3();
const q = new THREE.Quaternion();
const f = (a) => a.toArray().map((x) => x.toFixed(3)).join(',');
const show = (o, d) => {
  if (fingers || !/_(2|3)$/.test(o.name) || !/thumb|index|middle|ring|pinky/.test(o.name)) {
    o.getWorldPosition(v);
    o.getWorldQuaternion(q);
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    console.log(`${' '.repeat(d)}${o.name} w=(${f(v)}) X=(${f(x)}) Y=(${f(y)}) s=${o.scale.x.toFixed(2)}`);
  }
  o.children.forEach((c) => show(c, d + 1));
};
show(root, 0);
console.log('skin joints', j.skins[0].joints.length);
for (const a of j.animations) {
  const acc = j.accessors[a.samplers[0].input];
  console.log('anim', a.name, 'dur', acc.max?.[0]);
}
