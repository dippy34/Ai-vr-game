/**
 * "No dead spots": wherever a player stands in the house, the monster can get them.
 *
 *  - Geometric: every bit of player-standable floor is within catch range of a spot the monster's
 *    body fits in (upright, ducking, crawling or climbing), with no wall in between.
 *  - Behavioral: a player who keeps TALKING (voice 0.6 every 1.5 s at head height) anywhere in
 *    the house is caught, with the monster starting across the house. Sampled on a 1 m grid
 *    over every room plus the spots where the old nav-graph AI failed, for a few seeds.
 *
 * Before the nav grid (nav-node graph + straight-line sliding), the same full scan (0.5 m grid,
 * 899 spots) left 256 spots uncaught after 40 s (153 after 60 s), average 27 s.
 */

import { describe, expect, it } from 'vitest';
import { HEARING, PLAYER } from '../config';
import { HOUSE_ROOMS, createLevel, roomAt } from './level';
import { v3 } from './math';
import { navGridFor, nearestCell } from './navgrid';
import { circleBlocked } from './physics';
import { GameSim, makeSpawnPose } from './sim';

/** Where the old AI failed (corners, behind beds / couches / tables) and the tightest nooks. */
const KNOWN_HARD: [number, number][] = [
  [-10.25, -7.25], [-10.25, -3.25], [-9.25, -5.75], [-8.25, -4.75], // bedroom
  [-10.25, 4.25], [-10.25, 5.75], [-9.25, 7.25], [-8.75, 6.75], [-10.5, 1.75], // living
  [-4.4, -6.6], [-2.5, -6.6], // bathroom
  [9.75, -6.75], [4.75, -6.75], [8.75, -5.75], [9.75, -3.25], // kitchen
  [9.75, 4.25], [8.75, 6.75], [4.25, 7.25], [7.25, 6.75], [9.25, 6.25], // dining
  [3.55, -5.9], [3.5, -6.6], // study: between the desk and the wall
];

/** Runs: level seed (drives the monster's choices) and the monster's start z (x = +-9, across). */
const RUNS: [number, number][] = [
  [1234, -5],
  [7, -5],
  [99, 5],
];

const TALK = 0.6;
const TALK_EVERY = 1.5;
const LIMIT = 50;

describe('no dead spots', () => {
  it('geometric: all standable floor is within catch range of somewhere its body fits', () => {
    const level = createLevel(1234);
    const g = navGridFor(level);
    let tried = 0;
    const bad: string[] = [];
    for (let x = level.bounds.min.x + 0.1; x < level.bounds.max.x; x += 0.25) {
      for (let z = level.bounds.min.z + 0.1; z < 7.95; z += 0.25) {
        if (!roomAt(x, z) || circleBlocked(level, v3(x, PLAYER.eyeHeight, z), PLAYER.radius)) continue;
        tried++;
        // nearestCell only returns cells the body fits in and (here) with no wall between.
        if (nearestCell(g, x, z, HEARING.catchRadius - 0.05, true) < 0) bad.push(`(${x.toFixed(2)}, ${z.toFixed(2)})`);
      }
    }
    expect(tried).toBeGreaterThan(3000);
    expect(bad).toEqual([]);
  });

  it('behavioral: a talking player anywhere is caught, fast once heard', () => {
    const level = createLevel(1234);
    const spots: [number, number][] = [...KNOWN_HARD];
    for (let x = level.bounds.min.x + 0.35; x < level.bounds.max.x; x += 1) {
      for (let z = level.bounds.min.z + 0.35; z < 7.9; z += 1) spots.push([x, z]);
    }
    const free = spots.filter(([x, z]) => roomAt(x, z) && !circleBlocked(level, v3(x, PLAYER.eyeHeight, z), PLAYER.radius));
    const rooms = new Set(free.map(([x, z]) => roomAt(x, z)));
    for (const r of HOUSE_ROOMS) expect(rooms).toContain(r.name);

    const missed: string[] = [];
    let runs = 0;
    let total = 0;
    let worst = 0;
    let worstAfter = 0;
    let after = 0;
    const t0 = performance.now();
    for (const [seed, mz] of RUNS) {
      const L = createLevel(seed);
      for (const [x, z] of free) {
        const sim = new GameSim(L, { noiseMemory: false });
        sim.addPlayer('p', 'P', true);
        sim.startRound();
        sim.setPlayerPose('p', makeSpawnPose(v3(x, 0, z), 0));
        sim.state.monster.position = v3(x < 0 ? 9 : -9, 0, mz);
        const head = v3(x, PLAYER.eyeHeight, z);
        let t = 0;
        let heard = -1;
        let caught = false;
        let next = 0;
        while (t < LIMIT && !caught) {
          if (t >= next) {
            sim.reportNoise({ source: 'voice', position: head, loudness: TALK, playerId: 'p' });
            next += TALK_EVERY;
            if (heard < 0 && sim.state.lastHeard) heard = t;
          }
          for (const e of sim.step(1 / 30)) if (e.type === 'playerCaught') caught = true;
          t += 1 / 30;
        }
        runs++;
        total += t;
        worst = Math.max(worst, t);
        if (!caught) missed.push(`seed ${seed}: (${x.toFixed(2)}, ${z.toFixed(2)}) ${roomAt(x, z)}`);
        else if (heard >= 0) {
          after += t - heard;
          worstAfter = Math.max(worstAfter, t - heard);
        }
      }
    }
    const avg = total / runs;
    console.log(
      `dead-spot scan: ${runs} runs (${free.length} spots x ${RUNS.length} seeds) in ${((performance.now() - t0) / 1000).toFixed(1)} s: ` +
        `missed ${missed.length}; time to catch avg ${avg.toFixed(1)} s, max ${worst.toFixed(1)} s; ` +
        `after first hearing avg ${(after / runs).toFixed(1)} s, max ${worstAfter.toFixed(1)} s`,
    );
    expect(missed).toEqual([]);
    // Once it hears you talking it gets you quickly (pathing, no snags on furniture).
    expect(worstAfter).toBeLessThan(15);
    // From across the house (it has to roam within earshot first: talk is not heard through
    // several walls), on average well under 20 s.
    expect(avg).toBeLessThan(20);
    expect(worst).toBeLessThan(LIMIT);
  }, 60000);
});
