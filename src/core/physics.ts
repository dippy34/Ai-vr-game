import type { Box, LevelData, Vec3 } from './types';

export interface CollisionOptions {
  /** When false (default), the exit door is solid. */
  exitOpen?: boolean;
}

/**
 * Boxes whose bottom is at or above this height (door lintels, beams) are "overhead": they are
 * drawn, but neither block movement on the XZ plane nor muffle sound.
 */
export const OVERHEAD_Y = 2.0;

/**
 * When dropping something, a furniture top up to this far ABOVE the hand still counts as the
 * surface it lands on (hands sink a little into table tops in VR).
 */
export const SUPPORT_TOLERANCE = 0.25;

const EPS = 1e-6;
const MAX_SUBSTEPS = 400;
const RESOLVE_ITERATIONS = 4;
const PUSHOUT_ITERATIONS = 8;

export const isOverhead = (b: Box): boolean => b.min.y >= OVERHEAD_Y;

/** Everything that blocks horizontal movement: walls + furniture (+ the exit door while closed). */
export function solidBoxes(level: LevelData, opts?: CollisionOptions): Box[] {
  const out: Box[] = [];
  for (const b of level.boxes) {
    if ((b.kind === 'wall' || b.kind === 'furniture') && !isOverhead(b)) out.push(b);
  }
  if (!opts?.exitOpen) out.push(level.exit.door);
  return out;
}

/** Everything that muffles sound: walls (+ the exit door while closed). Furniture does not. */
export function wallBoxes(level: LevelData, opts?: CollisionOptions): Box[] {
  const out: Box[] = [];
  for (const b of level.boxes) {
    if (b.kind === 'wall' && !isOverhead(b)) out.push(b);
  }
  if (!opts?.exitOpen) out.push(level.exit.door);
  return out;
}

/** Push a circle at (p.x, p.z) out of `boxes`. Mutates `p`. Returns true if anything was hit. */
function resolveCircle(p: { x: number; z: number }, r: number, boxes: Box[], iterations: number): boolean {
  let hitAny = false;
  for (let it = 0; it < iterations; it++) {
    let hit = false;
    for (const b of boxes) {
      const cx = p.x < b.min.x ? b.min.x : p.x > b.max.x ? b.max.x : p.x;
      const cz = p.z < b.min.z ? b.min.z : p.z > b.max.z ? b.max.z : p.z;
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2);
        const k = (r - d + EPS) / d;
        p.x += dx * k;
        p.z += dz * k;
      } else {
        // Center is inside the box: leave through the nearest face.
        const l = p.x - b.min.x;
        const rt = b.max.x - p.x;
        const bk = p.z - b.min.z;
        const f = b.max.z - p.z;
        const m = Math.min(l, rt, bk, f);
        if (m === l) p.x = b.min.x - r - EPS;
        else if (m === rt) p.x = b.max.x + r + EPS;
        else if (m === bk) p.z = b.min.z - r - EPS;
        else p.z = b.max.z + r + EPS;
      }
      hit = true;
    }
    if (!hit) break;
    hitAny = true;
  }
  return hitAny;
}

/** Boxes whose XZ footprint overlaps the rectangle [minX,maxX] x [minZ,maxZ]. */
function boxesNear(boxes: readonly Box[], minX: number, minZ: number, maxX: number, maxZ: number): Box[] {
  const out: Box[] = [];
  for (const b of boxes) {
    if (b.max.x < minX || b.min.x > maxX || b.max.z < minZ || b.min.z > maxZ) continue;
    out.push(b);
  }
  return out;
}

/**
 * Move a circle (XZ plane, given radius) from `from` by `delta`, sliding along walls/furniture
 * instead of passing through them. Y is carried through unchanged. Returns the new position.
 * Sub-steps the motion (each sub-step <= radius / 2) so fast movers never tunnel through walls.
 */
export function moveCircle(
  level: LevelData,
  from: Vec3,
  delta: Vec3,
  radius: number,
  opts?: CollisionOptions,
): Vec3 {
  return moveCircleAmong(solidBoxes(level, opts), from, delta, radius);
}

