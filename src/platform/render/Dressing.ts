/**
 * Set dressing: scatters the Blender clutter (public/models/dressing_<name>.glb) through the house
 * so every room reads as decades-abandoned. Purely visual (no collision, no gameplay effect).
 *
 * Deterministic: the same level + seed + set of models gives the same layout on every client.
 * Works with any subset of pieces (and ignores names it doesn't know, except for a generic rule
 * by their `placement` extra), so models can be added/re-exported freely.
 *
 * How it works:
 *  1. The level is rasterized onto a 10 cm floor grid: walls, doorway lintels, furniture, the
 *     exit door. Rooms are flood-filled regions (doorways close them off via their lintels).
 *  2. Keep-out zones are marked on the grid: nav links + nodes (where the monster and players walk),
 *     doorways, spawn points, item spawns and the fuse box. Solid floor pieces never touch them;
 *     flat litter only avoids the cores of walkways; rugs only avoid doorways and spawns.
 *  3. Rules (by piece name) place pieces where they make sense: chairs tucked under tables,
 *     frames/clocks on clear wall spans (no windows, doors, fuse box, tall furniture in front),
 *     bottles/candles/books on table + counter tops (real surface height found by raycasting the
 *     furniture model, so sinks/stoves/backsplashes are avoided), rugs under living/bedroom
 *     furniture, boards over a couple of windows, bare bulbs hanging over tables, and the toys
 *     somewhere you see them on the first flash (straight ahead of the spawn, across the house).
 *  4. All copies of a source mesh are merged into one static mesh (StaticBatcher).
 */

import * as THREE from 'three';
import { makeRng } from '../../core/math';
import { LEVEL_ID, roomAt } from '../../core/level';
import type { Box, LevelData, PropStyle, Vec3 } from '../../core/types';
import { extrasSize, localBounds, type ModelLibrary } from './assets';
import type { StaticBatcher } from './batch';
import type { PlacedFurniture } from './FurnitureModels';
import { rayAabb, type Aabb } from './util';

export const DRESSING_PREFIX = 'dressing_';

export type DressingPlacement = 'floor' | 'surface' | 'wall' | 'ceiling';

/** One dressing model, measured. */
interface Piece {
  name: string;
  scene: THREE.Object3D;
  placement: DressingPlacement;
  /** Local bounds of the model (its own frame). */
  bounds: THREE.Box3;
  size: THREE.Vector3;
}

export interface DressingPlacementInfo {
  name: string;
  room: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

export interface DressingInput {
  level: LevelData;
  /** Wall boxes (incl. lintels); the exit door is excluded by the scatter itself. */
  walls: Box[];
  furniture: Box[];
  /** GLB furniture placements (to find the real top surface of each piece). */
  placed: PlacedFurniture[];
  /** World point at the center of the fuse box's back (on the wall). */
  fuseBoxMount: THREE.Vector3;
}

// ---------------------------------------------------------------------------------------------
// Floor grid
// ---------------------------------------------------------------------------------------------

const CELL = 0.1;
const F_WALL = 1;
const F_LINTEL = 2;
const F_FURN = 4;
const F_DOOR = 8;
/** Walkway band around nav links / nodes (solid pieces stay out). */
const F_WALK = 16;
/** Doorways, spawns, fuse box, exit (everything stays out except wall/ceiling pieces). */
const F_CLEAR = 32;
/** Something dressing-solid is already here. */
const F_USED = 64;
/** Core of a walkway (even flat litter stays out). */
const F_WALK_CORE = 128;
const F_RUG = 256;
const F_ITEM = 512;

const SOLID_BLOCK = F_WALL | F_LINTEL | F_FURN | F_DOOR | F_WALK | F_CLEAR | F_USED | F_ITEM;
const LITTER_BLOCK = F_WALL | F_LINTEL | F_FURN | F_DOOR | F_WALK_CORE | F_CLEAR | F_USED | F_ITEM;
const RUG_BLOCK = F_WALL | F_LINTEL | F_DOOR | F_CLEAR | F_RUG;

interface Room {
  id: number;
  name: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cells: number;
  furniture: Box[];
  windows: number[];
}

class Grid {
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  readonly flags: Uint16Array;
  readonly room: Int16Array;
  /** Rug top height per cell (0 = bare floor). */
  readonly rugTop: Float32Array;

  constructor(min: Vec3, max: Vec3) {
    this.x0 = min.x;
    this.z0 = min.z;
    this.nx = Math.max(1, Math.ceil((max.x - min.x) / CELL));
    this.nz = Math.max(1, Math.ceil((max.z - min.z) / CELL));
    this.flags = new Uint16Array(this.nx * this.nz);
    this.room = new Int16Array(this.nx * this.nz).fill(-1);
    this.rugTop = new Float32Array(this.nx * this.nz);
  }

  ix(x: number): number {
    return Math.floor((x - this.x0) / CELL);
  }
  iz(z: number): number {
    return Math.floor((z - this.z0) / CELL);
  }
  at(x: number, z: number): number {
    const i = this.ix(x), k = this.iz(z);
    return i < 0 || k < 0 || i >= this.nx || k >= this.nz ? -1 : k * this.nx + i;
  }
  cx(i: number): number {
    return this.x0 + (i + 0.5) * CELL;
  }
  cz(k: number): number {
    return this.z0 + (k + 0.5) * CELL;
  }

  /** Flag every cell whose center is inside the XZ rectangle. */
  markRect(x0: number, z0: number, x1: number, z1: number, flag: number): void {
    const i0 = Math.max(0, Math.ceil((x0 - this.x0) / CELL - 0.5)), i1 = Math.min(this.nx - 1, Math.floor((x1 - this.x0) / CELL - 0.5));
    const k0 = Math.max(0, Math.ceil((z0 - this.z0) / CELL - 0.5)), k1 = Math.min(this.nz - 1, Math.floor((z1 - this.z0) / CELL - 0.5));
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) this.flags[k * this.nx + i] |= flag;
  }

