// Sample authored clip tracks from the monster GLB (no three.js loader needed). Usage:
//   node dev/anim/clip-dump.mjs <Clip> <bone>[,<bone>...] [times...]
// Prints, per bone and time, the local rotation as the angle (deg) from the bind pose and its axis
// in the bone's local frame, plus translation when the bone moves.
import fs from 'fs';
import * as THREE from 'three';

const [clipName = 'Attack', bonesArg = 'hips', ...ts] = process.argv.slice(2);
const times = ts.length ? ts.map(Number) : [0, 0.25, 0.5, 0.75, 1];
const b = fs.readFileSync('public/models/monster.glb');
const len = b.readUInt32LE(12);
const j = JSON.parse(b.subarray(20, 20 + len).toString());
const binStart = 20 + len + 8;
const read = (ai) => {
  const a = j.accessors[ai];
  const bv = j.bufferViews[a.bufferView];
  const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
  const off = binStart + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return { n, data: new Float32Array(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + a.count * n * 4)) };
};
const anim = j.animations.find((a) => a.name === clipName);
const sample = (ch, t) => {
  const s = anim.samplers[ch.sampler];
  const inp = read(s.input).data;
  const out = read(s.output);
  let i = 0;
  while (i < inp.length - 1 && inp[i + 1] < t) i++;
  const k = inp.length > 1 ? Math.min(1, Math.max(0, (t - inp[i]) / (inp[i + 1] - inp[i] || 1))) : 0;
  const i1 = Math.min(i + 1, inp.length - 1);
  if (out.n === 4) {
    const q0 = new THREE.Quaternion().fromArray(out.data, i * 4);
    const q1 = new THREE.Quaternion().fromArray(out.data, i1 * 4);
    return q0.slerp(q1, k);
  }
  return new THREE.Vector3().fromArray(out.data, i * 3).lerp(new THREE.Vector3().fromArray(out.data, i1 * 3), k);
};
for (const name of bonesArg.split(',')) {
  const ni = j.nodes.findIndex((n) => n.name === name);
  const node = j.nodes[ni];
  const bind = new THREE.Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]);
  const bindT = new THREE.Vector3().fromArray(node.translation ?? [0, 0, 0]);
  for (const t of times) {
    let line = `${name} t=${t.toFixed(2)}`;
    for (const ch of anim.channels.filter((c) => c.target.node === ni)) {
      const v = sample(ch, t);
      if (ch.target.path === 'rotation') {
        const d = bind.clone().invert().multiply(v);
        const ang = 2 * Math.acos(Math.min(1, Math.abs(d.w)));
        const ax = new THREE.Vector3(d.x, d.y, d.z).normalize().multiplyScalar(Math.sign(d.w) || 1);
        line += ` rot ${((ang * 180) / Math.PI).toFixed(1)}deg ax(${ax.toArray().map((x) => x.toFixed(2))})`;
      } else if (ch.target.path === 'translation' && v.distanceTo(bindT) > 1e-3) {
        line += ` pos(${v.toArray().map((x) => x.toFixed(3))})`;
      }
    }
    console.log(line);
  }
}
