/**
 * Validation of untrusted data (anything that arrived over the network) for the engine-agnostic
 * core. The host runs client poses / actions through these before they touch the GameSim, and
 * clients run the host's snapshots / events through them before they reach the renderer and audio.
 *
 * Every reader returns clean, fully populated plain data (fresh objects, never the input) or null
 * when the input is beyond repair, so nothing downstream ever sees NaN, strings posing as numbers,
 * missing fields, absurd coordinates or prototype tricks. Legit data passes through unchanged.
 */

import type {
  FingerCurls,
  GamePhase,
  Handedness,
  HandPose,
  HeldRef,
  ItemState,
  MonsterMode,
  PlayerPose,
  PlayerState,
  PlayerStatus,
  Quat,
  SimEvent,
  Vec3,
  WorldState,
} from './types';

export const LIMITS = {
  /** Heads are kept inside the level bounds grown by this much (m). */
  headMargin: 1,
  /** Everything else (hands, items, camera, monster) inside the bounds grown by this much (m). */
  worldMargin: 3,
  /** A hand is never farther than this from its own head (m): an arm plus tracking slop. */
  handReach: 1.5,
  /** A noise a client reports must come from within this distance of its head (m). */
  noiseReach: 2.5,
  /** Longest id / name strings accepted from the network. */
  idLength: 128,
  nameLength: 32,
  /** Collections larger than this in a snapshot are truncated. */
  maxPlayers: 16,
  maxItems: 128,
} as const;

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

const PHASES: readonly GamePhase[] = ['lobby', 'playing', 'won', 'lost'];
const MODES: readonly MonsterMode[] = ['wander', 'investigate', 'chase', 'feeding'];
const STATUSES: readonly PlayerStatus[] = ['alive', 'caught', 'escaped'];
const HANDS: readonly Handedness[] = ['left', 'right'];
const REST_CURL = 0.3;

type Obj = Record<string, unknown>;

/** A plain object (not null, not an array). */
export function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** `o[k]` only if `k` is an own property (ids like 'constructor' or '__proto__' are not lookups). */
export function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

const own = (o: Obj, k: string): unknown => (hasOwn(o, k) ? o[k] : undefined);

/** Ids that must never be used as keys of a plain object. */
export const isSafeKey = (k: string): boolean => k !== '__proto__';

