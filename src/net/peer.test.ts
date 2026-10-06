/**
 * The 'peerjs' transport against an in-memory fake of the PeerJS API (no network, no WebRTC):
 * checks the wiring in peer.ts (error mapping, code retry, data path, voice call hookup).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NET } from '../config';
import type { NetMessage } from './protocol';
import type { Transport } from './transport';

const fake = vi.hoisted(() => {
  type Fn = (...args: unknown[]) => void;
  class Emitter {
    private handlers = new Map<string, Fn[]>();
    on(event: string, fn: Fn): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      return this;
    }
    off(event: string, fn: Fn): this {
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter((f) => f !== fn));
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
  }
  const later = (fn: () => void): void => void setTimeout(fn, 1);
  const peerError = (type: string, msg: string): Error => Object.assign(new Error(msg), { type });

  class FakeConn extends Emitter {
    open = false;
    closed = false;
    other: FakeConn | null = null;
    constructor(
      readonly peer: string,
      readonly metadata?: unknown,
      readonly localStream?: unknown,
    ) {
      super();
    }
    send(data: unknown): void {
      const json = JSON.stringify(data);
      if (new TextEncoder().encode(json).byteLength >= 16300) {
        this.emit('error', peerError('message-too-big', 'Message too big for JSON channel'));
        return;
      }
      const copy: unknown = JSON.parse(json);
      later(() => this.other?.open && this.other.emit('data', copy));
    }
    answer(): void {
      this.open = true;
      const caller = this.other!;
      caller.open = true;
      later(() => this.emit('stream', caller.localStream));
    }
    close(): void {
      if (this.closed) return;
      this.closed = true;
      const wasOpen = this.open;
      this.open = false;
      if (wasOpen) this.emit('close');
      later(() => this.other?.close());
    }
  }

  class FakePeer extends Emitter {
    static registry = new Map<string, FakePeer>();
    /** Error types the next Peer constructions fail with (one per construction). */
    static failNext: string[] = [];
    static created: FakePeer[] = [];
    id: string;
    open = false;
    destroyed = false;
    disconnected = false;
    conns: FakeConn[] = [];
    constructor(idOrOptions?: unknown) {
      super();
      FakePeer.created.push(this);
      this.id = typeof idOrOptions === 'string' ? idOrOptions : 'rnd' + Math.random().toString(36).slice(2, 10);
      later(() => {
        const failure = FakePeer.failNext.shift();
        if (failure || FakePeer.registry.has(this.id)) {
          this.emit('error', peerError(failure ?? 'unavailable-id', `ID "${this.id}" is taken`));
          this.destroy();
          return;
        }
        FakePeer.registry.set(this.id, this);
        this.open = true;
        this.emit('open', this.id);
      });
    }
    private dial(target: string, make: (from: string) => FakeConn, event: 'connection' | 'call', local: FakeConn): void {
      this.conns.push(local);
      later(() => {
        const remotePeer = FakePeer.registry.get(target);
        if (!remotePeer) {
          this.emit('error', peerError('peer-unavailable', `Could not connect to peer ${target}`));
          return;
        }
        const remote = make(this.id);
        remote.other = local;
        local.other = remote;
        remotePeer.conns.push(remote);
        remotePeer.emit(event, remote);
        if (event === 'connection') {
          later(() => {
            local.open = remote.open = true;
            remote.emit('open');
            local.emit('open');
          });
        }
      });
    }
    connect(target: string, options?: { metadata?: unknown }): FakeConn {
      const local = new FakeConn(target, options?.metadata);
      this.dial(target, (from) => new FakeConn(from, options?.metadata), 'connection', local);
      return local;
    }
    call(target: string, stream: unknown, options?: { metadata?: unknown }): FakeConn {
      const local = new FakeConn(target, options?.metadata, stream);
      this.dial(target, (from) => new FakeConn(from, options?.metadata), 'call', local);
      return local;
    }
    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      if (FakePeer.registry.get(this.id) === this) FakePeer.registry.delete(this.id);
      for (const c of this.conns) c.close();
      this.emit('close');
    }
    reconnect(): void {}
  }
  return { FakePeer };
});

