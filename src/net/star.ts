/**
 * Transport-agnostic core of every MUTE transport: a star (clients <-> host) with
 *  - a private wire envelope ("frames") around NetMessages,
 *  - keepalive pings + timeout-based leave detection (close events of WebRTC/BroadcastChannel are
 *    unreliable or nonexistent),
 *  - a ROSTER the host pushes to every client (all peer ids in the room; the voice mesh needs it),
 *  - chunking of frames bigger than the channel's message limit (PeerJS' JSON channel drops
 *    anything >= ~16 KB, and a full WorldState can get close to that).
 *
 * Concrete transports (peer.ts, local.ts) only move frames over a `Link` and report channel
 * open/close; NetMessage payloads pass through untouched.
 */

import type { PlayerId } from '../core/types';
import type { NetMessage } from './protocol';
import type { Transport, VoiceLink } from './transport';

/** Wire envelope. Short keys: these go out up to ~20x/s per player. */
export type Frame =
  /** A game message. */
  | { k: 'm'; m: NetMessage }
  /** Keepalive ping (answered with 'q' unless we sent something recently). */
  | { k: 'p' }
  /** Keepalive pong. */
  | { k: 'q' }
  /** Host -> clients: everyone in the room, host first, then clients in join order. */
  | { k: 'r'; ids: PlayerId[] }
  /** Graceful leave (or "you were dropped" when sent by the host). */
  | { k: 'b' }
  /** Chunk `i` of `n` of a JSON-encoded frame that was too big to send in one piece. */
  | { k: 'c'; id: number; i: number; n: number; d: string };

/** One point-to-point channel to a remote peer. */
export interface Link {
  /** Deliver a frame (JSON-serializable). Must not throw; drop silently if the channel is gone. */
  send(frame: Frame): void;
  /** Tear down this channel. Must not throw. */
  close(): void;
}

export interface StarTiming {
  /** How often keepalives are sent / timeouts are checked. */
  pingIntervalMs: number;
  /** A peer we haven't heard from for this long is dropped. */
  peerTimeoutMs: number;
  /**
   * A peer that joined less than this long ago gets this much silence before being dropped
   * instead of peerTimeoutMs: right after joining, a client builds the whole level (models,
   * merged meshes, shaders), which can freeze its main thread for seconds on a headset.
   */
  joinGraceMs?: number;
  /** Frames whose JSON is bigger than this (UTF-8 bytes) are chunked. */
  maxFrameBytes: number;
}

export const DEFAULT_TIMING: StarTiming = {
  pingIntervalMs: 2000,
  peerTimeoutMs: 15000,
  joinGraceMs: 30000,
  // PeerJS' JSON serializer refuses messages >= 16300 bytes (util.chunkedMTU).
  maxFrameBytes: 16000,
};

/** A Transport that also exposes the room roster. Every transport from this module is one. */
export interface RoomTransport extends Transport {
  /** Everyone in the room (including us): host first, then clients in join order. Empty once closed. */
  readonly roster: readonly PlayerId[];
  /** Fires whenever `roster` changes. */
  onRosterChange(handler: (roster: readonly PlayerId[]) => void): void;
  /** True after close() or after a client lost its host. */
  readonly closed: boolean;
}

export function isRoomTransport(t: Transport): t is RoomTransport {
  return Array.isArray((t as Partial<RoomTransport>).roster) && typeof (t as Partial<RoomTransport>).onRosterChange === 'function';
}

/**
 * Event with multiple listeners. Events emitted before the first listener is registered are
 * buffered and replayed (in order, on a microtask) once one is, so a game loop that registers its
 * handlers a little after `await joinRoom()` doesn't miss the host's 'welcome'.
 */
export class Signal<A extends unknown[]> {
  private handlers: ((...args: A) => void)[] = [];
  private queue: A[] | null = [];
  private flushScheduled = false;

  constructor(private readonly maxQueued = 1000) {}

