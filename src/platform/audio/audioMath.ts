/**
 * Pure audio helpers: no WebAudio, no DOM. Everything here is unit-tested in node
 * (see audioMath.test.ts) and is safe to import from anywhere.
 */

import { MIC, NOISE, PLAYER } from '../../config';
import { clamp, rotate3 } from '../../core/math';
import type { MonsterMode, Quat, Vec3 } from '../../core/types';

// ---------------------------------------------------------------------------------------------
// Microphone meter
// ---------------------------------------------------------------------------------------------

/** Root-mean-square of a block of samples (0 for an empty block). */
export function rmsOf(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Linear RMS (full scale = 1) to dBFS. Silence gives -Infinity. */
export function rmsToDbfs(rms: number): number {
  if (!(rms > 0)) return -Infinity;
  return 20 * Math.log10(rms);
}

/** Maps dBFS linearly so `floor` -> 0 and `ceil` -> 1, clamped to 0..1. */
export function dbfsToLevel(db: number, floor: number = MIC.dbFloor, ceil: number = MIC.dbCeil): number {
  if (!Number.isFinite(db)) return db > 0 ? 1 : 0;
  if (ceil <= floor) return db >= ceil ? 1 : 0;
  return clamp((db - floor) / (ceil - floor), 0, 1);
}

/**
 * One meter step: instant attack, exponential release. The level falls ~95% of the way to
 * `target` in `release` seconds (so a shout is gone, i.e. below the gate, within MIC.release).
 */
export function stepMicLevel(prev: number, target: number, dt: number, release: number = MIC.release): number {
  if (!Number.isFinite(prev)) prev = 0;
  if (!Number.isFinite(target)) target = 0;
  if (target >= prev) return target;
  if (!(release > 0) || !(dt > 0)) return dt > 0 ? target : prev;
  const k = Math.exp((-3 * dt) / release);
  const next = target + (prev - target) * k;
  return next - target < 1e-4 ? target : next;
}

/** Below the gate, the voice makes no noise at all. */
export function gateMicLevel(level: number, gate: number = MIC.gate): number {
  return level < gate ? 0 : Math.min(level, 1);
}

/** Sensitivity slider range in dB (each side of 0). */
export const MIC_SENSITIVITY_RANGE = 15;

/** Stateful mic meter built from the pure steps above: feed RMS + dt, read the gated level. */
export class MicMeter {
  private smoothed = 0;
  private out = 0;
  /** Per-player mic sensitivity offset in dB (mics differ a lot), clamped to ±MIC_SENSITIVITY_RANGE. */
  sensitivityDb = 0;

  /** Push one RMS measurement taken `dt` seconds after the previous one. Returns the gated level. */
  push(rms: number, dt: number): number {
    const raw = dbfsToLevel(rmsToDbfs(rms) + this.sensitivityDb);
    this.smoothed = stepMicLevel(this.smoothed, raw, dt);
    this.out = gateMicLevel(this.smoothed);
    return this.out;
  }

  /** Gated, smoothed level 0..1. */
  get level(): number {
    return this.out;
  }

  reset(): void {
    this.smoothed = 0;
    this.out = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------------------------

export const HEARTBEAT = {
  minBpm: 62,
  maxBpm: 150,
  /** At or beyond this distance (m, XZ) to the monster the heart is calm. */
  farDistance: 16,
  /** At or inside this distance the heart is at max. */
  nearDistance: 1.5,
  /** >1 keeps the heart calmer until the monster gets properly close. */
  curve: 1.35,
  /** How much monster.alert (0..1) adds on top of proximity. */
  alertWeight: 0.25,
  minGain: 0.012,
  maxGain: 0.32,
} as const;

/** 0..1 "fear" from distance to the monster and its agitation. */
export function heartbeatIntensity(distance: number, alert: number): number {
  const { farDistance: far, nearDistance: near, curve, alertWeight } = HEARTBEAT;
  const d = Number.isFinite(distance) ? distance : far;
  const t = clamp((far - d) / (far - near), 0, 1);
  const prox = Math.pow(t, curve);
  const a = clamp(Number.isFinite(alert) ? alert : 0, 0, 1);
  return clamp(prox + alertWeight * a * (1 - prox), 0, 1);
}

/** Beats per minute: 62 when calm (>= 16 m) up to 150 when the monster is at 1.5 m. */
export function heartbeatBpm(distance: number, alert: number): number {
  return bpmFromIntensity(heartbeatIntensity(distance, alert));
}

export function bpmFromIntensity(intensity: number): number {
  const { minBpm, maxBpm } = HEARTBEAT;
  return minBpm + (maxBpm - minBpm) * clamp(intensity, 0, 1);
}

/** Linear gain of the heartbeat for an intensity: barely there when calm, loud up close. */
export function heartbeatGain(intensity: number): number {
  const { minGain, maxGain } = HEARTBEAT;
  return minGain + (maxGain - minGain) * Math.pow(clamp(intensity, 0, 1), 1.3);
}

/** Seconds between "lub" and "dub" for a given beat period. */
export function dubDelay(period: number): number {
  return clamp(period * 0.32, 0.13, 0.26);
}

// ---------------------------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------------------------

/**
 * Listener vectors for a head rotation: forward = rotate(-Z), up = rotate(+Y), both unit length.
 * Degenerate quaternions fall back to the identity orientation.
 */
export function headVectors(q: Quat): { forward: Vec3; up: Vec3 } {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  const u: Quat = n > 1e-9 && Number.isFinite(n) ? { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n } : { x: 0, y: 0, z: 0, w: 1 };
  return {
    forward: unit(rotate3(u, { x: 0, y: 0, z: -1 }), { x: 0, y: 0, z: -1 }),
    up: unit(rotate3(u, { x: 0, y: 1, z: 0 }), { x: 0, y: 1, z: 0 }),
  };
}

function unit(v: Vec3, fallback: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l, z: v.z / l } : fallback;
}

// ---------------------------------------------------------------------------------------------
// Movement-derived sounds
// ---------------------------------------------------------------------------------------------

/** Frame-rate independent exponential smoothing factor for a rate in 1/s. */
export function smoothFactor(rate: number, dt: number): number {
  if (!(dt > 0) || !(rate > 0)) return 0;
  return 1 - Math.exp(-rate * dt);
}

/**
 * Footstep loudness (0..1, same scale as NOISE.*Step) for a remote player moving at `speed` m/s
 * with their head at height `headY`. Crouched players are always sneaking.
 */
export function footstepLoudness(speed: number, headY: number): number {
  if (headY < PLAYER.crouchThreshold) return NOISE.sneakStep;
  const s = Math.max(0, speed);
  if (s <= PLAYER.sneakSpeed) return NOISE.sneakStep;
  if (s <= PLAYER.walkSpeed) {
    const t = (s - PLAYER.sneakSpeed) / (PLAYER.walkSpeed - PLAYER.sneakSpeed);
    return NOISE.sneakStep + (NOISE.walkStep - NOISE.sneakStep) * t;
  }
  const t = clamp((s - PLAYER.walkSpeed) / (PLAYER.sprintSpeed - PLAYER.walkSpeed), 0, 1);
  return NOISE.walkStep + (NOISE.sprintStep - NOISE.walkStep) * t;
}

/** Monster stride length in meters (one heavy footstep per stride). */
export const MONSTER_STRIDE = 1.1;

/** Seconds between monster footsteps at `speed` (Infinity when standing still). */
export function monsterStepInterval(speed: number, stride: number = MONSTER_STRIDE): number {
  return speed > 0.12 ? stride / speed : Infinity;
}

/** Breath cycle length (s): slow and deep when calm, panting when alert or chasing. */
export function breathPeriod(alert: number, mode: MonsterMode): number {
  const a = clamp(Number.isFinite(alert) ? alert : 0, 0, 1);
  let p = 3.9 - 2.5 * a;
  if (mode === 'investigate') p = Math.min(p, 2.6);
  if (mode === 'chase') p = Math.min(p, 1.05);
  if (mode === 'feeding') p = 1.8;
  return clamp(p, 0.8, 4.5);
}

// ---------------------------------------------------------------------------------------------
// Waveshaping
// ---------------------------------------------------------------------------------------------

/** Symmetric tanh distortion curve for a WaveShaperNode (`drive` ~1 gentle .. 30 brutal). */
export function makeDriveCurve(drive: number, samples = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const k = Math.max(0.01, drive);
  const norm = Math.tanh(k);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/**
 * How much walls between a sound and the listener muffle it: [gain multiplier, lowpass Hz].
 * One wall = clearly "next room"; three or more = a distant thump through the house.
 */
export function occlusionMix(walls: number, nyquist: number): [number, number] {
  if (!(walls > 0)) return [1, nyquist];
  if (walls < 2) return [0.55, 1500];
  if (walls < 3) return [0.35, 750];
  return [0.22, 450];
}
