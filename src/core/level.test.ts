import { describe, expect, it } from 'vitest';
import { PLAYER } from '../config';
import { createLevel, HOUSE_ROOMS, roomAt, WALL_HEIGHT } from './level';
import { distXZ, v3 } from './math';
import { findPath, nearestNavNode, navComponents } from './nav';
import { circleBlocked, moveCircle, pushOut, segmentClear, supportHeight } from './physics';
import type { LevelData, Vec3 } from './types';

const MONSTER_R = 0.35;

/** Walk a circle along the nav graph from `from` to `to` using moveCircle only. */
function walk(level: LevelData, from: Vec3, to: Vec3, radius: number, speed = 3.3, fps = 60): Vec3 {
  const s = nearestNavNode(level, from, radius);
  const g = nearestNavNode(level, to, radius);
  const ids = findPath(level.nav, s, g);
  expect(ids).not.toBeNull();
  const wps = [...ids!.map((id) => level.nav[id].position), to];
  let p = v3(from.x, from.y, from.z);
  for (const wp of wps) {
    for (let k = 0; k < 3000; k++) {
      const dx = wp.x - p.x;
      const dz = wp.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.02) break;
      const step = Math.min(d, speed / fps);
      p = moveCircle(level, p, v3((dx / d) * step, 0, (dz / d) * step), radius);
    }
  }
  return p;
}

