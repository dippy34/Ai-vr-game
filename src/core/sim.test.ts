import { describe, expect, it } from 'vitest';
import { GAME, HEARING, LIGHT, MONSTER, NOISE, PLAYER, PLAYER_COLORS } from '../config';
import { createLevel, roomAt } from './level';
import { distXZ, v3 } from './math';
import { circleBlocked, distToBox, moveCircle, supportHeight } from './physics';
import { navGridFor } from './navgrid';
import { GameSim, makeSpawnPose, SIM_TUNING } from './sim';
import type { LevelData, MonsterState, PlayerId, SimEvent, Vec3 } from './types';

const SEED = 1234;

function setup(players = 1, opts = {}) {
  const level = createLevel(SEED);
  const sim = new GameSim(level, opts);
  const ids: PlayerId[] = [];
  for (let i = 0; i < players; i++) {
    const id = `p${i}`;
    sim.addPlayer(id, `Player ${i}`, true);
    ids.push(id);
  }
  sim.startRound();
  return { level, sim, ids };
}

/** Stand player `id` at (x, z) with tracked hands; optional explicit right-hand position. */
function place(sim: GameSim, id: PlayerId, x: number, z: number, rightHand?: Vec3, leftHand?: Vec3) {
  const pose = makeSpawnPose(v3(x, 0, z), 0);
  pose.left.tracked = true;
  pose.right.tracked = true;
  if (rightHand) pose.right.position = { ...rightHand };
  if (leftHand) pose.left.position = { ...leftHand };
  sim.setPlayerPose(id, pose);
}

function placeMonster(sim: GameSim, x: number, z: number) {
  sim.state.monster.position = v3(x, 0, z);
}

const head = (x: number, z: number) => v3(x, PLAYER.eyeHeight, z);

function talk(sim: GameSim, id: PlayerId | null, pos: Vec3, loudness: number) {
  sim.reportNoise({ source: 'voice', position: pos, loudness, playerId: id });
}

/** Step until `pred` is true (or time runs out). Returns all events. */
function runUntil(sim: GameSim, seconds: number, pred: (ev: SimEvent[]) => boolean = () => false, dt = 1 / 30) {
  const all: SimEvent[] = [];
  for (let t = 0; t < seconds; t += dt) {
    const ev = sim.step(dt);
    all.push(...ev);
    if (pred(ev)) break;
  }
  return all;
}

const has = (ev: SimEvent[], type: SimEvent['type']) => ev.some((e) => e.type === type);

/**
 * Does the monster's body overlap geometry it must not? Never walls / tall furniture / the closed
 * door (with its current radius: smaller on all fours); low furniture only while it is down on
 * all fours (crawling past or climbing over it).
 */
function monsterClips(level: LevelData, m: MonsterState): boolean {
  const g = navGridFor(level);
  const r = (m.posture === 'crawl' ? MONSTER.crawlRadius : MONSTER.radius) - 0.02;
  const { x, z } = m.position;
  if (g.hard.some((b) => distToBox(b, x, z) < r)) return true;
  return m.posture !== 'crawl' && g.climb.some((b) => distToBox(b, x, z) < r);
}

describe('GameSim setup', () => {
  it('constructs a lobby world', () => {
    const level = createLevel(SEED);
    const sim = new GameSim(level);
    const s = sim.state;
    expect(s.phase).toBe('lobby');
    expect(s.levelSeed).toBe(SEED);
    expect(distXZ(s.monster.position, level.monsterSpawn)).toBe(0);
    expect(s.monster.mode).toBe('wander');
    expect(s.items.length).toBe(GAME.fusesRequired);
    expect(s.items.every((i) => i.kind === 'fuse')).toBe(true);
    expect(s.fusesRequired).toBe(GAME.fusesRequired);
    // The lobby does not simulate the monster.
    sim.step(1);
    expect(s.time).toBeCloseTo(1);
    expect(distXZ(s.monster.position, level.monsterSpawn)).toBe(0);
  });

  it('respects SimOptions', () => {
    const sim = new GameSim(createLevel(SEED), { fusesRequired: 2 });
    expect(sim.state.fusesRequired).toBe(2);
    expect(sim.state.items.filter((i) => i.kind === 'fuse').length).toBe(2);
  });

  it('assigns colors and spawns in join order, reusing freed ones', () => {
    const level = createLevel(SEED);
    const sim = new GameSim(level);
    const a = sim.addPlayer('a', 'A', false);
    const b = sim.addPlayer('b', 'B', true);
    expect(a.color).toBe(PLAYER_COLORS[0]);
    expect(b.color).toBe(PLAYER_COLORS[1]);
    expect(a.spawn).toEqual(level.playerSpawns[0].position);
    expect(b.spawn).toEqual(level.playerSpawns[1].position);
    expect(a.pose.head.position.y).toBeCloseTo(PLAYER.eyeHeight);
    expect(a.pose.left.tracked).toBe(false);
    expect(a.held).toEqual({ left: null, right: null });
    expect(a.status).toBe('alive');
    sim.removePlayer('a');
    const c = sim.addPlayer('c', 'C', true);
    expect(c.color).toBe(PLAYER_COLORS[0]);
    expect(c.spawn).toEqual(level.playerSpawns[0].position);
    // Mid-round joiner.
    sim.startRound();
    const d = sim.addPlayer('d', 'D', true);
    expect(d.status).toBe('alive');
    expect(d.spawn).toEqual(level.playerSpawns[2].position);
  });

  it('snapshot is a deep copy', () => {
    const { sim } = setup(1);
    const snap = sim.snapshot();
    snap.monster.position.x = 999;
    snap.players.p0.pose.head.position.x = 999;
    expect(sim.state.monster.position.x).not.toBe(999);
    expect(sim.state.players.p0.pose.head.position.x).not.toBe(999);
    expect(JSON.parse(JSON.stringify(snap)).phase).toBe('playing');
  });

  it('is deterministic for identical inputs', () => {
    const script = () => {
      const { sim } = setup(2);
      const evs: SimEvent[] = [];
      for (let i = 0; i < 900; i++) {
        if (i === 200) talk(sim, 'p0', head(0, 4), NOISE.talk);
        if (i === 500) talk(sim, 'p1', head(0, 0), NOISE.shout);
        evs.push(...sim.step(1 / 30));
      }
      return JSON.stringify({ s: sim.snapshot(), evs });
    };
    expect(script()).toBe(script());
  });
});

