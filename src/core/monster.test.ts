import { describe, expect, it } from 'vitest';
import { GAME, HEARING, MONSTER, NOISE, PLAYER } from '../config';
import { createLevel } from './level';
import { distXZ, makeRng, v3 } from './math';
import { distToBox } from './physics';
import { astarStats, navGridFor, surfaceTop, underLintel } from './navgrid';
import { GameSim, makeSpawnPose } from './sim';
import type { Box, LevelData, MonsterState, PlayerId, SimEvent, Vec3 } from './types';

const SEED = 1234;

function setup(players = 1, level: LevelData = createLevel(SEED), opts = {}) {
  const sim = new GameSim(level, opts);
  for (let i = 0; i < players; i++) sim.addPlayer(`p${i}`, `Player ${i}`, true);
  sim.startRound();
  return { sim, level };
}

const place = (sim: GameSim, id: PlayerId, x: number, z: number) => sim.setPlayerPose(id, makeSpawnPose(v3(x, 0, z), 0));
const head = (x: number, z: number) => v3(x, PLAYER.eyeHeight, z);
const noise = (sim: GameSim, pos: Vec3, loudness: number, id: PlayerId | null = null) =>
  sim.reportNoise({ source: id ? 'voice' : 'item', position: pos, loudness, playerId: id });

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

function monsterClips(level: LevelData, m: MonsterState): boolean {
  const g = navGridFor(level);
  const r = (m.posture === 'crawl' ? MONSTER.crawlRadius : MONSTER.radius) - 0.02;
  const { x, z } = m.position;
  if (g.hard.some((b) => distToBox(b, x, z) < r)) return true;
  return m.posture !== 'crawl' && g.climb.some((b) => distToBox(b, x, z) < r);
}

const wall = (x0: number, z0: number, x1: number, z1: number): Box => ({ kind: 'wall', min: v3(x0, 0, z0), max: v3(x1, 2.8, z1) });

/** A walled 2 m wide corridor along +X from x = -1 to 9 (plus extra boxes); exit door in the east end. */
function corridor(extra: Box[] = []): LevelData {
  const door: Box = { kind: 'wall', min: v3(8.8, 0, -0.5), max: v3(9, 2.4, 0.5) };
  return {
    id: 'corridor',
    seed: 3,
    bounds: { min: v3(-1.2, 0, -1.4), max: v3(9.2, 2.8, 1.4) },
    boxes: [wall(-1, -1.2, 9, -1.0), wall(-1, 1.0, 9, 1.2), wall(-1, -1.2, -0.8, 1.2), wall(8.8, -1.2, 9, 1.2), ...extra],
    nav: [],
    playerSpawns: [0, 1, 2, 3].map((i) => ({ position: v3(7, 0, -0.6 + i * 0.4), yaw: 0 })),
    monsterSpawn: v3(0, 0, 0),
    fuseSpawns: [],
    fuseBox: { position: v3(8.7, 1.4, 0.8), yaw: 0 },
    exit: { door, zone: { min: v3(9.1, 0, -0.5), max: v3(9.2, 3, 0.5) } },
    windows: [],
  };
}

