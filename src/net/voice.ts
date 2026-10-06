/**
 * Voice mesh over PeerJS media calls (everyone <-> everyone, independent of the data star).
 *
 * Negotiation scheme: ONE-WAY CALLS, OWNED BY THE SENDER.
 *   - Whoever has a mic calls every other roster member and sends its stream on that call.
 *   - Incoming calls are always answered receive-only (no stream). Each call carries exactly one
 *     direction of audio, so a pair of talking players has two calls (A->B and B->A).
 * Why: PeerJS can't renegotiate, `peer.call()` requires a stream, and a single shared call per pair
 * would need glare handling plus a re-call whenever the answering side gets a mic later. Here there
 * is no glare (each side only ever dials its own outgoing call), a late mic simply starts dialing,
 * a mic change swaps the track in place (RTCRtpSender.replaceTrack, no renegotiation; re-dials if
 * that fails), and removing the mic hangs up. Cost: up to 2*(N-1) RTCPeerConnections per player,
 * i.e. 6 audio-only connections at 4 players, which is fine.
 *
 * Failed/unanswered outgoing calls are retried with capped exponential backoff for as long as the
 * peer is in the roster. Calls from peers not (yet) in our roster are parked briefly, because the
 * host's roster update can arrive after the newcomer has already dialed us.
 *
 * onRemoteStream / onRemoteStreamEnded strictly alternate per peer: a second onRemoteStream for the
 * same peer is always preceded by onRemoteStreamEnded.
 */

import type { PlayerId } from '../core/types';
import type { VoiceLink } from './transport';

/** The subset of a PeerJS MediaConnection we use (lets tests use fakes). */
export interface VoiceCall {
  readonly peer: string;
  readonly open: boolean;
  readonly metadata?: unknown;
  readonly peerConnection?: RTCPeerConnection | null;
  on(event: 'stream', fn: (stream: MediaStream) => void): unknown;
  on(event: 'close', fn: () => void): unknown;
  on(event: 'error', fn: (err: unknown) => void): unknown;
  on(event: 'iceStateChanged', fn: (state: RTCIceConnectionState) => void): unknown;
  answer(stream?: MediaStream): void;
  close(): void;
}

/** The subset of a PeerJS Peer we use. */
export interface VoicePeer {
  call(peerId: string, stream: MediaStream, options?: { metadata?: unknown }): VoiceCall | undefined | void;
}

export interface VoiceTiming {
  /** Outgoing call not answered after this long -> hang up and retry. */
  answerTimeoutMs: number;
  /** How long a call from a peer that isn't in our roster yet is kept waiting. */
  pendingCallMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export const DEFAULT_VOICE_TIMING: VoiceTiming = {
  answerTimeoutMs: 15000,
  pendingCallMs: 6000,
  retryBaseMs: 1000,
  retryMaxMs: 15000,
};

export const VOICE_METADATA = { mute: 'voice' } as const;

interface Remote {
  id: PlayerId;
  /** Our mic -> them. */
  out: VoiceCall | null;
  answerTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  attempts: number;
  /** Their mic -> us. */
  incoming: VoiceCall | null;
  /** Stream we announced via onRemoteStream (and the call it came from). */
  stream: MediaStream | null;
  streamCall: VoiceCall | null;
}

function safeClose(call: VoiceCall | null | undefined): void {
  if (!call) return;
  try {
    call.close();
  } catch {
    // already gone
  }
}

export class PeerVoice implements VoiceLink {
  private local: MediaStream | null = null;
  private readonly remotes = new Map<PlayerId, Remote>();
  private readonly pending = new Map<PlayerId, { call: VoiceCall; timer: ReturnType<typeof setTimeout> }>();
  private readonly streamHandlers: ((peerId: PlayerId, stream: MediaStream) => void)[] = [];
  private readonly endedHandlers: ((peerId: PlayerId) => void)[] = [];
  private readonly timing: VoiceTiming;
  private disposed = false;

  constructor(
    private readonly peer: VoicePeer,
    private readonly selfId: PlayerId,
    timing: Partial<VoiceTiming> = {},
  ) {
    this.timing = { ...DEFAULT_VOICE_TIMING, ...timing };
  }

  // ---------------------------------------------------------------- VoiceLink

