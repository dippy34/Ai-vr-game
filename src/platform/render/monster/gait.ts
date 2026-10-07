/**
 * Reading the body-language contract (MonsterState.gait / posture / act) robustly, inferring what
 * the sim leaves at its defaults, and the per-gait stepping/body parameters.
 *
 * Pure: no three.js.
 */

import type { MonsterAct, MonsterGait, MonsterMode, MonsterPosture } from '../../../core/types';

const ACTS: ReadonlySet<string> = new Set(['none', 'listen', 'sniff', 'search', 'sweep', 'lurk', 'climb']);
const GAIT_NAMES: ReadonlySet<string> = new Set(['still', 'creep', 'walk', 'run']);
const POSTURES: ReadonlySet<string> = new Set(['tall', 'duck', 'crawl']);

/** Unknown / future act names read as 'none'. */
export const readAct = (a: unknown): MonsterAct => (typeof a === 'string' && ACTS.has(a) ? (a as MonsterAct) : 'none');
export const readGait = (g: unknown): MonsterGait => (typeof g === 'string' && GAIT_NAMES.has(g) ? (g as MonsterGait) : 'still');
export const readPosture = (p: unknown): MonsterPosture => (typeof p === 'string' && POSTURES.has(p) ? (p as MonsterPosture) : 'tall');

/** How each gait steps and carries the body. */
export interface GaitParams {
  /** Swing (foot in the air) duration, seconds. */
  swing: number;
  /** Desired stance (foot planted) duration, seconds: sets the stride at a given speed. */
  stance: number;
  /** Foot lift at mid-swing (m). */
  lift: number;
  /** Smallest error (m) that triggers a step. */
  minThr: number;
  /** Biped: both feet down at least this long between steps. */
  minDouble: number;
  /** Hips lowered from the standing height (m). */
  hipDrop: number;
  /** Extra forward hunch of the trunk (rad). */
  pitch: number;
  /** Heel raised during stance (rad): tiptoe creep. */
  tiptoe: number;
  /** Share of the swing spent hovering over the spot before placing it (deliberate creep). */
  hover: number;
  /** Half the stance width (m), biped. */
  stanceW: number;
  /** Body bob amplitude (m). */
  bob: number;
}

export const GAITS: Readonly<Record<MonsterGait, Readonly<GaitParams>>> = {
  still: { swing: 0.62, stance: 0.8, lift: 0.07, minThr: 0.16, minDouble: 0.25, hipDrop: 0.06, pitch: 0.12, tiptoe: 0, hover: 0, stanceW: 0.18, bob: 0.0 },
  creep: { swing: 0.95, stance: 1.0, lift: 0.1, minThr: 0.12, minDouble: 0.28, hipDrop: 0.2, pitch: 0.42, tiptoe: 0.42, hover: 0.3, stanceW: 0.16, bob: 0.012 },
  walk: { swing: 0.5, stance: 0.62, lift: 0.12, minThr: 0.16, minDouble: 0.07, hipDrop: 0.09, pitch: 0.3, tiptoe: 0, hover: 0, stanceW: 0.17, bob: 0.03 },
  run: { swing: 0.3, stance: 0.26, lift: 0.2, minThr: 0.25, minDouble: 0, hipDrop: 0.2, pitch: 0.55, tiptoe: 0.25, hover: 0, stanceW: 0.15, bob: 0.05 },
};

/** Quadruped (all fours) stepping: crawling and running. */
export const QUAD_GAITS: Readonly<Record<'crawl' | 'gallop', Readonly<GaitParams>>> = {
  crawl: { swing: 0.55, stance: 0.9, lift: 0.1, minThr: 0.14, minDouble: 0.12, hipDrop: 0, pitch: 0, tiptoe: 0.2, hover: 0.15, stanceW: 0.3, bob: 0.015 },
  gallop: { swing: 0.24, stance: 0.24, lift: 0.18, minThr: 0.3, minDouble: 0, hipDrop: 0, pitch: 0, tiptoe: 0.3, hover: 0, stanceW: 0.3, bob: 0.06 },
};

export function lerpGait(a: GaitParams, b: GaitParams, t: number, out: GaitParams): GaitParams {
  for (const k of Object.keys(out) as (keyof GaitParams)[]) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

export const newGaitParams = (): GaitParams => ({ ...GAITS.walk });

/**
 * The gait to animate: the contract's when the sim sets one, otherwise inferred from the measured
 * speed (with hysteresis so it never flickers between two).
 */
export class GaitSelector {
  gait: MonsterGait = 'still';
  /** Seconds in the current gait. */
  age = 0;
  /** Seconds it has been (nearly) stopped. */
  private stopped = 0;

  update(contract: MonsterGait, speed: number, mode: MonsterMode, dt: number): MonsterGait {
    const prev = this.gait;
    this.stopped = speed < 0.06 ? this.stopped + dt : 0;
    let g: MonsterGait;
    if (contract !== 'still') {
      g = contract;
      // The sim says it moves but it has stopped: settle like 'still'.
      if (this.stopped > 0.3 && contract !== 'run') g = 'still';
    } else if (speed < 0.12) {
      g = prev !== 'still' && speed > 0.06 ? prev : 'still';
    } else {
      // Inferred (the sim left the default): hysteresis bands.
      const runIn = mode === 'chase' ? 1.5 : 2.3;
      const runOut = mode === 'chase' ? 1.2 : 1.9;
      if (prev === 'run') g = speed > runOut ? 'run' : 'walk';
      else if (speed > runIn) g = 'run';
      else if (prev === 'creep') g = speed > 0.78 ? 'walk' : 'creep';
      else if (prev === 'walk') g = speed < 0.5 ? 'creep' : 'walk';
      else g = speed < 0.6 ? 'creep' : 'walk';
    }
    if (g !== prev) {
      this.gait = g;
      this.age = 0;
    } else this.age += dt;
    return this.gait;
  }
}

/**
 * All fours or upright. Quadruped when the contract says crawl, when it has been running for a
 * moment (it drops to all fours to charge), or while climbing. Held for a minimum time either way
 * so a change is always carried through real steps.
 */
export class StanceSelector {
  quad = false;
  private age = 10;
  private runFor = 0;

  update(posture: MonsterPosture, gait: MonsterGait, speed: number, climbing: boolean, dt: number): boolean {
    this.age += dt;
    this.runFor = gait === 'run' && speed > 1.9 ? this.runFor + dt : 0;
    const want = posture === 'crawl' || climbing || this.runFor > 0.35 || (this.quad && gait === 'run' && speed > 1.2);
    if (want !== this.quad && this.age > 0.6) {
      this.quad = want;
      this.age = 0;
    }
    return this.quad;
  }
}

/** Act timeline helpers (seconds since the act began). */
export const SWEEP = { windup: 0.85, strike: 0.26, follow: 0.34, recover: 0.8 } as const;