/** moveCircle against an explicit list of solid boxes (e.g. the monster, which climbs low furniture). */
export function moveCircleAmong(solids: readonly Box[], from: Vec3, delta: Vec3, radius: number): Vec3 {
  const r = Math.max(radius, 1e-3);
  const len = Math.hypot(delta.x, delta.z);
  const pad = 2 * r + 0.1;
  const boxes = boxesNear(
    solids,
    Math.min(from.x, from.x + delta.x) - pad,
    Math.min(from.z, from.z + delta.z) - pad,
    Math.max(from.x, from.x + delta.x) + pad,
    Math.max(from.z, from.z + delta.z) + pad,
  );
  const p = { x: from.x, z: from.z };
  const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(len / (r * 0.5))));
  const sx = delta.x / n;
  const sz = delta.z / n;
  // Resolve any overlap we start in first (e.g. a VR player who leaned into a wall).
  resolveCircle(p, r, boxes, RESOLVE_ITERATIONS);
  for (let i = 0; i < n; i++) {
    p.x += sx;
    p.z += sz;
    resolveCircle(p, r, boxes, RESOLVE_ITERATIONS);
  }
  return { x: p.x, y: from.y + delta.y, z: p.z };
}

/** Distance (XZ) from point (x, z) to the footprint of box `b` (0 inside). */
export function distToBox(b: Box, x: number, z: number): number {
  const dx = x < b.min.x ? b.min.x - x : x > b.max.x ? x - b.max.x : 0;
  const dz = z < b.min.z ? b.min.z - z : z > b.max.z ? z - b.max.z : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Squared distance from (px, pz) to segment (ax, az)-(bx, bz). */
function pointSegDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-12 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px;
  const ez = az + dz * t - pz;
  return ex * ex + ez * ez;
}

/**
 * Exact version of segmentClear against an explicit box list: true when a circle of `radius`
 * swept from a to b (XZ) touches none of `boxes` (rounded corners, unlike segmentClear).
 */
export function capsuleClear(boxes: readonly Box[], a: Vec3, b: Vec3, radius: number): boolean {
  const r2 = radius * radius;
  const minX = Math.min(a.x, b.x) - radius;
  const maxX = Math.max(a.x, b.x) + radius;
  const minZ = Math.min(a.z, b.z) - radius;
  const maxZ = Math.max(a.z, b.z) + radius;
  for (const s of boxes) {
    if (s.max.x < minX || s.min.x > maxX || s.max.z < minZ || s.min.z > maxZ) continue;
    if (segmentHitsRect(a.x, a.z, b.x, b.z, s.min.x, s.min.z, s.max.x, s.max.z)) return false;
    const da = distToBox(s, a.x, a.z);
    if (da * da < r2) return false;
    const db = distToBox(s, b.x, b.z);
    if (db * db < r2) return false;
    if (pointSegDist2(s.min.x, s.min.z, a.x, a.z, b.x, b.z) < r2) return false;
    if (pointSegDist2(s.max.x, s.min.z, a.x, a.z, b.x, b.z) < r2) return false;
    if (pointSegDist2(s.min.x, s.max.z, a.x, a.z, b.x, b.z) < r2) return false;
    if (pointSegDist2(s.max.x, s.max.z, a.x, a.z, b.x, b.z) < r2) return false;
  }
  return true;
}

/** Like pushOut, but against an explicit list of boxes. Returns the corrected position (y kept). */
export function pushOutOf(boxes: Box[], pos: Vec3, radius: number): Vec3 {
  const p = { x: pos.x, z: pos.z };
  resolveCircle(p, Math.max(radius, 1e-3), boxes, PUSHOUT_ITERATIONS);
  return { x: p.x, y: pos.y, z: p.z };
}

/**
 * If a circle at `pos` overlaps solid geometry, return the minimal correction vector (XZ) that
 * pushes it out; otherwise {0,0,0}. Used to stop VR players physically walking through walls.
 */
