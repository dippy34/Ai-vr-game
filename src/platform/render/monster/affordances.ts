/**
 * The affordance layer: what a free hand can do with the geometry around the body right now.
 * Every frame each free hand looks at the features listed in its grid cell (MonsterWorld) and
 * scores the ones that fit the moment: a door jamb to pull through, a corner edge to swing
 * around, a table top to lean on while passing, a wall to brace on or trail its fingertips along,
 * the glass of a moonlit window, the ceiling to brush. Each encounter with a feature rolls once
 * (seeded by the feature and the encounter count, so it is deterministic and never the same twice)
 * and draws its own heights, offsets, finger style and duration.
 *
 * New level geometry needs no code: anything that is a wall face, a convex corner, a lintel, a
 * furniture top or a window in LevelData becomes something the hands can use.
 */

import * as THREE from 'three';
import { Feat, type MonsterWorld } from './world';
import { hashKey, Rng } from './noise';

export type GoalKind = 'none' | 'jamb' | 'corner' | 'top' | 'wall' | 'trail' | 'window' | 'ceiling' | 'touch' | 'ear';

/**
 * How the hand meets the surface: Palm flat (fingers spread), Tips (fingertips only, wrist raised,
 * a claw), Wrap (palm on one face, fingers around the edge), Trail (fingertips dragging along it).
 */
export const Grip = { Palm: 0, Tips: 1, Wrap: 2, Trail: 3 } as const;
export type Grip = (typeof Grip)[keyof typeof Grip];

export interface HandGoal {
  kind: GoalKind;
  /** Feature key (kind << 16 | index), -1 for none. */
  key: number;
  /** Contact point on the surface (level space). */
  readonly p: THREE.Vector3;
  /** Surface normal (out of the surface). */
  readonly n: THREE.Vector3;
  /** Finger direction along the surface. */
  readonly f: THREE.Vector3;
  grip: Grip;
  /** Finger curl (0..1.4 rad, middle joints) and spread for this instance. */
  curl: number;
  spread: number;
  /** Priority (higher preempts lower). */
  prio: number;
  /** Sim-independent time (s) it gives up by. */
  until: number;
  /** Seed for this instance's micro-variation. */
  seed: number;
  /** Kind-specific: travel normal for jambs (x, z), the corner's wrap side, trail lag... */
  ax: number;
  az: number;
  lag: number;
  /** Height of the contact relative to the shoulder when chosen (trail keeps it). */
  h: number;
}

export const newGoal = (): HandGoal => ({
  kind: 'none', key: -1, p: new THREE.Vector3(), n: new THREE.Vector3(0, 1, 0), f: new THREE.Vector3(0, 0, -1),
  grip: Grip.Palm, curl: 0.3, spread: 0, prio: 0, until: 0, seed: 0, ax: 0, az: 0, lag: 0, h: 0,
});

export function copyGoal(src: HandGoal, dst: HandGoal): HandGoal {
  dst.kind = src.kind; dst.key = src.key; dst.p.copy(src.p); dst.n.copy(src.n); dst.f.copy(src.f);
  dst.grip = src.grip; dst.curl = src.curl; dst.spread = src.spread; dst.prio = src.prio; dst.until = src.until;
  dst.seed = src.seed; dst.ax = src.ax; dst.az = src.az; dst.lag = src.lag; dst.h = src.h;
  return dst;
}

/** What the body tells the affordance layer each frame (level space unless noted). */
export interface AffordCtx {
  time: number;
  x: number;
  y: number;
  z: number;
  /** Body forward / right (unit, XZ). */
  fx: number;
  fz: number;
  rx: number;
  rz: number;
  speed: number;
  /** Unit direction of motion (XZ; = forward when still). */
  vx: number;
  vz: number;
  yawRate: number;
  /** Shoulder joints, [left, right]. */
  readonly shoulder: [THREE.Vector3, THREE.Vector3];
  /** Arm reach (shoulder to wrist, m). */
  reach: number;
  /** Ground under the body. */
  ground: number;
  quad: boolean;
  /** Standing still, not acting (idle or listening): windows, resting on furniture. */
  idle: boolean;
  listening: boolean;
  /** Gestures own the hands: no surface contacts. */
  busy: boolean;
  /** Doorway being passed (-1 none), travel normal, depth along it (s < 0 before the door). */
  door: number;
  dnx: number;
  dnz: number;
  ds: number;
  /** Duck/crawl through the door (low grips) vs. upright. */
  doorLow: boolean;
  /** Headroom over the body (ceiling or lintel). */
  headroom: number;
}

