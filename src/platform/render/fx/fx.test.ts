import { describe, expect, it } from 'vitest';
import { createLevel } from '../../../core/level';
import type { LevelData } from '../../../core/types';
import { AO_FIELD, buildAoField, type AoFieldData } from './roomAO';
import { pickQuality } from './pipeline';

/** Decoded field value (m) of channel c at world (x, z), nearest texel. */
function at(f: AoFieldData, c: number, x: number, z: number): number {
  const i = Math.floor((x - f.minX) / f.res);
  const j = Math.floor((z - f.minZ) / f.res);
  return (f.data[(j * f.width + i) * 4 + c] / 255) * (c === 3 ? AO_FIELD.maxHeight : AO_FIELD.maxDist);
}

/** One 4 x 4 m room (walls 0.2 thick, a doorway gap in the east wall) and a table. */
function tinyLevel(): LevelData {
  const wall = (x0: number, z0: number, x1: number, z1: number) => ({ kind: 'wall' as const, min: { x: x0, y: 0, z: z0 }, max: { x: x1, y: 2.8, z: z1 } });
  return {
    id: 't', seed: 1,
    bounds: { min: { x: -2.1, y: 0, z: -2.1 }, max: { x: 2.1, y: 2.8, z: 2.1 } },
    boxes: [
      wall(-2.1, -2.1, 2.1, -1.9), wall(-2.1, 1.9, 2.1, 2.1), wall(-2.1, -1.9, -1.9, 1.9),
      wall(1.9, -1.9, 2.1, -0.5), wall(1.9, 0.5, 2.1, 1.9),
      { kind: 'furniture', style: 'table', min: { x: -0.5, y: 0, z: -0.5 }, max: { x: 0.5, y: 0.8, z: 0.5 } },
    ],
    nav: [], playerSpawns: [], monsterSpawn: { x: 0, y: 0, z: 0 },
  } as unknown as LevelData;
}

describe('room AO field', () => {
  const f = buildAoField(tinyLevel());

  it('measures free distance to walls along each axis', () => {
    // 0.3 m east of the west wall's inner face (x = -1.9).
    expect(at(f, 0, -1.6, 1.0)).toBeCloseTo(0.3, 1);
    // 0.3 m south of the north wall's inner face (z = -1.9).
    expect(at(f, 1, 1.0, -1.6)).toBeCloseTo(0.3, 1);
    // Mid-room: far from everything along X.
    expect(at(f, 0, 0, 1.2)).toBeGreaterThan(0.95);
  });

  it('ignores openings (a doorway is not a wall)', () => {
    // In the doorway gap of the east wall, looking along X: no wall within reach.
    expect(at(f, 0, 1.6, 0)).toBeGreaterThan(0.95);
    // Beside the gap, the wall is right there.
    expect(at(f, 0, 1.6, 1.2)).toBeCloseTo(0.3, 1);
  });

  it('stores the distance to furniture footprints and their height', () => {
    expect(at(f, 2, 0, 0)).toBe(0);
    expect(at(f, 2, 0.8, 0)).toBeCloseTo(0.3, 1);
    expect(at(f, 3, 0.8, 0)).toBeCloseTo(0.8, 1);
  });

  it('builds for the real house in one quick pass', () => {
    const t0 = performance.now();
    const h = buildAoField(createLevel(1));
    expect(h.width * h.height).toBeGreaterThan(50000);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('render quality', () => {
  it('auto follows the XR session; a setting or a forced tier wins', () => {
    expect(pickQuality('auto', true)).toBe('quest');
    expect(pickQuality('auto', false)).toBe('desktop');
    expect(pickQuality('desktop', true)).toBe('desktop');
    expect(pickQuality('auto', false, 'quest')).toBe('quest');
  });
});
