import { describe, expect, it } from 'vitest';
import { PeerVoice, type VoiceCall, type VoicePeer } from './voice';

/** In-memory stand-ins for PeerJS Peer/MediaConnection (no WebRTC in Node). */
type Handler = (...args: never[]) => void;

class FakeCall implements VoiceCall {
  open = false;
  closed = false;
  other: FakeCall | null = null;
  answeredWith: MediaStream | undefined | null = null;
  private handlers = new Map<string, Handler[]>();

  constructor(
    readonly peer: string,
    private readonly sending: MediaStream | null,
    readonly metadata?: unknown,
  ) {}

  on(event: string, fn: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.handlers.get(event) ?? []) (fn as (...a: unknown[]) => void)(...args);
  }

  answer(stream?: MediaStream): void {
    this.answeredWith = stream;
    this.open = true;
    const caller = this.other!;
    caller.open = true;
    // PeerJS fires 'stream' per track, sometimes twice: make sure that is deduped.
    const s = caller.sending!;
    this.emit('stream', s);
    this.emit('stream', s);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const wasOpen = this.open;
    this.open = false;
    if (wasOpen) this.emit('close');
    this.other?.close();
  }
}

class FakeNet {
  peers = new Map<string, FakePeer>();
  /** Calls to these ids hang forever (never answered). */
  blackhole = new Set<string>();
  add(id: string): FakePeer {
    const p = new FakePeer(id, this);
    this.peers.set(id, p);
    return p;
  }
}

class FakePeer implements VoicePeer {
  voice: PeerVoice;
  calls: FakeCall[] = [];
  constructor(
    readonly id: string,
    private readonly net: FakeNet,
  ) {
    this.voice = new PeerVoice(this, id, { answerTimeoutMs: 60, retryBaseMs: 10, retryMaxMs: 40, pendingCallMs: 200 });
  }
  call(peerId: string, stream: MediaStream, options?: { metadata?: unknown }): VoiceCall {
    const local = new FakeCall(peerId, stream, options?.metadata);
    this.calls.push(local);
    const target = this.net.peers.get(peerId);
    if (target && !this.net.blackhole.has(peerId)) {
      const remote = new FakeCall(this.id, null, options?.metadata);
      local.other = remote;
      remote.other = local;
      queueMicrotask(() => target.voice.handleCall(remote));
    }
    return local;
  }
}

function fakeStream(id: string): MediaStream {
  return { id, getAudioTracks: () => [] } as unknown as MediaStream;
}

/** Records the stream/ended events a voice emits, and what it currently hears. */
function listen(v: PeerVoice): { log: string[]; hearing: Map<string, string> } {
  const log: string[] = [];
  const hearing = new Map<string, string>();
  v.onRemoteStream((id, s) => {
    expect(hearing.has(id)).toBe(false); // strict stream/ended alternation
    hearing.set(id, s.id);
    log.push(`+${id}:${s.id}`);
  });
  v.onRemoteStreamEnded((id) => {
    expect(hearing.has(id)).toBe(true);
    hearing.delete(id);
    log.push(`-${id}`);
  });
  return { log, hearing };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await tick(2);
  }
}

