/**
 * The procedural monster body: turns the networked MonsterState (position, yaw, speed, mode,
 * alert + the body-language contract: gait, posture, act, actStart, focus) and the level geometry
 * into a full-body pose every frame. Nothing here loops: steps are planned one at a time from the
 * predicted motion (steps.ts), hands pick what to touch from the geometry around them
 * (affordances.ts), and the trunk, head, jaw, ears and fingers are driven by springs, seeded
 * noise and the moment's context.
 *
 * Frames: "level" space is the space MonsterState lives in; "model" space is the rig's own frame
 * (origin on the ground under the body, -Z forward, +Y up), placed at the smoothed root with the
 * smoothed yaw (this.root / this.rootYaw). The pose is written into the rig's buffers; the caller
 * copies it onto the bones (optionally blended with an authored clip).
 */

import * as THREE from 'three';
import type { MonsterAct, MonsterGait, MonsterMode, MonsterState } from '../../../core/types';
import { Affordances, copyGoal, Grip, newAffordCtx, newGoal, type HandGoal } from './affordances';
import { GAITS, GaitSelector, lerpGait, newGaitParams, QUAD_GAITS, readAct, readGait, readPosture, StanceSelector, SWEEP } from './gait';
import { aimQuat, solveTwoBone } from './ik';
import { MotionTracker } from './motion';
import { fbm1, hashKey, noise1, Rng } from './noise';
import type { MonsterRig } from './rig';
import { damp, Spring, Twitch } from './springs';
import { newStepParams, StepPlanner, type Limb, type StepHost } from './steps';
import { Feat, type MonsterWorld } from './world';

/** Body tuning (meters / radians / seconds). */
export const BODY = {
  /** Hips height on all fours, crawling and galloping. */
  quadHip: 0.8,
  quadHipRun: 0.9,
  /** Hips sit this far behind the root on all fours (the shoulders as far ahead). */
  quadHipBack: 0.36,
  /** Trunk pitch on all fours (rad): hips / each spine segment. */
  quadHipPitch: 1.02,
  quadSpinePitch: 0.13,
  /** Home contacts on all fours (right, forward) offsets. */
  quadFoot: { r: 0.3, f: -0.4 },
  quadHand: { r: 0.5, f: 0.74, runReach: 0.28 },
  /** Leg stays within this share of its length (the hips drop to keep it). */
  legReach: 0.965,
  armReach: 0.97,
  /** Head top clearance under a lintel / the ceiling. */
  headClear: 0.07,
  /** Foot / hand contact radius for placement. */
  footR: 0.09,
  handR: 0.07,
  /** Free hands: hang offset (right, up, forward) from the model origin. */
  hang: { r: 0.4, y: 1.05, f: 0.14 },
  creepHands: { r: 0.36, y: 1.4, f: 0.62 },
  /** Max shoulder (clavicle) shrug / protraction (rad). */
  shrug: 0.32,
  /** How far ahead it notices a doorway / overhead (m). */
  doorAhead: 2.0,
  /** Body width it needs (m): narrower than this between solids, it turns its shoulders. */
  squeezeWidth: 1.2,
} as const;

const LEFT = new THREE.Vector3(-1, 0, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, -1);

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// Scratch (module level: the body never re-enters itself).
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _end = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
/** Trunk weights / unfold rates / head-aim chain shares (bottom-up). */
const SPINE_W = [0.22, 0.26, 0.3] as const;
const UNFOLD = [3.2, 2.6, 2.0, 1.6, 1.25, 1.0] as const;
const AIM_W = [0.3, 0.4, 1] as const;
const AIM_LIM = [0.55, 0.6, 0.75] as const;

interface Arm {
  i: 0 | 1;
  side: -1 | 1;
  goal: HandGoal;
  cand: HandGoal;
  /** 0 free (spring), 1 reaching a contact, 2 holding it. */
  mode: 0 | 1 | 2;
  /** Wrist target (level). */
  readonly wrist: THREE.Vector3;
  readonly vel: THREE.Vector3;
  readonly from: THREE.Vector3;
  t: number;
  dur: number;
  /** Desired hand frame for the contact (level directions). */
  readonly fdir: THREE.Vector3;
  readonly palm: THREE.Vector3;
  /** Blend of the hand orientation / fingers toward the contact (0..1). */
  contactW: number;
  /** 0 = brain (free / affordance), 1 = support limb on all fours. */
  supportW: number;
  readonly curl: Float32Array;
  spread: number;
  stretch: number;
  /** Elbow direction blend: 0 hanging (back/out), 1 reaching (out/up). */
  reachW: number;
  delay: number;
  twitch: Twitch;
  /** Free-target spring tuning this frame. */
  omega: number;
  zeta: number;
  /** Search touches made (seeds each one). */
  touchN: number;
  /** Door pass whose jamb this hand already used; when the second hand may reach. */
  jambPass: number;
  /** Next affordance scan (s). */
  scanAt: number;
}

interface DoorPass {
  id: number;
  sign: number;
  s: number;
  u: number;
  seed: number;
  extra: number;
  roll: number;
  twist: number;
  lowAt: number;
}

export class ProceduralBody implements StepHost {
  /** Root placement (level): ground under the body center, and the body yaw. */
  readonly root = new THREE.Vector3();
  rootYaw = 0;
  /** Resolved state, for debugging / sound hooks. */
  gait: MonsterGait = 'still';
  act: MonsterAct = 'none';
  quad = false;

  private readonly motion = new MotionTracker();
  private readonly gaitSel = new GaitSelector();
  private readonly stanceSel = new StanceSelector();
  private readonly planner: StepPlanner;
  private world: MonsterWorld | null = null;
  private afford: Affordances | null = null;
  private readonly ctx = newAffordCtx();
  private readonly arms: [Arm, Arm];
  private readonly rng: Rng;
  private readonly seed: number;
  private time = 0;
  private initialized = false;
  // Act timing.
  private actT = 0;
  private lastAct = '';
  private lastActStart = NaN;
  private actSeed = 0;
  private mode: MonsterMode = 'wander';
  private alert = 0;
  // Focus / head.
  private readonly focus = new THREE.Vector3();
  private hasFocus = false;
  private readonly prevFocus = new THREE.Vector3();
  private snapT = 0;
  private readonly look = new THREE.Vector3();
  private readonly lookVel = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private hasTarget = false;
  // Smoothed posture.
  private readonly quadW = new Spring(0);
  private readonly crouch = new Spring(0);
  private readonly hunch = new Spring(0);
  private readonly lean = new Spring(0);
  private readonly sideLean = new Spring(0);
  private readonly twist = new Spring(0);
  private readonly roll = new Spring(0);
  private readonly squeeze = new Spring(0);
  private readonly hipShift = new Spring(0);
  private readonly bob = new Spring(0);
  /** Duck (m of head drop) per trunk segment: hips, spine 1-3, neck, neck_2 (unfold lags up). */
  private readonly duckSeg = new Float32Array(6);
  private duckNeed = 0;
  private readonly gp = newGaitParams();
  private readonly sp = newStepParams();
  private readonly door: DoorPass = { id: -1, sign: 1, s: 0, u: 0, seed: 0, extra: 0, roll: 0, twist: 0, lowAt: 0 };
  private doorK = 0;
  private doorPasses = 0;
  private climbHold = 0;
  private climbing = false;
  /** Furniture top it is climbing onto / over (-1 none). */
  private climbTop = -1;
  private headroom = 2.8;
  private breath = 0;
  private readonly tw = { hy: new Twitch(), hp: new Twitch(), hr: new Twitch(), sp: new Twitch(), ear: new Twitch(), jaw: new Twitch() };
  private jawOpen = new Spring(0);
  private split = new Spring(0);
  /** Optional authored deltas (Attack clip) for the split mandibles at full open. */
  private jawSplit: [THREE.Quaternion, THREE.Quaternion] | null = null;
  private readonly aimChain: number[];
  /** Idle: a point on a nearby wall its blind head slowly tracks along (level), and when to move on. */
  private readonly idleLook = new THREE.Vector3();
  private idleLookAt = -1;
  private idleFace = -1;
  /** Hips placement this frame (model space). */
  private readonly hipP = new THREE.Vector3();
  private readonly hipQ = new THREE.Quaternion();

  constructor(private readonly rig: MonsterRig, seed: number, private readonly scale = 1) {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.planner = new StepPlanner(seed);
    const arm = (i: 0 | 1): Arm => ({
      i, side: i === 0 ? -1 : 1, goal: newGoal(), cand: newGoal(), mode: 0,
      wrist: new THREE.Vector3(), vel: new THREE.Vector3(), from: new THREE.Vector3(), t: 0, dur: 0.4,
      fdir: new THREE.Vector3(0, -1, 0), palm: new THREE.Vector3(1, 0, 0), contactW: 0, supportW: 0,
      curl: new Float32Array(5).fill(0.3), spread: 0.05, stretch: 0.8, reachW: 0, delay: 0, twitch: new Twitch(),
      omega: 7, zeta: 0.5, touchN: 0, jambPass: -1, scanAt: 0,
    });
    this.arms = [arm(0), arm(1)];
    this.aimChain = [rig.neck[0], rig.neck[1], rig.head];
  }

  setWorld(world: MonsterWorld | null): void {
    this.world = world;
    this.afford = world ? new Affordances(world, this.seed) : null;
    this.door.id = -1;
    this.initialized = false;
  }

  /** Authored mandible spread (local deltas for jaw_L / jaw_R at full open). */
  setJawSplit(l: THREE.Quaternion, r: THREE.Quaternion): void {
    this.jawSplit = [l.clone(), r.clone()];
  }

  /** Forget contacts and springs: next update re-plants everything (after a clip took over). */
  reset(): void {
    this.initialized = false;
  }

  // -------------------------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------------------------

  private toModel(v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(this.rootYaw);
    const s = Math.sin(this.rootYaw);
    const dx = v.x - this.root.x;
    const dz = v.z - this.root.z;
    const k = 1 / this.scale;
    return out.set((dx * c - dz * s) * k, (v.y - this.root.y) * k, (dx * s + dz * c) * k);
  }

  private dirToModel(v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(this.rootYaw);
    const s = Math.sin(this.rootYaw);
    return out.set(v.x * c - v.z * s, v.y, v.x * s + v.z * c);
  }