describe('hearing', () => {
  it('does not hear a whisper from far away or through a wall', () => {
    const { sim } = setup(1);
    placeMonster(sim, -3.45, 0);
    place(sim, 'p0', 2.55, 0);
    talk(sim, 'p0', head(2.55, 0), NOISE.whisper); // ~6 m in the open
    // ~2.8 m but through the storage/study wall
    placeMonster(sim, -3.6, -3.0);
    place(sim, 'p0', -0.9, -3.5);
    talk(sim, 'p0', head(-0.9, -3.5), NOISE.whisper);
    expect(sim.state.lastHeard).toBeNull();
    expect(sim.state.monster.mode).toBe('wander');
    // Same distance without a wall IS heard.
    placeMonster(sim, -3.45, 0);
    place(sim, 'p0', -0.75, 0);
    talk(sim, 'p0', head(-0.75, 0), NOISE.whisper);
    expect(sim.state.lastHeard).not.toBeNull();
    expect(sim.state.monster.mode).toBe('investigate');
  });

  it('does not hear normal talk from the far side of the house', () => {
    const { sim } = setup(1);
    placeMonster(sim, -6.0, 3.6); // living room
    place(sim, 'p0', 7.5, -6.4); // kitchen
    talk(sim, 'p0', head(7.5, -6.4), NOISE.talk);
    expect(sim.state.lastHeard).toBeNull();
  });

  it('hears a shout from far away and investigates it', () => {
    const { sim } = setup(1);
    placeMonster(sim, -10.2, 0);
    place(sim, 'p0', 6.55, 0);
    talk(sim, 'p0', head(6.55, 0), NOISE.shout); // ~17 m down the hallway
    expect(sim.state.monster.mode).toBe('investigate');
    expect(sim.state.lastHeard?.loudness).toBeCloseTo(NOISE.shout);
  });

  it('talking nearby makes it investigate (with one alert event)', () => {
    const { sim } = setup(1);
    placeMonster(sim, -3.45, 0);
    place(sim, 'p0', 4.5, 0.2);
    expect(sim.hearingRatio(head(4.5, 0.2), NOISE.talk)).toBeLessThan(HEARING.chaseRatio);
    talk(sim, 'p0', head(4.5, 0.2), NOISE.talk);
    const m = sim.state.monster;
    expect(m.mode).toBe('investigate');
    expect(m.targetPlayer).toBeNull();
    expect(m.alert).toBeGreaterThan(0);
    const ev = sim.step(1 / 30);
    expect(ev.filter((e) => e.type === 'monsterAlert')).toEqual([
      expect.objectContaining({ type: 'monsterAlert', mode: 'investigate' }),
    ]);
    // Another noise of the same kind does not re-alert.
    talk(sim, 'p0', head(4.5, 0.2), NOISE.talk);
    expect(has(sim.step(1 / 30), 'monsterAlert')).toBe(false);
  });

  it('a loud noise close by makes it chase the source player', () => {
    const { sim } = setup(1);
    placeMonster(sim, -3.45, 0);
    place(sim, 'p0', -0.5, 0);
    talk(sim, 'p0', head(-0.5, 0), NOISE.shout);
    expect(sim.state.monster.mode).toBe('chase');
    expect(sim.state.monster.targetPlayer).toBe('p0');
    expect(sim.state.monster.alert).toBeCloseTo(1, 1);
  });

  it('noises made by actions return their alerts immediately', () => {
    const { sim } = setup(1);
    place(sim, 'p0', -1.5, 6.5);
    sim.handleAction('p0', { type: 'light', on: false });
    // The light switch only clicks quietly: right next to it, it still hears it.
    placeMonster(sim, -1.5, 6.1);
    const ev = sim.handleAction('p0', { type: 'light', on: true });
    expect(ev.map((e) => e.type)).toEqual(['light', 'monsterAlert']);
    expect(sim.state.lastHeard?.loudness).toBeCloseTo(NOISE.lightClick);
  });

  it('ignores noise outside play and from non-alive players', () => {
    const level = createLevel(SEED);
    const lobby = new GameSim(level);
    lobby.addPlayer('p0', 'P', true);
    talk(lobby, 'p0', v3(-3, 2, -5.6), NOISE.shout);
    expect(lobby.state.lastHeard).toBeNull();

    const { sim } = setup(2);
    sim.state.players.p1.status = 'caught';
    talk(sim, 'p1', v3(-3.4, 2, -5), NOISE.shout);
    talk(sim, 'ghost', v3(-3.4, 2, -5), NOISE.shout);
    expect(sim.state.lastHeard).toBeNull();
    expect(sim.state.monster.mode).toBe('wander');
  });

  it('alert decays over ~8 s', () => {
    const { sim } = setup(1);
    placeMonster(sim, -3.45, 0);
    talk(sim, null, v3(-3.45, 2, 0.5), NOISE.shout);
    expect(sim.state.monster.alert).toBeGreaterThan(0.9);
    runUntil(sim, 4);
    expect(sim.state.monster.alert).toBeGreaterThan(0.3);
    expect(sim.state.monster.alert).toBeLessThan(0.7);
    runUntil(sim, 4.5);
    expect(sim.state.monster.alert).toBe(0);
  });

  it('a quieter noise from someone else does not steal an ongoing chase', () => {
    const { sim } = setup(2);
    placeMonster(sim, -3.45, 0);
    place(sim, 'p0', -1.5, 0);
    place(sim, 'p1', 6.55, 0);
    talk(sim, 'p0', head(-1.5, 0), NOISE.shout);
    expect(sim.state.monster.targetPlayer).toBe('p0');
    talk(sim, 'p1', head(6.55, 0), NOISE.talk);
    expect(sim.state.monster.mode).toBe('chase');
    expect(sim.state.monster.targetPlayer).toBe('p0');
  });
});

