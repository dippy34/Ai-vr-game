/**
 * 'peerjs' transport: real online play over WebRTC, brokered by the free PeerJS signaling server.
 * Data is a star (each client has one reliable JSON DataConnection to the host); voice is a full
 * mesh of media calls (see voice.ts). Loaded lazily by index.ts so PeerJS stays out of the main
 * bundle and out of Node unit tests.
 *
 * Configuration (all optional, Vite env vars, e.g. in `.env.local`):
 *   VITE_PEER_HOST, VITE_PEER_PORT, VITE_PEER_PATH, VITE_PEER_SECURE   self-hosted PeerServer
 *   VITE_ICE_SERVERS   JSON array of RTCIceServer, e.g.
 *     [{"urls":"stun:stun.l.google.com:19302"},
 *      {"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]
 * Default: PeerJS cloud (0.peerjs.com) + public Google STUN. STUN is enough for most home
 * networks, but players behind strict/symmetric NATs (some mobile carriers, corporate/campus
 * networks) can only connect through a TURN relay: configure one via VITE_ICE_SERVERS.
 */

import { Peer, type DataConnection, type MediaConnection, type PeerOptions } from 'peerjs';
import { hostIdForCode, randomRoomCode } from './roomCode';
import { StarTransport, type Link, type StarTiming } from './star';
import { PeerVoice, type VoiceCall, type VoicePeer } from './voice';

export interface PeerTransportOptions {
  timing: StarTiming;
  /** Max wait for the signaling server to register us. */
  signalingTimeoutMs: number;
  /** Max wait for the data connection to the host to open. */
  joinTimeoutMs: number;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

const HOST_CODE_ATTEMPTS = 5;

/** Delay before tearing down a channel, so a final goodbye frame still gets delivered. */
const LINGER_MS = 120;

const MSG_SIGNALING = "Couldn't reach the matchmaking server. Check your internet connection and try again.";

function envString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function iceServers(): RTCIceServer[] {
  const raw = envString(import.meta.env.VITE_ICE_SERVERS);
  if (!raw) return DEFAULT_ICE_SERVERS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((s) => typeof s === 'object' && s !== null && 'urls' in s)
    ) {
      return parsed as RTCIceServer[];
    }
  } catch {
    // fall through
  }
  console.warn('[net] VITE_ICE_SERVERS must be a JSON array of RTCIceServer objects; using defaults');
  return DEFAULT_ICE_SERVERS;
}

/** PeerJS options built from the (optional) Vite env vars. */
export function peerOptions(): PeerOptions {
  const opts: PeerOptions = {
    debug: 1, // errors only
    config: { iceServers: iceServers() },
  };
  const host = envString(import.meta.env.VITE_PEER_HOST);
  if (host) opts.host = host;
  const port = Number(envString(import.meta.env.VITE_PEER_PORT));
  if (Number.isInteger(port) && port > 0) opts.port = port;
  const path = envString(import.meta.env.VITE_PEER_PATH);
  if (path) opts.path = path;
  const secure = envString(import.meta.env.VITE_PEER_SECURE);
  if (secure) opts.secure = /^(1|true|yes|on)$/i.test(secure);
  return opts;
}

/** Error carrying the PeerJS error type through our promise chains. */
class PeerFailure extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

function errorType(err: unknown): string {
  return typeof err === 'object' && err !== null && typeof (err as { type?: unknown }).type === 'string'
    ? (err as { type: string }).type
    : '';
}

function readable(err: unknown, code?: string): Error {
  const type = errorType(err);
  switch (type) {
    case 'peer-unavailable':
      return new Error(code ? `No room with code ${code}.` : 'That player is no longer reachable.');
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
    case 'disconnected':
    case 'signaling-timeout':
      return new Error(MSG_SIGNALING);
    case 'ssl-unavailable':
      return new Error("The matchmaking server doesn't support secure connections (check VITE_PEER_SECURE).");
    case 'browser-incompatible':
      return new Error("This browser doesn't support WebRTC, which online play needs.");
    case 'unavailable-id':
      return new Error("Couldn't get a free room code. Please try again.");
    case 'webrtc':
    case 'negotiation-failed':
    case 'connection-closed':
      return new Error(
        `Couldn't connect to ${code ? `room ${code}` : 'the other player'}: the network blocked the ` +
          'peer-to-peer connection. A TURN server may be needed (VITE_ICE_SERVERS).',
      );
    default:
      return new Error(err instanceof Error && err.message ? err.message : 'Network error.');
  }
}

