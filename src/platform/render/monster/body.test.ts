import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createLevel } from '../../../core/level';
import { fixtureSkeleton } from './__fixtures__/rig';
import { FPS, script, TOUR } from './__fixtures__/tour';
import { ProceduralBody } from './body';
import { MonsterRig } from './rig';
import { MonsterWorld } from './world';

const level = createLevel(1);
const world = new MonsterWorld(level);

function makeBody(seed = 7): { body: ProceduralBody; rig: MonsterRig } {
  const rig = MonsterRig.build(fixtureSkeleton())!;
  const body = new ProceduralBody(rig, seed, 1);
  body.setWorld(world);
  return { body, rig };
}

const _p = new THREE.Vector3();
/** Rig model-space point -> level space through the body's root. */
function toLevel(body: ProceduralBody, m: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(body.rootYaw);
  const s = Math.sin(body.rootYaw);
  return out.set(body.root.x + m.x * c + m.z * s, body.root.y + m.y, body.root.z - m.x * s + m.z * c);
}

describe('ProceduralBody', () => {
  it('reads the rig by name and measures it', () => {
    const { rig } = makeBody();
    expect(rig.hipHeight).toBeCloseTo(1.265, 2);
    expect(rig.arms[0].lenA + rig.arms[0].lenB).toBeGreaterThan(1.1);
    expect(rig.legs[0].lenA + rig.legs[0].lenB).toBeGreaterThan(1.05);
    expect(MonsterRig.build(new THREE.Group())).toBeNull();
  });

  it('tours the house: finite pose, planted feet never slide, contacts on free ground, head under the lintels', () => {
    const { body, rig } = makeBody();
    const b = body as unknown as { planner: { limbs: { planted: boolean; justLanded: boolean; pos: THREE.Vector3; active: boolean; front: boolean }[] } };
    const prevBall = [new THREE.Vector3(), new THREE.Vector3()];
    const wasPlanted = [false, false];
    let frames = 0;
    let maxSlide = 0;
    let doorFrames = 0;
    for (const m of script([-8.5, -0.4], TOUR)) {
      body.update(m, 1 / FPS);
      frames++;
      for (const q of rig.q) expect(Number.isFinite(q.x + q.y + q.z + q.w)).toBe(true);
      expect(Number.isFinite(rig.hipsPos.x + rig.hipsPos.y + rig.hipsPos.z)).toBe(true);
      // Planted feet: the ball of the foot stays put in the world.
      for (let i = 0; i < 2; i++) {
        const l = b.planner.limbs[i];
        toLevel(body, rig.mp[rig.legs[i].toe], _p);
        if (l.planted && wasPlanted[i] && !l.justLanded && frames > 5) maxSlide = Math.max(maxSlide, _p.distanceTo(prevBall[i]));
        prevBall[i].copy(_p);
        wasPlanted[i] = l.planted;
      }
      // Contacts on free ground (or a furniture top it climbs).
      for (const l of b.planner.limbs) {
        if (!l.active || !l.planted) continue;
        expect(world.blocked(l.pos.x, l.pos.z, l.pos.y + 0.05), `contact at ${l.pos.x.toFixed(3)},${l.pos.y.toFixed(2)},${l.pos.z.toFixed(3)} frame ${frames}`).toBe(false);
      }
      // The skull clears whatever is overhead.
      toLevel(body, rig.mp[rig.head], _p);
      const room = world.headroom(_p.x, _p.z, 0.05);
      if (room < 2.6) doorFrames++;
      expect(_p.y + rig.headTop).toBeLessThan(room + 0.03);
    }
    expect(frames).toBeGreaterThan(1500);
    expect(doorFrames).toBeGreaterThan(10);
    expect(maxSlide).toBeLessThan(0.02);
  });

  it('is deterministic for a seed', () => {
    const a = makeBody(3);
    const c = makeBody(3);
    let n = 0;
    for (const m of script([-8.5, -0.4], TOUR.slice(0, 4))) {
      a.body.update(m, 1 / FPS);
      c.body.update(m, 1 / FPS);
      if (++n % 30 === 0) {
        for (let i = 0; i < a.rig.q.length; i++) {
          const p = a.rig.q[i];
          const q = c.rig.q[i];
          expect(Math.abs(p.x - q.x) + Math.abs(p.y - q.y) + Math.abs(p.z - q.z) + Math.abs(p.w - q.w)).toBeLessThan(1e-12);
        }
      }
    }
  });

  it('is cheap', () => {
    const { body } = makeBody();
    const states = [...script([-8.5, -0.4], TOUR)].map((m) => structuredClone(m));
    for (const m of states.slice(0, 300)) body.update(m, 1 / FPS);
    // Best of three passes (other test files may be running in parallel).
    let ms = Infinity;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      for (const m of states) body.update(m, 1 / FPS);
      ms = Math.min(ms, (performance.now() - t0) / states.length);
    }
    // Desktop target is < 0.3 ms per frame; generous here for busy CI machines.
    expect(ms).toBeLessThan(0.6);
  });
});
