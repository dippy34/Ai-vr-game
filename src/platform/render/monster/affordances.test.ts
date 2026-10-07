import { describe, expect, it } from 'vitest';
import { createLevel } from '../../../core/level';
import { Affordances, newAffordCtx, newGoal, type AffordCtx, type HandGoal } from './affordances';
import { MonsterWorld } from './world';

const level = createLevel(1);
const world = new MonsterWorld(level);

/** Body at (x, z) facing `yaw`, shoulders where the rig has them (2 m up, 0.23 m out). */
function body(c: AffordCtx, x: number, z: number, yaw: number, speed: number): AffordCtx {
  c.x = x;
  c.z = z;
  c.fx = -Math.sin(yaw);
  c.fz = -Math.cos(yaw);
  c.rx = Math.cos(yaw);
  c.rz = -Math.sin(yaw);
  c.vx = c.fx;
  c.vz = c.fz;
  c.speed = speed;
  c.reach = 1.25;
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    c.shoulder[i].set(x + c.rx * side * 0.23, 1.95, z + c.rz * side * 0.23);
  }
  return c;
}

/** The point is on open ground / a free surface: not inside any solid. */
function free(g: HandGoal): boolean {
  return !world.blocked(g.p.x + g.n.x * 0.03, g.p.z + g.n.z * 0.03, Math.max(0.05, g.p.y - 0.05));
}

describe('Affordances', () => {
  it('trails or braces a hand on the hallway wall beside it, on the correct side', () => {
    const af = new Affordances(world, 1);
    const c = newAffordCtx();
    const g = newGoal();
    let hits = 0;
    // Walk east along the hallway, 0.55 m from the north wall (on its left).
    for (let i = 0; i < 400; i++) {
      c.time = i * 0.1;
      body(c, -10 + i * 0.05, -0.55, -Math.PI / 2, 1);
      if (af.choose(0, c, g)) {
        expect(g.kind === 'wall' || g.kind === 'trail' || g.kind === 'corner').toBe(true);
        if (g.kind !== 'corner') {
          expect(g.p.z).toBeCloseTo(-1.1, 6);
          expect(g.n.z).toBe(1);
          expect(g.p.y).toBeGreaterThan(0.4);
          expect(g.p.y).toBeLessThan(2.3);
        }
        expect(free(g)).toBe(true);
        hits++;
      }
      // The right hand never reaches across the body for the north wall.
      if (af.choose(1, c, g) && (g.kind === 'wall' || g.kind === 'trail')) expect(g.p.z).not.toBeCloseTo(-1.1, 3);
    }
    expect(hits).toBeGreaterThan(0);
  });

  it('grips the jambs of the door it walks through: each hand its own side, palm on the jamb face', () => {
    const af = new Affordances(world, 2);
    const c = newAffordCtx();
    const g = newGoal();
    const door = world.doors.find((d) => Math.abs(d.cx + 6.45) < 1e-6 && Math.abs(d.cz - 1.2) < 1e-6)!;
    // From the hallway, heading south (+Z) into the living room.
    body(c, -6.4, 0.2, Math.PI, 0.9);
    c.door = door.id;
    c.dnx = 0;
    c.dnz = 1;
    c.ds = -1;
    expect(af.jamb(0, c, g)).toBe(true);
    // Facing +Z, the left hand is on +X: the jamb at x = -5.9, whose face points into the gap (-X).
    expect(g.p.x).toBeCloseTo(-5.9, 6);
    expect(g.n.x).toBe(-1);
    expect(g.p.z).toBeGreaterThan(1.1 - 1e-6);
    expect(g.p.z).toBeLessThan(1.3 + 1e-6);
    expect(g.p.y).toBeLessThan(door.lintel);
    expect(af.jamb(1, c, g)).toBe(true);
    expect(g.p.x).toBeCloseTo(-7.0, 6);
    expect(g.n.x).toBe(1);
    // Fingers point through the door.
    expect(g.f.z).toBeGreaterThan(0.7);
  });

  it('puts both hands on a moonlit window it stands at, on the glass', () => {
    const af = new Affordances(world, 3);
    const c = newAffordCtx();
    const g = newGoal();
    const win = world.windows.find((w) => w.cx < -10.8 && Math.abs(w.cz - 5) < 1e-6)!;
    let hits = 0;
    for (let k = 0; k < 12; k++) {
      c.time = k * 10;
      body(c, -10.25, 5.0, Math.PI / 2, 0);
      c.idle = true;
      for (const arm of [0, 1] as const) {
        if (!af.choose(arm, c, g) || g.kind !== 'window') continue;
        hits++;
        expect(g.p.x).toBeCloseTo(win.cx, 6);
        expect(Math.abs(g.p.z - win.cz)).toBeLessThanOrEqual(win.halfW);
        expect(Math.abs(g.p.y - win.cy)).toBeLessThanOrEqual(win.halfH);
        expect(g.n.x).toBeCloseTo(1, 6);
        // Left hand on the left half of the glass (facing west, left is +Z... i.e. south).
        expect(Math.sign(g.p.z - win.cz)).toBe(arm === 0 ? 1 : -1);
      }
    }
    expect(hits).toBeGreaterThan(2);
  });

  it('grips a convex corner it turns around, fingers wrapped onto the other face', () => {
    const af = new Affordances(world, 4);
    const c = newAffordCtx();
    const g = newGoal();
    // The foyer coat cabinet (x [2.4, 2.9], z [1.8, 3.2], 1.9 m): its corner at (2.4, 3.2).
    const k = world.corners.find((q) => Math.abs(q.x - 2.4) < 1e-6 && Math.abs(q.z - 3.2) < 1e-6)!;
    expect(k).toBeTruthy();
    let hits = 0;
    for (let i = 0; i < 20; i++) {
      c.time = i * 10;
      // Walking north past it with the cabinet on the right, turning right around it.
      body(c, 1.9, 3.5, 0, 0.8);
      c.yawRate = -1.2;
      if (!af.choose(1, c, g) || g.kind !== 'corner') continue;
      hits++;
      expect(Math.hypot(g.p.x - k.x, g.p.z - k.z)).toBeLessThan(0.16);
      const onA = Math.abs(g.n.x - k.n1x) + Math.abs(g.n.z - k.n1z) < 1e-6;
      const onB = Math.abs(g.n.x - k.n2x) + Math.abs(g.n.z - k.n2z) < 1e-6;
      expect(onA || onB).toBe(true);
      // Fingers cross the edge: along the other face's normal.
      expect(g.f.x * (onA ? k.n2x : k.n1x) + g.f.z * (onA ? k.n2z : k.n1z)).toBeGreaterThan(0.9);
      expect(free(g)).toBe(true);
    }
    expect(hits).toBeGreaterThan(5);
  });

  it('rests a hand on a counter it walks past', () => {
    const af = new Affordances(world, 5);
    const c = newAffordCtx();
    const g = newGoal();
    let hits = 0;
    // The kitchen island: x [6.5, 8.5], z [-5.2, -4.2], 0.9 m. Walk east beside its south side.
    for (let i = 0; i < 60; i++) {
      c.time = i * 5;
      body(c, 7.4, -3.85, -Math.PI / 2, 0.9);
      if (af.choose(0, c, g) && g.kind === 'top') {
        hits++;
        expect(g.p.y).toBeCloseTo(0.9, 6);
        expect(g.p.z).toBeLessThan(-4.2);
        expect(g.p.z).toBeGreaterThan(-5.2);
      }
    }
    expect(hits).toBeGreaterThan(5);
  });
});
