/**
 * Session layer: the network boundary. HostSession must survive hostile / flooding clients;
 * ClientSession must survive a hostile host; and real game flows (mid-round join, leaving with
 * the camera, the host leaving) must end cleanly. Uses a fake Transport for exact message
 * accounting and the real 'local' BroadcastChannel transport for end-to-end flows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAME, NET } from '../config';
import { dist3, isFiniteVec3, v3 } from '../core/math';
import { GameSim, makeSpawnPose } from '../core/sim';
import type { PlayerId, PlayerPose, SimEvent, WorldState } from '../core/types';
import { LIMITS } from '../core/validate';
import { hostRoom } from '../net';
import { PROTOCOL_VERSION, type LobbyPlayer, type NetMessage } from '../net/protocol';
import type { Transport } from '../net/transport';
import { ClientSession, HostSession, type SessionCallbacks } from './session';

class FakeTransport implements Transport {
  readonly selfId = 'host';
  readonly isHost = true;
  readonly roomCode = 'ABCDE';
  readonly voice = null;
  sent: { msg: NetMessage; to?: PlayerId }[] = [];
  private onMsg: ((msg: NetMessage, from: PlayerId) => void)[] = [];
  private onLeave: ((id: PlayerId) => void)[] = [];
  send(msg: NetMessage, to?: PlayerId): void {
    this.sent.push({ msg: JSON.parse(JSON.stringify(msg)) as NetMessage, to });
  }
  onMessage(h: (msg: NetMessage, from: PlayerId) => void): void {
    this.onMsg.push(h);
  }
  onPeerJoin(): void {}
  onPeerLeave(h: (id: PlayerId) => void): void {
    this.onLeave.push(h);
  }
  close(): void {}
  /** A message from a client, as it would come off the wire (JSON round trip). */
  deliver(msg: unknown, from: PlayerId): void {
    for (const h of this.onMsg) h(JSON.parse(JSON.stringify(msg)) as NetMessage, from);
  }
  leave(id: PlayerId): void {
    for (const h of this.onLeave) h(id);
  }
  take(t: NetMessage['t'], to?: PlayerId): NetMessage[] {
    const out = this.sent.filter((s) => s.msg.t === t && (to === undefined || s.to === to)).map((s) => s.msg);
    this.sent = this.sent.filter((s) => !(s.msg.t === t && (to === undefined || s.to === to)));
    return out;
  }
}

function hostWith(clients: PlayerId[], clock = { t: 0 }) {
  const tr = new FakeTransport();
  const host = new HostSession(tr, 'Host', true, { now: () => clock.t });
  for (const id of clients) tr.deliver({ t: 'hello', version: PROTOCOL_VERSION, name: id, isDesktop: true }, id);
  tr.sent = [];
  return { tr, host, clock };
}

const finiteDeep = (x: unknown): boolean => {
  if (typeof x === 'number') return Number.isFinite(x);
  if (Array.isArray(x)) return x.every(finiteDeep);
  if (x && typeof x === 'object') return Object.values(x).every(finiteDeep);
  return true;
};

function spawnPoseOf(host: HostSession, id: PlayerId): PlayerPose {
  const p = host.state.players[id];
  return makeSpawnPose(p.spawn, p.spawnYaw);
}

afterEach(() => vi.restoreAllMocks());