describe('monster behaviour', () => {
  it('a frozen monster (dev / test hook) stays put, hears nothing and catches no one', () => {
    const { sim } = setup(1);
    sim.setMonsterFrozen(true);
    placeMonster(sim, 0, 0);
    place(sim, 'p0', 0.3, 0.3);
    talk(sim, 'p0', head(0.3, 0.3), NOISE.shout);
    const ev = runUntil(sim, 3);
    expect(has(ev, 'playerCaught')).toBe(false);
    expect(sim.state.monster.position).toEqual(v3(0, 0, 0));
    sim.setMonsterFrozen(false);
    expect(has(runUntil(sim, 2, (e) => has(e, 'playerCaught')), 'playerCaught')).toBe(true);
  });

  it('walks to a noise and catches a silent player standing there, feeds, then wanders', () => {
    const { sim, level } = setup(2);
    placeMonster(sim, -3.45, 0);
    place(sim, 'p0', 4.5, 0.2); // hallway, east part
    place(sim, 'p1', 7.0, 6.5); // dining room, silent, far away
    talk(sim, 'p0', head(4.5, 0.2), NOISE.talk);
    expect(sim.state.monster.mode).toBe('investigate');
    const ev = runUntil(sim, 20, (e) => has(e, 'playerCaught'));
    const caught = ev.find((e) => e.type === 'playerCaught');
    expect(caught).toMatchObject({ type: 'playerCaught', id: 'p0' });
    expect(sim.state.players.p0.status).toBe('caught');
    expect(sim.state.monster.mode).toBe('feeding');
    expect(sim.state.phase).toBe('playing');
    expect(monsterClips(level, sim.state.monster)).toBe(false);
    runUntil(sim, GAME.feedingTime + 0.2);
    expect(sim.state.monster.mode).toBe('wander');
    // Caught players are ignored.
    talk(sim, 'p0', head(4.5, 0.2), NOISE.shout);
    expect(sim.state.monster.mode).toBe('wander');
  });

  it('navigates through doorways to investigate a noise in another room', () => {
    const { sim, level } = setup(1);
    place(sim, 'p0', 0.7, 6.6);
    // Monster starts in the bathroom; a noise in the bedroom next door (clearly audible: a faint
    // one would be stalked at a creep).
    talk(sim, null, v3(-9.9, 1.0, -2.4), 0.8);
    expect(sim.state.monster.mode).toBe('investigate');
    expect(sim.monsterDebug().stalk).toBe(false);
    let maxSpeed = 0;
    runUntil(sim, 25, () => {
      maxSpeed = Math.max(maxSpeed, sim.state.monster.speed);
      expect(monsterClips(level, sim.state.monster)).toBe(false);
      return distXZ(sim.state.monster.position, v3(-9.9, 0, -2.4)) < 0.5;
    });
    expect(distXZ(sim.state.monster.position, v3(-9.9, 0, -2.4))).toBeLessThan(0.5);
    expect(maxSpeed).toBeLessThanOrEqual(MONSTER.investigateSpeed + 1e-6);
    expect(maxSpeed).toBeGreaterThan(MONSTER.investigateSpeed * 0.8);
    // Then it stops and listens toward the sound...
    runUntil(sim, 0.5);
    const m = sim.state.monster;
    expect(m.mode).toBe('investigate');
    expect(m.speed).toBe(0);
    expect(m.act).toBe('listen');
    expect(distXZ(m.focus!, v3(-9.9, 0, -2.4))).toBeLessThan(0.01);
    // ...searches the hiding spots around (moving between them), and goes back to wandering.
    const acts = new Set<string>();
    let travelled = 0;
    let prev = { ...m.position };
    runUntil(sim, 40, () => {
      acts.add(m.act);
      travelled += distXZ(prev, m.position);
      prev = { ...m.position };
      expect(monsterClips(level, m)).toBe(false);
      return m.mode === 'wander';
    });
    expect(m.mode).toBe('wander');
    expect([...acts].filter((a) => a === 'search' || a === 'sniff' || a === 'sweep').length).toBeGreaterThan(0);
    expect(travelled).toBeGreaterThan(1);
  });

  it('gives up a chase after silence and investigates the last spot', () => {
    const { sim } = setup(1);
    placeMonster(sim, -3.45, 0);
    place(sim, 'p0', 0, 0);
    talk(sim, 'p0', head(0, 0), NOISE.shout);
    expect(sim.state.monster.mode).toBe('chase');
    place(sim, 'p0', 7.0, 6.5); // sneaks away silently to the dining room
    runUntil(sim, HEARING.chaseForget - 0.3);
    expect(sim.state.monster.mode).toBe('chase');
    expect(distXZ(sim.state.monster.position, v3(0, 0, 0))).toBeLessThan(0.5);
    const ev = runUntil(sim, 0.6);
    expect(sim.state.monster.mode).toBe('investigate');
    expect(ev).toContainEqual(expect.objectContaining({ type: 'monsterAlert', mode: 'investigate' }));
    // It searches around the spot (maybe lurks a while) and eventually wanders off again.
    runUntil(sim, 45, () => sim.state.monster.mode === 'wander');
    expect(sim.state.monster.mode).toBe('wander');
    expect(sim.state.players.p0.status).toBe('alive');
  });

  it('keeps chasing while the target keeps making noise, and re-alerts after a gap', () => {
    const { sim } = setup(1);
    placeMonster(sim, -10.2, 0);
    place(sim, 'p0', -6.45, 0);
    talk(sim, 'p0', head(-6.45, 0), NOISE.shout);
    expect(sim.state.monster.mode).toBe('chase');
    sim.step(1 / 30);
    // Player runs east down the hallway, footsteps every 0.7 m.
    let x = -6.45;
    const evs: SimEvent[] = [];
    for (let i = 0; i < 60 && x < 9; i++) {
      x += 0.7;
      place(sim, 'p0', x, 0);
      sim.reportNoise({ source: 'footstep', position: v3(x, 0, 0), loudness: NOISE.sprintStep, playerId: 'p0' });
      evs.push(...runUntil(sim, 0.7 / PLAYER.sprintSpeed));
      if (sim.state.players.p0.status !== 'alive') break;
    }
    expect(sim.state.monster.mode === 'chase' || sim.state.players.p0.status === 'caught').toBe(true);
    expect(evs.filter((e) => e.type === 'monsterAlert').length).toBe(0);
  });

  it('notices a silent player it bumps into', () => {
    const { sim } = setup(1);
    const m = sim.state.monster;
    placeMonster(sim, 0, 0);
    place(sim, 'p0', 0.3, 0.3);
    const ev = sim.step(1 / 30);
    expect(has(ev, 'playerCaught')).toBe(true);
    expect(m.mode).toBe('feeding');
  });

  it('never catches through a wall', () => {
    const { sim } = setup(1);
    // Monster in the storage room right behind the hallway wall (z = -1.2); a VR player leans
    // their head into the wall from the hallway side: 0.6 m apart, but a wall in between.
    placeMonster(sim, -2.6, -1.7);
    place(sim, 'p0', -2.6, -1.1);
    expect(distXZ(sim.state.monster.position, sim.state.players.p0.pose.head.position)).toBeLessThan(
      HEARING.catchRadius,
    );
    expect(has(sim.step(1 / 60), 'playerCaught')).toBe(false);
    expect(sim.state.players.p0.status).toBe('alive');
    // Same distance on the same side of the wall: caught.
    placeMonster(sim, -2.6, -1.7);
    place(sim, 'p0', -2.6, -2.3);
    expect(has(sim.step(1 / 60), 'playerCaught')).toBe(true);
  });

  it('chases through doorways and catches a player in the next room', () => {
    const { sim, level } = setup(1);
    // Monster in the bathroom (spawn); player shouts in the bedroom next door.
    place(sim, 'p0', -7.4, -4.6);
    talk(sim, 'p0', head(-7.4, -4.6), NOISE.shout);
    expect(sim.state.monster.mode).toBe('chase');
    const ev = runUntil(sim, 10, (e) => {
      expect(monsterClips(level, sim.state.monster)).toBe(false);
      return has(e, 'playerCaught');
    });
    expect(ev).toContainEqual(expect.objectContaining({ type: 'playerCaught', id: 'p0' }));
  });

  it('re-alerts when a chased player is heard again after a gap', () => {
    const { sim } = setup(1);
    placeMonster(sim, -10.2, 0);
    place(sim, 'p0', -3.45, 0);
    talk(sim, 'p0', head(-3.45, 0), NOISE.shout);
    sim.step(1 / 30);
    place(sim, 'p0', 2.55, 0);
    runUntil(sim, SIM_TUNING.chaseRegainGap + 0.5); // silent, but less than chaseForget
    expect(sim.state.monster.mode).toBe('chase');
    sim.reportNoise({ source: 'footstep', position: v3(2.55, 0, 0), loudness: NOISE.sprintStep, playerId: 'p0' });
    const ev = sim.step(1 / 30);
    expect(ev).toContainEqual(expect.objectContaining({ type: 'monsterAlert', mode: 'chase' }));
  });

  it('wanders the whole house over time without ever clipping geometry', () => {
    const level = createLevel(99);
    const sim = new GameSim(level);
    sim.startRound(); // no players: phase stays 'playing'
    const rooms = new Set<string>();
    const nodes = level.nav;
    let k = 0;
    const b = level.bounds;
    for (let i = 0; i < 30 * 600; i++) {
      if (i % 240 === 0) {
        // A random-ish unattributed noise somewhere (deterministic).
        const n = nodes[(k = (k * 7 + 3) % nodes.length)];
        sim.reportNoise({ source: 'item', position: v3(n.position.x, 1, n.position.z), loudness: 0.4, playerId: null });
      }
      sim.step(1 / 30);
      const p = sim.state.monster.position;
      if (monsterClips(level, sim.state.monster)) {
        throw new Error(`monster clipped geometry at ${p.x.toFixed(2)},${p.z.toFixed(2)} t=${sim.state.time}`);
      }
      expect(p.x > b.min.x && p.x < b.max.x && p.z > b.min.z && p.z < 8).toBe(true);
      const r = roomAt(p.x, p.z);
      if (r) rooms.add(r);
    }
    expect(rooms.size).toBeGreaterThanOrEqual(8);
  });
});

