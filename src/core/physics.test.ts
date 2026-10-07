import { describe, expect, it } from 'vitest';
import { createLevel } from './level';
import { v3 } from './math';
import {
  circleBlocked,
  moveCircle,
  pushOut,
  segmentClear,
  supportHeight,
  wallsBetween,
} from './physics';
import type { Box, LevelData } from './types';

const wall = (x0: number, z0: number, x1: number, z1: number, y0 = 0): Box => ({
  kind: 'wall',
  min: v3(x0, y0, z0),
  max: v3(x1, 2.8, z1),
});

/** Minimal synthetic level: the given boxes plus a far-away exit door. */
function testLevel(boxes: Box[]): LevelData {
  return {
    id: 'test',
    seed: 1,
    bounds: { min: v3(-50, 0, -50), max: v3(50, 3, 50) },
    boxes,
    nav: [],
    playerSpawns: [],
    monsterSpawn: v3(),
    fuseSpawns: [],
    fuseBox: { position: v3(), yaw: 0 },
    exit: { door: wall(40, 40, 41, 41), zone: { min: v3(40, 0, 42), max: v3(41, 3, 43) } },
    windows: [],
  };
}

describe('moveCircle', () => {
  // A thin wall along Z at x in [1, 1.2].
  const L = testLevel([wall(1, -5, 1.2, 5)]);
  const r = 0.25;

  it('moves freely in open space and carries Y through', () => {
    const p = moveCircle(L, v3(-3, 1.6, 0), v3(0.5, 0.1, -0.5), r);
    expect(p.x).toBeCloseTo(-2.5);
    expect(p.y).toBeCloseTo(1.7);
    expect(p.z).toBeCloseTo(-0.5);
  });

  it('stops at the wall face', () => {
    const p = moveCircle(L, v3(0, 0, 0), v3(2, 0, 0), r);
    expect(p.x).toBeCloseTo(1 - r, 4);
    expect(p.x).toBeLessThanOrEqual(1 - r + 1e-4);
  });

  it('slides along the wall when moving diagonally', () => {
    const p = moveCircle(L, v3(0.5, 0, 0), v3(1, 0, 1), r);
    expect(p.x).toBeCloseTo(1 - r, 4);
    expect(p.z).toBeCloseTo(1, 4);
  });

  it('never tunnels: 4 m/s at 30 fps and one huge step', () => {
    let p = v3(0, 0, 0);
    for (let i = 0; i < 90; i++) p = moveCircle(L, p, v3(4 / 30, 0, 0.01), r);
    expect(p.x).toBeLessThan(1);
    const big = moveCircle(L, v3(0, 0, 0), v3(6, 0, 0), r);
    expect(big.x).toBeLessThan(1);
    const thin = moveCircle(L, v3(0.9, 0, 0), v3(0.5, 0, 0), 0.05);
    expect(thin.x).toBeLessThan(1);
  });

  it('handles inside corners', () => {
    const C = testLevel([wall(1, -5, 1.2, 5), wall(-5, 1, 1.2, 1.2)]);
    const p = moveCircle(C, v3(0, 0, 0), v3(3, 0, 3), r);
    expect(p.x).toBeCloseTo(1 - r, 3);
    expect(p.z).toBeCloseTo(1 - r, 3);
    expect(circleBlocked(C, p, r - 1e-3)).toBe(false);
  });

  it('slides around an outside corner', () => {
    const B = testLevel([{ kind: 'furniture', min: v3(-0.5, 0, -0.5), max: v3(0.5, 0.8, 0.5) }]);
    let p = v3(-0.65, 0, -2); // clips the corner by 0.1 m
    for (let i = 0; i < 120; i++) p = moveCircle(B, p, v3(0, 0, 0.05), r);
    expect(p.z).toBeGreaterThan(2); // slid off the edge and kept going
    expect(circleBlocked(B, p, r - 1e-3)).toBe(false);
  });

  it('ignores floors, ceilings and overhead lintels', () => {
    const F = testLevel([
      { kind: 'floor', min: v3(-10, -0.2, -10), max: v3(10, 0, 10) },
      { kind: 'ceiling', min: v3(-10, 2.8, -10), max: v3(10, 3, 10) },
      wall(1, -1, 1.2, 1, 2.4),
    ]);
    const p = moveCircle(F, v3(0, 0, 0), v3(3, 0, 0), r);
    expect(p.x).toBeCloseTo(3);
  });
});