describe('sweep (telegraphed long-armed swipe)', () => {
  /**
   * Monster charges a shout 2 m ahead; the shouter steps silently to `to` (x, z), or (with
   * `during`) is somewhere else when the swipe winds up.
   */
  function sweepAt(extra: Box[], to: [number, number], during?: [number, number]) {
    const { sim, level } = setup(1, corridor(extra));
    const m = sim.state.monster;
    m.position = v3(0, 0, 0);
    m.yaw = -Math.PI / 2; // facing +X
    place(sim, 'p0', 2, 0);
    noise(sim, head(2, 0), NOISE.shout, 'p0');
    expect(m.mode).toBe('chase');
    place(sim, 'p0', to[0], to[1]);
    runUntil(sim, 2, () => m.act === 'sweep');
    expect(m.act).toBe('sweep');
    const start = m.actStart;
    if (during) place(sim, 'p0', during[0], during[1]);
    return { sim, level, m, start };
  }

  it('catches a silent player in reach in front, but only after the wind-up', () => {
    const { sim, m, start } = sweepAt([], [3.1, 0]);
    expect(distXZ(m.position, sim.state.players.p0.pose.head.position)).toBeGreaterThan(HEARING.catchRadius);
    expect(distXZ(m.position, sim.state.players.p0.pose.head.position)).toBeLessThan(MONSTER.sweepReach);
    expect(m.focus).not.toBeNull();
    // Wind-up: time to react, nobody is caught.
    runUntil(sim, start + MONSTER.sweepWindup - 0.05 - sim.state.time);
    expect(sim.state.players.p0.status).toBe('alive');
    expect(m.act).toBe('sweep');
    // Strike.
    const ev = runUntil(sim, MONSTER.sweepStrike + 0.1, (e) => has(e, 'playerCaught'));
    expect(ev).toContainEqual(expect.objectContaining({ type: 'playerCaught', id: 'p0' }));
    expect(sim.state.time - start).toBeGreaterThanOrEqual(MONSTER.sweepWindup);
    expect(m.mode).toBe('feeding');
  });

  it('never catches through a wall, nor behind it, nor out of reach', () => {
    // A wall between the monster and the player (they are 1.35 m apart).
    const a = sweepAt([wall(2.4, -1.0, 2.6, 1.0)], [3.1, 0]);
    runUntil(a.sim, SWEEP_S + 0.3);
    expect(a.sim.state.players.p0.status).toBe('alive');
    // Behind its back.
    const b = sweepAt([], [3.1, 0], [0.6, 0]);
    expect(distXZ(b.m.position, b.sim.state.players.p0.pose.head.position)).toBeLessThan(MONSTER.sweepReach);
    runUntil(b.sim, SWEEP_S + 0.3);
    expect(b.sim.state.players.p0.status).toBe('alive');
    // Just out of reach.
    const c = sweepAt([], [3.8, 0]);
    runUntil(c.sim, SWEEP_S + 0.3);
    expect(c.sim.state.players.p0.status).toBe('alive');
  });
});

const SWEEP_S = MONSTER.sweepWindup + MONSTER.sweepStrike + MONSTER.sweepRecover;

describe('stalking faint sounds', () => {
  it('creeps (slow, near-silent gait) toward a faint sound, stops to listen, then lunges when it hears it again', () => {
    const { sim } = setup(1);
    place(sim, 'p0', 7, 6.5);
    const m = sim.state.monster;
    m.position = v3(-3.45, 0, 0);
    const at = v3(0.6, 1.0, 0);
    expect(sim.hearingRatio(at, 0.2)).toBeLessThan(MONSTER.stalkRatio);
    noise(sim, at, 0.2);
    expect(m.mode).toBe('investigate');
    expect(sim.monsterDebug().stalk).toBe(true);
    // It freezes and turns its head toward the sound first.
    sim.step(1 / 30);
    expect(m.act).toBe('listen');
    expect(distXZ(m.focus!, at)).toBeLessThan(0.01);
    let moving = 0;
    let listened = false;
    let wasMoving = false;
    runUntil(sim, 6, () => {
      if (m.speed > 0.15) {
        moving++;
        wasMoving = true;
        expect(m.gait).toBe('creep');
        expect(m.speed).toBeLessThanOrEqual(MONSTER.creepSpeed * sim.monsterDebug().speedMul + 1e-6);
      }
      if (wasMoving && m.act === 'listen' && m.speed === 0) listened = true;
      return false;
    });
    expect(moving).toBeGreaterThan(30);
    expect(listened).toBe(true);
    expect(distXZ(m.position, at)).toBeLessThan(MONSTER.lungeRange);
    // Heard again (still faint): it commits and charges.
    const ev: SimEvent[] = [];
    sim.reportNoise({ source: 'item', position: at, loudness: 0.15, playerId: null });
    ev.push(...sim.step(1 / 30));
    expect(m.mode).toBe('chase');
    expect(ev).toContainEqual(expect.objectContaining({ type: 'monsterAlert', mode: 'chase' }));
  });
});