/** "Could not connect to peer <id>" -> id. */
function unavailablePeerId(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : '';
  const m = /peer\s+(\S+)\s*$/.exec(msg);
  return m ? m[1] : null;
}

/** Create a Peer and wait until the signaling server has registered it. */
function openPeer(id: string | undefined, timeoutMs: number): Promise<Peer> {
  return new Promise<Peer>((resolve, reject) => {
    const opts = peerOptions();
    const peer = id ? new Peer(id, opts) : new Peer(opts);
    const cleanup = (): void => {
      clearTimeout(timer);
      peer.off('open', onOpen);
      peer.off('error', onError);
    };
    const fail = (err: unknown): void => {
      cleanup();
      peer.destroy();
      reject(err);
    };
    const onOpen = (): void => {
      cleanup();
      resolve(peer);
    };
    const onError = (err: unknown): void => fail(err);
    const timer = setTimeout(
      () => fail(new PeerFailure('signaling-timeout', 'signaling server timeout')),
      timeoutMs,
    );
    peer.on('open', onOpen);
    peer.on('error', onError);
  });
}

/**
 * Keep the signaling connection alive after setup: the host needs it to accept new players and
 * everyone needs it to set up voice calls. Existing P2P connections survive a drop.
 */
function keepSignaling(peer: Peer, isClosed: () => boolean): () => void {
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onDisconnected = (): void => {
    if (isClosed() || peer.destroyed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (isClosed() || peer.destroyed || !peer.disconnected) return;
      try {
        peer.reconnect();
      } catch (err) {
        console.warn('[net] signaling reconnect failed', err);
      }
    }, delay);
    delay = Math.min(delay * 2, 30000);
  };
  const onOpen = (): void => {
    delay = 1000;
  };
  peer.on('disconnected', onDisconnected);
  peer.on('open', onOpen);
  return () => {
    clearTimeout(timer);
    peer.off('disconnected', onDisconnected);
    peer.off('open', onOpen);
  };
}

/** Errors on a DataConnection that don't mean the channel is dead. */
function isFatalConnError(err: unknown): boolean {
  const type = errorType(err);
  return type !== 'message-too-big' && type !== 'not-open-yet';
}

function linkFor(conn: DataConnection): Link {
  return {
    send(frame) {
      if (!conn.open) return;
      try {
        void conn.send(frame);
      } catch (err) {
        console.warn('[net] send failed', err);
      }
    },
    close() {
      // Give a just-sent goodbye frame a moment to leave before the channel is torn down.
      setTimeout(() => {
        try {
          conn.close();
        } catch {
          // already closed
        }
      }, LINGER_MS);
    },
  };
}

/** Voice + generic error handling shared by host and client peers. */
function attachVoice(peer: Peer, selfId: string): PeerVoice {
  const voice = new PeerVoice(peer as unknown as VoicePeer, selfId);
  peer.on('call', (call: MediaConnection) => voice.handleCall(call as unknown as VoiceCall));
  return voice;
}

export async function hostPeerjs(opts: PeerTransportOptions): Promise<StarTransport> {
  let peer: Peer | null = null;
  let code = '';
  for (let attempt = 0; attempt < HOST_CODE_ATTEMPTS && !peer; attempt++) {
    code = randomRoomCode();
    try {
      peer = await openPeer(hostIdForCode(code), opts.signalingTimeoutMs);
    } catch (err) {
      if (errorType(err) !== 'unavailable-id' || attempt === HOST_CODE_ATTEMPTS - 1) throw readable(err);
    }
  }
  if (!peer) throw readable(new PeerFailure('unavailable-id', 'no free code'));
  const p = peer;
  const hostId = p.id;

  const voice = attachVoice(p, hostId);
  let stopSignaling = (): void => {};
  const star = new StarTransport({
    selfId: hostId,
    hostId,
    isHost: true,
    roomCode: code,
    timing: opts.timing,
    voice,
    dispose: () => {
      stopSignaling();
      voice.dispose();
      setTimeout(() => p.destroy(), LINGER_MS);
    },
  });
  stopSignaling = keepSignaling(p, () => star.closed);
  star.onRosterChange((roster) => voice.setRoster(roster));
  voice.setRoster(star.roster);

  p.on('connection', (conn: DataConnection) => {
    if (star.closed || conn.peer === hostId) {
      conn.close();
      return;
    }
    const link = linkFor(conn);
    // A connection that never opens (ICE failure) emits no 'close'; don't leak it.
    const openTimer = setTimeout(() => {
      if (!conn.open) link.close();
    }, opts.joinTimeoutMs + 5000);
    conn.on('open', () => {
      clearTimeout(openTimer);
      star.addLink(conn.peer, link);
    });
    conn.on('data', (data) => star.receive(conn.peer, data, link));
    conn.on('close', () => {
      clearTimeout(openTimer);
      star.linkClosed(conn.peer, link);
    });
    conn.on('error', (err) => {
      if (!isFatalConnError(err)) {
        console.warn('[net]', err.message);
        return;
      }
      clearTimeout(openTimer);
      link.close();
      star.linkClosed(conn.peer, link);
    });
  });

  p.on('error', (err) => {
    if (err.type === 'peer-unavailable') {
      const id = unavailablePeerId(err);
      if (id) voice.handlePeerUnavailable(id);
      return;
    }
    if (!star.closed) console.warn(`[net] host peer error (${err.type}): ${err.message}`);
  });

  return star;
}

