import { GAME, HEARING, MONSTER, NOISE, PLAYER, PLAYER_COLORS } from '../config';
import type {
  Box,
  Handedness,
  HandPose,
  ItemKind,
  ItemState,
  LevelData,
  NavNode,
  NoiseEvent,
  PlayerAction,
  PlayerId,
  PlayerPose,
  PlayerState,
  SimEvent,
  Vec3,
  WorldState,
} from './types';
import {
  add3,
  angleDelta,
  clamp,
  copy3,
  copyQuat,
  dist3,
  distXZ,
  isFiniteVec3,
  lerp,
  makeRng,
  mixSeed,
  normalize3,
  quatFromYaw,
  rotate3,
  v3,
  wrapAngle,
  yawFromQuat,
  yawTowards,
} from './math';
import {
  moveCircle,
  pointInBox,
  pushOut,
  pushOutOf,
  segmentClear,
  supportHeight,
  SUPPORT_TOLERANCE,
  wallBoxes,
  wallsBetween,
  type CollisionOptions,
} from './physics';
import { findPath, nearestNavNode } from './nav';

export interface SimOptions {
  fusesRequired?: number;
  startingFilm?: number;
}

/** Sim-private tunables (shared "feel" numbers live in config.ts). */
export const SIM_TUNING = {
  /** Monster body radius on the XZ plane. */
  monsterRadius: 0.35,
  /** Clearance used for the monster's own straight-line checks (slightly under its radius). */
  pathClearance: 0.33,
  /** Distance at which a waypoint counts as reached. */
  waypointRadius: 0.3,
  /** A held fuse this close (m, 3D) to the fuse box goes in. */
  fuseInsertDistance: 0.6,
  /** Alert decays from 1 to 0 over this many seconds. */
  alertDecaySeconds: 8,
  /** How fast the "priority" of the current stimulus fades (s), so newer noises can override. */
  stimulusDecaySeconds: 4,
  /** Hearing the chased player again after this long a silence re-emits a 'monsterAlert'. */
  chaseRegainGap: 1.5,
  /** Min seconds between chase re-plans. */
  chaseReplanInterval: 0.25,
  /** Chance to pause at each wander node, and pause duration range. */
  wanderPauseChance: 0.22,
  wanderPauseMin: 1.2,
  wanderPauseMax: 3.5,
  /** If the monster moves less than stuckDistance in stuckWindow seconds while walking, it re-plans. */
  stuckWindow: 1.25,
  stuckDistance: 0.12,
  /** The sim advances in ticks of at most this many seconds. */
  maxTick: 1 / 30,
  /** Loudness of a dry trigger click. */
  dryFireLoudness: NOISE.cameraClick * 0.25,
  /** Radius used to keep dropped things out of walls. */
  itemRadius: 0.05,
  /**
   * The exit door opening is the climax: when true, the monster at least investigates the door
   * even if the door noise alone would not reach it through the house.
   */
  exitDoorAlwaysAlerts: true,
} as const;

const HANDS: readonly Handedness[] = ['left', 'right'];
const NEVER = -1e9;

/** Default (untracked) pose for a player standing at `feet` facing `yaw`. */
export function makeSpawnPose(feet: Vec3, yaw: number): PlayerPose {
  const rot = quatFromYaw(yaw);
  const head = v3(feet.x, feet.y + PLAYER.eyeHeight, feet.z);
  const hand = (side: number): HandPose => ({
    tracked: false,
    position: add3(head, rotate3(rot, v3(0.22 * side, -0.55, -0.25))),
    rotation: copyQuat(rot),
    curls: [0.2, 0.2, 0.2, 0.2, 0.2],
  });
  return { head: { position: copy3(head), rotation: copyQuat(rot) }, left: hand(-1), right: hand(1) };
}

function clonePose(p: PlayerPose): PlayerPose {
  const hand = (h: HandPose): HandPose => ({
    tracked: !!h.tracked,
    position: copy3(h.position),
    rotation: copyQuat(h.rotation),
    curls: [h.curls[0], h.curls[1], h.curls[2], h.curls[3], h.curls[4]],
  });
  return {
    head: { position: copy3(p.head.position), rotation: copyQuat(p.head.rotation) },
    left: hand(p.left),
    right: hand(p.right),
  };
}

const flat = (p: Vec3): Vec3 => ({ x: p.x, y: 0, z: p.z });
const isHand = (h: unknown): h is Handedness => h === 'left' || h === 'right';

/** Monster AI memory that is not part of the networked state. */
interface Brain {
  /** Remaining waypoints (XZ) for investigate / chase. */
  route: Vec3[];
  /** Final destination of investigate / chase. */
  goal: Vec3 | null;
  wanderNode: number;
  prevNode: number;
  pause: number;
  listening: boolean;
  listen: number;
  feed: number;
  chasePos: Vec3 | null;
  chaseHeardAt: number;
  replanAt: number;
  routeDirty: boolean;
  stimScore: number;
  stimTime: number;
  stuckT: number;
  stuckRef: Vec3;
  stuckCount: number;
  /** Last time each nav node (by index) was visited while wandering. */
  visited: number[];
}

