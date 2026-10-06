import { describe, expect, it } from 'vitest';
import { MIC, NOISE } from '../../config';
import { quatFromYaw } from '../../core/math';
import {
  HEARTBEAT,
  MicMeter,
  breathPeriod,
  dbfsToLevel,
  dubDelay,
  footstepLoudness,
  gateMicLevel,
  headVectors,
  heartbeatBpm,
  heartbeatGain,
  heartbeatIntensity,
  makeDriveCurve,
  monsterStepInterval,
  rmsOf,
  rmsToDbfs,
  stepMicLevel,
} from './audioMath';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('mic level mapping', () => {
  it('computes RMS and dBFS', () => {
    expect(rmsOf([])).toBe(0);
    close(rmsOf([1, -1, 1, -1]), 1);
    close(rmsOf([0.5, -0.5]), 0.5);
    close(rmsToDbfs(1), 0);
    close(rmsToDbfs(0.1), -20);
    expect(rmsToDbfs(0)).toBe(-Infinity);
  });

  it('maps dbFloor..dbCeil linearly to 0..1 and clamps', () => {
    expect(dbfsToLevel(MIC.dbFloor)).toBe(0);
    expect(dbfsToLevel(MIC.dbCeil)).toBe(1);
    close(dbfsToLevel((MIC.dbFloor + MIC.dbCeil) / 2), 0.5);
    expect(dbfsToLevel(-120)).toBe(0);
    expect(dbfsToLevel(0)).toBe(1);
    expect(dbfsToLevel(-Infinity)).toBe(0);
  });

  it('gates quiet levels to zero', () => {
    expect(gateMicLevel(MIC.gate * 0.99)).toBe(0);
    expect(gateMicLevel(MIC.gate)).toBe(MIC.gate);
    expect(gateMicLevel(0.7)).toBe(0.7);
  });

  it('attacks instantly and releases over MIC.release', () => {
    expect(stepMicLevel(0, 0.8, 1 / 72)).toBe(0.8);
    const half = stepMicLevel(1, 0, MIC.release / 3);
    expect(half).toBeLessThan(1);
    expect(half).toBeGreaterThan(0.2);
    // After `release` seconds of silence a full-scale level is below the gate.
    let l = 1;
    const dt = 1 / 90;
    for (let t = 0; t < MIC.release; t += dt) l = stepMicLevel(l, 0, dt);
    expect(l).toBeLessThan(MIC.gate);
    // Frame-rate independence: one big step ~= many small steps.
    let a = 1;
    for (let i = 0; i < 10; i++) a = stepMicLevel(a, 0, 0.01);
    close(a, stepMicLevel(1, 0, 0.1), 1e-3);
  });

  it('MicMeter combines mapping, smoothing and gate', () => {
    const m = new MicMeter();
    expect(m.push(0, 0.016)).toBe(0);
    // -12 dBFS (= dbCeil) -> 1
    const loud = Math.pow(10, MIC.dbCeil / 20);
    close(m.push(loud, 0.016), 1);
    // Silence: falls, then is gated to 0 within MIC.release.
    const after = m.push(0, 0.03);
    expect(after).toBeLessThan(1);
    expect(after).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) m.push(0, 0.01);
    expect(m.level).toBe(0);
    // A room-tone level just under the gate never registers.
    const roomDb = MIC.dbFloor + (MIC.dbCeil - MIC.dbFloor) * (MIC.gate * 0.5);
    m.reset();
    expect(m.push(Math.pow(10, roomDb / 20), 0.016)).toBe(0);
  });
});

describe('heartbeat curve', () => {
  it('runs 62 bpm far away to 150 bpm up close', () => {
    close(heartbeatBpm(16, 0), 62);
    close(heartbeatBpm(40, 0), 62);
    close(heartbeatBpm(1.5, 0), 150);
    close(heartbeatBpm(0.2, 0), 150);
  });

  it('is monotonic in distance and alert, and bounded', () => {
    let prev = Infinity;
    for (let d = 0; d <= 20; d += 0.5) {
      const b = heartbeatBpm(d, 0);
      expect(b).toBeLessThanOrEqual(prev + 1e-9);
      prev = b;
    }
    expect(heartbeatBpm(10, 1)).toBeGreaterThan(heartbeatBpm(10, 0));
    expect(heartbeatBpm(30, 1)).toBeGreaterThan(62);
    expect(heartbeatBpm(1, 1)).toBeLessThanOrEqual(HEARTBEAT.maxBpm);
    expect(heartbeatIntensity(NaN, NaN)).toBe(0);
  });

  it('gets louder with intensity and spaces lub-dub sensibly', () => {
    expect(heartbeatGain(1)).toBeGreaterThan(heartbeatGain(0.5));
    expect(heartbeatGain(0.5)).toBeGreaterThan(heartbeatGain(0));
    close(heartbeatGain(0), HEARTBEAT.minGain);
    const fast = 60 / 150;
    expect(dubDelay(fast)).toBeLessThan(fast / 2);
    expect(dubDelay(60 / 62)).toBeLessThanOrEqual(0.26);
  });
});

describe('head orientation', () => {
  it('identity looks down -Z with +Y up', () => {
    const { forward, up } = headVectors({ x: 0, y: 0, z: 0, w: 1 });
    close(forward.x, 0); close(forward.y, 0); close(forward.z, -1);
    close(up.x, 0); close(up.y, 1); close(up.z, 0);
  });

  it('yaw +90deg (counter-clockwise from above) looks down -X', () => {
    const { forward, up } = headVectors(quatFromYaw(Math.PI / 2));
    close(forward.x, -1); close(forward.y, 0); close(forward.z, 0);
    close(up.y, 1);
  });

  it('pitching up tilts forward up and up backward', () => {
    const a = Math.PI / 4; // 45deg around +X
    const q = { x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) };
    const { forward, up } = headVectors(q);
    close(forward.y, Math.SQRT1_2); close(forward.z, -Math.SQRT1_2);
    close(up.y, Math.SQRT1_2); close(up.z, Math.SQRT1_2);
  });

  it('normalizes non-unit and degenerate quaternions', () => {
    const { forward } = headVectors({ x: 0, y: 0, z: 0, w: 5 });
    close(forward.z, -1);
    const z = headVectors({ x: 0, y: 0, z: 0, w: 0 });
    close(z.forward.z, -1); close(z.up.y, 1);
  });
});

describe('movement-derived sounds', () => {
  it('maps remote player speed to footstep loudness', () => {
    expect(footstepLoudness(0.5, 1.6)).toBe(NOISE.sneakStep);
    close(footstepLoudness(1.9, 1.6), NOISE.walkStep);
    close(footstepLoudness(5, 1.6), NOISE.sprintStep);
    expect(footstepLoudness(3.3, 0.9)).toBe(NOISE.sneakStep);
  });

  it('spaces monster steps by stride', () => {
    close(monsterStepInterval(1.1), 1);
    close(monsterStepInterval(2.2), 0.5);
    expect(monsterStepInterval(0)).toBe(Infinity);
  });

  it('breathes faster when alert or chasing', () => {
    expect(breathPeriod(1, 'wander')).toBeLessThan(breathPeriod(0, 'wander'));
    expect(breathPeriod(0, 'chase')).toBeLessThan(breathPeriod(0, 'investigate'));
  });

  it('builds a bounded odd drive curve', () => {
    const c = makeDriveCurve(8, 257);
    close(c[0], -1); close(c[256], 1); close(c[128], 0);
  });
});
