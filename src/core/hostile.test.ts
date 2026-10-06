/**
 * The host trusts nothing a client sends: poses, actions and noises from the network go through
 * the GameSim, which must neither explode nor be cheated by garbage, absurd or flooding input.
 */
import { describe, expect, it } from 'vitest';
import { PLAYER } from '../config';
import { createLevel } from './level';
import { dist3, distXZ, isFiniteVec3, v3 } from './math';
import { GameSim, makeSpawnPose, SIM_TUNING } from './sim';
import type { PlayerAction, PlayerPose, Vec3 } from './types';
import { LIMITS, sanitizeSimEvent, sanitizeWorldState } from './validate';

const SEED = 1234;

function setup() {
  const level = createLevel(SEED);
  const sim = new GameSim(level);
  sim.addPlayer('p0', 'P0', true);
  sim.addPlayer('p1', 'P1', true);
  sim.startRound();
  sim.state.monster.position = v3(-9.9, 0, -2.4); // far away in the bedroom
  return { level, sim };
}

function pose(x: number, z: number, right?: Vec3): PlayerPose {
  const p = makeSpawnPose(v3(x, 0, z), 0);
  p.left.tracked = p.right.tracked = true;
  if (right) p.right.position = { ...right };
  return p;
}

/** Put p0 next to the first fuse holding it in the right hand. */
function holdFuse(sim: GameSim) {
  const fuse = sim.state.items.find((i) => i.kind === 'fuse')!;
  const at = v3(fuse.position.x, fuse.position.y + 0.05, fuse.position.z);
  sim.setPlayerPose('p0', pose(fuse.position.x, fuse.position.z, at));
  sim.handleAction('p0', { type: 'grab', hand: 'right', position: at, reach: PLAYER.vrGrabReach });
  expect(fuse.where).toBe('held');
  return fuse;
}

const finiteDeep = (x: unknown): boolean => {
  if (typeof x === 'number') return Number.isFinite(x);
  if (Array.isArray(x)) return x.every(finiteDeep);
  if (x && typeof x === 'object') return Object.values(x).every(finiteDeep);
  return true;
};

describe('GameSim vs hostile poses', () => {
  it('a garbage hand position does not insert a held fuse from across the house', () => {
    const { sim } = setup();
    const fuse = holdFuse(sim);
    const bad = pose(fuse.position.x, fuse.position.z) as unknown as { right: { position: unknown } };
    // Strings survive JSON; NaN comparisons used to read as "close enough to the fuse box".
    bad.right.position = { x: 'a', y: 'b', z: 'c' };
    sim.setPlayerPose('p0', bad as unknown as PlayerPose);
    sim.step(1 / 30);
    expect(fuse.where).toBe('held');
    expect(sim.state.fusesInserted).toBe(0);
    expect(finiteDeep(sim.snapshot())).toBe(true);
  });

  it('survives structurally broken poses without throwing or storing garbage', () => {
    const { sim } = setup();
    const broken: unknown[] = [
      null,
      42,
      'pose',
      [],
      {},
      { head: null },
      { head: { position: { x: 1, y: 1 } } },
      { head: { position: { x: 0, y: 1.6, z: 5 } } }, // no rotation, no hands
      { head: { position: { x: 0, y: 1.6, z: 5 }, rotation: 'up' }, left: 7, right: { curls: 'fist', rotation: { x: 0, y: 0, z: 0, w: 0 } } },
      { head: { position: { x: 1e308, y: -1e308, z: 1e308 }, rotation: { x: NaN, y: 0, z: 0, w: 1 } } },
    ];
    for (const b of broken) {
      expect(() => sim.setPlayerPose('p1', b as PlayerPose)).not.toThrow();
      expect(() => sim.step(1 / 30)).not.toThrow();
      const p = sim.state.players.p1.pose;
      expect(finiteDeep(p)).toBe(true);
      expect(p.right.curls).toHaveLength(5);
      expect(Math.hypot(p.head.rotation.x, p.head.rotation.y, p.head.rotation.z, p.head.rotation.w)).toBeCloseTo(1);
    }
    expect(finiteDeep(sim.snapshot())).toBe(true);
  });

  it('keeps heads near the level and hands within arm reach of their head', () => {
    const { sim, level } = setup();
    const far = pose(0, 5);
    far.head.position = v3(5000, -300, -9000);
    sim.setPlayerPose('p1', far);
    const h = sim.state.players.p1.pose.head.position;
    expect(h.x).toBeLessThanOrEqual(level.bounds.max.x + LIMITS.headMargin);
    expect(h.y).toBeGreaterThanOrEqual(level.bounds.min.y - LIMITS.headMargin);
    expect(h.z).toBeGreaterThanOrEqual(level.bounds.min.z - LIMITS.headMargin);

    const longArm = pose(0, 5, v3(9, 1, -7));
    sim.setPlayerPose('p1', longArm);
    const p = sim.state.players.p1.pose;
    expect(dist3(p.right.position, p.head.position)).toBeLessThanOrEqual(LIMITS.handReach + 1e-9);
    // Legit poses pass through untouched.
    const legit = pose(0.5, 5.2, v3(0.7, 1.2, 4.8));
    sim.setPlayerPose('p1', legit);
    expect(sim.state.players.p1.pose).toEqual(legit);
  });

  it('remote clients cannot teleport, but legit sprinting is never limited', () => {
    const { sim } = setup();
    const start = { ...sim.state.players.p1.pose.head.position };
    // Teleport straight to the exit / across the house in one message.
    sim.setPlayerPose('p1', pose(0, -6), true);
    const after = sim.state.players.p1.pose.head.position;
    expect(distXZ(after, start)).toBeLessThanOrEqual(SIM_TUNING.moveBurst + 1e-9);
    // Hands move along with the clamped head.
    expect(dist3(sim.state.players.p1.pose.right.position, after)).toBeLessThan(1);
    // Keep insisting: it gets there at no more than maxMoveSpeed.
    let t = 0;
    while (distXZ(sim.state.players.p1.pose.head.position, v3(0, 0, -6)) > 0.01 && t < 10) {
      sim.step(0.05);
      t += 0.05;
      sim.setPlayerPose('p1', pose(0, -6), true);
    }
    expect(t).toBeGreaterThan((distXZ(start, v3(0, 0, -6)) - SIM_TUNING.moveBurst) / SIM_TUNING.maxMoveSpeed - 0.1);
    expect(t).toBeLessThan(5);

    // A legit client sprinting at 20 Hz, with a burst of 10 late packets, is followed exactly.
    let z = -6;
    for (let i = 0; i < 60; i++) {
      const burst = i >= 30 && i < 40;
      if (!burst) sim.step(0.05);
      z += PLAYER.sprintSpeed * 0.05;
      const p = pose(0, z);
      sim.setPlayerPose('p1', p, true);
      expect(sim.state.players.p1.pose.head.position).toEqual(p.head.position);
    }
    // The host's own (local) pose is trusted.
    sim.setPlayerPose('p0', pose(-9, -6));
    expect(sim.state.players.p0.pose.head.position.x).toBe(-9);
  });
});