export const newAffordCtx = (): AffordCtx => ({
  time: 0, x: 0, y: 0, z: 0, fx: 0, fz: -1, rx: 1, rz: 0, speed: 0, vx: 0, vz: -1, yawRate: 0,
  shoulder: [new THREE.Vector3(), new THREE.Vector3()], reach: 1.2, ground: 0, quad: false,
  idle: false, listening: false, busy: false, door: -1, dnx: 0, dnz: 1, ds: 0, doorLow: false, headroom: 2.8,
});

/** Odds that an encounter with each kind of feature is used. */
export const AFFORD = {
  corner: 0.8,
  cornerPassing: 0.35,
  top: 0.6,
  topIdle: 0.35,
  wall: 0.5,
  window: 0.55,
  ceiling: 0.1,
  ear: 0.45,
} as const;

const MEM = 32;

/**
 * Remembers each encounter's roll so a feature is used (or ignored) consistently while it stays
 * in range, and rolls again on the next encounter.
 */
class Encounters {
  private readonly keys = new Int32Array(MEM).fill(-1);
  private readonly ok = new Uint8Array(MEM);
  private readonly until = new Float64Array(MEM);
  private readonly count = new Map<number, number>();
  private readonly rng = new Rng(1);
  private next = 0;

  /** Roll (or recall) the decision for `key`; keeps it alive for `hold` seconds. */
  decide(key: number, p: number, now: number, seed: number, hold = 2.5): boolean {
    for (let i = 0; i < MEM; i++) {
      if (this.keys[i] === key && this.until[i] > now) {
        this.until[i] = now + hold;
        return this.ok[i] === 1;
      }
    }
    const n = (this.count.get(key) ?? 0) + 1;
    this.count.set(key, n);
    const ok = this.rng.seed(hashKey(key ^ seed, n)).next() < p;
    const i = this.next;
    this.next = (this.next + 1) % MEM;
    this.keys[i] = key;
    this.ok[i] = ok ? 1 : 0;
    this.until[i] = now + hold;
    return ok;
  }

  /** Forbid `key` for `seconds` (a cooldown after using it). */
  block(key: number, now: number, seconds: number): void {
    for (let i = 0; i < MEM; i++) {
      if (this.keys[i] === key) {
        this.ok[i] = 0;
        this.until[i] = now + seconds;
        return;
      }
    }
    const i = this.next;
    this.next = (this.next + 1) % MEM;
    this.keys[i] = key;
    this.ok[i] = 0;
    this.until[i] = now + seconds;
  }

  /** Encounters with `key` so far (seeds per-instance variation). */
  n(key: number): number {
    return this.count.get(key) ?? 0;
  }
}

const _c = newGoal();
const _v = new THREE.Vector3();

export class Affordances {
  private readonly mem = new Encounters();
  private readonly rng = new Rng(1);

  constructor(private readonly world: MonsterWorld, private readonly seed: number) {}

  /** Cooldown: don't reuse this feature (with this arm) for a while. */
  rest(key: number, arm: number, now: number, seconds: number): void {
    this.mem.block(key ^ (arm << 28), now, seconds);
  }

  /**
   * Best surface goal for `arm` (0 left, 1 right) right now, written to `out`; returns false when
   * there is none. `minPrio`: only goals that beat what the hand already does.
   */
  choose(arm: 0 | 1, c: AffordCtx, out: HandGoal, minPrio = 0): boolean {
    if (c.busy) return false;
    const side = arm === 0 ? -1 : 1;
    const S = c.shoulder[arm];
    const w = this.world;
    out.kind = 'none';
    out.prio = minPrio;
    let found = false;
    w.query(c.x, c.z);
    const q0 = w.qStart;
    const q1 = w.qEnd;
    for (let q = q0; q < q1; q++) {
      const ref = w.refs[q];
      const kind = ref >> 16;
      const idx = ref & 0xffff;
      let ok = false;
      if (kind === Feat.Corner) ok = this.corner(idx, arm, side, S, c, _c);
      else if (kind === Feat.Top) ok = this.top(idx, arm, side, S, c, _c);
      else if (kind === Feat.Face) ok = this.wall(idx, arm, side, S, c, _c);
      else if (kind === Feat.Window) ok = this.window(idx, arm, side, S, c, _c);
      if (ok && _c.prio > out.prio) {
        copyGoal(_c, out);
        found = true;
      }
    }
    if (!found && out.prio < 15) found = this.ceiling(arm, side, S, c, out);
    return found;
  }

