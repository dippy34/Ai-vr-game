/**
 * Second chance (SECOND_CHANCE): grabbed instead of caught, and the ways out (pry, Last Flash,
 * Loud Mode scream, a teammate's rescue), the stun after, and the limits on all of it.
 */
import { describe, expect, it } from 'vitest';
import { HEARING, NOISE, SECOND_CHANCE } from '../config';
import { createLevel } from './level';
import { distXZ, v3 } from './math';
import { GameSim, makeSpawnPose } from './sim';
import type { PlayerAction, PlayerId, SimEvent } from './types';

const W = SECOND_CHANCE;
const DT = 1 / 30;
const has = (ev: SimEvent[], type: SimEvent['type']) => ev.some((e) => e.type === type);

function setup(players = 1) {
  const level = createLevel(1234);
  const sim = new GameSim(level);
  const ids: PlayerId[] = [];
  for (let i = 0; i < players; i++) {
    sim.addPlayer(`p${i}`, `P${i}`, true);
    ids.push(`p${i}`);
  }
  sim.startRound();
  return { level, sim, ids };
}

/** Player head at (x, 1.6, z), hands tracked. */
function place(sim: GameSim, id: PlayerId, x: number, z: number) {
  const pose = makeSpawnPose(v3(x, 0, z), 0);
  pose.left.tracked = pose.right.tracked = true;
  sim.setPlayerPose(id, pose);
}

function run(sim: GameSim, seconds: number, stop: (ev: SimEvent[]) => boolean = () => false) {
  const all: SimEvent[] = [];
  for (let t = 0; t < seconds; t += DT) {
    const ev = sim.step(DT);
    all.push(...ev);
    if (stop(ev)) break;
  }
  return all;
}

/** Open hallway: the monster walks into p0 at (0, 0). */
function grabbed(players = 1) {
  const ctx = setup(players);
  place(ctx.sim, 'p0', 0, 0);
  ctx.sim.state.monster.position = v3(0.3, 0, 0.1);
  const ev = ctx.sim.step(DT);
  expect(has(ev, 'playerGrabbed')).toBe(true);
  return { ...ctx, ev };
}

const pry = (): PlayerAction => ({ type: 'breakFree', method: 'pry', hand: 'right', position: v3(0, 1.4, -0.3), direction: v3(0, 0, -1) });

/** Give p0 the camera in the right hand. */
function holdCamera(sim: GameSim, film: number) {
  const cam = sim.state.camera;
  cam.holder = 'p0';
  cam.hand = 'right';
  cam.film = film;
  sim.state.players.p0.held.right = { kind: 'camera' };
}

describe('second chance: the grab', () => {
  it('grabs instead of catching while you have a chance left, and announces the window', () => {
    const { sim, ev } = grabbed();
    const s = sim.state;
    expect(s.players.p0.status).toBe('alive');
    expect(s.players.p0.secondChances).toBe(W.perRound - 1);
    expect(s.monster.mode).toBe('grab');
    expect(s.grab).toMatchObject({ playerId: 'p0' });
    expect(s.grab!.deadline - s.grab!.start).toBeCloseTo(W.window + W.latencyGrace);
    expect(ev).toContainEqual(expect.objectContaining({ type: 'playerGrabbed', id: 'p0', window: W.window }));
    expect(has(ev, 'playerCaught')).toBe(false);
  });

  it('holds still while it has you, and catches you when the window runs out', () => {
    const { sim } = grabbed();
    const at = { ...sim.state.monster.position };
    const ev = run(sim, W.window + W.latencyGrace - 0.1);
    expect(has(ev, 'playerCaught')).toBe(false);
    expect(distXZ(sim.state.monster.position, at)).toBeLessThan(1e-6);
    const late = run(sim, 0.3, (e) => has(e, 'playerCaught'));
    expect(has(late, 'playerCaught')).toBe(true);
    expect(sim.state.players.p0.status).toBe('caught');
    expect(sim.state.monster.mode).toBe('feeding');
    expect(sim.state.grab).toBeNull();
  });

  it('with no chance left, contact is an instant catch', () => {
    const { sim } = setup(1);
    sim.state.players.p0.secondChances = 0;
    place(sim, 'p0', 0, 0);
    sim.state.monster.position = v3(0.3, 0, 0.1);
    const ev = sim.step(DT);
    expect(has(ev, 'playerGrabbed')).toBe(false);
    expect(has(ev, 'playerCaught')).toBe(true);
  });

  it('a grabbed player counts as still in the house (a solo round does not end)', () => {
    const { sim } = grabbed(1);
    run(sim, 0.5);
    expect(sim.state.phase).toBe('playing');
  });

  it('only the struggle is possible in its grip (grab / flash actions are ignored)', () => {
    const { sim, level } = grabbed();
    holdCamera(sim, 5);
    const flash = sim.handleAction('p0', { type: 'flash', hand: 'right', position: v3(0, 1.4, -0.3), direction: v3(0, 0, -1) });
    expect(flash).toEqual([]);
    expect(sim.state.camera.film).toBe(5);
    const grab = sim.handleAction('p0', { type: 'grab', hand: 'left', position: level.cameraSpawn.position, reach: 2 });
    expect(grab).toEqual([]);
  });

  it('chances come back every round', () => {
    const { sim } = grabbed();
    run(sim, 3);
    expect(sim.state.players.p0.status).toBe('caught');
    sim.startRound();
    expect(sim.state.players.p0.secondChances).toBe(W.perRound);
    expect(sim.state.grab).toBeNull();
  });

  it('the one it holds leaving the game lets it go back to roaming', () => {
    const { sim } = grabbed(2);
    sim.removePlayer('p0');
    expect(sim.state.grab).toBeNull();
    expect(sim.state.monster.mode).toBe('wander');
  });
});

