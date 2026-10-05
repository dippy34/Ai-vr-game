/** Transport contract: how the game loop sends/receives NetMessages. Implementations live next to this file. */

import type { PlayerId } from '../core/types';
import type { NetMessage } from './protocol';

/** Peer-to-peer voice between all players in the room. */
export interface VoiceLink {
  /** Our microphone stream to send to everyone (null = send nothing). Can be set at any time. */
  setLocalStream(stream: MediaStream | null): void;
  onRemoteStream(handler: (peerId: PlayerId, stream: MediaStream) => void): void;
  onRemoteStreamEnded(handler: (peerId: PlayerId) => void): void;
}

export interface Transport {
  /** Our own id. Player ids ARE transport peer ids. */
  readonly selfId: PlayerId;
  readonly isHost: boolean;
  /** Human-friendly room code, e.g. "K7QXM". */
  readonly roomCode: string;
  /** Null when the transport can't carry audio (e.g. the local BroadcastChannel test transport). */
  readonly voice: VoiceLink | null;
  /**
   * Host: send to one client (`to`) or broadcast to all clients (no `to`).
   * Client: always goes to the host (`to` is ignored).
   */
  send(msg: NetMessage, to?: PlayerId): void;
  onMessage(handler: (msg: NetMessage, from: PlayerId) => void): void;
  /** Host: a client connected. Client: never fires. */
  onPeerJoin(handler: (peerId: PlayerId) => void): void;
  /** Host: a client left. Client: the host left / connection lost (peerId = host id). */
  onPeerLeave(handler: (peerId: PlayerId) => void): void;
  close(): void;
}

export type TransportKind =
  /** Real online play over WebRTC (PeerJS public signaling server). */
  | 'peerjs'
  /** Same-browser testing across tabs via BroadcastChannel. No voice. */
  | 'local';
