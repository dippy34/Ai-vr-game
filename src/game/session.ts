/**
 * A Session is "the authority the local game talks to". The game loop doesn't care whether it is:
 *  - HostSession: we run the GameSim ourselves (solo play, or hosting friends over a Transport), or
 *  - ClientSession: someone else's GameSim, reached over a Transport.
 * No rendering/audio/DOM here, so this layer ports cleanly to a native app.
 */

import { GAME, NET } from '../config';
import { createLevel } from '../core/level';
import { clamp } from '../core/math';
import { GameSim } from '../core/sim';
import type {
  LevelData,
  NoiseEvent,
  NoiseSource,
  PlayerAction,
  PlayerId,
  PlayerPose,
  SimEvent,
  WorldState,
} from '../core/types';
import {
  clampToward,
  hasOwn,
  isObj,
  isSafeKey,
  LIMITS,
  readNum,
  readVec3,
  sanitizePose,
  sanitizeSimEvent,
  sanitizeWorldState,
} from '../core/validate';
import { hostRoom, joinRoom, type Transport, type TransportKind, type VoiceLink } from '../net';
import { PROTOCOL_VERSION, type LobbyPlayer, type NetMessage } from '../net/protocol';

export interface SessionCallbacks {
  onEvent(event: SimEvent): void;
  /** Another player's pose arrived (between snapshots). */
  onRemotePose(id: PlayerId, pose: PlayerPose): void;
  /** A new round started; `state` already has fresh spawns. */
  onRound(state: WorldState): void;
  onLobby(players: LobbyPlayer[]): void;
  onDisconnected(reason: string): void;
}

const noopCallbacks: SessionCallbacks = {
  onEvent() {},
  onRemotePose() {},
  onRound() {},
  onLobby() {},
  onDisconnected() {},
};

export interface Session {
  readonly isHost: boolean;
  readonly localId: PlayerId;
  readonly level: LevelData;
  /** Null for solo play. */
  readonly roomCode: string | null;
  readonly voice: VoiceLink | null;
  /** Latest known world state (live on the host, last snapshot on clients). */
  readonly state: WorldState;
  callbacks: SessionCallbacks;
  lobbyPlayers(): LobbyPlayer[];
  /** Call every frame; clients throttle network sends internally. */
  sendPose(pose: PlayerPose): void;
  /** Mic loudness 0..1, sent at NET.voiceRate by the game loop. */
  sendVoice(level: number): void;
  sendNoise(noise: NoiseEvent): void;
  sendAction(action: PlayerAction): void;
  /** Host: start/restart a round. Clients: ignored. */
  startRound(): void;
  /** Host, in the lobby: Loud Mode on/off (clients see it in the state). Clients: ignored. */
  setLoudMode(on: boolean): void;
  update(dt: number): void;
  close(): void;
}

