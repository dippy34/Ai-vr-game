/**
 * What the monster's body can read and touch: the level geometry, precomputed once per level
 * into features (wall faces, convex corners, door frames, furniture tops, windows, overheads)
 * and a 1 m spatial grid, so per-frame queries only look at what is within ~1.8 m.
 *
 * Pure: reads LevelData (plain JSON from core), no three.js scene objects. Allocation-free queries.
 */

import type { Box, LevelData, PropStyle } from '../../../core/types';

/** A side of a wall (or tall furniture) the hands can brace on or trail along. */
export interface WallFace {
  id: number;
  /** Outward normal (axis aligned: one of nx, nz is ±1). */
  nx: number;
  nz: number;
  /** Plane coordinate: x for ±X faces, z for ±Z faces. */
  plane: number;
  /** Extent along the face (z for ±X faces, x for ±Z faces) and in height. */
  a0: number;
  a1: number;
  top: number;
  /** True for tall furniture sides (wardrobes, shelves), false for walls. */
  furniture: boolean;
}

/** A convex vertical edge: a wall end, a door jamb, the outside corner of a tall cabinet. */
export interface Corner {
  id: number;
  x: number;
  z: number;
  /** Outward normals of the two faces that meet here. */
  n1x: number;
  n1z: number;
  n2x: number;
  n2z: number;
  top: number;
  /** Doorway this corner frames (-1 if none). */
  door: number;
}

/** An open doorway under a lintel. */
export interface Doorway {
  id: number;
  cx: number;
  cz: number;
  /** Unit normal across the wall (one of the two directions) and the along-wall tangent. */
  nx: number;
  nz: number;
  tx: number;
  tz: number;
  /** Half the opening width and half the wall thickness. */
  halfW: number;
  halfT: number;
  /** Underside of the lintel. */
  lintel: number;
}

/** A furniture top a hand can rest on, a foot or hand can climb onto. */
export interface Top {
  id: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  y: number;
  style: PropStyle | null;
}

export interface WindowFeature {
  id: number;
  cx: number;
  cy: number;
  cz: number;
  /** Into the house. */
  nx: number;
  nz: number;
  /** Along the glass (horizontal). */
  tx: number;
  tz: number;
  halfW: number;
  halfH: number;
}

interface Solid {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  top: number;
  furniture: boolean;
}

/** Feature kinds in MonsterWorld.refs (ref >> 16). */
export const Feat = { Solid: 0, Face: 1, Corner: 2, Door: 3, Top: 4, Window: 5 } as const;
export type FeatKind = (typeof Feat)[keyof typeof Feat];

const CELL = 1.0;
/** Features within this distance of a cell are listed in it. */
const REACH = 1.9;
/** Boxes whose bottom is at least this high are overhead (lintels): matches core/physics.ts. */
const OVERHEAD_Y = 2.0;
const EPS = 1e-4;

export class MonsterWorld {
  readonly faces: WallFace[] = [];
  readonly corners: Corner[] = [];
  readonly doors: Doorway[] = [];
  readonly tops: Top[] = [];
  readonly windows: WindowFeature[] = [];
  private readonly solids: Solid[] = [];
  private readonly overheads: Solid[] = [];
  /** Lowest ceiling underside (headroom where there is no lintel). */
  readonly ceiling: number;
  private readonly gx0: number;
  private readonly gz0: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly cellStart: Int32Array;
  /** Feature references: (kind << 16) | index. */
  readonly refs: Int32Array;
  /** Result of the last query(): refs[qStart .. qEnd). */
  qStart = 0;
  qEnd = 0;