  add(handler: (...args: A) => void): void {
    this.handlers.push(handler);
    if (this.queue && !this.flushScheduled) {
      if (this.queue.length === 0) {
        this.queue = null;
        return;
      }
      this.flushScheduled = true;
      queueMicrotask(() => {
        const queued = this.queue ?? [];
        this.queue = null;
        this.flushScheduled = false;
        for (const args of queued) this.dispatch(args);
      });
    }
  }

  emit(...args: A): void {
    if (this.queue) {
      if (this.queue.length < this.maxQueued) this.queue.push(args);
      return;
    }
    this.dispatch(args);
  }

  clear(): void {
    this.handlers = [];
    this.queue = null;
  }

  private dispatch(args: A): void {
    for (const handler of this.handlers.slice()) {
      try {
        handler(...args);
      } catch (err) {
        console.error('[net] handler threw', err);
      }
    }
  }
}

interface PeerEntry {
  link: Link;
  lastHeard: number;
  /** When the peer joined (for the join grace period). */
  joinedAt: number;
  lastSent: number;
  /** Outgoing chunk sequence number. */
  chunkSeq: number;
  /** Incoming partially reassembled frames by chunk id. */
  inbox: Map<number, { n: number; parts: (string | undefined)[]; got: number }>;
}

export interface StarInit {
  selfId: PlayerId;
  hostId: PlayerId;
  isHost: boolean;
  roomCode: string;
  timing: StarTiming;
  voice?: VoiceLink | null;
  /** Tears down the underlying channel/peer. Called exactly once, when the transport shuts down. */
  dispose: () => void;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function isFrame(x: unknown): x is Frame {
  return typeof x === 'object' && x !== null && typeof (x as { k?: unknown }).k === 'string';
}

const MAX_CHUNKS = 4096;

export class StarTransport implements RoomTransport {
  readonly selfId: PlayerId;
  readonly hostId: PlayerId;
  readonly isHost: boolean;
  readonly roomCode: string;
  readonly voice: VoiceLink | null;

  private readonly timing: StarTiming;
  private readonly disposeChannel: () => void;
  private readonly peers = new Map<PlayerId, PeerEntry>();
  private _roster: PlayerId[];
  private _closed = false;
  private hostLost = false;
  private lastTick = now();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly messageSig = new Signal<[NetMessage, PlayerId]>();
  private readonly joinSig = new Signal<[PlayerId]>();
  private readonly leaveSig = new Signal<[PlayerId]>();
  private readonly rosterHandlers: ((roster: readonly PlayerId[]) => void)[] = [];
  private readonly onPageHide = (): void => this.close();

  constructor(init: StarInit) {
    this.selfId = init.selfId;
    this.hostId = init.hostId;
    this.isHost = init.isHost;
    this.roomCode = init.roomCode;
    this.voice = init.voice ?? null;
    this.timing = init.timing;
    this.disposeChannel = init.dispose;
    this._roster = init.isHost ? [init.selfId] : [init.hostId, init.selfId];
    this.timer = setInterval(() => this.tick(), this.timing.pingIntervalMs);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      // Best-effort goodbye so the others don't have to wait for the keepalive timeout.
      window.addEventListener('pagehide', this.onPageHide);
    }
  }

  // ---------------------------------------------------------------- Transport

  get roster(): readonly PlayerId[] {
    return this._roster;
  }

  get closed(): boolean {
    return this._closed;
  }

  send(msg: NetMessage, to?: PlayerId): void {
    if (this._closed) return;
    const frame: Frame = { k: 'm', m: msg };
    if (!this.isHost) {
      const host = this.peers.get(this.hostId);
      if (host) this.sendFrame(host, frame);
      return;
    }
    if (to !== undefined) {
      const entry = this.peers.get(to);
      if (entry) this.sendFrame(entry, frame);
      return;
    }
    for (const entry of this.peers.values()) this.sendFrame(entry, frame);
  }

  onMessage(handler: (msg: NetMessage, from: PlayerId) => void): void {
    this.messageSig.add(handler);
  }

  onPeerJoin(handler: (peerId: PlayerId) => void): void {
    this.joinSig.add(handler);
  }

  onPeerLeave(handler: (peerId: PlayerId) => void): void {
    this.leaveSig.add(handler);
  }

