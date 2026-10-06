/**
 * Story decals + notes: the Blender decals (public/models/decal_<name>.glb: blood, claw gouges,
 * mold, wall scrawls, a child's drawing) and handwritten notes (note_<name>.glb) placed where they
 * tell the house's story. Visual only: no collision, no gameplay state.
 *
 * Deterministic: the same level + seed + set of models gives the same layout on every client. The
 * narrative anchors are fixed (the drag trail always leads to the bathroom, the tutorial note always
 * lies by the camera); the seed picks the exact spots, small rotations and mirroring.
 *
 * The plan runs BEFORE the set-dressing scatter and hands it the spots it used (DressingReserved),
 * so frames, clutter and rugs keep clear of the story. Placement rules:
 *  - wall pieces only on flat, solid wall (ray-tested across their whole span), never on or under
 *    windows (radiators live there), over the fuse box / its conduit, by the exit door, behind
 *    furniture that would hide them, or overlapping each other; 'door' decals sit on the wall right
 *    beside a door frame (never on the moving leaf);
 *  - floor pieces clear of walls, furniture and each other (rugs are kept off them);
 *  - notes on real furniture tops (raycast against the placed GLB furniture), clear of item spawns.
 *
 * Every copy goes into the level's StaticBatcher. All decals share one material setup (same
 * texture size, alpha blend, roughness) so the batcher can merge them into one draw call per chunk;
 * notes likewise. z-fighting: wall pieces float 3 mm off the wall, floor pieces 2-3 mm, and the
 * materials use polygonOffset.
 */

import * as THREE from 'three';
import { makeRng } from '../../core/math';
import { HOUSE_ROOMS, LEVEL_ID, WALL_HEIGHT, WALL_THICKNESS, roomAt } from '../../core/level';
import type { Box, LevelData, Vec3 } from '../../core/types';
import { extrasSize, localBounds, type ModelLibrary } from './assets';
import type { StaticBatcher } from './batch';
import type { DressingReserved, FloorRect, WallRect } from './Dressing';
import type { PlacedFurniture } from './FurnitureModels';
import { rayAabb, type Aabb } from './util';

export const DECAL_PREFIX = 'decal_';
export const NOTE_PREFIX = 'note_';

type Placement = 'wall' | 'door' | 'floor' | 'ceiling' | 'surface';

interface Piece {
  /** Full model name, e.g. 'decal_mold'. */
  name: string;
  scene: THREE.Object3D;
  placement: Placement;
  kind: 'decal' | 'note';
  /** Width x height (wall pieces) or width x length (floor pieces, notes lying flat), m. */
  w: number;
  h: number;
}

