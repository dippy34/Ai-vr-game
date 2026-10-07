/**
 * The monster's mind. Host-only and deterministic (every random choice comes from the sim's
 * seeded rng). Pure TypeScript: it reads LevelData / WorldState and writes MonsterState.
 *
 * It is BLIND: it knows only what it hears (GameSim.hear -> onHeard), what it touches
 * (GameSim.checkContacts -> onTouch, its search / sweep reach) and what it remembers (noise
 * memory). See "How the monster thinks" in docs/DESIGN.md.
 *
 * Structure: the networked `mode` (wander / investigate / chase / feeding) plus an internal task
 * (patrol, orient, approach, listen, probe, act, lurk...). Every tick the active task moves it
 * along a planned route (navgrid.ts) and states what it wants to show (act + focus + gait); then
 * the body pass (finishBody) works out what its body must truthfully be doing at its position:
 * ducking under a lintel, crawling through a gap, climbing over low furniture (position.y).
 */

import { GAME, HEARING, MONSTER, NAV, NOISE, PLAYER } from '../config';
import type {
  LevelData,
  MonsterAct,
  MonsterGait,
  MonsterState,
  PlayerId,
  PlayerState,
  SimEvent,
  Vec3,
  WorldState,
} from './types';
import { angleDelta, clamp, copy3, distXZ, lerp, v3, wrapAngle, yawTowards } from './math';
import { moveCircleAmong, wallsBetween, type CollisionOptions } from './physics';
import {
  CELL_TALL,
  bodyClearance,
  cellX,
  wallsCrossed,
  cellZ,
  hidingSpots,
  navGridFor,
  nearestCell,
  planRoute,
  regionAt,
  segmentClearFor,
  surfaceTop,
  underLintel,
  type ClassCosts,
  type LurkSpot,
  type NavGrid,
  type RoutePoint,
  type SegKind,
} from './navgrid';

/** Brain-private tunables (shared "feel" numbers live in config.ts MONSTER / NAV). */
export const BRAIN_TUNING = {
  /** Distance at which a waypoint (and the final goal) counts as reached. */
  waypointRadius: 0.3,
  goalRadius: 0.25,
  /** Min seconds between chase re-plans. */
  chaseReplanInterval: 0.3,
  /** Hearing the chased player again after this long a silence re-emits a 'monsterAlert'. */
  chaseRegainGap: 1.5,
  /** How fast the "priority" of the current stimulus fades (s), so newer noises can override. */
  stimulusDecaySeconds: 4,
  /** Moving less than stuckDistance (m) in stuckWindow (s) while walking counts as stuck. */
  stuckWindow: 1.0,
  stuckDistance: 0.12,
  /**
   * Noise memory: every noise it hears warms a hot spot there (merged within `noiseMemoryMerge`
   * m), the warmth halves every `noiseMemoryHalfLife` s, and while patrolling it favors rooms and
   * points near warm spots (`noiseMemoryPull`, distance falloff `noiseMemoryReach` m).
   */
  noiseMemoryMerge: 2.0,
  noiseMemoryHalfLife: 90,
  noiseMemoryPerNoise: 0.15,
  noiseMemoryCap: 10,
  noiseMemoryPull: 8,
  noiseMemoryReach: 4,
  noiseMemorySpots: 16,
  /** After a sweep it waits this long (s) before sweeping again. */
  sweepCooldown: 1.6,
  /** Arriving where it last heard its quarry this recently (s), it swipes right away. */
  sweepFresh: 1.0,
  /** Probing a hiding spot it stops this close (m) for a sweep / to search or sniff it. */
  probeSweepDist: 1.1,
  probeTouchDist: 0.6,
  /** The region the fuse box is in gets checked more (players have to go there). */
  objectiveBias: 1.4,
  /**
   * Patrol: it tracks when each bit of floor was last within earshot of normal talk (and refreshes
   * that every `earshotEvery` s or `earshotMove` m), and roams toward rooms it has not listened to lately.
   */
  earshotEvery: 2,
  earshotMove: 0.8,
  /** Staleness (s) at which a room counts as completely unheard. */
  earshotStale: 90,
} as const;

/** What the sim gives the brain. */
export interface MonsterHost {
  readonly level: LevelData;
  readonly state: WorldState;
  rng(): number;
  coll(): CollisionOptions;
  /** Catch `p` (status, dropped items, 'playerCaught'); the sim then calls onCaught. */
  catchPlayer(p: PlayerState, out: SimEvent[]): void;
  readonly noiseMemory: boolean;
}

type ProbeAct = 'search' | 'sniff' | 'sweep';

type Task =
  | { kind: 'patrol' }
  | { kind: 'pause'; until: number; act: 'listen' | 'sniff'; focus: Vec3 }
  | { kind: 'orient'; until: number }
  | { kind: 'approach' }
  | { kind: 'stalkListen'; until: number }
  | { kind: 'listen'; until: number }
  | { kind: 'probe'; spot: Vec3; act: ProbeAct }
  | { kind: 'act'; act: ProbeAct; spot: Vec3; until: number; struck: boolean }
  | { kind: 'lurkGo'; spot: LurkSpot }
  | { kind: 'lurk'; spot: LurkSpot; until: number }
  | { kind: 'chase' }
  | { kind: 'feed'; until: number; at: Vec3 };

type MoveResult = 'moving' | 'arrived' | 'stuck' | 'waiting';

interface HotSpot {
  x: number;
  z: number;
  heat: number;
  region: number;
}

const NEVER = -1e9;
const SWEEP_TOTAL = MONSTER.sweepWindup + MONSTER.sweepStrike + MONSTER.sweepRecover;
const span = (r: readonly [number, number], t: number): number => lerp(r[0], r[1], t);

export class MonsterBrain {
  private readonly g: NavGrid;
  private task: Task = { kind: 'patrol' };
  private route: RoutePoint[] = [];
  private routeGoal: Vec3 | null = null;
  private needPlan = false;
  private planTokens: number = NAV.planBurst;
  private planTick = -1;
  private tickNo = 0;
  /** Kind of the route segment it is on (drives posture while moving). */
  private segKind: SegKind = 'upright';
  private moving = false;
  private crawling = false;
  /** Smoothed speed (gait thresholds do not flicker at corners). */
  private gaitSpeed = 0;
  private lastPos: Vec3;

  // Body-language intent for this tick (committed in finishBody).
  private wantAct: MonsterAct = 'none';
  private wantFocus: Vec3 | null = null;
  private actRestart = false;
  private gaitIntent: MonsterGait = 'still';