  constructor(level: LevelData) {
    let ceiling = Infinity;
    const walls: Box[] = [];
    for (const b of level.boxes) {
      if (b.kind === 'ceiling') ceiling = Math.min(ceiling, b.min.y);
      if (b.kind !== 'wall' && b.kind !== 'furniture') continue;
      const s: Solid = { minX: b.min.x, minZ: b.min.z, maxX: b.max.x, maxZ: b.max.z, top: b.max.y, furniture: b.kind === 'furniture' };
      if (b.min.y >= OVERHEAD_Y) {
        this.overheads.push({ ...s, top: b.min.y });
        if (b.kind === 'wall') this.addDoor(b);
        continue;
      }
      this.solids.push(s);
      if (b.kind === 'wall') walls.push(b);
      if (b.kind === 'furniture') {
        if (b.max.y >= 0.3 && b.max.y <= 1.35) {
          this.tops.push({ id: this.tops.length, minX: b.min.x, minZ: b.min.z, maxX: b.max.x, maxZ: b.max.z, y: b.max.y, style: b.style ?? null });
        }
      }
    }
    // The closed exit door is solid too (the monster never passes it).
    const d = level.exit.door;
    this.solids.push({ minX: d.min.x, minZ: d.min.z, maxX: d.max.x, maxZ: d.max.z, top: d.max.y, furniture: false });
    this.ceiling = ceiling === Infinity ? 2.8 : ceiling;
    // Ceiling-height door lintels are only doors if they hang below the ceiling.
    for (let i = this.doors.length - 1; i >= 0; i--) if (this.doors[i].lintel >= this.ceiling - 0.05) this.doors.splice(i, 1);
    this.doors.forEach((dd, i) => (dd.id = i));

    for (const s of this.solids) {
      if (!s.furniture || s.top >= 1.4) this.addFaces(s);
    }
    for (const s of this.solids) if (!s.furniture || s.top >= 1.4) this.addCorners(s);
    for (const w of level.windows) {
      const nx = -Math.sin(w.yaw);
      const nz = -Math.cos(w.yaw);
      // yaw faces into the house: forward of an object with that yaw is (-sin, -cos).
      this.windows.push({
        id: this.windows.length, cx: w.center.x, cy: w.center.y, cz: w.center.z,
        nx, nz, tx: -nz, tz: nx, halfW: w.width / 2, halfH: w.height / 2,
      });
    }

    // Grid.
    const b = level.bounds;
    this.gx0 = b.min.x - 1;
    this.gz0 = b.min.z - 1;
    this.nx = Math.ceil((b.max.x - b.min.x + 2) / CELL);
    this.nz = Math.ceil((b.max.z - b.min.z + 2) / CELL);
    const lists: number[][] = [];
    for (let i = 0; i < this.nx * this.nz; i++) lists.push([]);
    const add = (kind: FeatKind, idx: number, x0: number, z0: number, x1: number, z1: number) => {
      const i0 = Math.max(0, Math.floor((x0 - REACH - this.gx0) / CELL));
      const i1 = Math.min(this.nx - 1, Math.floor((x1 + REACH - this.gx0) / CELL));
      const k0 = Math.max(0, Math.floor((z0 - REACH - this.gz0) / CELL));
      const k1 = Math.min(this.nz - 1, Math.floor((z1 + REACH - this.gz0) / CELL));
      for (let k = k0; k <= k1; k++) {
        for (let i = i0; i <= i1; i++) {
          const cx0 = this.gx0 + i * CELL;
          const cz0 = this.gz0 + k * CELL;
          const dx = Math.max(0, x0 - (cx0 + CELL), cx0 - x1);
          const dz = Math.max(0, z0 - (cz0 + CELL), cz0 - z1);
          if (dx * dx + dz * dz <= REACH * REACH) lists[k * this.nx + i].push((kind << 16) | idx);
        }
      }
    };
    this.solids.forEach((s, i) => add(Feat.Solid, i, s.minX, s.minZ, s.maxX, s.maxZ));
    this.faces.forEach((f, i) => {
      if (f.nx !== 0) add(Feat.Face, i, f.plane, f.a0, f.plane, f.a1);
      else add(Feat.Face, i, f.a0, f.plane, f.a1, f.plane);
    });
    this.corners.forEach((c, i) => add(Feat.Corner, i, c.x, c.z, c.x, c.z));
    this.doors.forEach((dd, i) => {
      const ex = Math.abs(dd.tx) * dd.halfW + Math.abs(dd.nx) * dd.halfT;
      const ez = Math.abs(dd.tz) * dd.halfW + Math.abs(dd.nz) * dd.halfT;
      add(Feat.Door, i, dd.cx - ex, dd.cz - ez, dd.cx + ex, dd.cz + ez);
    });
    this.tops.forEach((t, i) => add(Feat.Top, i, t.minX, t.minZ, t.maxX, t.maxZ));
    this.windows.forEach((w, i) => {
      const ex = Math.abs(w.tx) * w.halfW;
      const ez = Math.abs(w.tz) * w.halfW;
      add(Feat.Window, i, w.cx - ex, w.cz - ez, w.cx + ex, w.cz + ez);
    });
    this.cellStart = new Int32Array(lists.length + 1);
    let n = 0;
    for (let i = 0; i < lists.length; i++) {
      this.cellStart[i] = n;
      n += lists[i].length;
    }
    this.cellStart[lists.length] = n;
    this.refs = new Int32Array(n);
    let o = 0;
    for (const l of lists) for (const r of l) this.refs[o++] = r;
  }