describe('second chance: pry free', () => {
  it('in time: free, empty-handed, it reels back stunned and deaf, then comes for you', () => {
    const { sim } = grabbed(1);
    holdCamera(sim, 4);
    const before = { ...sim.state.monster.position };
    const ev = sim.handleAction('p0', pry());
    const s = sim.state;
    expect(ev).toContainEqual(expect.objectContaining({ type: 'playerBrokeFree', id: 'p0', method: 'pry', by: null }));
    expect(ev).toContainEqual(expect.objectContaining({ type: 'drop', by: 'p0', what: 'camera' }));
    expect(s.players.p0.held.right).toBeNull();
    expect(s.grab).toBeNull();
    expect(s.monster.mode).toBe('stunned');
    expect(distXZ(s.monster.position, before)).toBeGreaterThan(W.recoil * 0.8);
    // Deaf while stunned: even a shout right next to it does nothing.
    sim.reportNoise({ source: 'voice', position: v3(0.5, 1.6, 0), loudness: NOISE.shout, playerId: 'p0' });
    run(sim, W.pryStun - 0.2);
    expect(s.monster.mode).toBe('stunned');
    // Then it charges at you, and this time there is no second chance.
    const after = run(sim, 4, (e) => has(e, 'playerCaught'));
    expect(after).toContainEqual(expect.objectContaining({ type: 'monsterAlert', mode: 'chase' }));
    expect(has(after, 'playerGrabbed')).toBe(false);
    expect(has(after, 'playerCaught')).toBe(true);
  });

  it('too late, someone else, or nobody grabbed: ignored', () => {
    const { sim } = grabbed(2);
    expect(sim.handleAction('p1', pry())).toEqual([]);
    expect(sim.state.monster.mode).toBe('grab');
    run(sim, W.window + W.latencyGrace + 0.1, (e) => has(e, 'playerCaught'));
    expect(sim.handleAction('p0', pry())).toEqual([]);
    expect(sim.state.players.p0.status).toBe('caught');

    const fresh = setup(1);
    expect(fresh.sim.handleAction('p0', pry())).toEqual([]);
  });

  it('a remote player’s pry still counts within the latency grace after the window', () => {
    const { sim } = grabbed();
    run(sim, W.window + W.latencyGrace * 0.5);
    expect(has(sim.handleAction('p0', pry()), 'playerBrokeFree')).toBe(true);
  });

  it('its recoil never goes through a wall', () => {
    const { sim, level } = setup(1);
    // Player in the hallway, monster between them and the north wall (z = -1.2, face at -1.1).
    place(sim, 'p0', 2, 0.1);
    sim.state.monster.position = v3(2, 0, -0.55);
    expect(has(sim.step(DT), 'playerGrabbed')).toBe(true);
    sim.handleAction('p0', pry());
    expect(sim.state.monster.position.z).toBeGreaterThan(-1.1 + 0.3);
    expect(level.bounds.min.z).toBeLessThan(sim.state.monster.position.z);
  });
});

