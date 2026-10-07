/**
 * Step planning: every supporting limb (legs, and the long arms when it goes on all fours) stays
 * planted at a world position until it has to step, then swings to a target planned from the
 * predicted body motion. Nothing is a cycle: a limb steps when its own error passes a threshold
 * that is re-drawn every step (seeded), and every step draws its own duration, lead, lift, landing
 * jitter and style, so no two steps are alike and nothing is periodic.
 *
 * Sequencing:
 *  - upright: one foot at a time (both down for a moment between steps), except a run, which
 *    may leave the ground briefly;
 *  - on all fours: never both limbs of one side, never both front or both hind limbs at once
 *    (diagonal pairs at most), one at a time when slow.
 *
 * Plain three.js math (Vector3), no scene objects, no per-frame allocations.
 */

import * as THREE from 'three';
import { hashKey, Rng } from './noise';

export interface Limb {
  readonly index: number;
  /** -1 = left, +1 = right. */
  readonly side: -1 | 1;
  /** An arm (a front leg on all fours). */
  readonly front: boolean;
  /** Part of the support set right now. */
  active: boolean;
  planted: boolean;
  /** Contact point (level space, y = surface height). Never moves while planted. */
  readonly pos: THREE.Vector3;
  yaw: number;
  /** Swing progress 0..1 and duration (s). */
  t: number;
  dur: number;
  readonly from: THREE.Vector3;
  fromYaw: number;
  readonly to: THREE.Vector3;
  toYaw: number;
  lift: number;
  hover: number;
  /** Seconds since it landed (planted) or lifted (swinging). */
  since: number;
  /** Steps taken (seeds each step's variation). */
  steps: number;
  /** Where it is right now (= pos while planted). */
  readonly cur: THREE.Vector3;
  curYaw: number;
  /** Per-step style draws in [0, 1): the body uses them for splay, curl, toe angle... */
  styleA: number;
  styleB: number;
  styleC: number;
  /** IK reach ratio from the last frame (written by the body). */
  stretch: number;
  /** How badly it wants to step (>= 1: it will when allowed). */
  urge: number;
  justLanded: boolean;
  /** Per-step landing offsets in the home frame (forward, right) and lead time. */
  jf: number;
  jr: number;
  lead: number;
  jyaw: number;
  /** Per-step trigger threshold scale. */
  thrScale: number;
}

/** What the planner needs from the body. */
export interface StepHost {
  /** Home contact for `limb` `t` seconds ahead (level space): sets out.x / out.z, returns its yaw. */
  home(limb: Limb, t: number, out: THREE.Vector3): number;
  /** Make a contact target valid in place (out.x / out.z) and set out.y to the surface height. */
  place(limb: Limb, out: THREE.Vector3): void;
  /** Highest surface between two points (swing clearance). */
  clearance(a: THREE.Vector3, b: THREE.Vector3): number;
}

export interface StepParams {
  swing: number;
  stance: number;
  lift: number;
  minThr: number;
  minDouble: number;
  hover: number;
  /** Body speed (m/s). */
  speed: number;
  quad: boolean;
  /** Max limbs in the air at once. */
  maxSwing: number;
  /** Yaw error (rad) that triggers a step. */
  yawThr: number;
  /** Running: an upright run may have both feet off the ground for a moment. */
  flight: boolean;
}

export const newStepParams = (): StepParams => ({
  swing: 0.5, stance: 0.6, lift: 0.1, minThr: 0.15, minDouble: 0.08, hover: 0, speed: 0, quad: false, maxSwing: 1, yawThr: 0.5, flight: false,
});

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function newLimb(index: number, side: -1 | 1, front: boolean): Limb {
  return {
    index, side, front, active: !front, planted: true,
    pos: new THREE.Vector3(), yaw: 0, t: 0, dur: 0.5,
    from: new THREE.Vector3(), fromYaw: 0, to: new THREE.Vector3(), toYaw: 0,
    lift: 0.1, hover: 0, since: 1, steps: 0, cur: new THREE.Vector3(), curYaw: 0,
    styleA: 0.5, styleB: 0.5, styleC: 0.5, stretch: 0.8, urge: 0, justLanded: false,
    jf: 0, jr: 0, lead: 0, jyaw: 0, thrScale: 1,
  };
}

