import { describe, expect, it } from 'vitest';
import { GaitSelector, readAct, readGait, readPosture, StanceSelector } from './gait';
import { MotionTracker } from './motion';
import { fbm1, hash01, Rng } from './noise';

describe('contract reading', () => {
  it('treats unknown values as defaults', () => {
    expect(readAct('climb')).toBe('climb');
    expect(readAct('dance')).toBe('none');
    expect(readAct(undefined)).toBe('none');
    expect(readGait('sprint')).toBe('still');
    expect(readPosture(3)).toBe('tall');
  });
});

describe('GaitSelector', () => {
  it('infers creep / walk / run from speed when the sim leaves the default, without flicker', () => {
    const g = new GaitSelector();
    const seen: string[] = [];
    // Speed ramps up, then hovers around each threshold with noise.
    for (let i = 0; i < 600; i++) {
      const base = i < 200 ? 0.55 : i < 400 ? 1.0 : 2.6;
      const speed = base + 0.08 * Math.sin(i * 1.7);
      const gait = g.update('still', speed, 'wander', 1 / 60);
      if (seen[seen.length - 1] !== gait) seen.push(gait);
    }
    expect(seen).toEqual(['creep', 'walk', 'run']);
  });

  it('uses the contract gait when the sim sets one', () => {
    const g = new GaitSelector();
    expect(g.update('creep', 1.4, 'investigate', 1 / 60)).toBe('creep');
    expect(g.update('run', 0.5, 'chase', 1 / 60)).toBe('run');
  });

  it('settles to still when it stops', () => {
    const g = new GaitSelector();
    for (let i = 0; i < 60; i++) g.update('walk', 1, 'wander', 1 / 60);
    let gait = 'walk';
    for (let i = 0; i < 60; i++) gait = g.update('walk', 0, 'wander', 1 / 60);
    expect(gait).toBe('still');
  });
});

describe('StanceSelector', () => {
  it('goes on all fours to crawl, to climb, or after running a moment, and holds a change', () => {
    const s = new StanceSelector();
    expect(s.update('crawl', 'creep', 0.5, false, 1 / 60)).toBe(true);
    // Held: a flicker back to tall right away is ignored.
    expect(s.update('tall', 'walk', 1, false, 1 / 60)).toBe(true);
    let q = true;
    for (let i = 0; i < 60; i++) q = s.update('tall', 'walk', 1, false, 1 / 60);
    expect(q).toBe(false);
    for (let i = 0; i < 10; i++) q = s.update('tall', 'run', 3, false, 1 / 60);
    expect(q).toBe(false);
    for (let i = 0; i < 40; i++) q = s.update('tall', 'run', 3, false, 1 / 60);
    expect(q).toBe(true);
  });
});

describe('MotionTracker', () => {
  it('turns 12 Hz snapshots into smooth motion with the right velocity', () => {
    const m = new MotionTracker();
    const dt = 1 / 72;
    let simT = 0;
    let snap = { x: 0, z: 0 };
    let prevVx = 0;
    let maxJerk = 0;
    for (let i = 0; i < 72 * 4; i++) {
      const t = i * dt;
      // Host sends a snapshot every 1/12 s of a body walking +X at 1.2 m/s.
      if (t >= simT) {
        snap = { x: 1.2 * t, z: 0 };
        simT += 1 / 12;
      }
      m.update(snap.x, 0, snap.z, 0, dt);
      if (t > 1.5) {
        expect(Math.abs(m.vel.x - 1.2)).toBeLessThan(0.12);
        expect(Math.abs(m.pos.x - 1.2 * t)).toBeLessThan(0.2);
        maxJerk = Math.max(maxJerk, Math.abs(m.vel.x - prevVx));
      }
      prevVx = m.vel.x;
    }
    // No per-snapshot lurching.
    expect(maxJerk).toBeLessThan(0.08);
  });

  it('snaps on a teleport and settles to rest when it stops', () => {
    const m = new MotionTracker();
    m.update(0, 0, 0, 0, 1 / 60);
    for (let i = 0; i < 60; i++) m.update(i / 60, 0, 0, 0, 1 / 60);
    for (let i = 0; i < 120; i++) m.update(1, 0, 0, 0, 1 / 60);
    expect(m.speed).toBeLessThan(0.02);
    expect(m.stillFor).toBeGreaterThan(0.5);
    expect(m.update(20, 0, 5, 1, 1 / 60)).toBe(true);
    expect(m.pos.x).toBe(20);
  });
});

describe('noise', () => {
  it('is deterministic, bounded and seeded', () => {
    expect(hash01(5, 2)).toBe(hash01(5, 2));
    expect(hash01(5, 2)).not.toBe(hash01(5, 3));
    let lo = 1;
    let hi = -1;
    for (let x = 0; x < 50; x += 0.01) {
      const n = fbm1(x, 4);
      lo = Math.min(lo, n);
      hi = Math.max(hi, n);
    }
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(0.8);
    const a = new Rng(9);
    const b = new Rng(9);
    for (let i = 0; i < 10; i++) expect(a.next()).toBe(b.next());
  });
});