  private begin(out: HandGoal, kind: GoalKind, key: number, arm: number): Rng {
    out.kind = kind;
    out.key = key;
    const k = key ^ (arm << 28);
    out.seed = hashKey(k, this.mem.n(k));
    return this.rng.seed(out.seed ^ this.seed);
  }

  private decide(key: number, arm: number, p: number, now: number, hold?: number): boolean {
    return this.mem.decide(key ^ (arm << 28), p, now, this.seed, hold);
  }

  /** Door jambs: the corners framing door `c.door` on the approach side, one per hand. */
  jamb(arm: 0 | 1, c: AffordCtx, out: HandGoal): boolean {
    if (c.door < 0) return false;
    const w = this.world;
    const d = w.doors[c.door];
    const side = arm === 0 ? -1 : 1;
    let best = -1;
    for (const k of w.corners) {
      if (k.door !== d.id) continue;
      // Approach side: before the door center along the travel normal.
      if ((k.x - d.cx) * c.dnx + (k.z - d.cz) * c.dnz > 0) continue;
      // This hand's side of the body.
      if (((k.x - c.x) * c.rx + (k.z - c.z) * c.rz) * side <= 0) continue;
      best = k.id;
    }
    if (best < 0) return false;
    const k = w.corners[best];
    const key = (Feat.Door << 16) | (d.id * 4 + arm);
    const r = this.begin(out, 'jamb', key, arm);
    // The jamb face: of the corner's two faces, the one along the travel normal (facing the opening).
    const j1 = Math.abs(k.n1x * c.dnx + k.n1z * c.dnz) < 0.5;
    const jnx = j1 ? k.n1x : k.n2x;
    const jnz = j1 ? k.n1z : k.n2z;
    // Grip height: varied per pass, low when it crawls through.
    const shoulderY = c.shoulder[arm].y - c.ground;
    const h = c.doorLow ? r.range(0.3, 0.95) : r.range(Math.max(0.8, shoulderY - 0.8), Math.min(d.lintel - 0.25, shoulderY + 0.35));
    const depth = r.range(0.03, d.halfT * 2 - 0.05);
    out.p.set(k.x + c.dnx * depth, c.ground + h, k.z + c.dnz * depth);
    out.n.set(jnx, 0, jnz);
    // Fingers point through the door, tipped up or down along the jamb.
    const tilt = r.range(-0.55, 0.45);
    out.f.set(c.dnx * Math.cos(tilt), Math.sin(tilt), c.dnz * Math.cos(tilt));
    out.grip = Grip.Wrap;
    out.curl = r.range(0.75, 1.3);
    out.spread = r.range(0.0, 0.25);
    out.prio = 90;
    out.until = c.time + 6;
    out.ax = c.dnx;
    out.az = c.dnz;
    out.lag = r.range(0, 0.35); // reach delay for the second hand
    out.h = h;
    return true;
  }

