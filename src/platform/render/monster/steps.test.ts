import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { newStepParams, StepPlanner, type Limb, type StepHost, type StepParams } from './steps';

interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** A body moving at constant velocity / turn rate, with optional boxes contacts must avoid. */
class Host implements StepHost {
  x = 0;
  z = 0;
  vx = 0;
  vz = 0;
  yaw = 0;
  yawRate = 0;
  quad = false;
  boxes: Rect[] = [];

  home(l: Limb, t: number, out: THREE.Vector3): number {
    const yaw = this.yaw + this.yawRate * Math.min(t, 0.5);
    const px = this.x + this.vx * t;
    const pz = this.z + this.vz * t;
    const r = l.side * (l.front ? 0.5 : this.quad ? 0.3 : 0.17);
    const f = l.front ? 0.72 : this.quad ? -0.4 : 0.12;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    out.set(px + c * r - s * f, 0, pz - s * r - c * f);
    return yaw;
  }

  place(_l: Limb, out: THREE.Vector3): void {
    const r = 0.09;
    for (const b of this.boxes) {
      const cx = Math.max(b.minX, Math.min(out.x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(out.z, b.maxZ));
      const dx = out.x - cx;
      const dz = out.z - cz;
      const d = Math.hypot(dx, dz);
      if (d >= r) continue;
      if (d > 1e-9) {
        out.x = cx + (dx / d) * r;
        out.z = cz + (dz / d) * r;
      } else {
        // Inside: leave through the nearest side.
        const e = [out.x - b.minX, b.maxX - out.x, out.z - b.minZ, b.maxZ - out.z];
        const m = Math.min(...e);
        if (m === e[0]) out.x = b.minX - r;
        else if (m === e[1]) out.x = b.maxX + r;
        else if (m === e[2]) out.z = b.minZ - r;
        else out.z = b.maxZ + r;
      }
    }
    out.y = 0;
  }

  clearance(): number {
    return 0;
  }

  advance(dt: number): void {
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.yaw += this.yawRate * dt;
  }
}

const walk = (speed: number): StepParams => ({ ...newStepParams(), swing: 0.5, stance: 0.62, lift: 0.12, minThr: 0.16, minDouble: 0.07, speed });
const quad = (speed: number): StepParams => ({ ...newStepParams(), swing: speed > 1.5 ? 0.24 : 0.55, stance: speed > 1.5 ? 0.24 : 0.9, minThr: 0.14, speed, quad: true, maxSwing: speed > 0.7 ? 2 : 1, yawThr: 0.45 });

interface Lift {
  limb: number;
  time: number;
  len: number;
  dur: number;
}

/** Run a planner; checks no planted limb ever moves. Returns every lift. */
function run(host: Host, planner: StepPlanner, p: StepParams, seconds: number, each?: (t: number) => void): Lift[] {
  const dt = 1 / 60;
  const lifts: Lift[] = [];
  const plantedAt = planner.limbs.map((l) => l.pos.clone());
  const wasPlanted = planner.limbs.map((l) => l.planted);
  for (let i = 0; i < seconds / dt; i++) {
    host.advance(dt);
    planner.update(dt, p, host);
    for (const l of planner.limbs) {
      if (!l.active) continue;
      if (l.planted && wasPlanted[l.index] && !l.justLanded) {
        // No foot sliding: a planted contact stays exactly where it landed.
        expect(l.pos.distanceTo(plantedAt[l.index])).toBeLessThan(1e-9);
      }
      if (l.planted) plantedAt[l.index].copy(l.pos);
      if (!l.planted && wasPlanted[l.index]) lifts.push({ limb: l.index, time: i * dt, len: Math.hypot(l.to.x - l.from.x, l.to.z - l.from.z), dur: l.dur });
      wasPlanted[l.index] = l.planted;
    }
    each?.(i * dt);
  }
  return lifts;
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const std = (a: number[]) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));