  // Investigation.
  private noisePos: Vec3 | null = null;
  private stalk = false;
  private stalkPid: PlayerId | null = null;
  private stalkWalked = 0;
  private stalkNext = 0;
  private probes: Vec3[] = [];
  private afterChase = false;

  // Chase.
  private chasePos: Vec3 | null = null;
  private chaseHeardAt = NEVER;
  private replanAt = NEVER;
  private routeDirty = false;
  private track: { x: number; z: number; t: number }[] = [];
  private sweepReadyAt = 0;

  // Stimulus priority.
  private stimScore = 0;
  private stimTime = NEVER;

  // Stuck detection.
  private stuckT = 0;
  private stuckRef: Vec3;
  private stuckCount = 0;

  // Patrol.
  private patrolGoal: Vec3 | null = null;
  private patrolRegion = -1;
  private patrolLeft = 0;
  private hot: HotSpot[] = [];
  /** Per listen point (NavGrid.listen): last time it was within earshot. */
  private heardAt: Float64Array;
  private earshotAt = 0;
  private earshotPos: Vec3 = v3(1e9, 0, 1e9);

  /** The room with the fuse box (players must go there) and the one by the exit door. */
  private readonly objectiveRegion: number;
  private readonly exitRegion: number;

  // Escalation.
  private readonly roundStart: number;
  private frenzy = false;

  constructor(private readonly host: MonsterHost) {
    this.g = navGridFor(host.level);
    this.roundStart = host.state.time;
    this.lastPos = copy3(host.state.monster.position);
    this.stuckRef = copy3(host.state.monster.position);
    this.heardAt = new Float64Array(this.g.listen.n).fill(this.roundStart - BRAIN_TUNING.earshotStale);
    const g = this.g;
    const roomNear = (p: Vec3, sight: boolean): number => {
      const c = nearestCell(g, p.x, p.z, 2.5, sight, (i) => g.region[i] >= 0);
      return c >= 0 ? g.region[c] : -1;
    };
    const door = host.level.exit.door;
    this.objectiveRegion = roomNear(host.level.fuseBox.position, true);
    this.exitRegion = roomNear(v3((door.min.x + door.max.x) / 2, 0, (door.min.z + door.max.z) / 2), false);
  }

  private get m(): MonsterState {
    return this.host.state.monster;
  }

  private get now(): number {
    return this.host.state.time;
  }

  private rng(): number {
    return this.host.rng();
  }

  // =============================================================================================
  // Public API (called by GameSim)
  // =============================================================================================

  /** Escalation 0..1 (fuses inserted, round time); see MONSTER.escalation*. */
  escalation(): number {
    const s = this.host.state;
    const fuses = s.fusesRequired > 0 ? clamp(s.fusesInserted / s.fusesRequired, 0, 1) : 0;
    const t = this.now - this.roundStart - MONSTER.escalationGrace;
    const time = clamp(t / Math.max(1, MONSTER.escalationTime - MONSTER.escalationGrace), 0, 1);
    return clamp(0.65 * fuses + 0.35 * time, 0, 1);
  }

  /** Multiplier on all its speeds right now. */
  speedMul(): number {
    return (1 + MONSTER.escalationSpeed * this.escalation()) * (this.frenzy ? MONSTER.frenzySpeed : 1);
  }

  /** Multiplier on its hearing range right now. */
  hearingMul(): number {
    const listening = this.m.act === 'listen' ? MONSTER.listenHearing : 1;
    return (1 + MONSTER.escalationHearing * this.escalation()) * (this.frenzy ? MONSTER.frenzyHearing : 1) * listening;
  }

  /** What it is doing internally (tests / debugging). */
  debug(): { task: string; route: readonly RoutePoint[]; goal: Vec3 | null; stalk: boolean; frenzy: boolean } {
    return { task: this.task.kind, route: this.route, goal: this.routeGoal, stalk: this.stalk, frenzy: this.frenzy };
  }

  /** It heard a noise at `pos` with hearing ratio `ratio` (>= 1). */
  onHeard(pos: Vec3, pid: PlayerId | null, ratio: number, out: SimEvent[]): void {
    const m = this.m;
    if (m.mode === 'feeding') return;
    this.remember(pos, ratio);
    const chaseR = this.chaseRatio();
    const cur = this.currentStim();
    switch (m.mode) {
      case 'wander':
        if (ratio >= chaseR) this.enterChase(pos, pid, out, true);
        else this.enterInvestigate(pos, pid, ratio, out, true, false);
        this.setStim(ratio);
        return;
      case 'investigate': {
        if (ratio >= chaseR) {
          this.enterChase(pos, pid, out, true);
          this.setStim(ratio);
          return;
        }
        if (this.stalk && this.sameSource(pos, pid)) {
          // Heard the sound it is stalking again: commit.
          if (distXZ(m.position, pos) <= MONSTER.lungeRange) this.enterChase(pos, pid, out, true);
          else this.investigateAgain(pos, pid, false);
          this.setStim(Math.max(ratio, cur));
          return;
        }
        const idle = this.task.kind !== 'approach' && this.task.kind !== 'orient';
        if (idle || ratio >= cur) {
          this.investigateAgain(pos, pid, ratio < MONSTER.stalkRatio && (idle || this.stalk));
          this.setStim(ratio);
        }
        return;
      }
      case 'chase':
        if (pid === m.targetPlayer && (pid !== null || ratio >= chaseR)) {
          // The chased player (or the same unattributed source) keeps making noise: refresh.
          const gap = this.now - this.chaseHeardAt;
          this.chasePos = v3(pos.x, pos.y, pos.z);
          this.chaseHeardAt = this.now;
          this.routeDirty = true;
          this.pushTrack(pos);
          this.setStim(Math.max(cur, ratio));
          if (gap > BRAIN_TUNING.chaseRegainGap) {
            out.push({ type: 'monsterAlert', mode: 'chase', position: copy3(m.position) });
          }
        } else if (ratio >= chaseR && ratio >= cur) {
          this.enterChase(pos, pid, out, true);
          this.setStim(ratio);
        }
        return;
    }
  }

  /** It touched a (possibly silent) alive player at `head`. */
  onTouch(head: Vec3, pid: PlayerId, out: SimEvent[]): void {
    const m = this.m;
    if (m.mode === 'feeding') return;
    if (m.mode !== 'chase' || m.targetPlayer !== pid) {
      this.enterChase(head, pid, out, true);
      this.setStim(HEARING.chaseRatio);
    } else {
      this.chasePos = copy3(head);
      this.chaseHeardAt = this.now;
      this.routeDirty = true;
      this.pushTrack(head);
    }
  }