vi.mock('peerjs', () => ({ Peer: fake.FakePeer, default: fake.FakePeer }));

const { hostRoom, joinRoom } = await import('./index');

const FAST = { pingIntervalMs: 40, peerTimeoutMs: 400, joinTimeoutMs: 500, signalingTimeoutMs: 500, joinGraceMs: 0 };
const open: Transport[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
  fake.FakePeer.failNext = [];
});

async function until(pred: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("'peerjs' transport (fake PeerJS)", () => {
  it('hosts, lets clients join and routes messages', async () => {
    const h = await hostRoom('peerjs', FAST);
    open.push(h);
    expect(h.selfId).toBe(NET.idPrefix + h.roomCode);
    expect(h.voice).not.toBeNull();
    const joined: string[] = [];
    const hostIn: { msg: NetMessage; from: string }[] = [];
    h.onPeerJoin((id) => joined.push(id));
    h.onMessage((msg, from) => hostIn.push({ msg, from }));

    const a = await joinRoom('peerjs', ` ${h.roomCode.toLowerCase()} `, FAST);
    open.push(a);
    const aIn: NetMessage[] = [];
    a.onMessage((msg) => aIn.push(msg));
    await until(() => joined.length === 1);
    expect(joined).toEqual([a.selfId]);

    a.send({ t: 'voice', level: 0.3 });
    const big = 'é"'.repeat(30000); // over PeerJS' 16 KB JSON limit -> must be chunked
    h.send({ t: 'reject', reason: big });
    await until(() => hostIn.length === 1 && aIn.length === 1);
    expect(hostIn[0]).toEqual({ msg: { t: 'voice', level: 0.3 }, from: a.selfId });
    expect(aIn[0]).toEqual({ t: 'reject', reason: big });

    const left: string[] = [];
    a.onPeerLeave((id) => left.push(id));
    h.close();
    await until(() => left.length === 1);
    expect(left).toEqual([h.selfId]);
  });

  it('retries with a fresh code when the room id is taken', async () => {
    fake.FakePeer.failNext = ['unavailable-id', 'unavailable-id'];
    const before = fake.FakePeer.created.length;
    const h = await hostRoom('peerjs', FAST);
    open.push(h);
    expect(fake.FakePeer.created.length - before).toBe(3);
  });

  it('rejects with readable errors', async () => {
    await expect(joinRoom('peerjs', 'ZZZZZ', FAST)).rejects.toThrow('No room with code ZZZZZ');
    fake.FakePeer.failNext = ['network'];
    await expect(hostRoom('peerjs', FAST)).rejects.toThrow("Couldn't reach the matchmaking server");
    fake.FakePeer.failNext = ['server-error'];
    await expect(joinRoom('peerjs', 'ZZZZZ', FAST)).rejects.toThrow("Couldn't reach the matchmaking server");
  });

  it('wires voice calls through the PeerJS peer', async () => {
    const h = await hostRoom('peerjs', FAST);
    open.push(h);
    const a = await joinRoom('peerjs', h.roomCode, FAST);
    open.push(a);
    const heard: [string, unknown][] = [];
    const ended: string[] = [];
    a.voice!.onRemoteStream((id, s) => heard.push([id, s]));
    a.voice!.onRemoteStreamEnded((id) => ended.push(id));
    const mic = { id: 'hostMic', getAudioTracks: () => [] } as unknown as MediaStream;
    h.voice!.setLocalStream(mic);
    await until(() => heard.length === 1);
    expect(heard[0]).toEqual([h.selfId, mic]);
    h.voice!.setLocalStream(null);
    await until(() => ended.length === 1);
    expect(ended).toEqual([h.selfId]);
  });
});