  /** A convex corner it turns around (or passes close by): grip the edge, swing around it. */
  private corner(i: number, arm: number, side: number, S: THREE.Vector3, c: AffordCtx, out: HandGoal): boolean {
    const k = this.world.corners[i];
    // A jamb is a pivot when it turns into a doorway; once it walks through, the door pass owns it.
    if ((k.door >= 0 && k.door === c.door) || c.quad) return false;
    const dx = k.x - c.x;
    const dz = k.z - c.z;
    const lat = dx * c.rx + dz * c.rz;
    const fwd = dx * c.fx + dz * c.fz;
    if (lat * side < 0.12 || fwd < -0.3) return false;
    const dist = Math.hypot(k.x - S.x, k.z - S.z);
    if (dist > c.reach * 0.92 || Math.hypot(dx, dz) > 1.25) return false;
    if (k.top < 1.2) return false;
    // Turning toward this side (a left turn is +yawRate), or brushing past it while moving.
    const turning = c.yawRate * -side > 0.45 && c.speed > 0.1;
    const passing = c.speed > 0.35 && fwd < 0.6 && Math.abs(lat) < 0.95;
    if (!turning && !passing) return false;
    const key = (Feat.Corner << 16) | i;
    if (!this.decide(key, arm, turning ? AFFORD.corner : AFFORD.cornerPassing, c.time)) return false;
    const r = this.begin(out, 'corner', key, arm);
    // Palm on the face the body is in front of; fingers wrap around the edge onto the other.
    const d1 = (c.x - k.x) * k.n1x + (c.z - k.z) * k.n1z;
    const d2 = (c.x - k.x) * k.n2x + (c.z - k.z) * k.n2z;
    const pnx = d1 >= d2 ? k.n1x : k.n2x;
    const pnz = d1 >= d2 ? k.n1z : k.n2z;
    const wnx = d1 >= d2 ? k.n2x : k.n1x;
    const wnz = d1 >= d2 ? k.n2z : k.n1z;
    const h = THREE.MathUtils.clamp(S.y - c.ground + r.range(-0.75, 0.15), 0.8, k.top - 0.2);
    const back = r.range(0.05, 0.14);
    out.p.set(k.x - wnx * back, c.ground + h, k.z - wnz * back);
    out.n.set(pnx, 0, pnz);
    const tilt = r.range(-0.35, 0.35);
    out.f.set(wnx * Math.cos(tilt), Math.sin(tilt), wnz * Math.cos(tilt));
    out.grip = Grip.Wrap;
    out.curl = r.range(0.8, 1.35);
    out.spread = r.range(0, 0.2);
    out.prio = turning ? 80 : 55;
    out.until = c.time + r.range(1.6, 3.2);
    out.ax = wnx;
    out.az = wnz;
    out.lag = 0;
    out.h = h;
    return true;
  }

  /** A table, counter, bed or chair top within reach: rest a hand on it / push off it. */
  private top(i: number, arm: number, side: number, S: THREE.Vector3, c: AffordCtx, out: HandGoal): boolean {
    if (c.quad) return false;
    const t = this.world.tops[i];
    if (t.y < c.ground + 0.3 || t.y > c.ground + 1.35) return false;
    if (S.y - t.y < 0.3) return false;
    // Nearest point of the top to the shoulder (a little inside the edge), a bit ahead.
    const ax = S.x + c.fx * 0.25;
    const az = S.z + c.fz * 0.25;
    const m = 0.08;
    const px = THREE.MathUtils.clamp(ax, t.minX + m, t.maxX - m);
    const pz = THREE.MathUtils.clamp(az, t.minZ + m, t.maxZ - m);
    const dx = px - c.x;
    const dz = pz - c.z;
    if ((dx * c.rx + dz * c.rz) * side < -0.05 || dx * c.fx + dz * c.fz < -0.15) return false;
    _v.set(px - S.x, t.y - S.y, pz - S.z);
    if (_v.length() > c.reach * 0.9) return false;
    const moving = c.speed > 0.15;
    if (!moving && !c.idle) return false;
    const key = (Feat.Top << 16) | i;
    if (!this.decide(key, arm, moving ? AFFORD.top : AFFORD.topIdle, c.time)) return false;
    const r = this.begin(out, 'top', key, arm);
    out.p.set(px + r.signed() * 0.05, t.y, pz + r.signed() * 0.05);
    out.p.x = THREE.MathUtils.clamp(out.p.x, t.minX + 0.04, t.maxX - 0.04);
    out.p.z = THREE.MathUtils.clamp(out.p.z, t.minZ + 0.04, t.maxZ - 0.04);
    out.n.set(0, 1, 0);
    // Fingers forward and splayed outward, varied.
    const a = Math.atan2(c.fx, c.fz) + side * r.range(0.1, 0.7);
    out.f.set(Math.sin(a), 0, Math.cos(a));
    out.grip = r.chance(0.6) ? Grip.Palm : Grip.Tips;
    out.curl = out.grip === Grip.Palm ? r.range(0.05, 0.3) : r.range(0.5, 0.9);
    out.spread = r.range(0.1, 0.35);
    out.prio = 60;
    out.until = c.time + (moving ? r.range(1.2, 2.6) : r.range(2.5, 6));
    out.ax = out.az = 0;
    out.lag = 0;
    out.h = t.y - c.ground;
    return true;
  }

