/**
 * Headless probe of the procedural body: the real rig (bones read from public/models/monster.glb,
 * no textures) on the real level, driven by a scene from dev/anim/scenes.cjs. Prints the body's
 * internal state every N frames and times update(). Run:
 *   SCENE=walk EVERY=15 npx vitest run --config dev/anim/vitest.anim.config.ts
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as THREE from 'three';
import { test } from 'vitest';
import { createLevel } from '../../src/core/level';
import type { MonsterState } from '../../src/core/types';
import { ProceduralBody } from '../../src/platform/render/monster/body';
import { MonsterRig } from '../../src/platform/render/monster/rig';
import { MonsterWorld } from '../../src/platform/render/monster/world';

const require = createRequire(import.meta.url);
const scenes = require('./scenes.cjs') as Record<string, { frames: number; frame(f: number): { mon: Record<string, unknown> } }>;

/** The GLB's node hierarchy as three.js objects (bones are Bones). */
export function loadRig(file = 'public/models/monster.glb'): THREE.Object3D {
  const b = fs.readFileSync(file);
  const len = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + len).toString());
  const joints = new Set<number>(j.skins[0].joints);
  const objs = j.nodes.map((n: { name: string; translation?: number[]; rotation?: number[]; scale?: number[] }, i: number) => {
    const o = joints.has(i) ? new THREE.Bone() : new THREE.Object3D();
    o.name = n.name;
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  j.nodes.forEach((n: { children?: number[] }, i: number) => (n.children ?? []).forEach((c) => objs[i].add(objs[c])));
  const scene = new THREE.Group();
  for (const i of j.scenes[0].nodes) scene.add(objs[i]);
  return scene;
}

const D = Math.PI / 180;

test('probe', () => {
  const name = process.env.SCENE ?? 'walk';
  const every = Number(process.env.EVERY ?? 15);
  const scene = scenes[name];
  const inst = loadRig();
  const rig = MonsterRig.build(inst)!;
  const body = new ProceduralBody(rig, 0x6d6f6e, 1);
  const level = createLevel(1);
  body.setWorld(new MonsterWorld(level));
  const m: MonsterState = {
    position: { x: 0, y: 0, z: 0 }, yaw: 0, mode: 'wander', target: null, targetPlayer: null, speed: 0, alert: 0,
    gait: 'still', posture: 'tall', act: 'none', actStart: 0, focus: null,
  };
  const times: number[] = [];
  const v = new THREE.Vector3();
  const b = body as unknown as Record<string, unknown>;
  for (let f = 0; f < scene.frames; f++) {
    const c = scene.frame(f).mon as Record<string, number & string>;
    m.position = { x: c.x, y: c.y ?? 0, z: c.z };
    m.yaw = c.yaw * D;
    m.speed = c.speed;
    m.mode = c.mode;
    m.alert = c.alert;
    m.gait = c.gait;
    m.posture = c.posture;
    if (c.act !== m.act) m.actStart = f / 30;
    m.act = c.act;
    m.focus = (c.focus as unknown as MonsterState['focus']) ?? null;
    const t0 = performance.now();
    body.update(m, 1 / 30);
    times.push(performance.now() - t0);
    if (f % every === 0) {
      const hips = rig.mp[rig.hips];
      const head = rig.mp[rig.head];
      const L = (body as unknown as { planner: { limbs: { planted: boolean; stretch: number; urge: number; active: boolean }[] } }).planner.limbs;
      const arms = b.arms as { goal: { kind: string }; mode: number; stretch: number }[];
      v.copy(rig.mp[rig.arms[0].hand]);
      console.log(
        `f${f} t${(f / 30).toFixed(1)} pos(${c.x.toFixed(2)},${c.z.toFixed(2)}) gait=${body.gait} act=${body.act} quad=${body.quad}` +
          ` hips(${hips.x.toFixed(2)},${hips.y.toFixed(2)},${hips.z.toFixed(2)}) head(${head.y.toFixed(2)},${head.z.toFixed(2)})` +
          ` door=${(b.door as { id: number }).id}/${(b.doorK as number).toFixed(2)} lean=${(b.lean as { x: number }).x.toFixed(2)}` +
          ` hunch=${(b.hunch as { x: number }).x.toFixed(2)} duck=${Array.from(b.duckSeg as Float32Array).map((x) => x.toFixed(2)).join('/')}` +
          ` legs=${L.slice(0, 2).map((l) => `${l.planted ? 'P' : 'S'}${l.stretch.toFixed(2)}`).join(',')}` +
          ` arms=${arms.map((a) => `${a.goal.kind}:${a.mode}:${a.stretch.toFixed(2)}`).join(',')}`,
      );
    }
  }
  const s = times.slice(30).sort((x, y) => x - y);
  console.log(`update ms: median ${s[s.length >> 1].toFixed(4)} p95 ${s[Math.floor(s.length * 0.95)].toFixed(4)} max ${s[s.length - 1].toFixed(4)}`);
  // Steady-state cost: re-run the scene a few times to let the JIT settle.
  const t0 = performance.now();
  let n = 0;
  for (let rep = 0; rep < 5; rep++) {
    for (let f = 0; f < scene.frames; f++) {
      const c = scene.frame(f).mon as Record<string, number & string>;
      m.position = { x: c.x, y: c.y ?? 0, z: c.z };
      m.yaw = c.yaw * D;
      body.update(m, 1 / 30);
      n++;
    }
  }
  console.log(`steady: ${((performance.now() - t0) / n).toFixed(4)} ms/update over ${n} updates`);
});
