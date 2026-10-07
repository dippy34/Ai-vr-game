/** Small allocation-free dynamics for secondary motion: springs and twitch impulses. */

import type { Rng } from './noise';

/** Exponential approach factor for a rate (1/s) over dt. */
export const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * Math.max(0, dt));

/** Scalar spring (omega rad/s, zeta damping ratio: < 1 overshoots). */
export class Spring {
  v = 0;
  constructor(public x = 0) {}

  step(target: number, omega: number, zeta: number, dt: number): number {
    const n = dt > 1 / 60 ? Math.ceil(dt * 60) : 1;
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (omega * omega * (target - this.x) - 2 * zeta * omega * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }

  set(x: number): void {
    this.x = x;
    this.v = 0;
  }
}

/**
 * Random jerks: fires at a Poisson `rate` (1/s), snaps to a random offset in [-amp, amp] within
 * ~40 ms, holds briefly, relaxes over ~0.2-0.4 s.
 */
export class Twitch {
  x = 0;
  private target = 0;
  private hold = 0;
  private relax = 4;

  update(dt: number, rate: number, amp: number, rng: Rng): number {
    if (rate > 0 && rng.next() < rate * dt) {
      this.target = rng.signed() * amp;
      this.hold = rng.range(0.04, 0.22);
      this.relax = rng.range(3, 7);
    }
    if (this.hold > 0) {
      this.hold -= dt;
      this.x += (this.target - this.x) * (1 - Math.exp(-dt * 40));
    } else {
      this.target = 0;
      this.x += (0 - this.x) * (1 - Math.exp(-dt * this.relax));
    }
    return this.x;
  }
}
