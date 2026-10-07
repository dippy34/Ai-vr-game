import { describe, expect, it } from 'vitest';
import { MONSTER, NAV } from '../config';
import { HOUSE_ROOMS, createLevel, roomAt } from './level';
import { distXZ, v3 } from './math';
import { wallsBetween } from './physics';
import {
  CELL_BLOCKED,
  CELL_CLIMB,
  CELL_CRAWL,
  CELL_DUCK,
  CELL_TALL,
  astarStats,
  buildNavGrid,
  cellIndex,
  hidingSpots,
  isClimbable,
  navGridFor,
  planRoute,
  segmentClearFor,
  type RoutePoint,
} from './navgrid';
import { makeRng } from './math';

const level = createLevel(1234);
const g = navGridFor(level);
const clsAt = (x: number, z: number) => g.cls[cellIndex(g, x, z)];

describe('nav grid', () => {
  it('is built once per level and shared', () => {
    expect(navGridFor(level)).toBe(g);
    const t0 = performance.now();
    buildNavGrid(level);
    const ms = performance.now() - t0;
    console.log(`nav grid ${g.w}x${g.h} (${NAV.cellSize} m) built in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(500);
  });

  it('classes cells by what the body must do there', () => {
    expect(clsAt(-7, 3)).toBe(CELL_TALL); // open living room
    expect(clsAt(-6.45, 1.2)).toBe(CELL_DUCK); // living room doorway (lintel at 2.4 m)
    expect(clsAt(0, 1.2)).toBe(CELL_DUCK); // the foyer arch
    expect(clsAt(-9.85, -4.6)).toBe(CELL_CLIMB); // on the bed
    expect(clsAt(-7.7, 4.5)).toBe(CELL_CLIMB); // on the coffee table
    expect([CELL_CRAWL, CELL_CLIMB]).toContain(clsAt(3.55, -5.9)); // between the desk and the wall
    expect(clsAt(-3, 3)).toBe(CELL_BLOCKED); // inside a wall
    expect(clsAt(-7.3, -7.6)).toBe(CELL_BLOCKED); // wardrobe (too tall to climb)
    expect(clsAt(7.5, -4.7)).toBe(CELL_BLOCKED); // kitchen island (0.9 m: too tall)
    expect(clsAt(0, 9)).toBe(CELL_BLOCKED); // outside on the porch: not reachable
    expect(clsAt(5, 8.8)).toBe(CELL_BLOCKED); // outside the house
    const low = level.boxes.filter(isClimbable).map((b) => b.style);
    expect(low).toContain('bed');
    expect(low).toContain('table');
    expect(low).not.toContain('piano');
    expect(low).not.toContain('shelf');
  });

  it('splits the house into its rooms, joined by doorways', () => {
    const names = g.regions.map((r) => roomAt(r.center.x, r.center.z));
    expect(names.sort()).toEqual(HOUSE_ROOMS.map((r) => r.name).sort());
    for (const r of g.regions) {
      expect(r.patrol.length).toBeGreaterThan(0);
      expect(r.lurks.length).toBeGreaterThan(0);
      for (const p of [...r.patrol, ...r.lurks.map((l) => l.position)]) {
        expect(g.region[cellIndex(g, p.x, p.z)]).toBe(r.id);
        expect(g.cls[cellIndex(g, p.x, p.z)]).toBe(CELL_TALL);
      }
    }
    const pair = (a: string, b: string) =>
      g.doorways.some((d) => {
        const n = d.regions.map((r) => roomAt(g.regions[r].center.x, g.regions[r].center.z));
        return n.includes(a) && n.includes(b);
      });
    expect(pair('bedroom', 'bathroom')).toBe(true);
    expect(pair('hallway', 'kitchen')).toBe(true);
    expect(pair('foyer', 'living')).toBe(true);
    expect(pair('study', 'kitchen')).toBe(true);
    expect(pair('bedroom', 'kitchen')).toBe(false);
    // 11 interior doorways + the (closed) front door.
    expect(g.doorways.length).toBe(12);
  });

  it('routes between all rooms: string-pulled, never through walls, every leg clear for its kind', () => {
    const out: RoutePoint[] = [];
    const pts = g.regions.flatMap((r) => r.patrol.slice(0, 2));
    let plans = 0;
    let worst = 0;
    let legs = 0;
    let spent = 0;
    for (const a of pts) {
      for (const b of pts) {
        if (a === b) continue;
        const s = performance.now();
        const ok = planRoute(g, a, b, out);
        const ms = performance.now() - s;
        spent += ms;
        worst = Math.max(worst, ms);
        expect(ok).toBe(true);
        plans++;
        legs += out.length;
        const last = out[out.length - 1];
        expect(distXZ(v3(last.x, 0, last.z), b)).toBeLessThan(0.05);
        let prev = a;
        for (const p of out) {
          const q = v3(p.x, 0, p.z);
          expect(wallsBetween(level, prev, q)).toBe(0);
          expect(segmentClearFor(g, p.kind, prev, q)).toBe(true);
          prev = q;
        }
      }
    }
    const avg = spent / plans;
    console.log(`${plans} routes: avg ${avg.toFixed(3)} ms, worst ${worst.toFixed(2)} ms, ${(legs / plans).toFixed(1)} legs each`);
    expect(legs / plans).toBeLessThan(8);
    expect(avg).toBeLessThan(3);
    expect(astarStats.searches).toBeGreaterThan(0);
  });

  it('snaps goals to its side of a wall, and climbs only where the furniture is low', () => {
    const out: RoutePoint[] = [];
    // A goal just inside the storage room wall, asked from the hallway: it walks round through
    // the door instead of stopping at the hallway side of the wall.
    planRoute(g, v3(-2.6, 0, 0), v3(-2.6, 0, -1.7), out);
    const end = out[out.length - 1];
    expect(roomAt(end.x, end.z)).toBe('storage');
    // Straight over the bed when told to use the fixed default costs? Only through climb legs.
    planRoute(g, v3(-9.85, 0, -6.4), v3(-9.85, 0, -3.0), out);
    for (const p of out) if (p.kind === 'upright') expect(clsAt(p.x, p.z)).not.toBe(CELL_CLIMB);
  });

  it('finds likely hiding spots (corners, behind furniture) on the near side of walls', () => {
    const center = v3(-7.4, 0, -4.6); // bedroom
    const spots = hidingSpots(g, center, MONSTER.searchRadius, 4, makeRng(3));
    expect(spots.length).toBeGreaterThan(1);
    for (const s of spots) {
      expect(roomAt(s.x, s.z)).toBe('bedroom');
      expect(g.stand[cellIndex(g, s.x, s.z)]).toBe(1);
      expect(g.nook[cellIndex(g, s.x, s.z)]).toBeGreaterThanOrEqual(3);
      expect(distXZ(s, center)).toBeLessThanOrEqual(MONSTER.searchRadius);
    }
  });
});