export async function joinPeerjs(code: string, opts: PeerTransportOptions): Promise<StarTransport> {
  const hostId = hostIdForCode(code);
  let peer: Peer;
  try {
    peer = await openPeer(undefined, opts.signalingTimeoutMs);
  } catch (err) {
    throw readable(err, code);
  }
  const p = peer;
  const selfId = p.id;
  // Ready for calls before the data connection opens: the host may dial us first.
  const voice = attachVoice(p, selfId);
  voice.setRoster([hostId, selfId]);

  return new Promise<StarTransport>((resolve, reject) => {
    let star: StarTransport | null = null;
    let failed = false;
    let stopSignaling = (): void => {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fail = (err: Error): void => {
      if (star || failed) return;
      failed = true;
      clearTimeout(timer);
      voice.dispose();
      p.destroy();
      reject(err);
    };

    const conn = p.connect(hostId, { reliable: true, serialization: 'json', metadata: { app: 'mute-vr' } });
    if (!conn) {
      fail(new Error(MSG_SIGNALING));
      return;
    }
    const link = linkFor(conn);
    timer = setTimeout(
      () =>
        fail(
          new Error(
            `Couldn't connect to room ${code} (timed out). If the code is right, the network may be ` +
              'blocking peer-to-peer connections; a TURN server may be needed (VITE_ICE_SERVERS).',
          ),
        ),
      opts.joinTimeoutMs,
    );

    p.on('error', (err) => {
      if (!star) {
        // Before we're in: only errors about the host connection matter.
        if (err.type === 'peer-unavailable') {
          const id = unavailablePeerId(err);
          if (id === null || id === hostId) fail(readable(err, code));
          return;
        }
        // 'webrtc' errors can also come from an early voice call; the data connection's own
        // failures arrive on conn 'error' (or end in the timeout).
        if (err.type === 'webrtc') console.warn(`[net] ${err.message}`);
        else fail(readable(err, code));
        return;
      }
      if (err.type === 'peer-unavailable') {
        const id = unavailablePeerId(err);
        if (id) voice.handlePeerUnavailable(id);
        return;
      }
      if (!star.closed) console.warn(`[net] peer error (${err.type}): ${err.message}`);
    });

    conn.on('open', () => {
      if (failed || star) return;
      clearTimeout(timer);
      const s = new StarTransport({
        selfId,
        hostId,
        isHost: false,
        roomCode: code,
        timing: opts.timing,
        voice,
        dispose: () => {
          stopSignaling();
          voice.dispose();
          setTimeout(() => p.destroy(), LINGER_MS);
        },
      });
      star = s;
      stopSignaling = keepSignaling(p, () => s.closed);
      s.onRosterChange((roster) => voice.setRoster(roster));
      voice.setRoster(s.roster);
      s.addLink(hostId, link);
      resolve(s);
    });
    conn.on('data', (data) => star?.receive(hostId, data, link));
    conn.on('close', () => {
      if (star) star.linkClosed(hostId, link);
      else fail(new Error(`The host of room ${code} closed the connection.`));
    });
    conn.on('error', (err) => {
      if (!isFatalConnError(err)) {
        console.warn('[net]', err.message);
        return;
      }
      if (star) {
        link.close();
        star.linkClosed(hostId, link);
      } else {
        fail(readable(err, code));
      }
    });
  });
}
