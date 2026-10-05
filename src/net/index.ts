import type { Transport, TransportKind } from './transport';

/**
 * Create a room as host. Resolves once the room is reachable (PeerJS: registered with the
 * signaling server under NET.idPrefix + code).
 * STUB — implemented by the net module.
 */
export async function hostRoom(kind: TransportKind): Promise<Transport> {
  throw new Error(`hostRoom(${kind}) not implemented yet`);
}

/**
 * Join a room by code. Resolves once connected to the host's data channel.
 * Rejects with a readable Error message if the room doesn't exist / times out.
 * STUB — implemented by the net module.
 */
export async function joinRoom(kind: TransportKind, code: string): Promise<Transport> {
  throw new Error(`joinRoom(${kind}, ${code}) not implemented yet`);
}

export type { Transport, TransportKind, VoiceLink } from './transport';