  private toLevel(m: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(this.rootYaw);
    const s = Math.sin(this.rootYaw);
    const k = this.scale;
    return out.set(this.root.x + (m.x * c + m.z * s) * k, this.root.y + m.y * k, this.root.z + (-m.x * s + m.z * c) * k);
  }

  // -------------------------------------------------------------------------------------------
  // StepHost
  // -------------------------------------------------------------------------------------------

  home(l: Limb, t: number, out: THREE.Vector3): number {
    const M = this.motion;
    const tt = Math.min(t, 1.2);
    // Predicted root: velocity bent by the turn rate.
    const a = clamp(M.yawRate, -3, 3) * tt * 0.5;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const vx = M.vel.x * ca + M.vel.z * sa;
    const vz = -M.vel.x * sa + M.vel.z * ca;
    const px = this.root.x + vx * tt;
    const pz = this.root.z + vz * tt;
    const yaw = this.rootYaw + wrap(M.rawYaw - this.rootYaw) * Math.min(1, tt * 5);
    const q = this.quadW.x;
    const sq = this.squeeze.x;
    const k = this.rig.legs[0];
    let r: number;
    let f: number;
    if (!l.front) {
      const ballF = -k.restBall.z;
      // Idle: the stance drifts slowly (weight shifts that end in a re-step now and then).
      const idle = this.gait === 'still' && !this.quad ? 1 : 0;
      const drift = idle * 0.09 * fbm1(this.time * 0.11 + l.index * 7.3, this.seed + 11);
      const driftF = idle * 0.1 * fbm1(this.time * 0.09 + l.index * 3.1, this.seed + 12);
      r = l.side * lerp(this.gp.stanceW * (1 - 0.45 * sq), BODY.quadFoot.r, q) + drift;
      f = lerp(ballF + driftF, BODY.quadFoot.f, q);
    } else {
      r = l.side * BODY.quadHand.r;
      f = BODY.quadHand.f + (this.gait === 'run' ? BODY.quadHand.runReach : 0);
      // Through a doorway on all fours: hands at the foot of the jambs.
      if (this.doorK > 0.3 && this.world && this.door.id >= 0) r = l.side * Math.min(BODY.quadHand.r, this.world.doors[this.door.id].halfW - 0.08);
    }
    r *= this.scale;
    f *= this.scale;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    out.x = px + c * r - s * f;
    out.z = pz - s * r - c * f;
    out.y = this.root.y;
    // Climbing: contacts near the top it climbs land on it (the stance narrows to fit).
    if (this.climbTop >= 0 && this.world) {
      const tp = this.world.tops[this.climbTop];
      const e = 0.38;
      if (out.x > tp.minX - e && out.x < tp.maxX + e && out.z > tp.minZ - e && out.z < tp.maxZ + e) {
        const m = l.front ? 0.07 : 0.1;
        out.x = clamp(out.x, tp.minX + m, Math.max(tp.minX + m, tp.maxX - m));
        out.z = clamp(out.z, tp.minZ + m, Math.max(tp.minZ + m, tp.maxZ - m));
      }
    }
    return l.front ? yaw - l.side * 0.35 : yaw;
  }

  place(l: Limb, out: THREE.Vector3): void {
    if (!this.world) {
      out.y = this.root.y;
      return;
    }
    const tops = this.climbing || this.root.y > 0.02;
    out.y = this.world.placeContact(out, l.front ? BODY.handR : BODY.footR, this.root.y, tops, tops ? 0.95 : 0.25, 1.0);
  }

  clearance(a: THREE.Vector3, b: THREE.Vector3): number {
    if (!this.world) return Math.max(a.y, b.y);
    return this.world.maxTopAlong(a.x, a.z, b.x, b.z, this.root.y + 1.0);
  }

  // -------------------------------------------------------------------------------------------
  // Per frame
  // -------------------------------------------------------------------------------------------

  update(m: MonsterState, dt: number): void {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.time += dt;
    this.dt = dt;
    const M = this.motion;
    const snapped = M.update(m.position.x, m.position.y, m.position.z, m.yaw, dt);
    this.root.copy(M.pos);
    this.rootYaw = M.yaw;
    this.mode = m.mode;
    this.alert += (m.alert - this.alert) * damp(3, dt);
    this.readContract(m, dt);
    this.scan(dt);
    if (snapped || !this.initialized) this.init();
    this.updateGait(dt);
    this.updateSupport();
    this.planner.update(dt, this.sp, this);
    this.updateCtx();
    for (const a of this.arms) this.updateArmGoal(a, dt);
    this.solve(dt);
  }

  private readContract(m: MonsterState, dt: number): void {
    let act = readAct(m.act);
    if (m.act !== this.lastAct || m.actStart !== this.lastActStart) {
      this.lastAct = m.act;
      this.lastActStart = m.actStart;
      this.actT = 0;
      this.actSeed++;
    } else this.actT += dt;
    const speed = this.motion.speed;
    this.hasTarget = !!m.target;
    if (m.target) this.target.set(m.target.x, m.target.y, m.target.z);
    // The current sim leaves the contract at its defaults: an investigation that stopped is a listen.
    if (act === 'none' && m.mode === 'investigate' && speed < 0.2 && this.motion.stillFor > 0.25) act = 'listen';
    if (act === 'none' && m.mode === 'feeding') act = 'lurk';
    this.act = act;
    const f = m.focus ?? ((act === 'listen' || act === 'sniff' || m.mode === 'chase') && m.target ? m.target : null);
    if (f) {
      if (!this.hasFocus || Math.hypot(f.x - this.prevFocus.x, f.z - this.prevFocus.z) > 0.6) this.snapT = 0.35;
      this.focus.set(f.x, f.y, f.z);
      this.prevFocus.copy(this.focus);
      // Points on the floor read as "somewhere around there": listen at ear height.
      if (this.focus.y < 0.05 && act !== 'sniff' && act !== 'search') this.focus.y = 1.0;
    }
    this.hasFocus = !!f;
    this.snapT = Math.max(0, this.snapT - dt);
    this.gait = this.gaitSel.update(readGait(m.gait), speed, m.mode, dt);
    const posture = readPosture(m.posture);
    const reachTarget = this.reachingTarget();
    this.quad = this.stanceSel.update(posture, this.gait, speed, this.climbing, dt) && !reachTarget && act !== 'sweep' && act !== 'listen';
  }

  /** Chasing someone within arm's reach soon: it rears up and reaches. */
  private reachingTarget(): boolean {
    if (this.mode !== 'chase') return false;
    const t = this.hasTarget ? this.target : this.hasFocus ? this.focus : null;
    return !!t && Math.hypot(t.x - this.root.x, t.z - this.root.z) < 2.4;
  }

  /** Read the geometry around it: doorway, headroom, climbing, narrow gaps. */
  private scan(dt: number): void {
    const w = this.world;
    const M = this.motion;
    const fx = -Math.sin(this.rootYaw);
    const fz = -Math.cos(this.rootYaw);
    // Climbing: told to, already up on something, or about to be.
    const up = this.root.y > 0.03 || M.leadVel.y > 0.05 || this.act === 'climb';
    this.climbHold = up ? 0.8 : Math.max(0, this.climbHold - dt);
    this.climbing = this.climbHold > 0;
    if (!w) {
      this.doorK = 0;
      this.headroom = 2.8;
      return;
    }
    // What it climbs: the nearest furniture top within reach of its path.
    this.climbTop = -1;
    if (this.climbing) {
      let best = 1.3;
      w.query(this.root.x, this.root.z);
      for (let q = w.qStart; q < w.qEnd; q++) {
        const ref = w.refs[q];
        if (ref >> 16 !== Feat.Top) continue;
        const tp = w.tops[ref & 0xffff];
        if (Math.abs(tp.y - this.root.y) > 1.0) continue;
        const ax = this.root.x + fx * 0.4;
        const az = this.root.z + fz * 0.4;
        const d = Math.hypot(Math.max(0, tp.minX - ax, ax - tp.maxX), Math.max(0, tp.minZ - az, az - tp.maxZ));
        if (d < best) {
          best = d;
          this.climbTop = ref & 0xffff;
        }
      }
    }
    // Headroom over where the head is and will be.
    let hr = w.ceiling;
    for (let i = 0; i <= 3; i++) {
      const d = i * 0.35;
      hr = Math.min(hr, w.headroom(this.root.x + fx * d, this.root.z + fz * d, 0.18));
    }
    this.headroom = hr;
    // Doorway: keep the one being passed; else find the one ahead.
    const speed = M.speed;
    const dirX = speed > 0.15 ? M.vel.x / speed : fx;
    const dirZ = speed > 0.15 ? M.vel.z / speed : fz;
    const D = this.door;
    if (D.id >= 0) {
      const d = w.doors[D.id];
      D.s = D.sign * ((this.root.x - d.cx) * d.nx + (this.root.z - d.cz) * d.nz);
      D.u = (this.root.x - d.cx) * d.tx + (this.root.z - d.cz) * d.tz;
      if (D.s > 1.7 || D.s < -2.4 || Math.abs(D.u) > d.halfW + 0.7) D.id = -1;
    }
    if (D.id < 0) {
      w.query(this.root.x, this.root.z);
      for (let q = w.qStart; q < w.qEnd; q++) {
        const ref = w.refs[q];
        if (ref >> 16 !== Feat.Door) continue;
        const d = w.doors[ref & 0xffff];
        const dn = (this.root.x - d.cx) * d.nx + (this.root.z - d.cz) * d.nz;
        const toward = dirX * d.nx + dirZ * d.nz;
        if (Math.abs(toward) < 0.3) continue;
        const sign = toward > 0 ? 1 : -1;
        const s = sign * dn;
        const u = (this.root.x - d.cx) * d.tx + (this.root.z - d.cz) * d.tz;
        if (s < -BODY.doorAhead || s > 0.2 || Math.abs(u) > d.halfW + 0.4) continue;
        // Only a door its path goes through: where the heading crosses the wall, inside the gap.
        const cross = u + ((dirX * d.tx + dirZ * d.tz) * -s) / Math.abs(toward);
        if (Math.abs(cross) > d.halfW + 0.05) continue;
        D.id = d.id;
        D.sign = sign;
        D.s = s;
        D.u = u;
        this.doorPasses++;
        const r = this.rng.seed(hashKey(this.seed + d.id * 131, this.doorPasses));
        D.seed = r.next() * 1e6;
        D.extra = r.range(0.12, 0.5);
        D.roll = r.signed() * 0.38;
        D.twist = r.signed() * 0.4;
        D.lowAt = r.range(-0.9, -0.4);
        break;
      }
    }
    const kIn = D.id >= 0 ? smooth(-1.9, -0.7, D.s) * (1 - smooth(0.05, 0.75, D.s)) : 0;
    this.doorK += (kIn - this.doorK) * damp(kIn > this.doorK ? 8 : 3, dt);
    // Narrow gaps: free distance to each side at shoulder level.
    const rx = Math.cos(this.rootYaw);
    const rz = -Math.sin(this.rootYaw);
    const l = w.freeDistance(this.root.x, this.root.z, -rx, -rz, 1.0, 0.9);
    const r = w.freeDistance(this.root.x, this.root.z, rx, rz, 1.0, 0.9);
    const sq = smooth(BODY.squeezeWidth, 0.75, l + r) * (this.quad ? 0.3 : 1);
    this.squeeze.step(sq, 5, 1, dt);
  }

