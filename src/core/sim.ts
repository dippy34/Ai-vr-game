import type {
  LevelData,
  NoiseEvent,
  PlayerAction,
  PlayerId,
  PlayerPose,
  PlayerState,
  SimEvent,
  WorldState,
} from './types';

export interface SimOptions {
  fusesRequired?: number;
  startingFilm?: number;
}

/**
 * Authoritative game simulation. Runs only on the host (or locally in solo play).
 * Pure logic: no rendering, audio, DOM or networking.
 * STUB — implemented by the core module.
 */
export class GameSim {
  readonly level: LevelData;
  readonly state: WorldState;

  constructor(level: LevelData, opts: SimOptions = {}) {
    void opts;
    this.level = level;
    throw new Error('GameSim not implemented yet');
  }

  /** Add a player (lobby or mid-round). Assigns color + spawn. Returns the new player state. */
  addPlayer(id: PlayerId, name: string, isDesktop: boolean): PlayerState {
    void id; void name; void isDesktop;
    throw new Error('not implemented');
  }

  /** Remove a player; anything they held is dropped where their hands were. */
  removePlayer(id: PlayerId): SimEvent[] {
    void id;
    return [];
  }

  /** Client-authoritative pose update. Also moves anything held in their hands. */
  setPlayerPose(id: PlayerId, pose: PlayerPose): void {
    void id; void pose;
  }

  /**
   * Start (or restart) a round: resets monster, items, camera, fuses, statuses; assigns spawns.
   * Sets phase 'playing'. Returns events (including { type: 'phase', phase: 'playing' }).
   */
  startRound(): SimEvent[] {
    return [];
  }

  /** Something made a sound. Ignored unless phase === 'playing' and the source player is alive. */
  reportNoise(noise: NoiseEvent): void {
    void noise;
  }

  /** Apply a player's action. Returns resulting events. */
  handleAction(id: PlayerId, action: PlayerAction): SimEvent[] {
    void id; void action;
    return [];
  }

  /** Advance the simulation by dt seconds. Returns events that happened. */
  step(dt: number): SimEvent[] {
    void dt;
    return [];
  }

  /** Deep copy of the state, safe to JSON-serialize and send. */
  snapshot(): WorldState {
    return structuredClone(this.state);
  }
}