  private addDoor(b: Box): void {
    const sx = b.max.x - b.min.x;
    const sz = b.max.z - b.min.z;
    const alongX = sx >= sz;
    const width = alongX ? sx : sz;
    if (width < 0.5 || width > 3) return;
    this.doors.push({
      id: this.doors.length,
      cx: (b.min.x + b.max.x) / 2,
      cz: (b.min.z + b.max.z) / 2,
      nx: alongX ? 0 : 1,
      nz: alongX ? 1 : 0,
      tx: alongX ? 1 : 0,
      tz: alongX ? 0 : 1,
      halfW: width / 2,
      halfT: (alongX ? sz : sx) / 2,
      lintel: b.min.y,
    });
  }

  /** Is (x, z) inside any wall/tall solid other than `skip` (inclusive margin `m`)? */
  private insideWall(x: number, z: number, skip: Solid | null, m = 0): boolean {
    for (const s of this.solids) {
      if (s === skip || (s.furniture && s.top < 1.4)) continue;
      if (x > s.minX - m && x < s.maxX + m && z > s.minZ - m && z < s.maxZ + m) return true;
    }
    return false;
  }

  private addFaces(s: Solid): void {
    const furniture = s.furniture;
    const o = 0.03;
    const sides: [number, number, number, number, number][] = [
      [-1, 0, s.minX, s.minZ, s.maxZ],
      [1, 0, s.maxX, s.minZ, s.maxZ],
      [0, -1, s.minZ, s.minX, s.maxX],
      [0, 1, s.maxZ, s.minX, s.maxX],
    ];
    for (const [nx, nz, plane, a0, a1] of sides) {
      if (a1 - a0 < 0.25) continue;
      // Keep the exposed stretch of the face: trim covered ends (where another wall abuts).
      let lo = a0;
      let hi = a1;
      const at = (a: number): boolean => {
        const x = nx !== 0 ? plane + nx * o : a;
        const z = nx !== 0 ? a : plane + nz * o;
        return !this.insideWall(x, z, s);
      };
      const step = 0.05;
      while (lo < hi && !at(lo + EPS)) lo += step;
      while (hi > lo && !at(hi - EPS)) hi -= step;
      if (hi - lo < 0.3 || !at((lo + hi) / 2)) continue;
      this.faces.push({ id: this.faces.length, nx, nz, plane, a0: lo, a1: hi, top: s.top, furniture });
    }
  }