describe('PeerVoice mesh', () => {
  it('one-way calls: everyone with a mic is heard by everyone else', async () => {
    const net = new FakeNet();
    const [a, b, c] = ['A', 'B', 'C'].map((id) => net.add(id));
    const [la, lb, lc] = [a, b, c].map((p) => listen(p.voice));
    for (const p of [a, b, c]) p.voice.setRoster(['A', 'B', 'C']);

    a.voice.setLocalStream(fakeStream('micA'));
    await until(() => lb.hearing.get('A') === 'micA' && lc.hearing.get('A') === 'micA');
    expect(lb.log).toEqual(['+A:micA']); // deduped
    expect(la.hearing.size).toBe(0);

    // B gets a mic later: it simply starts dialing.
    b.voice.setLocalStream(fakeStream('micB'));
    await until(() => la.hearing.get('B') === 'micB' && lc.hearing.get('B') === 'micB');
    // C never has a mic: nobody hears C, C hears both.
    expect([...lc.hearing.keys()].sort()).toEqual(['A', 'B']);
    expect(la.hearing.has('C')).toBe(false);
    // Incoming calls are answered receive-only.
    expect(b.calls.every((call) => call.other?.answeredWith === undefined)).toBe(true);
    expect(a.voice.sendingTo.sort()).toEqual(['B', 'C']);
    expect(c.voice.sendingTo).toEqual([]);
  });

  it('mic change re-sends, mic removal hangs up', async () => {
    const net = new FakeNet();
    const [a, b] = ['A', 'B'].map((id) => net.add(id));
    const lb = listen(b.voice);
    a.voice.setRoster(['A', 'B']);
    b.voice.setRoster(['A', 'B']);
    a.voice.setLocalStream(fakeStream('mic1'));
    await until(() => lb.hearing.get('A') === 'mic1');

    a.voice.setLocalStream(fakeStream('mic2')); // no RTCPeerConnection in fakes -> re-dial
    await until(() => lb.hearing.get('A') === 'mic2');
    expect(lb.log).toEqual(['+A:mic1', '-A', '+A:mic2']);

    a.voice.setLocalStream(null);
    await until(() => !lb.hearing.has('A'));
    await tick(30);
    expect(a.calls.filter((c) => !c.closed)).toHaveLength(0);
  });

  it('roster changes open and close calls', async () => {
    const net = new FakeNet();
    const [a, b, c] = ['A', 'B', 'C'].map((id) => net.add(id));
    const [la, lb] = [a, b].map((p) => listen(p.voice));
    for (const p of [a, b, c]) p.voice.setLocalStream(fakeStream('mic' + p.id));
    a.voice.setRoster(['A', 'B']);
    b.voice.setRoster(['A', 'B']);
    await until(() => la.hearing.has('B') && lb.hearing.has('A'));

    // C joins.
    for (const p of [a, b, c]) p.voice.setRoster(['A', 'B', 'C']);
    await until(() => la.hearing.has('C') && lb.hearing.has('C'));

    // C leaves: the others close everything with C.
    a.voice.setRoster(['A', 'B']);
    b.voice.setRoster(['A', 'B']);
    c.voice.dispose();
    await until(() => !la.hearing.has('C') && !lb.hearing.has('C'));
    await tick(80);
    expect(a.voice.sendingTo).toEqual(['B']);
    expect(la.hearing.has('B')).toBe(true);
  });

  it('parks calls from peers that are not in the roster yet', async () => {
    const net = new FakeNet();
    const [a, b] = ['A', 'B'].map((id) => net.add(id));
    const lb = listen(b.voice);
    b.voice.setRoster(['B']); // B hasn't heard about A yet
    a.voice.setRoster(['A', 'B']);
    a.voice.setLocalStream(fakeStream('micA'));
    await tick(20);
    expect(lb.hearing.size).toBe(0);
    b.voice.setRoster(['A', 'B']); // roster catches up
    await until(() => lb.hearing.get('A') === 'micA');
  });

  it('retries unanswered calls and cleans up on dispose', async () => {
    const net = new FakeNet();
    const [a, b] = ['A', 'B'].map((id) => net.add(id));
    const lb = listen(b.voice);
    net.blackhole.add('B');
    a.voice.setRoster(['A', 'B']);
    b.voice.setRoster(['A', 'B']);
    a.voice.setLocalStream(fakeStream('micA'));
    await until(() => a.calls.length >= 2, 1000); // first call timed out, re-dialed
    net.blackhole.delete('B');
    await until(() => lb.hearing.get('A') === 'micA', 1000);

    b.voice.dispose();
    expect(lb.hearing.size).toBe(0);
    expect(lb.log.at(-1)).toBe('-A');
    a.voice.dispose();
    const before = a.calls.length;
    await tick(100);
    expect(a.calls.length).toBe(before);
  });
});
