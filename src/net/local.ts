/**
 * 'local' transport: several tabs of ONE browser (or one Node process, for unit tests) talk over a
 * BroadcastChannel named after the room code. Same star semantics as the PeerJS transport (host
 * relays, keepalive-based leave detection, roster), but no voice.
 *
 * Frames are JSON-encoded on the wire, exactly like PeerJS' JSON channel, so anything that works
 * here survives real online play too (no typed arrays, Maps, undefined-vs-missing surprises).
 */

import { hostIdForCode, randomRoomCode } from './roomCode';
import { StarTransport, type Frame, type Link, type StarTiming } from './star';

const CHANNEL_PREFIX = 'mute-vr-local-';

/** Everything on the channel is addressed (`to`) because every tab sees every post. */
type Wire =
  | { c: 'join'; f: string; to: string }
  | { c: 'accept'; f: string; to: string }
  | { c: 'data'; f: string; to: string; d: string };

function isWire(x: unknown): x is Wire {
  if (typeof x !== 'object' || x === null) return false;
  const w = x as Partial<Record<string, unknown>>;
  return typeof w.c === 'string' && typeof w.f === 'string' && typeof w.to === 'string';
}

function parse(d: unknown): unknown {
  if (typeof d !== 'string') return undefined;
  try {
    return JSON.parse(d);
  } catch {
    return undefined;
  }
}

function requireBroadcastChannel(): void {
  if (typeof BroadcastChannel === 'undefined') {
    throw new Error("This browser doesn't support BroadcastChannel, which the local test transport needs.");
  }
}

/** A channel wrapper that silently ignores posts after close(). */
function openChannel(code: string): { post(w: Wire): void; close(): void; ch: BroadcastChannel } {
  const ch = new BroadcastChannel(CHANNEL_PREFIX + code);
  let open = true;
  return {
    ch,
    post(w) {
      if (!open) return;
      try {
        ch.postMessage(w);
      } catch {
        // closed underneath us
      }
    },
    close() {
      if (!open) return;
      open = false;
      ch.onmessage = null;
      ch.close();
    },
  };
}

export interface LocalJoinOptions {
  timing: StarTiming;
  /** Reject if no host answers within this time. */
  joinTimeoutMs: number;
}

export async function hostLocal(timing: StarTiming): Promise<StarTransport> {
  requireBroadcastChannel();
  const code = randomRoomCode();
  const hostId = hostIdForCode(code);
  const chan = openChannel(code);

  const links = new Map<string, Link>();
  const linkTo = (peerId: string): Link => {
    let link = links.get(peerId);
    if (!link) {
      link = {
        send: (frame: Frame) => chan.post({ c: 'data', f: hostId, to: peerId, d: JSON.stringify(frame) }),
        close: () => links.delete(peerId),
      };
      links.set(peerId, link);
    }
    return link;
  };

  const star = new StarTransport({
    selfId: hostId,
    hostId,
    isHost: true,
    roomCode: code,
    timing,
    voice: null,
    dispose: () => chan.close(),
  });

  chan.ch.onmessage = (ev: MessageEvent) => {
    const w: unknown = ev.data;
    if (!isWire(w) || w.to !== hostId || star.closed) return;
    if (w.c === 'join') {
      // Accept first so it arrives before anything the game sends from its onPeerJoin handler.
      // Joins are retried by the client until accepted, so this must be idempotent.
      chan.post({ c: 'accept', f: hostId, to: w.f });
      if (!star.hasPeer(w.f)) star.addLink(w.f, linkTo(w.f));
    } else if (w.c === 'data') {
      const link = links.get(w.f);
      if (!link || !star.hasPeer(w.f)) {
        // A client we dropped (timeout) is still talking: tell it it's out.
        chan.post({ c: 'data', f: hostId, to: w.f, d: JSON.stringify({ k: 'b' } satisfies Frame) });
        return;
      }
      star.receive(w.f, parse(w.d), link);
    }
  };
  return star;
}

export function joinLocal(code: string, opts: LocalJoinOptions): Promise<StarTransport> {
  requireBroadcastChannel();
  const hostId = hostIdForCode(code);
  const selfId = 'local-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  const chan = openChannel(code);

  return new Promise<StarTransport>((resolve, reject) => {
    let star: StarTransport | null = null;
    const link: Link = {
      send: (frame: Frame) => chan.post({ c: 'data', f: selfId, to: hostId, d: JSON.stringify(frame) }),
      close: () => {},
    };
    const sendJoin = (): void => chan.post({ c: 'join', f: selfId, to: hostId });
    const retry = setInterval(sendJoin, Math.min(250, Math.max(20, opts.joinTimeoutMs / 4)));
    const timeout = setTimeout(() => {
      clearInterval(retry);
      chan.close();
      reject(new Error(`No room with code ${code}.`));
    }, opts.joinTimeoutMs);

    chan.ch.onmessage = (ev: MessageEvent) => {
      const w: unknown = ev.data;
      if (!isWire(w) || w.to !== selfId || w.f !== hostId) return;
      if (w.c === 'accept') {
        if (star) return;
        clearInterval(retry);
        clearTimeout(timeout);
        star = new StarTransport({
          selfId,
          hostId,
          isHost: false,
          roomCode: code,
          timing: opts.timing,
          voice: null,
          dispose: () => chan.close(),
        });
        star.addLink(hostId, link);
        resolve(star);
      } else if (w.c === 'data' && star) {
        star.receive(hostId, parse(w.d), link);
      }
    };
    sendJoin();
  });
}