export interface DecalPlacementInfo {
  name: string;
  room: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface DecalInput {
  level: LevelData;
  /** Wall boxes (incl. lintels). */
  walls: Box[];
  furniture: Box[];
  /** GLB furniture placements (to find the real top surface of each piece). */
  placed: PlacedFurniture[];
  /** World point at the center of the fuse box's back (on the wall). */
  fuseBoxMount: THREE.Vector3;
}

/** A spot on a wall face: outward normal (room -> wall, axis aligned), face point, size. */
interface WallSpot {
  room: string;
  nx: number;
  nz: number;
  fx: number;
  fz: number;
  y: number;
  hw: number;
  hh: number;
}

interface WallRule {
  rooms: readonly string[];
  /** Center height (m) and random +- jitter. */
  y: number;
  yJitter?: number;
  /** Higher = better; the best few are picked from with the seed. */
  score: (s: WallSpot) => number;
  /** Extra clearance past the piece's edges that must be flat wall too (doorway casings). */
  margin?: number;
  /** Keep solid floor dressing out of the strip in front (default true). */
  clearance?: boolean;
  /** How far the seed may stray from the best score (score units). */
  slack?: number;
  /** Lowest allowed bottom edge (baseboards). */
  minBottom?: number;
  /** Don't reject spots for being near a door frame (for 'door' decals). */
  nearDoor?: boolean;
}

const SIDES: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const HT = WALL_THICKNESS / 2;
/** Wall pieces float this far off the wall (plus polygonOffset). */
const WALL_OFFSET = 0.003;
const FLOOR_Y = 0.0025;
/** Notes' self-light (emissive x their own texture): readable at arm's length in the dark. */
const NOTE_GLOW = 0.035;

/** Tangent coordinate along a wall with outward normal (nx, nz) (same as the dressing's). */
const along = (nx: number, nz: number, x: number, z: number): number => -nz * x + nx * z;
/** Yaw that points a model's front (-Z) along world direction (dx, dz). */
const yawFacing = (dx: number, dz: number): number => Math.atan2(-dx, -dz);
const boxAabb = (b: Box): Aabb => ({ minX: b.min.x, minY: b.min.y, minZ: b.min.z, maxX: b.max.x, maxY: b.max.y, maxZ: b.max.z });
const dist2 = (ax: number, az: number, bx: number, bz: number): number => Math.hypot(ax - bx, az - bz);

function hashName(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _ray = new THREE.Ray();
const _raycaster = new THREE.Raycaster();
const _inv = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------------------------------------
// DecalSet
// ---------------------------------------------------------------------------------------------

export class DecalSet {
  /** Everything placed (for debugging / dev tools). */
  readonly placed: DecalPlacementInfo[] = [];
  private readonly pieces = new Map<string, Piece>();
  private input!: DecalInput;
  private level!: LevelData;
  private solid: Aabb[] = [];
  private seed = 1;
  private readonly wallRects: WallRect[] = [];
  private readonly floorRects: FloorRect[] = [];
  private reserved: DressingReserved = { walls: [], floor: [], clearance: [], surfaces: [] };

  constructor(lib: ModelLibrary, private readonly batcher: StaticBatcher) {
    for (const full of lib.names()) {
      const kind = full.startsWith(DECAL_PREFIX) ? 'decal' : full.startsWith(NOTE_PREFIX) ? 'note' : null;
      if (!kind) continue;
      const asset = lib.get(full)!;
      const bounds = localBounds(asset.scene);
      if (bounds.isEmpty()) continue;
      const p = asset.extras.placement;
      const placement: Placement = p === 'wall' || p === 'door' || p === 'floor' || p === 'ceiling' || p === 'surface' ? p : 'wall';
      const size = extrasSize(asset.extras) ?? bounds.getSize(new THREE.Vector3());
      const flat = placement === 'floor' || placement === 'surface' || placement === 'ceiling';
      this.pieces.set(full, { name: full, scene: asset.scene, placement, kind, w: size.x, h: flat ? size.z : size.y });
      prepareMaterials(asset.scene, kind);
    }
  }

  /** True if any decal / note model is available. */
  get available(): boolean {
    return this.pieces.size > 0;
  }

  /**
   * Plan + queue every decal and note into the batcher. Call once per level, before the set
   * dressing scatter (pass the result as its `reserved`) and before the batcher builds.
   */
  place(input: DecalInput): DressingReserved {
    this.input = input;
    this.level = input.level;
    this.seed = (input.level.seed >>> 0) ^ 0xdeca1;
    this.solid = input.walls.filter((b) => b.min.y < 1.0).map(boxAabb);
    this.reserved = { walls: [], floor: [], clearance: [], surfaces: [] };
    if (!this.pieces.size) return this.reserved;
    if (this.level.id === LEVEL_ID) this.storyOldHouse();
    else this.tutorialAnywhere();
    return this.reserved;
  }

  private rng(tag: string): () => number {
    return makeRng((this.seed ^ hashName(tag)) >>> 0);
  }

  // -------------------------------------------------------------------------------------------
  // The story of the old house
  // -------------------------------------------------------------------------------------------

  private storyOldHouse(): void {
    const room = (n: string) => HOUSE_ROOMS.find((r) => r.name === n)!;
    const center = (n: string) => ({ x: (room(n).min.x + room(n).max.x) / 2, z: (room(n).min.z + room(n).max.z) / 2 });
    const spawn = this.spawnCenter();
    /** Prefer spots close to (x, z). */
    const near = (x: number, z: number) => (s: WallSpot) => -dist2(s.fx, s.fz, x, z);
    /** Prefer spots a viewer at (x, z) faces head-on and isn't too far from. */
    const seenFrom = (x: number, z: number) => (s: WallSpot) => {
      const dx = x - s.fx, dz = z - s.fz;
      const d = Math.hypot(dx, dz) || 1;
      const facing = -(s.nx * dx + s.nz * dz) / d; // front faces -n
      return facing * 3 - d * 0.15;
    };

    // 1. The first flash from the spawn: "IT HEARS YOU" on the foyer wall left of the arch and,
    //    through the arch, "SHHH" + the tally of days on the hallway wall straight ahead.
    this.wallPiece('decal_writing_hears', {
      rooms: ['foyer'], y: 1.62, yJitter: 0.05, score: near(-1.85, 1.3), slack: 0.4,
    }, false, 0.025);
    this.wallPiece('decal_writing_shh', {
      rooms: ['hallway'], y: 1.42, yJitter: 0.05, score: near(spawn.x - 0.25, -1.1), slack: 0.35, clearance: false,
    }, false, 0.02);
    // ... and a pinned note beside it (whoever wrote SHHH had more to say)
    const shh = this.placed.find((p) => p.name === 'decal_writing_shh');
    this.wallPiece('note_whisper', {
      rooms: ['hallway'], y: 1.5, yJitter: 0.04,
      score: shh ? (s) => -Math.abs(dist2(s.fx, s.fz, shh.x, shh.z) - 1.15) * 2 - (s.nz < 0 ? 0 : 3) : near(1.2, -1.1),
      slack: 0.3,
    }, false, 0.05);

    // 2. Something tried to get out: gouges on the wall right beside the front door's frame.
    this.besideExitDoor('decal_scratches');

    // 3. The struggle in the hallway: handprints smeared down the wall where someone was caught,
    //    the drag trail leading from there through the bedroom into the bathroom (the deepest
    //    room, where it sleeps), and claw marks around the bedroom doorway.
    this.wallPiece('decal_handprints', { rooms: ['hallway'], y: 1.02, yJitter: 0.05, score: near(-6.0, -1.1), slack: 0.5 }, true);
    this.dragTrail([
      { x: -6.0, z: -0.35 }, { x: -7.95, z: -1.2 }, { x: -7.55, z: -3.2 }, { x: -6.35, z: -5.35 },
      { x: -5.0, z: -6.45 }, { x: -4.0, z: -6.55 },
    ]);
    this.besideDoorway('decal_scratches', 'hallway', 'bedroom');

    // 4. The bedroom: the child's crayon drawing over the bed, her note dropped at its foot.
    this.wallPiece('decal_drawing', { rooms: ['bedroom'], y: 1.22, yJitter: 0.06, score: near(-10.9, -4.6), slack: 0.6 }, false, 0.06);
    const bed = this.input.furniture.find((b) => b.style === 'bed' && roomAt((b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2) === 'bedroom');
    if (bed) {
      const door = { x: -7.95, z: -1.9 };
      const cx = (bed.min.x + bed.max.x) / 2, cz = (bed.min.z + bed.max.z) / 2;
      // at the open (foot) end of the bed, or along its open long side
      const foot = Math.abs(bed.min.x - room('bedroom').min.x) < 0.3 ? { x: bed.max.x + 0.32, z: cz } : { x: bed.min.x - 0.32, z: cz };
      this.floorNote('note_dad', 'bedroom', [foot, { x: foot.x, z: cz + 0.45 }, { x: foot.x, z: cz - 0.45 }, { x: cx + 0.4, z: bed.min.z - 0.3 }], door);
    }

    // 5. Water got in where it lives: mold blooming down from the ceiling corners.
    this.wallPiece('decal_mold', {
      rooms: ['bathroom'], y: WALL_HEIGHT - 0.79, yJitter: 0.01, score: (s) => this.cornerScore(s), slack: 0.4, clearance: false,
    }, 'corner');
    this.wallPiece('decal_mold', {
      rooms: ['storage'], y: WALL_HEIGHT - 0.79, yJitter: 0.01, score: (s) => this.cornerScore(s) + (s.nz < 0 ? 0.5 : 0), slack: 0.4,
      clearance: false,
    }, 'corner');

    // 6. The kitchen: "DON'T TALK" facing whoever walks in, and the note that explains why it
    //    keeps coming back here (it remembers where it heard things).
    const kDoor = { x: 6.55, z: -1.9 };
    this.wallPiece('decal_writing_dont', { rooms: ['kitchen'], y: 1.55, yJitter: 0.06, score: seenFrom(kDoor.x, kDoor.z), slack: 0.6 }, false, 0.03);
    this.surfaceNote('note_kitchen', 'kitchen', ['table', 'counter'], kDoor);

    // 7. More hands: one more smear somewhere it fought back (seeded room).
    const rnd = this.rng('hands2');
    const second = ['dining', 'kitchen', 'living'][Math.floor(rnd() * 3)];
    this.wallPiece('decal_handprints', { rooms: [second], y: 1.0, yJitter: 0.08, score: () => rnd(), slack: 1 }, true);

    // 8. The notes: the tutorial by the camera (everyone reads it first), the study desk note about
    //    the flash, Tom's in the living room.
    this.tutorialNote();
    this.surfaceNote('note_flash', 'study', ['table'], { x: 2.55, z: -1.9 });
    const lv = center('living');
    const chair = this.input.furniture.find((b) => b.style === 'couch' && roomAt(b.min.x, b.min.z) === 'living' && b.max.x - b.min.x < 1.2);
    const tomSpots = chair
      ? [{ x: chair.min.x - 0.35, z: (chair.min.z + chair.max.z) / 2 }, { x: (chair.min.x + chair.max.x) / 2, z: chair.max.z + 0.35 },
        { x: chair.min.x - 0.3, z: chair.max.z + 0.3 }]
      : [{ x: lv.x, z: lv.z }];
    this.floorNote('note_tom', 'living', tomSpots, { x: -3.7, z: 5.05 });
  }

  /** Prefer the top corners of the wall (mold). */
  private cornerScore(s: WallSpot): number {
    const r = HOUSE_ROOMS.find((q) => q.name === s.room);
    if (!r) return 0;
    const t = along(s.nx, s.nz, s.fx, s.fz);
    // the wall's two ends in tangent coordinates
    const ends = s.nx !== 0 ? [s.nx * (r.min.z + HT), s.nx * (r.max.z - HT)] : [-s.nz * (r.min.x + HT), -s.nz * (r.max.x - HT)];
    const gap = Math.min(...ends.map((e) => Math.abs(Math.abs(t - e) - s.hw)));
    return -gap * 2;
  }

  private spawnCenter(): { x: number; z: number } {
    const sp = this.level.playerSpawns;
    let x = 0, z = 0;
    for (const s of sp) {
      x += s.position.x;
      z += s.position.z;
    }
    return sp.length ? { x: x / sp.length, z: z / sp.length } : { x: 0, z: 0 };
  }

  // -------------------------------------------------------------------------------------------
  // Walls
  // -------------------------------------------------------------------------------------------

  /**
   * Place a wall piece by `rule`. mirror: true = random mirroring (no text), 'corner' = mirrored so
   * the texture's left edge (its source, e.g. a leak) sits at the nearer room corner.
   */
  private wallPiece(name: string, rule: WallRule, mirror: boolean | 'corner' = false, roll = 0.04): WallSpot | null {
    const p = this.pieces.get(name);
    if (!p) return null;
    const rnd = this.rng(`wall-${name}-${rule.rooms.join(',')}`);
    const hw = p.w / 2, hh = p.h / 2;
    const y = rule.y + (rnd() - 0.5) * 2 * (rule.yJitter ?? 0);
    const cands: { s: WallSpot; score: number }[] = [];
    for (const roomName of rule.rooms) {
      for (const s of this.wallCandidates(roomName, hw, hh, y)) {
        if (!this.wallOk(s, rule.margin ?? 0.15, rule.minBottom ?? 0.15, rule.nearDoor ?? false)) continue;
        cands.push({ s, score: rule.score(s) });
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);
    const slack = rule.slack ?? 0.3;
    const top = cands.filter((c) => c.score >= cands[0].score - slack);
    const pick = top[Math.floor(rnd() * top.length) % top.length].s;
    let sx = 1;
    if (mirror === true) sx = rnd() < 0.5 ? -1 : 1;
    else if (mirror === 'corner') sx = this.cornerMirror(pick);
    this.emitWall(p, pick, sx, (rnd() - 0.5) * 2 * roll, rule.clearance ?? true);
    return pick;
  }

  /** Candidate spots along every wall face of a room (wall-centerline rects from HOUSE_ROOMS). */
  private wallCandidates(roomName: string, hw: number, hh: number, y: number): WallSpot[] {
    const r = HOUSE_ROOMS.find((q) => q.name === roomName);
    if (!r) return [];
    const out: WallSpot[] = [];
    for (const [nx, nz] of SIDES) {
      if (nx !== 0) {
        const fx = (nx > 0 ? r.max.x : r.min.x) - nx * HT;
        for (let z = r.min.z + HT + hw + 0.04; z <= r.max.z - HT - hw - 0.04 + 1e-6; z += 0.05) out.push({ room: roomName, nx, nz, fx, fz: z, y, hw, hh });
      } else {
        const fz = (nz > 0 ? r.max.z : r.min.z) - nz * HT;
        for (let x = r.min.x + HT + hw + 0.04; x <= r.max.x - HT - hw - 0.04 + 1e-6; x += 0.05) out.push({ room: roomName, nx, nz, fx: x, fz, y, hw, hh });
      }
    }
    return out;
  }

  /** Distance from (x, y, z) along (nx, nz) to a solid wall (Infinity if none). */
  private rayWall(x: number, y: number, z: number, nx: number, nz: number): number {
    _o.set(x, y, z);
    _d.set(nx, 0, nz);
    let t = Infinity;
    for (const w of this.solid) t = Math.min(t, rayAabb(_o, _d, w));
    return t;
  }

  private insideSolid(x: number, y: number, z: number, pad = 0): boolean {
    return this.solid.some((b) => x > b.minX - pad && x < b.maxX + pad && y > b.minY && y < b.maxY && z > b.minZ - pad && z < b.maxZ + pad);
  }

  /** Is this wall spot usable? (flat solid wall, nothing in the way, nothing overlapping) */
  private wallOk(s: WallSpot, margin: number, minBottom: number, nearDoor: boolean): boolean {
    const { nx, nz, hw, hh, y } = s;
    if (y - hh < minBottom || y + hh > WALL_HEIGHT - 0.02) return false;
    const tx = -nz, tz = nx;
    const back = 0.3;
    // Flat wall across the span at three heights, in this room.
    const step = Math.min(0.1, hw);
    for (let u = -hw; u <= hw + 1e-6; u += step) {
      const ox = s.fx + tx * u - nx * back, oz = s.fz + tz * u - nz * back;
      if (roomAt(ox, oz) !== s.room) return false;
      for (const yy of [y - hh + 0.03, y, y + hh - 0.03]) {
        if (Math.abs(this.rayWall(ox, yy, oz, nx, nz) - back) > 0.012) return false;
      }
    }
    // Past the edges: more flat wall (no doorway casing / window trim), or a room corner.
    for (const u of [-hw - margin, hw + margin]) {
      const ox = s.fx + tx * u - nx * back, oz = s.fz + tz * u - nz * back;
      for (const yy of [y - hh + 0.03, y + hh - 0.03]) {
        if (this.insideSolid(ox, yy, oz)) continue;
        if (Math.abs(this.rayWall(ox, yy, oz, nx, nz) - back) > 0.012) return false;
      }
    }
    const plane = nx * s.fx + nz * s.fz;
    const s0 = along(nx, nz, s.fx, s.fz);
    // Windows (and the radiators under them): not on, under or over one.
    for (const w of this.level.windows) {
      const fx = -Math.sin(w.yaw), fz = -Math.cos(w.yaw); // into the room = -normal
      if (Math.abs(-fx - nx) > 0.01 || Math.abs(-fz - nz) > 0.01) continue;
      if (Math.abs(nx * w.center.x + nz * w.center.z - plane) > 0.35) continue;
      if (Math.abs(along(nx, nz, w.center.x, w.center.z) - s0) < hw + w.width / 2 + 0.2) return false;
    }
    // Fuse box + its conduit (runs up the wall above it).
    const fb = this.input.fuseBoxMount;
    if (Math.abs(nx * fb.x + nz * fb.z - plane) < 0.4 && Math.abs(along(nx, nz, fb.x, fb.z) - s0) < hw + 0.48) return false;
    // The exit door + its frame.
    const d = this.level.exit.door;
    const dcx = (d.min.x + d.max.x) / 2, dcz = (d.min.z + d.max.z) / 2;
    const dw = Math.max(d.max.x - d.min.x, d.max.z - d.min.z);
    if (!nearDoor && Math.abs(nx * dcx + nz * dcz - plane) < 0.5 && Math.abs(along(nx, nz, dcx, dcz) - s0) < hw + dw / 2 + 0.25) return false;
    // Furniture standing against the wall in front of it (low furniture below it is fine).
    for (const f of this.input.furniture) {
      const gap = nx > 0 ? s.fx - f.max.x : nx < 0 ? f.min.x - s.fx : nz > 0 ? s.fz - f.max.z : f.min.z - s.fz;
      if (gap > 0.9 || gap < -0.3) continue;
      const lo = nx !== 0 ? f.min.z : f.min.x, hi = nx !== 0 ? f.max.z : f.max.x;
      const c = nx !== 0 ? s.fz : s.fx;
      if (hi < c - hw - 0.05 || lo > c + hw + 0.05) continue;
      if (f.max.y > y - hh - 0.04) return false;
    }
    // Other story pieces on this wall.
    for (const r of this.wallRects) {
      if (r.nx !== nx || r.nz !== nz || Math.abs(r.plane - plane) > 0.05) continue;
      if (Math.abs(r.s - s0) < r.hw + hw + 0.12 && Math.abs(r.y - y) < r.hh + hh + 0.1) return false;
    }
    return true;
  }

  /** Mirror (-1) so the model's +X edge (texture left) is the one next to the nearer corner. */
  private cornerMirror(s: WallSpot): number {
    const r = HOUSE_ROOMS.find((q) => q.name === s.room);
    if (!r) return 1;
    const yaw = Math.atan2(s.nx, s.nz);
    const mx = Math.cos(yaw), mz = -Math.sin(yaw); // model +X in world
    // corner candidates: the two ends of this wall face
    const ends = s.nx !== 0
      ? [{ x: s.fx, z: r.min.z + HT }, { x: s.fx, z: r.max.z - HT }]
      : [{ x: r.min.x + HT, z: s.fz }, { x: r.max.x - HT, z: s.fz }];
    ends.sort((a, b) => dist2(a.x, a.z, s.fx, s.fz) - dist2(b.x, b.z, s.fx, s.fz));
    const c = ends[0];
    return (c.x - s.fx) * mx + (c.z - s.fz) * mz >= 0 ? 1 : -1;
  }

  private emitWall(p: Piece, s: WallSpot, sx: number, roll: number, clearance: boolean): void {
    const yaw = Math.atan2(s.nx, s.nz); // model front (-Z) faces -n, into the room
    const x = s.fx - s.nx * WALL_OFFSET, z = s.fz - s.nz * WALL_OFFSET;
    _q.setFromAxisAngle(_Y, yaw).multiply(_q2.setFromAxisAngle(_Z, roll));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, s.y, z), _q, new THREE.Vector3(sx, 1, 1));
    this.batcher.add(p.scene, m);
    const rect: WallRect = { nx: s.nx, nz: s.nz, plane: s.nx * s.fx + s.nz * s.fz, s: along(s.nx, s.nz, s.fx, s.fz), y: s.y, hw: s.hw, hh: s.hh };
    this.wallRects.push(rect);
    this.reserved.walls.push(rect);
    if (clearance) {
      const d = 0.35;
      this.reserved.clearance.push({
        x: s.fx - s.nx * d, z: s.fz - s.nz * d,
        hw: Math.abs(s.nz) * s.hw + Math.abs(s.nx) * d, hd: Math.abs(s.nx) * s.hw + Math.abs(s.nz) * d, yaw: 0,
      });
    }
    this.log(p, s.room, x, s.y, z, yaw);
  }

  /** A 'door' decal on the wall right beside the exit door's frame (never on the moving leaf). */
  private besideExitDoor(name: string): void {
    const p = this.pieces.get(name);
    if (!p) return;
    const d = this.level.exit.door;
    const wideX = d.max.x - d.min.x >= d.max.z - d.min.z;
    const zone = this.level.exit.zone;
    // the face inside the house: opposite the exit zone
    const outSign = wideX ? Math.sign((zone.min.z + zone.max.z) / 2 - (d.min.z + d.max.z) / 2) || 1 : Math.sign((zone.min.x + zone.max.x) / 2 - (d.min.x + d.max.x) / 2) || 1;
    const nx = wideX ? 0 : outSign, nz = wideX ? outSign : 0;
    const face = wideX ? (outSign > 0 ? d.min.z : d.max.z) : (outSign > 0 ? d.min.x : d.max.x);
    const lo = wideX ? d.min.x : d.min.z, hi = wideX ? d.max.x : d.max.z;
    const rnd = this.rng(`door-${name}`);
    const hw = p.w / 2, hh = p.h / 2;
    const y = 1.18 + (rnd() - 0.5) * 0.1;
    const sides = rnd() < 0.5 ? [-1, 1] : [1, -1];
    for (const side of sides) {
      // inner edge 5 cm under the frame's casing: the gouges run into it
      const c = side < 0 ? lo - 0.06 - hw : hi + 0.06 + hw;
      const fx = wideX ? c : face, fz = wideX ? face : c;
      const r = roomAt(fx - nx * 0.3, fz - nz * 0.3);
      if (!r) continue;
      const s: WallSpot = { room: r, nx, nz, fx, fz, y, hw, hh };
      // flat wall on the far side only (the near side is the door frame)
      if (!this.wallOk({ ...s, fx: wideX ? c + side * 0.06 : fx, fz: wideX ? fz : c + side * 0.06, hw: hw - 0.06 }, 0.1, 0.15, true)) continue;
      this.emitWall(p, s, side < 0 ? 1 : -1, (rnd() - 0.5) * 0.08, true);
      return;
    }
  }

  /** A decal beside a doorway between two rooms, on room `a`'s side. */
  private besideDoorway(name: string, a: string, b: string): void {
    const p = this.pieces.get(name);
    if (!p) return;
    const lintel = this.input.walls.find((w) => {
      if (w.min.y < 1.8 || w.min.y > 2.7) return false;
      const cx = (w.min.x + w.max.x) / 2, cz = (w.min.z + w.max.z) / 2;
      const alongX = w.max.x - w.min.x >= w.max.z - w.min.z;
      const r1 = alongX ? roomAt(cx, cz - 0.4) : roomAt(cx - 0.4, cz);
      const r2 = alongX ? roomAt(cx, cz + 0.4) : roomAt(cx + 0.4, cz);
      return (r1 === a && r2 === b) || (r1 === b && r2 === a);
    });
    if (!lintel) return;
    const cx = (lintel.min.x + lintel.max.x) / 2, cz = (lintel.min.z + lintel.max.z) / 2;
    const alongX = lintel.max.x - lintel.min.x >= lintel.max.z - lintel.min.z;
    const lo = alongX ? lintel.min.x : lintel.min.z, hi = alongX ? lintel.max.x : lintel.max.z;
    // outward normal from room a into the wall
    const sideOfA = alongX ? (roomAt(cx, cz - 0.4) === a ? -1 : 1) : (roomAt(cx - 0.4, cz) === a ? -1 : 1);
    const nx = alongX ? 0 : -sideOfA, nz = alongX ? -sideOfA : 0;
    const face = alongX ? cz + sideOfA * HT : cx + sideOfA * HT;
    const rnd = this.rng(`doorway-${name}-${a}-${b}`);
    const hw = p.w / 2, hh = p.h / 2;
    const y = 1.3 + (rnd() - 0.5) * 0.12;
    const sides = rnd() < 0.5 ? [-1, 1] : [1, -1];
    for (const side of sides) {
      const c = side < 0 ? lo - 0.13 - hw : hi + 0.13 + hw;
      const s: WallSpot = { room: a, nx, nz, fx: alongX ? c : face, fz: alongX ? face : c, y, hw, hh };
      if (!this.wallOk(s, 0.1, 0.15, false)) continue;
      this.emitWall(p, s, side < 0 ? 1 : -1, (rnd() - 0.5) * 0.1, true);
      return;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Floors
  // -------------------------------------------------------------------------------------------

  /** Fraction of a floor rect (center, half extents, yaw) that is blocked by walls / furniture. */
  private floorBlocked(x: number, z: number, hw: number, hd: number, yaw: number, pad = 0.04): number {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let n = 0, bad = 0;
    for (let a = -hw; a <= hw + 1e-6; a += Math.max(0.05, hw / 4)) {
      for (let b = -hd; b <= hd + 1e-6; b += Math.max(0.05, Math.min(0.15, hd / 4))) {
        // local X = (c, -s), local Z = (s, c) (same as the dressing grid)
        const px = x + a * c + b * s, pz = z - a * s + b * c;
        n++;
        if (!roomAt(px, pz) || this.insideSolid(px, 0.05, pz, 0.01)
          || this.input.furniture.some((f) => px > f.min.x - pad && px < f.max.x + pad && pz > f.min.z - pad && pz < f.max.z + pad)) bad++;
      }
    }
    return n ? bad / n : 1;
  }

  private floorOverlaps(x: number, z: number, r: number): boolean {
    return this.floorRects.some((f) => dist2(f.x, f.z, x, z) < Math.hypot(f.hw, f.hd) * 0.8 + r);
  }

  private emitFloor(p: Piece, room: string, x: number, y: number, z: number, yaw: number, sx: number, s: number): void {
    _q.setFromAxisAngle(_Y, yaw);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q, new THREE.Vector3(sx * s, 1, s));
    this.batcher.add(p.scene, m);
    const rect: FloorRect = { x, z, hw: (p.w / 2) * s, hd: (p.h / 2) * s, yaw };
    this.floorRects.push(rect);
    this.reserved.floor.push(rect);
    this.log(p, room, x, y, z, yaw);
  }

  /** Chain drag-trail segments along a path (each segment's forward = toward the path's end). */
  private dragTrail(path: { x: number; z: number }[]): void {
    const p = this.pieces.get('decal_drag');
    if (!p || path.length < 2) return;
    const rnd = this.rng('drag');
    const pts = path.map((q, i) => (i === 0 || i === path.length - 1 ? q : { x: q.x + (rnd() - 0.5) * 0.24, z: q.z + (rnd() - 0.5) * 0.24 }));
    const seg: number[] = [0];
    for (let i = 1; i < pts.length; i++) seg.push(seg[i - 1] + dist2(pts[i - 1].x, pts[i - 1].z, pts[i].x, pts[i].z));
    const total = seg[seg.length - 1];
    const at = (t: number): { x: number; z: number } => {
      t = Math.max(0, Math.min(total, t));
      let i = 1;
      while (i < seg.length - 1 && seg[i] < t) i++;
      const k = (t - seg[i - 1]) / Math.max(1e-6, seg[i] - seg[i - 1]);
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * k };
    };
    const L = p.h;
    const n = Math.max(1, Math.ceil((total - L * 0.15) / (L * 0.97)));
    const step = n > 1 ? (total - L) / (n - 1) : 0;
    for (let i = 0; i < n; i++) {
      const s = 0.9 + rnd() * 0.12;
      const t0 = n > 1 ? i * step : Math.max(0, (total - L) / 2);
      const a = at(t0), b = at(t0 + L * s);
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
      const yaw = yawFacing(dx / len, dz / len);
      const sl = Math.min(s, len / L + 0.05);
      if (this.floorBlocked(cx, cz, (p.w / 2) * sl * 0.8, (L / 2) * sl * 0.9, yaw) > 0.12) continue;
      this.emitFloor(p, roomAt(cx, cz) ?? '?', cx, FLOOR_Y + i * 0.0004, cz, yaw, rnd() < 0.5 ? -1 : 1, sl);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------------------------

  private items(): Vec3[] {
    return [this.level.cameraSpawn.position, ...this.level.fuseSpawns, ...this.level.filmSpawns];
  }

  /** The tutorial note on the furniture the camera lies on (next to it), else on the floor in front of the spawns. */
  private tutorialNote(): void {
    const name = 'note_tutorial';
    const p = this.pieces.get(name);
    if (!p) return;
    const cam = this.level.cameraSpawn.position;
    const sp = this.spawnCenter();
    const table = this.input.furniture.find((f) => cam.x >= f.min.x - 0.02 && cam.x <= f.max.x + 0.02 && cam.z >= f.min.z - 0.02 && cam.z <= f.max.z + 0.02 && Math.abs(f.max.y - cam.y) < 0.08);
    if (table && this.noteOnTop(p, roomAt(cam.x, cam.z) ?? '?', table, sp, 0.1, true, 0.12)) return;
    // Fallback: on the floor right in front of the spawn points.
    const s0 = this.level.playerSpawns[0];
    const yaw0 = s0?.yaw ?? 0;
    const fx = -Math.sin(yaw0), fz = -Math.cos(yaw0);
    const x = sp.x + fx * 1.1, z = sp.z + fz * 1.1;
    this.emitNote(p, roomAt(x, z) ?? '?', x, 0, z, yawFacing(-fx, -fz));
  }

  /** Same as tutorialNote() for levels without a story: just make sure the tutorial is there. */
  private tutorialAnywhere(): void {
    this.tutorialNote();
  }

  private surfaceNote(name: string, room: string, styles: string[], reader: { x: number; z: number }): void {
    const p = this.pieces.get(name);
    if (!p) return;
    const tops = this.input.furniture.filter((f) => styles.includes(f.style ?? '') && f.max.y >= 0.4 && f.max.y <= 1.35
      && roomAt((f.min.x + f.max.x) / 2, (f.min.z + f.max.z) / 2) === room);
    const rnd = this.rng(`note-${name}`);
    // free-standing tables first (they read as "someone sat here and wrote")
    tops.sort((a, b) => (a.style === 'table' ? 0 : 1) - (b.style === 'table' ? 0 : 1) || rnd() - 0.5);
    for (const t of tops) if (this.noteOnTop(p, room, t, reader, 0.15, false, 0.4)) return;
  }

  /** Put a note on top of furniture box `top`, front facing the reader. */
  private noteOnTop(p: Piece, room: string, top: Box, reader: { x: number; z: number }, itemGap: number, preferNearCamera: boolean, jitter: number): boolean {
    const rnd = this.rng(`top-${p.name}`);
    const r = Math.hypot(p.w, p.h) / 2;
    const cands: { x: number; z: number; yaw: number; score: number }[] = [];
    const cam = this.level.cameraSpawn.position;
    for (let k = 0; k < 400; k++) {
      const x = top.min.x + (top.max.x - top.min.x) * (0.08 + 0.84 * rnd());
      const z = top.min.z + (top.max.z - top.min.z) * (0.08 + 0.84 * rnd());
      const dx = reader.x - x, dz = reader.z - z;
      const dl = Math.hypot(dx, dz) || 1;
      const yaw = yawFacing(dx / dl, dz / dl) + (rnd() - 0.5) * jitter;
      // the sheet's footprint corners must stay on the top
      const c = Math.cos(yaw), s = Math.sin(yaw);
      let onTop = true;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const px = x + a * (p.w / 2) * c + b * (p.h / 2) * s, pz = z - a * (p.w / 2) * s + b * (p.h / 2) * c;
        if (px < top.min.x + 0.015 || px > top.max.x - 0.015 || pz < top.min.z + 0.015 || pz > top.max.z - 0.015) onTop = false;
      }
      if (!onTop) continue;
      if (this.items().some((q) => dist2(q.x, q.z, x, z) < r * 0.75 + itemGap)) continue;
      if (this.reserved.surfaces.some((u) => dist2(u.x, u.z, x, z) < u.r + r)) continue;
      const score = preferNearCamera ? -Math.abs(dist2(cam.x, cam.z, x, z) - (r * 0.75 + itemGap + 0.02)) * 4 - dist2(x, z, reader.x, reader.z) * 0.1
        : -Math.abs(dist2(x, z, (top.min.x + top.max.x) / 2, (top.min.z + top.max.z) / 2) - 0.15);
      cands.push({ x, z, yaw, score });
    }
    cands.sort((a, b) => b.score - a.score);
    for (const cd of cands.slice(0, 12)) {
      const y = this.topAt(top, cd.x, cd.z, r * 0.6);
      if (y === null) continue;
      this.emitNote(p, room, cd.x, y, cd.z, cd.yaw);
      this.reserved.surfaces.push({ x: cd.x, z: cd.z, r });
      return true;
    }
    return false;
  }

  /** A note dropped on the floor at the first free spot (front facing the reader). */
  private floorNote(name: string, room: string, spots: { x: number; z: number }[], reader: { x: number; z: number }): void {
    const p = this.pieces.get(name);
    if (!p) return;
    const rnd = this.rng(`floor-${name}`);
    const r = Math.hypot(p.w, p.h) / 2;
    const tries: { x: number; z: number }[] = [];
    for (const s of spots) for (let k = 0; k < 6; k++) tries.push({ x: s.x + (rnd() - 0.5) * 0.3 * (k > 0 ? 1 : 0), z: s.z + (rnd() - 0.5) * 0.3 * (k > 0 ? 1 : 0) });
    for (const t of tries) {
      if (roomAt(t.x, t.z) !== room) continue;
      const dx = reader.x - t.x, dz = reader.z - t.z;
      const dl = Math.hypot(dx, dz) || 1;
      const yaw = yawFacing(dx / dl, dz / dl) + (rnd() - 0.5) * 0.9;
      if (this.floorBlocked(t.x, t.z, p.w / 2 + 0.02, p.h / 2 + 0.02, yaw, 0.03) > 0) continue;
      if (this.floorOverlaps(t.x, t.z, r)) continue;
      this.emitNote(p, room, t.x, 0, t.z, yaw);
      const rect: FloorRect = { x: t.x, z: t.z, hw: p.w / 2, hd: p.h / 2, yaw };
      this.floorRects.push(rect);
      this.reserved.floor.push(rect);
      return;
    }
  }

  private emitNote(p: Piece, room: string, x: number, y: number, z: number, yaw: number): void {
    _q.setFromAxisAngle(_Y, yaw);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q, new THREE.Vector3(1, 1, 1));
    this.batcher.add(p.scene, m);
    this.log(p, room, x, y, z, yaw);
  }

  /**
   * Height of the flat top of furniture box `box` at (x, z): raycast the placed GLB furniture
   * (so sinks / stoves / raised backs are rejected), else the box top. Null if not flat within r.
   */
  private topAt(box: Box, x: number, z: number, r: number): number | null {
    const placed = this.input.placed.filter((f) => {
      const hw = Math.max(f.w, f.d) / 2 + 0.05;
      return Math.abs(f.center.x - x) < hw && Math.abs(f.center.z - z) < hw;
    });
    if (!placed.length) return box.max.y;
    let y0: number | null = null;
    for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
      const h = castDown(placed, x + dx, z + dz, box.max.y + 0.4);
      if (h === null || Math.abs(h - box.max.y) > 0.12) return null;
      if (y0 === null) y0 = h;
      else if (Math.abs(h - y0) > 0.01) return null;
    }
    return y0;
  }

  private log(p: Piece, room: string, x: number, y: number, z: number, yaw: number): void {
    this.placed.push({ name: p.name, room, x: +x.toFixed(2), y: +y.toFixed(3), z: +z.toFixed(2), yaw: +yaw.toFixed(2) });
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/**
 * One material setup for every decal (and one for every note), so the static batcher can merge all
 * of them into a texture-array material: decals never write depth and are pulled toward the viewer
 * (no z-fighting with the wall/floor they sit on), notes are alpha-masked paper.
 */
function prepareMaterials(root: THREE.Object3D, kind: 'decal' | 'note'): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (m.userData.muteDecal) continue;
      m.userData.muteDecal = true;
      m.polygonOffset = true;
      if (kind === 'decal') {
        m.transparent = true;
        m.depthWrite = false;
        m.polygonOffsetFactor = -2;
        m.polygonOffsetUnits = -4;
      } else {
        m.polygonOffsetFactor = -1;
        m.polygonOffsetUnits = -2;
        // Pale paper is the first thing dark-adapted eyes make out: a whisper of self-light (the
        // page's own texture, so the ink stays dark) keeps a note readable up close in the dark.
        // Same texture as the map, so the batcher can still stack every note into one array.
        const sm = m as THREE.MeshStandardMaterial;
        if (sm.isMeshStandardMaterial && sm.map) {
          sm.emissiveMap = sm.map;
          sm.emissive.setScalar(NOTE_GLOW);
        }
      }
      m.needsUpdate = true;
    }
  });
}

/** Highest upward-facing hit on the placed furniture straight below (x, from, z), or null. */
function castDown(placed: PlacedFurniture[], x: number, z: number, from: number): number | null {
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
        if (best === null || _p.y > best) return null;
        continue;
      }
      if (best === null || _p.y > best) best = _p.y;
      break;
    }
  }
  return best;
}