  /** Flag cells within `r` of the segment a-b (XZ). */
  markCapsule(ax: number, az: number, bx: number, bz: number, r: number, flag: number): void {
    const i0 = Math.max(0, this.ix(Math.min(ax, bx) - r)), i1 = Math.min(this.nx - 1, this.ix(Math.max(ax, bx) + r));
    const k0 = Math.max(0, this.iz(Math.min(az, bz) - r)), k1 = Math.min(this.nz - 1, this.iz(Math.max(az, bz) + r));
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const px = this.cx(i), pz = this.cz(k);
        let t = l2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t - px, qz = az + dz * t - pz;
        if (qx * qx + qz * qz <= r * r) this.flags[k * this.nx + i] |= flag;
      }
    }
  }

  /** Grow `src` flagged cells by `r` meters into `flag`. */
  dilate(src: number, r: number, flag: number): void {
    const n = Math.ceil(r / CELL);
    const hits: number[] = [];
    for (let i = 0; i < this.flags.length; i++) if (this.flags[i] & src) hits.push(i);
    for (const c of hits) {
      const ci = c % this.nx, ck = (c / this.nx) | 0;
      for (let dk = -n; dk <= n; dk++) {
        const k = ck + dk;
        if (k < 0 || k >= this.nz) continue;
        for (let di = -n; di <= n; di++) {
          const i = ci + di;
          if (i < 0 || i >= this.nx || (di * di + dk * dk) * CELL * CELL > r * r) continue;
          this.flags[k * this.nx + i] |= flag;
        }
      }
    }
  }

  /**
   * Visit every cell whose center lies in the rectangle centered (cx, cz) with half extents
   * (hw along the yaw-rotated X, hd along rotated Z). Stops early if `fn` returns false.
   */
  forRect(cx: number, cz: number, hw: number, hd: number, yaw: number, fn: (cell: number) => boolean): boolean {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // Local X = (c, -s), local Z = (s, c) in world XZ.
    const ex = Math.abs(c) * hw + Math.abs(s) * hd, ez = Math.abs(s) * hw + Math.abs(c) * hd;
    const i0 = this.ix(cx - ex), i1 = this.ix(cx + ex), k0 = this.iz(cz - ez), k1 = this.iz(cz + ez);
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const px = this.cx(i) - cx, pz = this.cz(k) - cz;
        const lx = px * c - pz * s, lz = px * s + pz * c;
        if (Math.abs(lx) > hw || Math.abs(lz) > hd) continue;
        if (i < 0 || k < 0 || i >= this.nx || k >= this.nz) {
          if (!fn(-1)) return false;
          continue;
        }
        if (!fn(k * this.nx + i)) return false;
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function hashName(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** Yaw that points a model's front (-Z) along world direction (dx, dz). */
const yawFacing = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

const boxAabb = (b: Box): Aabb => ({ minX: b.min.x, minY: b.min.y, minZ: b.min.z, maxX: b.max.x, maxY: b.max.y, maxZ: b.max.z });

const SIDES: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** A placed wall piece (for overlap tests). */
interface WallRect {
  /** Outward wall normal (from the room into the wall). */
  nx: number;
  nz: number;
  /** Wall plane offset along the normal. */
  plane: number;
  /** Position along the wall (tangent coordinate) and height. */
  s: number;
  y: number;
  hw: number;
  hh: number;
}

/** Tangent coordinate along a wall with outward normal (nx, nz). */
const along = (nx: number, nz: number, x: number, z: number): number => -nz * x + nx * z;

const _ray = new THREE.Ray();
const _raycaster = new THREE.Raycaster();
const _inv = new THREE.Matrix4();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Height of a model's top surface at (x, z) in its own frame, by raycasting down. */
function modelTopAt(root: THREE.Object3D, x: number, z: number, b: THREE.Box3): number | null {
  root.updateMatrixWorld(true);
  _raycaster.ray.origin.set(x, b.max.y + 0.1, z);
  _raycaster.ray.direction.set(0, -1, 0);
  const hit = _raycaster.intersectObject(root, true)[0];
  return hit ? hit.point.y : null;
}

// ---------------------------------------------------------------------------------------------
// DressingSet
// ---------------------------------------------------------------------------------------------

export class DressingSet {
  /** Everything placed (for debugging / dev tools). */
  readonly placed: DressingPlacementInfo[] = [];
  /** Indices into level.windows that got boarded up. */
  readonly boarded = new Set<number>();
  private readonly pieces = new Map<string, Piece>();
  private grid!: Grid;
  private rooms: Room[] = [];
  private level!: LevelData;
  private solidWalls: Aabb[] = [];
  private input!: DressingInput;
  private readonly wallRects: WallRect[] = [];
  private readonly surfaceUsed: { x: number; z: number; r: number }[] = [];
  private seed = 1;

  constructor(lib: ModelLibrary, private readonly batcher: StaticBatcher) {
    for (const full of lib.names()) {
      if (!full.startsWith(DRESSING_PREFIX)) continue;
      const asset = lib.get(full)!;
      const name = full.slice(DRESSING_PREFIX.length);
      const bounds = localBounds(asset.scene);
      if (bounds.isEmpty()) continue;
      const p = asset.extras.placement;
      const placement: DressingPlacement = p === 'surface' || p === 'wall' || p === 'ceiling' ? p : 'floor';
      const size = extrasSize(asset.extras) ?? bounds.getSize(new THREE.Vector3());
      this.pieces.set(name, { name, scene: asset.scene, placement, bounds, size });
    }
  }

  /** True if any dressing model is available. */
  get available(): boolean {
    return this.pieces.size > 0;
  }

  /** Plan + queue every piece. Call once per level, before the batcher builds. */
  scatter(input: DressingInput): void {
    if (!this.pieces.size) return;
    this.input = input;
    this.level = input.level;
    this.seed = (input.level.seed >>> 0) ^ 0x5eed;
    this.analyze();
    const has = (n: string) => this.pieces.has(n);
    // Order matters: big/structural things first, litter last.
    if (has('boards')) this.ruleBoards();
    if (has('rug')) this.ruleRugs();
    if (has('chair')) this.ruleChairs();
    if (has('toys')) this.ruleToys();
    if (has('coat_rack')) this.ruleCoatRack();
    if (has('chair_fallen')) this.ruleFallenChair();
    this.ruleWalls();
    if (has('bulb')) this.ruleBulbs();
    this.ruleSurfaces();
    this.ruleFloorClutter();
    this.ruleUnknown();
  }

  // -------------------------------------------------------------------------------------------
  // Level analysis
  // -------------------------------------------------------------------------------------------

  private analyze(): void {
    const level = this.level;
    const g = (this.grid = new Grid(level.bounds.min, level.bounds.max));
    const door = level.exit.door;
    const isDoor = (b: Box) => b === door || (b.min.x === door.min.x && b.max.x === door.max.x && b.min.z === door.min.z && b.max.z === door.max.z && b.min.y === door.min.y);
    this.solidWalls = [];
    for (const b of this.input.walls) {
      if (isDoor(b)) continue;
      if (b.min.y < 1.0) {
        g.markRect(b.min.x, b.min.z, b.max.x, b.max.z, F_WALL);
        this.solidWalls.push(boxAabb(b));
      } else {
        g.markRect(b.min.x, b.min.z, b.max.x, b.max.z, F_LINTEL);
      }
    }
    g.markRect(door.min.x, door.min.z, door.max.x, door.max.z, F_DOOR);
    for (const b of this.input.furniture) g.markRect(b.min.x - 0.02, b.min.z - 0.02, b.max.x + 0.02, b.max.z + 0.02, F_FURN);

    // Rooms: flood fill under the ceiling, walls/lintels/door close them off.
    const ceilings = level.boxes.filter((b) => b.kind === 'ceiling');
    const floors = level.boxes.filter((b) => b.kind === 'floor');
    const covered = (x: number, z: number, list: Box[]) => list.some((b) => x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z);
    const open = new Uint8Array(g.nx * g.nz);
    for (let k = 0; k < g.nz; k++) {
      for (let i = 0; i < g.nx; i++) {
        const c = k * g.nx + i;
        if (g.flags[c] & (F_WALL | F_LINTEL | F_DOOR)) continue;
        const x = g.cx(i), z = g.cz(k);
        if (ceilings.length && !covered(x, z, ceilings)) continue;
        if (floors.length && !covered(x, z, floors)) continue;
        open[c] = 1;
      }
    }
    this.rooms = [];
    const stack: number[] = [];
    for (let c0 = 0; c0 < open.length; c0++) {
      if (!open[c0] || g.room[c0] >= 0) continue;
      const id = this.rooms.length;
      const room: Room = { id, name: '', minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, cells: 0, furniture: [], windows: [] };
      stack.push(c0);
      g.room[c0] = id;
      while (stack.length) {
        const c = stack.pop()!;
        const i = c % g.nx, k = (c / g.nx) | 0;
        room.cells++;
        const x = g.cx(i), z = g.cz(k);
        room.minX = Math.min(room.minX, x - CELL / 2);
        room.maxX = Math.max(room.maxX, x + CELL / 2);
        room.minZ = Math.min(room.minZ, z - CELL / 2);
        room.maxZ = Math.max(room.maxZ, z + CELL / 2);
        const nb = [i > 0 ? c - 1 : -1, i < g.nx - 1 ? c + 1 : -1, k > 0 ? c - g.nx : -1, k < g.nz - 1 ? c + g.nx : -1];
        for (const n of nb) {
          if (n >= 0 && open[n] && g.room[n] < 0) {
            g.room[n] = id;
            stack.push(n);
          }
        }
      }
      this.rooms.push(room);
    }
    for (const b of this.input.furniture) {
      const r = this.roomOf((b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2);
      if (r) r.furniture.push(b);
    }
    level.windows.forEach((w, wi) => {
      const fx = -Math.sin(w.yaw), fz = -Math.cos(w.yaw);
      const r = this.roomOf(w.center.x + fx * 0.35, w.center.z + fz * 0.35);
      if (r) r.windows.push(wi);
    });
    for (const r of this.rooms) r.name = this.nameRoom(r);

    // Keep-out zones.
    const navIdx = new Map<number, Vec3>();
    for (const n of level.nav) navIdx.set(n.id, n.position);
    for (const n of level.nav) {
      g.markCapsule(n.position.x, n.position.z, n.position.x, n.position.z, 0.55, F_WALK);
      g.markCapsule(n.position.x, n.position.z, n.position.x, n.position.z, 0.35, F_WALK_CORE);
      for (const l of n.links) {
        const m = navIdx.get(l);
        if (!m || l < n.id) continue;
        g.markCapsule(n.position.x, n.position.z, m.x, m.z, 0.45, F_WALK);
        g.markCapsule(n.position.x, n.position.z, m.x, m.z, 0.22, F_WALK_CORE);
      }
    }
    g.dilate(F_LINTEL, 0.85, F_CLEAR);
    g.dilate(F_DOOR, 1.35, F_CLEAR);
    const disc = (p: Vec3, r: number, f: number) => g.markCapsule(p.x, p.z, p.x, p.z, r, f);
    for (const s of level.playerSpawns) disc(s.position, 0.75, F_CLEAR);
    disc(level.monsterSpawn, 0.6, F_CLEAR);
    disc(level.cameraSpawn.position, 0.4, F_ITEM);
    for (const p of [...level.fuseSpawns, ...level.filmSpawns]) disc(p, 0.4, F_ITEM);
    disc(this.input.fuseBoxMount, 1.0, F_CLEAR);
  }

  private roomOf(x: number, z: number): Room | null {
    const c = this.grid.at(x, z);
    if (c < 0) return null;
    const id = this.grid.room[c];
    return id >= 0 ? this.rooms[id] : null;
  }

  private nameRoom(r: Room): string {
    const cx = (r.minX + r.maxX) / 2, cz = (r.minZ + r.maxZ) / 2;
    if (this.level.id === LEVEL_ID) {
      const n = roomAt(cx, cz);
      if (n) return n;
    }
    const styles = new Set<PropStyle>(r.furniture.map((b) => b.style ?? 'crate'));
    const w = r.maxX - r.minX, d = r.maxZ - r.minZ;
    if (this.level.playerSpawns.some((s) => this.roomOfRoom(r, s.position))) return 'foyer';
    if (styles.has('bed')) return 'bedroom';
    if (styles.has('piano') || (styles.has('couch') && w * d > 20)) return 'living';
    const counters = r.furniture.filter((b) => b.style === 'counter');
    if (counters.some((b) => b.max.y >= 0.8)) return 'kitchen';
    if (counters.length) return 'bathroom';
    if (Math.max(w, d) / Math.max(0.1, Math.min(w, d)) > 3.2) return 'hallway';
    if (styles.has('shelf') && styles.has('table')) return 'study';
    if (styles.has('crate')) return 'storage';
    if (styles.has('table')) return 'dining';
    return 'room';
  }

  private roomOfRoom(r: Room, p: Vec3): boolean {
    return this.roomOf(p.x, p.z) === r;
  }

  private roomsNamed(...names: string[]): Room[] {
    return this.rooms.filter((r) => names.includes(r.name) && r.cells * CELL * CELL > 1.5);
  }

  /** The room the players start in. */
  private entryRoom(): Room | null {
    const s = this.level.playerSpawns[0];
    return s ? this.roomOf(s.position.x, s.position.z) : null;
  }

  private rng(tag: string): () => number {
    return makeRng((this.seed ^ hashName(tag)) >>> 0);
  }

  // -------------------------------------------------------------------------------------------
  // Footprints
  // -------------------------------------------------------------------------------------------

  /** World footprint (center, half extents) of a piece placed at (x, z, yaw, scale). */
  private footprint(p: Piece, x: number, z: number, yaw: number, s: number): { cx: number; cz: number; hw: number; hd: number } {
    const b = p.bounds;
    const lx = ((b.min.x + b.max.x) / 2) * s, lz = ((b.min.z + b.max.z) / 2) * s;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    return { cx: x + lx * c + lz * sn, cz: z - lx * sn + lz * c, hw: ((b.max.x - b.min.x) / 2) * s, hd: ((b.max.z - b.min.z) / 2) * s };
  }

  /** Can a floor piece go here? `ignore` = a furniture box it may tuck under (a chair at a table). */
  private fits(p: Piece, x: number, z: number, yaw: number, s: number, room: Room, block: number, pad = 0.03, ignore?: Box): boolean {
    const f = this.footprint(p, x, z, yaw, s);
    const g = this.grid;
    return g.forRect(f.cx, f.cz, f.hw + pad, f.hd + pad, yaw, (c) => {
      if (c < 0 || g.room[c] !== room.id) return false;
      let fl = g.flags[c];
      if (ignore && fl & F_FURN) {
        const i = c % g.nx, k = (c / g.nx) | 0;
        const px = g.cx(i), pz = g.cz(k);
        if (px >= ignore.min.x - 0.03 && px <= ignore.max.x + 0.03 && pz >= ignore.min.z - 0.03 && pz <= ignore.max.z + 0.03) fl &= ~F_FURN;
      }
      return (fl & block) === 0;
    });
  }

  private claim(p: Piece, x: number, z: number, yaw: number, s: number, flag: number, pad = 0.05): void {
    const f = this.footprint(p, x, z, yaw, s);
    this.grid.forRect(f.cx, f.cz, f.hw + pad, f.hd + pad, yaw, (c) => {
      if (c >= 0) this.grid.flags[c] |= flag;
      return true;
    });
  }

  /** Floor height under a piece (top of a rug if it stands on one). */
  private floorY(x: number, z: number): number {
    const c = this.grid.at(x, z);
    return c >= 0 ? this.grid.rugTop[c] : 0;
  }

  // -------------------------------------------------------------------------------------------
  // Emit
  // -------------------------------------------------------------------------------------------

  private emit(p: Piece, room: Room | null, x: number, y: number, z: number, yaw: number, scale: THREE.Vector3 | number, tilt?: THREE.Quaternion): void {
    const sv = typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : scale;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    if (tilt) q.multiply(tilt);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, sv);
    this.batcher.add(p.scene, m);
    this.placed.push({ name: p.name, room: room?.name ?? '?', x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), yaw: +yaw.toFixed(2), scale: +sv.x.toFixed(2) });
  }

  // -------------------------------------------------------------------------------------------
  // Floor placement helpers
  // -------------------------------------------------------------------------------------------

  /**
   * Candidate spots along the walls of a room for a floor piece: back to the wall (model +Z
   * toward the wall), `gap` from it. Returns [x, z, yaw].
   */
  private wallSpots(p: Piece, room: Room, s: number, gap = 0.03, step = 0.2): [number, number, number][] {
    const out: [number, number, number][] = [];
    const b = p.bounds;
    const backZ = b.max.z * s; // model +Z extent = distance from origin to its back
    for (const [nx, nz] of SIDES) {
      // Wall face along this side of the room's interior box.
      const len = nx !== 0 ? room.maxZ - room.minZ : room.maxX - room.minX;
      const yaw = Math.atan2(nx, nz); // model +Z -> outward normal (back to the wall)
      for (let t = 0.25; t < len - 0.25; t += step) {
        const px = nx !== 0 ? (nx > 0 ? room.maxX : room.minX) : room.minX + t;
        const pz = nz !== 0 ? (nz > 0 ? room.maxZ : room.minZ) : room.minZ + t;
        // Snap to the actual wall face (rooms aren't always rectangles).
        const face = this.wallFace(px - nx * 0.4, pz - nz * 0.4, nx, nz, 0.4);
        if (face === null) continue;
        const d = face - gap - backZ;
        out.push([px - nx * 0.4 + nx * d, pz - nz * 0.4 + nz * d, yaw]);
      }
    }
    return out;
  }

  /** Distance from (x, z) along (nx, nz) to a solid wall at knee height, or null if > max + 0.4. */
  private wallFace(x: number, z: number, nx: number, nz: number, max: number, y = 0.4): number | null {
    _o.set(x, y, z);
    _d.set(nx, 0, nz);
    let t = Infinity;
    for (const w of this.solidWalls) t = Math.min(t, rayAabb(_o, _d, w));
    return t <= max + 0.4 ? t : null;
  }

  /** Try spots in order; place the first that fits. */
  private placeFirst(p: Piece, room: Room, spots: [number, number, number][], s: number, block: number, ignore?: Box, flag = F_USED): [number, number, number] | null {
    for (const [x, z, yaw] of spots) {
      if (!this.fits(p, x, z, yaw, s, room, block, 0.03, ignore)) continue;
      this.emit(p, room, x, this.floorY(x, z), z, yaw, s);
      this.claim(p, x, z, yaw, s, flag);
      return [x, z, yaw];
    }
    return null;
  }

  /** Scale to make a piece read at its modeled size (extras.size vs real bounds). */
  private natural(p: Piece): number {
    const real = p.bounds.max.y - p.bounds.min.y;
    return real > 1e-3 && p.size.y > 1e-3 ? THREE.MathUtils.clamp(p.size.y / real, 0.5, 2) : 1;
  }

  // -------------------------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------------------------

  /** Chairs tucked under the long sides of tables and in front of desks. */
  private ruleChairs(): void {
    const p = this.pieces.get('chair')!;
    const rnd = this.rng('chair');
    const s = this.natural(p);
    const depth = (p.bounds.max.z - p.bounds.min.z) * s;
    const width = (p.bounds.max.x - p.bounds.min.x) * s;
    for (const room of this.roomsNamed('dining', 'kitchen', 'study', 'room')) {
      for (const t of room.furniture) {
        if (t.style !== 'table' || t.max.y < 0.6) continue;
        const sx = t.max.x - t.min.x, sz = t.max.z - t.min.z;
        const long = Math.max(sx, sz);
        const isDesk = room.name === 'study' || (long < 2 && room.name !== 'dining' && room.name !== 'kitchen');
        // Seats per long side.
        const per = long >= 2.0 ? 2 : 1;
        const sides: [number, number][] = sx >= sz ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
        if (long >= 2.2 && sx !== sz) sides.push(...((sx >= sz ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]]) as [number, number][]));
        let placed = 0;
        for (const [nx, nz] of shuffle(sides, rnd)) {
          const endSide = (sx >= sz) === (nx !== 0); // short end of the table
          const span = nx !== 0 ? sz : sx;
          // Head-of-table chairs only sometimes.
          if (endSide && rnd() < 0.5) continue;
          const count = endSide ? 1 : per;
          for (let i = 0; i < count; i++) {
            if (isDesk && placed >= 1) break;
            const along0 = count === 1 ? 0 : (i - (count - 1) / 2) * Math.min(span / count, width + 0.25);
            const tuck = 0.1 + rnd() * 0.12;
            const cx = (t.min.x + t.max.x) / 2, cz = (t.min.z + t.max.z) / 2;
            const ex = nx !== 0 ? (nx > 0 ? t.max.x : t.min.x) : cx + along0;
            const ez = nz !== 0 ? (nz > 0 ? t.max.z : t.min.z) : cz + along0;
            const off = depth / 2 - tuck;
            const x = ex + nx * off, z = ez + nz * off;
            // Facing the table, slightly askew.
            const yaw = yawFacing(-nx, -nz) + (rnd() - 0.5) * 0.35;
            if (!this.fits(p, x, z, yaw, s, room, SOLID_BLOCK, 0.02, t)) continue;
            this.emit(p, room, x, this.floorY(x, z), z, yaw, s);
            this.claim(p, x, z, yaw, s, F_USED, 0.02);
            placed++;
          }
        }
      }
    }
    // One lonely chair against a bedroom wall.
    for (const room of this.roomsNamed('bedroom')) {
      this.placeFirst(p, room, shuffle(this.wallSpots(p, room, s, 0.05), rnd), s, SOLID_BLOCK);
    }
  }

  private ruleFallenChair(): void {
    const p = this.pieces.get('chair_fallen')!;
    const rnd = this.rng('chair_fallen');
    const s = this.natural(p);
    for (const room of shuffle(this.roomsNamed('dining', 'kitchen', 'study'), rnd).slice(0, 1)) {
      const spots: [number, number, number][] = [];
      for (let k = 0; k < 160; k++) {
        const x = room.minX + 0.4 + rnd() * (room.maxX - room.minX - 0.8);
        const z = room.minZ + 0.4 + rnd() * (room.maxZ - room.minZ - 0.8);
        spots.push([x, z, rnd() * Math.PI * 2]);
      }
      // Prefer spots near furniture (it fell off its table, not in the middle of nowhere).
      const near = (x: number, z: number) => Math.min(...room.furniture.map((b) => Math.hypot(Math.max(b.min.x - x, 0, x - b.max.x), Math.max(b.min.z - z, 0, z - b.max.z))), 9);
      spots.sort((a, b) => near(a[0], a[1]) - near(b[0], b[1]));
      this.placeFirst(p, room, spots, s, SOLID_BLOCK);
    }
  }

  /** Something you see in your first flash: straight ahead of the spawn, against a far wall. */
  private ruleToys(): void {
    const p = this.pieces.get('toys')!;
    const s = this.natural(p);
    const sp = this.level.playerSpawns;
    if (!sp.length) return;
    let cx = 0, cz = 0;
    for (const q of sp) { cx += q.position.x; cz += q.position.z; }
    cx /= sp.length;
    cz /= sp.length;
    const yaw = sp[0].yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const g = this.grid;
    // March forward (through doorways) until a solid wall or furniture.
    let hit: [number, number] | null = null;
    for (let t = 1.5; t < 30; t += CELL / 2) {
      const x = cx + fx * t, z = cz + fz * t;
      const c = g.at(x, z);
      if (c < 0) break;
      if (g.flags[c] & (F_WALL | F_FURN | F_DOOR)) {
        hit = [x - fx * CELL, z - fz * CELL];
        break;
      }
    }
    const tries: [number, number, number][] = [];
    const face = yawFacing(-fx, -fz);
    if (hit) {
      const back = p.bounds.max.z * s + 0.05;
      for (const side of [0, 0.25, -0.25, 0.5, -0.5, 0.8, -0.8, 1.2, -1.2]) {
        tries.push([hit[0] - fx * back + fz * side, hit[1] - fz * back - fx * side, face + side * 0.15]);
      }
      const room = this.roomOf(hit[0], hit[1]);
      if (room && this.placeFirst(p, room, tries, s, SOLID_BLOCK)) return;
    }
    // Fallback: a bedroom corner.
    const rnd = this.rng('toys');
    for (const room of this.roomsNamed('bedroom', 'living')) {
      if (this.placeFirst(p, room, shuffle(this.wallSpots(p, room, s, 0.05), rnd), s, SOLID_BLOCK)) return;
    }
  }

  private ruleCoatRack(): void {
    const p = this.pieces.get('coat_rack')!;
    const room = this.entryRoom();
    if (!room) return;
    const s = this.natural(p);
    const rnd = this.rng('coat');
    // Corners first (a coat rack lives in a corner), then anywhere along a wall.
    const spots = this.wallSpots(p, room, s, 0.06, 0.1);
    const corner = (x: number, z: number) => Math.min(x - room.minX, room.maxX - x) + Math.min(z - room.minZ, room.maxZ - z);
    spots.sort((a, b) => corner(a[0], a[1]) - corner(b[0], b[1]) + (rnd() - 0.5) * 0.3);
    this.placeFirst(p, room, spots, s, SOLID_BLOCK);
  }

  /** Rugs under the living room seating, beside the bed, in front of the study desk. */
  private ruleRugs(): void {
    const p = this.pieces.get('rug')!;
    const rnd = this.rng('rug');
    const rw = p.bounds.max.x - p.bounds.min.x, rd = p.bounds.max.z - p.bounds.min.z;
    // The rug's real top (its bounds include curled corners): raycast its middle.
    const top = Math.min(p.bounds.max.y, modelTopAt(p.scene, (p.bounds.min.x + p.bounds.max.x) / 2, (p.bounds.min.z + p.bounds.max.z) / 2, p.bounds) ?? 0.012);
    const targets: { room: Room; cx: number; cz: number; w: number; d: number; alongX: boolean }[] = [];
    for (const room of this.rooms) {
      const f = room.furniture;
      const pick = (style: PropStyle, minH = 0, maxH = 9) => f.filter((b) => b.style === style && b.max.y >= minH && b.max.y <= maxH);
      if (room.name === 'living') {
        // Centered on the coffee table, stretched toward the couch.
        const table = pick('table', 0, 0.6)[0];
        const couch = pick('couch').sort((a, b) => (b.max.x - b.min.x) * (b.max.z - b.min.z) - (a.max.x - a.min.x) * (a.max.z - a.min.z))[0];
        if (table) {
          let cx = (table.min.x + table.max.x) / 2, cz = (table.min.z + table.max.z) / 2;
          if (couch) {
            cx = (cx * 2 + (couch.min.x + couch.max.x) / 2) / 3;
            cz = (cz * 2 + (couch.min.z + couch.max.z) / 2) / 3;
          }
          const alongX = table.max.x - table.min.x >= table.max.z - table.min.z;
          targets.push({ room, cx, cz, w: 2.6, d: 1.9, alongX });
        }
      } else if (room.name === 'bedroom') {
        const bed = pick('bed')[0];
        if (bed) {
          // On the open long side of the bed, half under it.
          const sx = bed.max.x - bed.min.x, sz = bed.max.z - bed.min.z;
          const alongX = sx >= sz;
          const cx = (bed.min.x + bed.max.x) / 2, cz = (bed.min.z + bed.max.z) / 2;
          for (const sgn of [1, -1]) {
            const ox = alongX ? 0 : sgn * (sx / 2 + 0.25), oz = alongX ? sgn * (sz / 2 + 0.25) : 0;
            targets.push({ room, cx: cx + ox, cz: cz + oz, w: Math.max(sx, sz) * 0.9, d: 1.1, alongX });
          }
        }
      } else if (room.name === 'study' || room.name === 'dining') {
        const table = pick('table', 0.6)[0];
        if (table) {
          const alongX = table.max.x - table.min.x >= table.max.z - table.min.z;
          const big = room.name === 'dining';
          targets.push({
            room, cx: (table.min.x + table.max.x) / 2, cz: (table.min.z + table.max.z) / 2,
            w: (alongX ? table.max.x - table.min.x : table.max.z - table.min.z) + (big ? 1.0 : 0.9),
            d: (alongX ? table.max.z - table.min.z : table.max.x - table.min.x) + (big ? 1.2 : 1.0),
            alongX,
          });
        }
      }
    }
    const done = new Set<Room>();
    for (const t of targets) {
      if (done.has(t.room)) continue;
      // Rug's long side along the target's long side.
      const rugLongX = rw >= rd;
      const yaw = (t.alongX === rugLongX ? 0 : Math.PI / 2) + (rnd() < 0.5 ? 0 : Math.PI) + (rnd() - 0.5) * 0.08;
      const long = Math.max(rw, rd), short = Math.min(rw, rd);
      let s = Math.min(t.w / long, t.d / short);
      s = THREE.MathUtils.clamp(s, 0.5, 1.6);
      for (let k = 0; k < 6; k++, s *= 0.88) {
        // Offset so the rug's bounds center lands on the target center.
        const f = this.footprint(p, 0, 0, yaw, s);
        const x = t.cx - f.cx, z = t.cz - f.cz;
        if (!this.fits(p, x, z, yaw, s, t.room, RUG_BLOCK, 0.02)) continue;
        const sv = new THREE.Vector3(s, 1, s);
        this.emit(p, t.room, x, 0, z, yaw, sv);
        const ff = this.footprint(p, x, z, yaw, s);
        this.grid.forRect(ff.cx, ff.cz, ff.hw, ff.hd, yaw, (c) => {
          if (c >= 0) {
            this.grid.flags[c] |= F_RUG;
            this.grid.rugTop[c] = Math.max(0, top);
          }
          return true;
        });
        done.add(t.room);
        break;
      }
    }
  }

  /** Boards nailed over a couple of windows (never the entry room's: that's the way out). */
  private ruleBoards(): void {
    const p = this.pieces.get('boards')!;
    const rnd = this.rng('boards');
    const entry = this.entryRoom();
    const cands = this.level.windows.map((w, i) => ({ w, i })).filter(({ w, i }) => {
      const r = this.rooms.find((rr) => rr.windows.includes(i));
      return w.width >= 0.7 && r !== entry;
    });
    const want = Math.min(2, cands.length);
    const rooms = new Set<Room>();
    for (const { w, i } of shuffle(cands, rnd)) {
      if (this.boarded.size >= want) break;
      const room = this.rooms.find((rr) => rr.windows.includes(i)) ?? null;
      if (room && rooms.has(room)) continue;
      const fx = -Math.sin(w.yaw), fz = -Math.cos(w.yaw);
      // Pane on the inner wall face (like LevelView), boards just in front of the frame trim.
      _o.set(w.center.x + fx * 0.3, w.center.y, w.center.z + fz * 0.3);
      _d.set(-fx, 0, -fz);
      let t = Infinity;
      for (const a of this.solidWalls) t = Math.min(t, rayAabb(_o, _d, a));
      const face = t < 1 ? _o.clone().addScaledVector(_d, t) : new THREE.Vector3(w.center.x, w.center.y, w.center.z);
      const b = p.bounds;
      const bw = b.max.x - b.min.x, bh = b.max.y - b.min.y;
      const sx = THREE.MathUtils.clamp((w.width + 0.22) / bw, 0.5, 2.2);
      const sy = THREE.MathUtils.clamp((w.height + 0.1) / bh, 0.5, 2.2);
      const sz = Math.sqrt(sx * sy);
      const yaw = w.yaw;
      // Bottom sits on the window sill (top of the sill = bottom of the pane).
      const cy = w.center.y - w.height / 2 - b.min.y * sy;
      const out = 0.038;
      const lx = ((b.min.x + b.max.x) / 2) * sx;
      const x = face.x + fx * out - Math.cos(yaw) * lx;
      const z = face.z + fz * out + Math.sin(yaw) * lx;
      this.emit(p, room, x, cy, z, yaw, new THREE.Vector3(sx, sy, sz));
      this.boarded.add(i);
      if (room) rooms.add(room);
    }
  }

  /** Frames and clocks on clear wall spans. */
  private ruleWalls(): void {
    const P = 'frame_portrait', L = 'frame_landscape', C = 'clock';
    const perRoom: Record<string, string[]> = {
      hallway: [P, L, C, P, P],
      living: [L, P, C],
      dining: [L, P],
      bedroom: [P, L],
      foyer: [P, C],
      study: [L, C],
      kitchen: [C],
      room: [P],
    };
    const height: Record<string, number> = { [P]: 1.6, [L]: 1.55, [C]: 1.9 };
    for (const room of this.rooms) {
      const list = perRoom[room.name];
      if (!list) continue;
      const rnd = this.rng(`wall-${room.name}-${room.id}`);
      for (const name of list) {
        const p = this.pieces.get(name);
        if (p) this.placeOnWall(p, room, height[name] ?? 1.6, rnd);
      }
    }
  }

  private placeOnWall(p: Piece, room: Room, yc: number, rnd: () => number): boolean {
    const s = this.natural(p);
    const b = p.bounds;
    const hw = ((b.max.x - b.min.x) / 2) * s, hh = ((b.max.y - b.min.y) / 2) * s;
    const spots: { x: number; z: number; nx: number; nz: number; face: number }[] = [];
    for (const [nx, nz] of SIDES) {
      const len = nx !== 0 ? room.maxZ - room.minZ : room.maxX - room.minX;
      for (let t = hw + 0.3; t < len - hw - 0.3; t += 0.15) {
        const px = nx !== 0 ? (nx > 0 ? room.maxX : room.minX) - nx * 0.3 : room.minX + t;
        const pz = nz !== 0 ? (nz > 0 ? room.maxZ : room.minZ) - nz * 0.3 : room.minZ + t;
        spots.push({ x: px, z: pz, nx, nz, face: 0 });
      }
    }
    shuffle(spots, rnd);
    for (const sp of spots) {
      let y = yc + (rnd() - 0.5) * 0.12;
      // Raise above low furniture standing against this wall (a portrait over the sideboard).
      const below = this.furnitureAgainst(room, sp, hw);
      if (below.some((f) => f.max.y > 1.3)) continue;
      const topBelow = Math.max(0, ...below.map((f) => f.max.y));
      y = Math.max(y, topBelow + hh + 0.22);
      if (y + hh > 2.55) continue;
      const face = this.flatWall(sp.x, sp.z, sp.nx, sp.nz, hw, y - hh + 0.04, y + hh - 0.04, room);
      if (face === null) continue;
      const fx = sp.x + sp.nx * face, fz = sp.z + sp.nz * face;
      const s0 = along(sp.nx, sp.nz, fx, fz);
      const plane = sp.nx * fx + sp.nz * fz;
      if (!this.wallClear(sp.nx, sp.nz, plane, s0, y, hw, hh)) continue;
      // Origin = center of the back face; it faces into the room (model -Z = -normal).
      const yaw = Math.atan2(sp.nx, sp.nz);
      const lx = ((b.min.x + b.max.x) / 2) * s;
      const x = fx - Math.cos(yaw) * lx - sp.nx * 0.002, z = fz + Math.sin(yaw) * lx - sp.nz * 0.002;
      const oy = y - ((b.min.y + b.max.y) / 2) * s;
      // Frames hang a hair crooked.
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (rnd() - 0.5) * 0.06);
      this.emit(p, room, x, oy, z, yaw, s, tilt);
      this.wallRects.push({ nx: sp.nx, nz: sp.nz, plane, s: s0, y, hw, hh });
      return true;
    }
    return false;
  }

  /** Furniture standing against the wall in front of a wall spot (within 0.8 m, overlapping the span). */
  private furnitureAgainst(room: Room, sp: { x: number; z: number; nx: number; nz: number }, hw: number): Box[] {
    const out: Box[] = [];
    for (const f of room.furniture) {
      const gap = sp.nx > 0 ? (sp.x + 0.3) - f.max.x : sp.nx < 0 ? f.min.x - (sp.x - 0.3) : sp.nz > 0 ? (sp.z + 0.3) - f.max.z : f.min.z - (sp.z - 0.3);
      if (gap > 0.8) continue;
      const lo = sp.nx !== 0 ? f.min.z : f.min.x, hi = sp.nx !== 0 ? f.max.z : f.max.x;
      const c = sp.nx !== 0 ? sp.z : sp.x;
      if (hi < c - hw - 0.1 || lo > c + hw + 0.1) continue;
      out.push(f);
    }
    return out;
  }

  /**
   * Is the wall behind (x, z) flat and solid across +-hw at heights y0..y1? Returns the distance
   * to its face, or null. Also requires the room in front all along.
   */
  private flatWall(x: number, z: number, nx: number, nz: number, hw: number, y0: number, y1: number, room: Room): number | null {
    let face: number | null = null;
    const tx = -nz, tz = nx;
    for (let u = -hw; u <= hw + 1e-6; u += Math.min(0.1, hw)) {
      const px = x + tx * u, pz = z + tz * u;
      if (this.roomOf(px, pz) !== room) return null;
      for (const y of [y0, (y0 + y1) / 2, y1]) {
        const d = this.wallFace(px, pz, nx, nz, 0.25, y);
        if (d === null) return null;
        if (face === null) face = d;
        else if (Math.abs(d - face) > 0.015) return null;
      }
    }
    return face;
  }

  /** No window, door, fuse box or other wall piece overlaps this wall rect. */
  private wallClear(nx: number, nz: number, plane: number, s0: number, y: number, hw: number, hh: number): boolean {
    const same = (ax: number, az: number, p: number) => Math.abs(ax * nx + az * nz - 1) < 0.01 && Math.abs(p - plane) < 0.3;
    for (const w of this.level.windows) {
      const fx = -Math.sin(w.yaw), fz = -Math.cos(w.yaw); // faces into the room = -normal
      if (!same(-fx, -fz, -fx * w.center.x - fz * w.center.z)) continue;
      const ws = along(nx, nz, w.center.x, w.center.z);
      if (Math.abs(ws - s0) < hw + w.width / 2 + 0.18 && Math.abs(w.center.y - y) < hh + w.height / 2 + 0.15) return false;
    }
    const fb = this.input.fuseBoxMount;
    if (Math.abs(nx * fb.x + nz * fb.z - plane) < 0.4 && Math.abs(along(nx, nz, fb.x, fb.z) - s0) < hw + 0.45) return false;
    const d = this.level.exit.door;
    const dc = new THREE.Vector3((d.min.x + d.max.x) / 2, 0, (d.min.z + d.max.z) / 2);
    const dw = Math.max(d.max.x - d.min.x, d.max.z - d.min.z);
    if (Math.abs(nx * dc.x + nz * dc.z - plane) < 0.5 && Math.abs(along(nx, nz, dc.x, dc.z) - s0) < hw + dw / 2 + 0.3) return false;
    for (const r of this.wallRects) {
      if (r.nx !== nx || r.nz !== nz || Math.abs(r.plane - plane) > 0.05) continue;
      if (Math.abs(r.s - s0) < r.hw + hw + 0.35 && Math.abs(r.y - y) < r.hh + hh + 0.3) return false;
    }
    return true;
  }

  /** Bare bulbs hanging over tables (and over open floor where the monster won't brush them). */
  private ruleBulbs(): void {
    const p = this.pieces.get('bulb')!;
    const rnd = this.rng('bulb');
    const s = this.natural(p);
    const drop = (p.bounds.max.y - p.bounds.min.y) * s;
    const ceilingAt = (x: number, z: number): number | null => {
      let best: number | null = null;
      for (const b of this.level.boxes) {
        if (b.kind !== 'ceiling' || x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
        best = best === null ? b.min.y : Math.min(best, b.min.y);
      }
      return best;
    };
    const spots: { room: Room; x: number; z: number; pri: number }[] = [];
    for (const room of this.rooms) {
      if (room.cells * CELL * CELL < 3) continue;
      // Over a free-standing table or island (nobody walks there).
      for (const f of room.furniture) {
        if ((f.style !== 'table' && f.style !== 'counter') || f.max.y < 0.6) continue;
        const cx = (f.min.x + f.max.x) / 2, cz = (f.min.z + f.max.z) / 2;
        const free = this.wallFace(cx, cz, 1, 0, 0.6) === null && this.wallFace(cx, cz, -1, 0, 0.6) === null
          && this.wallFace(cx, cz, 0, 1, 0.6) === null && this.wallFace(cx, cz, 0, -1, 0.6) === null;
        if (free) spots.push({ room, x: cx, z: cz, pri: 2 + rnd() });
      }
      // Middle of the room if the bulb hangs above the monster's head (2.3 m).
      const cx = (room.minX + room.maxX) / 2, cz = (room.minZ + room.maxZ) / 2;
      const ceil = ceilingAt(cx, cz);
      if (ceil !== null && ceil - drop >= 2.33) spots.push({ room, x: cx, z: cz, pri: 1 + rnd() });
    }
    spots.sort((a, b) => b.pri - a.pri);
    const used = new Set<Room>();
    for (const sp of spots) {
      if (used.size >= 4) break;
      if (used.has(sp.room)) continue;
      const ceil = ceilingAt(sp.x, sp.z);
      if (ceil === null) continue;
      const lx = ((p.bounds.min.x + p.bounds.max.x) / 2) * s, lz = ((p.bounds.min.z + p.bounds.max.z) / 2) * s;
      this.emit(p, sp.room, sp.x - lx, ceil - p.bounds.max.y * s, sp.z - lz, rnd() * Math.PI * 2, s);
      used.add(sp.room);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Surfaces
  // -------------------------------------------------------------------------------------------

  private ruleSurfaces(): void {
    const plan: { name: string; rooms: string[]; styles: PropStyle[]; per: number }[] = [
      { name: 'bottles', rooms: ['kitchen'], styles: ['counter', 'table'], per: 2 },
      { name: 'bottles', rooms: ['dining', 'living', 'bathroom', 'storage'], styles: ['counter', 'cabinet', 'crate'], per: 1 },
      { name: 'candles', rooms: ['dining'], styles: ['table'], per: 1 },
      { name: 'candles', rooms: ['living', 'bedroom', 'study', 'bathroom', 'hallway'], styles: ['piano', 'cabinet', 'table'], per: 1 },
      { name: 'books_pile', rooms: ['study', 'living', 'bedroom'], styles: ['table', 'cabinet'], per: 1 },
      { name: 'plate_broken', rooms: ['dining', 'kitchen'], styles: ['table', 'counter'], per: 1 },
      { name: 'papers', rooms: ['study', 'hallway', 'kitchen'], styles: ['table', 'cabinet'], per: 1 },
    ];
    for (const [pi, item] of plan.entries()) {
      const p = this.pieces.get(item.name);
      if (!p || item.per <= 0) continue;
      const rnd = this.rng(`surf-${item.name}-${pi}`);
      for (const room of this.roomsNamed(...item.rooms)) {
        const tops = room.furniture.filter((f) => item.styles.includes(f.style ?? 'crate') && f.max.y >= 0.4 && f.max.y <= 1.35);
        let n = 0;
        for (const top of shuffle(tops, rnd)) {
          if (n >= item.per) break;
          if (this.placeOnSurface(p, room, top, rnd)) n++;
        }
      }
    }
  }

  private placeOnSurface(p: Piece, room: Room, top: Box, rnd: () => number): boolean {
    const s = this.natural(p);
    const b = p.bounds;
    const r = Math.hypot(b.max.x - b.min.x, b.max.z - b.min.z) * s * 0.5;
    const inset = Math.min(r * 0.8 + 0.04, 0.2);
    const w = top.max.x - top.min.x - inset * 2, d = top.max.z - top.min.z - inset * 2;
    if (w <= 0 || d <= 0) return false;
    const items = [this.level.cameraSpawn.position, ...this.level.fuseSpawns, ...this.level.filmSpawns];
    for (let k = 0; k < 24; k++) {
      const x = top.min.x + inset + rnd() * w, z = top.min.z + inset + rnd() * d;
      if (items.some((q) => Math.hypot(q.x - x, q.z - z) < r + 0.16)) continue;
      if (this.surfaceUsed.some((u) => Math.hypot(u.x - x, u.z - z) < u.r + r + 0.04)) continue;
      const yaw = rnd() * Math.PI * 2;
      const y = this.surfaceHeight(top, x, z, r * 0.75);
      if (y === null) continue;
      const lx = ((b.min.x + b.max.x) / 2) * s, lz = ((b.min.z + b.max.z) / 2) * s;
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      this.emit(p, room, x - (lx * c + lz * sn), y - b.min.y * s, z - (-lx * sn + lz * c), yaw, s);
      this.surfaceUsed.push({ x, z, r });
      return true;
    }
    return false;
  }

  /**
   * Height of the flat top at (x, z) of a furniture box: raycast the placed GLB model (real
   * surface, so sinks / stoves / raised backs are rejected), or the box top for procedural pieces.
   * Null if not flat within radius r.
   */
  private surfaceHeight(box: Box, x: number, z: number, r: number): number | null {
    const placed = this.input.placed.filter((f) => {
      const hw = Math.max(f.w, f.d) / 2 + 0.05;
      return Math.abs(f.center.x - x) < hw && Math.abs(f.center.z - z) < hw;
    });
    if (!placed.length) return box.max.y;
    let y0: number | null = null;
    const pts: [number, number][] = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]];
    for (const [dx, dz] of pts) {
      const h = this.castDown(placed, x + dx, z + dz, box.max.y + 0.4);
      if (h === null) return null;
      if (Math.abs(h - box.max.y) > 0.12) return null;
      if (y0 === null) y0 = h;
      else if (Math.abs(h - y0) > 0.012) return null;
    }
    return y0;
  }

  private castDown(placed: PlacedFurniture[], x: number, z: number, from: number): number | null {
    let best: number | null = null;
    for (const f of placed) {
      _inv.copy(f.matrix).invert();
      _ray.origin.set(x, from, z).applyMatrix4(_inv);
      _ray.direction.set(0, -1, 0).transformDirection(_inv);
      _raycaster.ray.copy(_ray);
      f.scene.updateMatrixWorld(true);
      const hits = _raycaster.intersectObject(f.scene, true);
      for (const h of hits) {
        if (!h.face) continue;
        _p.copy(h.point).applyMatrix4(f.matrix);
        const n = h.face.normal.clone().transformDirection((h.object as THREE.Mesh).matrixWorld).transformDirection(f.matrix);
        if (n.y < 0.9) {
          // First hit is a slanted/vertical face: not a resting surface here.
          if (best === null || _p.y > best) return null;
          continue;
        }
        if (best === null || _p.y > best) best = _p.y;
        break;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------------------------
  // Floor clutter
  // -------------------------------------------------------------------------------------------

  private ruleFloorClutter(): void {
    const plan: { name: string; rooms: string[]; per: number; near?: PropStyle[]; litter?: boolean }[] = [
      { name: 'books_pile', rooms: ['study', 'living', 'storage'], per: 1, near: ['shelf'] },
      { name: 'papers', rooms: ['study', 'hallway', 'storage', 'bedroom'], per: 1, litter: true },
      { name: 'plate_broken', rooms: ['kitchen', 'dining'], per: 1, near: ['counter', 'table', 'cabinet'], litter: true },
      { name: 'bottles', rooms: ['storage', 'kitchen'], per: 1, near: ['crate', 'counter'] },
      { name: 'candles', rooms: ['bathroom'], per: 1, near: ['counter'] },
      { name: 'papers', rooms: ['living', 'dining'], per: 1, litter: true },
    ];
    for (const [pi, item] of plan.entries()) {
      const p = this.pieces.get(item.name);
      if (!p) continue;
      const rnd = this.rng(`floor-${item.name}-${pi}`);
      for (const room of this.roomsNamed(...item.rooms)) {
        for (let k = 0; k < item.per; k++) this.placeOnFloor(p, room, rnd, item.near, item.litter);
      }
    }
  }

  private placeOnFloor(p: Piece, room: Room, rnd: () => number, near?: PropStyle[], litter = false): boolean {
    const s = this.natural(p);
    const block = litter ? LITTER_BLOCK : SOLID_BLOCK;
    const spots: [number, number, number][] = [];
    if (near?.length) {
      // Right next to a piece of furniture (at its foot, against the wall side or its front).
      for (const f of room.furniture.filter((b) => near.includes(b.style ?? 'crate'))) {
        for (let k = 0; k < 14; k++) {
          const side = Math.floor(rnd() * 4);
          const r = Math.max(p.bounds.max.x - p.bounds.min.x, p.bounds.max.z - p.bounds.min.z) * s * 0.5 + 0.05;
          const x = side === 0 ? f.min.x - r : side === 1 ? f.max.x + r : f.min.x + rnd() * (f.max.x - f.min.x);
          const z = side === 2 ? f.min.z - r : side === 3 ? f.max.z + r : f.min.z + rnd() * (f.max.z - f.min.z);
          spots.push([x, z, rnd() * Math.PI * 2]);
        }
      }
    }
    // Along the walls, then anywhere.
    for (const sp of shuffle(this.wallSpots(p, room, s, 0.08, 0.3), rnd).slice(0, 30)) spots.push([sp[0], sp[1], sp[2] + (rnd() - 0.5) * 1.2]);
    for (let k = 0; k < (litter ? 40 : 10); k++) {
      spots.push([room.minX + 0.3 + rnd() * (room.maxX - room.minX - 0.6), room.minZ + 0.3 + rnd() * (room.maxZ - room.minZ - 0.6), rnd() * Math.PI * 2]);
    }
    return this.placeFirst(p, room, spots, s, block) !== null;
  }

  /** Pieces this file doesn't know: one each, by their placement type. */
  private ruleUnknown(): void {
    const known = new Set(['chair', 'chair_fallen', 'frame_portrait', 'frame_landscape', 'clock', 'books_pile', 'bottles', 'candles', 'plate_broken', 'rug', 'coat_rack', 'bulb', 'toys', 'papers', 'boards']);
    for (const p of this.pieces.values()) {
      if (known.has(p.name)) continue;
      const rnd = this.rng(`unknown-${p.name}`);
      const rooms = shuffle(this.rooms.filter((r) => r.cells * CELL * CELL > 4), rnd);
      for (const room of rooms) {
        let ok = false;
        if (p.placement === 'wall') ok = this.placeOnWall(p, room, 1.6, rnd);
        else if (p.placement === 'surface') {
          for (const top of room.furniture.filter((f) => f.max.y >= 0.4 && f.max.y <= 1.35)) if ((ok = this.placeOnSurface(p, room, top, rnd))) break;
        } else if (p.placement === 'floor') ok = this.placeOnFloor(p, room, rnd);
        if (ok) break;
      }
    }
  }
}