describe('createLevel', () => {
  const level = createLevel(42);

  it('is deterministic and stores the seed', () => {
    expect(JSON.stringify(createLevel(42))).toBe(JSON.stringify(level));
    expect(level.seed).toBe(42);
    expect(createLevel(7).seed).toBe(7);
  });

  it('has a sane house shell', () => {
    const b = level.bounds;
    expect(b.max.x - b.min.x).toBeGreaterThan(21);
    expect(b.max.z - b.min.z).toBeGreaterThan(15);
    for (const box of level.boxes) {
      expect(box.max.x).toBeGreaterThan(box.min.x);
      expect(box.max.y).toBeGreaterThan(box.min.y);
      expect(box.max.z).toBeGreaterThan(box.min.z);
    }
    const floor = level.boxes.find((x) => x.kind === 'floor')!;
    expect(floor.max.y).toBe(0);
    expect(level.boxes.some((x) => x.kind === 'ceiling' && x.min.y === WALL_HEIGHT)).toBe(true);
    const furniture = level.boxes.filter((x) => x.kind === 'furniture');
    expect(furniture.length).toBeGreaterThan(20);
    expect(furniture.every((f) => f.style !== undefined && f.color !== undefined)).toBe(true);
    expect(new Set(furniture.map((f) => f.style)).size).toBe(8);
    expect(HOUSE_ROOMS.length).toBeGreaterThanOrEqual(8);
  });

  it('puts 4 player spawns in the foyer, clear of geometry, facing into the house', () => {
    expect(level.playerSpawns.length).toBeGreaterThanOrEqual(4);
    for (const s of level.playerSpawns) {
      expect(roomAt(s.position.x, s.position.z)).toBe('foyer');
      expect(s.yaw).toBe(0); // facing -Z, toward the hallway
      expect(circleBlocked(level, s.position, PLAYER.radius)).toBe(false);
    }
    for (let i = 0; i < level.playerSpawns.length; i++) {
      for (let j = i + 1; j < level.playerSpawns.length; j++) {
        expect(distXZ(level.playerSpawns[i].position, level.playerSpawns[j].position)).toBeGreaterThan(
          2 * PLAYER.radius,
        );
      }
    }
  });

  it('puts the monster in the farthest room, clear of geometry', () => {
    expect(roomAt(level.monsterSpawn.x, level.monsterSpawn.z)).toBe('bathroom');
    expect(circleBlocked(level, level.monsterSpawn, MONSTER_R)).toBe(false);
    expect(distXZ(level.monsterSpawn, level.playerSpawns[0].position)).toBeGreaterThan(10);
  });

  it('places items on surfaces across many rooms', () => {
    expect(level.fuseSpawns.length).toBeGreaterThanOrEqual(6);
    expect(level.filmSpawns.length).toBeGreaterThanOrEqual(4);
    const fuseRooms = new Set(level.fuseSpawns.map((p) => roomAt(p.x, p.z)));
    expect(fuseRooms.size).toBeGreaterThanOrEqual(6);
    expect(fuseRooms.has(null)).toBe(false);
    for (const p of [...level.fuseSpawns, ...level.filmSpawns, level.cameraSpawn.position]) {
      expect(supportHeight(level, p.x, p.z)).toBeCloseTo(p.y, 6);
    }
    expect(roomAt(level.cameraSpawn.position.x, level.cameraSpawn.position.z)).toBe('foyer');
  });

  it('has the fuse box beside the front door and the exit zone just outside it', () => {
    const { door, zone } = level.exit;
    expect(roomAt(level.fuseBox.position.x, level.fuseBox.position.z)).toBe('foyer');
    const doorCenter = v3((door.min.x + door.max.x) / 2, 1.4, (door.min.z + door.max.z) / 2);
    expect(distXZ(level.fuseBox.position, doorCenter)).toBeLessThan(2.5);
    expect(zone.min.z).toBeGreaterThanOrEqual(door.max.z - 1e-9);
    expect(zone.min.x).toBeLessThanOrEqual(door.min.x);
    expect(zone.max.x).toBeGreaterThanOrEqual(door.max.x);
  });

  it('blocks the front doorway only while the door is closed', () => {
    const start = v3(0, 1.6, 7.0);
    const closed = moveCircle(level, start, v3(0, 0, 2.2), PLAYER.radius);
    expect(closed.z).toBeLessThan(level.exit.door.min.z);
    const open = moveCircle(level, start, v3(0, 0, 2.2), PLAYER.radius, { exitOpen: true });
    expect(open.z).toBeGreaterThan(level.exit.zone.min.z);
  });

  it('has windows on exterior walls', () => {
    expect(level.windows.length).toBeGreaterThanOrEqual(6);
    for (const w of level.windows) {
      const onEW = Math.abs(Math.abs(w.center.x) - 10.89) < 0.02;
      const onNS = Math.abs(Math.abs(w.center.z) - 7.89) < 0.02;
      expect(onEW || onNS).toBe(true);
    }
  });

  describe('nav graph', () => {
    it('has ids equal to indices and symmetric links', () => {
      level.nav.forEach((n, i) => {
        expect(n.id).toBe(i);
        for (const l of n.links) expect(level.nav[l].links).toContain(n.id);
      });
    });

    it('is connected and covers every room', () => {
      expect(navComponents(level.nav)).toBe(1);
      const rooms = new Set(level.nav.map((n) => roomAt(n.position.x, n.position.z)));
      for (const r of HOUSE_ROOMS) expect(rooms.has(r.name)).toBe(true);
    });

    it('only links nodes with a clear straight line for the monster', () => {
      for (const n of level.nav) {
        expect(n.links.length).toBeGreaterThan(0);
        for (const l of n.links) {
          expect(segmentClear(level, n.position, level.nav[l].position, MONSTER_R)).toBe(true);
        }
      }
    });

    it('keeps nodes away from furniture and walls', () => {
      for (const n of level.nav) {
        expect(circleBlocked(level, n.position, MONSTER_R + 0.05)).toBe(false);
        const c = pushOut(level, n.position, MONSTER_R);
        expect(c.x).toBe(0);
        expect(c.z).toBe(0);
      }
    });
  });

  it('every room is reachable on foot through the doorways (player and monster sized)', () => {
    const foyer = v3(0, 0, 4.0);
    for (const n of level.nav) {
      const end = walk(level, foyer, n.position, PLAYER.radius);
      expect(distXZ(end, n.position)).toBeLessThan(0.1);
    }
    for (const r of ['kitchen', 'bedroom', 'study', 'dining', 'living', 'storage']) {
      const target = level.nav.find((n) => roomAt(n.position.x, n.position.z) === r)!;
      const end = walk(level, level.monsterSpawn, target.position, MONSTER_R, 3.1, 30);
      expect(distXZ(end, target.position)).toBeLessThan(0.1);
    }
  });
});
