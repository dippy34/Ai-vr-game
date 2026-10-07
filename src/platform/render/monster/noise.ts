/**
 * Deterministic variation for the procedural monster: integer hashing, smooth value noise and a
 * tiny seeded RNG. Everything here is pure and allocation-free, so the same seed gives the same
 * performance on every client and in tests.
 */

/** Hash an integer (and a seed) to [0, 1). */
export function hash01(i: number, seed = 0): number {
  let h = Math.imul((i | 0) ^ Math.imul((seed | 0) + 0x6d2b79f5, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Hash two integers to one 32-bit key (for feature ids + encounter counters). */
export function hashKey(a: number, b: number): number {
  return (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x9e3779b1)) | 0;
}

/** Smooth 1D value noise in [-1, 1]. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(i, seed) * 2 - 1;
  const b = hash01(i + 1, seed) * 2 - 1;
  return a + (b - a) * u;
}

/** Two octaves of value noise in [-1, 1]: organic drift with no visible period. */
export function fbm1(x: number, seed = 0): number {
  return noise1(x, seed) * 0.67 + noise1(x * 2.137 + 17.3, seed + 101) * 0.33;
}

/** Mulberry32: a small, fast, seedable RNG. */
export class Rng {
  private s: number;

  constructor(seed = 1) {
    this.s = seed | 0;
  }

  seed(seed: number): this {
    this.s = seed | 0;
    return this;
  }

  /** [0, 1) */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** [-1, 1) */
  signed(): number {
    return this.next() * 2 - 1;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}
