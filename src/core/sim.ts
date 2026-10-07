import { GAME, HEARING, MONSTER, NOISE, PLAYER, PLAYER_COLORS } from '../config';
import type {
  Box,
  Handedness,
  HandPose,
  ItemKind,
  ItemState,
  LevelData,
  MonsterState,
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
  clamp,
  copy3,
  copyQuat,
  dist3,
  distXZ,
  isFiniteVec3,
  lerp3,
  makeRng,
  mixSeed,
  normalize3,
  quatFromYaw,
  rotate3,
  v3,
  wrapAngle,
  yawFromQuat,
} from './math';
import {
  pointInBox,
  pushOutOf,
  supportHeight,
  SUPPORT_TOLERANCE,
  wallBoxes,
  wallsBetween,
  type CollisionOptions,
} from './physics';
import { BRAIN_TUNING, MonsterBrain, type MonsterHost } from './monster';
import { clampToward, hasOwn, LIMITS, sanitizePose } from './validate';

export interface SimOptions {
  fusesRequired?: number;
  startingFilm?: number;
  /** The monster remembers where it heard things and patrols there more (default true). */
  noiseMemory?: boolean;
  /**
   * Each round the monster starts at a random nav node far from the players (default false:
   * always level.monsterSpawn, which tests rely on). The game turns this on.
   */
  randomMonsterSpawn?: boolean;
}