  private addCorners(s: Solid): void {
    const pts: [number, number, number, number][] = [
      [s.minX, s.minZ, -1, -1],
      [s.maxX, s.minZ, 1, -1],
      [s.minX, s.maxZ, -1, 1],
      [s.maxX, s.maxZ, 1, 1],
    ];
    for (const [x, z, sx, sz] of pts) {
      // Convex and exposed: just outside, along both faces and diagonally, is open space.
      const o = 0.04;
      if (this.insideWall(x + sx * o, z + sz * o, null)) continue;
      if (this.insideWall(x + sx * o, z - sz * o, s)) continue;
      if (this.insideWall(x - sx * o, z + sz * o, s)) continue;
      let door = -1;
      for (const d of this.doors) {
        const u = (x - d.cx) * d.tx + (z - d.cz) * d.tz;
        const v = (x - d.cx) * d.nx + (z - d.cz) * d.nz;
        if (Math.abs(Math.abs(u) - d.halfW) < 0.03 && Math.abs(v) <= d.halfT + 0.03) door = d.id;
      }
      this.corners.push({ id: this.corners.length, x, z, n1x: sx, n1z: 0, n2x: 0, n2z: sz, top: s.top, door });
    }
  }

  /** List the features near (x, z): refs[qStart .. qEnd). Returns the count. */
  query(x: number, z: number): number {
    const i = Math.floor((x - this.gx0) / CELL);
    const k = Math.floor((z - this.gz0) / CELL);
    if (i < 0 || k < 0 || i >= this.nx || k >= this.nz) {
      this.qStart = this.qEnd = 0;
      return 0;
    }
    const c = k * this.nx + i;
    this.qStart = this.cellStart[c];
    this.qEnd = this.cellStart[c + 1];
    return this.qEnd - this.qStart;
  }

  /**
   * Highest furniture top under (x, z) that is at most `maxTop` (the floor, 0, otherwise).
   * Uses the grid: (x, z) must be the query point or close to it.
   */
  supportAt(x: number, z: number, maxTop = Infinity): number {
    this.query(x, z);
    let best = 0;
    for (let r = this.qStart; r < this.qEnd; r++) {
      const ref = this.refs[r];
      if (ref >> 16 !== Feat.Solid) continue;
      const s = this.solids[ref & 0xffff];
      if (!s.furniture || s.top > maxTop) continue;
      if (x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ && s.top > best) best = s.top;
    }
    return best;
  }