  /** The sim caught a player at `at` (by touch or sweep): feed. */
  onCaught(at: Vec3): void {
    const m = this.m;
    m.mode = 'feeding';
    m.speed = 0;
    m.target = null;
    m.targetPlayer = null;
    this.route = [];
    this.routeGoal = null;
    this.needPlan = false;
    this.chasePos = null;
    this.stalk = false;
    this.stimScore = 0;
    this.task = { kind: 'feed', until: this.now + GAME.feedingTime, at: v3(at.x, 0.4, at.z) };
    this.want('none', this.task.at);
    // Caught mid-stride (contacts are checked after its move): it stops dead.
    m.gait = 'still';
    if (m.act !== 'none' && m.act !== 'climb') {
      m.act = m.position.y > 0.02 ? 'climb' : 'none';
      m.actStart = this.now;
    }
    m.focus = copy3(this.task.at);
  }

  /** The exit door just opened (with the door noise already heard or not): frenzy. */
  onExitOpened(inside: Vec3, wasWander: boolean, out: SimEvent[]): void {
    this.frenzy = true;
    this.m.alert = 1;
    if (wasWander && this.m.mode === 'wander') {
      this.enterInvestigate(inside, null, HEARING.chaseRatio * 0.9, out, true, false);
      this.setStim(1);
    }
  }

  /** One sim tick. */
  update(dt: number, out: SimEvent[]): void {
    const m = this.m;
    this.tickNo++;
    this.moving = false;
    this.planTokens = Math.min(NAV.planBurst, this.planTokens + dt * NAV.plansPerSecond);
    // Moved from outside (tests, debug): the route no longer starts here.
    if (distXZ(m.position, this.lastPos) > 0.25) this.onTeleport();
    this.decayMemory(dt);
    if (this.now >= this.earshotAt || distXZ(m.position, this.earshotPos) > BRAIN_TUNING.earshotMove) {
      this.earshotAt = this.now + BRAIN_TUNING.earshotEvery;
      this.earshotPos.x = m.position.x;
      this.earshotPos.z = m.position.z;
      this.markEarshot();
    }

    switch (this.task.kind) {
      case 'feed':
        this.updateFeed();
        break;
      case 'patrol':
      case 'pause':
        this.updatePatrol(dt);
        break;
      case 'chase':
        this.updateChase(dt, out);
        break;
      case 'act':
        this.updateAct(dt, out);
        break;
      default:
        this.updateInvestigate(dt);
    }
    if (!this.moving) m.speed = 0;
    this.finishBody(dt);
    this.lastPos.x = m.position.x;
    this.lastPos.z = m.position.z;
  }

  // =============================================================================================
  // Modes
  // =============================================================================================

  private chaseRatio(): number {
    let r: number = HEARING.chaseRatio;
    if (this.frenzy) r *= MONSTER.frenzyChaseRatio;
    if (this.task.kind === 'lurk') r = Math.min(r, MONSTER.lurkChaseRatio);
    return r;
  }

  private chaseForget(): number {
    return HEARING.chaseForget * (1 + 0.5 * this.escalation()) * (this.frenzy ? 1.4 : 1);
  }

  /** Shorter pauses as it escalates. */
  private patience(): number {
    return (1 - 0.3 * this.escalation()) * (this.frenzy ? 0.6 : 1);
  }

  private currentStim(): number {
    const age = this.now - this.stimTime;
    return this.stimScore * Math.max(0, 1 - age / BRAIN_TUNING.stimulusDecaySeconds);
  }

  private setStim(score: number): void {
    this.stimScore = score;
    this.stimTime = this.now;
  }

  private sameSource(pos: Vec3, pid: PlayerId | null): boolean {
    if (pid !== null && pid === this.stalkPid) return true;
    return this.noisePos !== null && distXZ(pos, this.noisePos) < 2.5;
  }

  private enterWander(): void {
    const m = this.m;
    this.want('none', null);
    m.mode = 'wander';
    m.target = null;
    m.targetPlayer = null;
    this.task = { kind: 'patrol' };
    this.route = [];
    this.routeGoal = null;
    this.needPlan = false;
    this.patrolGoal = null;
    this.stalk = false;
    this.afterChase = false;
    this.chasePos = null;
    this.stimScore = 0;
    this.probes = [];
    this.resetStuck();
  }

  private enterInvestigate(
    pos: Vec3,
    pid: PlayerId | null,
    ratio: number,
    out: SimEvent[],
    alert: boolean,
    afterChase: boolean,
  ): void {
    const m = this.m;
    this.want('listen', pos);
    m.mode = 'investigate';
    m.targetPlayer = null;
    this.afterChase = afterChase;
    this.chasePos = null;
    this.probes = [];
    this.stalk = ratio < MONSTER.stalkRatio && !afterChase && !this.frenzy;
    this.stalkPid = pid;
    this.noisePos = copy3(pos);
    this.setGoal(pos);
    this.beginStalkLeg();
    if (afterChase) this.task = { kind: 'approach' };
    else {
      const freeze = this.stalk ? lerp(MONSTER.stalkOrientMin, MONSTER.stalkOrientMax, this.rng()) : MONSTER.orientTime;
      this.task = { kind: 'orient', until: this.now + freeze };
    }
    if (alert) out.push({ type: 'monsterAlert', mode: 'investigate', position: copy3(m.position) });
  }

  /** A new noise while already investigating: go there instead (no new alert). */
  private investigateAgain(pos: Vec3, pid: PlayerId | null, stalk: boolean): void {
    const wasIdle = this.task.kind !== 'approach' && this.task.kind !== 'orient';
    this.stalk = stalk && !this.frenzy;
    this.stalkPid = pid;
    this.probes = [];
    const same = !wasIdle && this.routeGoal !== null && distXZ(pos, this.routeGoal) < 0.5;
    this.noisePos = copy3(pos);
    if (same && this.route.length > 0) {
      // Same spot again (e.g. continuous talking): keep walking the current route.
      this.routeGoal = copy3(pos);
      this.m.target = v3(pos.x, 0, pos.z);
      return;
    }
    this.setGoal(pos);
    this.beginStalkLeg();
    if (wasIdle) this.task = { kind: 'orient', until: this.now + (stalk ? MONSTER.stalkOrientMin : MONSTER.orientTime) };
  }