  setLocalStream(stream: MediaStream | null): void {
    if (this.disposed || stream === this.local) return;
    const previous = this.local;
    this.local = stream;
    for (const r of this.remotes.values()) {
      r.attempts = 0;
      if (!stream) this.hangUp(r);
      else if (r.out && previous) this.swapTrack(r, r.out, stream);
    }
    this.dialMissing();
  }

  onRemoteStream(handler: (peerId: PlayerId, stream: MediaStream) => void): void {
    this.streamHandlers.push(handler);
  }

  onRemoteStreamEnded(handler: (peerId: PlayerId) => void): void {
    this.endedHandlers.push(handler);
  }

  // ------------------------------------------------------------ fed by peer.ts

  /** Everyone in the room (may include us). Creates/closes calls to match. */
  setRoster(ids: readonly PlayerId[]): void {
    if (this.disposed) return;
    const members = new Set(ids.filter((id) => id !== this.selfId));
    for (const id of [...this.remotes.keys()]) if (!members.has(id)) this.dropRemote(id);
    for (const id of members) {
      if (!this.remotes.has(id)) {
        this.remotes.set(id, {
          id,
          out: null,
          answerTimer: null,
          retryTimer: null,
          attempts: 0,
          incoming: null,
          stream: null,
          streamCall: null,
        });
      }
      const parked = this.pending.get(id);
      if (parked) {
        this.pending.delete(id);
        clearTimeout(parked.timer);
        this.accept(parked.call);
      }
    }
    this.dialMissing();
  }

  /** PeerJS 'call' event. */
  handleCall(call: VoiceCall): void {
    const id = call.peer;
    if (this.disposed || id === this.selfId) {
      safeClose(call);
      return;
    }
    if (this.remotes.has(id)) {
      this.accept(call);
      return;
    }
    const prev = this.pending.get(id);
    if (prev) {
      clearTimeout(prev.timer);
      safeClose(prev.call);
    }
    const timer = setTimeout(() => {
      if (this.pending.get(id)?.call !== call) return;
      this.pending.delete(id);
      safeClose(call);
    }, this.timing.pendingCallMs);
    this.pending.set(id, { call, timer });
  }

  /** PeerJS reported that `peerId` isn't registered with the signaling server. */
  handlePeerUnavailable(peerId: PlayerId): void {
    const r = this.remotes.get(peerId);
    if (r?.out && !r.out.open) this.outEnded(r, r.out);
  }

  /** Peers whose voice we currently receive (debug/UI). */
  get hearing(): PlayerId[] {
    return [...this.remotes.values()].filter((r) => r.stream).map((r) => r.id);
  }

  /** Peers we currently have an outgoing call to (debug/UI). */
  get sendingTo(): PlayerId[] {
    return [...this.remotes.values()].filter((r) => r.out).map((r) => r.id);
  }

  dispose(): void {
    if (this.disposed) return;
    for (const id of [...this.remotes.keys()]) this.dropRemote(id);
    for (const { call, timer } of this.pending.values()) {
      clearTimeout(timer);
      safeClose(call);
    }
    this.pending.clear();
    this.local = null;
    this.disposed = true;
  }

  // ------------------------------------------------------------------ outgoing

  private dialMissing(): void {
    if (!this.local || this.disposed) return;
    for (const r of this.remotes.values()) if (!r.out && !r.retryTimer) this.dial(r);
  }

  private dial(r: Remote): void {
    const stream = this.local;
    if (!stream) return;
    let call: VoiceCall | null = null;
    try {
      call = this.peer.call(r.id, stream, { metadata: VOICE_METADATA }) || null;
    } catch (err) {
      console.warn('[net] voice call failed', err);
    }
    if (!call) {
      // Typically: we're momentarily disconnected from the signaling server.
      this.scheduleRetry(r);
      return;
    }
    const c = call;
    r.out = c;
    const end = (): void => this.outEnded(r, c);
    c.on('close', end);
    c.on('error', end);
    c.on('iceStateChanged', (state) => {
      if ((state === 'connected' || state === 'completed') && r.out === c) r.attempts = 0;
    });
    r.answerTimer = setTimeout(() => {
      r.answerTimer = null;
      if (r.out === c && !c.open) end();
    }, this.timing.answerTimeoutMs);
  }

  private outEnded(r: Remote, call: VoiceCall): void {
    if (r.out !== call) return;
    r.out = null;
    if (r.answerTimer) clearTimeout(r.answerTimer);
    r.answerTimer = null;
    safeClose(call);
    if (this.remotes.get(r.id) === r && this.local && !this.disposed) this.scheduleRetry(r);
  }

