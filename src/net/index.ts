/**
 * Network module entry point.
 *
 *   const t = await hostRoom('peerjs');          // t.roomCode -> show it to the players
 *   const t = await joinRoom('peerjs', 'k7qxm');  // codes are normalized for you
 *
 * Topology: data is a star (clients <-> host; the game loop on the host relays), voice is a full
 * mesh (`t.voice`, PeerJS only). Player ids === transport peer ids. See star.ts / peer.ts / voice.ts.
 */

import { isValidRoomCode, normalizeRoomCode } from './roomCode';
import { hostLocal, joinLocal } from './local';
import { DEFAULT_TIMING, type StarTiming } from './star';
import type { Transport, TransportKind } from './transport';

export interface NetOptions {
  /** Keepalive interval (default 2000 ms). */
  pingIntervalMs?: number;
  /** Drop a peer after this long without any traffic (default 15000 ms). */
  peerTimeoutMs?: number;
  /** Extra silence allowed right after a peer joins, while it builds the level (default 30000 ms). */
  joinGraceMs?: number;
  /** Max wait for the host to answer a join (default: 10000 ms peerjs, 2000 ms local). */
  joinTimeoutMs?: number;
  /** PeerJS only: max wait for the signaling server (default 10000 ms). */
  signalingTimeoutMs?: number;
}

function timing(opts: NetOptions): StarTiming {
  return {
    ...DEFAULT_TIMING,
    ...(opts.pingIntervalMs !== undefined ? { pingIntervalMs: opts.pingIntervalMs } : {}),
    ...(opts.joinGraceMs !== undefined ? { joinGraceMs: opts.joinGraceMs } : {}),
    ...(opts.peerTimeoutMs !== undefined ? { peerTimeoutMs: opts.peerTimeoutMs } : {}),
  };
}

function unknownKind(kind: never): Error {
  return new Error(`Unknown transport kind "${String(kind)}"`);
}

/**
 * Create a room as host. Resolves once the room is reachable (PeerJS: registered with the
 * signaling server under NET.idPrefix + code). The result is a RoomTransport (see star.ts).
 */
export async function hostRoom(kind: TransportKind, options: NetOptions = {}): Promise<Transport> {
  switch (kind) {
    case 'local':
      return hostLocal(timing(options));
    case 'peerjs': {
      const { hostPeerjs } = await import('./peer');
      return hostPeerjs({
        timing: timing(options),
        signalingTimeoutMs: options.signalingTimeoutMs ?? 10000,
        joinTimeoutMs: options.joinTimeoutMs ?? 10000,
      });
    }
    default:
      throw unknownKind(kind);
  }
}

/**
 * Join a room by code (any case, spaces/dashes allowed). Resolves once connected to the host's
 * data channel. Rejects with a readable Error message if the room doesn't exist / times out.
 */
export async function joinRoom(kind: TransportKind, code: string, options: NetOptions = {}): Promise<Transport> {
  const normalized = normalizeRoomCode(code);
  if (!isValidRoomCode(normalized)) {
    throw new Error(normalized ? `No room with code ${normalized}.` : 'Enter a room code.');
  }
  switch (kind) {
    case 'local':
      return joinLocal(normalized, { timing: timing(options), joinTimeoutMs: options.joinTimeoutMs ?? 2000 });
    case 'peerjs': {
      const { joinPeerjs } = await import('./peer');
      return joinPeerjs(normalized, {
        timing: timing(options),
        signalingTimeoutMs: options.signalingTimeoutMs ?? 10000,
        joinTimeoutMs: options.joinTimeoutMs ?? 10000,
      });
    }
    default:
      throw unknownKind(kind);
  }
}

/** 'local' if the page URL has `?net=local` (multi-tab testing), else 'peerjs'. */
export function defaultTransportKind(): TransportKind {
  try {
    if (typeof location !== 'undefined') {
      const net = new URLSearchParams(location.search).get('net');
      if (net === 'local') return 'local';
    }
  } catch {
    // not a browser
  }
  return 'peerjs';
}

export { normalizeRoomCode, isValidRoomCode, randomRoomCode } from './roomCode';
export { isRoomTransport, type RoomTransport } from './star';
export type { Transport, TransportKind, VoiceLink } from './transport';