  private enterChase(pos: Vec3, pid: PlayerId | null, out: SimEvent[], alert: boolean): void {
    const m = this.m;
    this.want('none', pos);
    m.mode = 'chase';
    m.targetPlayer = pid;
    this.stalk = false;
    this.probes = [];
    this.chasePos = copy3(pos);
    this.chaseHeardAt = this.now;
    this.track = [];
    this.pushTrack(pos);
    this.setGoal(pos);
    this.replanAt = this.now;
    this.routeDirty = false;
    this.task = { kind: 'chase' };
    if (alert) out.push({ type: 'monsterAlert', mode: 'chase', position: copy3(m.position) });
  }

  // =============================================================================================
  // Wander: patrol rooms with intent
  // =============================================================================================

  private updatePatrol(dt: number): void {
    const t = this.task;
    if (t.kind === 'pause') {
      this.gaitIntent = 'still';
      this.want(t.act, t.focus);
      this.turnToward(yawTowards(this.m.position, t.focus), dt * 0.6);
      if (this.now >= t.until) this.task = { kind: 'patrol' };
      return;
    }
    if (!this.patrolGoal) this.choosePatrolGoal();
    this.gaitIntent = 'walk';
    this.want('none', null);
    // Roams briskly over to the next room, prowls slower inside it.
    const inRoom = regionAt(this.g, this.m.position.x, this.m.position.z) === this.patrolRegion;
    const res = this.moveAlong(dt, (inRoom ? MONSTER.wanderSpeed : MONSTER.roamSpeed) * (this.frenzy ? 1.3 : 1));
    if (res === 'arrived') {
      this.patrolLeft--;
      this.patrolGoal = null;
      this.routeGoal = null;
      this.m.target = null;
      if (this.rng() < MONSTER.patrolPauseChance) this.startPause();
    } else if (res === 'stuck' && this.stuckCount >= 2) {
      this.patrolGoal = null;
      this.stuckCount = 0;
    }
  }

  private startPause(): void {
    const m = this.m;
    const sniff = this.rng() < 0.45;
    const yaw = m.yaw + (this.rng() - 0.5) * 1.6;
    const d = sniff ? 1.2 : 2.5;
    const focus = v3(m.position.x - Math.sin(yaw) * d, sniff ? 0.5 : 1.4, m.position.z - Math.cos(yaw) * d);
    const dur = span(MONSTER.patrolPause, this.rng()) * this.patience();
    this.task = { kind: 'pause', until: this.now + dur, act: sniff ? 'sniff' : 'listen', focus };
  }

  /** Mark the floor within earshot (normal talk, walls muffling) as listened to now. */
  private markEarshot(): void {
    const L = this.g.listen;
    const m = this.m;
    const hy = m.position.y + MONSTER.height - PLAYER.eyeHeight;
    const R = NOISE.talk * HEARING.rangeMeters * this.hearingMul();
    for (let i = 0; i < L.n; i++) {
      const dx = L.x[i] - m.position.x;
      const dz = L.z[i] - m.position.z;
      const d = Math.sqrt(dx * dx + dz * dz + hy * hy);
      if (d > R) continue;
      const maxWalls = Math.floor((R / d - 1) / HEARING.wallOcclusion) + 1;
      const walls = wallsCrossed(this.g, m.position.x, m.position.z, L.x[i], L.z[i], maxWalls);
      if (d * (1 + HEARING.wallOcclusion * walls) <= R) this.heardAt[i] = this.now;
    }
  }

  /** Per room: 0 (just listened to all of it) .. 1 (none of it heard for earshotStale s). */
  private staleness(): number[] {
    const L = this.g.listen;
    const sum = this.g.regions.map(() => 0);
    const cnt = this.g.regions.map(() => 0);
    for (let i = 0; i < L.n; i++) {
      const r = L.region[i];
      if (r < 0) continue;
      sum[r] += Math.min(BRAIN_TUNING.earshotStale, this.now - this.heardAt[i]);
      cnt[r]++;
    }
    return sum.map((v, r) => (cnt[r] > 0 ? v / cnt[r] / BRAIN_TUNING.earshotStale : 0));
  }

  private regionHeat(r: number): number {
    let h = 0;
    for (const s of this.hot) if (s.region === r) h += s.heat;
    return h;
  }

  private heatNear(p: Vec3): number {
    let h = 0;
    for (const s of this.hot) h += s.heat * Math.exp(-Math.hypot(s.x - p.x, s.z - p.z) / BRAIN_TUNING.noiseMemoryReach);
    return h;
  }