  private scheduleRetry(r: Remote): void {
    if (r.retryTimer || this.disposed) return;
    const delay = Math.min(this.timing.retryBaseMs * 2 ** r.attempts, this.timing.retryMaxMs);
    r.attempts++;
    r.retryTimer = setTimeout(() => {
      r.retryTimer = null;
      if (this.remotes.get(r.id) === r && this.local && !r.out && !this.disposed) this.dial(r);
    }, delay);
  }

  /** Close our outgoing call to `r` and cancel retries. */
  private hangUp(r: Remote): void {
    if (r.retryTimer) clearTimeout(r.retryTimer);
    if (r.answerTimer) clearTimeout(r.answerTimer);
    r.retryTimer = r.answerTimer = null;
    const call = r.out;
    r.out = null;
    safeClose(call);
  }

  /** New mic on an existing call: swap the track without renegotiating, or re-dial. */
  private swapTrack(r: Remote, call: VoiceCall, stream: MediaStream): void {
    const track = stream.getAudioTracks()[0];
    const sender = call.peerConnection
      ?.getSenders?.()
      .find((s) => s.track === null || s.track.kind === 'audio');
    const redial = (): void => {
      if (r.out !== call) return;
      this.hangUp(r);
      this.dialMissing();
    };
    if (!track || !sender) {
      redial();
      return;
    }
    sender.replaceTrack(track).catch(redial);
  }

  // ------------------------------------------------------------------ incoming

  private accept(call: VoiceCall): void {
    const r = this.remotes.get(call.peer);
    if (!r) {
      safeClose(call);
      return;
    }
    if (r.incoming && r.incoming !== call) {
      // They re-dialed (e.g. after a mic change): the newest call wins.
      const old = r.incoming;
      r.incoming = null;
      this.endStream(r, old);
      safeClose(old);
    }
    r.incoming = call;
    // Must be attached before answer(): PeerJS can emit 'stream' synchronously-ish from it.
    call.on('stream', (stream) => {
      if (this.remotes.get(r.id) !== r || r.incoming !== call) return;
      this.announce(r, call, stream);
    });
    const end = (): void => this.inEnded(r, call);
    call.on('close', end);
    call.on('error', end);
    try {
      // Receive-only: our own mic travels on our own outgoing call.
      call.answer();
    } catch (err) {
      console.warn('[net] answering voice call failed', err);
      end();
    }
  }

  private inEnded(r: Remote, call: VoiceCall): void {
    if (r.incoming !== call) return;
    r.incoming = null;
    this.endStream(r, call);
    safeClose(call);
  }

  private announce(r: Remote, call: VoiceCall, stream: MediaStream): void {
    // PeerJS fires 'stream' once per remote track (and sometimes twice for one): dedupe.
    if (r.stream === stream || (r.streamCall === call && r.stream?.id === stream.id)) return;
    if (r.stream) {
      r.stream = null;
      r.streamCall = null;
      this.emitEnded(r.id);
    }
    r.stream = stream;
    r.streamCall = call;
    for (const h of this.streamHandlers.slice()) {
      try {
        h(r.id, stream);
      } catch (err) {
        console.error('[net] onRemoteStream handler threw', err);
      }
    }
  }

  private endStream(r: Remote, call: VoiceCall): void {
    if (r.streamCall !== call || !r.stream) return;
    r.stream = null;
    r.streamCall = null;
    this.emitEnded(r.id);
  }

  private emitEnded(id: PlayerId): void {
    for (const h of this.endedHandlers.slice()) {
      try {
        h(id);
      } catch (err) {
        console.error('[net] onRemoteStreamEnded handler threw', err);
      }
    }
  }

  private dropRemote(id: PlayerId): void {
    const r = this.remotes.get(id);
    const parked = this.pending.get(id);
    if (parked) {
      this.pending.delete(id);
      clearTimeout(parked.timer);
      safeClose(parked.call);
    }
    if (!r) return;
    this.remotes.delete(id);
    this.hangUp(r);
    const incoming = r.incoming;
    r.incoming = null;
    safeClose(incoming);
    if (r.stream) {
      r.stream = null;
      r.streamCall = null;
      this.emitEnded(id);
    }
  }
}