describe('the Crank Light', () => {
  it('every player starts each round with a full light, switched on', () => {
    const { sim } = setup(2);
    for (const p of Object.values(sim.state.players)) {
      expect(p.light).toEqual({ on: LIGHT.startOn, charge: LIGHT.startCharge, cranking: false });
      // It never takes up a hand.
      expect(p.held).toEqual({ left: null, right: null });
    }
  });

  it('switching it clicks (once per change), drains while on and not while off', () => {
    const { sim } = setup(1);
    place(sim, 'p0', -1.5, 6.5);
    const L = sim.state.players.p0.light;
    expect(sim.handleAction('p0', { type: 'light', on: true })).toEqual([]); // already on
    const off = sim.handleAction('p0', { type: 'light', on: false });
    expect(off).toContainEqual(expect.objectContaining({ type: 'light', by: 'p0', on: false }));
    expect(L.on).toBe(false);
    runUntil(sim, 10);
    expect(L.charge).toBe(LIGHT.startCharge);
    sim.handleAction('p0', { type: 'light', on: true });
    runUntil(sim, 10);
    expect(L.charge).toBeCloseTo(LIGHT.startCharge - 10 / LIGHT.batterySeconds, 2);
    // It runs flat and stays flat (but stays switched on, so winding brings it straight back).
    runUntil(sim, LIGHT.batterySeconds);
    expect(L.charge).toBe(0);
    expect(L.on).toBe(true);
  });

  it('winding charges it and is loud: the monster hears it from across a room', () => {
    const { sim } = setup(1);
    place(sim, 'p0', -8, 0);
    const L = sim.state.players.p0.light;
    L.charge = 0;
    sim.handleAction('p0', { type: 'light', on: false });
    // 8 m down the hallway: a whisper wouldn't reach it, winding does.
    placeMonster(sim, 0, 0);
    expect(sim.hearingRatio(head(-8, 0), NOISE.whisper)).toBe(0);
    expect(sim.hearingRatio(head(-8, 0), NOISE.crank)).toBeGreaterThan(1);
    sim.handleAction('p0', { type: 'crank', on: true });
    const ev = sim.step(1 / 30);
    expect(has(ev, 'monsterAlert')).toBe(true);
    expect(sim.state.lastHeard?.loudness).toBeCloseTo(NOISE.crank);
    // Keeps ratcheting while you wind.
    sim.state.lastHeard = null;
    runUntil(sim, LIGHT.crankNoiseInterval + 0.05);
    expect(sim.state.lastHeard).not.toBeNull();
    // Stop winding: silence.
    sim.handleAction('p0', { type: 'crank', on: false });
    sim.state.lastHeard = null;
    runUntil(sim, 0.5);
    expect(sim.state.lastHeard).toBeNull();
    expect(L.cranking).toBe(false);
    // (Monster held still so it doesn't interrupt.) crankSecondsToFull of winding fills it.
    sim.setMonsterFrozen(true);
    const before = L.charge;
    sim.handleAction('p0', { type: 'crank', on: true });
    runUntil(sim, LIGHT.crankSecondsToFull * (1 - before) + 0.1);
    expect(L.charge).toBe(1);
  });

  it('is off once you are caught, and ignores junk and actions outside play', () => {
    const { sim } = setup(1);
    place(sim, 'p0', -1.5, 6.5);
    const p = sim.state.players.p0;
    sim.handleAction('p0', { type: 'crank', on: true });
    // @ts-expect-error junk off the network
    expect(sim.handleAction('p0', { type: 'light', on: 'yes' })).toEqual([]);
    // @ts-expect-error junk off the network
    sim.handleAction('p0', { type: 'crank' });
    expect(p.light.cranking).toBe(true);
    placeMonster(sim, -1.5, 6.6);
    runUntil(sim, 1, (ev) => has(ev, 'playerCaught'));
    expect(p.status).toBe('caught');
    expect(p.light.on).toBe(false);
    expect(p.light.cranking).toBe(false);
    expect(sim.handleAction('p0', { type: 'light', on: true })).toEqual([]);
    expect(p.light.on).toBe(false);
    const lobby = new GameSim(createLevel(SEED));
    lobby.addPlayer('p0', 'P', true);
    expect(lobby.handleAction('p0', { type: 'light', on: false })).toEqual([]);
    expect(lobby.state.players.p0.light.on).toBe(LIGHT.startOn);
  });
});