function sanitizeName(name: unknown): string {
  return (
    (typeof name === 'string' ? name : '')
      .slice(0, 64) // before the regex: names can be huge when they come off the network
      .replace(/[^\p{L}\p{N} _.'-]/gu, '')
      .trim()
      .slice(0, 16) || 'Survivor'
  );
}

/** Lobby list from the host, cleaned (shown in the DOM and used for colors). */
function sanitizeLobby(x: unknown): LobbyPlayer[] | null {
  if (!Array.isArray(x)) return null;
  const out: LobbyPlayer[] = [];
  for (const p of x.slice(0, LIMITS.maxPlayers)) {
    if (!isObj(p) || typeof p.id !== 'string' || !p.id || p.id.length > LIMITS.idLength) continue;
    const color = readNum(p.color);
    out.push({
      id: p.id,
      name: (typeof p.name === 'string' ? p.name : '').slice(0, LIMITS.nameLength) || 'Survivor',
      color: color !== null && Number.isInteger(color) && color >= 0 && color <= 0xffffff ? color : 0xffffff,
      isDesktop: p.isDesktop === true,
    });
  }
  return out;
}

/** Token bucket: `rate` messages per second on average, bursts of up to `burst`. */
class RateLimit {
  private tokens: number;
  private last: number;
  constructor(
    private readonly rate: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + Math.max(0, now - this.last) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * How many messages per second (and in one burst) the host accepts from each client. Legit clients
 * send poses at NET.poseRate, voice at NET.voiceRate, a footstep every NOISE.stepLength meters and
 * an action per button press; anything far above that is a broken or malicious client.
 */
const CLIENT_LIMITS = {
  pose: [NET.poseRate * 2, NET.poseRate],
  voice: [NET.voiceRate * 3, NET.voiceRate * 2],
  noise: [20, 10],
  action: [15, 10],
} as const;
type LimitKind = keyof typeof CLIENT_LIMITS;

/** Non-voice noises a client may report (voice goes through 'voice' messages). */
const CLIENT_NOISES: readonly NoiseSource[] = ['footstep', 'item', 'camera'];

export interface HostSessionOptions {
  /** Clock in seconds for rate limiting (default: performance.now). */
  now?: () => number;
}

const defaultNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

function toLobby(state: WorldState): LobbyPlayer[] {
  return Object.values(state.players).map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    isDesktop: p.isDesktop,
  }));
}

// ---------------------------------------------------------------------------------------------

export class HostSession implements Session {
  readonly isHost = true;
  readonly localId: PlayerId;
  readonly level: LevelData;
  readonly roomCode: string | null;
  readonly voice: VoiceLink | null;
  callbacks: SessionCallbacks = noopCallbacks;

  private readonly sim: GameSim;
  private snapshotTimer = 0;
  private poseTimer = 0;
  private localPoseDirty = false;
  private readonly now: () => number;
  private readonly limits = new Map<PlayerId, Record<LimitKind, RateLimit>>();

  constructor(
    private readonly transport: Transport | null,
    name: string,
    isDesktop: boolean,
    opts: HostSessionOptions = {},
  ) {
    this.now = opts.now ?? defaultNow;
    const seed = Math.floor(Math.random() * 2 ** 31);
    this.level = createLevel(seed);
    this.sim = new GameSim(this.level, {
      fusesRequired: GAME.fusesRequired,
      startingFilm: GAME.startingFilm,
      randomMonsterSpawn: true,
    });
    this.localId = transport?.selfId ?? 'solo';
    this.roomCode = transport?.roomCode ?? null;
    this.voice = transport?.voice ?? null;
    this.sim.addPlayer(this.localId, sanitizeName(name), isDesktop);

    if (transport) {
      transport.onMessage((msg, from) => this.onMessage(msg, from));
      transport.onPeerLeave((id) => {
        this.limits.delete(id);
        if (!hasOwn(this.sim.state.players, id)) return;
        this.emit(this.sim.removePlayer(id));
        this.broadcastLobby();
      });
    }
  }

  get state(): WorldState {
    return this.sim.state;
  }

  lobbyPlayers(): LobbyPlayer[] {
    return toLobby(this.sim.state);
  }

  sendPose(pose: PlayerPose): void {
    this.sim.setPlayerPose(this.localId, pose);
    // Relayed from update() at NET.poseRate (this is called every frame, up to 90+ times/s).
    this.localPoseDirty = true;
  }

  sendVoice(level: number): void {
    this.applyVoice(this.localId, level);
  }

  sendNoise(noise: NoiseEvent): void {
    this.sim.reportNoise({ ...noise, playerId: this.localId });
  }

  sendAction(action: PlayerAction): void {
    this.emit(this.sim.handleAction(this.localId, action));
  }

  setLoudMode(on: boolean): void {
    this.sim.setLoudMode(on);
  }

  startRound(): void {
    const events = this.sim.startRound();
    const state = this.sim.snapshot();
    this.transport?.send({ t: 'round', state });
    this.callbacks.onRound(this.sim.state);
    this.emit(events);
  }

  update(dt: number): void {
    this.emit(this.sim.step(dt));
    if (!this.transport) return;
    this.poseTimer += dt;
    if (this.localPoseDirty && this.poseTimer >= 1 / NET.poseRate) {
      this.poseTimer = 0;
      this.localPoseDirty = false;
      const me = this.sim.state.players[this.localId];
      if (me) this.relayPose(this.localId, me.pose);
    }
    this.snapshotTimer += dt;
    if (this.snapshotTimer >= 1 / NET.snapshotRate) {
      this.snapshotTimer = 0;
      this.transport.send({ t: 'snapshot', state: this.sim.snapshot() });
    }
  }

  close(): void {
    this.transport?.close();
    this.callbacks = noopCallbacks;
  }

  // ---- internals ----

  private emit(events: SimEvent[]): void {
    for (const event of events) {
      this.transport?.send({ t: 'event', event });
      this.callbacks.onEvent(event);
    }
  }

  private broadcastLobby(): void {
    const players = this.lobbyPlayers();
    this.transport?.send({ t: 'lobby', players });
    this.callbacks.onLobby(players);
  }

  /** Forward a pose to every other client right away (snapshots also carry it, but slower). */
  private relayPose(from: PlayerId, pose: PlayerPose): void {
    if (!this.transport) return;
    for (const id of Object.keys(this.sim.state.players)) {
      if (id !== from && id !== this.localId) this.transport.send({ t: 'peerPose', id: from, pose }, id);
    }
  }

  private applyVoice(id: PlayerId, level: number): void {
    const player = this.sim.state.players[id];
    if (!player || !(level > 0)) return;
    this.sim.reportNoise({
      source: 'voice',
      position: player.pose.head.position,
      loudness: clamp(level, 0, 1),
      playerId: id,
    });
  }

  /** Rate limit for client `from` (see CLIENT_LIMITS). */
  private allow(from: PlayerId, kind: LimitKind): boolean {
    const now = this.now();
    let l = this.limits.get(from);
    if (!l) {
      const make = (k: LimitKind) => new RateLimit(CLIENT_LIMITS[k][0], CLIENT_LIMITS[k][1], now);
      l = { pose: make('pose'), voice: make('voice'), noise: make('noise'), action: make('action') };
      this.limits.set(from, l);
    }
    return l[kind].take(now);
  }

  /** A client-reported noise, cleaned: a known source, loudness 0..1, next to the player's head. */
  private clientNoise(from: PlayerId, raw: unknown): NoiseEvent | null {
    const player = this.sim.state.players[from];
    if (!player || !isObj(raw)) return null;
    const source = raw.source as NoiseSource;
    const pos = readVec3(raw.position);
    if (!CLIENT_NOISES.includes(source) || !pos) return null;
    return {
      source,
      position: clampToward(player.pose.head.position, pos, LIMITS.noiseReach),
      loudness: clamp(readNum(raw.loudness) ?? 0, 0, 1),
      playerId: from,
    };
  }

  /** Everything here comes straight off the network from a client: trust nothing. */
  private onMessage(msg: NetMessage, from: PlayerId): void {
    if (typeof from !== 'string' || !isSafeKey(from)) return;
    const known = hasOwn(this.sim.state.players, from);
    switch (msg.t) {
      case 'hello': {
        if (known) return;
        if (msg.version !== PROTOCOL_VERSION) {
          this.transport?.send({ t: 'reject', reason: 'Your game version is different from the host’s. Refresh the page.' }, from);
          return;
        }
        if (Object.keys(this.sim.state.players).length >= GAME.maxPlayers) {
          this.transport?.send({ t: 'reject', reason: `That room is full (${GAME.maxPlayers} players max).` }, from);
          return;
        }
        this.sim.addPlayer(from, sanitizeName(msg.name), !!msg.isDesktop);
        this.transport?.send({ t: 'welcome', playerId: from, state: this.sim.snapshot() }, from);
        this.broadcastLobby();
        return;
      }
      case 'pose': {
        if (!known || !this.allow(from, 'pose')) return;
        this.sim.setPlayerPose(from, msg.pose, true);
        // Relay what the sim accepted (sanitized, speed-limited), never the raw message.
        const pose = this.sim.state.players[from].pose;
        this.relayPose(from, pose);
        this.callbacks.onRemotePose(from, pose);
        return;
      }
      case 'voice':
        if (known && this.allow(from, 'voice')) this.applyVoice(from, Number(msg.level));
        return;
      case 'noise': {
        if (!known || !this.allow(from, 'noise')) return;
        const noise = this.clientNoise(from, msg.noise);
        if (noise) this.sim.reportNoise(noise);
        return;
      }
      case 'action':
        if (known && isObj(msg.action) && this.allow(from, 'action')) {
          this.emit(this.sim.handleAction(from, msg.action));
        }
        return;
      default:
        // host -> client messages are never valid from a client
        return;
    }
  }
}

// ---------------------------------------------------------------------------------------------

export class ClientSession implements Session {
  readonly isHost = false;
  readonly localId: PlayerId;
  readonly level: LevelData;
  readonly roomCode: string;
  readonly voice: VoiceLink | null;
  callbacks: SessionCallbacks = noopCallbacks;

  private _state: WorldState;
  private lobby: LobbyPlayer[];
  private poseTimer = 0;
  private pendingPose: PlayerPose | null = null;

  private constructor(
    private readonly transport: Transport,
    playerId: PlayerId,
    level: LevelData,
    state: WorldState,
  ) {
    this.localId = playerId;
    this._state = state;
    this.level = level;
    this.roomCode = transport.roomCode;
    this.voice = transport.voice;
    this.lobby = toLobby(state);
  }

  /** A session from the host's 'welcome', or null if the welcome is unusable. */
  private static fromWelcome(transport: Transport, msg: Extract<NetMessage, { t: 'welcome' }>): ClientSession | null {
    if (typeof msg.playerId !== 'string' || !isObj(msg.state)) return null;
    const seed = readNum(msg.state.levelSeed);
    if (seed === null) return null;
    const level = createLevel(seed);
    const state = sanitizeWorldState(msg.state, level.bounds);
    return state ? new ClientSession(transport, msg.playerId, level, state) : null;
  }

  /** Connect, say hello, and resolve once the host welcomes us. */
  static async connect(kind: TransportKind, code: string, name: string, isDesktop: boolean): Promise<ClientSession> {
    const transport = await joinRoom(kind, code);
    return new Promise<ClientSession>((resolve, reject) => {
      let session: ClientSession | null = null;
      const timeout = setTimeout(() => {
        transport.close();
        reject(new Error('The host didn’t answer. Check the code and try again.'));
      }, 10_000);

      transport.onMessage((msg) => {
        if (session) {
          session.onMessage(msg);
          return;
        }
        if (msg.t === 'welcome') {
          clearTimeout(timeout);
          session = ClientSession.fromWelcome(transport, msg);
          if (session) resolve(session);
          else {
            transport.close();
            reject(new Error('The host sent a game this version can’t read. Refresh the page.'));
          }
        } else if (msg.t === 'reject') {
          clearTimeout(timeout);
          transport.close();
          reject(new Error(readReason(msg.reason)));
        }
      });
      transport.onPeerLeave(() => {
        if (session) session.callbacks.onDisconnected('Lost connection to the host.');
        else {
          clearTimeout(timeout);
          reject(new Error('Lost connection to the host.'));
        }
      });
      transport.send({ t: 'hello', version: PROTOCOL_VERSION, name, isDesktop });
    });
  }

  get state(): WorldState {
    return this._state;
  }

  lobbyPlayers(): LobbyPlayer[] {
    return this.lobby;
  }

  sendPose(pose: PlayerPose): void {
    this.pendingPose = pose;
  }

  sendVoice(level: number): void {
    this.transport.send({ t: 'voice', level });
  }

  sendNoise(noise: NoiseEvent): void {
    this.transport.send({ t: 'noise', noise });
  }

  sendAction(action: PlayerAction): void {
    this.transport.send({ t: 'action', action });
  }

  startRound(): void {
    /* only the host can */
  }

  setLoudMode(): void {
    /* only the host can */
  }

  update(dt: number): void {
    this.poseTimer += dt;
    if (this.pendingPose && this.poseTimer >= 1 / NET.poseRate) {
      this.poseTimer = 0;
      this.transport.send({ t: 'pose', pose: this.pendingPose });
      this.pendingPose = null;
    }
  }

  close(): void {
    this.callbacks = noopCallbacks;
    this.transport.close();
  }

  /** Everything here comes straight off the network from the host: validate before use. */
  private onMessage(msg: NetMessage): void {
    const bounds = this.level.bounds;
    switch (msg.t) {
      case 'snapshot': {
        const state = sanitizeWorldState(msg.state, bounds);
        if (state) this._state = state;
        return;
      }
      case 'peerPose': {
        // Only for other players we know about (our own pose is ours; strangers would leak).
        const players = this._state.players;
        const p =
          typeof msg.id === 'string' && msg.id !== this.localId && hasOwn(players, msg.id) ? players[msg.id] : undefined;
        const pose = p ? sanitizePose(msg.pose, bounds) : null;
        if (!p || !pose) return;
        p.pose = pose;
        this.callbacks.onRemotePose(msg.id, pose);
        return;
      }
      case 'event': {
        const event = sanitizeSimEvent(msg.event, bounds);
        if (event) this.callbacks.onEvent(event);
        return;
      }
      case 'round': {
        const state = sanitizeWorldState(msg.state, bounds);
        if (!state) return;
        this._state = state;
        this.callbacks.onRound(state);
        return;
      }
      case 'lobby': {
        const players = sanitizeLobby(msg.players);
        if (!players) return;
        this.lobby = players;
        this.callbacks.onLobby(players);
        return;
      }
      case 'reject':
        this.callbacks.onDisconnected(readReason(msg.reason));
        return;
      default:
        return;
    }
  }
}

function readReason(x: unknown): string {
  return (typeof x === 'string' ? x.slice(0, 200) : '') || 'The host closed the connection.';
}

// ---------------------------------------------------------------------------------------------

export type SessionMode = 'solo' | 'host' | 'join';

export async function createSession(
  mode: SessionMode,
  opts: { name: string; isDesktop: boolean; kind: TransportKind; code?: string },
): Promise<Session> {
  switch (mode) {
    case 'solo':
      return new HostSession(null, opts.name, opts.isDesktop);
    case 'host':
      return new HostSession(await hostRoom(opts.kind), opts.name, opts.isDesktop);
    case 'join':
      return ClientSession.connect(opts.kind, opts.code ?? '', opts.name, opts.isDesktop);
  }
}