describe('body over furniture and through doorways', () => {
  it('climbs over low furniture that blocks the way (position.y follows the top, crawl + climb)', () => {
    const bed: Box = { kind: 'furniture', style: 'bed', min: v3(3, 0, -1.0), max: v3(5, 0.6, 1.0) };
    const { sim, level } = setup(1, corridor([bed]));
    const m = sim.state.monster;
    place(sim, 'p0', 7.5, 0.6);
    noise(sim, v3(7, 1, 0), 0.5);
    expect(m.mode).toBe('investigate');
    let maxY = 0;
    let climbed = false;
    runUntil(sim, 25, () => {
      maxY = Math.max(maxY, m.position.y);
      if (m.position.y > 0.05) {
        expect(m.posture).toBe('crawl');
        expect(m.act === 'climb' || m.act === 'listen' || m.act === 'sniff' || m.act === 'search' || m.act === 'sweep').toBe(true);
        if (m.act === 'climb') climbed = true;
      }
      expect(monsterClips(level, m)).toBe(false);
      return m.position.x > 6.2;
    });
    expect(m.position.x).toBeGreaterThan(6.2);
    expect(climbed).toBe(true);
    expect(maxY).toBeGreaterThan(0.55);
    expect(maxY).toBeLessThanOrEqual(0.6 + 1e-9);
    runUntil(sim, 1);
    expect(m.position.y).toBe(0);
    expect(m.act).not.toBe('climb');
  });

  it('never climbs tall furniture (a wardrobe across the corridor stops it)', () => {
    const wardrobe: Box = { kind: 'furniture', style: 'cabinet', min: v3(3, 0, -1.0), max: v3(5, 1.9, 1.0) };
    const { sim } = setup(1, corridor([wardrobe]));
    const m = sim.state.monster;
    noise(sim, v3(7, 1, 0), 0.5);
    let maxX = 0;
    runUntil(sim, 15, () => {
      maxX = Math.max(maxX, m.position.x);
      expect(m.position.y).toBe(0);
      return false;
    });
    expect(maxX).toBeLessThan(3 - MONSTER.crawlRadius + 0.02);
  });

  it('ducks under door lintels (slower there) and stands tall in the open', () => {
    const { sim, level } = setup(1);
    const g = navGridFor(level);
    place(sim, 'p0', 7, 6.5);
    const m = sim.state.monster;
    m.position = v3(-3.6, 0, -3.0); // storage room
    noise(sim, v3(-3.45, 1.0, 0.6), 0.3); // hallway, through the storage door
    expect(m.mode).toBe('investigate');
    let ducked = 0;
    let tall = 0;
    runUntil(sim, 8, () => {
      const under = underLintel(g, m.position.x, m.position.z, MONSTER.radius, m.position.y + MONSTER.standHeight);
      if (m.posture !== 'crawl') expect(m.posture).toBe(under ? 'duck' : 'tall');
      if (m.posture === 'duck') {
        ducked++;
        expect(m.speed).toBeLessThanOrEqual(MONSTER.investigateSpeed * MONSTER.duckSpeedMul + 1e-6);
      }
      if (m.posture === 'tall' && m.speed > 1) tall++;
      return distXZ(m.position, v3(-3.45, 0, 0.6)) < 0.3;
    });
    expect(ducked).toBeGreaterThan(3);
    expect(tall).toBeGreaterThan(3);
  });

  it('gets a talker squeezed between the study desk and the wall (crawls in or climbs over)', () => {
    const { sim, level } = setup(1);
    const m = sim.state.monster;
    m.position = v3(0.2, 0, -4.2); // study
    place(sim, 'p0', 3.55, -5.9);
    let low = false;
    let caught = false;
    for (let t = 0; t < 20 && !caught; t += 1 / 30) {
      if (Math.abs(t % 1.5) < 1 / 30) noise(sim, head(3.55, -5.9), NOISE.talk, 'p0');
      for (const e of sim.step(1 / 30)) if (e.type === 'playerCaught') caught = true;
      if (m.posture === 'crawl') low = true;
      expect(monsterClips(level, m)).toBe(false);
    }
    expect(caught).toBe(true);
    expect(low).toBe(true);
  });
});