describe('pushOut', () => {
  const L = testLevel([wall(1, -5, 1.2, 5)]);

  it('returns zero when clear', () => {
    expect(pushOut(L, v3(0, 1, 0), 0.25)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('returns the minimal correction when overlapping', () => {
    const c = pushOut(L, v3(0.9, 1, 0), 0.25);
    expect(c.x).toBeCloseTo(-0.15, 4);
    expect(c.z).toBeCloseTo(0, 6);
    const inside = pushOut(L, v3(1.15, 1, 0), 0.25);
    expect(1.15 + inside.x).toBeCloseTo(1.45, 4); // nearest face is +X
  });
});

describe('wallsBetween / segmentClear', () => {
  const L = testLevel([
    wall(1, -5, 1.2, 5),
    wall(3, -5, 3.2, 5),
    { kind: 'furniture', min: v3(-2, 0, -1), max: v3(-1, 1, 1) },
  ]);

  it('counts walls crossed, not furniture', () => {
    expect(wallsBetween(L, v3(0, 1, 0), v3(2, 1, 0))).toBe(1);
    expect(wallsBetween(L, v3(0, 1, 0), v3(4, 1, 0))).toBe(2);
    expect(wallsBetween(L, v3(0, 1, 0), v3(-3, 1, 0))).toBe(0);
    expect(wallsBetween(L, v3(0, 1, 6), v3(4, 1, 6))).toBe(0);
  });

  it('segmentClear respects the radius', () => {
    expect(segmentClear(L, v3(-3, 0, 1.2), v3(0, 0, 1.2), 0.1)).toBe(true);
    expect(segmentClear(L, v3(-3, 0, 1.2), v3(0, 0, 1.2), 0.3)).toBe(false);
    expect(segmentClear(L, v3(0, 0, 0), v3(2, 0, 0), 0.1)).toBe(false);
  });

  it('works on the real house', () => {
    const H = createLevel(1);
    const foyer = v3(0, 1.6, 4);
    expect(wallsBetween(H, foyer, v3(0, 2.3, -0.2))).toBe(0); // through the arch
    expect(wallsBetween(H, foyer, v3(-6, 2.3, 3.6))).toBe(1); // living room
    expect(wallsBetween(H, foyer, v3(7.5, 2.3, -4.5))).toBe(2); // kitchen
    const outside = v3(0, 1.6, 9);
    expect(wallsBetween(H, v3(0, 1.6, 7), outside)).toBe(1); // closed door
    expect(wallsBetween(H, v3(0, 1.6, 7), outside, { exitOpen: true })).toBe(0);
  });
});

describe('supportHeight', () => {
  const L = testLevel([{ kind: 'furniture', min: v3(0, 0, 0), max: v3(1, 0.75, 1) }]);

  it('returns the furniture top or the floor', () => {
    expect(supportHeight(L, 0.5, 0.5)).toBeCloseTo(0.75);
    expect(supportHeight(L, 2, 2)).toBe(0);
    expect(supportHeight(L, 0.5, 0.5, 1.2)).toBeCloseTo(0.75);
    expect(supportHeight(L, 0.5, 0.5, 0.6)).toBeCloseTo(0.75); // hand slightly below the top
    expect(supportHeight(L, 0.5, 0.5, 0.2)).toBe(0); // far below: that is not the surface
  });
});