  onRosterChange(handler: (roster: readonly PlayerId[]) => void): void {
    this.rosterHandlers.push(handler);
  }

  /** Leave the room. Tells the others (best effort) and frees everything. Fires no onPeerLeave. */
  close(): void {
    if (this._closed) return;
    for (const entry of this.peers.values()) {
      this.sendFrame(entry, { k: 'b' });
      entry.link.close();
    }
    this.peers.clear();
    this.shutdown();
  }

  // ------------------------------------------------- used by concrete transports

  hasPeer(id: PlayerId): boolean {
    return this.peers.has(id);
  }

  /** A channel to `id` is open. Host: a client joined. Client: call once with the host link. */
  addLink(id: PlayerId, link: Link): void {
    if (this._closed || id === this.selfId) {
      link.close();
      return;
    }
    if (!this.isHost && id !== this.hostId) {
      link.close();
      return;
    }
    if (this.peers.has(id)) this.dropPeer(id, 'replaced');
    const t = now();
    this.peers.set(id, { link, lastHeard: t, joinedAt: t, lastSent: 0, chunkSeq: 0, inbox: new Map() });
    if (this.isHost) {
      this.setRoster([...this._roster.filter((p) => p !== id), id]);
      this.joinSig.emit(id);
    } else {
      // Say hi right away so the host sees traffic even before the game sends anything.
      this.sendFrame(this.peers.get(id)!, { k: 'p' });
    }
  }

  /** Raw frame received from `from` over `link` (if given, frames from a stale link are ignored). */
  receive(from: PlayerId, data: unknown, link?: Link): void {
    if (this._closed) return;
    const entry = this.peers.get(from);
    if (!entry || (link && entry.link !== link)) return;
    entry.lastHeard = now();
    this.handleFrame(from, entry, data);
  }

  /** The underlying channel to `id` closed or failed. */
  linkClosed(id: PlayerId, link?: Link): void {
    const entry = this.peers.get(id);
    if (!entry || (link && entry.link !== link)) return;
    this.dropPeer(id, 'closed');
  }

  // ------------------------------------------------------------------ internals

  private handleFrame(from: PlayerId, entry: PeerEntry, data: unknown): void {
    if (!isFrame(data)) return;
    switch (data.k) {
      case 'm':
        if (data.m && typeof data.m === 'object') this.messageSig.emit(data.m, from);
        break;
      case 'p':
        if (now() - entry.lastSent > this.timing.pingIntervalMs / 2) this.sendFrame(entry, { k: 'q' });
        break;
      case 'q':
        break;
      case 'r':
        if (!this.isHost && from === this.hostId && Array.isArray(data.ids)) {
          const ids = data.ids.filter((x): x is string => typeof x === 'string');
          if (!ids.includes(this.selfId)) ids.push(this.selfId);
          this.setRoster(ids);
        }
        break;
      case 'b':
        this.dropPeer(from, 'bye');
        break;
      case 'c':
        this.receiveChunk(from, entry, data);
        break;
    }
  }

  private receiveChunk(from: PlayerId, entry: PeerEntry, c: Extract<Frame, { k: 'c' }>): void {
    if (
      typeof c.d !== 'string' ||
      !Number.isInteger(c.n) ||
      !Number.isInteger(c.i) ||
      c.n < 1 ||
      c.n > MAX_CHUNKS ||
      c.i < 0 ||
      c.i >= c.n
    ) {
      return;
    }
    let slot = entry.inbox.get(c.id);
    if (!slot) {
      // Channels are reliable + ordered, so at most a couple of assemblies are ever in flight.
      if (entry.inbox.size >= 8) entry.inbox.delete(entry.inbox.keys().next().value!);
      slot = { n: c.n, parts: new Array(c.n), got: 0 };
      entry.inbox.set(c.id, slot);
    }
    if (slot.n !== c.n || slot.parts[c.i] !== undefined) return;
    slot.parts[c.i] = c.d;
    slot.got++;
    if (slot.got < slot.n) return;
    entry.inbox.delete(c.id);
    let frame: unknown;
    try {
      frame = JSON.parse(slot.parts.join(''));
    } catch {
      return;
    }
    if (isFrame(frame) && frame.k !== 'c') this.handleFrame(from, entry, frame);
  }