describe('HostSession vs hostile clients', () => {
  it('relays the sanitized pose, never the raw one', () => {
    const { tr, host } = hostWith(['a', 'b']);
    const remote: [PlayerId, PlayerPose][] = [];
    host.callbacks = { ...noop(), onRemotePose: (id, pose) => remote.push([id, pose]) };
    const bad = spawnPoseOf(host, 'a') as unknown as Record<string, Record<string, unknown>>;
    bad.right.position = { x: 'boom', y: {}, z: [] };
    bad.left.curls = 'fist';
    tr.deliver({ t: 'pose', pose: bad }, 'a');
    const relayed = tr.take('peerPose', 'b');
    expect(relayed).toHaveLength(1);
    expect(finiteDeep(relayed[0])).toBe(true);
    expect(relayed[0].t === 'peerPose' && relayed[0].pose.left.curls).toHaveLength(5);
    expect(tr.take('peerPose', 'a')).toHaveLength(0); // never echoed back
    expect(remote).toHaveLength(1);
    expect(finiteDeep(remote[0][1])).toBe(true);
  });

  it('rate-limits floods of poses, actions, voice and noise', () => {
    const { tr, host, clock } = hostWith(['a', 'b']);
    const handle = vi.spyOn(GameSim.prototype, 'handleAction');
    const noise = vi.spyOn(GameSim.prototype, 'reportNoise');
    host.startRound();
    tr.sent = [];
    const pose = spawnPoseOf(host, 'a');
    for (let i = 0; i < 1000; i++) {
      tr.deliver({ t: 'pose', pose }, 'a');
      tr.deliver({ t: 'action', action: { type: 'grab', hand: 'left', position: pose.left.position, reach: 0.35 } }, 'a');
      tr.deliver({ t: 'voice', level: 0.01 }, 'a');
      tr.deliver({ t: 'noise', noise: { source: 'footstep', position: pose.head.position, loudness: 0.01, playerId: 'a' } }, 'a');
    }
    const poses = tr.take('peerPose', 'b').length;
    expect(poses).toBeGreaterThan(0);
    expect(poses).toBeLessThanOrEqual(NET.poseRate * 2);
    expect(handle.mock.calls.length).toBeGreaterThan(0);
    expect(handle.mock.calls.length).toBeLessThanOrEqual(20);
    expect(noise.mock.calls.length).toBeGreaterThan(0);
    expect(noise.mock.calls.length).toBeLessThanOrEqual(40);

    // Legit rates always get through: 20 poses/s for 10 s, with jitter.
    clock.t += 5;
    for (let i = 0; i < 200; i++) {
      clock.t += 0.05 + (i % 2 ? 0.01 : -0.01);
      tr.deliver({ t: 'pose', pose }, 'a');
      tr.deliver({ t: 'voice', level: 0.01 }, 'a');
    }
    expect(tr.take('peerPose', 'b')).toHaveLength(200);
  });

  it("relays the host's own pose at NET.poseRate, not at the frame rate", () => {
    const { tr, host } = hostWith(['a']);
    const pose = spawnPoseOf(host, 'host');
    for (let f = 0; f < 90; f++) {
      host.sendPose(pose);
      host.update(1 / 90);
    }
    const n = tr.take('peerPose', 'a').length;
    expect(n).toBeGreaterThanOrEqual(NET.poseRate - 2);
    expect(n).toBeLessThanOrEqual(NET.poseRate + 1);
  });

  it('keeps reported noises next to the player who made them', () => {
    const { tr, host } = hostWith(['a']);
    const noise = vi.spyOn(GameSim.prototype, 'reportNoise');
    host.startRound();
    const head = host.state.players.a.pose.head.position;
    tr.deliver({ t: 'noise', noise: { source: 'footstep', position: v3(-10, 0, -7), loudness: 5, playerId: 'host' } }, 'a');
    tr.deliver({ t: 'noise', noise: null }, 'a');
    tr.deliver({ t: 'noise', noise: { source: 'voice', position: head, loudness: 1 } }, 'a');
    tr.deliver({ t: 'noise', noise: { source: 'footstep', position: { x: 'x' }, loudness: 1 } }, 'a');
    expect(noise).toHaveBeenCalledTimes(1);
    const n = noise.mock.calls[0][0];
    expect(n.playerId).toBe('a');
    expect(n.loudness).toBe(1);
    expect(dist3(n.position, head)).toBeLessThanOrEqual(LIMITS.noiseReach + 1e-9);
  });

  it('survives garbage hello / host-only messages and caps names', () => {
    const { tr, host } = hostWith([]);
    const before = JSON.stringify(host.state);
    const junk: unknown[] = [
      { t: 'snapshot', state: { phase: 'won' } },
      { t: 'round', state: null },
      { t: 'welcome', playerId: 'x', state: {} },
      { t: 'lobby', players: 5 },
      { t: 'pose', pose: makeSpawnPose(v3(), 0) }, // before hello
      { t: 'action', action: { type: 'grab' } },
      { t: 'hello' },
    ];
    for (const m of junk) expect(() => tr.deliver(m, 'evil')).not.toThrow();
    // 'hello' without a version is a version mismatch, not a player.
    expect(Object.keys(host.state.players)).toEqual(['host']);
    expect(JSON.stringify(host.state)).toBe(before);

    tr.deliver({ t: 'hello', version: PROTOCOL_VERSION, name: 'Z'.repeat(100_000), isDesktop: 'yes' }, 'long');
    tr.deliver({ t: 'hello', version: PROTOCOL_VERSION, name: { evil: true }, isDesktop: false }, 'obj');
    expect(host.state.players.long.name).toBe('Z'.repeat(16));
    expect(host.state.players.long.isDesktop).toBe(true);
    expect(host.state.players.obj.name).toBe('Survivor');

    // Peer ids that collide with Object.prototype members are strangers, not players.
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(() => tr.deliver({ t: 'pose', pose: makeSpawnPose(v3(), 0) }, id)).not.toThrow();
      expect(() => tr.deliver({ t: 'action', action: { type: 'grab', hand: 'left', position: v3(), reach: 1 } }, id)).not.toThrow();
    }
    expect(({} as Record<string, unknown>).pose).toBeUndefined();
    expect((Object as unknown as Record<string, unknown>).pose).toBeUndefined();
    tr.deliver({ t: 'hello', version: PROTOCOL_VERSION, name: 'Ctor', isDesktop: true }, 'constructor');
    expect(Object.prototype.hasOwnProperty.call(host.state.players, 'constructor')).toBe(true);
    expect(host.state.players.constructor).toMatchObject({ name: 'Ctor', status: 'alive' });
  });

  it('a client leaving with the camera drops it, and the others hear about it', () => {
    const { tr, host } = hostWith(['a', 'b']);
    host.startRound();
    const cam = host.state.camera.position;
    const pose = makeSpawnPose(v3(cam.x + 0.6, 0, cam.z), Math.PI / 2);
    pose.right.position = v3(cam.x, cam.y + 0.05, cam.z);
    tr.deliver({ t: 'pose', pose }, 'a');
    tr.deliver({ t: 'action', action: { type: 'grab', hand: 'right', position: pose.right.position, reach: 0.35 } }, 'a');
    expect(host.state.camera.holder).toBe('a');
    tr.sent = [];
    tr.leave('a');
    expect(host.state.camera.holder).toBeNull();
    expect(host.state.players.a).toBeUndefined();
    const events = tr.take('event').map((m) => (m.t === 'event' ? m.event : null));
    expect(events).toContainEqual(expect.objectContaining({ type: 'drop', by: 'a', what: 'camera' }));
    const lobby = tr.take('lobby');
    expect(lobby).toHaveLength(1);
    expect(lobby[0].t === 'lobby' && lobby[0].players.map((p) => p.id)).toEqual(['host', 'b']);
  });
});