  /** A wall face beside it: brace a hand on it, or trail the fingertips along it. */
  private wall(i: number, arm: number, side: number, S: THREE.Vector3, c: AffordCtx, out: HandGoal): boolean {
    if (c.quad) return false;
    const f = this.world.faces[i];
    // The face must face the body from this hand's side.
    if ((f.nx * c.rx + f.nz * c.rz) * side > -0.55) return false;
    const d = f.nx !== 0 ? (S.x - f.plane) * f.nx : (S.z - f.plane) * f.nz;
    if (d < 0.1 || d > c.reach * 0.8) return false;
    const listening = c.listening && c.speed < 0.1;
    if (!listening && c.speed < 0.2) return false;
    if (Math.abs(c.vx * f.nx + c.vz * f.nz) > 0.55 && !listening) return false;
    const key = (Feat.Face << 16) | i;
    if (!this.decide(key, arm, listening ? AFFORD.ear : AFFORD.wall, c.time, 3)) return false;
    const r = this.begin(out, listening ? 'ear' : 'wall', key, arm);
    const trail = !listening && r.chance(0.55);
    if (trail) out.kind = 'trail';
    const lead = trail ? -r.range(0.15, 0.45) : r.range(0.15, 0.45);
    // Along the face: from the shoulder, ahead (brace) or behind (trail).
    let a = f.nx !== 0 ? S.z + c.fz * lead : S.x + c.fx * lead;
    if (a < f.a0 + 0.12 || a > f.a1 - 0.12) return false;
    a = THREE.MathUtils.clamp(a, f.a0 + 0.12, f.a1 - 0.12);
    const h = THREE.MathUtils.clamp(S.y - c.ground + r.range(-0.6, 0.2), 0.45, Math.min(f.top - 0.15, 2.1));
    if (f.nx !== 0) out.p.set(f.plane, c.ground + h, a);
    else out.p.set(a, c.ground + h, f.plane);
    // Never onto a spot hidden by something else in front of the face.
    if (this.world.blocked(out.p.x + f.nx * 0.04, out.p.z + f.nz * 0.04, 0.05) && out.p.y < 1.4) return false;
    out.n.set(f.nx, 0, f.nz);
    // Fingers: forward along the wall (brace) or trailing back (drag), tipped up/down.
    const along = trail ? -1 : 1;
    const tilt = trail ? r.range(-0.6, -0.15) : r.range(-0.35, 0.65);
    const tx = f.nx !== 0 ? 0 : 1;
    const tz = f.nx !== 0 ? 1 : 0;
    const dirSign = Math.sign(tx * c.fx + tz * c.fz) || 1;
    out.f.set(tx * dirSign * along * Math.cos(tilt), Math.sin(tilt), tz * dirSign * along * Math.cos(tilt));
    out.grip = trail ? Grip.Trail : r.chance(0.65) ? Grip.Palm : Grip.Tips;
    out.curl = trail ? r.range(0.3, 0.7) : out.grip === Grip.Palm ? r.range(0.0, 0.25) : r.range(0.45, 0.85);
    out.spread = r.range(0.15, 0.45);
    out.prio = listening ? 45 : 40;
    out.until = c.time + (trail ? r.range(1.5, 4) : listening ? r.range(2, 5) : r.range(0.8, 1.8));
    out.ax = f.nx !== 0 ? 0 : 1;
    out.az = f.nx !== 0 ? 1 : 0;
    out.lag = -lead;
    out.h = h;
    return true;
  }

  /** A moonlit window in front of it while it stands and listens: hands flat on the glass. */
  private window(i: number, arm: number, side: number, S: THREE.Vector3, c: AffordCtx, out: HandGoal): boolean {
    if (!c.idle || c.quad) return false;
    const wd = this.world.windows[i];
    const dx = wd.cx - c.x;
    const dz = wd.cz - c.z;
    if (Math.hypot(dx, dz) > 1.6 || dx * c.fx + dz * c.fz < 0.25) return false;
    // In front of the glass (on the room side).
    if (-(dx * wd.nx + dz * wd.nz) < 0.2) return false;
    const key = (Feat.Window << 16) | i;
    // Both hands share the decision (same key for both arms).
    if (!this.mem.decide(key, AFFORD.window, c.time, this.seed, 4)) return false;
    const r = this.begin(out, 'window', key, arm);
    // Which side of the glass this hand takes: by the hand's side relative to the window axis.
    const tSide = Math.sign(wd.tx * c.rx + wd.tz * c.rz) * side || side;
    const u = tSide * r.range(0.12, Math.max(0.15, wd.halfW - 0.08));
    const v = r.range(-0.3, 0.45) * wd.halfH;
    out.p.set(wd.cx + wd.tx * u, wd.cy + v, wd.cz + wd.tz * u);
    _v.set(out.p.x - S.x, out.p.y - S.y, out.p.z - S.z);
    if (_v.length() > c.reach * 1.05) return false;
    out.n.set(wd.nx, 0, wd.nz);
    const tilt = Math.PI / 2 - r.range(0.0, 0.5) * tSide;
    out.f.set(wd.tx * Math.cos(tilt) * tSide, Math.sin(tilt), wd.tz * Math.cos(tilt) * tSide);
    out.grip = Grip.Palm;
    out.curl = r.range(0.0, 0.2);
    out.spread = r.range(0.25, 0.5);
    out.prio = 70;
    out.until = c.time + r.range(3, 7);
    out.ax = out.az = 0;
    out.lag = 0;
    out.h = out.p.y - c.ground;
    return true;
  }