  private sendFrame(entry: PeerEntry, frame: Frame): void {
    entry.lastSent = now();
    const max = this.timing.maxFrameBytes;
    if (frame.k === 'p' || frame.k === 'q' || frame.k === 'b') {
      entry.link.send(frame);
      return;
    }
    let json: string;
    try {
      json = JSON.stringify(frame);
    } catch (err) {
      console.error('[net] message is not JSON-serializable, dropped', err);
      return;
    }
    if (json.length * 3 <= max || utf8Length(json) <= max) {
      entry.link.send(frame);
      return;
    }
    // Re-encoded as a JSON string, each char costs at most 3 bytes (`"` and `\` become 2, BMP
    // non-ASCII is 3, a surrogate pair is 4 for 2 chars), so this step always fits.
    const step = Math.max(16, Math.floor((max - 96) / 3));
    const parts: string[] = [];
    for (let i = 0; i < json.length; ) {
      let end = Math.min(json.length, i + step);
      const last = json.charCodeAt(end - 1);
      if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--; // don't split a surrogate pair
      parts.push(json.slice(i, end));
      i = end;
    }
    if (parts.length > MAX_CHUNKS) {
      console.error(`[net] message too big (${json.length} chars), dropped`);
      return;
    }
    const id = entry.chunkSeq++;
    parts.forEach((d, i) => entry.link.send({ k: 'c', id, i, n: parts.length, d }));
  }

  private setRoster(ids: PlayerId[]): void {
    const same = ids.length === this._roster.length && ids.every((id, i) => id === this._roster[i]);
    if (same) return;
    this._roster = ids;
    if (this.isHost && !this._closed) {
      for (const entry of this.peers.values()) this.sendFrame(entry, { k: 'r', ids });
    }
    for (const handler of this.rosterHandlers.slice()) {
      try {
        handler(ids);
      } catch (err) {
        console.error('[net] roster handler threw', err);
      }
    }
  }

  private dropPeer(id: PlayerId, reason: 'bye' | 'closed' | 'timeout' | 'replaced'): void {
    const entry = this.peers.get(id);
    if (!entry) return;
    this.peers.delete(id);
    // On timeout, tell the peer (if it can still hear us) that it is out, so it doesn't linger.
    if (reason === 'timeout') entry.link.send({ k: 'b' });
    entry.link.close();
    if (this.isHost) {
      this.setRoster(this._roster.filter((p) => p !== id));
      this.leaveSig.emit(id);
    } else if (!this.hostLost) {
      this.hostLost = true;
      this.shutdown();
      this.leaveSig.emit(this.hostId);
    }
  }

  private tick(): void {
    if (this._closed) return;
    const t = now();
    const gap = t - this.lastTick;
    this.lastTick = t;
    // Our own timers were frozen (background tab, laptop sleep...): we can't tell who was silent,
    // so give everyone a fresh window instead of dropping the whole room.
    const suspended = gap > this.timing.pingIntervalMs * 3;
    for (const [id, entry] of [...this.peers]) {
      if (suspended) entry.lastHeard = t;
      const grace = this.timing.joinGraceMs ?? 0;
      const limit = t - entry.joinedAt < grace ? Math.max(grace, this.timing.peerTimeoutMs) : this.timing.peerTimeoutMs;
      if (t - entry.lastHeard > limit) {
        this.dropPeer(id, 'timeout');
        continue;
      }
      if (t - entry.lastSent >= this.timing.pingIntervalMs * 0.9) this.sendFrame(entry, { k: 'p' });
    }
  }

  private shutdown(): void {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this.timer);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pagehide', this.onPageHide);
    }
    for (const entry of this.peers.values()) entry.link.close();
    this.peers.clear();
    this.setRoster([]);
    try {
      this.disposeChannel();
    } catch (err) {
      console.error('[net] dispose failed', err);
    }
  }
}
