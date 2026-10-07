// Write the monster skeleton's bind pose (bone names, parents, local transforms) as a small JSON
// fixture for unit tests, so they don't need the GLB:
//   node dev/anim/rig-fixture.mjs [public/models/monster.glb]
import fs from 'fs';

const file = process.argv[2] ?? 'public/models/monster.glb';
const b = fs.readFileSync(file);
const len = b.readUInt32LE(12);
const j = JSON.parse(b.subarray(20, 20 + len).toString());
const joints = new Set(j.skins[0].joints);
const parent = new Map();
j.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
const r5 = (a) => a.map((x) => Math.round(x * 1e5) / 1e5);
const bones = [...joints].map((i) => {
  const n = j.nodes[i];
  const p = parent.get(i);
  return {
    name: n.name,
    parent: p !== undefined && joints.has(p) ? j.nodes[p].name : null,
    t: r5(n.translation ?? [0, 0, 0]),
    r: r5(n.rotation ?? [0, 0, 0, 1]),
  };
});
const out = 'src/platform/render/monster/__fixtures__/monster-rig.json';
fs.mkdirSync('src/platform/render/monster/__fixtures__', { recursive: true });
fs.writeFileSync(out, JSON.stringify({ source: 'public/models/monster.glb', bones }) + '\n');
console.log(`${out}: ${bones.length} bones`);