describe('StepPlanner (upright)', () => {
  it('walks: one foot at a time, both down between steps, no sliding, keeping up', () => {
    const host = new Host();
    host.vz = -1;
    const pl = new StepPlanner(7);
    pl.reset(host);
    const p = walk(1);
    const tmp = new THREE.Vector3();
    let maxErr = 0;
    const lifts = run(host, pl, p, 12, (t) => {
      const [a, b] = pl.limbs;
      expect(a.planted || b.planted).toBe(true);
      if (t > 1) {
        for (const l of [a, b]) {
          host.home(l, 0, tmp);
          maxErr = Math.max(maxErr, Math.hypot(l.cur.x - tmp.x, l.cur.z - tmp.z));
        }
      }
    });
    expect(maxErr).toBeLessThan(0.75);
    // Steps alternate legs.
    for (let i = 1; i < lifts.length; i++) expect(lifts[i].limb).not.toBe(lifts[i - 1].limb);
    // It covered the ground: per leg, the step lengths add up to the distance walked.
    const left = lifts.filter((l) => l.limb === 0).reduce((s, l) => s + l.len, 0);
    expect(left).toBeGreaterThan(12 * 0.8);
    expect(left).toBeLessThan(12 * 1.2);
  });

  it('never repeats a step: lengths, durations and timing all vary', () => {
    const host = new Host();
    host.vx = 1;
    const pl = new StepPlanner(3);
    pl.reset(host);
    const lifts = run(host, pl, walk(1), 15).slice(4);
    const lens = lifts.map((l) => l.len);
    const durs = lifts.map((l) => l.dur);
    const gaps = lifts.slice(1).map((l, i) => l.time - lifts[i].time);
    expect(std(lens) / mean(lens)).toBeGreaterThan(0.04);
    expect(std(durs) / mean(durs)).toBeGreaterThan(0.05);
    expect(std(gaps)).toBeGreaterThan(0.02);
    expect(new Set(durs.map((d) => d.toFixed(4))).size).toBe(durs.length);
  });

  it('is deterministic per seed and different across seeds', () => {
    const go = (seed: number) => {
      const host = new Host();
      host.vz = -0.8;
      const pl = new StepPlanner(seed);
      pl.reset(host);
      return run(host, pl, walk(0.8), 5).map((l) => l.len.toFixed(6)).join();
    };
    expect(go(11)).toBe(go(11));
    expect(go(11)).not.toBe(go(12));
  });

  it('turns in place with shuffling steps', () => {
    const host = new Host();
    const pl = new StepPlanner(5);
    pl.reset(host);
    const p = walk(0);
    host.yawRate = 2;
    // Shuffling, never hopping: one foot is always down.
    const lifts = run(host, pl, p, 1.6, () => expect(pl.limbs[0].planted || pl.limbs[1].planted).toBe(true));
    host.yawRate = 0;
    run(host, pl, p, 2);
    expect(lifts.length).toBeGreaterThanOrEqual(3);
    for (const l of pl.limbs.slice(0, 2)) {
      expect(Math.abs(Math.atan2(Math.sin(l.yaw - host.yaw), Math.cos(l.yaw - host.yaw)))).toBeLessThan(0.5);
    }
  });

  it('never lands a foot inside an obstacle beside its path', () => {
    const host = new Host();
    host.vx = 1;
    const box = { minX: 3, minZ: -0.6, maxX: 4, maxZ: 0.1 };
    host.boxes.push(box);
    const pl = new StepPlanner(9);
    pl.reset(host);
    run(host, pl, walk(1), 8, () => {
      for (const l of pl.limbs.slice(0, 2)) {
        if (!l.planted) continue;
        const inside = l.pos.x > box.minX - 0.085 && l.pos.x < box.maxX + 0.085 && l.pos.z > box.minZ - 0.085 && l.pos.z < box.maxZ + 0.085;
        const cx = Math.max(box.minX, Math.min(l.pos.x, box.maxX));
        const cz = Math.max(box.minZ, Math.min(l.pos.z, box.maxZ));
        if (inside) expect(Math.hypot(l.pos.x - cx, l.pos.z - cz)).toBeGreaterThan(0.085);
      }
    });
  });
});

describe('StepPlanner (all fours)', () => {
  for (const speed of [0.4, 0.9, 2.6]) {
    it(`never lifts both limbs of a side, or both front / both hind limbs (${speed} m/s)`, () => {
      const host = new Host();
      host.quad = true;
      host.vz = -speed;
      host.yawRate = 0.3;
      const pl = new StepPlanner(13);
      for (const l of pl.limbs) l.active = true;
      pl.reset(host);
      const p = quad(speed);
      let steps = 0;
      run(host, pl, p, 8, () => {
        const air = pl.limbs.filter((l) => !l.planted);
        expect(air.length).toBeLessThanOrEqual(p.maxSwing);
        for (const a of air) {
          for (const b of air) {
            if (a === b) continue;
            expect(a.side === b.side).toBe(false);
            expect(a.front === b.front).toBe(false);
          }
        }
        steps += air.length;
      });
      expect(steps).toBeGreaterThan(0);
    });
  }
});