/**
 * Authoritative game simulation. Runs only on the host (or locally in solo play).
 * Pure logic: no rendering, audio, DOM or networking.
 */
export class GameSim {
  readonly level: LevelData;
  readonly state: WorldState;

  private readonly opts: SimOptions;
  private readonly nodeIndex: Record<number, number> = {};
  private round = 0;
  private rng: () => number;
  private nextItemId = 1;
  private joinOrder: PlayerId[] = [];
  private spawnOf: Record<PlayerId, number> = {};
  private pending: SimEvent[] = [];
  private brain: Brain;

  constructor(level: LevelData, opts: SimOptions = {}) {
    this.level = level;
    this.opts = { ...opts };
    level.nav.forEach((n, i) => (this.nodeIndex[n.id] = i));
    this.rng = makeRng(mixSeed(level.seed, 0));
    this.brain = this.freshBrain();
    this.state = {
      time: 0,
      phase: 'lobby',
      levelSeed: level.seed,
      players: {},
      monster: {
        position: flat(level.monsterSpawn),
        yaw: 0,
        mode: 'wander',
        target: null,
        targetPlayer: null,
        speed: 0,
        alert: 0,
      },
      items: [],
      camera: {
        holder: null,
        hand: null,
        position: copy3(level.cameraSpawn.position),
        yaw: level.cameraSpawn.yaw,
        film: this.startingFilm(),
        lastFlashTime: NEVER,
      },
      fusesInserted: 0,
      fusesRequired: this.fusesRequired(),
      exitOpen: false,
      lastHeard: null,
    };
    this.resetWorld();
  }

  // -------------------------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------------------------

  /** Add a player (lobby or mid-round). Assigns color + spawn. Returns the new player state. */
  addPlayer(id: PlayerId, name: string, isDesktop: boolean): PlayerState {
    const existing = this.state.players[id];
    if (existing) return existing;
    const others = Object.values(this.state.players);
    const used = new Set(others.map((p) => p.color));
    const color =
      PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[others.length % PLAYER_COLORS.length];
    const spawnIdx = this.freeSpawnIndex();
    const sp = this.level.playerSpawns[spawnIdx];
    const player: PlayerState = {
      id,
      name,
      color,
      isDesktop,
      status: 'alive',
      spawn: copy3(sp.position),
      spawnYaw: sp.yaw,
      pose: makeSpawnPose(sp.position, sp.yaw),
      held: { left: null, right: null },
    };
    this.state.players[id] = player;
    this.spawnOf[id] = spawnIdx;
    this.joinOrder.push(id);
    return player;
  }

  /** Remove a player; anything they held is dropped where their hands were. */
  removePlayer(id: PlayerId): SimEvent[] {
    const p = this.state.players[id];
    if (!p) return [];
    const out: SimEvent[] = [];
    this.dropAll(p, out, false);
    delete this.state.players[id];
    delete this.spawnOf[id];
    this.joinOrder = this.joinOrder.filter((j) => j !== id);
    if (this.state.monster.targetPlayer === id) this.state.monster.targetPlayer = null;
    this.checkEnd(out);
    return out;
  }

  /** Client-authoritative pose update. Also moves anything held in their hands. */
  setPlayerPose(id: PlayerId, pose: PlayerPose): void {
    const p = this.state.players[id];
    if (!p || !pose || !isFiniteVec3(pose.head?.position)) return;
    p.pose = clonePose(pose);
    this.syncHeld(p);
  }

  // -------------------------------------------------------------------------------------------
  // Round
  // -------------------------------------------------------------------------------------------

  /**
   * Start (or restart) a round: resets monster, items, camera, fuses, statuses; assigns spawns.
   * Sets phase 'playing'. Returns events (including { type: 'phase', phase: 'playing' }).
   */
  startRound(): SimEvent[] {
    this.round++;
    this.resetWorld();
    const s = this.state;
    const spawns = this.level.playerSpawns;
    this.joinOrder.forEach((id, i) => {
      const p = s.players[id];
      if (!p) return;
      const idx = i % spawns.length;
      this.spawnOf[id] = idx;
      p.status = 'alive';
      p.held = { left: null, right: null };
      p.spawn = copy3(spawns[idx].position);
      p.spawnYaw = spawns[idx].yaw;
      p.pose = makeSpawnPose(spawns[idx].position, spawns[idx].yaw);
    });
    s.phase = 'playing';
    this.pending = [];
    return [{ type: 'phase', phase: 'playing' }];
  }

  // -------------------------------------------------------------------------------------------
  // Noise
  // -------------------------------------------------------------------------------------------

  /** Something made a sound. Ignored unless phase === 'playing' and the source player is alive. */
  reportNoise(noise: NoiseEvent): void {
    this.hear(noise, this.pending);
  }

  // -------------------------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------------------------