/** Sim-private tunables (shared "feel" numbers live in config.ts; the monster's own in monster.ts). */
export const SIM_TUNING = {
  /** Monster body radius on the XZ plane (standing; MONSTER.crawlRadius on all fours). */
  monsterRadius: MONSTER.radius,
  /** A held fuse this close (m, 3D) to the fuse box goes in. */
  fuseInsertDistance: 0.6,
  /** Alert decays from 1 to 0 over this many seconds. */
  alertDecaySeconds: 8,
  /** How fast the "priority" of the current stimulus fades (s), so newer noises can override. */
  stimulusDecaySeconds: BRAIN_TUNING.stimulusDecaySeconds,
  /** Hearing the chased player again after this long a silence re-emits a 'monsterAlert'. */
  chaseRegainGap: BRAIN_TUNING.chaseRegainGap,
  /** Min seconds between chase re-plans. */
  chaseReplanInterval: BRAIN_TUNING.chaseReplanInterval,
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
  /** Random monster spawns are at least this far (m, XZ) from every player spawn. */
  monsterSpawnMinDistance: 10,
  /**
   * Remote clients' heads may move at most this fast (m/s, XZ) on the host, with a burst budget
   * of `moveBurst` m for bunched-up packets. Sprinting is 3.3 m/s, so legit play never hits it;
   * it stops "teleport" cheats (the host keeps them where they were and lets them catch up).
   */
  maxMoveSpeed: 3 * PLAYER.sprintSpeed,
  moveBurst: 3,
  /**
   * Nothing farther than this (m) from a player's eyes can be grabbed: the desktop probe sits
   * 0.5 m in front of the eyes and reaches PLAYER.desktopGrabReach from there.
   */
  maxGrabFromHead: 0.5 + PLAYER.desktopGrabReach + 0.15,
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

const flat = (p: Vec3): Vec3 => ({ x: p.x, y: 0, z: p.z });
const freshMonster = (position: Vec3, yaw: number): MonsterState => ({
  position,
  yaw,
  mode: 'wander',
  target: null,
  targetPlayer: null,
  speed: 0,
  alert: 0,
  gait: 'still',
  posture: 'tall',
  act: 'none',
  actStart: 0,
  focus: null,
});
/** Player by id; ids come off the network, so 'constructor' & co. must not hit Object.prototype. */
const playerOf = (s: WorldState, id: PlayerId | null): PlayerState | undefined =>
  id !== null && hasOwn(s.players, id) ? s.players[id] : undefined;
const isHand = (h: unknown): h is Handedness => h === 'left' || h === 'right';

/**
 * Authoritative game simulation. Runs only on the host (or locally in solo play).
 * Pure logic: no rendering, audio, DOM or networking.
 */
export class GameSim {
  readonly level: LevelData;
  readonly state: WorldState;

  private readonly opts: SimOptions;
  private round = 0;
  private rng: () => number;
  private nextItemId = 1;
  private joinOrder: PlayerId[] = [];
  private spawnOf: Record<PlayerId, number> = {};
  private pending: SimEvent[] = [];
  private ai: MonsterBrain;
  /** setMonsterFrozen() (dev / tests only). */
  private monsterFrozen = false;
  private readonly host: MonsterHost;
  /** Per remote player: how far (m) their head may still move right now, and when that was. */
  private moveBudget: Record<PlayerId, { left: number; time: number }> = {};

  constructor(level: LevelData, opts: SimOptions = {}) {
    this.level = level;
    this.opts = { ...opts };
    this.rng = makeRng(mixSeed(level.seed, 0));
    const host = {
      level,
      state: null as unknown as WorldState,
      rng: () => this.rng(),
      coll: () => this.coll(),
      catchPlayer: (p: PlayerState, out: SimEvent[]) => this.catchPlayer(p, out),
      noiseMemory: opts.noiseMemory !== false,
    };
    this.host = host;
    this.state = {
      time: 0,
      phase: 'lobby',
      levelSeed: level.seed,
      players: {},
      monster: freshMonster(flat(level.monsterSpawn), 0),
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
    host.state = this.state;
    this.ai = new MonsterBrain(host);
    this.resetWorld();
  }

  // -------------------------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------------------------

  /** Add a player (lobby or mid-round). Assigns color + spawn. Returns the new player state. */
  addPlayer(id: PlayerId, name: string, isDesktop: boolean): PlayerState {
    const existing = playerOf(this.state, id);
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
    this.resetMoveBudget(id);
    return player;
  }

  /** Remove a player; anything they held is dropped where their hands were. */
  removePlayer(id: PlayerId): SimEvent[] {
    const p = playerOf(this.state, id);
    if (!p) return [];
    const out: SimEvent[] = [];
    this.dropAll(p, out, false);
    delete this.state.players[id];
    delete this.spawnOf[id];
    delete this.moveBudget[id];
    this.joinOrder = this.joinOrder.filter((j) => j !== id);
    if (this.state.monster.targetPlayer === id) this.state.monster.targetPlayer = null;
    this.checkEnd(out);
    return out;
  }

  /**
   * Client-authoritative pose update. Also moves anything held in their hands.
   * The pose may come straight off the network: it is sanitized (see sanitizePose) and, for
   * `remote` players (anyone but the host itself), speed-limited (SIM_TUNING.maxMoveSpeed).
   */
  setPlayerPose(id: PlayerId, pose: PlayerPose, remote = false): void {
    const p = playerOf(this.state, id);
    if (!p) return;
    const clean = sanitizePose(pose, this.level.bounds);
    if (!clean) return;
    if (remote) this.limitMove(p, clean);
    p.pose = clean;
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
      this.resetMoveBudget(id);
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
    const p = playerOf(s, id);
    const out: SimEvent[] = [];
    if (!p || p.status !== 'alive' || s.phase !== 'playing') return out;
    if (!action || !isHand(action.hand) || !isFiniteVec3(action.position)) return out;
    // Hands are never farther than an arm from the eyes (actions come off the network).
    const at = clampToward(p.pose.head.position, copy3(action.position), LIMITS.handReach);
    switch (action.type) {
      case 'grab':
        this.grab(p, action.hand, at, action.reach, out);
        break;
      case 'release':
        this.release(p, action.hand, at, out);
        break;
      case 'flash':
        this.flash(p, action.hand, at, action.direction, out);
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

  private resetMoveBudget(id: PlayerId): void {
    this.moveBudget[id] = { left: SIM_TUNING.moveBurst, time: this.state.time };
  }

  /** Clamp a remote player's head travel (XZ) to their movement budget; hands move along. */
  private limitMove(p: PlayerState, pose: PlayerPose): void {
    const T = SIM_TUNING;
    const b = this.moveBudget[p.id] ?? { left: T.moveBurst, time: this.state.time };
    this.moveBudget[p.id] = b;
    b.left = Math.min(T.moveBurst, b.left + Math.max(0, this.state.time - b.time) * T.maxMoveSpeed);
    b.time = this.state.time;
    const from = p.pose.head.position;
    const to = pose.head.position;
    const d = distXZ(from, to);
    if (d <= b.left) {
      b.left -= d;
      return;
    }
    const k = b.left / d;
    const dx = from.x + (to.x - from.x) * k - to.x;
    const dz = from.z + (to.z - from.z) * k - to.z;
    for (const pt of [pose.head.position, pose.left.position, pose.right.position]) {
      pt.x += dx;
      pt.z += dz;
    }
    b.left = 0;
  }

  private freeSpawnIndex(): number {
    const taken = new Set(Object.values(this.spawnOf));
    const n = this.level.playerSpawns.length;
    for (let i = 0; i < n; i++) if (!taken.has(i)) return i;
    return Object.keys(this.state.players).length % n;
  }

  /** Where the monster starts this round (see SimOptions.randomMonsterSpawn). */
  private pickMonsterSpawn(): Vec3 {
    const L = this.level;
    if (!this.opts.randomMonsterSpawn) return L.monsterSpawn;
    const far = L.nav.filter((n) =>
      L.playerSpawns.every((p) => distXZ(n.position, p.position) >= SIM_TUNING.monsterSpawnMinDistance),
    );
    if (far.length === 0) return L.monsterSpawn;
    return far[Math.floor(this.rng() * far.length) % far.length].position;
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

    const yaw = this.rng() * Math.PI * 2 - Math.PI;
    s.monster = freshMonster(flat(this.pickMonsterSpawn()), yaw);
    this.ai = new MonsterBrain(this.host);
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

  /**
   * Where something let go at `pos` by a player whose eyes are at `eye` comes to rest: never on
   * the far side of a wall from the player, out of walls, on the surface below.
   */
  private restPoint(pos: Vec3, eye: Vec3): Vec3 {
    const opts = this.coll();
    let at = copy3(pos);
    if (wallsBetween(this.level, eye, at, opts) > 0) {
      // Hand (or desktop probe) went through a wall: pull it back toward the player.
      let t = 1;
      while (t > 0 && wallsBetween(this.level, eye, lerp3(eye, pos, t), opts) > 0) t -= 0.05;
      at = lerp3(eye, pos, Math.max(0, t - 0.1));
      at.y = pos.y;
    }
    let p = pushOutOf(wallBoxes(this.level, opts), at, SIM_TUNING.itemRadius);
    // A hand pushed deep into a tall piece of furniture: slide the item out of it.
    const tall: Box[] = this.level.boxes.filter(
      (b) =>
        b.kind === 'furniture' &&
        b.max.y > at.y + SUPPORT_TOLERANCE &&
        p.x >= b.min.x &&
        p.x <= b.max.x &&
        p.z >= b.min.z &&
        p.z <= b.max.z,
    );
    if (tall.length > 0) p = pushOutOf(tall, p, SIM_TUNING.itemRadius);
    return v3(p.x, supportHeight(this.level, p.x, p.z, at.y), p.z);
  }

  private dropHand(p: PlayerState, hand: Handedness, at: Vec3, out: SimEvent[], noisy: boolean): void {
    const s = this.state;
    const h = p.held[hand];
    if (!h) return;
    p.held[hand] = null;
    const pos = this.restPoint(at, p.pose.head.position);
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
      if (dist3(p.pose.head.position, pos) > SIM_TUNING.maxGrabFromHead) return Infinity;
      // No reaching through walls: the player's eyes must see it.
      if (wallsBetween(this.level, p.pose.head.position, pos, opts) > 0) return Infinity;
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
    const range = loudness * HEARING.rangeMeters * this.ai.hearingMul();
    if (eff > range) return 0;
    return range / Math.max(eff, 1e-3);
  }

  /** What the monster is up to internally (tests / debugging; not networked). */
  monsterDebug(): ReturnType<MonsterBrain['debug']> & { escalation: number; speedMul: number } {
    return { ...this.ai.debug(), escalation: this.ai.escalation(), speedMul: this.ai.speedMul() };
  }

  private hear(noise: NoiseEvent, out: SimEvent[]): void {
    const s = this.state;
    if (s.phase !== 'playing' || !noise || !isFiniteVec3(noise.position)) return;
    const loudness = clamp(Number.isFinite(noise.loudness) ? noise.loudness : 0, 0, 1);
    if (loudness <= 0) return;
    const pid = noise.playerId ?? null;
    if (pid !== null) {
      const src = playerOf(s, pid);
      if (!src || src.status !== 'alive') return;
    }
    const m = s.monster;
    if (m.mode === 'feeding' || this.monsterFrozen) return;
    const ratio = this.hearingRatio(noise.position, loudness);
    if (ratio <= 0) return;
    s.lastHeard = { position: copy3(noise.position), loudness, time: s.time };
    const t = clamp((ratio - 1) / (HEARING.chaseRatio - 1), 0, 1);
    m.alert = Math.max(m.alert, 0.25 + 0.75 * t);
    this.ai.onHeard(noise.position, pid, ratio, out);
  }

  /**
   * Dev / test hook (capture harness, robot playtest; never set in play): a frozen monster stays
   * exactly where its state is put, hears nothing and catches no one. Survives new rounds.
   */
  setMonsterFrozen(frozen: boolean): void {
    this.monsterFrozen = frozen === true;
  }

  // ---- per-tick rules -------------------------------------------------------------------------

  private tick(dt: number, out: SimEvent[]): void {
    const s = this.state;
    s.time += dt;
    s.monster.alert = Math.max(0, s.monster.alert - dt / SIM_TUNING.alertDecaySeconds);
    this.checkFuses(out);
    if (!this.monsterFrozen) {
      this.ai.update(dt, out);
      this.checkContacts(out);
    }
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
      const holder = playerOf(s, by);
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
    this.ai.onExitOpened(inside, SIM_TUNING.exitDoorAlwaysAlerts && before === 'wander', out);
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
      // Bumped into a silent player.
      if (d <= HEARING.touchRadius) this.ai.onTouch(head, p.id, out);
    }
  }

  private catchPlayer(p: PlayerState, out: SimEvent[]): void {
    p.status = 'caught';
    this.dropAll(p, out, false);
    out.push({ type: 'playerCaught', id: p.id, position: copy3(p.pose.head.position) });
    this.ai.onCaught(p.pose.head.position);
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