describe('GameSim vs hostile actions', () => {
  it('cannot grab things far from the head (probe or reach pushed out)', () => {
    const { sim, level } = setup();
    const cam = level.cameraSpawn.position;
    const at = v3(cam.x, cam.y + 0.05, cam.z);
    // Stand 3 m from the camera table (clear line of sight across the foyer), claiming the
    // hand is right on the camera.
    sim.setPlayerPose('p0', pose(cam.x + 3, cam.z));
    expect(sim.handleAction('p0', { type: 'grab', hand: 'right', position: at, reach: PLAYER.vrGrabReach })).toEqual([]);
    expect(sim.handleAction('p0', { type: 'grab', hand: 'left', position: at, reach: 1e9 })).toEqual([]);
    expect(sim.state.camera.holder).toBeNull();
    // Hands nobody has, unknown actions, garbage reach: ignored.
    for (const bad of [
      { type: 'grab', hand: 'tail', position: at, reach: 0.35 },
      { type: 'grab', hand: '__proto__', position: at, reach: 0.35 },
      { type: 'teleport', hand: 'left', position: at },
      { type: 'grab', hand: 'left', position: at, reach: '1e9' },
      { type: 'flash', hand: 'left', position: at, direction: 'up' },
    ]) {
      expect(sim.handleAction('p0', bad as unknown as PlayerAction)).toEqual([]);
    }
    expect(sim.state.players.p0.held).toEqual({ left: null, right: null });
    // Desktop reach from a probe half a meter in front of the eyes still works.
    sim.setPlayerPose('p0', pose(cam.x + 1.8, cam.z));
    const head = sim.state.players.p0.pose.head.position;
    const probe = v3(head.x - 0.45, head.y - 0.2, head.z);
    expect(sim.handleAction('p0', { type: 'grab', hand: 'left', position: probe, reach: PLAYER.desktopGrabReach })).not.toEqual([]);
    expect(sim.state.camera.holder).toBe('p0');
  });

  it('cannot place items or flashes far away from the player', () => {
    const { sim, level } = setup();
    const fuse = holdFuse(sim);
    const head = sim.state.players.p0.pose.head.position;
    sim.handleAction('p0', { type: 'release', hand: 'right', position: v3(head.x + 30, 1, head.z) });
    expect(fuse.where).toBe('world');
    expect(dist3(fuse.position, head)).toBeLessThanOrEqual(LIMITS.handReach + 1.7);

    const cam = level.cameraSpawn.position;
    sim.setPlayerPose('p0', pose(-1.5, 6.5, v3(cam.x, cam.y + 0.1, cam.z)));
    sim.handleAction('p0', { type: 'grab', hand: 'right', position: v3(cam.x, cam.y + 0.1, cam.z), reach: PLAYER.vrGrabReach });
    expect(sim.state.camera.holder).toBe('p0');
    const ev = sim.handleAction('p0', { type: 'flash', hand: 'right', position: v3(-9, 1, -7), direction: v3(0, 0, -1) });
    const flash = ev.find((e) => e.type === 'flash');
    expect(flash).toBeTruthy();
    expect(dist3(flash!.type === 'flash' ? flash!.position : v3(), sim.state.players.p0.pose.head.position)).toBeLessThanOrEqual(
      LIMITS.handReach + 1e-9,
    );
    expect(isFiniteVec3(sim.state.camera.position)).toBe(true);
  });
});