  /** Apply a player's action. Returns resulting events. */
  handleAction(id: PlayerId, action: PlayerAction): SimEvent[] {
    const s = this.state;
    const p = s.players[id];
    const out: SimEvent[] = [];
    if (!p || p.status !== 'alive' || s.phase !== 'playing') return out;
    if (!action || !isHand(action.hand) || !isFiniteVec3(action.position)) return out;
    switch (action.type) {
      case 'grab':
        this.grab(p, action.hand, action.position, action.reach, out);
        break;
      case 'release':
        this.release(p, action.hand, action.position, out);
        break;
      case 'flash':
        this.flash(p, action.hand, action.position, action.direction, out);
        break;
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Step
  // -------------------------------------------------------------------------------------------

  /** Advance the simulation by dt seconds. Returns events that happened. */
  step(dt: number): SimEvent[] {
    const out = this.pending;
    this.pending = [];
    if (!(dt > 0) || !Number.isFinite(dt)) return out;
    const n = Math.min(600, Math.max(1, Math.ceil(dt / SIM_TUNING.maxTick - 1e-9)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (this.state.phase !== 'playing') {
        this.state.time += h * (n - i);
        break;
      }
      this.tick(h, out);
    }
    return out;
  }

  /** Deep copy of the state, safe to JSON-serialize and send. */
  snapshot(): WorldState {
    return structuredClone(this.state);
  }

  // ===========================================================================================
  // Internals
  // ===========================================================================================

  private startingFilm(): number {
    return Math.max(0, Math.floor(this.opts.startingFilm ?? GAME.startingFilm));
  }

  private fusesRequired(): number {
    return clamp(Math.floor(this.opts.fusesRequired ?? GAME.fusesRequired), 0, this.level.fuseSpawns.length);
  }

  private coll(): CollisionOptions {
    return { exitOpen: this.state.exitOpen };
  }

  private node(id: number): NavNode {
    return this.level.nav[this.nodeIndex[id]];
  }

  private freshBrain(): Brain {
    return {
      route: [],
      goal: null,
      wanderNode: -1,
      prevNode: -1,
      pause: 0,
      listening: false,
      listen: 0,
      feed: 0,
      chasePos: null,
      chaseHeardAt: NEVER,
      replanAt: NEVER,
      routeDirty: false,
      stimScore: 0,
      stimTime: NEVER,
      stuckT: 0,
      stuckRef: flat(this.level.monsterSpawn),
      stuckCount: 0,
      visited: this.level.nav.map(() => NEVER),
    };
  }

  private freeSpawnIndex(): number {
    const taken = new Set(Object.values(this.spawnOf));
    const n = this.level.playerSpawns.length;
    for (let i = 0; i < n; i++) if (!taken.has(i)) return i;
    return Object.keys(this.state.players).length % n;
  }

  /** Reset monster, items, camera and objective for a new round (players handled by caller). */
  private resetWorld(): void {
    const s = this.state;
    const L = this.level;
    this.rng = makeRng(mixSeed(L.seed, this.round));
    s.levelSeed = L.seed;
    s.fusesRequired = this.fusesRequired();
    s.fusesInserted = 0;
    s.exitOpen = s.fusesRequired === 0;
    s.lastHeard = null;

    // Pick fuse spots with a seeded shuffle; a film roll on every film spot.
    const order = L.fuseSpawns.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const items: ItemState[] = [];
    const make = (kind: ItemKind, pos: Vec3): ItemState => ({
      id: this.nextItemId++,
      kind,
      where: 'world',
      position: copy3(pos),
      yaw: wrapAngle(this.rng() * Math.PI * 2),
      holder: null,
      hand: null,
    });
    for (let k = 0; k < s.fusesRequired; k++) items.push(make('fuse', L.fuseSpawns[order[k]]));
    for (const f of L.filmSpawns) items.push(make('film', f));
    s.items = items;

    s.camera = {
      holder: null,
      hand: null,
      position: copy3(L.cameraSpawn.position),
      yaw: L.cameraSpawn.yaw,
      film: this.startingFilm(),
      lastFlashTime: NEVER,
    };

    s.monster = {
      position: flat(L.monsterSpawn),
      yaw: this.rng() * Math.PI * 2 - Math.PI,
      mode: 'wander',
      target: null,
      targetPlayer: null,
      speed: 0,
      alert: 0,
    };
    this.brain = this.freshBrain();
  }

  // ---- held things ----------------------------------------------------------------------------

  private syncHeld(p: PlayerState): void {
    const s = this.state;
    for (const hand of HANDS) {
      const h = p.held[hand];
      if (!h) continue;
      const hp = p.pose[hand];
      if (h.kind === 'camera') {
        s.camera.position = copy3(hp.position);
        s.camera.yaw = yawFromQuat(hp.rotation);
      } else {
        const it = s.items.find((i) => i.id === h.itemId);
        if (it) it.position = copy3(hp.position);
      }
    }
  }

  /** Where something let go at `pos` comes to rest: out of walls, on the surface below. */
  private restPoint(pos: Vec3): Vec3 {
    let p = pushOutOf(wallBoxes(this.level, this.coll()), pos, SIM_TUNING.itemRadius);
    // A hand pushed deep into a tall piece of furniture: slide the item out of it.
    const tall: Box[] = this.level.boxes.filter(
      (b) =>
        b.kind === 'furniture' &&
        b.max.y > pos.y + SUPPORT_TOLERANCE &&
        p.x >= b.min.x &&
        p.x <= b.max.x &&
        p.z >= b.min.z &&
        p.z <= b.max.z,
    );
    if (tall.length > 0) p = pushOutOf(tall, p, SIM_TUNING.itemRadius);
    return v3(p.x, supportHeight(this.level, p.x, p.z, pos.y), p.z);
  }

  private dropHand(p: PlayerState, hand: Handedness, at: Vec3, out: SimEvent[], noisy: boolean): void {
    const s = this.state;
    const h = p.held[hand];
    if (!h) return;
    p.held[hand] = null;
    const pos = this.restPoint(at);
    const yaw = yawFromQuat(p.pose[hand].rotation);
    let what: 'camera' | ItemKind;
    if (h.kind === 'camera') {
      s.camera.holder = null;
      s.camera.hand = null;
      s.camera.position = pos;
      s.camera.yaw = yaw;
      what = 'camera';
    } else {
      const it = s.items.find((i) => i.id === h.itemId);
      if (!it) return;
      it.where = 'world';
      it.holder = null;
      it.hand = null;
      it.position = pos;
      it.yaw = yaw;
      what = it.kind;
    }
    out.push({ type: 'drop', by: p.id, what, position: copy3(pos) });
    if (noisy) this.hear({ source: 'item', position: pos, loudness: NOISE.itemDrop, playerId: p.id }, out);
  }

  private dropAll(p: PlayerState, out: SimEvent[], noisy: boolean): void {
    for (const hand of HANDS) this.dropHand(p, hand, p.pose[hand].position, out, noisy);
  }

  // ---- actions --------------------------------------------------------------------------------

  private grab(p: PlayerState, hand: Handedness, at: Vec3, reach: number, out: SimEvent[]): void {
    const s = this.state;
    if (p.held[hand]) return;
    const r = clamp(Number.isFinite(reach) ? reach : 0, 0, Math.max(PLAYER.desktopGrabReach, PLAYER.vrGrabReach));
    const opts = this.coll();
    let best: { kind: 'camera' } | { kind: 'item'; item: ItemState } | null = null;
    let bestD = Infinity;
    const consider = (pos: Vec3): number => {
      const d = dist3(at, pos);
      if (d > r || d >= bestD) return Infinity;
      if (wallsBetween(this.level, at, pos, opts) > 0) return Infinity;
      return d;
    };
    if (s.camera.holder === null) {
      const d = consider(s.camera.position);
      if (d < bestD) {
        bestD = d;
        best = { kind: 'camera' };
      }
    }
    for (const it of s.items) {
      if (it.where !== 'world') continue;
      const d = consider(it.position);
      if (d < bestD) {
        bestD = d;
        best = { kind: 'item', item: it };
      }
    }
    if (!best) return;

    if (best.kind === 'camera') {
      s.camera.holder = p.id;
      s.camera.hand = hand;
      s.camera.position = copy3(at);
      p.held[hand] = { kind: 'camera' };
      out.push({ type: 'pickup', by: p.id, what: 'camera', position: copy3(s.camera.position) });
      this.hear({ source: 'item', position: s.camera.position, loudness: NOISE.itemPickup, playerId: p.id }, out);
      return;
    }
    const it = best.item;
    if (it.kind === 'film') {
      it.where = 'used';
      s.camera.film += GAME.filmPerRoll;
      out.push({
        type: 'filmLoaded',
        by: p.id,
        amount: GAME.filmPerRoll,
        total: s.camera.film,
        position: copy3(it.position),
      });
      this.hear({ source: 'item', position: it.position, loudness: NOISE.itemPickup, playerId: p.id }, out);
      return;
    }
    it.where = 'held';
    it.holder = p.id;
    it.hand = hand;
    const from = copy3(it.position);
    it.position = copy3(at);
    p.held[hand] = { kind: 'item', itemId: it.id };
    out.push({ type: 'pickup', by: p.id, what: it.kind, position: from });
    this.hear({ source: 'item', position: from, loudness: NOISE.itemPickup, playerId: p.id }, out);
  }

  private release(p: PlayerState, hand: Handedness, at: Vec3, out: SimEvent[]): void {
    if (!p.held[hand]) return;
    this.dropHand(p, hand, at, out, true);
  }

  private flash(p: PlayerState, hand: Handedness, at: Vec3, direction: Vec3, out: SimEvent[]): void {
    const s = this.state;
    const cam = s.camera;
    if (cam.holder !== p.id || cam.hand !== hand) return;
    const pos = copy3(at);
    if (cam.film > 0 && s.time - cam.lastFlashTime >= GAME.flashCooldown) {
      cam.film--;
      cam.lastFlashTime = s.time;
      const dir = isFiniteVec3(direction) ? normalize3(direction) : v3(0, 0, -1);
      out.push({ type: 'flash', by: p.id, position: pos, direction: dir, time: s.time });
      this.hear({ source: 'camera', position: pos, loudness: NOISE.cameraClick, playerId: p.id }, out);
    } else {
      out.push({ type: 'dryFire', by: p.id, position: pos });
      this.hear({ source: 'camera', position: pos, loudness: SIM_TUNING.dryFireLoudness, playerId: p.id }, out);
    }
  }

  // ---- hearing --------------------------------------------------------------------------------

  /** Loudness * range / effective distance for a noise at `pos` (0 if not heard). */
  hearingRatio(pos: Vec3, loudness: number): number {
    const m = this.state.monster;
    const head = v3(m.position.x, m.position.y + MONSTER.height, m.position.z);
    const walls = wallsBetween(this.level, pos, head, this.coll());
    const eff = dist3(pos, head) * (1 + HEARING.wallOcclusion * walls);
    const range = loudness * HEARING.rangeMeters;
    if (eff > range) return 0;
    return range / Math.max(eff, 1e-3);
  }

  private hear(noise: NoiseEvent, out: SimEvent[]): void {
    const s = this.state;
    if (s.phase !== 'playing' || !noise || !isFiniteVec3(noise.position)) return;
    const loudness = clamp(Number.isFinite(noise.loudness) ? noise.loudness : 0, 0, 1);
    if (loudness <= 0) return;
    const pid = noise.playerId ?? null;
    if (pid !== null) {
      const src = s.players[pid];
      if (!src || src.status !== 'alive') return;
    }
    const m = s.monster;
    if (m.mode === 'feeding') return;
    const ratio = this.hearingRatio(noise.position, loudness);
    if (ratio <= 0) return;
    s.lastHeard = { position: copy3(noise.position), loudness, time: s.time };
    const t = clamp((ratio - 1) / (HEARING.chaseRatio - 1), 0, 1);
    m.alert = Math.max(m.alert, 0.25 + 0.75 * t);
    this.react(noise.position, pid, ratio, out);
  }

  private currentStim(): number {
    const b = this.brain;
    const age = this.state.time - b.stimTime;
    return b.stimScore * Math.max(0, 1 - age / SIM_TUNING.stimulusDecaySeconds);
  }

  private setStim(score: number): void {
    this.brain.stimScore = score;
    this.brain.stimTime = this.state.time;
  }

  /** Decide what a heard noise does to the monster (priority: chase > investigate > wander). */
  private react(pos: Vec3, pid: PlayerId | null, ratio: number, out: SimEvent[]): void {
    const m = this.state.monster;
    const b = this.brain;
    const chaseLevel = ratio >= HEARING.chaseRatio;
    const cur = this.currentStim();
    switch (m.mode) {
      case 'feeding':
        return;
      case 'wander':
        if (chaseLevel) this.enterChase(pos, pid, out, true);
        else this.enterInvestigate(pos, out, true);
        this.setStim(ratio);
        return;
      case 'investigate':
        if (chaseLevel) {
          this.enterChase(pos, pid, out, true);
          this.setStim(ratio);
        } else if (b.listening || ratio >= cur) {
          this.retargetInvestigate(pos);
          this.setStim(ratio);
        }
        return;
      case 'chase':
        if (pid !== null && pid === m.targetPlayer) {
          // The chased player keeps making noise: refresh where we think they are.
          const gap = this.state.time - b.chaseHeardAt;
          b.chasePos = flat(pos);
          b.chaseHeardAt = this.state.time;
          b.routeDirty = true;
          this.setStim(Math.max(cur, ratio));
          if (gap > SIM_TUNING.chaseRegainGap) {
            out.push({ type: 'monsterAlert', mode: 'chase', position: copy3(m.position) });
          }
        } else if (chaseLevel && ratio >= cur) {
          this.enterChase(pos, pid, out, true);
          this.setStim(ratio);
        }
        return;
    }
  }

  // ---- monster modes --------------------------------------------------------------------------

  private resetStuck(): void {
    this.brain.stuckT = 0;
    this.brain.stuckRef = copy3(this.state.monster.position);
  }

  private isStuck(dt: number): boolean {
    const b = this.brain;
    b.stuckT += dt;
    if (b.stuckT < SIM_TUNING.stuckWindow) return false;
    const moved = distXZ(this.state.monster.position, b.stuckRef);
    this.resetStuck();
    return moved < SIM_TUNING.stuckDistance;
  }

  private enterWander(): void {
    const m = this.state.monster;
    const b = this.brain;
    m.mode = 'wander';
    m.target = null;
    m.targetPlayer = null;
    b.route = [];
    b.goal = null;
    b.wanderNode = -1;
    b.prevNode = -1;
    b.pause = 0;
    b.listening = false;
    b.chasePos = null;
    b.stimScore = 0;
    this.resetStuck();
  }

  private enterInvestigate(pos: Vec3, out: SimEvent[], alert: boolean): void {
    const m = this.state.monster;
    m.mode = 'investigate';
    m.targetPlayer = null;
    this.retargetInvestigate(pos);
    if (alert) out.push({ type: 'monsterAlert', mode: 'investigate', position: copy3(m.position) });
  }

  private retargetInvestigate(pos: Vec3): void {
    const m = this.state.monster;
    const b = this.brain;
    b.goal = this.reachable(pos);
    b.route = this.planRoute(m.position, b.goal, false);
    b.listening = false;
    b.listen = 0;
    b.pause = 0;
    b.stuckCount = 0;
    m.target = copy3(b.goal);
    this.resetStuck();
  }

  private enterChase(pos: Vec3, pid: PlayerId | null, out: SimEvent[], alert: boolean): void {
    const s = this.state;
    const m = s.monster;
    const b = this.brain;
    m.mode = 'chase';
    m.targetPlayer = pid;
    b.chasePos = flat(pos);
    b.chaseHeardAt = s.time;
    b.goal = this.reachable(pos);
    b.route = this.planRoute(m.position, b.goal, false);
    b.replanAt = s.time;
    b.routeDirty = false;
    b.listening = false;
    b.pause = 0;
    m.target = copy3(b.goal);
    this.resetStuck();
    if (alert) out.push({ type: 'monsterAlert', mode: 'chase', position: copy3(m.position) });
  }

  private enterFeeding(): void {
    const m = this.state.monster;
    const b = this.brain;
    m.mode = 'feeding';
    m.speed = 0;
    m.target = null;
    m.targetPlayer = null;
    b.route = [];
    b.goal = null;
    b.chasePos = null;
    b.listening = false;
    b.feed = GAME.feedingTime;
    b.stimScore = 0;
  }

  private startListening(): void {
    const m = this.state.monster;
    const b = this.brain;
    b.listening = true;
    b.listen = MONSTER.listenTime;
    b.route = [];
    m.speed = 0;
    m.target = null;
  }

  /** Closest spot to `pos` (on the floor) that the monster's body can actually stand on. */
  private reachable(pos: Vec3): Vec3 {
    const bnd = this.level.bounds;
    const p = v3(clamp(pos.x, bnd.min.x, bnd.max.x), 0, clamp(pos.z, bnd.min.z, bnd.max.z));
    const c = pushOut(this.level, p, SIM_TUNING.monsterRadius + 0.03, this.coll());
    return v3(p.x + c.x, 0, p.z + c.z);
  }

  /** Waypoints from `from` to `goal`: straight if clear, else via the nav graph (string-pulled). */
  private planRoute(from: Vec3, goal: Vec3, forceNav: boolean): Vec3[] {
    const L = this.level;
    const opts = this.coll();
    const r = SIM_TUNING.pathClearance;
    if (!forceNav && segmentClear(L, from, goal, r, opts)) return [copy3(goal)];
    const s = nearestNavNode(L, from, r, opts);
    const g = nearestNavNode(L, goal, r, opts);
    const ids = s >= 0 && g >= 0 ? findPath(L.nav, s, g) : null;
    if (!ids) return [copy3(goal)];
    const route = ids.map((id) => flat(this.node(id).position));
    route.push(copy3(goal));
    if (!forceNav) this.pull(route, from);
    return route;
  }

  /** Skip waypoints that can be bypassed in a straight line from `from`. Mutates `route`. */
  private pull(route: Vec3[], from: Vec3): void {
    const opts = this.coll();
    for (let i = route.length - 1; i > 0; i--) {
      if (segmentClear(this.level, from, route[i], SIM_TUNING.pathClearance, opts)) {
        route.splice(0, i);
        return;
      }
    }
  }

  private turnToward(yaw: number, dt: number): void {
    const m = this.state.monster;
    const d = angleDelta(m.yaw, yaw);
    const maxTurn = MONSTER.turnSpeed * dt;
    m.yaw = wrapAngle(m.yaw + clamp(d, -maxTurn, maxTurn));
  }

  /**
   * Walk toward `p` (XZ) at up to `speed`. Turns smoothly; moves along the straight line to the
   * target, slower while still facing away from it. Returns true once within waypointRadius.
   */
  private moveToward(p: Vec3, speed: number, dt: number): boolean {
    const m = this.state.monster;
    const dx = p.x - m.position.x;
    const dz = p.z - m.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= SIM_TUNING.waypointRadius) {
      m.speed = 0;
      return true;
    }
    this.turnToward(yawTowards(m.position, p), dt);
    const facing = Math.max(0, Math.cos(angleDelta(m.yaw, yawTowards(m.position, p))));
    const stepLen = Math.min(speed * facing * dt, dist);
    if (stepLen > 1e-6) {
      const np = moveCircle(
        this.level,
        m.position,
        v3((dx / dist) * stepLen, 0, (dz / dist) * stepLen),
        SIM_TUNING.monsterRadius,
        this.coll(),
      );
      m.speed = distXZ(np, m.position) / dt;
      m.position = v3(np.x, 0, np.z);
    } else {
      m.speed = 0;
    }
    return distXZ(m.position, p) <= SIM_TUNING.waypointRadius;
  }

  private pickWanderNext(node: NavNode, prev: number): number {
    let cands = node.links.filter((l) => l !== prev);
    if (cands.length === 0) cands = node.links.slice();
    if (cands.length === 0) return node.id;
    const now = this.state.time;
    // Prefer nodes not visited for a while, so it roams the whole house.
    const weights = cands.map((id) => 1 + Math.min(60, now - this.brain.visited[this.nodeIndex[id]]) / 10);
    const total = weights.reduce((a, w) => a + w, 0);
    let pick = this.rng() * total;
    for (let i = 0; i < cands.length; i++) {
      pick -= weights[i];
      if (pick <= 0) return cands[i];
    }
    return cands[cands.length - 1];
  }

  private updateMonster(dt: number, out: SimEvent[]): void {
    const m = this.state.monster;
    switch (m.mode) {
      case 'feeding':
        m.speed = 0;
        this.brain.feed -= dt;
        if (this.brain.feed <= 0) this.enterWander();
        return;
      case 'wander':
        this.updateWander(dt);
        return;
      case 'investigate':
        this.updateInvestigate(dt);
        return;
      case 'chase':
        this.updateChase(dt, out);
        return;
    }
  }

  private updateWander(dt: number): void {
    const m = this.state.monster;
    const b = this.brain;
    if (b.pause > 0) {
      b.pause -= dt;
      m.speed = 0;
      m.target = null;
      this.resetStuck();
      return;
    }
    if (b.wanderNode < 0) {
      b.wanderNode = nearestNavNode(this.level, m.position, SIM_TUNING.pathClearance, this.coll());
      b.prevNode = -1;
      if (b.wanderNode < 0) {
        m.speed = 0;
        return;
      }
    }
    const node = this.node(b.wanderNode);
    m.target = flat(node.position);
    if (this.moveToward(node.position, MONSTER.wanderSpeed, dt)) {
      b.visited[this.nodeIndex[node.id]] = this.state.time;
      const next = this.pickWanderNext(node, b.prevNode);
      b.prevNode = node.id;
      b.wanderNode = next;
      this.resetStuck();
      if (this.rng() < SIM_TUNING.wanderPauseChance) {
        b.pause = lerp(SIM_TUNING.wanderPauseMin, SIM_TUNING.wanderPauseMax, this.rng());
        m.speed = 0;
        m.target = null;
      }
    } else if (this.isStuck(dt)) {
      const blocked = b.wanderNode;
      b.wanderNode = nearestNavNode(this.level, m.position, SIM_TUNING.pathClearance, this.coll(), blocked);
      b.prevNode = blocked;
    }
  }

  private updateInvestigate(dt: number): void {
    const m = this.state.monster;
    const b = this.brain;
    if (b.listening) {
      m.speed = 0;
      m.target = null;
      b.listen -= dt;
      // Slowly sweep the head around while listening.
      m.yaw = wrapAngle(m.yaw + Math.sin(b.listen * 1.7) * 0.9 * dt);
      if (b.listen <= 0) this.enterWander();
      return;
    }
    if (b.route.length === 0 || !b.goal) {
      this.startListening();
      return;
    }
    if (this.moveToward(b.route[0], MONSTER.investigateSpeed, dt)) {
      b.route.shift();
      this.resetStuck();
      if (b.route.length === 0) this.startListening();
      else this.pull(b.route, m.position);
    } else if (this.isStuck(dt)) {
      b.stuckCount++;
      if (b.stuckCount >= 2 || distXZ(m.position, b.goal) < 1.5) this.startListening();
      else b.route = this.planRoute(m.position, b.goal, true);
    }
  }

  private updateChase(dt: number, out: SimEvent[]): void {
    const s = this.state;
    const m = s.monster;
    const b = this.brain;
    if (!b.chasePos || s.time - b.chaseHeardAt > HEARING.chaseForget) {
      // Lost them: go check the last place we heard them.
      this.enterInvestigate(b.chasePos ?? m.position, out, true);
      return;
    }
    if (m.targetPlayer !== null) {
      const tp = s.players[m.targetPlayer];
      if (!tp || tp.status !== 'alive') m.targetPlayer = null;
    }
    if (b.routeDirty && s.time - b.replanAt >= SIM_TUNING.chaseReplanInterval) {
      b.goal = this.reachable(b.chasePos);
      b.route = this.planRoute(m.position, b.goal, false);
      b.replanAt = s.time;
      b.routeDirty = false;
    }
    m.target = b.goal ? copy3(b.goal) : null;
    if (b.route.length === 0) {
      // At the last spot we heard them: stand still and listen.
      m.speed = 0;
      this.resetStuck();
      return;
    }
    if (this.moveToward(b.route[0], MONSTER.chaseSpeed, dt)) {
      b.route.shift();
      this.resetStuck();
      if (b.route.length > 0) this.pull(b.route, m.position);
    } else if (this.isStuck(dt) && b.goal) {
      b.route = this.planRoute(m.position, b.goal, true);
    }
  }

  // ---- per-tick rules -------------------------------------------------------------------------

  private tick(dt: number, out: SimEvent[]): void {
    const s = this.state;
    s.time += dt;
    s.monster.alert = Math.max(0, s.monster.alert - dt / SIM_TUNING.alertDecaySeconds);
    this.checkFuses(out);
    this.updateMonster(dt, out);
    this.checkContacts(out);
    this.checkEscapes(out);
    this.checkEnd(out);
  }

  private checkFuses(out: SimEvent[]): void {
    const s = this.state;
    const box = this.level.fuseBox.position;
    for (const it of s.items) {
      if (it.kind !== 'fuse' || it.where !== 'held') continue;
      if (dist3(it.position, box) > SIM_TUNING.fuseInsertDistance) continue;
      const by = it.holder;
      const holder = by !== null ? s.players[by] : undefined;
      if (!holder || holder.status !== 'alive' || it.hand === null) continue;
      holder.held[it.hand] = null;
      it.where = 'used';
      it.holder = null;
      it.hand = null;
      it.position = copy3(box);
      s.fusesInserted++;
      out.push({
        type: 'fuseInserted',
        by: holder.id,
        count: s.fusesInserted,
        required: s.fusesRequired,
        position: copy3(box),
      });
      this.hear({ source: 'item', position: box, loudness: NOISE.fuseInsert, playerId: holder.id }, out);
      if (s.fusesInserted >= s.fusesRequired && !s.exitOpen) this.openExit(out);
    }
  }

  private openExit(out: SimEvent[]): void {
    const s = this.state;
    const d = this.level.exit.door;
    s.exitOpen = true;
    const center = v3((d.min.x + d.max.x) / 2, (d.min.y + d.max.y) / 2, (d.min.z + d.max.z) / 2);
    out.push({ type: 'exitOpened', position: center });
    // The noise comes from just inside the doorway.
    const inside = v3(center.x, 1.5, d.min.z - 0.3);
    const before = s.monster.mode;
    this.hear({ source: 'door', position: inside, loudness: NOISE.exitDoor, playerId: null }, out);
    if (SIM_TUNING.exitDoorAlwaysAlerts && before === 'wander' && s.monster.mode === 'wander') {
      this.enterInvestigate(inside, out, true);
      this.setStim(1);
    }
  }

  private checkContacts(out: SimEvent[]): void {
    const s = this.state;
    const m = s.monster;
    if (m.mode === 'feeding') return;
    const reachR = Math.max(HEARING.catchRadius, HEARING.touchRadius);
    for (const p of Object.values(s.players)) {
      if (p.status !== 'alive') continue;
      const head = p.pose.head.position;
      const d = distXZ(m.position, head);
      if (d > reachR) continue;
      // Never through a wall.
      if (wallsBetween(this.level, v3(m.position.x, head.y, m.position.z), head, this.coll()) > 0) continue;
      if (d <= HEARING.catchRadius) {
        this.catchPlayer(p, out);
        return;
      }
      if (d <= HEARING.touchRadius) {
        // Bumped into a silent player.
        if (m.mode !== 'chase' || m.targetPlayer !== p.id) {
          this.enterChase(head, p.id, out, true);
          this.setStim(HEARING.chaseRatio);
        } else {
          this.brain.chasePos = flat(head);
          this.brain.chaseHeardAt = s.time;
          this.brain.routeDirty = true;
        }
      }
    }
  }

  private catchPlayer(p: PlayerState, out: SimEvent[]): void {
    p.status = 'caught';
    this.dropAll(p, out, false);
    out.push({ type: 'playerCaught', id: p.id, position: copy3(p.pose.head.position) });
    this.enterFeeding();
  }

  private checkEscapes(out: SimEvent[]): void {
    const s = this.state;
    if (!s.exitOpen) return;
    const zone = this.level.exit.zone;
    for (const p of Object.values(s.players)) {
      if (p.status !== 'alive' || !pointInBox(p.pose.head.position, zone)) continue;
      p.status = 'escaped';
      this.dropAll(p, out, false);
      out.push({ type: 'playerEscaped', id: p.id });
    }
  }

  private checkEnd(out: SimEvent[]): void {
    const s = this.state;
    if (s.phase !== 'playing') return;
    const ps = Object.values(s.players);
    if (ps.length === 0 || ps.some((p) => p.status === 'alive')) return;
    s.phase = ps.some((p) => p.status === 'escaped') ? 'won' : 'lost';
    s.monster.speed = 0;
    out.push({ type: 'phase', phase: s.phase });
  }
}