describe('lurking', () => {
  it('sometimes waits motionless by a doorway or in a corner after losing someone, then moves on', () => {
    let lurks = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { sim } = setup(1, createLevel(seed));
      const m = sim.state.monster;
      m.position = v3(-3.45, 0, 0);
      place(sim, 'p0', 0, 0);
      noise(sim, head(0, 0), NOISE.shout, 'p0');
      place(sim, 'p0', 7, 6.5); // slips away silently
      let lurkStart = -1;
      let lurkEnd = -1;
      runUntil(sim, 50, () => {
        if (m.act === 'lurk') {
          if (lurkStart < 0) lurkStart = sim.state.time;
          expect(m.speed).toBe(0);
          expect(m.gait).toBe('still');
          expect(m.focus).not.toBeNull();
          expect(m.mode).toBe('investigate');
        } else if (lurkStart >= 0 && lurkEnd < 0) lurkEnd = sim.state.time;
        return lurkEnd >= 0 && m.mode === 'wander';
      });
      if (lurkStart < 0) continue;
      lurks++;
      expect(lurkEnd).toBeGreaterThan(lurkStart);
      expect(lurkEnd - lurkStart).toBeLessThanOrEqual(MONSTER.lurkTime[1] + 0.1);
      expect(m.mode).toBe('wander');
      expect(sim.state.players.p0.status).toBe('alive');
    }
    expect(lurks).toBeGreaterThan(0);
  });

  it('lunges from a lurk at a sound it would only investigate otherwise', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { sim } = setup(1, createLevel(seed));
      const m = sim.state.monster;
      m.position = v3(-3.45, 0, 0);
      place(sim, 'p0', 0, 0);
      noise(sim, head(0, 0), NOISE.shout, 'p0');
      place(sim, 'p0', 7, 6.5);
      runUntil(sim, 40, () => m.act === 'lurk' || m.mode === 'wander');
      if (m.act !== 'lurk') continue;
      // A noise 3 m in front of it, between the lurk and chase thresholds.
      const at = v3(m.position.x - Math.sin(m.yaw) * 3, 1.2, m.position.z - Math.cos(m.yaw) * 3);
      const r1 = sim.hearingRatio(at, 1);
      if (r1 <= 0) continue;
      const loud = 1.9 / r1; // the ratio is linear in loudness
      const r = sim.hearingRatio(at, loud);
      if (r < MONSTER.lurkChaseRatio || r >= HEARING.chaseRatio) continue; // wall in the way
      noise(sim, at, loud);
      expect(m.mode).toBe('chase');
      return;
    }
    throw new Error('no lurk found to test');
  });
});

describe('chase prediction', () => {
  it('aims ahead of a runner who keeps making noise instead of tail-chasing', () => {
    const { sim } = setup(1);
    const m = sim.state.monster;
    m.position = v3(-8, 0, 0);
    m.yaw = -Math.PI / 2;
    place(sim, 'p0', -4, 0);
    noise(sim, head(-4, 0), NOISE.shout, 'p0');
    expect(m.mode).toBe('chase');
    let x = -4;
    let led = 0;
    for (let i = 0; i < 16 && x < 9; i++) {
      x += 0.7;
      place(sim, 'p0', x, 0);
      sim.reportNoise({ source: 'footstep', position: v3(x, 0, 0), loudness: NOISE.sprintStep, playerId: 'p0' });
      runUntil(sim, 0.7 / PLAYER.sprintSpeed, () => {
        if (m.mode === 'chase' && m.target && m.target.x > x + 0.5) led++;
        return false;
      });
      if (sim.state.players.p0.status !== 'alive') break;
    }
    expect(led).toBeGreaterThan(0);
  });
});