describe('client-side sanitizers vs a legit host', () => {
  it('every snapshot and event of a played round passes through unchanged', () => {
    const { sim, level } = setup();
    const events: unknown[] = [];
    const check = () => {
      const snap = JSON.parse(JSON.stringify(sim.snapshot())); // as it arrives over the wire
      expect(sanitizeWorldState(snap, level.bounds)).toEqual(snap);
    };
    check();
    // Play: grab the camera, flash, pick up fuses, insert them, walk out; the monster roams.
    const cam = level.cameraSpawn.position;
    sim.setPlayerPose('p0', pose(-1.5, 6.5, v3(cam.x, cam.y + 0.1, cam.z)));
    events.push(...sim.handleAction('p0', { type: 'grab', hand: 'right', position: v3(cam.x, cam.y + 0.1, cam.z), reach: 0.35 }));
    events.push(...sim.handleAction('p0', { type: 'flash', hand: 'right', position: v3(cam.x, cam.y + 0.1, cam.z), direction: v3(0, 0, -1) }));
    events.push(...sim.handleAction('p0', { type: 'flash', hand: 'right', position: v3(cam.x, cam.y + 0.1, cam.z), direction: v3(0, 0, -1) }));
    sim.reportNoise({ source: 'voice', position: v3(0, 1.6, 5), loudness: 0.95, playerId: 'p1' });
    const box = level.fuseBox.position;
    for (const fuse of sim.state.items.filter((i) => i.kind === 'fuse')) {
      const at = v3(fuse.position.x, fuse.position.y + 0.05, fuse.position.z);
      sim.setPlayerPose('p0', pose(fuse.position.x, fuse.position.z, at));
      events.push(...sim.handleAction('p0', { type: 'grab', hand: 'left', position: at, reach: 0.35 }));
      check();
      const p = pose(box.x, box.z - 0.5);
      p.left.position = v3(box.x, box.y, box.z - 0.3);
      sim.setPlayerPose('p0', p);
      for (let i = 0; i < 10; i++) events.push(...sim.step(1 / 30));
      check();
    }
    expect(sim.state.exitOpen).toBe(true);
    for (let i = 0; i < 300; i++) {
      events.push(...sim.step(1 / 30));
      if (i % 30 === 0) check();
    }
    sim.setPlayerPose('p0', pose(0, 8.6));
    events.push(...sim.step(1 / 30));
    sim.state.monster.position = v3(0.7, 0, 5.6);
    sim.setPlayerPose('p1', pose(0.7, 5.6));
    // Grabbed: p1 pries free mid-snapshot, then stays put and gets caught when the stun ends.
    for (let i = 0; i < 3; i++) events.push(...sim.step(1 / 30));
    check();
    events.push(...sim.handleAction('p1', { type: 'breakFree', method: 'pry', hand: 'right', position: v3(0.7, 1.6, 5.6), direction: v3(0, 0, -1) }));
    check();
    for (let i = 0; i < 150; i++) {
      events.push(...sim.step(1 / 30));
      if (i % 10 === 0) check();
    }
    check();
    const types = new Set(events.map((e) => (e as { type: string }).type));
    for (const t of ['pickup', 'flash', 'dryFire', 'fuseInserted', 'exitOpened', 'monsterAlert', 'playerEscaped', 'playerGrabbed', 'playerBrokeFree', 'playerCaught', 'phase']) {
      expect(types).toContain(t);
    }
    for (const e of events) {
      const wire = JSON.parse(JSON.stringify(e));
      expect(sanitizeSimEvent(wire, level.bounds)).toEqual(wire);
    }
  });
});