/** Position along a limb's swing at its current t (level space) and its yaw. */
export function evalSwing(l: Limb, out: THREE.Vector3): number {
  const t = Math.min(1, Math.max(0, l.t));
  const th = 1 - Math.min(0.6, l.hover);
  // Horizontal: arrives at th (before the end when hovering), smootherstep.
  const u = Math.min(1, t / th);
  const e = u * u * u * (u * (u * 6 - 15) + 10);
  out.x = l.from.x + (l.to.x - l.from.x) * e;
  out.z = l.from.z + (l.to.z - l.from.z) * e;
  // Vertical: lift fast, place slow; a hover ends high and lowers it deliberately.
  const hoverH = l.hover > 0 ? 0.32 : 0;
  let arc: number;
  if (t < th) arc = Math.sin(Math.PI * Math.pow(u, 0.8)) * (1 - hoverH * smooth(0.5, 1, u)) + hoverH * smooth(0.5, 1, u);
  else {
    const v = (t - th) / (1 - th);
    arc = hoverH * (1 - v * v * (3 - 2 * v));
  }
  const ey = smooth(0, 0.8, t);
  out.y = l.from.y + (l.to.y - l.from.y) * ey + l.lift * arc;
  return l.fromYaw + wrap(l.toYaw - l.fromYaw) * e;
}

export class StepPlanner {
  readonly limbs: Limb[];
  private readonly rng = new Rng(1);
  private readonly tmp = new THREE.Vector3();

  /** Limbs 0/1 = left/right leg, 2/3 = left/right arm. */
  constructor(private readonly seed: number) {
    this.limbs = [newLimb(0, -1, false), newLimb(1, 1, false), newLimb(2, -1, true), newLimb(3, 1, true)];
  }

  /** Plant every active limb at its home (first frame, teleports). */
  reset(host: StepHost): void {
    for (const l of this.limbs) {
      l.yaw = host.home(l, 0, l.pos);
      host.place(l, l.pos);
      l.planted = true;
      l.since = 1;
      l.t = 0;
      l.cur.copy(l.pos);
      l.curYaw = l.yaw;
      l.stretch = 0.8;
      l.urge = 0;
    }
  }

  /** Bring a limb into the support set: it swings from `from` (e.g. where the hand is now). */
  activate(l: Limb, from: THREE.Vector3, fromYaw: number, p: StepParams, host: StepHost): void {
    l.active = true;
    l.pos.copy(from);
    l.yaw = fromYaw;
    l.planted = true;
    this.startSwing(l, p, host, 1);
  }

  deactivate(l: Limb): void {
    l.active = false;
  }

  update(dt: number, p: StepParams, host: StepHost): void {
    const L = this.limbs;
    for (const l of L) {
      l.justLanded = false;
      l.since += dt;
    }
    // 1. Swings: advance, keep re-aiming the landing early on, land.
    for (const l of L) {
      if (l.planted) {
        l.cur.copy(l.pos);
        l.curYaw = l.yaw;
        continue;
      }
      l.t += dt / l.dur;
      if (l.t < 0.7 && l.active) {
        const yaw = this.target(l, Math.max(0, (1 - l.t) * l.dur) + l.lead, host, this.tmp);
        const k = 1 - Math.exp(-dt * 9);
        l.to.lerp(this.tmp, k);
        // Blending two valid spots can cut through furniture: validate the blend too.
        host.place(l, l.to);
        l.toYaw += wrap(yaw - l.toYaw) * k;
      }
      if (l.t >= 1) {
        l.t = 1;
        l.planted = true;
        l.pos.copy(l.to);
        l.yaw = l.toYaw;
        l.since = 0;
        l.steps++;
        l.justLanded = true;
        l.cur.copy(l.pos);
        l.curYaw = l.yaw;
      } else {
        l.curYaw = evalSwing(l, l.cur);
      }
    }
    // 2. Urgency of every planted support limb.
    const thrBase = Math.max(p.minThr, p.speed * p.stance * 0.5);
    for (const l of L) {
      l.urge = 0;
      if (!l.active || !l.planted) continue;
      const hy = host.home(l, 0, this.tmp);
      const err = Math.hypot(l.pos.x - this.tmp.x, l.pos.z - this.tmp.z);
      const yawErr = Math.abs(wrap(l.yaw - hy));
      l.urge = Math.max(err / (thrBase * l.thrScale), yawErr / p.yawThr, (l.stretch - 0.94) / 0.06);
    }
    // 3. Lift the most urgent limb that sequencing allows (a diagonal partner may join a fast gait).
    let best: Limb | null = null;
    for (const l of L) if (l.urge >= 1 && this.canLift(l, p) && (!best || l.urge > best.urge)) best = l;
    if (best) {
      this.startSwing(best, p, host, best.urge);
      if (p.quad && p.maxSwing >= 2 && p.speed > 1.2) {
        // Diagonal partner: left leg (0) <-> right arm (3), right leg (1) <-> left arm (2).
        const partner = L[3 - best.index];
        if (partner.urge > 0.55 && this.canLift(partner, p)) this.startSwing(partner, p, host, partner.urge);
      }
    }
  }