/** A finite number, or null. */
export function readNum(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function readInt(x: unknown, lo: number, hi: number): number | null {
  const n = readNum(x);
  return n !== null && Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

function readStr(x: unknown, maxLength: number = LIMITS.idLength): string | null {
  return typeof x === 'string' && x.length > 0 && x.length <= maxLength ? x : null;
}

function oneOf<T extends string>(x: unknown, options: readonly T[]): T | null {
  return typeof x === 'string' && (options as readonly string[]).includes(x) ? (x as T) : null;
}

/** A Vec3 of finite numbers (fresh object), or null. */
export function readVec3(x: unknown): Vec3 | null {
  if (!isObj(x)) return null;
  const a = readNum(own(x, 'x'));
  const b = readNum(own(x, 'y'));
  const c = readNum(own(x, 'z'));
  return a === null || b === null || c === null ? null : { x: a, y: b, z: c };
}

/** A unit quaternion (normalized copy); identity when the input is not a usable rotation. */
export function readQuat(x: unknown): Quat {
  if (isObj(x)) {
    const q = [own(x, 'x'), own(x, 'y'), own(x, 'z'), own(x, 'w')].map(readNum);
    if (q.every((n) => n !== null)) {
      const [a, b, c, d] = q as number[];
      const l = Math.hypot(a, b, c, d);
      if (l > 1e-6 && Number.isFinite(l)) return { x: a / l, y: b / l, z: c / l, w: d / l };
    }
  }
  return { x: 0, y: 0, z: 0, w: 1 };
}

const clampN = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** `p` clamped into `b` grown by `margin` on every side. */
export function clampToBounds(p: Vec3, b: Bounds, margin: number): Vec3 {
  return {
    x: clampN(p.x, b.min.x - margin, b.max.x + margin),
    y: clampN(p.y, b.min.y - margin, b.max.y + margin),
    z: clampN(p.z, b.min.z - margin, b.max.z + margin),
  };
}

/** `p` pulled toward `center` so it is at most `maxDist` away from it (3D). */
export function clampToward(center: Vec3, p: Vec3, maxDist: number): Vec3 {
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  const dz = p.z - center.z;
  const d = Math.hypot(dx, dy, dz);
  if (d <= maxDist) return { x: p.x, y: p.y, z: p.z };
  const k = maxDist / d;
  return { x: center.x + dx * k, y: center.y + dy * k, z: center.z + dz * k };
}

function readCurls(x: unknown): FingerCurls {
  const out: FingerCurls = [REST_CURL, REST_CURL, REST_CURL, REST_CURL, REST_CURL];
  if (!Array.isArray(x)) return out;
  for (let i = 0; i < 5; i++) {
    const n = readNum(x[i]);
    if (n !== null) out[i] = clampN(n, 0, 1);
  }
  return out;
}

function readHand(x: unknown, head: Vec3): HandPose {
  const o = isObj(x) ? x : {};
  const pos = readVec3(own(o, 'position'));
  return {
    // A hand without a usable position is drawn nowhere (untracked) and rests below the head.
    tracked: own(o, 'tracked') === true && pos !== null,
    position: clampToward(head, pos ?? { x: head.x, y: head.y - 0.6, z: head.z }, LIMITS.handReach),
    rotation: readQuat(own(o, 'rotation')),
    curls: readCurls(own(o, 'curls')),
  };
}

/**
 * A clean PlayerPose from untrusted input, or null if it has no usable head position.
 * The head is kept inside `bounds` (+ LIMITS.headMargin) and each hand within LIMITS.handReach
 * of the head; rotations are normalized and curls clamped to 0..1.
 */
export function sanitizePose(x: unknown, bounds: Bounds): PlayerPose | null {
  if (!isObj(x)) return null;
  const headIn = own(x, 'head');
  if (!isObj(headIn)) return null;
  const hp = readVec3(own(headIn, 'position'));
  if (!hp) return null;
  const position = clampToBounds(hp, bounds, LIMITS.headMargin);
  return {
    head: { position, rotation: readQuat(own(headIn, 'rotation')) },
    left: readHand(own(x, 'left'), position),
    right: readHand(own(x, 'right'), position),
  };
}

function readHeld(x: unknown): HeldRef | null {
  if (!isObj(x)) return null;
  const kind = own(x, 'kind');
  if (kind === 'camera') return { kind: 'camera' };
  if (kind === 'item') {
    const itemId = readInt(own(x, 'itemId'), -1e9, 1e12);
    return itemId === null ? null : { kind: 'item', itemId };
  }
  return null;
}

function readPlayer(id: string, x: unknown, bounds: Bounds): PlayerState | null {
  if (!isObj(x) || own(x, 'id') !== id) return null;
  const pose = sanitizePose(own(x, 'pose'), bounds);
  const status = oneOf(own(x, 'status'), STATUSES);
  if (!pose || !status) return null;
  const color = readInt(own(x, 'color'), 0, 0xffffff) ?? 0xffffff;
  const held = isObj(own(x, 'held')) ? (own(x, 'held') as Obj) : {};
  const spawn = readVec3(own(x, 'spawn'));
  return {
    id,
    name: (typeof own(x, 'name') === 'string' ? (own(x, 'name') as string) : '').slice(0, LIMITS.nameLength) || 'Survivor',
    color,
    isDesktop: own(x, 'isDesktop') === true,
    status,
    spawn: spawn ? clampToBounds(spawn, bounds, LIMITS.headMargin) : { ...pose.head.position, y: 0 },
    spawnYaw: readNum(own(x, 'spawnYaw')) ?? 0,
    pose,
    held: { left: readHeld(own(held, 'left')), right: readHeld(own(held, 'right')) },
  };
}

function readItem(x: unknown, bounds: Bounds): ItemState | null {
  if (!isObj(x)) return null;
  const id = readInt(own(x, 'id'), -1e9, 1e12);
  const kind = oneOf(own(x, 'kind'), ['fuse', 'film'] as const);
  const where = oneOf(own(x, 'where'), ['world', 'held', 'used'] as const);
  const position = readVec3(own(x, 'position'));
  if (id === null || !kind || !where || !position) return null;
  return {
    id,
    kind,
    where,
    position: clampToBounds(position, bounds, LIMITS.worldMargin),
    yaw: readNum(own(x, 'yaw')) ?? 0,
    holder: readStr(own(x, 'holder')),
    hand: oneOf(own(x, 'hand'), HANDS),
  };
}

/**
 * A clean WorldState from untrusted input (a snapshot from the host), or null if it is
 * structurally broken. Broken players / items are dropped; positions are clamped near `bounds`.
 */
export function sanitizeWorldState(x: unknown, bounds: Bounds): WorldState | null {
  if (!isObj(x)) return null;
  const phase = oneOf(own(x, 'phase'), PHASES);
  const time = readNum(own(x, 'time'));
  const m = own(x, 'monster');
  const c = own(x, 'camera');
  if (!phase || time === null || !isObj(m) || !isObj(c)) return null;

  const mPos = readVec3(own(m, 'position'));
  const mode = oneOf(own(m, 'mode'), MODES);
  const cPos = readVec3(own(c, 'position'));
  if (!mPos || !mode || !cPos) return null;
  const target = readVec3(own(m, 'target'));

  const players: Record<string, PlayerState> = {};
  const rawPlayers = own(x, 'players');
  if (isObj(rawPlayers)) {
    for (const id of Object.keys(rawPlayers).slice(0, LIMITS.maxPlayers)) {
      if (!readStr(id) || !isSafeKey(id)) continue;
      const p = readPlayer(id, rawPlayers[id], bounds);
      if (p) players[id] = p;
    }
  }
  const items: ItemState[] = [];
  const rawItems = own(x, 'items');
  if (Array.isArray(rawItems)) {
    for (const it of rawItems.slice(0, LIMITS.maxItems)) {
      const clean = readItem(it, bounds);
      if (clean) items.push(clean);
    }
  }
  const lh = own(x, 'lastHeard');
  const lhPos = isObj(lh) ? readVec3(own(lh, 'position')) : null;

  return {
    time,
    phase,
    levelSeed: readNum(own(x, 'levelSeed')) ?? 0,
    players,
    monster: {
      position: clampToBounds(mPos, bounds, LIMITS.worldMargin),
      yaw: readNum(own(m, 'yaw')) ?? 0,
      mode,
      target: target ? clampToBounds(target, bounds, LIMITS.worldMargin) : null,
      targetPlayer: readStr(own(m, 'targetPlayer')),
      speed: clampN(readNum(own(m, 'speed')) ?? 0, 0, 20),
      alert: clampN(readNum(own(m, 'alert')) ?? 0, 0, 1),
    },
    items,
    camera: {
      holder: readStr(own(c, 'holder')),
      hand: oneOf(own(c, 'hand'), HANDS),
      position: clampToBounds(cPos, bounds, LIMITS.worldMargin),
      yaw: readNum(own(c, 'yaw')) ?? 0,
      film: readInt(own(c, 'film'), 0, 9999) ?? 0,
      lastFlashTime: readNum(own(c, 'lastFlashTime')) ?? -1e9,
    },
    fusesInserted: readInt(own(x, 'fusesInserted'), 0, 999) ?? 0,
    fusesRequired: readInt(own(x, 'fusesRequired'), 0, 999) ?? 0,
    exitOpen: own(x, 'exitOpen') === true,
    lastHeard:
      isObj(lh) && lhPos
        ? {
            position: clampToBounds(lhPos, bounds, LIMITS.worldMargin),
            loudness: clampN(readNum(own(lh, 'loudness')) ?? 0, 0, 1),
            time: readNum(own(lh, 'time')) ?? 0,
          }
        : null,
  };
}

/** A clean SimEvent from untrusted input (an event from the host), or null if unusable. */
export function sanitizeSimEvent(x: unknown, bounds: Bounds): SimEvent | null {
  if (!isObj(x)) return null;
  const rawPos = readVec3(own(x, 'position'));
  const position = rawPos ? clampToBounds(rawPos, bounds, LIMITS.worldMargin) : null;
  const by = readStr(own(x, 'by'));
  const id = readStr(own(x, 'id'));
  const count = (k: string): number | null => readInt(own(x, k), 0, 9999);
  switch (own(x, 'type')) {
    case 'flash': {
      const d = readVec3(own(x, 'direction'));
      const l = d ? Math.hypot(d.x, d.y, d.z) : 0;
      const time = readNum(own(x, 'time'));
      if (!by || !position || time === null) return null;
      const direction = d && l > 1e-6 ? { x: d.x / l, y: d.y / l, z: d.z / l } : { x: 0, y: 0, z: -1 };
      return { type: 'flash', by, position, direction, time };
    }
    case 'dryFire':
      return by && position ? { type: 'dryFire', by, position } : null;
    case 'pickup':
    case 'drop': {
      const what = oneOf(own(x, 'what'), ['camera', 'fuse', 'film'] as const);
      if (!by || !position || !what) return null;
      return own(x, 'type') === 'pickup' ? { type: 'pickup', by, what, position } : { type: 'drop', by, what, position };
    }
    case 'filmLoaded': {
      const amount = count('amount');
      const total = count('total');
      return by && position && amount !== null && total !== null
        ? { type: 'filmLoaded', by, amount, total, position }
        : null;
    }
    case 'fuseInserted': {
      const n = count('count');
      const required = count('required');
      return by && position && n !== null && required !== null
        ? { type: 'fuseInserted', by, count: n, required, position }
        : null;
    }
    case 'exitOpened':
      return position ? { type: 'exitOpened', position } : null;
    case 'monsterAlert': {
      const mode = oneOf(own(x, 'mode'), MODES);
      return mode && position ? { type: 'monsterAlert', mode, position } : null;
    }
    case 'playerCaught':
      return id && position ? { type: 'playerCaught', id, position } : null;
    case 'playerEscaped':
      return id ? { type: 'playerEscaped', id } : null;
    case 'phase': {
      const phase = oneOf(own(x, 'phase'), PHASES);
      return phase ? { type: 'phase', phase } : null;
    }
    default:
      return null;
  }
}
