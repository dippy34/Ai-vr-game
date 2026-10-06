import { afterEach, describe, expect, it } from 'vitest';
import { NET } from '../config';
import { hostRoom, isRoomTransport, isValidRoomCode, joinRoom, normalizeRoomCode, randomRoomCode, type NetOptions, type RoomTransport } from './index';
import type { NetMessage } from './protocol';
import type { Transport } from './transport';

const FAST: NetOptions = { pingIntervalMs: 40, peerTimeoutMs: 250, joinTimeoutMs: 300, joinGraceMs: 0 };

const open: Transport[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

async function host(): Promise<RoomTransport> {
  const t = await hostRoom('local', FAST);
  open.push(t);
  if (!isRoomTransport(t)) throw new Error('expected a RoomTransport');
  return t;
}

async function join(code: string): Promise<RoomTransport> {
  const t = await joinRoom('local', code, FAST);
  open.push(t);
  if (!isRoomTransport(t)) throw new Error('expected a RoomTransport');
  return t;
}

/** Resolves when `pred` becomes true (polls), rejects after `ms`. */
async function until(pred: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function inbox(t: Transport): { msg: NetMessage; from: string }[] {
  const got: { msg: NetMessage; from: string }[] = [];
  t.onMessage((msg, from) => got.push({ msg, from }));
  return got;
}

describe('room codes', () => {
  it('normalizes user input', () => {
    expect(normalizeRoomCode('  k7q-xm ')).toBe('K7QXM');
    expect(normalizeRoomCode('k 7 q x m')).toBe('K7QXM');
    expect(normalizeRoomCode('K7Q–XM')).toBe('K7QXM');
    expect(normalizeRoomCode('')).toBe('');
  });

  it('generates valid random codes', () => {
    for (let i = 0; i < 200; i++) {
      const code = randomRoomCode();
      expect(code).toHaveLength(NET.codeLength);
      expect(isValidRoomCode(code)).toBe(true);
    }
    expect(isValidRoomCode('K7QX0')).toBe(false); // 0 isn't in the alphabet
    expect(isValidRoomCode('K7QX')).toBe(false);
  });
});

describe("'local' transport", () => {
  it('connects a host and two clients and keeps the roster in sync', async () => {
    const h = await host();
    expect(h.isHost).toBe(true);
    expect(h.selfId).toBe(NET.idPrefix + h.roomCode);
    expect(h.voice).toBeNull();
    const joined: string[] = [];
    h.onPeerJoin((id) => joined.push(id));

    const a = await join(h.roomCode.toLowerCase());
    const b = await join(h.roomCode);
    expect(a.isHost).toBe(false);
    expect(a.roomCode).toBe(h.roomCode);
    expect(a.selfId).not.toBe(b.selfId);

    await until(() => joined.length === 2);
    expect(joined).toEqual([a.selfId, b.selfId]);
    const expected = [h.selfId, a.selfId, b.selfId];
    await until(() => a.roster.length === 3 && b.roster.length === 3);
    expect(h.roster).toEqual(expected);
    expect(a.roster).toEqual(expected);
    expect(b.roster).toEqual(expected);
  });

  it('routes messages: client -> host, host broadcast, host -> one client', async () => {
    const h = await host();
    const a = await join(h.roomCode);
    const b = await join(h.roomCode);
    const hIn = inbox(h);
    const aIn = inbox(a);
    const bIn = inbox(b);
    await until(() => h.roster.length === 3);

    a.send({ t: 'voice', level: 0.5 });
    b.send({ t: 'voice', level: 0.25 }, 'ignored-for-clients');
    await until(() => hIn.length === 2);
    expect(hIn).toContainEqual({ msg: { t: 'voice', level: 0.5 }, from: a.selfId });
    expect(hIn).toContainEqual({ msg: { t: 'voice', level: 0.25 }, from: b.selfId });

    h.send({ t: 'reject', reason: 'everyone' });
    await until(() => aIn.length === 1 && bIn.length === 1);
    expect(aIn[0]).toEqual({ msg: { t: 'reject', reason: 'everyone' }, from: h.selfId });
    expect(bIn[0]).toEqual({ msg: { t: 'reject', reason: 'everyone' }, from: h.selfId });

    h.send({ t: 'reject', reason: 'just a' }, a.selfId);
    await until(() => aIn.length === 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(aIn[1].msg).toEqual({ t: 'reject', reason: 'just a' });
    expect(bIn).toHaveLength(1);
  });

  it('delivers messages received before a handler was registered', async () => {
    const h = await host();
    h.onPeerJoin((id) => h.send({ t: 'reject', reason: 'early' }, id));
    const a = await join(h.roomCode);
    await new Promise((r) => setTimeout(r, 30)); // message arrives with no handler yet
    const got = inbox(a);
    await until(() => got.length === 1);
    expect(got[0].msg).toEqual({ t: 'reject', reason: 'early' });
  });

  it('chunks and reassembles messages bigger than the channel limit', async () => {
    const h = await host();
    const a = await join(h.roomCode);
    const hIn = inbox(h);
    const aIn = inbox(a);
    const big = 'x"\\é漢😀'.repeat(20000); // ~140k chars, escapes + multi-byte + surrogate pairs
    h.send({ t: 'reject', reason: big });
    a.send({ t: 'hello', version: 1, name: big, isDesktop: true });
    await until(() => aIn.length === 1 && hIn.length === 1);
    expect(aIn[0].msg).toEqual({ t: 'reject', reason: big });
    expect(hIn[0].msg).toEqual({ t: 'hello', version: 1, name: big, isDesktop: true });
  });

  it('detects a client that leaves with close()', async () => {
    const h = await host();
    const a = await join(h.roomCode);
    const b = await join(h.roomCode);
    const left: string[] = [];
    h.onPeerLeave((id) => left.push(id));
    await until(() => b.roster.length === 3);

    a.close();
    expect(a.closed).toBe(true);
    await until(() => left.length === 1, 100); // via the goodbye frame, well before the timeout
    expect(left).toEqual([a.selfId]);
    expect(h.roster).toEqual([h.selfId, b.selfId]);
    await until(() => b.roster.length === 2);
    expect(b.roster).toEqual([h.selfId, b.selfId]);
  });

  it('drops a client that goes silent (keepalive timeout)', async () => {
    const h = await host();
    const left: string[] = [];
    h.onPeerLeave((id) => left.push(id));
    // A "client" that joins and then crashes: it never sends keepalives.
    const ch = new BroadcastChannel('mute-vr-local-' + h.roomCode);
    try {
      ch.postMessage({ c: 'join', f: 'ghost', to: h.selfId });
      await until(() => h.roster.includes('ghost'));
      await until(() => left.length === 1, 1000);
      expect(left).toEqual(['ghost']);
      expect(h.roster).toEqual([h.selfId]);
    } finally {
      ch.close();
    }
  });

  it('gives a freshly joined client a grace period while it loads the level', async () => {
    const h = (await hostRoom('local', { ...FAST, joinGraceMs: 700 })) as RoomTransport;
    const left: string[] = [];
    h.onPeerLeave((id) => left.push(id));
    const ch = new BroadcastChannel('mute-vr-local-' + h.roomCode);
    try {
      ch.postMessage({ c: 'join', f: 'loader', to: h.selfId });
      await until(() => h.roster.includes('loader'));
      // Silent for longer than peerTimeoutMs (250) but within the grace: still in the room.
      await new Promise((r) => setTimeout(r, 450));
      expect(left).toEqual([]);
      // ...but a client that never speaks up is dropped once the grace is over.
      await until(() => left.length === 1, 1500);
      expect(left).toEqual(['loader']);
    } finally {
      ch.close();
      h.close();
    }
  });

  it('tells clients when the host goes away', async () => {
    const h = await host();
    const a = await join(h.roomCode);
    const left: string[] = [];
    a.onPeerLeave((id) => left.push(id));
    h.close();
    await until(() => left.length === 1, 100);
    expect(left).toEqual([h.selfId]);
    expect(a.closed).toBe(true);
    expect(a.roster).toEqual([]);
  });

  it('rejects joining a room nobody hosts', async () => {
    const code = randomRoomCode();
    const t0 = Date.now();
    await expect(joinRoom('local', code, FAST)).rejects.toThrow(`No room with code ${code}`);
    expect(Date.now() - t0).toBeLessThan(1000);
    await expect(joinRoom('local', 'nope!', FAST)).rejects.toThrow(/No room with code/);
    await expect(joinRoom('local', '   ', FAST)).rejects.toThrow(/room code/);
  });
});
