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
  PlayerAction,
  PlayerId,
  PlayerPose,
  SimEvent,
  WorldState,
} from '../core/types';
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
  update(dt: number): void;
  close(): void;
}

function sanitizeName(name: string): string {
  return (
    String(name)
      .replace(/[^\p{L}\p{N} _.'-]/gu, '')
      .trim()
      .slice(0, 16) || 'Survivor'
  );
}

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

  constructor(
    private readonly transport: Transport | null,
    name: string,
    isDesktop: boolean,
  ) {
    const seed = Math.floor(Math.random() * 2 ** 31);
    this.level = createLevel(seed);
    this.sim = new GameSim(this.level, {
      fusesRequired: GAME.fusesRequired,
      startingFilm: GAME.startingFilm,
    });
    this.localId = transport?.selfId ?? 'solo';
    this.roomCode = transport?.roomCode ?? null;
    this.voice = transport?.voice ?? null;
    this.sim.addPlayer(this.localId, sanitizeName(name), isDesktop);

    if (transport) {
      transport.onMessage((msg, from) => this.onMessage(msg, from));
      transport.onPeerLeave((id) => {
        if (!this.sim.state.players[id]) return;
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
    this.relayPose(this.localId, pose);
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

  private onMessage(msg: NetMessage, from: PlayerId): void {
    const known = !!this.sim.state.players[from];
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
      case 'pose':
        if (!known) return;
        this.sim.setPlayerPose(from, msg.pose);
        this.relayPose(from, msg.pose);
        this.callbacks.onRemotePose(from, msg.pose);
        return;
      case 'voice':
        if (known) this.applyVoice(from, Number(msg.level));
        return;
      case 'noise':
        if (!known || msg.noise.source === 'voice') return;
        this.sim.reportNoise({
          ...msg.noise,
          loudness: clamp(Number(msg.noise.loudness) || 0, 0, 1),
          playerId: from,
        });
        return;
      case 'action':
        if (known) this.emit(this.sim.handleAction(from, msg.action));
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
    welcome: Extract<NetMessage, { t: 'welcome' }>,
  ) {
    this.localId = welcome.playerId;
    this._state = welcome.state;
    this.level = createLevel(welcome.state.levelSeed);
    this.roomCode = transport.roomCode;
    this.voice = transport.voice;
    this.lobby = toLobby(welcome.state);
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
          session = new ClientSession(transport, msg);
          resolve(session);
        } else if (msg.t === 'reject') {
          clearTimeout(timeout);
          transport.close();
          reject(new Error(msg.reason));
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

  private onMessage(msg: NetMessage): void {
    switch (msg.t) {
      case 'snapshot':
        this._state = msg.state;
        return;
      case 'peerPose': {
        const p = this._state.players[msg.id];
        if (p) p.pose = msg.pose;
        this.callbacks.onRemotePose(msg.id, msg.pose);
        return;
      }
      case 'event':
        this.callbacks.onEvent(msg.event);
        return;
      case 'round':
        this._state = msg.state;
        this.callbacks.onRound(this._state);
        return;
      case 'lobby':
        this.lobby = msg.players;
        this.callbacks.onLobby(msg.players);
        return;
      case 'reject':
        this.callbacks.onDisconnected(msg.reason);
        return;
      default:
        return;
    }
  }
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