  /** Rarely, walking tall under the open ceiling, a hand brushes up along it. */
  private ceiling(arm: number, side: number, S: THREE.Vector3, c: AffordCtx, out: HandGoal): boolean {
    if (c.quad || c.speed < 0.3 || c.headroom < 2.6) return false;
    const reachUp = c.headroom - S.y;
    if (reachUp > c.reach * 0.8 || reachUp < 0.2) return false;
    const bucket = Math.floor(c.time / 5);
    const key = (6 << 16) | (bucket & 0xffff);
    if (!this.decide(key, arm, AFFORD.ceiling, c.time, 5)) return false;
    const r = this.begin(out, 'ceiling', key, arm);
    out.p.set(S.x + c.fx * 0.25 + c.rx * side * 0.2, c.headroom, S.z + c.fz * 0.25 + c.rz * side * 0.2);
    if (this.world.blocked(out.p.x, out.p.z)) return false;
    out.n.set(0, -1, 0);
    out.f.set(-c.fx, 0, -c.fz);
    out.grip = Grip.Trail;
    out.curl = r.range(0.25, 0.6);
    out.spread = r.range(0.2, 0.4);
    out.prio = 15;
    out.until = c.time + r.range(1.0, 2.2);
    out.ax = c.fx;
    out.az = c.fz;
    out.lag = r.range(0.1, 0.3);
    out.h = c.headroom - c.ground;
    return true;
  }

  /**
   * Is the hand's current goal still worth holding? `stretch` is the arm's reach ratio to it.
   * Updates moving goals (trails slide along their surface).
   */
  keep(g: HandGoal, arm: 0 | 1, c: AffordCtx, stretch: number): boolean {
    if (g.kind === 'none') return false;
    if (c.time > g.until) return false;
    const S = c.shoulder[arm];
    switch (g.kind) {
      case 'jamb': {
        if (c.door < 0) return false;
        // Released once the shoulder has passed it (pushes off behind).
        const behind = (S.x - g.p.x) * g.ax + (S.z - g.p.z) * g.az;
        return behind < 0.3 && stretch < 1.04;
      }
      case 'corner': {
        const behind = -((g.p.x - S.x) * c.fx + (g.p.z - S.z) * c.fz);
        return behind < 0.35 && stretch < 1.02;
      }
      case 'top':
      case 'wall':
      case 'ear':
      case 'window': {
        const behind = -((g.p.x - S.x) * c.fx + (g.p.z - S.z) * c.fz);
        return behind < 0.3 && stretch < 1.0;
      }
      case 'trail':
        return stretch < 1.0;
      case 'ceiling': {
        if (c.headroom < 2.6) return false;
        // Slides along overhead, trailing the shoulder.
        g.p.set(S.x - c.fx * g.lag + c.rx * (arm === 0 ? -0.2 : 0.2), c.headroom, S.z - c.fz * g.lag + c.rz * (arm === 0 ? -0.2 : 0.2));
        g.f.set(-c.fx, 0, -c.fz);
        return stretch < 1.0 && !this.world.blocked(g.p.x, g.p.z);
      }
      case 'touch':
        return true;
      default:
        return false;
    }
  }

  /** Slide a wall trail along its face with the shoulder; false when the face runs out. */
  slideTrail(g: HandGoal, arm: 0 | 1, c: AffordCtx): boolean {
    const S = c.shoulder[arm];
    const key = g.key & 0xffff;
    const f = this.world.faces[key];
    if (!f) return false;
    const a = f.nx !== 0 ? S.z - c.fz * g.lag : S.x - c.fx * g.lag;
    if (a < f.a0 + 0.08 || a > f.a1 - 0.08) return false;
    if (f.nx !== 0) g.p.z = a;
    else g.p.x = a;
    g.p.y = c.ground + g.h;
    return true;
  }
}