export function pushOut(level: LevelData, pos: Vec3, radius: number, opts?: CollisionOptions): Vec3 {
  const r = Math.max(radius, 1e-3);
  const boxes = boxesNear(solidBoxes(level, opts), pos.x - r, pos.z - r, pos.x + r, pos.z + r);
  if (boxes.length === 0) return { x: 0, y: 0, z: 0 };
  const p = pushOutOf(solidBoxes(level, opts), pos, r);
  const dx = p.x - pos.x;
  const dz = p.z - pos.z;
  return { x: Math.abs(dx) < 1e-9 ? 0 : dx, y: 0, z: Math.abs(dz) < 1e-9 ? 0 : dz };
}

/** True when the circle at `pos` overlaps any solid (walls, furniture, closed door). */
export function circleBlocked(level: LevelData, pos: Vec3, radius: number, opts?: CollisionOptions): boolean {
  for (const b of solidBoxes(level, opts)) {
    const cx = Math.max(b.min.x, Math.min(pos.x, b.max.x));
    const cz = Math.max(b.min.z, Math.min(pos.z, b.max.z));
    if ((pos.x - cx) ** 2 + (pos.z - cz) ** 2 < radius * radius) return true;
  }
  return false;
}

/** Does segment (ax,az)->(bx,bz) touch the rectangle [minX,maxX] x [minZ,maxZ]? (slab test) */
export function segmentHitsRect(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  if (Math.abs(dx) < 1e-12) {
    if (ax < minX || ax > maxX) return false;
  } else {
    let ta = (minX - ax) / dx;
    let tb = (maxX - ax) / dx;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  if (Math.abs(dz) < 1e-12) {
    if (az < minZ || az > maxZ) return false;
  } else {
    let ta = (minZ - az) / dz;
    let tb = (maxZ - az) / dz;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

/** Number of walls (BoxKind 'wall', plus the closed exit door) crossed by segment a→b (XZ). */
export function wallsBetween(level: LevelData, a: Vec3, b: Vec3, opts?: CollisionOptions): number {
  let n = 0;
  for (const w of wallBoxes(level, opts)) {
    if (segmentHitsRect(a.x, a.z, b.x, b.z, w.min.x, w.min.z, w.max.x, w.max.z)) n++;
  }
  return n;
}

/**
 * True when a circle of `radius` can travel in a straight line from a to b (XZ) without touching
 * walls, furniture or the closed exit door. Conservative (boxes are inflated as squares).
 */
export function segmentClear(
  level: LevelData,
  a: Vec3,
  b: Vec3,
  radius: number,
  opts?: CollisionOptions,
): boolean {
  for (const s of solidBoxes(level, opts)) {
    if (
      segmentHitsRect(
        a.x,
        a.z,
        b.x,
        b.z,
        s.min.x - radius,
        s.min.z - radius,
        s.max.x + radius,
        s.max.z + radius,
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Height of the surface something resting at (x, z) sits on: the top of the highest furniture box
 * under that point whose top is not more than SUPPORT_TOLERANCE above `maxY`; 0 (the floor)
 * otherwise. Pass the hand height as `maxY` when dropping; omit it to get the highest top.
 */
export function supportHeight(level: LevelData, x: number, z: number, maxY = Infinity): number {
  let best = 0;
  for (const b of level.boxes) {
    if (b.kind !== 'furniture') continue;
    if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
    if (b.max.y > maxY + SUPPORT_TOLERANCE) continue;
    if (b.max.y > best) best = b.max.y;
  }
  return best;
}

/** Is point p inside the axis-aligned box [min, max] (inclusive, 3D)? */
export function pointInBox(p: Vec3, box: { min: Vec3; max: Vec3 }): boolean {
  return (
    p.x >= box.min.x &&
    p.x <= box.max.x &&
    p.y >= box.min.y &&
    p.y <= box.max.y &&
    p.z >= box.min.z &&
    p.z <= box.max.z
  );
}
