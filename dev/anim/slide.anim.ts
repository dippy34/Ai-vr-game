// Diagnostics on the shared tour (src/platform/render/monster/__fixtures__/tour.ts): reports
// every frame where a planted foot's ball moves more than 1 cm, with the body's state.
//   npx vitest run --config dev/anim/vitest.anim.config.ts dev/anim/slide.anim.ts
import * as THREE from 'three';
import { test } from 'vitest';
import { createLevel } from '../../src/core/level';
import { fixtureSkeleton } from '../../src/platform/render/monster/__fixtures__/rig';
import { FPS, script, TOUR } from '../../src/platform/render/monster/__fixtures__/tour';
import { ProceduralBody } from '../../src/platform/render/monster/body';
import { MonsterRig } from '../../src/platform/render/monster/rig';
import { MonsterWorld } from '../../src/platform/render/monster/world';

test('slide', () => {
  const world = new MonsterWorld(createLevel(1));
  const rig = MonsterRig.build(fixtureSkeleton())!;
  const body = new ProceduralBody(rig, 7, 1);
  body.setWorld(world);
  type L = { planted: boolean; justLanded: boolean; stretch: number; urge: number; pos: THREE.Vector3 };
  const limbs = (body as unknown as { planner: { limbs: L[] } }).planner.limbs;
  const prev = [new THREE.Vector3(), new THREE.Vector3()];
  const was = [false, false];
  const p = new THREE.Vector3();
  let f = 0;
  let n = 0;
  for (const m of script([-8.5, -0.4], TOUR)) {
    body.update(m, 1 / FPS);
    f++;
    for (let i = 0; i < 2; i++) {
      const l = limbs[i];
      const mp = rig.mp[rig.legs[i].toe];
      const c = Math.cos(body.rootYaw);
      const s = Math.sin(body.rootYaw);
      p.set(body.root.x + mp.x * c + mp.z * s, body.root.y + mp.y, body.root.z - mp.x * s + mp.z * c);
      const d = p.distanceTo(prev[i]);
      if (l.planted && was[i] && !l.justLanded && f > 5 && d > 0.01 && n++ < 40) {
        console.log(
          `f${f} t${(f / FPS).toFixed(2)} leg${i} slide ${d.toFixed(3)} stretch ${l.stretch.toFixed(3)} urge ${l.urge.toFixed(2)}` +
            ` gait ${body.gait} act ${body.act} quad ${body.quad} ballErr ${Math.hypot(p.x - l.pos.x, p.z - l.pos.z).toFixed(3)}` +
            ` y ${p.y.toFixed(3)} tgtY ${l.pos.y.toFixed(2)} root(${body.root.x.toFixed(2)},${body.root.y.toFixed(2)},${body.root.z.toFixed(2)})`,
        );
      }
      prev[i].copy(p);
      was[i] = l.planted;
    }
  }
  console.log(`slides > 1 cm: ${n}`);
});

test('contacts and cost', () => {
  const world = new MonsterWorld(createLevel(1));
  const rig = MonsterRig.build(fixtureSkeleton())!;
  const body = new ProceduralBody(rig, 7, 1);
  body.setWorld(world);
  type L = { planted: boolean; active: boolean; front: boolean; pos: THREE.Vector3; index: number };
  const limbs = (body as unknown as { planner: { limbs: L[] } }).planner.limbs;
  let f = 0;
  let bad = 0;
  const states = [...script([-8.5, -0.4], TOUR)].map((m) => structuredClone(m));
  for (const m of states) {
    body.update(m, 1 / FPS);
    f++;
    for (const l of limbs) {
      if (!l.active || !l.planted) continue;
      if (world.blocked(l.pos.x, l.pos.z, l.pos.y + 0.05) && bad++ < 8) {
        console.log(`f${f} limb${l.index} front ${l.front} at (${l.pos.x.toFixed(3)}, ${l.pos.y.toFixed(2)}, ${l.pos.z.toFixed(3)}) root(${body.root.x.toFixed(2)},${body.root.z.toFixed(2)}) act ${body.act} quad ${body.quad}`);
      }
    }
  }
  const t0 = performance.now();
  for (let r = 0; r < 3; r++) for (const m of states) body.update(m, 1 / FPS);
  console.log(`cost ${((performance.now() - t0) / (3 * states.length)).toFixed(4)} ms/update, bad ${bad}`);
});