  private weightedPick<T>(items: readonly T[], weight: (t: T) => number): T | null {
    let total = 0;
    const ws = items.map((t) => {
      const w = Math.max(0, weight(t));
      total += w;
      return w;
    });
    if (items.length === 0 || total <= 0) return items.length > 0 ? items[0] : null;
    let pick = this.rng() * total;
    for (let i = 0; i < items.length; i++) {
      pick -= ws[i];
      if (pick <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  private choosePatrolGoal(): void {
    const m = this.m;
    const g = this.g;
    const pull = BRAIN_TUNING.noiseMemoryPull;
    let cur = regionAt(g, m.position.x, m.position.z);
    if (cur < 0) cur = this.patrolRegion;
    const here = cur >= 0 ? g.regions[cur] : null;
    let pts: Vec3[];
    if (here && cur === this.patrolRegion && this.patrolLeft > 0) {
      pts = here.patrol.filter((p) => distXZ(p, m.position) > 1.0);
    } else {
      const objective = this.objectiveRegion;
      const exitR = this.exitRegion;
      const cands = g.regions.filter((r) => r.patrol.length > 0);
      const stale = this.staleness();
      const reg = this.weightedPick(cands, (r) => {
        // Rooms it has not listened to lately, rooms where it heard things (noise memory), the
        // room players must go to, nearer rooms first; staying put is less likely.
        const k = 0.3 + 3 * stale[r.id];
        let w = k * k + pull * this.regionHeat(r.id);
        if (r.id === objective) w *= BRAIN_TUNING.objectiveBias;
        if (this.frenzy && (r.id === exitR || r.id === objective)) w *= 4;
        if (r.id === cur) w *= 0.4;
        return w / (1 + distXZ(r.center, m.position) / 10);
      });
      if (!reg) {
        this.patrolGoal = copy3(m.position);
        return;
      }
      this.patrolRegion = reg.id;
      // More points (a longer look around) in rooms it remembers noise from.
      const extra = Math.min(3, Math.floor(this.regionHeat(reg.id) * 0.6));
      this.patrolLeft = 1 + Math.floor(this.rng() * 1.8) + extra;
      pts = reg.patrol;
    }
    const p = this.weightedPick(pts.length > 0 ? pts : here!.patrol, (q) => 1 + 0.1 * pull * this.heatNear(q)) ?? m.position;
    // Not exactly on the point: a little variety.
    const jx = (this.rng() - 0.5) * 0.6;
    const jz = (this.rng() - 0.5) * 0.6;
    const c = nearestCell(g, p.x + jx, p.z + jz, 0.6, true, (i) => g.cls[i] === CELL_TALL);
    this.patrolGoal = c >= 0 ? v3(cellX(g, c), 0, cellZ(g, c)) : copy3(p);
    this.setGoal(this.patrolGoal);
  }

  // =============================================================================================
  // Investigate: orient, approach (or stalk), listen, search hiding spots, maybe lurk
  // =============================================================================================

  private beginStalkLeg(): void {
    this.stalkWalked = 0;
    this.stalkNext = span(MONSTER.stalkListenEvery, this.rng());
  }

  private updateInvestigate(dt: number): void {
    const m = this.m;
    const t = this.task;
    const noise = this.noisePos ?? m.position;
    switch (t.kind) {
      case 'orient':
        this.gaitIntent = 'still';
        this.want('listen', noise);
        this.turnToward(yawTowards(m.position, noise), dt);
        if (this.now >= t.until) this.task = { kind: 'approach' };
        return;
      case 'stalkListen':
        this.gaitIntent = 'still';
        this.want('listen', noise);
        this.turnToward(yawTowards(m.position, noise), dt);
        if (this.now >= t.until) {
          this.beginStalkLeg();
          this.task = { kind: 'approach' };
        }
        return;
      case 'approach': {
        // Stalking: walk closer first, creep the last stretch.
        const creep = this.stalk && distXZ(m.position, noise) <= MONSTER.stalkRange;
        this.gaitIntent = creep ? 'creep' : 'walk';
        this.want('none', noise);
        const res = this.moveAlong(dt, creep ? MONSTER.creepSpeed : MONSTER.investigateSpeed);
        const goal = this.routeGoal ?? noise;
        if (res === 'arrived' || (res !== 'waiting' && distXZ(m.position, goal) < 0.4 && this.route.length <= 1)) {
          this.startListening();
          return;
        }
        if (res === 'stuck' && (this.stuckCount >= 4 || (this.stuckCount >= 2 && distXZ(m.position, goal) < 1.5))) {
          this.startListening();
          return;
        }
        if (creep && this.moving) {
          this.stalkWalked += dt;
          if (this.stalkWalked >= this.stalkNext) {
            this.task = { kind: 'stalkListen', until: this.now + span(MONSTER.stalkListenTime, this.rng()) };
          }
        }
        return;
      }
      case 'listen':
        this.gaitIntent = 'still';
        this.want('listen', noise);
        // Slowly sweep the head around while listening.
        m.yaw = wrapAngle(m.yaw + Math.sin((t.until - this.now) * 1.7) * 0.9 * dt);
        if (this.now >= t.until) this.startProbes();
        return;
      case 'probe': {
        this.gaitIntent = 'creep';
        this.want('none', t.spot);
        const stop = t.act === 'sweep' ? BRAIN_TUNING.probeSweepDist : BRAIN_TUNING.probeTouchDist;
        const d = distXZ(m.position, t.spot);
        const sees = d <= stop + 0.2 && wallsBetween(this.host.level, m.position, t.spot, this.host.coll()) === 0;
        if (d <= stop && sees) {
          this.startAct(t.act, t.spot);
          return;
        }
        const res = this.moveAlong(dt, MONSTER.probeSpeed);
        if (res === 'arrived') {
          if (d < 2.2) this.startAct(t.act, t.spot);
          else this.nextProbe();
        } else if (res === 'stuck' && this.stuckCount >= 2) {
          if (d < 2.2) this.startAct(t.act, t.spot);
          else this.nextProbe();
        }
        return;
      }
      case 'lurkGo': {
        this.gaitIntent = 'creep';
        this.want('none', t.spot.focus);
        const res = this.moveAlong(dt, MONSTER.creepSpeed);
        if (res === 'arrived' || (res === 'stuck' && this.stuckCount >= 2)) {
          const dur = span(MONSTER.lurkTime, this.rng()) * this.patience();
          this.task = { kind: 'lurk', spot: t.spot, until: this.now + dur };
          this.m.target = null;
        }
        return;
      }
      case 'lurk':
        this.gaitIntent = 'still';
        this.want('lurk', t.spot.focus);
        this.turnToward(yawTowards(m.position, t.spot.focus), dt * 0.5);
        if (this.now >= t.until) this.enterWander();
        return;
      default:
        // Not an investigate task (should not happen): fall back to patrolling.
        this.enterWander();
    }
  }

  private startListening(): void {
    this.route = [];
    this.needPlan = false;
    this.m.target = null;
    const dur = MONSTER.listenTime * this.patience() * lerp(0.85, 1.15, this.rng());
    this.task = { kind: 'listen', until: this.now + dur };
  }

  /** Arrived and heard nothing more: check the likely hiding spots around. */
  private startProbes(): void {
    const center = this.noisePos ?? this.m.position;
    const n = this.frenzy
      ? 1
      : MONSTER.searchSpotsMin + Math.floor(this.rng() * (MONSTER.searchSpotsMax - MONSTER.searchSpotsMin + 1));
    this.probes = hidingSpots(this.g, center, MONSTER.searchRadius, n, () => this.rng());
    if (this.rng() < 0.4) this.startAct('sniff', v3(center.x, 0.5, center.z));
    else this.nextProbe();
  }

  private nextProbe(): void {
    const spot = this.probes.shift();
    if (!spot) {
      this.finishSearch();
      return;
    }
    const r = this.rng();
    const act: ProbeAct = r < 0.45 ? 'sweep' : r < 0.8 ? 'search' : 'sniff';
    const s = v3(spot.x, act === 'sweep' ? 0.9 : 0.5, spot.z);
    this.setGoal(s);
    this.task = { kind: 'probe', spot: s, act };
  }

  private finishSearch(): void {
    const p = this.frenzy ? 0 : MONSTER.lurkChance + (this.afterChase ? MONSTER.lurkAfterChase : 0);
    const spot = this.rng() < p ? this.pickLurk() : null;
    if (!spot) {
      this.enterWander();
      return;
    }
    this.setGoal(spot.position);
    this.task = { kind: 'lurkGo', spot };
  }

  private pickLurk(): LurkSpot | null {
    const m = this.m;
    const g = this.g;
    const cur = regionAt(g, m.position.x, m.position.z);
    const cands: LurkSpot[] = [];
    for (const r of g.regions) {
      for (const l of r.lurks) {
        const d = distXZ(l.position, m.position);
        if (r.id === cur || (d < 7 && wallsBetween(this.host.level, m.position, l.position) === 0)) {
          cands.push(l);
        }
      }
    }
    return this.weightedPick(cands, (l) => (l.door ? 2 : 1) / (1 + distXZ(l.position, m.position)));
  }

  // =============================================================================================
  // Acts: search (feel around), sniff, sweep (telegraphed swipe that can catch)
  // =============================================================================================

  private startAct(act: ProbeAct, at: Vec3): void {
    const m = this.m;
    this.route = [];
    this.needPlan = false;
    m.target = null;
    // Standing on the spot already (e.g. where it last heard its quarry): swipe straight ahead.
    const spot =
      act === 'sweep' && distXZ(at, m.position) < 0.6
        ? v3(m.position.x - Math.sin(m.yaw), at.y, m.position.z - Math.cos(m.yaw))
        : at;
    const p = this.patience();
    const dur =
      act === 'sweep'
        ? SWEEP_TOTAL
        : act === 'search'
          ? span(MONSTER.searchTime, this.rng()) * p
          : span(MONSTER.sniffTime, this.rng()) * p;
    this.task = { kind: 'act', act, spot: copy3(spot), until: this.now + dur, struck: false };
    this.actRestart = true;
    this.want(act, spot);
  }

  private updateAct(dt: number, out: SimEvent[]): void {
    const t = this.task;
    if (t.kind !== 'act') return;
    const m = this.m;
    this.gaitIntent = 'still';
    this.want(t.act, t.spot);
    this.turnToward(yawTowards(m.position, t.spot), dt);
    if (t.act === 'sweep') {
      const e = this.now - m.actStart;
      if (m.mode === 'chase' && e < MONSTER.sweepWindup && this.routeDirty && this.chasePos) {
        // Its quarry made noise out of reach during the wind-up: abort and run.
        if (distXZ(m.position, this.chasePos) > MONSTER.sweepReach + 0.3) {
          this.sweepReadyAt = this.now + 0.5;
          this.task = { kind: 'chase' };
          return;
        }
      }
      if (!t.struck && e >= MONSTER.sweepWindup && e <= MONSTER.sweepWindup + MONSTER.sweepStrike + 1e-9) {
        if (this.sweepHits(out)) return;
      }
      if (e >= MONSTER.sweepWindup + MONSTER.sweepStrike) t.struck = true;
    } else if (t.act === 'search') {
      // Feeling around: a player within arm's reach in front is touched.
      if (this.feel(out)) return;
      m.yaw = wrapAngle(m.yaw + Math.sin((this.now - m.actStart) * 3.1) * 0.6 * dt);
    }
    if (this.now < t.until) return;
    this.sweepReadyAt = t.act === 'sweep' ? this.now + BRAIN_TUNING.sweepCooldown : this.sweepReadyAt;
    if (m.mode === 'chase') {
      this.task = { kind: 'chase' };
      return;
    }
    if (t.act === 'sniff' && this.rng() < 0.5) {
      // Smelled something there? Swipe at it.
      this.startAct('sweep', v3(t.spot.x, 0.9, t.spot.z));
      return;
    }
    this.nextProbe();
  }

  /** The strike of a sweep: catches the first alive player in reach. */
  private sweepHits(out: SimEvent[]): boolean {
    const m = this.m;
    const s = this.host.state;
    for (const id of Object.keys(s.players)) {
      const p = s.players[id];
      if (p.status !== 'alive') continue;
      const head = p.pose.head.position;
      if (distXZ(m.position, head) > MONSTER.sweepReach) continue;
      if (Math.abs(angleDelta(m.yaw, yawTowards(m.position, head))) > MONSTER.sweepArc) continue;
      if (wallsBetween(this.host.level, v3(m.position.x, head.y, m.position.z), head, this.host.coll()) > 0) continue;
      this.host.catchPlayer(p, out);
      return true;
    }
    return false;
  }

  /** Searching hands: a player within MONSTER.searchFeel in front is noticed (touched). */
  private feel(out: SimEvent[]): boolean {
    const m = this.m;
    const s = this.host.state;
    for (const id of Object.keys(s.players)) {
      const p = s.players[id];
      if (p.status !== 'alive') continue;
      const head = p.pose.head.position;
      if (distXZ(m.position, head) > MONSTER.searchFeel) continue;
      if (Math.abs(angleDelta(m.yaw, yawTowards(m.position, head))) > 1.75) continue;
      if (wallsBetween(this.host.level, v3(m.position.x, head.y, m.position.z), head, this.host.coll()) > 0) continue;
      this.onTouch(head, id, out);
      return true;
    }
    return false;
  }

  // =============================================================================================
  // Chase (with prediction) and feeding
  // =============================================================================================

  private pushTrack(p: Vec3): void {
    this.track.push({ x: p.x, z: p.z, t: this.now });
    if (this.track.length > 8) this.track.shift();
  }

  /** Where to run: the last heard spot, or ahead along a noisy runner's recent track. */
  private chaseGoal(): Vec3 {
    const last = this.chasePos!;
    const tr = this.track;
    const m = this.m;
    const d = distXZ(m.position, last);
    if (tr.length < 2 || d < 2.5) return last;
    const newest = tr[tr.length - 1];
    let old = null as { x: number; z: number; t: number } | null;
    for (let i = tr.length - 2; i >= 0; i--) {
      if (newest.t - tr[i].t > 2.0) break;
      if (newest.t - tr[i].t >= 0.4) old = tr[i];
    }
    if (!old) return last;
    const dt = newest.t - old.t;
    let vx = (newest.x - old.x) / dt;
    let vz = (newest.z - old.z) / dt;
    const spd = Math.hypot(vx, vz);
    if (spd < 0.5) return last;
    if (spd > 4) {
      vx *= 4 / spd;
      vz *= 4 / spd;
    }
    const lead = Math.min(MONSTER.chaseLead, (d / MONSTER.chaseSpeed) * 0.6);
    for (const k of [1, 0.5]) {
      const p = v3(last.x + vx * lead * k, last.y, last.z + vz * lead * k);
      const c = nearestCell(this.g, p.x, p.z, 0.4, true);
      if (c >= 0 && wallsBetween(this.host.level, last, p, this.host.coll()) === 0) return p;
    }
    return last;
  }

  private updateChase(dt: number, out: SimEvent[]): void {
    const m = this.m;
    const s = this.host.state;
    if (!this.chasePos || this.now - this.chaseHeardAt > this.chaseForget()) {
      // Lost them: go check the last place we heard them.
      this.enterInvestigate(this.chasePos ?? m.position, null, HEARING.chaseRatio, out, true, true);
      return;
    }
    if (m.targetPlayer !== null) {
      const tp = Object.prototype.hasOwnProperty.call(s.players, m.targetPlayer) ? s.players[m.targetPlayer] : undefined;
      if (!tp || tp.status !== 'alive') m.targetPlayer = null;
    }
    if (this.routeDirty && this.now - this.replanAt >= BRAIN_TUNING.chaseReplanInterval) {
      const goal = this.chaseGoal();
      if (!this.retarget(goal)) this.setGoal(goal);
      this.replanAt = this.now;
      this.routeDirty = false;
    }
    const focus = this.chasePos;
    this.gaitIntent = 'run';
    this.want('none', focus);
    const res = this.moveAlong(dt, MONSTER.chaseSpeed);
    if (res === 'arrived') {
      m.target = null;
      const fresh = this.now - this.chaseHeardAt < BRAIN_TUNING.sweepFresh;
      if (fresh && this.now >= this.sweepReadyAt && distXZ(m.position, focus) <= MONSTER.sweepReach) {
        this.startAct('sweep', v3(focus.x, 0.9, focus.z));
        return;
      }
      // At the last spot we heard them: stand still and listen.
      this.gaitIntent = 'still';
      this.want('listen', focus);
      this.turnToward(yawTowards(m.position, focus), dt);
    } else if (res === 'stuck' && this.stuckCount >= 3) {
      this.nudge();
    }
  }

  private updateFeed(): void {
    const t = this.task;
    if (t.kind !== 'feed') return;
    this.gaitIntent = 'still';
    this.want('none', t.at);
    if (this.now >= t.until) this.enterWander();
  }

  // =============================================================================================
  // Movement
  // =============================================================================================

  private setGoal(p: Vec3): void {
    this.routeGoal = v3(p.x, 0, p.z);
    this.route = [];
    this.needPlan = true;
    this.stuckCount = 0;
    this.m.target = v3(p.x, 0, p.z);
    this.resetStuck();
  }

  /** Move the end of the current route to a nearby new goal without re-planning, if that leg stays clear. */
  private retarget(goal: Vec3): boolean {
    if (!this.routeGoal || this.needPlan || this.route.length === 0) return false;
    if (distXZ(goal, this.routeGoal) > 0.75) return false;
    const last = this.route[this.route.length - 1];
    const prev = this.route.length >= 2 ? this.route[this.route.length - 2] : this.m.position;
    const to = v3(goal.x, 0, goal.z);
    if (!segmentClearFor(this.g, last.kind, v3(prev.x, 0, prev.z), to, this.host.state.exitOpen)) return false;
    last.x = to.x;
    last.z = to.z;
    this.routeGoal = to;
    this.m.target = copy3(to);
    return true;
  }

  private onTeleport(): void {
    this.route = [];
    if (this.routeGoal) this.needPlan = true;
    this.crawling = false;
    this.resetStuck();
  }

  /** A* costs = travel time per meter relative to open floor, at this pace. */
  private costsFor(base: number): ClassCosts {
    const s = base * this.speedMul();
    const crawl = s / Math.min(s * MONSTER.crawlSpeedMul, MONSTER.crawlSpeedMax);
    const climb = s / Math.min(s * MONSTER.climbSpeedMul, MONSTER.climbSpeedMax);
    return [0, 1, 1 / MONSTER.duckSpeedMul, crawl * NAV.crawlReluctance, climb * NAV.climbReluctance];
  }

  private tryPlan(base: number): boolean {
    if (!this.routeGoal) return false;
    if (this.planTokens < 1 || this.planTick === this.tickNo) return false;
    this.planTokens -= 1;
    this.planTick = this.tickNo;
    planRoute(this.g, this.m.position, this.routeGoal, this.route, this.host.state.exitOpen, this.costsFor(base));
    this.needPlan = false;
    this.resetStuck();
    return true;
  }

  private bodyRadius(kind: SegKind): number {
    return kind !== 'upright' || this.crawling ? MONSTER.crawlRadius : MONSTER.radius;
  }

  private speedFor(base: number, kind: SegKind): number {
    const m = this.m;
    let s = base * this.speedMul();
    if (kind === 'climb' || m.position.y > 0.02) s = Math.min(s * MONSTER.climbSpeedMul, MONSTER.climbSpeedMax);
    else if (kind === 'crawl' || this.crawling) s = Math.min(s * MONSTER.crawlSpeedMul, MONSTER.crawlSpeedMax);
    // Ducks a step early (lookahead) so a whole step that ends under the lintel is slowed.
    else if (underLintel(this.g, m.position.x, m.position.z, MONSTER.radius + 0.15, m.position.y + MONSTER.standHeight)) {
      s *= MONSTER.duckSpeedMul;
    }
    return s;
  }

  /** Follow the route (planning it first if needed). */
  private moveAlong(dt: number, baseSpeed: number): MoveResult {
    if (this.needPlan && !this.tryPlan(baseSpeed)) return 'waiting';
    if (this.route.length === 0) return 'arrived';
    const wp = this.route[0];
    const last = this.route.length === 1;
    this.segKind = wp.kind;
    const reached = this.stepToward(
      wp,
      this.speedFor(baseSpeed, wp.kind),
      dt,
      this.bodyRadius(wp.kind),
      last ? BRAIN_TUNING.goalRadius : BRAIN_TUNING.waypointRadius,
    );
    if (reached) {
      this.route.shift();
      this.resetStuck();
      if (this.route.length === 0) return 'arrived';
      return 'moving';
    }
    if (this.isStuck(dt)) {
      this.stuckCount++;
      this.needPlan = true;
      return 'stuck';
    }
    return 'moving';
  }

  /** Get out of a jam: walk to an open spot nearby, then re-plan to the goal. */
  private nudge(): void {
    const m = this.m;
    const g = this.g;
    const c = nearestCell(g, m.position.x + (this.rng() - 0.5) * 1.2, m.position.z + (this.rng() - 0.5) * 1.2, 2, true, (i) =>
      g.cls[i] === CELL_TALL && g.allClear[i] >= MONSTER.radius + 0.25,
    );
    this.stuckCount = 0;
    if (c < 0) return;
    this.route = [{ x: cellX(g, c), z: cellZ(g, c), kind: 'upright' }];
    this.needPlan = false;
    // Walk there for a moment, then re-plan to the quarry.
    this.routeDirty = true;
    this.replanAt = this.now + 0.6;
  }

  private turnToward(yaw: number, dt: number): void {
    const m = this.m;
    const d = angleDelta(m.yaw, yaw);
    const maxTurn = MONSTER.turnSpeed * dt;
    m.yaw = wrapAngle(m.yaw + clamp(d, -maxTurn, maxTurn));
  }

  /**
   * Walk toward `p` (XZ) at up to `speed`: turns smoothly, slower while still facing away.
   * Collides with walls / tall furniture only: low furniture it climbs (see finishBody).
   */
  private stepToward(p: { x: number; z: number }, speed: number, dt: number, radius: number, arrive: number): boolean {
    const m = this.m;
    const dx = p.x - m.position.x;
    const dz = p.z - m.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= arrive) return true;
    const want = Math.atan2(-dx, -dz);
    this.turnToward(want, dt);
    const facing = Math.max(0, Math.cos(angleDelta(m.yaw, want)));
    const stepLen = Math.min(speed * facing * dt, dist);
    if (stepLen > 1e-6) {
      const solids = this.host.state.exitOpen ? this.g.hardOpen : this.g.hard;
      const np = moveCircleAmong(solids, m.position, v3((dx / dist) * stepLen, 0, (dz / dist) * stepLen), radius);
      m.speed = Math.hypot(np.x - m.position.x, np.z - m.position.z) / dt;
      m.position.x = np.x;
      m.position.z = np.z;
      this.moving = true;
    }
    return Math.hypot(p.x - m.position.x, p.z - m.position.z) <= arrive;
  }

  private resetStuck(): void {
    this.stuckT = 0;
    this.stuckRef = copy3(this.m.position);
  }

  private isStuck(dt: number): boolean {
    this.stuckT += dt;
    if (this.stuckT < BRAIN_TUNING.stuckWindow) return false;
    const moved = distXZ(this.m.position, this.stuckRef);
    this.resetStuck();
    return moved < BRAIN_TUNING.stuckDistance;
  }

  // =============================================================================================
  // Body language
  // =============================================================================================

  private want(act: MonsterAct, focus: Vec3 | null): void {
    this.wantAct = act;
    this.wantFocus = focus;
  }

  /** Work out what its body is truthfully doing here and commit gait / posture / act / focus. */
  private finishBody(dt: number): void {
    const m = this.m;
    const g = this.g;
    const { x, z } = m.position;
    // Height: resting on the low furniture under its body.
    const top = surfaceTop(g, x, z, 0.12);
    const y = m.position.y;
    const rise = MONSTER.climbRiseSpeed * dt;
    m.position.y = top > y ? Math.min(top, y + rise) : Math.max(top, y - rise * 1.5);
    if (m.position.y < 1e-4) m.position.y = 0;
    const onFurniture = m.position.y > 0.02 || top > 0.01;
    // Does the upright body fit here? (with hysteresis so it does not flicker at an edge)
    const clr = bodyClearance(g, x, z);
    const low = onFurniture || clr < MONSTER.radius - 0.01 || (this.moving && this.segKind !== 'upright');
    if (this.crawling) {
      if (!low && clr >= MONSTER.radius + 0.03) this.crawling = false;
    } else if (low) this.crawling = true;
    m.posture = this.crawling
      ? 'crawl'
      : underLintel(g, x, z, MONSTER.radius, m.position.y + MONSTER.standHeight)
        ? 'duck'
        : 'tall';

    // Act + focus.
    let act = this.wantAct;
    if (act === 'none' && onFurniture) act = 'climb';
    if (act !== m.act || this.actRestart) {
      m.act = act;
      m.actStart = this.now;
    }
    this.actRestart = false;
    const f = this.wantFocus;
    if (!f) m.focus = null;
    else if (m.focus) {
      m.focus.x = f.x;
      m.focus.y = f.y;
      m.focus.z = f.z;
    } else m.focus = copy3(f);

    // Gait: what it means to do, never claiming faster than it actually moves.
    // Smoothed speed: quick to rise, a little slower to fall (no flicker in tight turns).
    this.gaitSpeed += (m.speed - this.gaitSpeed) * Math.min(1, dt / 0.15);
    const sp = Math.max(this.gaitSpeed, m.speed * 0.8);
    const want = this.gaitIntent;
    let gait: MonsterGait;
    if (m.speed < 0.05) gait = 'still';
    else if (want === 'still') gait = sp > 1.5 ? 'run' : sp > 0.8 ? 'walk' : 'creep';
    else if (want === 'run' && sp < 1.5) gait = sp < 0.45 ? 'creep' : 'walk';
    else if (want === 'walk' && sp < 0.45) gait = 'creep';
    else gait = want;
    m.gait = gait;
  }

  // =============================================================================================
  // Noise memory
  // =============================================================================================

  private remember(pos: Vec3, ratio: number): void {
    if (!this.host.noiseMemory) return;
    const T = BRAIN_TUNING;
    const amount = T.noiseMemoryPerNoise * Math.min(3, ratio);
    for (const s of this.hot) {
      if (Math.hypot(s.x - pos.x, s.z - pos.z) <= T.noiseMemoryMerge) {
        s.heat = Math.min(T.noiseMemoryCap, s.heat + amount);
        return;
      }
    }
    const g = this.g;
    const c = nearestCell(g, pos.x, pos.z, 2, true, (i) => g.region[i] >= 0);
    this.hot.push({ x: pos.x, z: pos.z, heat: amount, region: c >= 0 ? g.region[c] : -1 });
    if (this.hot.length > T.noiseMemorySpots) {
      let k = 0;
      for (let i = 1; i < this.hot.length; i++) if (this.hot[i].heat < this.hot[k].heat) k = i;
      this.hot.splice(k, 1);
    }
  }

  private decayMemory(dt: number): void {
    if (this.hot.length === 0) return;
    const fade = Math.pow(0.5, dt / BRAIN_TUNING.noiseMemoryHalfLife);
    for (const s of this.hot) s.heat *= fade;
    if (this.hot[0].heat < 0.005) this.hot = this.hot.filter((s) => s.heat >= 0.005);
  }
}
