import { describe, expect, it } from 'vitest';
import { createLevel } from '../core/level';
import { GameSim } from '../core/sim';
import type { NetMessage } from './protocol';
import { DEFAULT_TIMING, MAX_CHUNKS, StarTransport, type Frame, type Link } from './star';

function hostWithClient() {
  const sent: Frame[] = [];
  const star = new StarTransport({
    selfId: 'h',
    hostId: 'h',
    isHost: true,
    roomCode: 'ABCDE',
    timing: DEFAULT_TIMING,
    dispose() {},
  });
  const link: Link = { send: (f) => sent.push(JSON.parse(JSON.stringify(f)) as Frame), close() {} };
  star.addLink('c', link);
  const got: NetMessage[] = [];
  star.onMessage((m) => got.push(m));
  return { star, link, sent, got };
}

function chunks(frame: Frame, n: number): Frame[] {
  const json = JSON.stringify(frame);
  const step = Math.ceil(json.length / n);
  const out: Frame[] = [];
  for (let i = 0; i < n; i++) out.push({ k: 'c', id: 7, i, n, d: json.slice(i * step, (i + 1) * step) });
  return out;
}

describe('StarTransport chunk reassembly vs hostile peers', () => {
  it('never assembles a frame of absurd size, but real snapshots fit with lots of room', () => {
    const { star, link, got, sent } = hostWithClient();
    // A full 4-player snapshot: how many chunks does it really need?
    const sim = new GameSim(createLevel(1));
    for (const id of ['a', 'b', 'c', 'd']) sim.addPlayer(id, id.repeat(16), true);
    sim.startRound();
    star.send({ t: 'snapshot', state: sim.snapshot() }, 'c');
    const snapshotChunks = sent.filter((f) => f.k === 'c').length || 1;
    expect(snapshotChunks * 20).toBeLessThan(MAX_CHUNKS);
    // ...while one assembly can never make us buffer more than a couple of MB.
    expect(MAX_CHUNKS * DEFAULT_TIMING.maxFrameBytes).toBeLessThanOrEqual(2 * 1024 * 1024 + 1e5);

    // A peer announcing a frame of thousands of chunks (tens of MB to buffer and parse) is ignored.
    const bomb = chunks({ k: 'm', m: { t: 'voice', level: 0.5 } } as Frame, MAX_CHUNKS + 1);
    for (const c of bomb) star.receive('c', c, link);
    expect(got).toEqual([]);
    // Within the cap still works.
    for (const c of chunks({ k: 'm', m: { t: 'voice', level: 0.25 } } as Frame, 3)) star.receive('c', c, link);
    expect(got).toEqual([{ t: 'voice', level: 0.25 }]);
    // Oversized single chunks (a modified client isn't bound by PeerJS' 16 KB send limit) are dropped.
    const fat = JSON.stringify({ k: 'm', m: { t: 'hello', version: 1, name: 'x'.repeat(DEFAULT_TIMING.maxFrameBytes * 2), isDesktop: true } });
    const half = Math.ceil(fat.length / 2);
    star.receive('c', { k: 'c', id: 9, i: 0, n: 2, d: fat.slice(0, half) }, link);
    star.receive('c', { k: 'c', id: 9, i: 1, n: 2, d: fat.slice(half) }, link);
    expect(got).toHaveLength(1);
    star.close();
  });
});