  private init(): void {
    this.initialized = true;
    this.quadW.set(this.quad ? 1 : 0);
    for (const s of [this.crouch, this.hunch, this.lean, this.sideLean, this.twist, this.roll, this.hipShift, this.bob]) s.set(0);
    this.duckSeg.fill(0);
    this.updateGait(0);
    this.planner.reset(this);
    for (const a of this.arms) {
      a.mode = 0;
      a.goal.kind = 'none';
      a.supportW = this.quad ? 1 : 0;
      this.planner.limbs[2 + a.i].active = this.quad;
      this.freeTarget(a, a.wrist);
      a.vel.set(0, 0, 0);
      a.contactW = 0;
    }
    this.look.set(this.root.x - Math.sin(this.rootYaw) * 3, this.root.y + 1.2, this.root.z - Math.cos(this.rootYaw) * 3);
    this.lookVel.set(0, 0, 0);
  }

  private updateGait(dt: number): void {
    const q = this.quadW.step(this.quad ? 1 : 0, this.quad ? 3.2 : 2.6, 1, dt);
    const base = GAITS[this.gait];
    const quadG = this.gait === 'run' ? QUAD_GAITS.gallop : QUAD_GAITS.crawl;
    lerpGait(base, quadG, this.quad ? 1 : 0, this.gp);
    const p = this.sp;
    const speed = this.motion.speed;
    // Swing/stance shorten as it hurries within a gait.
    const ref = this.gait === 'run' ? 3 : this.gait === 'walk' ? 1 : 0.45;
    const hurry = clamp(Math.pow(Math.max(speed, 0.05) / ref, 0.3), 0.75, 1.3);
    p.swing = this.gp.swing / hurry;
    p.stance = this.gp.stance / hurry;
    p.lift = this.gp.lift * (1 + this.doorK * 0.3);
    p.minThr = this.gp.minThr * this.scale;
    p.minDouble = this.gp.minDouble;
    p.hover = this.gp.hover;
    p.speed = speed;
    p.quad = this.quad && q > 0.35;
    p.maxSwing = this.quad ? (speed > 0.7 ? 2 : 1) : 1;
    p.yawThr = this.quad ? 0.45 : this.act === 'listen' || this.act === 'lurk' ? 0.75 : 0.5;
    p.flight = this.gait === 'run';
    // Frozen while listening / lurking: only an urgent step.
    if ((this.act === 'listen' || this.act === 'lurk') && speed < 0.1) p.minThr *= 2.2;
  }

  /** Arms join / leave the support set as it goes down on all fours / rises (real steps). */
  private dt = 0;

  private updateSupport(): void {
    const q = this.quadW.x;
    for (const a of this.arms) {
      const l = this.planner.limbs[2 + a.i];
      if (this.quad && q > 0.35 && !l.active) {
        // Swing from where the hand is to the floor ahead.
        _v1.copy(a.wrist);
        _v1.y = this.root.y;
        this.planner.activate(l, _v1, this.rootYaw, this.sp, this);
        a.goal.kind = 'none';
        a.mode = 0;
      } else if ((!this.quad || q < 0.3) && l.active) {
        this.planner.deactivate(l);
        // Push off the floor into the free spring.
        a.vel.set(0, 1.6, 0);
      }
      a.supportW += ((l.active ? 1 : 0) - a.supportW) * damp(l.active ? 14 : 7, this.dt);
    }
  }

  private updateCtx(): void {
    const c = this.ctx;
    const M = this.motion;
    c.time = this.time;
    c.x = this.root.x;
    c.y = this.root.y;
    c.z = this.root.z;
    c.fx = -Math.sin(this.rootYaw);
    c.fz = -Math.cos(this.rootYaw);
    c.rx = Math.cos(this.rootYaw);
    c.rz = -Math.sin(this.rootYaw);
    c.speed = M.speed;
    c.vx = M.speed > 0.05 ? M.vel.x / M.speed : c.fx;
    c.vz = M.speed > 0.05 ? M.vel.z / M.speed : c.fz;
    c.yawRate = M.yawRate;
    c.reach = (this.rig.arms[0].lenA + this.rig.arms[0].lenB) * this.scale;
    c.ground = this.root.y;
    c.quad = this.quad || this.quadW.x > 0.3;
    const still = M.speed < 0.1;
    c.idle = still && (this.act === 'none' || this.act === 'listen' || this.act === 'lurk') && this.mode !== 'chase';
    c.listening = this.act === 'listen';
    c.busy = this.act === 'sweep' || this.act === 'search' || this.reachingTarget() || this.mode === 'feeding';
    c.door = this.door.id >= 0 && this.doorK > 0.05 ? this.door.id : -1;
    if (c.door >= 0 && this.world) {
      const d = this.world.doors[c.door];
      c.dnx = d.nx * this.door.sign;
      c.dnz = d.nz * this.door.sign;
      c.ds = this.door.s;
    }
    c.doorLow = this.quad;
    c.headroom = this.headroom;
    // Shoulders from the last pose (level).
    for (const a of this.arms) this.toLevel(this.rig.mp[this.rig.arms[a.i].upper], c.shoulder[a.i]);
  }

  // -------------------------------------------------------------------------------------------
  // Hands: what each free hand does
  // -------------------------------------------------------------------------------------------

  private updateArmGoal(a: Arm, dt: number): void {
    const af = this.afford;
    const c = this.ctx;
    const g = a.goal;
    const support = this.planner.limbs[2 + a.i].active;
    if (support) {
      g.kind = 'none';
      a.mode = 0;
    } else {
      // Act-driven surface touches (search), then geometry affordances.
      if (this.act === 'search' && this.hasFocus) this.searchGoal(a);
      else if (g.kind === 'touch') this.releaseGoal(a);
      if (af && g.kind !== 'touch') {
        if (g.kind !== 'none') {
          let keep = af.keep(g, a.i, c, a.stretch);
          if (keep && g.kind === 'trail') keep = af.slideTrail(g, a.i, c);
          if (!keep) {
            // Walls and tops: the hand walks along them (same encounter, a beat later).
            const walk = (g.kind === 'wall' || g.kind === 'top') && this.time < g.until;
            af.rest(g.key, a.i, this.time, walk ? 0.25 : g.kind === 'jamb' ? 4 : 2.5, walk);
            this.releaseGoal(a);
          }
        }
        // Door jambs first (the signature), then whatever the geometry offers.
        if (c.door < 0) a.delay = 0;
        else if (g.kind === 'corner' && this.world && this.world.corners[g.key & 0xffff].door === c.door) {
          // Already pivoting on this door's jamb: that is its grip for this pass.
          a.jambPass = this.doorPasses;
        } else if (!c.doorLow && g.kind !== 'jamb' && a.jambPass !== this.doorPasses && this.door.s < 0.15 && this.door.s > -1.75) {
          if (af.jamb(a.i, c, a.cand)) {
            const reachD = a.cand.p.distanceTo(c.shoulder[a.i]);
            // Reach once it is close enough; the second hand a beat later.
            const other = this.arms[1 - a.i];
            if (other.goal.kind === 'jamb' && a.delay === 0) a.delay = this.time + a.cand.lag;
            if (reachD < c.reach * 1.3 && (other.goal.kind !== 'jamb' || this.time >= a.delay)) {
              this.setGoal(a, a.cand);
              a.jambPass = this.doorPasses;
            }
          }
        }
        if (g.prio < 90 && this.time >= a.scanAt) {
          a.scanAt = this.time + 0.1;
          if (af.choose(a.i, c, a.cand, g.kind === 'none' ? 0 : g.prio + 15)) this.setGoal(a, a.cand);
        }
      }
    }
    this.moveHand(a, dt);
  }

  private setGoal(a: Arm, src: HandGoal): void {
    copyGoal(src, a.goal);
    a.mode = 1;
    a.from.copy(a.wrist);
    a.t = 0;
    const d = a.from.distanceTo(src.p);
    a.dur = clamp(0.24 + d * 0.32, 0.26, 0.75) * (0.85 + 0.3 * ((src.seed >>> 3) % 100) / 100);
  }

  private releaseGoal(a: Arm): void {
    if (a.goal.kind === 'none') return;
    // Push off the surface: a little velocity out of it and back.
    a.vel.copy(a.goal.n).multiplyScalar(0.9);
    a.vel.x -= this.ctx.fx * 0.4;
    a.vel.z -= this.ctx.fz * 0.4;
    a.goal.kind = 'none';
    a.goal.prio = 0;
    a.mode = 0;
  }

