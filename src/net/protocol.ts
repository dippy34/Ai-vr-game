/**
 * Network messages. Topology is a star: every client talks only to the host, the host runs the
 * GameSim and relays. (Voice audio is the exception: it is peer-to-peer between everyone.)
 * Messages are plain JSON so any transport (PeerJS, BroadcastChannel, WebSocket, Photon...) works.
 *
 * Nothing received is trusted, in either direction: the types below describe what a well-behaved
 * peer sends, not what arrives. HostSession validates and rate-limits client messages (and the
 * GameSim sanitizes poses / actions); ClientSession validates the host's states, poses, events and
 * lobbies before use. The readers live in src/core/validate.ts.
 */

import type {
  NoiseEvent,
  PlayerAction,
  PlayerId,
  PlayerPose,
  SimEvent,
  WorldState,
} from '../core/types';

/** Bump when messages or the state change shape (2: monster body language). */
export const PROTOCOL_VERSION = 2;

export interface LobbyPlayer {
  id: PlayerId;
  name: string;
  color: number;
  isDesktop: boolean;
}

export type NetMessage =
  // ---- client -> host ----
  | { t: 'hello'; version: number; name: string; isDesktop: boolean }
  | { t: 'pose'; pose: PlayerPose }
  /** Current mic loudness 0..1 (already gated). The host turns it into a voice NoiseEvent. */
  | { t: 'voice'; level: number }
  /** A non-voice noise the client made (footsteps). */
  | { t: 'noise'; noise: NoiseEvent }
  | { t: 'action'; action: PlayerAction }
  // ---- host -> clients ----
  | { t: 'welcome'; playerId: PlayerId; state: WorldState }
  | { t: 'reject'; reason: string }
  | { t: 'lobby'; players: LobbyPlayer[] }
  | { t: 'snapshot'; state: WorldState }
  /** Low-latency relay of another player's pose (between snapshots). */
  | { t: 'peerPose'; id: PlayerId; pose: PlayerPose }
  | { t: 'event'; event: SimEvent }
  /** A brand new round (start or restart). Clients rebuild from this state. */
  | { t: 'round'; state: WorldState };