describe('second chance: Last Flash', () => {
  const lastFlash = (hand: 'left' | 'right' = 'right'): PlayerAction => ({ type: 'breakFree', method: 'flash', hand, position: v3(0.1, 1.45, -0.25), direction: v3(1, 0.1, 0) });

  it('needs the camera in that hand and film; costs film, keeps the camera, flashes, stuns longer', () => {
    const { sim } = grabbed();
    holdCamera(sim, 5);
    expect(sim.handleAction('p0', lastFlash('left'))).toEqual([]);
    const ev = sim.handleAction('p0', lastFlash());
    const s = sim.state;
    expect(ev).toContainEqual(expect.objectContaining({ type: 'flash', by: 'p0' }));
    expect(ev).toContainEqual(expect.objectContaining({ type: 'playerBrokeFree', id: 'p0', method: 'flash' }));
    expect(s.camera.film).toBe(5 - W.flashFilmCost);
    expect(s.camera.holder).toBe('p0');
    expect(s.players.p0.held.right).toEqual({ kind: 'camera' });
    expect(s.monster.mode).toBe('stunned');
    run(sim, W.pryStun + 0.3);
    expect(s.monster.mode).toBe('stunned');
    run(sim, W.flashStun - W.pryStun);
    expect(s.monster.mode).not.toBe('stunned');
  });

  it('works with the last shot, but not with an empty camera or without the camera', () => {
    const one = grabbed();
    holdCamera(one.sim, 1);
    expect(has(one.sim.handleAction('p0', lastFlash()), 'playerBrokeFree')).toBe(true);
    expect(one.sim.state.camera.film).toBe(0);

    const empty = grabbed();
    holdCamera(empty.sim, 0);
    expect(empty.sim.handleAction('p0', lastFlash())).toEqual([]);

    const none = grabbed();
    expect(none.sim.handleAction('p0', lastFlash())).toEqual([]);
    expect(none.sim.state.monster.mode).toBe('grab');
  });

  it('ignores the flash cooldown (you may have just flashed)', () => {
    const { sim } = grabbed();
    holdCamera(sim, 3);
    sim.state.camera.lastFlashTime = sim.state.time;
    expect(has(sim.handleAction('p0', lastFlash()), 'playerBrokeFree')).toBe(true);
  });
});

describe('second chance: Loud Mode scream', () => {
  const scream = (sim: GameSim, loudness: number) =>
    sim.reportNoise({ source: 'voice', position: sim.state.players.p0.pose.head.position, loudness, playerId: 'p0' });

  it('off (default): screaming does nothing', () => {
    const { sim } = grabbed();
    expect(sim.state.loudMode).toBe(false);
    scream(sim, 1);
    const ev = sim.step(DT);
    expect(has(ev, 'playerBrokeFree')).toBe(false);
    expect(sim.state.monster.mode).toBe('grab');
  });

  it('on: a real scream breaks free, talking does not', () => {
    const { sim } = setup(1);
    sim.state.phase = 'lobby';
    sim.setLoudMode(true);
    sim.startRound();
    expect(sim.state.loudMode).toBe(true);
    place(sim, 'p0', 0, 0);
    sim.state.monster.position = v3(0.3, 0, 0.1);
    expect(has(sim.step(DT), 'playerGrabbed')).toBe(true);
    scream(sim, NOISE.talk);
    expect(has(sim.step(DT), 'playerBrokeFree')).toBe(false);
    scream(sim, W.screamLevel);
    const ev = sim.step(DT);
    expect(ev).toContainEqual(expect.objectContaining({ type: 'playerBrokeFree', id: 'p0', method: 'scream' }));
    expect(sim.state.monster.mode).toBe('stunned');
  });

  it('cannot be switched mid-round', () => {
    const { sim } = setup(1);
    sim.setLoudMode(true);
    expect(sim.state.loudMode).toBe(false);
  });
});

describe('second chance: a teammate rescues you', () => {
  it('a loud noise from a teammate nearby: it drops you and goes for them', () => {
    const { sim } = grabbed(2);
    place(sim, 'p1', 2.2, 0);
    sim.reportNoise({ source: 'item', position: v3(2.2, 1, 0), loudness: NOISE.itemDrop, playerId: 'p1' });
    const ev = sim.step(DT);
    const s = sim.state;
    expect(ev).toContainEqual(expect.objectContaining({ type: 'playerBrokeFree', id: 'p0', method: 'rescue', by: 'p1' }));
    expect(s.grab).toBeNull();
    expect(s.monster.mode).toBe('chase');
    expect(s.monster.targetPlayer).toBe('p1');
    // It ignores you for a moment (it is still right on top of you).
    run(sim, W.rescueSpare - 0.2);
    expect(s.players.p0.status).toBe('alive');
  });

  it('quiet noises or far-away ones do not count; nor do your own (Loud Mode off)', () => {
    const { sim } = grabbed(2);
    place(sim, 'p1', 1.5, 0);
    sim.reportNoise({ source: 'camera', position: v3(1.5, 1.4, 0), loudness: NOISE.cameraClick, playerId: 'p1' });
    sim.reportNoise({ source: 'voice', position: v3(0, 1.6, 0), loudness: 1, playerId: 'p0' });
    place(sim, 'p1', 9, 0);
    const far = 9 - 0.3;
    const quietFar = (HEARING.chaseRatio * far) / HEARING.rangeMeters - 0.05;
    sim.reportNoise({ source: 'voice', position: v3(9, 1.6, 0), loudness: Math.max(W.rescueLoudness, quietFar), playerId: 'p1' });
    expect(has(sim.step(DT), 'playerBrokeFree')).toBe(false);
    expect(sim.state.monster.mode).toBe('grab');
  });
});
