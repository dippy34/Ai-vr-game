import { describe, expect, it } from 'vitest';
import { createLevel, DOORWAY_HEIGHT } from '../../../core/level';
import { Feat, MonsterWorld } from './world';

const level = createLevel(1);
const w = new MonsterWorld(level);

describe('MonsterWorld features', () => {
  it('finds every doorway under a lintel, each framed by four jamb corners', () => {
    // Front door, hallway south (3), hallway north (4), living|foyer, foyer|dining,
    // bedroom|bathroom+storage, study|kitchen.
    expect(w.doors.length).toBe(12);
    const exit = level.exit.door;
    for (const d of w.doors) {
      expect(d.lintel).toBeCloseTo(DOORWAY_HEIGHT, 6);
      expect(d.halfW).toBeGreaterThan(0.5);
      // The (closed) front door fills its frame: no open jambs to grip there.
      const front = d.cx > exit.min.x && d.cx < exit.max.x && d.cz > exit.min.z && d.cz < exit.max.z;
      expect(w.corners.filter((c) => c.door === d.id).length).toBe(front ? 0 : 4);
    }
    // The living-room door: gap x [-7.0, -5.9] in the wall at z = 1.2.
    const living = w.doors.find((d) => Math.abs(d.cx + 6.45) < 1e-6 && Math.abs(d.cz - 1.2) < 1e-6);
    expect(living?.halfW).toBeCloseTo(0.55, 6);
    expect(Math.abs(living!.nz)).toBe(1);
  });

  it('keeps only exposed wall faces (none buried in another wall)', () => {
    expect(w.faces.length).toBeGreaterThan(40);
    for (const f of w.faces) {
      const a = (f.a0 + f.a1) / 2;
      const x = f.nx !== 0 ? f.plane + f.nx * 0.05 : a;
      const z = f.nx !== 0 ? a : f.plane + f.nz * 0.05;
      expect(w.blocked(x, z, 1.4)).toBe(false);
    }
  });

  it('corners are convex: open space diagonally outside them', () => {
    for (const c of w.corners) {
      const x = c.x + (c.n1x + c.n2x) * 0.05;
      const z = c.z + (c.n1z + c.n2z) * 0.05;
      expect(w.blocked(x, z, 1.4)).toBe(false);
    }
  });

  it('reads furniture tops, windows and headroom', () => {
    // Living-room coffee table: x [-8.3, -7.1], z [4.2, 4.8], 0.45 high.
    expect(w.supportAt(-7.7, 4.5)).toBeCloseTo(0.45, 6);
    expect(w.supportAt(-7.7, 3.9)).toBe(0);
    expect(w.tops.some((t) => t.style === 'bed')).toBe(true);
    expect(w.windows.length).toBe(level.windows.length);
    for (const win of w.windows) {
      // The normal points into the house.
      const x = win.cx + win.nx * 0.5;
      const z = win.cz + win.nz * 0.5;
      expect(x > -11 && x < 11 && z > -8 && z < 8).toBe(true);
    }
    expect(w.headroom(-6.45, 1.2)).toBeCloseTo(DOORWAY_HEIGHT, 6);
    expect(w.headroom(-6.45, 3)).toBeCloseTo(2.8, 6);
  });

  it('places contacts out of walls and furniture sides, or on tops when climbing', () => {
    const p = { x: -7.7, z: 4.5 };
    // Not climbing: pushed off the coffee table.
    expect(w.placeContact(p, 0.09, 0, false)).toBe(0);
    expect(w.blocked(p.x, p.z)).toBe(false);
    // Climbing: stays on top.
    const q = { x: -7.7, z: 4.5 };
    expect(w.placeContact(q, 0.09, 0, true)).toBeCloseTo(0.45, 6);
    expect(q.x).toBeCloseTo(-7.7, 6);
    // Inside a wall: out of it.
    const r = { x: -6.0, z: 1.25 };
    w.placeContact(r, 0.09, 0, false);
    expect(w.blocked(r.x, r.z)).toBe(false);
    // Too close to a wall face: the contact circle is kept clear of it.
    const s = { x: -4.0, z: 1.33 };
    w.placeContact(s, 0.09, 0, false);
    expect(s.z).toBeGreaterThanOrEqual(1.3 + 0.09 - 1e-6);
  });

  it('measures the free width of a doorway and lists only nearby features', () => {
    const l = w.freeDistance(-6.45, 1.2, -1, 0, 2);
    const r = w.freeDistance(-6.45, 1.2, 1, 0, 2);
    expect(l + r).toBeCloseTo(1.1, 6);
    const n = w.query(-6.45, 1.2);
    expect(n).toBeGreaterThan(0);
    let doors = 0;
    for (let i = w.qStart; i < w.qEnd; i++) if (w.refs[i] >> 16 === Feat.Door) doors++;
    expect(doors).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThan(w.refs.length / 10);
  });
});