  /** Sequencing rules (see the file header). */
  canLift(l: Limb, p: StepParams): boolean {
    if (!l.active || !l.planted || l.since < 0.06) return false;
    let swinging = 0;
    const desperate = l.urge > 2.4;
    // Upright and dragged past its reach (a sudden burst of speed): scramble, feet briefly off.
    const scramble = !p.quad && (l.urge > 3 || l.stretch > 0.99);
    for (const o of this.limbs) {
      if (o === l || !o.active) continue;
      if (!o.planted) {
        swinging++;
        if (p.quad) {
          if (o.side === l.side || o.front === l.front) return false;
        } else if (!(p.flight && o.t > 0.72) && !(scramble && o.t > 0.35)) return false;
      } else if (!p.quad && o.since < p.minDouble && !desperate) return false;
    }
    return swinging < p.maxSwing || (scramble && swinging < 2);
  }

  /** Landing target for a step that lands in `ahead` seconds. Returns its yaw. */
  private target(l: Limb, ahead: number, host: StepHost, out: THREE.Vector3): number {
    const yaw = host.home(l, ahead, out);
    // Jitter in the home frame (forward = -Z rotated by yaw, right = +X rotated by yaw).
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    out.x += -s * l.jf + c * l.jr;
    out.z += -c * l.jf - s * l.jr;
    host.place(l, out);
    return yaw + l.jyaw;
  }

  private startSwing(l: Limb, p: StepParams, host: StepHost, urge: number): void {
    const r = this.rng.seed(hashKey(this.seed * 7 + l.index, l.steps));
    l.styleA = r.next();
    l.styleB = r.next();
    l.styleC = r.next();
    const hurry = urge > 1.7 ? 0.8 : 1;
    l.dur = Math.max(0.12, p.swing * r.range(0.84, 1.2) * hurry);
    const moving = Math.min(1, p.speed / 0.3);
    l.lead = p.stance * 0.5 * r.range(0.75, 1.2) * moving;
    l.jf = r.signed() * 0.045 * moving;
    l.jr = r.signed() * (l.front ? 0.06 : 0.03);
    l.jyaw = r.signed() * (l.front ? 0.3 : 0.13);
    l.thrScale = r.range(0.82, 1.25);
    l.from.copy(l.pos);
    l.fromYaw = l.yaw;
    l.toYaw = this.target(l, l.dur + l.lead, host, l.to);
    l.lift = p.lift * r.range(0.65, 1.35);
    // Clear whatever is between here and there (stepping up onto / over furniture).
    const over = host.clearance(l.from, l.to) - Math.max(l.from.y, l.to.y);
    if (over > -0.05) l.lift = Math.max(l.lift, over + 0.12);
    l.lift += Math.abs(l.to.y - l.from.y) * 0.35;
    l.hover = p.hover > 0 ? p.hover * r.range(0.6, 1.4) : 0;
    l.planted = false;
    l.t = 0;
    l.since = 0;
  }
}