  /** Search: feel the surfaces around the focus, one hand after the other. */
  private searchGoal(a: Arm): void {
    const g = a.goal;
    const other = this.arms[1 - a.i];
    if (g.kind === 'touch' && this.time < g.until) return;
    // Alternate: this hand goes when the other is holding (or idle) and it is "its turn".
    const turn = (Math.floor(this.actT / 0.9) + this.actSeed) % 2 === a.i;
    if (!turn && other.goal.kind === 'touch' && other.mode !== 2) {
      if (g.kind === 'touch') this.releaseGoal(a);
      return;
    }
    if (g.kind === 'touch') this.releaseGoal(a);
    if (!turn) return;
    a.touchN++;
    const r = this.rng.seed(hashKey(this.seed + this.actSeed * 17 + a.i, a.touchN));
    const ang = r.range(0, Math.PI * 2);
    const rad = r.range(0.08, 0.45);
    _v1.set(this.focus.x + Math.cos(ang) * rad, 0, this.focus.z + Math.sin(ang) * rad);
    // Keep it on its own side of the body.
    const lat = (_v1.x - this.root.x) * this.ctx.rx + (_v1.z - this.root.z) * this.ctx.rz;
    if (lat * a.side < -0.15) {
      _v1.x -= this.ctx.rx * lat * 1.2;
      _v1.z -= this.ctx.rz * lat * 1.2;
    }
    const y = this.world ? this.world.supportAt(_v1.x, _v1.z, this.root.y + 1.3) : 0;
    if (this.world && this.world.blocked(_v1.x, _v1.z, y + 0.05)) return;
    g.kind = 'touch';
    g.key = -1;
    g.p.set(_v1.x, Math.max(y, this.root.y), _v1.z);
    g.n.set(0, 1, 0);
    const fa = Math.atan2(_v1.x - this.root.x, _v1.z - this.root.z) + r.signed() * 0.6;
    g.f.set(Math.sin(fa), 0, Math.cos(fa));
    g.grip = r.chance(0.55) ? Grip.Tips : Grip.Palm;
    g.curl = r.range(0.3, 0.8);
    g.spread = r.range(0.2, 0.45);
    g.prio = 50;
    g.until = this.time + r.range(0.9, 1.7);
    g.seed = r.next() * 1e9;
    g.h = 0;
    this.setGoal(a, g);
  }

  /** Wrist target and hand frame for a surface goal (level). */
  private goalWrist(a: Arm, g: HandGoal, out: THREE.Vector3): void {
    const arm = this.rig.arms[a.i];
    const pl = (arm.handLen * 0.42) * this.scale;
    const t = this.time;
    switch (g.grip) {
      case Grip.Tips: {
        // Claw: fingertips down on it, wrist raised off the surface.
        a.fdir.copy(g.f).multiplyScalar(0.62).addScaledVector(g.n, -0.78).normalize();
        out.copy(g.p).addScaledVector(g.n, 0.15 * this.scale).addScaledVector(g.f, -pl * 0.9);
        break;
      }
      case Grip.Trail: {
        a.fdir.copy(g.f).multiplyScalar(0.8).addScaledVector(g.n, -0.6).normalize();
        out.copy(g.p).addScaledVector(g.n, 0.1 * this.scale).addScaledVector(g.f, -pl * 1.3);
        break;
      }
      case Grip.Wrap: {
        a.fdir.copy(g.f);
        out.copy(g.p).addScaledVector(g.f, -pl * 0.5).addScaledVector(g.n, 0.035 * this.scale);
        break;
      }
      default: {
        a.fdir.copy(g.f);
        out.copy(g.p).addScaledVector(g.f, -pl * 0.6).addScaledVector(g.n, 0.035 * this.scale);
      }
    }
    a.palm.copy(g.n).negate();
    // Searching fingers creep a little over the surface.
    if (g.kind === 'touch' && a.mode === 2) {
      out.x += 0.025 * noise1(t * 1.7 + a.i * 5, this.seed + 3);
      out.z += 0.025 * noise1(t * 1.5 + a.i * 9, this.seed + 4);
    }
  }