describe('items', () => {
  it('can not grab through walls, and ignores actions outside play or from caught players', () => {
    const level = createLevel(SEED);
    const lobby = new GameSim(level);
    lobby.addPlayer('p0', 'P', true);
    const f0 = lobby.state.items[0].position;
    expect(lobby.handleAction('p0', { type: 'grab', hand: 'right', position: f0, reach: 1 })).toEqual([]);

    const { sim } = setup(1);
    // A fuse on the foyer table, just on the foyer side of the living-room wall (x = -3); the
    // player is in the living room with their (desktop) probe poking through the wall.
    const onTable = sim.state.items[0];
    onTable.position = v3(-2.6, 0.75, 6.5);
    place(sim, 'p0', -3.6, 6.5);
    expect(sim.handleAction('p0', { type: 'grab', hand: 'right', position: v3(-2.9, 1, 6.5), reach: 1.6 })).toEqual([]);
    expect(onTable.where).toBe('world');
    // Dropping something with the hand through a wall leaves it on the player's side.
    const fuse = sim.state.items.find((i) => i.kind === 'fuse')!;
    place(sim, 'p0', fuse.position.x, fuse.position.z, v3(fuse.position.x, fuse.position.y + 0.05, fuse.position.z));
    sim.handleAction('p0', { type: 'grab', hand: 'right', position: v3(fuse.position.x, fuse.position.y + 0.05, fuse.position.z), reach: 0.35 });
    expect(fuse.where).toBe('held');
    place(sim, 'p0', -3.6, 6.5);
    sim.handleAction('p0', { type: 'release', hand: 'right', position: v3(-2.6, 1.2, 6.0) });
    expect(fuse.where).toBe('world');
    expect(fuse.position.x).toBeLessThan(-3.1);
    expect(roomAt(fuse.position.x, fuse.position.z)).toBe('living');
    sim.state.players.p0.status = 'caught';
    expect(sim.handleAction('p0', { type: 'grab', hand: 'right', position: fuse.position, reach: 1 })).toEqual([]);
  });

  it('a released fuse comes to rest on the surface below (table top or floor)', () => {
    const { sim, level } = setup(2);
    const fuse = sim.state.items[0];
    place(sim, 'p0', fuse.position.x, fuse.position.z, v3(fuse.position.x, fuse.position.y + 0.05, fuse.position.z));
    const g = sim.handleAction('p0', { type: 'grab', hand: 'right', position: v3(fuse.position.x, fuse.position.y + 0.05, fuse.position.z), reach: 0.35 });
    expect(g).toContainEqual(expect.objectContaining({ type: 'pickup', by: 'p0', what: 'fuse' }));
    expect(sim.state.players.p0.held.right).toEqual({ kind: 'item', itemId: fuse.id });
    // Someone else can't take it out of your hand.
    place(sim, 'p1', fuse.position.x + 0.3, fuse.position.z);
    expect(sim.handleAction('p1', { type: 'grab', hand: 'right', position: fuse.position, reach: 1 })).toEqual([]);
    // Held fuse follows the hand.
    place(sim, 'p0', 7.0, 5.5, v3(7.0, 1.1, 4.8));
    expect(fuse.position).toEqual(v3(7.0, 1.1, 4.8));
    // Release over the dining table: y snaps to the table top.
    place(sim, 'p1', 6.0, 3.3);
    const rel = sim.handleAction('p0', { type: 'release', hand: 'right', position: v3(7.0, 1.1, 4.5) });
    expect(rel).toContainEqual(expect.objectContaining({ type: 'drop', what: 'fuse' }));
    expect(fuse.position.y).toBeCloseTo(supportHeight(level, 7.0, 4.5));
    expect(fuse.position.y).toBeCloseTo(0.76);
    expect(sim.state.players.p0.held.right).toBeNull();
    // Picked up again and released over the floor.
    sim.handleAction('p1', { type: 'grab', hand: 'right', position: v3(7.0, 0.9, 4.5), reach: PLAYER.desktopGrabReach });
    expect(fuse.holder).toBe('p1');
    sim.handleAction('p1', { type: 'release', hand: 'right', position: v3(5.0, 1.2, 3.0) });
    expect(fuse.position.y).toBe(0);
  });

  it('fuses -> exit opens -> escape -> won', () => {
    const { sim, level } = setup(2);
    const s = sim.state;
    placeMonster(sim, -9.9, -2.4); // far away in the bedroom
    place(sim, 'p1', 0.7, 5.6);
    const box = level.fuseBox.position;
    const all: SimEvent[] = [];
    for (const fuse of s.items.filter((i) => i.kind === 'fuse')) {
      const at = v3(fuse.position.x, fuse.position.y + 0.05, fuse.position.z);
      place(sim, 'p0', fuse.position.x, fuse.position.z, at);
      const ev = sim.handleAction('p0', { type: 'grab', hand: 'right', position: at, reach: PLAYER.vrGrabReach });
      expect(ev).toContainEqual(expect.objectContaining({ type: 'pickup', what: 'fuse' }));
      expect(fuse.where).toBe('held');
      // Carry it to the fuse box.
      place(sim, 'p0', box.x, box.z - 0.5, v3(box.x, box.y, box.z - 0.3));
      expect(fuse.position).toEqual(v3(box.x, box.y, box.z - 0.3));
      all.push(...sim.step(1 / 30));
      expect(fuse.where).toBe('used');
      expect(sim.state.players.p0.held.right).toBeNull();
    }
    const inserted = all.filter((e) => e.type === 'fuseInserted');
    expect(inserted.map((e) => (e.type === 'fuseInserted' ? e.count : 0))).toEqual([1, 2, 3]);
    expect(s.fusesInserted).toBe(GAME.fusesRequired);
    expect(s.exitOpen).toBe(true);
    expect(has(all, 'exitOpened')).toBe(true);
    // The door noise brings the monster.
    expect(['investigate', 'chase']).toContain(s.monster.mode);

    // The door no longer blocks.
    const out = moveCircle(level, v3(0, 1.6, 7), v3(0, 0, 2), PLAYER.radius, { exitOpen: s.exitOpen });
    expect(out.z).toBeGreaterThan(level.exit.zone.min.z);

    // p0 walks out.
    place(sim, 'p0', 0, 8.6);
    const esc = sim.step(1 / 30);
    expect(esc).toContainEqual({ type: 'playerEscaped', id: 'p0' });
    expect(s.players.p0.status).toBe('escaped');
    expect(s.phase).toBe('playing'); // p1 is still inside
    // p1 gets caught -> still a win because someone escaped.
    placeMonster(sim, 0.7, 5.3);
    s.monster.mode = 'wander';
    const end = sim.step(1 / 30);
    expect(end).toContainEqual(expect.objectContaining({ type: 'playerCaught', id: 'p1' }));
    expect(end).toContainEqual({ type: 'phase', phase: 'won' });
    expect(s.phase).toBe('won');
  });

  it('nobody can escape while the door is closed', () => {
    const { sim } = setup(1);
    place(sim, 'p0', 0, 8.6);
    expect(has(sim.step(1 / 30), 'playerEscaped')).toBe(false);
    expect(sim.state.players.p0.status).toBe('alive');
  });
});

