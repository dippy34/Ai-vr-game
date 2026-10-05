import type { LevelData } from './types';

/**
 * Build the level. Deterministic: the same seed gives the same level on every client.
 * STUB — implemented by the core module.
 */
export function createLevel(seed: number): LevelData {
  throw new Error(`createLevel(${seed}) not implemented yet`);
}