  private moveHand(a: Arm, dt: number): void {
    const g = a.goal;
    if (a.mode !== 0 && g.kind !== 'none') {
      this.goalWrist(a, g, _v2);
      if (a.mode === 1) {
        a.t += dt / a.dur;
        const t = Math.min(1, a.t);
        const e = t * t * t * (t * (t * 6 - 15) + 10);
        // Arc in: come off the surface's normal side (and a little up), land pressing into it.
        const arc = Math.sin(Math.PI * Math.min(1, t * 1.05));
        a.wrist.lerpVectors(a.from, _v2, e).addScaledVector(g.n, 0.14 * arc * this.scale);
        a.wrist.y += 0.07 * arc * this.scale;
        if (a.t >= 1) a.mode = 2;
      } else {
        a.wrist.copy(_v2);
      }
      a.vel.set(0, 0, 0);
      a.contactW += (1 - a.contactW) * damp(a.mode === 2 ? 14 : 6, dt);
      a.reachW += (1 - a.reachW) * damp(5, dt);
    } else {
      this.freeTarget(a, _v2);
      // Pendulum-ish spring in level space: lags and overshoots as the body moves.
      const w = a.omega;
      const z = a.zeta;
      const n = dt > 1 / 60 ? Math.ceil(dt * 60) : 1;
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        _v3.subVectors(_v2, a.wrist).multiplyScalar(w * w).addScaledVector(a.vel, -2 * z * w);
        a.vel.addScaledVector(_v3, h);
        a.wrist.addScaledVector(a.vel, h);
      }
      a.contactW += (0 - a.contactW) * damp(5, dt);
      a.reachW += (this.freeReach - a.reachW) * damp(4, dt);
    }
  }

  /** How much the free pose reaches (elbows out/up) vs hangs. */
  private freeReach = 0;

  /** Where a free hand wants to be right now (level). Also sets its spring tuning. */
  private freeTarget(a: Arm, out: THREE.Vector3): void {
    const side = a.side;
    const t = this.time;
    const act = this.act;
    const R = this.rig;
    const H = BODY.hang;
    const sh = R.mp[R.arms[a.i].upper];
    let rr: number = H.r;
    let y: number = H.y;
    let f: number = H.f;
    a.omega = 7.5;
    a.zeta = 0.42;
    this.freeReach = 0;
    // Walking: counter-swing to the same-side leg (forward when the other leg is forward).
    const leg = this.planner.limbs[a.i];
    this.toModel(leg.cur, _v4);
    const swing = this.gait === 'walk' ? 0.55 : this.gait === 'run' ? 0.3 : 0.15;
    f += -(-_v4.z - 0.15) * swing;
    if (this.gait === 'creep' || (this.mode === 'investigate' && this.gait !== 'still' && this.gait !== 'run')) {
      // Blind creep: hands up ahead, feeling the air.
      const C = BODY.creepHands;
      rr = C.r;
      y = C.y + 0.08 * fbm1(t * 0.4 + a.i * 4, this.seed + 21);
      f = C.f + 0.1 * fbm1(t * 0.33 + a.i * 2, this.seed + 22);
      rr += 0.08 * fbm1(t * 0.27 + a.i * 6, this.seed + 23);
      a.omega = 4;
      a.zeta = 0.7;
      this.freeReach = 0.8;
    } else if (this.gait === 'run') {
      rr = 0.5;
      y = 1.05;
      f = -0.25;
      a.omega = 11;
    }
    if (this.doorK > 0.05 && !this.quad) {
      // Approaching a doorway: reaching ahead for the frame.
      rr = lerp(rr, 0.42, this.doorK);
      y = lerp(y, 1.35, this.doorK);
      f = lerp(f, 0.7, this.doorK);
      this.freeReach = Math.max(this.freeReach, this.doorK);
    }
    if (act === 'lurk') {
      rr = 0.3;
      y = 0.95 + 0.03 * fbm1(t * 0.2 + a.i, this.seed + 24);
      f = 0.22;
      a.omega = 2.5;
      a.zeta = 0.9;
    } else if (act === 'listen') {
      // Frozen mid-gesture: the hands barely drift.
      a.omega = 1.2;
      a.zeta = 1;
    } else if (act === 'sniff') {
      rr = 0.34;
      y = 0.85;
      f = 0.35;
    } else if (act === 'sweep' && this.hasFocus) {
      this.sweepTarget(a, out);
      return;
    }
    if (this.reachingTarget()) {
      // Reach for the prey: hands out toward it, claws open.
      this.toModel(this.hasTarget ? this.target : this.focus, _v4);
      _v4.y = clamp(_v4.y + 1.25, 0.8, 1.7);
      _v4.x += side * 0.22;
      _v5.subVectors(_v4, sh);
      const reach = (R.arms[a.i].lenA + R.arms[a.i].lenB) * 0.95;
      if (_v5.length() > reach) _v5.setLength(reach);
      _v4.addVectors(sh, _v5);
      a.omega = 14;
      a.zeta = 0.55;
      this.freeReach = 1;
      return void this.toLevel(_v4, out);
    }
    // Narrow gap: tuck the arms in.
    rr *= 1 - 0.35 * this.squeeze.x;
    // Unique, slow drift per arm; twitches when agitated.
    const tw = a.twitch.update(this.dt, 0.25 + this.alert * 1.2, 0.07, this.rng);
    _v4.set(
      side * rr + 0.04 * fbm1(t * 0.23 + a.i * 3.3, this.seed + 25) + tw,
      y + 0.04 * fbm1(t * 0.19 + a.i * 1.7, this.seed + 26),
      -f + 0.04 * fbm1(t * 0.21 + a.i * 8.1, this.seed + 27),
    );
    // Hands hang from the shoulders: follow the trunk's lean.
    _v4.x += (sh.x - R.restMP[R.arms[a.i].upper].x) * 0.8;
    _v4.z += (sh.z - R.restMP[R.arms[a.i].upper].z) * 0.85;
    _v4.y += (sh.y - R.restMP[R.arms[a.i].upper].y) * 0.9;
    this.toLevel(_v4, out);
  }

  /** Sweep: wind-up (the warning), a long-armed swipe through the focus, follow-through. */
  private sweepTarget(a: Arm, out: THREE.Vector3): void {
    const R = this.rig;
    this.toModel(this.focus, _v4);
    const right = _v4.x > 0 ? 1 : -1;
    const sh = R.mp[R.arms[a.i].upper];
    const reach = (R.arms[a.i].lenA + R.arms[a.i].lenB) * 0.96;
    const t = this.actT;
    const W = SWEEP.windup;
    const S = SWEEP.strike;
    const F = SWEEP.follow;
    this.freeReach = 1;
    if (a.side !== right) {
      // The other arm braces low and forward, claws open.
      _v5.set(a.side * 0.45, 0.95, -0.45 - 0.2 * smooth(W, W + S, t));
      a.omega = 6;
      a.zeta = 0.6;
      this.toLevel(_v5, out);
      return;
    }
    const fAng = Math.atan2(_v4.x - sh.x, -(_v4.z - sh.z));
    const rad = clamp(Math.hypot(_v4.x - sh.x, _v4.z - sh.z), 0.55, reach * 0.94);
    const wind = a.side * 2.35;
    const end = fAng - a.side * 1.35;
    let ang: number;
    let y: number;
    const high = sh.y + 0.7;
    if (t < W) {
      // Cocked high and far back over the shoulder; it trembles there (the warning).
      const u = smooth(0, W * 0.75, t);
      const shake = smooth(W * 0.55, W, t);
      ang = lerp(a.side * 0.3, wind, u) + 0.07 * Math.sin(t * 41) * shake;
      y = lerp(0.95, high, u) + 0.04 * Math.sin(t * 29 + 1) * shake;
      a.omega = 10;
      a.zeta = 0.7;
    } else if (t < W + S) {
      const u = (t - W) / S;
      const e = u * u * (3 - 2 * u);
      ang = lerp(wind, end, e);
      // Through the focus height at the middle of the swipe, low at the end.
      y = lerp(high, _v4.y, smooth(0, 0.5, u)) - 0.35 * smooth(0.5, 1, u);
      a.omega = 40;
      a.zeta = 0.55;
    } else if (t < W + S + F) {
      ang = end - a.side * 0.15 * Math.sin(((t - W - S) / F) * Math.PI);
      y = _v4.y - 0.35;
      a.omega = 10;
      a.zeta = 0.35;
    } else {
      ang = lerp(end, a.side * 0.3, smooth(W + S + F, W + S + F + SWEEP.recover, t));
      y = lerp(_v4.y - 0.35, 0.95, smooth(W + S + F, W + S + F + SWEEP.recover, t));
      a.omega = 5;
      a.zeta = 0.8;
    }
    // Elbow bent in the wind-up, the arm flung to full length through the strike.
    const r = t < W ? lerp(0.6, reach * 0.62, smooth(0, W, t)) : t < W + S ? lerp(reach * 0.62, Math.max(rad, reach * 0.9), smooth(0, 0.4, (t - W) / S)) : rad;
    _v5.set(sh.x + Math.sin(ang) * r, Math.max(0.25, y), sh.z - Math.cos(ang) * r);
    this.toLevel(_v5, out);
  }

  // -------------------------------------------------------------------------------------------
  // The pose
  // -------------------------------------------------------------------------------------------

  private solve(dt: number): void {
    const R = this.rig;
    const M = this.motion;
    const t = this.time;
    const q = this.quadW.x;
    const act = this.act;
    const speed = M.speed;
    const alert = this.alert;
    const gp = this.gp;

    // ---- What the trunk should do -----------------------------------------------------------
    // Anticipation: the sim is ahead of the smoothed root when it starts; decelerating = negative.
    const fx = -Math.sin(this.rootYaw);
    const fz = -Math.cos(this.rootYaw);
    const rxl = Math.cos(this.rootYaw);
    const rzl = -Math.sin(this.rootYaw);
    const leadF = (M.lead.x - M.pos.x) * fx + (M.lead.z - M.pos.z) * fz;
    const accF = M.accel.x * fx + M.accel.z * fz;
    const accR = M.accel.x * rxl + M.accel.z * rzl;
    const leanT = clamp(leadF * 1.6 + accF * 0.06, -0.25, 0.35) * (1 - 0.6 * q);
    this.lean.step(leanT, 7, 0.38, dt);
    // Into turns (centripetal) and toward a gripped corner / surface; away from lateral accel.
    let side = clamp(M.yawRate * speed * -0.07, -0.2, 0.2) - clamp(accR * 0.03, -0.08, 0.08);
    let crouchT = gp.hipDrop;
    let hunchT = gp.pitch;
    let twistT = 0;
    let rollT = 0;
    let shiftT = 0;
    for (const a of this.arms) {
      const g = a.goal;
      if (g.kind === 'corner' && a.mode === 2) {
        side += a.side * 0.16;
        shiftT += a.side * 0.05;
      } else if (g.kind === 'top' && a.mode !== 0) {
        // Lean and dip toward a low top so the hand can rest on it.
        const need = clamp(this.ctx.shoulder[a.i].distanceTo(g.p) - this.ctx.reach * 0.8, 0, 0.4);
        side += a.side * (0.06 + need * 0.6);
        hunchT += 0.08 + need * 1.2;
        crouchT += need * 0.7;
      } else if (g.kind === 'window' && a.mode !== 0) hunchT += 0.1;
      else if (g.kind === 'ear' && a.mode !== 0) side += a.side * 0.12;
      else if (g.kind === 'touch' || g.kind === 'jamb') hunchT += 0.05;
    }
    // Acts.
    const at = this.actT;
    if (act === 'lurk') {
      crouchT += 0.16 + 0.03 * fbm1(t * 0.1, this.seed + 31);
      hunchT += 0.42;
    } else if (act === 'listen') {
      crouchT += 0.04;
      hunchT += 0.08;
    } else if (act === 'sniff' && this.hasFocus) {
      // Down toward the scent.
      const fy = this.focus.y - this.root.y;
      const low = clamp((1.6 - fy) / 1.4, 0, 1);
      crouchT += 0.12 + 0.2 * low;
      hunchT += 0.35 + 0.45 * low;
    } else if (act === 'search') {
      let low = 0;
      for (const a of this.arms) if (a.goal.kind === 'touch') low = Math.max(low, clamp((1.1 - (a.goal.p.y - this.root.y)) / 1.1, 0, 1));
      crouchT += 0.1 + 0.25 * low;
      hunchT += 0.3 + 0.55 * low;
    } else if (act === 'sweep' && this.hasFocus) {
      this.toModel(this.focus, _v1);
      const sgn = _v1.x > 0 ? 1 : -1;
      const W = SWEEP.windup;
      const S = SWEEP.strike;
      const coil = smooth(0, W, at) * (1 - smooth(W, W + S, at));
      const strike = smooth(W, W + S, at) * (1 - smooth(W + S + SWEEP.follow, W + S + SWEEP.follow + SWEEP.recover, at));
      twistT += -sgn * 0.8 * coil + sgn * 0.65 * strike;
      crouchT += -0.03 * coil + 0.12 * strike;
      hunchT += -0.25 * coil + 0.4 * strike;
      side += sgn * 0.12 * coil - sgn * 0.14 * strike;
      shiftT += -sgn * 0.06 * coil;
    }
    if (this.mode === 'chase' && !this.quad) hunchT += 0.15;
    if (this.reachingTarget()) hunchT += 0.15;
    // Door: lower, head-first; seeded roll/twist per pass. Squeezing turns the shoulders.
    const dk = this.doorK;
    twistT += this.door.twist * dk + this.squeeze.x * 0.7 * (this.door.twist >= 0 ? 1 : -1) * (1 - q);
    rollT += this.door.roll * dk;
    this.crouch.step(crouchT, 5, 0.9, dt);
    this.hunch.step(hunchT, 4.5, 0.85, dt);
    this.sideLean.step(side, 5, 0.6, dt);
    this.twist.step(twistT, act === 'sweep' ? 12 : 5, 0.7, dt);
    this.roll.step(rollT, 4, 0.8, dt);
    this.hipShift.step(shiftT, 4, 0.9, dt);

    // Duck: the head must clear what is overhead (+ a seeded contortion at doors). Segments fold
    // together fast and unfold bottom-up (hips first, the head last).
    const lintelNeed = Math.max(0, this.duckNeed);
    const duckT = lintelNeed + this.door.extra * dk;
    for (let i = 0; i < 6; i++) {
      const cur = this.duckSeg[i];
      const rate = duckT > cur ? 7 : UNFOLD[i];
      this.duckSeg[i] = cur + (duckT - cur) * damp(rate, dt);
    }

    // Breathing: rate drifts; slower when holding still to listen, faster when agitated.
    const bRate = (act === 'listen' ? 0.13 : act === 'lurk' ? 0.16 : 0.24) * (1 + alert * 0.6) * (1 + 0.25 * fbm1(t * 0.05, this.seed + 41));
    this.breath += dt * bRate * Math.PI * 2;
    const breath = Math.sin(this.breath) * (act === 'listen' ? 0.4 : 1);
    const twA = 0.4 + alert * 1.6;
    const twRate = act === 'lurk' ? 0.2 : act === 'listen' ? 0.5 : 0.6 + alert * 1.4;
    const thy = this.tw.hy.update(dt, twRate, 0.22 * twA, this.rng);
    const thp = this.tw.hp.update(dt, twRate * 0.6, 0.14 * twA, this.rng);
    const thr = this.tw.hr.update(dt, twRate * 0.7, 0.24 * twA, this.rng);
    const tsp = this.tw.sp.update(dt, twRate * 0.3, 0.05 * twA, this.rng);

    // ---- Hips --------------------------------------------------------------------------------
    // Biped bob/sway from the swinging leg; quad from the hind legs.
    const L0 = this.planner.limbs[0];
    const L1 = this.planner.limbs[1];
    const sw = !L0.planted ? L0 : !L1.planted ? L1 : null;
    const swS = sw ? Math.sin(Math.PI * sw.t) : 0;
    const bobT = sw ? gp.bob * (swS - 0.35) : -gp.bob * 0.35 * clamp(speed / 0.5, 0, 1);
    this.bob.step(bobT, 14, 0.6, dt);
    const swaySide = sw ? -sw.side : 0;
    const idleSway = this.gait === 'still' ? 0.035 * fbm1(t * 0.13, this.seed + 51) : 0;
    const contactDy = this.contactHeight(q) - this.root.y;
    const hipY =
      lerp(R.hipHeight - this.crouch.x - this.duckSeg[0] * 0.38, (this.gait === 'run' ? BODY.quadHipRun : BODY.quadHip) - this.crouch.x * 0.3, q) +
      this.bob.x + contactDy + 0.006 * breath;
    const hipX = (swaySide * 0.035 * swS + idleSway) * (1 - q) + this.hipShift.x;
    const hipZ = BODY.quadHipBack * q - this.lean.x * 0.1;
    // Pelvis yaw follows the legs (the forward leg's hip forward); the chest counter-rotates.
    this.toModel(L0.cur, _v1);
    this.toModel(L1.cur, _v2);
    const legTwist = clamp((_v1.z - _v2.z) * 0.45, -0.25, 0.25) * (1 - q);
    const pitchHip = lerp(this.hunch.x * 0.3 + this.duckSeg[0] * 0.5, BODY.quadHipPitch + this.hunch.x * 0.15, q) + this.lean.x * 0.35 + this.terrainPitch(q);
    const rollHip = (sw ? sw.side * 0.035 * swS : 0) * (1 - q) + this.sideLean.x * 0.3;
    const hipQ = this.hipQ;
    const hipP = this.hipP;
    hipQ.setFromAxisAngle(UP, legTwist + this.twist.x * 0.15);
    _q2.setFromAxisAngle(FWD, rollHip);
    _q3.setFromAxisAngle(LEFT, pitchHip);
    hipQ.multiply(_q2).multiply(_q3).multiply(R.restMQ[R.hips]);
    R.resetPose();
    R.fk(0, R.hips);
    hipP.set(hipX, hipY, hipZ);
    R.setHips(hipP, hipQ);

    // ---- Spine, then head ------------------------------------------------------------------
    const turnLead = clamp(wrap(M.rawYaw - M.yaw) * 1.1 + M.yawRate * 0.12, -0.7, 0.7);
    this.spinePass(q, legTwist, turnLead, breath, tsp);
    // Head clearance: measure, and if it would hit the lintel, fold more (this frame).
    if (this.world) {
      const top = this.headTopLevel();
      const limit = Math.min(this.headroom, this.world.headroom(this.ctx.shoulder[0].x * 0.5 + this.ctx.shoulder[1].x * 0.5, this.ctx.shoulder[0].z * 0.5 + this.ctx.shoulder[1].z * 0.5, 0.2)) - BODY.headClear;
      const over = top - limit;
      if (over > 0) {
        this.duckNeed += over * 1.1;
        for (let i = 0; i < 6; i++) this.duckSeg[i] = Math.max(this.duckSeg[i], this.duckSeg[i] + over * 1.1);
        // Re-pose with the extra fold.
        _q3.setFromAxisAngle(LEFT, pitchHip + over * 0.5 * (1 - q));
        hipQ.setFromAxisAngle(UP, legTwist + this.twist.x * 0.15).multiply(_q2.setFromAxisAngle(FWD, rollHip)).multiply(_q3).multiply(R.restMQ[R.hips]);
        hipP.y -= over * 0.38 * (1 - q);
        R.setHips(hipP, hipQ);
        this.spinePass(q, legTwist, turnLead, breath, tsp);
      } else this.duckNeed = Math.max(0, this.duckNeed + over * 0.5) * (1 - damp(1.5, dt));
    }
    this.headAim(dt, thy, thp, thr, turnLead);

    // ---- Legs ---------------------------------------------------------------------------------
    // The hips must let the planted feet reach: lower them if a leg would over-stretch.
    let drop = 0;
    for (let i = 0; i < 2; i++) drop = Math.max(drop, this.legDrop(i));
    if (drop > 1e-4) {
      hipP.y -= drop;
      R.setHips(hipP, hipQ);
      this.spinePass(q, legTwist, turnLead, breath, tsp);
      this.headAim(0, thy, thp, thr, turnLead);
    }
    for (let i = 0; i < 2; i++) this.solveLeg(i);


    // ---- Arms ---------------------------------------------------------------------------------
    for (const a of this.arms) this.solveArm(a, dt, breath);

    // ---- Face -------------------------------------------------------------------------------
    this.face(dt, breath);
    void lerp;
  }

  /** Average height of the planted support limbs (level): the body rides on its contacts. */
  private contactHeight(q: number): number {
    let s = 0;
    let n = 0;
    for (const l of this.planner.limbs) {
      if (!l.active) continue;
      const w = l.front ? q : 1;
      s += (l.planted ? l.pos.y : Math.max(l.from.y, l.to.y)) * w;
      n += w;
    }
    const c = n > 0 ? s / n : this.root.y;
    return lerp(this.root.y, c, 0.75);
  }

  /** Pitch the trunk up when the front limbs stand higher than the hind ones (climbing). */
  private terrainPitch(q: number): number {
    if (q < 0.05) return 0;
    const L = this.planner.limbs;
    const hind = (L[0].cur.y + L[1].cur.y) / 2;
    const front = L[2].active && L[3].active ? (L[2].cur.y + L[3].cur.y) / 2 : hind;
    return -Math.atan2(front - hind, 1.0) * q * 0.9;
  }

  /** Spine segments + neck: hunch, duck, quad pitch, twist, lateral lean, breathing. */
  private spinePass(q: number, legTwist: number, turnLead: number, breath: number, tsp: number): void {
    const R = this.rig;
    const hunch = this.hunch.x;
    const W = SPINE_W;
    // From the bind pose every pass (it may run twice a frame).
    for (const i of R.spine) R.q[i].copy(R.restQ[i]);
    for (const i of R.neck) R.q[i].copy(R.restQ[i]);
    R.q[R.head].copy(R.restQ[R.head]);
    for (const arm of R.arms) R.q[arm.shoulder].copy(R.restQ[arm.shoulder]);
    for (let k = 0; k < 3; k++) {
      const i = R.spine[k];
      R.fk1(i);
      const pitch =
        lerp(hunch * W[k] + this.duckSeg[k + 1] * 0.55, BODY.quadSpinePitch + hunch * 0.1, q) +
        this.lean.x * 0.2 + (k === 2 ? 0.012 * breath : 0.006 * breath) + tsp * (k === 1 ? 1 : 0.4);
      const yaw = (-legTwist * 0.6 + this.twist.x * 0.3 + turnLead * 0.18) * (k === 0 ? 0.6 : 1);
      const roll = this.sideLean.x * 0.25 + this.roll.x * 0.15;
      _q1.setFromAxisAngle(UP, yaw);
      _q2.setFromAxisAngle(FWD, roll);
      _q3.setFromAxisAngle(LEFT, pitch);
      _qa.copy(R.mq[i]);
      R.setModelQ(i, _q1.multiply(_q2).multiply(_q3).multiply(_qa));
    }
    // Neck: carries the duck's head-first thrust, and on all fours cranes up (head aim does the rest).
    for (let k = 0; k < 2; k++) {
      const i = R.neck[k];
      R.fk1(i);
      const pitch = this.duckSeg[k + 4] * 0.25 - q * 0.25;
      _q3.setFromAxisAngle(LEFT, pitch);
      _qa.copy(R.mq[i]);
      R.setModelQ(i, _q3.multiply(_qa));
    }
    R.fk1(R.head);
    // Shoulders: FK so the arms start from the posed trunk.
    for (const arm of R.arms) {
      R.fk1(arm.shoulder);
      R.fk1(arm.upper);
    }
  }

  /** Top of the skull (level y) for the current pose. */
  private headTopLevel(): number {
    const R = this.rig;
    _v1.copy(R.mp[R.head]);
    return this.root.y + (_v1.y + R.headTop) * this.scale;
  }

  /** Head/neck aim at the look target (focus, the way ahead, around a corner...). */
  private headAim(dt: number, thy: number, thp: number, thr: number, turnLead: number): void {
    const R = this.rig;
    const t = this.time;
    const act = this.act;
    const c = this.ctx;
    // Look target (level).
    let roll = this.roll.x * 0.6 + thr * 0.6;
    if (this.hasFocus && act !== 'none') {
      _v1.copy(this.focus);
      if (act === 'listen') {
        // Turn an ear toward the sound: face it, then cock the head.
        this.toModel(this.focus, _v2);
        const sgn = _v2.x > 0 ? 1 : -1;
        roll += sgn * (0.32 + 0.08 * noise1(t * 0.5, this.seed + 61));
      }
    } else if (this.hasFocus && this.mode === 'chase') {
      _v1.copy(this.focus);
    } else if (this.motion.speed < 0.1 && !this.quad && this.idleWall(t)) {
      // Standing: its blind head tracks slowly along a nearby wall, as if listening through it.
      _v1.copy(this.idleLook);
    } else {
      // The way ahead, low; it "looks" around blindly.
      const scan = 0.55 * fbm1(t * 0.12, this.seed + 62) + turnLead;
      const yaw = this.rootYaw + scan;
      const dist = 2.5;
      _v1.set(this.root.x - Math.sin(yaw) * dist, this.root.y + 0.9 + 0.35 * fbm1(t * 0.1, this.seed + 63), this.root.z - Math.cos(yaw) * dist);
      if (this.quad) _v1.y = this.root.y + 0.6;
    }
    for (const a of this.arms) {
      if (a.goal.kind === 'corner' && a.mode !== 0) {
        // Lean the head around the corner before the body turns.
        _v1.set(a.goal.p.x + a.goal.f.x * 1.6 + c.fx * 0.4, this.root.y + 1.6, a.goal.p.z + a.goal.f.z * 1.6 + c.fz * 0.4);
        roll += a.side * 0.2;
      } else if (a.goal.kind === 'window' && a.mode !== 0) {
        _v1.set(a.goal.p.x - a.goal.n.x * 0.5, a.goal.p.y + 0.1, a.goal.p.z - a.goal.n.z * 0.5);
      } else if (a.goal.kind === 'ear' && a.mode !== 0) {
        // Ear to the wall: look along it, cheek toward it.
        _v1.set(a.goal.p.x - a.goal.n.x * 0.2 + c.fx * 1.5, a.goal.p.y + 0.4, a.goal.p.z - a.goal.n.z * 0.2 + c.fz * 1.5);
        roll += a.side * 0.5;
      }
    }
    if (this.doorK > 0.2 && this.world && this.door.id >= 0) {
      // Head-first through the frame: look through, low.
      const d = this.world.doors[this.door.id];
      const k = this.doorK;
      _v2.set(d.cx + d.nx * this.door.sign * 2, this.root.y + 0.9, d.cz + d.nz * this.door.sign * 2);
      _v1.lerp(_v2, k * 0.8);
    }
    // Smooth the look point: fast snap toward a new sound, slower otherwise.
    const w = this.snapT > 0 ? 26 : act === 'listen' ? 3 : this.motion.speed < 0.1 ? 2.2 : 6;
    const z = this.snapT > 0 ? 0.55 : 0.9;
    if (dt > 0) {
      const n = dt > 1 / 60 ? Math.ceil(dt * 60) : 1;
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        _v2.subVectors(_v1, this.look).multiplyScalar(w * w).addScaledVector(this.lookVel, -2 * z * w);
        this.lookVel.addScaledVector(_v2, h);
        this.look.addScaledVector(this.lookVel, h);
      }
    }
    this.toModel(this.look, _v3);
    // Sniffing: quick inhale jerks of the head in bursts.
    let sniff = 0;
    if (act === 'sniff') {
      const burst = noise1(t * 0.9, this.seed + 64) > -0.1 ? 1 : 0;
      sniff = burst * Math.max(0, Math.sin(t * 31)) * 0.05;
    }
    // Aim chain: neck, neck_2, head share the turn (CCD with weights and per-bone limits).
    const chain = this.aimChain;
    const wts = AIM_W;
    const lim = AIM_LIM;
    for (let k = 0; k < 3; k++) {
      const i = chain[k];
      R.fk1(i);
      for (let j = k + 1; j < 3; j++) R.fk1(chain[j]);
      // Face point and direction.
      _v4.copy(R.faceLocal).applyQuaternion(R.mq[R.head]).add(R.mp[R.head]);
      _v5.copy(R.faceDir).applyQuaternion(R.mq[R.head]);
      _v2.subVectors(_v3, _v4);
      if (_v2.lengthSq() < 1e-6) continue;
      _v2.normalize();
      const ang = Math.min(_v5.angleTo(_v2) * wts[k], lim[k]);
      if (ang < 1e-4) continue;
      _v1.crossVectors(_v5, _v2).normalize();
      _q1.setFromAxisAngle(_v1, ang);
      _qa.copy(R.mq[i]);
      R.setModelQ(i, _q1.multiply(_qa));
    }
    // Roll (cocked head), twitches, sniff jerk.
    const hd = R.head;
    _v5.copy(R.faceDir).applyQuaternion(R.mq[hd]);
    _q1.setFromAxisAngle(_v5, -roll);
    _q2.setFromAxisAngle(UP, thy * 0.7);
    _v1.crossVectors(UP, _v5).normalize();
    _q3.setFromAxisAngle(_v1.lengthSq() > 0.5 ? _v1 : LEFT, thp * 0.6 + sniff);
    _qa.copy(R.mq[hd]);
    R.setModelQ(hd, _q1.multiply(_q2).multiply(_q3).multiply(_qa));
  }

  /** Pick / slide the idle look point along a wall face in front of it. False: no wall near. */
  private idleWall(t: number): boolean {
    const w = this.world;
    if (!w) return false;
    if (t >= this.idleLookAt) {
      // Every few seconds: another face (or another stretch of the same one).
      const r = this.rng.seed(hashKey(this.seed + 301, Math.floor(t * 10)));
      this.idleLookAt = t + r.range(2.2, 4.5);
      this.idleFace = -1;
      const fx = -Math.sin(this.rootYaw);
      const fz = -Math.cos(this.rootYaw);
      let best = 2.6;
      w.query(this.root.x, this.root.z);
      for (let q = w.qStart; q < w.qEnd; q++) {
        const ref = w.refs[q];
        if (ref >> 16 !== Feat.Face) continue;
        const f = w.faces[ref & 0xffff];
        const d = f.nx !== 0 ? (this.root.x - f.plane) * f.nx : (this.root.z - f.plane) * f.nz;
        // In front of it (facing the body) and within a couple of meters.
        if (d < 0.2 || d > best || -(f.nx * fx + f.nz * fz) < 0.1 - r.next() * 0.4) continue;
        best = d;
        this.idleFace = ref & 0xffff;
      }
      if (this.idleFace >= 0) {
        const f = w.faces[this.idleFace];
        const a = clamp((f.nx !== 0 ? this.root.z : this.root.x) + r.signed() * 1.2, f.a0 + 0.1, f.a1 - 0.1);
        const y = this.root.y + r.range(0.7, 2.0);
        if (f.nx !== 0) this.idleLook.set(f.plane, y, a);
        else this.idleLook.set(a, y, f.plane);
      }
    }
    if (this.idleFace < 0) return false;
    // Drift along the face.
    const f = w.faces[this.idleFace];
    const v = 0.12 * noise1(t * 0.35, this.seed + 302) * this.dt * 6;
    if (f.nx !== 0) this.idleLook.z = clamp(this.idleLook.z + v, f.a0 + 0.1, f.a1 - 0.1);
    else this.idleLook.x = clamp(this.idleLook.x + v, f.a0 + 0.1, f.a1 - 0.1);
    return true;
  }

  /** How much the hips must come down for planted leg i to reach its foot. */
  private legDrop(i: number): number {
    const R = this.rig;
    const L = this.planner.limbs[i];
    if (!L.planted) return 0;
    const leg = R.legs[i];
    this.ankleTarget(i, _v4);
    R.fk1(leg.thigh);
    const hip = R.mp[leg.thigh];
    const max = (leg.lenA + leg.lenB) * BODY.legReach;
    const dx = _v4.x - hip.x;
    const dz = _v4.z - hip.z;
    const h2 = dx * dx + dz * dz;
    if (h2 >= max * max) return 0.5;
    const dyMax = Math.sqrt(max * max - h2);
    const dy = hip.y - _v4.y;
    return Math.max(0, dy - dyMax);
  }

  /** Foot roll (rad, + = heel up) for a leg at its current phase. */
  private footRoll(l: Limb): number {
    const tip = this.gp.tiptoe;
    if (l.planted) {
      // Heel peels off as the step nears.
      return tip + clamp((l.urge - 0.55) / 0.45, 0, 1) * 0.35 * (1 - tip);
    }
    const t = l.t;
    const off = lerp(0.4, -0.22, smooth(0.08, 0.5, t));
    return lerp(off, tip, smooth(0.72, 1, t));
  }

  /** Ankle target (model space) for leg i: the ball on its contact, the foot rolled. */
  private ankleTarget(i: number, out: THREE.Vector3): THREE.Vector3 {
    const R = this.rig;
    const leg = R.legs[i];
    const l = this.planner.limbs[i];
    _v5.copy(l.cur);
    _v5.y += leg.ballHeight * this.scale;
    this.toModel(_v5, out);
    const yawRel = wrap(l.curYaw - this.rootYaw);
    const roll = this.footRoll(l);
    _q2.setFromAxisAngle(UP, yawRel);
    _q3.setFromAxisAngle(RIGHT, -roll);
    _q2.multiply(_q3);
    _v5.copy(leg.ankleFromBall).applyQuaternion(_q2);
    return out.add(_v5);
  }

  private solveLeg(i: number): void {
    const R = this.rig;
    const leg = R.legs[i];
    const l = this.planner.limbs[i];
    const side = i === 0 ? -1 : 1;
    this.ankleTarget(i, _v4);
    R.fk1(leg.thigh);
    const hip = R.mp[leg.thigh];
    // Knee: forward, splayed out on all fours / creeping (a spider's knees), following the foot.
    const yawRel = wrap(l.curYaw - this.rootYaw);
    const out = lerp(this.gait === 'creep' ? 0.3 : 0.12, 0.75, this.quadW.x);
    _pole.set(side * out, 0.05, -(1 - out * 0.5)).applyAxisAngle(UP, yawRel * 0.6);
    l.stretch = solveTwoBone(hip, _v4, leg.lenA, leg.lenB, _pole, _mid, _end);
    _v1.subVectors(_mid, hip);
    R.setModelQ(leg.thigh, aimQuat(leg.thighAim, _v1, _pole, _q1));
    R.fk1(leg.shin);
    _v1.subVectors(_end, _mid);
    R.setModelQ(leg.shin, aimQuat(leg.shinAim, _v1, _pole, _q1));
    // Foot: yawed to its contact, rolled about the ball.
    const roll = this.footRoll(l);
    _q2.setFromAxisAngle(UP, yawRel);
    _q3.setFromAxisAngle(RIGHT, -roll);
    _q1.copy(_q2).multiply(_q3).multiply(R.restMQ[leg.foot]);
    R.setModelQ(leg.foot, _q1);
    // Toes stay flat on the ground while the heel is up; curl in the air.
    const flex = l.planted ? roll : -0.35 * Math.sin(Math.PI * l.t) + roll * 0.4;
    R.q[leg.toe].copy(R.restQ[leg.toe]).multiply(_qa.setFromAxisAngle(leg.toeAxis, flex));
    R.fk1(leg.toe);
  }

  private solveArm(a: Arm, dt: number, breath: number): void {
    const R = this.rig;
    const arm = R.arms[a.i];
    const l = this.planner.limbs[2 + a.i];
    const side = a.side;
    // Wrist target: the support contact (all fours) blended with the brain's.
    _v1.copy(a.wrist);
    let style = 0;
    if (a.supportW > 0.001) {
      // Planted: palm flat (fingers spread) or a fingertip claw, per step.
      style = l.styleA < 0.45 ? 0 : 1;
      const yaw = l.curYaw;
      const fxl = -Math.sin(yaw);
      const fzl = -Math.cos(yaw);
      const lift = l.planted ? 0 : Math.sin(Math.PI * l.t) * 0.06;
      const wy = (style === 0 ? 0.05 : 0.16) * this.scale + lift;
      _v2.set(l.cur.x - fxl * 0.12 * this.scale, l.cur.y + wy, l.cur.z - fzl * 0.12 * this.scale);
      _v1.lerp(_v2, a.supportW);
    }
    this.toModel(_v1, _v4);
    // Clavicle: shrug / protract toward far targets; breathing lifts it.
    const S0 = R.mp[arm.upper];
    const reach = arm.lenA + arm.lenB;
    const elev = clamp((_v4.y - S0.y) / reach, -1, 1);
    const fwd = clamp(-(_v4.z - S0.z) / reach, -1, 1);
    _q1.setFromAxisAngle(UP, side * BODY.shrug * 0.6 * fwd);
    _q2.setFromAxisAngle(FWD, -side * (BODY.shrug * Math.max(0, elev) * 0.8 + 0.015 * breath));
    _qa.copy(R.mq[arm.shoulder]);
    R.setModelQ(arm.shoulder, _q1.multiply(_q2).multiply(_qa));
    R.fk1(arm.upper);
    const S = R.mp[arm.upper];
    // Elbow: hanging = back and out; reaching = out and up (wide, unsettling); support = up/out.
    const rw = a.reachW;
    _pole.set(side * lerp(0.55, 0.85, rw), lerp(-0.05, 0.45, rw), lerp(0.8, 0.25, rw));
    if (a.supportW > 0) _pole.lerp(_v2.set(side * 0.7, 0.7, 0.2), a.supportW);
    if (a.goal.kind === 'wall' || a.goal.kind === 'trail' || a.goal.kind === 'ear') _pole.lerp(_v2.set(side * 0.3, -0.6, 0.6), a.contactW * 0.7);
    _pole.normalize();
    a.stretch = solveTwoBone(S, _v4, arm.lenA, arm.lenB, _pole, _mid, _end);
    if (a.supportW > 0.5) l.stretch = a.stretch;
    _v2.subVectors(_mid, S);
    R.setModelQ(arm.upper, aimQuat(arm.upperAim, _v2, _pole, _q1));
    R.fk1(arm.fore);
    _v2.subVectors(_end, _mid);
    R.setModelQ(arm.fore, aimQuat(arm.foreAim, _v2, _pole, _q1));
    R.fk1(arm.hand);
    // Hand: relaxed (rest relative to the forearm, drooping) blended toward the contact frame.
    _q2.copy(R.mq[arm.fore]).multiply(R.restQ[arm.hand]);
    let cw = a.contactW;
    if (a.supportW > 0.001) {
      // Support contact frame: fingers along the contact yaw (splayed out), palm down; claws tip down.
      const yaw = l.curYaw;
      _v2.set(-Math.sin(yaw), style === 1 ? -0.85 : -0.08, -Math.cos(yaw)).normalize();
      _v3.set(0, -1, 0);
      if (style === 1) _v3.set(-Math.sin(yaw) * 0.6, -0.8, -Math.cos(yaw) * 0.6);
      this.dirToModel(_v2, _v2);
      this.dirToModel(_v3, _v3);
      aimQuat(arm.handAim, _v2, _v3, _q3);
      cw = Math.max(cw, a.supportW);
      _q1.copy(_q2).slerp(_q3, cw);
    } else if (cw > 0.001) {
      this.dirToModel(a.fdir, _v2);
      this.dirToModel(a.palm, _v3);
      aimQuat(arm.handAim, _v2, _v3, _q3);
      _q1.copy(_q2).slerp(_q3, cw);
    } else _q1.copy(_q2);
    // Wrist limit: never bend the hand more than ~85 degrees off the forearm.
    const dev = _q1.angleTo(_q2);
    if (dev > 1.5) _q1.copy(_q2).slerp(_q3.copy(_q1), 1.5 / dev);
    R.setModelQ(arm.hand, _q1);
    this.fingers(a, style, dt);
  }

  /** Finger curls and spread per finger: contact style, drumming, twitching, splay. */
  private fingers(a: Arm, supportStyle: number, dt: number): void {
    const R = this.rig;
    const l = this.planner.limbs[2 + a.i];
    const arm = R.arms[a.i];
    const t = this.time;
    const g = a.goal;
    const cw = Math.max(a.contactW, a.supportW);
    // Profiles: [proximal, middle, distal] curl per style.
    let p0 = 0.22;
    let p1 = 0.35;
    let p2 = 0.3;
    let spread = 0.08;
    const free = 1 - cw;
    // Free hands: claws open when agitated / reaching, splayed when feeling the air.
    if (this.gait === 'creep' || this.act === 'sweep' || this.reachingTarget()) {
      p0 = -0.1;
      p1 = 0.05;
      p2 = 0.15;
      spread = 0.38;
      if (this.act === 'sweep') {
        const strike = smooth(SWEEP.windup, SWEEP.windup + SWEEP.strike, this.actT);
        p0 = lerp(-0.15, 0.55, strike);
        p1 = lerp(0.0, 0.85, strike);
        p2 = lerp(0.1, 0.7, strike);
      }
    }
    let c0 = p0;
    let c1 = p1;
    let c2 = p2;
    if (cw > 0.001) {
      let q0: number;
      let q1: number;
      let q2: number;
      let sp: number;
      const grip = a.supportW > 0.5 ? (supportStyle === 1 ? Grip.Tips : Grip.Palm) : g.grip;
      const k = a.supportW > 0.5 ? 0.25 + 0.55 * l.styleB : g.curl;
      if (grip === Grip.Palm) {
        q0 = -0.12; q1 = 0.05 + k * 0.2; q2 = 0.1 + k * 0.3; sp = a.supportW > 0.5 ? 0.15 + 0.3 * l.styleC : g.spread;
      } else if (grip === Grip.Tips) {
        q0 = 0.3 + k * 0.2; q1 = 0.45 + k * 0.3; q2 = 0.3 + k * 0.2; sp = a.supportW > 0.5 ? 0.1 + 0.3 * l.styleC : g.spread;
      } else if (grip === Grip.Wrap) {
        q0 = 0.15 + k * 0.25; q1 = k; q2 = k * 0.85; sp = g.spread;
      } else {
        q0 = 0.15 + k * 0.2; q1 = 0.25 + k * 0.4; q2 = 0.2 + k * 0.3; sp = g.spread;
      }
      c0 = lerp(c0, q0, cw);
      c1 = lerp(c1, q1, cw);
      c2 = lerp(c2, q2, cw);
      spread = lerp(spread, sp, cw);
    }
    // Drumming on a surface it rests on while idle; restless twitching otherwise.
    const drum = a.mode === 2 && (g.kind === 'top' || g.kind === 'window') && this.motion.speed < 0.1 && noise1(t * 0.3 + a.i * 4, this.seed + 71) > 0.2;
    for (let f = 0; f < 5; f++) {
      const bones = arm.fingers[f];
      if (bones[0] < 0) continue;
      const n = 0.08 * fbm1(t * (0.6 + f * 0.13) + a.i * 9 + f * 3.7, this.seed + 80 + f) * (0.4 + free);
      let tap = 0;
      if (drum) tap = 0.5 * Math.max(0, Math.sin(t * 9 - f * 0.9)) ** 6;
      const thumb = f === 0;
      const tw = thumb ? 0 : Math.max(0, a.twitch.x) * 2.2 * (f % 2 === 0 ? 1 : 0.6);
      const target = thumb ? 0.25 + 0.2 * cw : c1;
      a.curl[f] += (target + n + tap + tw - a.curl[f]) * damp(18, dt);
      const spr = thumb ? spread * 1.2 + 0.1 : spread * (f === 2 ? 0 : f === 1 ? 0.8 : f === 3 ? 0.7 : 1.4);
      for (let j = 0; j < 3; j++) {
        const b = bones[j];
        if (b < 0) continue;
        const ang = j === 1 ? a.curl[f] : j === 0 ? (thumb ? 0.15 : c0 + n * 0.5 + tap * 0.4) : thumb ? 0.25 : c2 + n + tap * 0.6;
        R.q[b].copy(R.restQ[b]).multiply(_qa.setFromAxisAngle(arm.curlAxis[f][j], ang));
        if (j === 0 && spr !== 0) R.q[b].multiply(_qa.setFromAxisAngle(arm.spreadAxis[f], spr));
      }
    }
  }

  /** Jaw, split mandibles, ears. */
  private face(dt: number, breath: number): void {
    const R = this.rig;
    const t = this.time;
    const act = this.act;
    let open = 0.03 + this.alert * 0.07 + 0.015 * breath;
    let split = 0.05 + this.alert * 0.15;
    if (act === 'sniff') {
      open += 0.04 * Math.max(0, Math.sin(t * 31));
      split += 0.15;
    } else if (act === 'sweep') {
      const u = smooth(0, SWEEP.windup, this.actT) * (1 - smooth(SWEEP.windup + SWEEP.strike, SWEEP.windup + SWEEP.strike + SWEEP.follow + 0.3, this.actT));
      open += 0.25 * u;
      split += 0.6 * u;
    } else if (act === 'listen') {
      open += 0.04;
    }
    if (this.reachingTarget() || this.mode === 'chase') {
      open += 0.12;
      split += 0.4;
    }
    const click = this.tw.jaw.update(dt, 0.15 + this.alert * 0.6, 0.12, this.rng);
    open += Math.abs(click);
    this.jawOpen.step(open, 18, 0.6, dt);
    this.split.step(split, 12, 0.5, dt);
    if (R.jaw >= 0) R.q[R.jaw].copy(R.restQ[R.jaw]).multiply(_qa.setFromAxisAngle(RIGHT, this.jawOpen.x));
    if (this.jawSplit) {
      const k = clamp(this.split.x, 0, 1);
      if (R.jawL >= 0) R.q[R.jawL].copy(R.restQ[R.jawL]).multiply(_q1.identity().slerp(this.jawSplit[0], k));
      if (R.jawR >= 0) R.q[R.jawR].copy(R.restQ[R.jawR]).multiply(_q1.identity().slerp(this.jawSplit[1], k));
    }
    // Ears: flick on their own, prick toward a focus.
    const flick = this.tw.ear.update(dt, 0.4 + this.alert, 0.35, this.rng);
    let toward = 0;
    if (this.hasFocus) {
      this.toModel(this.focus, _v1);
      toward = clamp(_v1.x * 0.3, -0.3, 0.3);
    }
    for (let s = -1; s <= 1; s += 2) {
      const e = s < 0 ? R.earL : R.earR;
      if (e < 0) continue;
      const a = (s < 0 ? flick : -flick * 0.7) + toward * s + 0.05 * noise1(t * 0.7 + s, this.seed + 91);
      R.q[e].copy(R.restQ[e]).multiply(_qa.setFromAxisAngle(R.fwdAxis[e], a));
    }
  }
}