// ---------------------------------------------------------------------------------------------

function noop(): SessionCallbacks {
  return { onEvent() {}, onRemotePose() {}, onRound() {}, onLobby() {}, onDisconnected() {} };
}

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const open: { close(): void }[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

describe('ClientSession vs a hostile host', () => {
  it('ignores garbage snapshots, poses, events and lobbies', async () => {
    const t = await hostRoom('local');
    open.push(t);
    const sim = new GameSim((await import('../core/level')).createLevel(7));
    sim.addPlayer(t.selfId, 'Host', true);
    let clientId = '';
    t.onMessage((msg, from) => {
      if (msg.t !== 'hello') return;
      clientId = from;
      sim.addPlayer(from, msg.name, msg.isDesktop);
      t.send({ t: 'welcome', playerId: from, state: sim.snapshot() }, from);
    });
    const client = await ClientSession.connect('local', t.roomCode, 'Me', true);
    open.push(client);
    const got = { events: [] as SimEvent[], poses: [] as PlayerPose[], lobby: [] as LobbyPlayer[][] };
    client.callbacks = {
      ...noop(),
      onEvent: (e) => got.events.push(e),
      onRemotePose: (_id, p) => got.poses.push(p),
      onLobby: (l) => got.lobby.push(l),
    };
    const good = JSON.stringify(client.state);
    const garbage: unknown[] = [
      { t: 'snapshot', state: null },
      { t: 'snapshot', state: { phase: 'nope' } },
      { t: 'snapshot', state: { ...sim.snapshot(), monster: { position: 'here' } } },
      { t: 'round', state: [] },
      { t: 'peerPose', id: t.selfId, pose: { head: { position: { x: 'a' } } } },
      { t: 'peerPose', id: 'stranger', pose: makeSpawnPose(v3(), 0) },
      { t: 'event', event: { type: 'flash', by: t.selfId, position: { x: 'a', y: 0, z: 0 } } },
      { t: 'event', event: { type: 'selfDestruct' } },
      { t: 'event', event: null },
      { t: 'lobby', players: 'everyone' },
    ];
    for (const m of garbage) t.send(m as NetMessage);
    // A good event after the garbage proves everything was delivered and processed in order.
    t.send({ t: 'event', event: { type: 'exitOpened', position: v3(0, 1, 8) } });
    await until(() => got.events.length > 0);
    expect(got.events).toEqual([{ type: 'exitOpened', position: v3(0, 1, 8) }]);
    expect(got.poses).toEqual([]);
    expect(got.lobby).toEqual([]);
    expect(JSON.stringify(client.state)).toBe(good);

    // A snapshot with one broken player and absurd numbers is cleaned, not swallowed whole.
    const snap = sim.snapshot() as unknown as Record<string, unknown> & WorldState;
    (snap.players as Record<string, unknown>).ghost = { id: 'ghost', pose: 7 };
    snap.monster.position = v3(1e9, 0, 0);
    snap.camera.film = -5;
    t.send({ t: 'snapshot', state: snap });
    t.send({ t: 'lobby', players: [{ id: clientId, name: 5, color: 'red', isDesktop: 1 }, null, { id: 9 }] } as unknown as NetMessage);
    await until(() => got.lobby.length > 0);
    expect(Object.keys(client.state.players).sort()).toEqual([clientId, t.selfId].sort());
    expect(client.state.monster.position.x).toBeLessThan(20);
    expect(client.state.camera.film).toBe(0);
    expect(finiteDeep(client.state)).toBe(true);
    expect(got.lobby[0]).toEqual([{ id: clientId, name: 'Survivor', color: 0xffffff, isDesktop: false }]);

    // Prototype pollution through player ids.
    const evil = JSON.parse(
      JSON.stringify({ ...sim.snapshot(), players: { ...sim.snapshot().players } }).replace(
        /^\{"time"/,
        '{"__proto__":{"pose":1},"time"',
      ),
    ) as WorldState;
    (evil.players as unknown as Record<string, unknown>)['__proto__'] = { id: '__proto__', pose: 1 };
    t.send({ t: 'snapshot', state: JSON.parse(JSON.stringify(evil).replace('"players":{', '"players":{"__proto__":{"id":"__proto__","status":"alive","pose":{"head":{"position":{"x":0,"y":1,"z":0}}}},')) });
    t.send({ t: 'peerPose', id: '__proto__', pose: makeSpawnPose(v3(), 0) });
    t.send({ t: 'peerPose', id: 'constructor', pose: makeSpawnPose(v3(), 0) });
    t.send({ t: 'event', event: { type: 'exitOpened', position: v3(0, 1, 7) } });
    await until(() => got.events.length > 1);
    expect(({} as Record<string, unknown>).pose).toBeUndefined();
    expect(Object.getPrototypeOf(client.state.players)).toBe(Object.prototype);
    expect(Object.keys(client.state.players).sort()).toEqual([clientId, t.selfId].sort());
    expect(got.poses).toEqual([]);
  });
});

describe('session flows over the local transport', () => {
  it('a player joining mid-round gets the live round and a free spawn', async () => {
    const t = await hostRoom('local');
    const host = new HostSession(t, 'Host', true);
    open.push(host);
    host.startRound();
    // Like the browser flow: the host walks to the table and takes the camera; an early guest
    // came and went; time passes and the monster roams.
    const cam = host.state.camera.position;
    const hostPose = makeSpawnPose(v3(cam.x + 0.8, 0, cam.z), Math.PI / 2);
    hostPose.right.position = v3(cam.x, cam.y + 0.05, cam.z);
    hostPose.left.tracked = hostPose.right.tracked = true;
    host.sendPose(hostPose);
    host.sendAction({ type: 'grab', hand: 'right', position: hostPose.right.position, reach: 0.35 });
    expect(host.state.camera.holder).toBe(host.localId);
    const early = await ClientSession.connect('local', t.roomCode, 'Early', true);
    early.close();
    await until(() => Object.keys(host.state.players).length === 1);
    for (let i = 0; i < 150; i++) host.update(1 / 30);
    const client = await ClientSession.connect('local', t.roomCode, 'Late', false);
    open.push(client);
    expect(client.state).toEqual(JSON.parse(JSON.stringify(client.state)));
    expect(client.state.camera.holder).toBe(host.localId);
    const me = client.state.players[client.localId];
    expect(client.state.phase).toBe('playing');
    expect(me.status).toBe('alive');
    expect(me.isDesktop).toBe(false);
    expect(dist3(me.spawn, host.state.players[host.localId].spawn)).toBeGreaterThan(0.5);
    expect(isFiniteVec3(me.pose.head.position)).toBe(true);
    expect(host.state.players[client.localId]).toBeTruthy();
  });

  it('the host leaving disconnects clients with a message', async () => {
    const t = await hostRoom('local');
    const host = new HostSession(t, 'Host', true);
    const client = await ClientSession.connect('local', t.roomCode, 'Guest', true);
    open.push(client);
    const reasons: string[] = [];
    client.callbacks = { ...noop(), onDisconnected: (r) => reasons.push(r) };
    host.close();
    await until(() => reasons.length > 0);
    expect(reasons[0]).toMatch(/host/i);
  });

  it('a full room rejects with a readable reason', async () => {
    const t = await hostRoom('local');
    const host = new HostSession(t, 'Host', true);
    open.push(host);
    for (let i = 1; i < GAME.maxPlayers; i++) open.push(await ClientSession.connect('local', t.roomCode, `P${i}`, true));
    await expect(ClientSession.connect('local', t.roomCode, 'Fifth', true)).rejects.toThrow(/full/);
  });
});