describe('escalation and frenzy', () => {
  it('gets faster as fuses go in and as the round drags on', () => {
    const { sim } = setup(1);
    const s = sim.state;
    expect(sim.monsterDebug().escalation).toBe(0);
    expect(sim.monsterDebug().speedMul).toBe(1);
    s.fusesInserted = s.fusesRequired;
    const fused = sim.monsterDebug().speedMul;
    expect(fused).toBeGreaterThan(1.05);
    s.fusesInserted = 0;
    place(sim, 'p0', 60, 60);
    runUntil(sim, MONSTER.escalationTime + 1, () => false, 1 / 10);
    const late = sim.monsterDebug();
    expect(late.escalation).toBeGreaterThan(0.3);
    expect(late.speedMul).toBeGreaterThan(1.03);
    s.fusesInserted = s.fusesRequired;
    expect(sim.monsterDebug().escalation).toBeCloseTo(1, 5);
    expect(sim.monsterDebug().speedMul).toBeCloseTo(1 + MONSTER.escalationSpeed, 5);
    // And it really runs faster.
    s.monster.position = v3(-8, 0, 0);
    s.monster.yaw = -Math.PI / 2;
    place(sim, 'p0', -1, 0);
    noise(sim, head(-1, 0), NOISE.shout, 'p0');
    expect(s.monster.mode).toBe('chase');
    let max = 0;
    runUntil(sim, 1.5, () => ((max = Math.max(max, s.monster.speed)), false));
    expect(max).toBeGreaterThan(MONSTER.chaseSpeed * 1.1);
    expect(max).toBeLessThanOrEqual(MONSTER.chaseSpeed * (1 + MONSTER.escalationSpeed) + 1e-6);
  });

  it('goes into a frenzy when the exit opens: comes for the door, faster, charges at less', () => {
    const { sim, level } = setup(1, createLevel(SEED), { fusesRequired: 1 });
    const s = sim.state;
    s.monster.position = v3(-9.9, 0, -2.4);
    const fuse = s.items.find((i) => i.kind === 'fuse')!;
    const at = v3(fuse.position.x, fuse.position.y + 0.05, fuse.position.z);
    const pose = makeSpawnPose(v3(fuse.position.x, 0, fuse.position.z), 0);
    pose.right.position = at;
    sim.setPlayerPose('p0', pose);
    sim.handleAction('p0', { type: 'grab', hand: 'right', position: at, reach: PLAYER.vrGrabReach });
    const box = level.fuseBox.position;
    const p2 = makeSpawnPose(v3(box.x, 0, box.z - 0.5), 0);
    p2.right.position = v3(box.x, box.y, box.z - 0.3);
    sim.setPlayerPose('p0', p2);
    const ev = sim.step(1 / 30);
    expect(has(ev, 'exitOpened')).toBe(true);
    const d = sim.monsterDebug();
    expect(d.frenzy).toBe(true);
    expect(d.speedMul).toBeGreaterThanOrEqual(MONSTER.frenzySpeed);
    expect(['investigate', 'chase']).toContain(s.monster.mode);
    expect(s.monster.alert).toBe(1);
    // A sound it would only investigate normally makes it charge now.
    place(sim, 'p0', 60, 60);
    const m = s.monster;
    m.position = v3(-3.45, 0, 0);
    sim.step(1 / 30);
    const spot = v3(0, 1.6, 0);
    const loud = 1.9 / sim.hearingRatio(spot, 1); // the ratio is linear in loudness
    const r = sim.hearingRatio(spot, loud);
    expect(r).toBeLessThan(HEARING.chaseRatio);
    expect(r).toBeGreaterThan(HEARING.chaseRatio * MONSTER.frenzyChaseRatio);
    m.mode = 'wander';
    sim.reportNoise({ source: 'item', position: spot, loudness: loud, playerId: null });
    expect(m.mode).toBe('chase');
  });
});

describe('body language stays truthful', () => {
  it('gait / posture / act / focus match what its body is doing, over a busy round', () => {
    const level = createLevel(77);
    const g = navGridFor(level);
    const { sim } = setup(4, level, { randomMonsterSpawn: true });
    const rng = makeRng(5);
    const stand: number[] = [];
    for (let i = 0; i < g.stand.length; i++) if (g.stand[i] && g.allClear[i] > 0.35) stand.push(i);
    const seen = { acts: new Set<string>(), gaits: new Set<string>(), postures: new Set<string>() };
    for (let k = 0; k < 30 * 240; k++) {
      if (k % 90 === 0) {
        for (let i = 0; i < 4; i++) {
          const id = `p${i}`;
          sim.state.players[id].status = 'alive';
          const c = stand[Math.floor(rng() * stand.length)];
          const x = g.ox + ((c % g.w) + 0.5) * g.cell;
          const z = g.oz + (Math.floor(c / g.w) + 0.5) * g.cell;
          sim.setPlayerPose(id, makeSpawnPose(v3(x, 0, z), rng() * 6));
          const r = rng();
          if (r < 0.25) noise(sim, head(x, z), NOISE.talk * (0.3 + rng()), id);
          else if (r < 0.4) sim.reportNoise({ source: 'footstep', position: v3(x, 0, z), loudness: NOISE.walkStep, playerId: id });
        }
      }
      sim.step(1 / 30);
      if (sim.state.phase !== 'playing') sim.startRound();
      const m = sim.state.monster;
      const { x, z } = m.position;
      seen.acts.add(m.act);
      seen.gaits.add(m.gait);
      seen.postures.add(m.posture);
      const onFurniture = m.position.y > 0.01 || surfaceTop(g, x, z, 0.12) > 0.01;
      if (m.act === 'climb') expect(onFurniture).toBe(true);
      if (m.position.y > 0.05) {
        expect(m.posture).toBe('crawl');
        expect(m.act).not.toBe('none');
      }
      const under = underLintel(g, x, z, MONSTER.radius, m.position.y + MONSTER.standHeight);
      if (m.posture === 'duck') expect(under).toBe(true);
      if (under) expect(m.posture).not.toBe('tall');
      if (['listen', 'sniff', 'search', 'sweep', 'lurk'].includes(m.act)) expect(m.focus).not.toBeNull();
      if (m.gait === 'still') expect(m.speed).toBeLessThan(0.05);
      else expect(m.speed).toBeGreaterThan(0.01);
      if (m.gait === 'run') expect(m.speed).toBeGreaterThan(0.6);
      if (m.gait === 'creep') expect(m.speed).toBeLessThan(MONSTER.investigateSpeed);
      expect(m.actStart).toBeLessThanOrEqual(sim.state.time + 1e-9);
      expect(monsterClips(level, m)).toBe(false);
    }
    for (const a of ['none', 'listen']) expect(seen.acts).toContain(a);
    for (const gt of ['still', 'creep', 'walk', 'run']) expect(seen.gaits).toContain(gt);
    for (const p of ['tall', 'duck']) expect(seen.postures).toContain(p);
  });

  it('feeds still and quiet after a catch, then patrols again', () => {
    const { sim } = setup(2);
    const m = sim.state.monster;
    m.position = v3(0, 0, 0);
    place(sim, 'p1', 7, 6.5);
    place(sim, 'p0', 0.3, 0.3);
    expect(has(sim.step(1 / 30), 'playerCaught')).toBe(true);
    expect(m.mode).toBe('feeding');
    expect(m.gait).toBe('still');
    expect(m.focus).not.toBeNull();
    runUntil(sim, GAME.feedingTime + 0.2);
    expect(m.mode).toBe('wander');
  });
});