describe('round flow', () => {
  it('everyone caught -> lost', () => {
    const { sim } = setup(1);
    // p0 is carrying a fuse when caught: it gets dropped.
    const fuse = sim.state.items.find((i) => i.kind === 'fuse')!;
    const at = v3(fuse.position.x, fuse.position.y + 0.05, fuse.position.z);
    place(sim, 'p0', fuse.position.x, fuse.position.z, at);
    sim.handleAction('p0', { type: 'grab', hand: 'right', position: at, reach: PLAYER.vrGrabReach });
    placeMonster(sim, -3.45, 0);
    place(sim, 'p0', -1.0, 0, v3(-0.8, 1.0, -0.2));
    talk(sim, 'p0', head(-1.0, 0), NOISE.shout);
    const ev = runUntil(sim, 10, (e) => has(e, 'phase'));
    expect(ev).toContainEqual(expect.objectContaining({ type: 'playerCaught', id: 'p0' }));
    expect(ev).toContainEqual(expect.objectContaining({ type: 'drop', what: 'fuse' }));
    expect(ev).toContainEqual({ type: 'phase', phase: 'lost' });
    expect(sim.state.phase).toBe('lost');
    expect(fuse.where).toBe('world');
    // Nothing happens after the round ended.
    const pos = { ...sim.state.monster.position };
    sim.step(1);
    expect(sim.state.monster.position).toEqual(pos);
  });

  it('removing players drops their things and can end the round', () => {
    const { sim } = setup(2);
    const fuse = sim.state.items[0];
    const at = v3(fuse.position.x, fuse.position.y + 0.05, fuse.position.z);
    place(sim, 'p1', fuse.position.x, fuse.position.z, at);
    sim.handleAction('p1', { type: 'grab', hand: 'right', position: at, reach: PLAYER.vrGrabReach });
    sim.state.players.p0.status = 'caught';
    const ev = sim.removePlayer('p1');
    expect(ev).toContainEqual(expect.objectContaining({ type: 'drop', by: 'p1', what: 'fuse' }));
    expect(fuse.holder).toBeNull();
    expect(sim.state.players.p1).toBeUndefined();
    expect(ev).toContainEqual({ type: 'phase', phase: 'lost' });

    // With no players at all, the round just stays as is.
    const { sim: solo } = setup(1);
    expect(solo.removePlayer('p0')).toEqual([]);
    expect(solo.state.phase).toBe('playing');
    expect(solo.removePlayer('nobody')).toEqual([]);
  });

  it('startRound resets everything', () => {
    const { sim, level } = setup(2);
    const s = sim.state;
    s.players.p0.light = { on: false, charge: 0.1, cranking: true };
    s.fusesInserted = 2;
    s.exitOpen = true;
    s.players.p0.status = 'caught';
    s.players.p1.status = 'escaped';
    s.items.forEach((i) => (i.where = 'used'));
    placeMonster(sim, 5, 5);
    s.monster.mode = 'chase';
    s.phase = 'lost';
    const ev = sim.startRound();
    expect(ev).toContainEqual({ type: 'phase', phase: 'playing' });
    expect(s.phase).toBe('playing');
    expect(s.players.p0.light).toEqual({ on: LIGHT.startOn, charge: LIGHT.startCharge, cranking: false });
    expect(s.fusesInserted).toBe(0);
    expect(s.exitOpen).toBe(false);
    expect(s.lastHeard).toBeNull();
    expect(s.monster.mode).toBe('wander');
    expect(distXZ(s.monster.position, level.monsterSpawn)).toBe(0);
    expect(s.items.every((i) => i.where === 'world')).toBe(true);
    expect(s.items.filter((i) => i.kind === 'fuse').length).toBe(GAME.fusesRequired);
    expect(Object.values(s.players).every((p) => p.status === 'alive')).toBe(true);
    expect(s.players.p0.spawn).toEqual(level.playerSpawns[0].position);
    expect(s.players.p1.spawn).toEqual(level.playerSpawns[1].position);
    expect(s.players.p0.pose.head.position.z).toBeCloseTo(level.playerSpawns[0].position.z);

    // Fuse picks come from distinct spawn spots and vary across rounds.
    const picks = new Set<string>();
    for (let r = 0; r < 6; r++) {
      sim.startRound();
      const fuses = s.items.filter((i) => i.kind === 'fuse').map((i) => `${i.position.x},${i.position.z}`);
      expect(new Set(fuses).size).toBe(fuses.length);
      for (const f of fuses) {
        expect(level.fuseSpawns.some((p) => `${p.x},${p.z}` === f)).toBe(true);
      }
      picks.add(fuses.sort().join('|'));
    }
    expect(picks.size).toBeGreaterThan(1);
  });
});

