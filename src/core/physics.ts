import type { LevelData, Vec3 } from './types';

export interface CollisionOptions {
  /** When false (default), the exit door is solid. */
  exitOpen?: boolean;
}

/**
 * Move a circle (XZ plane, given radius) from `from` by `delta`, sliding along walls/furniture
 * instead of passing through them. Y is carried through unchanged. Returns the new position.
 * STUB — implemented by the core module.
 */
export function moveCircle(
  level: LevelData,
  from: Vec3,
  delta: Vec3,
  radius: number,
  opts?: CollisionOptions,
): Vec3 {
  void level; void radius; void opts;
  return { x: from.x + delta.x, y: from.y + delta.y, z: from.z + delta.z };
}

/**
 * If a circle at `pos` overlaps solid geometry, return the minimal correction vector (XZ) that
 * pushes it out; otherwise {0,0,0}. Used to stop VR players physically walking through walls.
 * STUB — implemented by the core module.
 */
export function pushOut(level: LevelData, pos: Vec3, radius: number, opts?: CollisionOptions): Vec3 {
  void level; void pos; void radius; void opts;
  return { x: 0, y: 0, z: 0 };
}

/** Number of walls (BoxKind 'wall', plus the closed exit door) crossed by segment a→b. STUB. */
export function wallsBetween(level: LevelData, a: Vec3, b: Vec3, opts?: CollisionOptions): number {
  void level; void a; void b; void opts;
  return 0;
}
