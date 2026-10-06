import { describe, expect, it } from 'vitest';
import { JUMPSCARE_TIMING as J, REMOTE_GRAB_TIMING as R, jumpscareFrame, newJumpscareFrame, remoteGrabFrame } from './Jumpscare';

const STEP = 0.001;

function sample<K extends keyof ReturnType<typeof newJumpscareFrame>>(key: K, from = 0, to = J.end + 0.2): number[] {
  const f = newJumpscareFrame();
  const out: number[] = [];
  for (let t = from; t <= to; t += STEP) out.push(jumpscareFrame(t, f)[key] as number);
  return out;
}

/** Number of times the curve changes direction (a flicker would make this large). */
function turns(xs: number[]): number {
  let n = 0;
  let dir = 0;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    if (Math.abs(d) < 1e-9) continue;
    const s = Math.sign(d);
    if (dir !== 0 && s !== dir) n++;
    dir = s;
  }
  return n;
}

describe('jumpscareFrame', () => {
  it('cuts to black, holds, then fades into the ghost view and ends', () => {
    const f = newJumpscareFrame();
    expect(jumpscareFrame(0, f).black).toBe(0);
    expect(jumpscareFrame(J.cutStart - 0.01, f).black).toBe(0);
    expect(jumpscareFrame((J.cutEnd + J.holdEnd) / 2, f).black).toBe(1);
    expect(jumpscareFrame(J.end, f).black).toBe(0);
    expect(f.done).toBe(true);
    expect(jumpscareFrame(J.end - 0.01, f).done).toBe(false);
    // Fade to black takes ~0.25 s, total ~1.6 s.
    expect(J.cutEnd - J.cutStart).toBeGreaterThanOrEqual(0.2);
    expect(J.cutEnd - J.cutStart).toBeLessThanOrEqual(0.3);
    expect(J.end).toBeCloseTo(1.6, 5);
    // Up, then down, once.
    expect(turns(sample('black'))).toBe(1);
  });

  it('releases the monster only while the screen is fully black', () => {
    const f = newJumpscareFrame();
    let first = -1;
    for (let t = 0; t <= J.end; t += STEP) {
      if (jumpscareFrame(t, f).released) {
        first = t;
        break;
      }
    }
    expect(first).toBeGreaterThan(0);
    expect(jumpscareFrame(first, f).black).toBeGreaterThan(0.999);
  });

  it('flashes the face once at the impact, then decays without flicker', () => {
    const light = sample('light');
    expect(light[0]).toBe(1);
    expect(Math.max(...light)).toBeLessThanOrEqual(1);
    expect(turns(light)).toBe(0);
    const f = newJumpscareFrame();
    expect(jumpscareFrame(0.3, f).light).toBeLessThan(0.35);
    expect(jumpscareFrame(0.3, f).light).toBeGreaterThan(0.05);
    expect(jumpscareFrame(J.cutEnd + 0.01, f).light).toBe(0);
  });

  it('pulses the red vignette once (a single peak)', () => {
    const red = sample('red', 0, J.cutEnd + 0.05);
    const peak = red.indexOf(Math.max(...red)) * STEP;
    expect(peak).toBeLessThan(0.06);
    // Rises, then falls (the lingering tint is folded in smoothly).
    expect(turns(red)).toBeLessThanOrEqual(2);
  });

  it('puts the face 35-45 cm away right after the snap, and never moves it away again', () => {
    const f = newJumpscareFrame();
    expect(jumpscareFrame(0, f).dist).toBeCloseTo(J.far, 5);
    const at = jumpscareFrame(J.lunge, f).dist;
    expect(at).toBeGreaterThanOrEqual(0.35);
    expect(at).toBeLessThanOrEqual(0.45);
    const dist = sample('dist');
    for (let i = 1; i < dist.length; i++) expect(dist[i]).toBeLessThanOrEqual(dist[i - 1] + 1e-9);
    expect(Math.min(...dist)).toBeGreaterThanOrEqual(0.3);
  });

  it('drives the Attack clip forward through the open-jaw part of the lunge', () => {
    const clip = sample('clip');
    expect(clip[0]).toBeCloseTo(J.clipStart, 5);
    for (let i = 1; i < clip.length; i++) expect(clip[i]).toBeGreaterThanOrEqual(clip[i - 1] - 1e-9);
    const f = newJumpscareFrame();
    expect(jumpscareFrame(J.jawOpenAt, f).clip).toBeCloseTo(J.clipOpen, 5);
    expect(Math.max(...clip)).toBeLessThanOrEqual(J.clipCut + 1e-9);
  });
});

describe('remoteGrabFrame', () => {
  it('blends into the grab and back out, then ends', () => {
    const g = { clip: 0, weight: 0, done: false };
    expect(remoteGrabFrame(0, g).weight).toBe(0);
    expect(g.clip).toBeCloseTo(R.clipStart, 5);
    expect(remoteGrabFrame(0.5, g).weight).toBe(1);
    expect(remoteGrabFrame(R.end, g).weight).toBe(0);
    expect(g.done).toBe(true);
    expect(remoteGrabFrame(10, g).clip).toBeLessThanOrEqual(1.2);
  });
});