describe('noise memory', () => {
  /** Seconds the monster spends in `room` over `seconds` after hearing noises there. */
  function lingerAfterNoise(noiseMemory: boolean, seed: number, room: string, at: Vec3, seconds: number): number {
    const sim = new GameSim(createLevel(seed), { noiseMemory });
    sim.addPlayer('p0', 'Player 0', true);
    sim.startRound();
    place(sim, 'p0', 60, 60); // far outside, never reachable
    // A team that keeps making noise in one spot (heard each time, no player id).
    for (let i = 0; i < 12; i++) {
      talk(sim, null, at, NOISE.talk + 0.3);
      runUntil(sim, 2.5);
    }
    let inside = 0;
    const dt = 1 / 15;
    for (let t = 0; t < seconds; t += dt) {
      sim.step(dt);
      if (roomAt(sim.state.monster.position.x, sim.state.monster.position.z) === room) inside += dt;
    }
    return inside;
  }

  it('makes the monster patrol where it heard noise more often (on average over seeds)', () => {
    const kitchen = head(7.5, -4.6);
    const seeds = [1234, 7, 99];
    const total = (mem: boolean) => seeds.reduce((a, sd) => a + lingerAfterNoise(mem, sd, 'kitchen', kitchen, 180), 0);
    expect(total(true)).toBeGreaterThan(total(false) * 1.4);
  });

  it('is deterministic and can be turned off', () => {
    const kitchen = head(7.5, -4.6);
    expect(lingerAfterNoise(true, SEED, 'kitchen', kitchen, 30)).toBe(lingerAfterNoise(true, SEED, 'kitchen', kitchen, 30));
    expect(Number.isFinite(lingerAfterNoise(false, SEED, 'kitchen', kitchen, 30))).toBe(true);
  });
});

describe('random monster spawn', () => {
  it('starts each round somewhere far from the players, and varies between rounds', () => {
    const level = createLevel(SEED);
    const sim = new GameSim(level, { randomMonsterSpawn: true });
    sim.addPlayer('p0', 'Player 0', true);
    const spots = new Set<string>();
    for (let r = 0; r < 12; r++) {
      sim.startRound();
      const m = sim.state.monster.position;
      spots.add(`${m.x.toFixed(2)},${m.z.toFixed(2)}`);
      for (const p of level.playerSpawns) {
        expect(distXZ(m, p.position)).toBeGreaterThanOrEqual(SIM_TUNING.monsterSpawnMinDistance);
      }
      expect(circleBlocked(level, m, SIM_TUNING.monsterRadius)).toBe(false);
    }
    expect(spots.size).toBeGreaterThan(3);
  });

  it('keeps the fixed spawn when the option is off', () => {
    const { level, sim } = setup(1);
    sim.startRound();
    expect(distXZ(sim.state.monster.position, level.monsterSpawn)).toBe(0);
  });
});