  /**
   * Make a contact point (hand or foot, radius r) valid: push it out of walls and of furniture it
   * can't stand on; furniture tops within [refY - maxDown, refY + maxUp] are valid ground when
   * `tops` is set (it stays on a top it is well inside of, and steps off one it is near the edge
   * of). Mutates p.x/p.z; returns the surface height there.
   */
  placeContact(p: { x: number; z: number }, r: number, refY: number, tops: boolean, maxUp = 0.7, maxDown = 1.0): number {
    this.query(p.x, p.z);
    for (let it = 0; it < 3; it++) {
      let moved = false;
      for (let q = this.qStart; q < this.qEnd; q++) {
        const ref = this.refs[q];
        if (ref >> 16 !== Feat.Solid) continue;
        const s = this.solids[ref & 0xffff];
        const standable = tops && s.furniture && s.top <= refY + maxUp && s.top >= refY - maxDown;
        const inside = p.x > s.minX && p.x < s.maxX && p.z > s.minZ && p.z < s.maxZ;
        if (standable && inside) {
          // On top: keep it a margin away from the edges (no toes hanging off).
          const m = Math.min(r, (s.maxX - s.minX) / 2 - EPS, (s.maxZ - s.minZ) / 2 - EPS);
          const l = p.x - s.minX, rt = s.maxX - p.x, b = p.z - s.minZ, f = s.maxZ - p.z;
          const e = Math.min(l, rt, b, f);
          if (e < m * 0.5) {
            // Nearer the edge than half a contact: step off the top instead.
            if (e === l) p.x = s.minX - r;
            else if (e === rt) p.x = s.maxX + r;
            else if (e === b) p.z = s.minZ - r;
            else p.z = s.maxZ + r;
            moved = true;
          } else if (e < m) {
            if (l < m) p.x = s.minX + m;
            if (rt < m) p.x = s.maxX - m;
            if (b < m) p.z = s.minZ + m;
            if (f < m) p.z = s.maxZ - m;
          }
          continue;
        }
        // Outside it (or not standable): keep the contact circle clear of its sides.
        const cx = p.x < s.minX ? s.minX : p.x > s.maxX ? s.maxX : p.x;
        const cz = p.z < s.minZ ? s.minZ : p.z > s.maxZ ? s.maxZ : p.z;
        const dx = p.x - cx;
        const dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          const k = (r - d + EPS) / d;
          p.x += dx * k;
          p.z += dz * k;
        } else {
          const l = p.x - s.minX, rt = s.maxX - p.x, b = p.z - s.minZ, f = s.maxZ - p.z;
          const e = Math.min(l, rt, b, f);
          if (e === l) p.x = s.minX - r;
          else if (e === rt) p.x = s.maxX + r;
          else if (e === b) p.z = s.minZ - r;
          else p.z = s.maxZ + r;
        }
        moved = true;
      }
      if (!moved) break;
    }
    if (!tops) return 0;
    let best = 0;
    for (let q = this.qStart; q < this.qEnd; q++) {
      const ref = this.refs[q];
      if (ref >> 16 !== Feat.Solid) continue;
      const s = this.solids[ref & 0xffff];
      if (!s.furniture || s.top > refY + maxUp || s.top < refY - maxDown) continue;
      if (p.x > s.minX && p.x < s.maxX && p.z > s.minZ && p.z < s.maxZ && s.top > best) best = s.top;
    }
    return best;
  }

  /** Is (x, z) inside a solid (walls or furniture taller than `minTop`)? */
  blocked(x: number, z: number, minTop = 0): boolean {
    this.query(x, z);
    for (let q = this.qStart; q < this.qEnd; q++) {
      const ref = this.refs[q];
      if (ref >> 16 !== Feat.Solid) continue;
      const s = this.solids[ref & 0xffff];
      if (s.top < minTop) continue;
      if (x > s.minX && x < s.maxX && z > s.minZ && z < s.maxZ) return true;
    }
    return false;
  }

  /** Highest furniture top crossed by the segment a -> b (for swing clearance). */
  maxTopAlong(ax: number, az: number, bx: number, bz: number, maxTop = Infinity): number {
    let best = 0;
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const h = this.supportAt(ax + (bx - ax) * t, az + (bz - az) * t, maxTop);
      if (h > best) best = h;
    }
    return best;
  }

  /** Headroom above (x, z): the lowest overhead (lintel) underside, else the ceiling. */
  headroom(x: number, z: number, r = 0): number {
    let h = this.ceiling;
    for (const s of this.overheads) {
      if (x > s.minX - r && x < s.maxX + r && z > s.minZ - r && z < s.maxZ + r && s.top < h) h = s.top;
    }
    return h;
  }

  /**
   * Free distance from (x, z) along the unit direction (dx, dz) to the first solid taller than
   * `minTop`, up to `max`. Slab test against the solids listed near (x, z).
   */
  freeDistance(x: number, z: number, dx: number, dz: number, max: number, minTop = 0.6): number {
    this.query(x, z);
    let best = max;
    for (let q = this.qStart; q < this.qEnd; q++) {
      const ref = this.refs[q];
      if (ref >> 16 !== Feat.Solid) continue;
      const s = this.solids[ref & 0xffff];
      if (s.top < minTop) continue;
      let t0 = 0;
      let t1 = best;
      if (Math.abs(dx) < 1e-9) {
        if (x < s.minX || x > s.maxX) continue;
      } else {
        let a = (s.minX - x) / dx;
        let b = (s.maxX - x) / dx;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
        if (t0 > t1) continue;
      }
      if (Math.abs(dz) < 1e-9) {
        if (z < s.minZ || z > s.maxZ) continue;
      } else {
        let a = (s.minZ - z) / dz;
        let b = (s.maxZ - z) / dz;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
        if (t0 > t1) continue;
      }
      if (t0 < best) best = t0;
    }
    return best;
  }
}