describe('performance', () => {
  it('a normal 4-player round stays far under the per-tick budget', () => {
    const level = createLevel(5);
    const g = navGridFor(level);
    const { sim } = setup(4, level, { randomMonsterSpawn: true });
    const rng = makeRng(11);
    const stand: number[] = [];
    for (let i = 0; i < g.stand.length; i++) if (g.stand[i] && g.allClear[i] > 0.4) stand.push(i);
    const pos = [0, 1, 2, 3].map(() => stand[Math.floor(rng() * stand.length)]);
    const ticks = 30 * 300;
    // CPU time when available (wall time suffers on a busy machine), else wall time.
    const proc = (globalThis as { process?: { cpuUsage(prev?: unknown): { user: number; system: number } } }).process;
    const c0 = proc?.cpuUsage();
    const searches = astarStats.searches;
    const t0 = performance.now();
    for (let k = 0; k < ticks; k++) {
      // Players drift between spots, stepping (and now and then talking) as they go.
      for (let i = 0; i < 4; i++) {
        if (k % 45 === i * 10) {
          pos[i] = stand[Math.floor(rng() * stand.length)];
          const x = g.ox + ((pos[i] % g.w) + 0.5) * g.cell;
          const z = g.oz + (Math.floor(pos[i] / g.w) + 0.5) * g.cell;
          sim.setPlayerPose(`p${i}`, makeSpawnPose(v3(x, 0, z), 0));
          sim.reportNoise({ source: 'footstep', position: v3(x, 0, z), loudness: NOISE.sneakStep, playerId: `p${i}` });
          if (rng() < 0.15) noise(sim, head(x, z), NOISE.whisper * 2, `p${i}`);
        }
      }
      sim.step(1 / 30);
      if (sim.state.phase !== 'playing') {
        for (const p of Object.values(sim.state.players)) p.status = 'alive';
        sim.startRound();
      }
    }
    const wall = (performance.now() - t0) / ticks;
    const c1 = proc?.cpuUsage(c0);
    const perTick = c1 ? (c1.user + c1.system) / 1000 / ticks : wall;
    const plans = astarStats.searches - searches;
    console.log(
      `sim tick: ${(perTick * 1000).toFixed(1)} us CPU (${(wall * 1000).toFixed(1)} us wall) average over ${ticks} ticks; ` +
        `${plans} A* plans (${((plans * 30) / ticks).toFixed(2)} per second)`,
    );
    // Budget: well under 0.5 ms per tick on desktop (measured ~0.01 ms; generous for busy CI).
    expect(perTick).toBeLessThan(0.5);
  });
});
