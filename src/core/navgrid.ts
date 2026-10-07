/**
 * The monster's navigation grid (pure TypeScript over LevelData, no engine imports).
 *
 * A fine occupancy grid (NAV.cellSize) over the level, precomputed once per level and cached.
 * Every cell is classed by what the monster's body has to do there:
 *   TALL   open floor, it walks upright
 *   DUCK   under a door lintel lower than its standing height (it bends down, slower)
 *   CRAWL  too tight for its upright body (or brushing low furniture): on all fours, narrower
 *   CLIMB  over low furniture (beds, tables, couches, crates): it climbs onto / over it
 * A* (octile, 8-connected, no corner cutting) runs over per-meter costs (NAV.cost*), then the
 * cell path is string-pulled with exact capsule tests, never mixing segment kinds (an upright
 * stretch is never straightened across a bed, a climb never across a wall).
 *
 * The grid also knows the rooms (regions split at doorways), the doorways, patrol points, lurk
 * spots beside doorways / in corners, and how enclosed each cell is (likely hiding spots).
 */

import { MONSTER, NAV, PLAYER } from '../config';
import type { Box, LevelData, Vec3 } from './types';
import { OVERHEAD_Y, capsuleClear, distToBox, segmentHitsRect } from './physics';

export const CELL_BLOCKED = 0;
export const CELL_TALL = 1;
export const CELL_DUCK = 2;
export const CELL_CRAWL = 3;
export const CELL_CLIMB = 4;

/** Kind of a route segment. String pulling never merges segments of different kinds. */
export type SegKind = 'upright' | 'crawl' | 'climb';

export interface RoutePoint {
  x: number;
  z: number;
  /** How the body travels the segment that ENDS at this point. */
  kind: SegKind;
}

export interface LurkSpot {
  position: Vec3;
  /** Where it listens while waiting there (the doorway, or the room). */
  focus: Vec3;
  region: number;
}

export interface NavRegion {
  id: number;
  /** Floor area (m^2) of its walkable cells. */
  area: number;
  center: Vec3;
  /** Spread-out points it walks to when patrolling the room. */
  patrol: Vec3[];
  lurks: LurkSpot[];
}

export interface NavDoorway {
  id: number;
  center: Vec3;
  regions: number[];
}

export interface NavGrid {
  readonly cell: number;
  /** World X/Z of the corner of cell (0, 0). */
  readonly ox: number;
  readonly oz: number;
  readonly w: number;
  readonly h: number;
  /** Traversal class per cell (CELL_*; 0 = blocked or unreachable from inside the house). */
  readonly cls: Uint8Array;
  /** Extra A* cost per meter for hugging walls / furniture (0 in the open). */
  readonly hug: Float32Array;
  /** Distance from the cell center to the nearest wall / door / furniture of any height. */
  readonly allClear: Float32Array;
  /** 1 where an upright body would be under a lintel lower than its standing height. */
  readonly lintel: Uint8Array;
  /** 1 where a player could stand (clear of everything by PLAYER.radius, inside the house). */
  readonly stand: Uint8Array;
  /** 0..8: how enclosed the cell is (walls / furniture around it): corners, behind furniture. */
  readonly nook: Uint8Array;
  /** Room id per cell (-1 in doorways and blocked cells). */
  readonly region: Int16Array;
  readonly regions: NavRegion[];
  readonly doorways: NavDoorway[];
  /**
   * Coarse (1 m) sample points of player-standable floor, with their room: the AI tracks when
   * each was last within its earshot and roams toward areas it has not listened to lately.
   */
  readonly listen: { x: Float32Array; z: Float32Array; region: Int16Array; n: number };
  /** Walls, the exit door and furniture too tall to climb: what its body never passes. */
  readonly hard: Box[];
  /** `hard` without the exit door (movement once the door is open). */
  readonly hardOpen: Box[];
  /** Low furniture it climbs over. */
  readonly climb: Box[];
  /** hard + climb: what an upright or crawling (not climbing) body must not touch. */
  readonly body: Box[];
  /** Overhead boxes (lintels) lower than its standing height. */
  readonly overhead: Box[];
  /** Walls + the exit door: they block line of sight for searches and goal snapping. */
  readonly walls: Box[];
  /** A* scratch (shared; the sim is single-threaded). */
  readonly scratch: AStarScratch;
}

interface AStarScratch {
  gen: number;
  stamp: Uint32Array;
  closed: Uint32Array;
  g: Float64Array;
  parent: Int32Array;
  heapIdx: Int32Array;
  heapKey: Float64Array;
}

export const isClimbable = (b: Box): boolean =>
  b.kind === 'furniture' && b.min.y < OVERHEAD_Y && b.max.y <= MONSTER.climbMaxHeight;

const isHard = (b: Box): boolean =>
  (b.kind === 'wall' || b.kind === 'furniture') && b.min.y < OVERHEAD_Y && !isClimbable(b);

const cache = new WeakMap<LevelData, NavGrid>();

/** The (cached) nav grid of a level. Levels are static; build once, share between sims. */
export function navGridFor(level: LevelData): NavGrid {
  let g = cache.get(level);
  if (!g) {
    g = buildNavGrid(level);
    cache.set(level, g);
  }
  return g;
}

function minDist(boxes: readonly Box[], x: number, z: number): number {
  let d = Infinity;
  for (const b of boxes) {
    const e = distToBox(b, x, z);
    if (e < d) d = e;
  }
  return d;
}

const NB_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NB_DZ = [0, 0, 1, -1, 1, -1, 1, -1];

export function buildNavGrid(level: LevelData): NavGrid {
  const c = NAV.cellSize;
  const bnd = level.bounds;
  const ox = bnd.min.x;
  const oz = bnd.min.z;
  const w = Math.max(1, Math.ceil((bnd.max.x - bnd.min.x) / c));
  const h = Math.max(1, Math.ceil((bnd.max.z - bnd.min.z) / c));
  const n = w * h;

  const door = level.exit.door;
  const hardOpen = level.boxes.filter(isHard);
  const hard = [...hardOpen, door];
  const climb = level.boxes.filter(isClimbable);
  const body = [...hard, ...climb];
  const overhead = level.boxes.filter(
    (b) => b.kind !== 'floor' && b.kind !== 'ceiling' && b.min.y >= OVERHEAD_Y && b.min.y < MONSTER.standHeight,
  );
  const walls = [...level.boxes.filter((b) => b.kind === 'wall' && b.min.y < OVERHEAD_Y), door];

  const tallR = MONSTER.radius + NAV.margin;
  const crawlR = MONSTER.crawlRadius + NAV.margin;
  const cls = new Uint8Array(n);
  const allClear = new Float32Array(n);
  const lintel = new Uint8Array(n);
  const stand = new Uint8Array(n);
  for (let iz = 0; iz < h; iz++) {
    const z = oz + (iz + 0.5) * c;
    for (let ix = 0; ix < w; ix++) {
      const x = ox + (ix + 0.5) * c;
      const i = iz * w + ix;
      const hc = minDist(hard, x, z);
      const ac = Math.min(hc, minDist(climb, x, z));
      allClear[i] = ac;
      stand[i] = ac >= PLAYER.radius ? 1 : 0;
      for (const o of overhead) if (distToBox(o, x, z) < MONSTER.radius) lintel[i] = 1;
      if (hc < crawlR) cls[i] = CELL_BLOCKED;
      else if (ac >= tallR) cls[i] = lintel[i] ? CELL_DUCK : CELL_TALL;
      else if (ac >= crawlR) cls[i] = CELL_CRAWL;
      else cls[i] = CELL_CLIMB;
    }
  }

  // Keep only what can be reached from inside the house (seeds: nav nodes, else the spawn).
  const seeds: number[] = [];
  const cellAt = (x: number, z: number): number => {
    const ix = Math.floor((x - ox) / c);
    const iz = Math.floor((z - oz) / c);
    return ix < 0 || iz < 0 || ix >= w || iz >= h ? -1 : iz * w + ix;
  };
  for (const nd of level.nav) seeds.push(cellAt(nd.position.x, nd.position.z));
  seeds.push(cellAt(level.monsterSpawn.x, level.monsterSpawn.z));
  const reach = new Uint8Array(n);
  const stack: number[] = [];
  for (const s of seeds) {
    if (s >= 0 && cls[s] !== CELL_BLOCKED && !reach[s]) {
      reach[s] = 1;
      stack.push(s);
    }
  }
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const cx = cur % w;
    const cz = (cur - cx) / w;
    for (let k = 0; k < 8; k++) {
      const nx = cx + NB_DX[k];
      const nz = cz + NB_DZ[k];
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      const ni = nz * w + nx;
      if (reach[ni] || cls[ni] === CELL_BLOCKED) continue;
      if (k >= 4 && (cls[cz * w + nx] === CELL_BLOCKED || cls[nz * w + cx] === CELL_BLOCKED)) continue;
      reach[ni] = 1;
      stack.push(ni);
    }
  }
  // Standable for players: also only inside the house (reachable area grown by a few cells).
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (reach[i]) inside[i] = 1;
  for (let pass = 0; pass < 3; pass++) {
    const grow = inside.slice();
    for (let i = 0; i < n; i++) {
      if (!inside[i]) continue;
      const cx = i % w;
      const cz = (i - cx) / w;
      for (let k = 0; k < 4; k++) {
        const nx = cx + NB_DX[k];
        const nz = cz + NB_DZ[k];
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = nz * w + nx;
        if (stand[ni]) grow[ni] = 1;
      }
    }
    inside.set(grow);
  }
  for (let i = 0; i < n; i++) {
    if (!reach[i]) cls[i] = CELL_BLOCKED;
    if (!inside[i]) stand[i] = 0;
  }

  // Hugging walls / furniture costs a little extra (routes keep to the middle when they can).
  const hug = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = cls[i];
    if (k === CELL_BLOCKED || k === CELL_CLIMB) continue;
    const r = k === CELL_TALL || k === CELL_DUCK ? MONSTER.radius : MONSTER.crawlRadius;
    if (allClear[i] < r + NAV.margin + NAV.hugDistance) hug[i] = NAV.costHug;
  }

  // How enclosed each cell is: solids 0.55 m away in 8 directions.
  const nook = new Uint8Array(n);
  const ring = 0.55;
  for (let iz = 0; iz < h; iz++) {
    for (let ix = 0; ix < w; ix++) {
      const i = iz * w + ix;
      if (!stand[i] && cls[i] === CELL_BLOCKED) continue;
      const x = ox + (ix + 0.5) * c;
      const z = oz + (iz + 0.5) * c;
      let k = 0;
      for (let a = 0; a < 8; a++) {
        const ang = (a * Math.PI) / 4;
        const sx = Math.floor((x + Math.cos(ang) * ring - ox) / c);
        const sz = Math.floor((z + Math.sin(ang) * ring - oz) / c);
        // Outside the grid counts as solid; otherwise "solid" = within half a cell of a box.
        if (sx < 0 || sz < 0 || sx >= w || sz >= h || allClear[sz * w + sx] < c * 0.6) k++;
      }
      nook[i] = k;
    }
  }

  const scratch: AStarScratch = {
    gen: 0,
    stamp: new Uint32Array(n),
    closed: new Uint32Array(n),
    g: new Float64Array(n),
    parent: new Int32Array(n),
    heapIdx: new Int32Array(n * 8 + 16),
    heapKey: new Float64Array(n * 8 + 16),
  };
  const grid: NavGrid = {
    cell: c,
    ox,
    oz,
    w,
    h,
    cls,
    hug,
    allClear,
    lintel,
    stand,
    nook,
    region: new Int16Array(n).fill(-1),
    regions: [],
    doorways: [],
    listen: { x: new Float32Array(0), z: new Float32Array(0), region: new Int16Array(0), n: 0 },
    hard,
    hardOpen,
    climb,
    body,
    overhead,
    walls,
    scratch,
  };
  buildRegions(grid);
  return { ...grid, listen: listenPoints(grid) };
}

/** One standable floor sample per 1 m square (the one nearest the square's center). */
function listenPoints(g: NavGrid): NavGrid['listen'] {
  const step = Math.max(1, Math.round(1 / g.cell));
  const xs: number[] = [];
  const zs: number[] = [];
  const rs: number[] = [];
  for (let bz = 0; bz < g.h; bz += step) {
    for (let bx = 0; bx < g.w; bx += step) {
      let best = -1;
      let bestD = Infinity;
      for (let dz = 0; dz < step && bz + dz < g.h; dz++) {
        for (let dx = 0; dx < step && bx + dx < g.w; dx++) {
          const i = (bz + dz) * g.w + bx + dx;
          if (!g.stand[i]) continue;
          const d = Math.abs(dx - step / 2) + Math.abs(dz - step / 2);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      if (best < 0) continue;
      const x = cellX(g, best);
      const z = cellZ(g, best);
      const c = nearestCell(g, x, z, 1.5, true, (i) => g.region[i] >= 0);
      if (c < 0) continue;
      xs.push(x);
      zs.push(z);
      rs.push(g.region[c]);
    }
  }
  return { x: Float32Array.from(xs), z: Float32Array.from(zs), region: Int16Array.from(rs), n: xs.length };
}

// ---------------------------------------------------------------------------------------------
// Rooms, doorways, patrol and lurk spots
// ---------------------------------------------------------------------------------------------

function buildRegions(g: NavGrid): void {
  const { w, h, cls, lintel, region } = g;
  const n = w * h;
  const minCells = Math.ceil(1.5 / (g.cell * g.cell));
  const walk = (i: number) => cls[i] !== CELL_BLOCKED && !lintel[i];
  const comp = new Int32Array(n).fill(-1);
  const groups: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (!walk(i) || comp[i] >= 0) continue;
    const id = groups.length;
    const cells: number[] = [i];
    comp[i] = id;
    for (let q = 0; q < cells.length; q++) {
      const cur = cells[q];
      const cx = cur % w;
      const cz = (cur - cx) / w;
      for (let k = 0; k < 4; k++) {
        const nx = cx + NB_DX[k];
        const nz = cz + NB_DZ[k];
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = nz * w + nx;
        if (comp[ni] >= 0 || !walk(ni)) continue;
        comp[ni] = id;
        cells.push(ni);
      }
    }
    groups.push(cells);
  }
  for (const cells of groups) {
    if (cells.length < minCells) continue;
    const id = g.regions.length;
    let sx = 0;
    let sz = 0;
    for (const i of cells) {
      region[i] = id;
      sx += cellX(g, i);
      sz += cellZ(g, i);
    }
    g.regions.push({
      id,
      area: cells.length * g.cell * g.cell,
      center: { x: sx / cells.length, y: 0, z: sz / cells.length },
      patrol: patrolPoints(g, cells),
      lurks: [],
    });
  }

  // Doorways: connected lintel cells, and the rooms they join.
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (seen[i] || cls[i] === CELL_BLOCKED || !lintel[i]) continue;
    const cells = [i];
    seen[i] = 1;
    const rooms = new Set<number>();
    for (let q = 0; q < cells.length; q++) {
      const cur = cells[q];
      const cx = cur % w;
      const cz = (cur - cx) / w;
      for (let k = 0; k < 8; k++) {
        const nx = cx + NB_DX[k];
        const nz = cz + NB_DZ[k];
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = nz * w + nx;
        if (region[ni] >= 0) rooms.add(region[ni]);
        if (seen[ni] || cls[ni] === CELL_BLOCKED || !lintel[ni]) continue;
        seen[ni] = 1;
        cells.push(ni);
      }
    }
    let sx = 0;
    let sz = 0;
    for (const c of cells) {
      sx += cellX(g, c);
      sz += cellZ(g, c);
    }
    g.doorways.push({
      id: g.doorways.length,
      center: { x: sx / cells.length, y: 0, z: sz / cells.length },
      regions: [...rooms].sort((a, b) => a - b),
    });
  }
  buildLurks(g);
}

function patrolPoints(g: NavGrid, cells: number[]): Vec3[] {
  const open = cells.filter((i) => g.cls[i] === CELL_TALL && g.allClear[i] >= MONSTER.radius + 0.3);
  const cand = open.length > 0 ? open : cells.filter((i) => g.cls[i] === CELL_TALL);
  const pool = cand.length > 0 ? cand : cells;
  const area = cells.length * g.cell * g.cell;
  const want = Math.max(1, Math.min(5, Math.round(area / 7)));
  // Start with the most open spot, then farthest-point sampling.
  let first = pool[0];
  for (const i of pool) if (g.allClear[i] > g.allClear[first]) first = i;
  const chosen = [first];
  const dmin = new Float64Array(pool.length).fill(Infinity);
  while (chosen.length < want) {
    const last = chosen[chosen.length - 1];
    let best = -1;
    let bestD = 0;
    for (let k = 0; k < pool.length; k++) {
      const d = Math.hypot(cellX(g, pool[k]) - cellX(g, last), cellZ(g, pool[k]) - cellZ(g, last));
      if (d < dmin[k]) dmin[k] = d;
      if (dmin[k] > bestD) {
        bestD = dmin[k];
        best = pool[k];
      }
    }
    if (best < 0 || bestD < 1.6) break;
    chosen.push(best);
  }
  return chosen.map((i) => ({ x: cellX(g, i), y: 0, z: cellZ(g, i) }));
}

function buildLurks(g: NavGrid): void {
  const { w, h } = g;
  for (const d of g.doorways) {
    for (const r of d.regions) {
      const reg = g.regions[r];
      const into = { x: reg.center.x - d.center.x, z: reg.center.z - d.center.z };
      const il = Math.hypot(into.x, into.z) || 1;
      let best = -1;
      let bestScore = -Infinity;
      const R = Math.ceil(1.5 / g.cell);
      const cx0 = Math.floor((d.center.x - g.ox) / g.cell);
      const cz0 = Math.floor((d.center.z - g.oz) / g.cell);
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          const cx = cx0 + dx;
          const cz = cz0 + dz;
          if (cx < 0 || cz < 0 || cx >= w || cz >= h) continue;
          const i = cz * w + cx;
          if (g.region[i] !== r || g.cls[i] !== CELL_TALL) continue;
          const px = cellX(g, i) - d.center.x;
          const pz = cellZ(g, i) - d.center.z;
          const dist = Math.hypot(px, pz);
          if (dist < 0.6 || dist > 1.5) continue;
          // Beside the doorway (not in front of it), against the wall.
          const side = 1 - Math.abs((px * into.x + pz * into.z) / (dist * il));
          const score = g.nook[i] + 2.5 * side - Math.abs(dist - 0.95);
          if (score > bestScore) {
            bestScore = score;
            best = i;
          }
        }
      }
      if (best >= 0) {
        reg.lurks.push({
          position: { x: cellX(g, best), y: 0, z: cellZ(g, best) },
          focus: { x: d.center.x, y: 1.5, z: d.center.z },
          region: r,
        });
      }
    }
  }
  // Corners: the most enclosed upright spots of each room.
  const corners: number[][] = g.regions.map(() => []);
  for (let i = 0; i < w * h; i++) {
    const r = g.region[i];
    if (r >= 0 && g.cls[i] === CELL_TALL && g.nook[i] >= 4) corners[r].push(i);
  }
  corners.forEach((cells, r) => {
    cells.sort((a, b) => g.nook[b] - g.nook[a] || a - b);
    const reg = g.regions[r];
    const picked: number[] = [];
    for (const i of cells) {
      if (picked.length >= 2) break;
      if (picked.some((p) => Math.hypot(cellX(g, p) - cellX(g, i), cellZ(g, p) - cellZ(g, i)) < 2.5)) continue;
      picked.push(i);
      reg.lurks.push({
        position: { x: cellX(g, i), y: 0, z: cellZ(g, i) },
        focus: { x: reg.center.x, y: 1.4, z: reg.center.z },
        region: r,
      });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export const cellX = (g: NavGrid, i: number): number => g.ox + ((i % g.w) + 0.5) * g.cell;
export const cellZ = (g: NavGrid, i: number): number => g.oz + (Math.floor(i / g.w) + 0.5) * g.cell;

/** Index of the cell containing (x, z), or -1 outside the grid. */
export function cellIndex(g: NavGrid, x: number, z: number): number {
  const ix = Math.floor((x - g.ox) / g.cell);
  const iz = Math.floor((z - g.oz) / g.cell);
  return ix < 0 || iz < 0 || ix >= g.w || iz >= g.h ? -1 : iz * g.w + ix;
}

/** Room id at (x, z) (-1 in doorways / outside). */
export function regionAt(g: NavGrid, x: number, z: number): number {
  const i = cellIndex(g, x, z);
  return i < 0 ? -1 : g.region[i];
}

/** Number of walls (and the exit door) crossed by the segment (XZ). */
export function wallsCrossed(g: NavGrid, ax: number, az: number, bx: number, bz: number, stopAt = Infinity): number {
  const minX = ax < bx ? ax : bx;
  const maxX = ax < bx ? bx : ax;
  const minZ = az < bz ? az : bz;
  const maxZ = az < bz ? bz : az;
  let k = 0;
  for (const b of g.walls) {
    if (b.max.x < minX || b.min.x > maxX || b.max.z < minZ || b.min.z > maxZ) continue;
    if (segmentHitsRect(ax, az, bx, bz, b.min.x, b.min.z, b.max.x, b.max.z) && ++k >= stopAt) return k;
  }
  return k;
}

/** Exact distance (XZ) from (x, z) to the nearest solid an upright or crawling body avoids. */
export function bodyClearance(g: NavGrid, x: number, z: number): number {
  return minDist(g.body, x, z);
}

/** Top of the low furniture within `r` of (x, z) (0 = floor): where its body rests when climbing. */
export function surfaceTop(g: NavGrid, x: number, z: number, r: number): number {
  let top = 0;
  for (const b of g.climb) if (b.max.y > top && distToBox(b, x, z) <= r) top = b.max.y;
  return top;
}

/** Is an upright body (radius `r`) at (x, z) with its head at `headY` under something lower? */
export function underLintel(g: NavGrid, x: number, z: number, r: number, headY: number): boolean {
  for (const b of g.overhead) if (b.min.y < headY && distToBox(b, x, z) < r) return true;
  return false;
}

/** Precomputed spiral of cell offsets sorted by distance (up to 4 m). */
let spiral: { dx: number; dz: number; d: number }[] | null = null;
function spiralFor(g: NavGrid): { dx: number; dz: number; d: number }[] {
  if (!spiral) {
    const R = Math.ceil(4 / NAV.cellSize);
    spiral = [];
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) spiral.push({ dx, dz, d: Math.hypot(dx, dz) * NAV.cellSize });
    }
    spiral.sort((a, b) => a.d - b.d || a.dz - b.dz || a.dx - b.dx);
  }
  void g;
  return spiral;
}

/**
 * The traversable cell nearest to (x, z) within `maxR` m, optionally only cells with no wall
 * between their center and the point (so a goal is never snapped into the next room). -1 if none.
 */
export function nearestCell(
  g: NavGrid,
  x: number,
  z: number,
  maxR: number,
  needSight: boolean,
  accept?: (i: number) => boolean,
): number {
  const cx0 = Math.floor((x - g.ox) / g.cell);
  const cz0 = Math.floor((z - g.oz) / g.cell);
  let best = -1;
  let bestD = Infinity;
  for (const o of spiralFor(g)) {
    if (o.d > maxR + g.cell) break;
    // Offsets are sorted by cell distance; the exact distance can differ by < one cell.
    if (best >= 0 && o.d > bestD + g.cell * 1.5) break;
    const cx = cx0 + o.dx;
    const cz = cz0 + o.dz;
    if (cx < 0 || cz < 0 || cx >= g.w || cz >= g.h) continue;
    const i = cz * g.w + cx;
    if (g.cls[i] === CELL_BLOCKED) continue;
    if (accept && !accept(i)) continue;
    const px = cellX(g, i);
    const pz = cellZ(g, i);
    const d = Math.hypot(px - x, pz - z);
    if (d >= bestD || d > maxR) continue;
    if (needSight && wallsCrossed(g, px, pz, x, z) > 0) continue;
    best = i;
    bestD = d;
  }
  return best;
}

export const kindOfCell = (k: number): SegKind =>
  k === CELL_CLIMB ? 'climb' : k === CELL_CRAWL ? 'crawl' : 'upright';
const KIND_RANK: Record<SegKind, number> = { upright: 0, crawl: 1, climb: 2 };
const maxKind = (a: SegKind, b: SegKind): SegKind => (KIND_RANK[a] >= KIND_RANK[b] ? a : b);

/** Can a body travelling as `kind` go straight from a to b? (exact capsule test) */
export function segmentClearFor(g: NavGrid, kind: SegKind, a: Vec3, b: Vec3, exitOpen = false): boolean {
  if (kind === 'climb') return capsuleClear(exitOpen ? g.hardOpen : g.hard, a, b, MONSTER.crawlRadius + 0.01);
  const r = (kind === 'upright' ? MONSTER.radius : MONSTER.crawlRadius) + 0.01;
  return capsuleClear(g.body, a, b, r);
}

// ---------------------------------------------------------------------------------------------
// A*
// ---------------------------------------------------------------------------------------------

function heapPush(s: AStarScratch, size: number, idx: number, key: number): number {
  let i = size;
  if (i >= s.heapIdx.length) return size; // full (cannot happen with the sizing used)
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (s.heapKey[p] <= key) break;
    s.heapIdx[i] = s.heapIdx[p];
    s.heapKey[i] = s.heapKey[p];
    i = p;
  }
  s.heapIdx[i] = idx;
  s.heapKey[i] = key;
  return size + 1;
}

function heapPop(s: AStarScratch, size: number): number {
  const last = size - 1;
  const idx = s.heapIdx[last];
  const key = s.heapKey[last];
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= last) break;
    if (c + 1 < last && s.heapKey[c + 1] < s.heapKey[c]) c++;
    if (s.heapKey[c] >= key) break;
    s.heapIdx[i] = s.heapIdx[c];
    s.heapKey[i] = s.heapKey[c];
    i = c;
  }
  s.heapIdx[i] = idx;
  s.heapKey[i] = key;
  return last;
}

/** Statistics of the A* searches so far (for tests / perf logging). */
export const astarStats = { searches: 0, expanded: 0 };

/**
 * A* cost per meter of each cell class (index = CELL_*; blocked is ignored). Default: the fixed
 * NAV costs. The AI passes time-based costs for its current pace (see MonsterBrain).
 */
export type ClassCosts = readonly [number, number, number, number, number];
export const DEFAULT_COSTS: ClassCosts = [0, 1, NAV.costDuck, NAV.costCrawl, NAV.costClimb];

/**
 * A* from cell `s` to cell `t`. Returns the cell path (s..t), or a path to the explored cell
 * closest to `t` when the search hit NAV.maxExpansions (`complete` = false). Null if s is blocked.
 */
export function astar(
  g: NavGrid,
  s: number,
  t: number,
  costs: ClassCosts = DEFAULT_COSTS,
): { cells: number[]; complete: boolean } | null {
  const S = g.scratch;
  const { w, h, cls, hug, cell } = g;
  if (s < 0 || t < 0 || cls[s] === CELL_BLOCKED) return null;
  // The heuristic must not overestimate: scale by the cheapest class cost.
  const minCost = Math.min(costs[1], costs[2], costs[3], costs[4]);
  S.gen++;
  if (S.gen >= 0xffffffff) {
    S.stamp.fill(0);
    S.closed.fill(0);
    S.gen = 1;
  }
  const gen = S.gen;
  const tx = t % w;
  const tz = (t - tx) / w;
  const heur = (i: number): number => {
    const x = i % w;
    const dx = Math.abs(x - tx);
    const dz = Math.abs((i - x) / w - tz);
    return (dx > dz ? dx + (Math.SQRT2 - 1) * dz : dz + (Math.SQRT2 - 1) * dx) * cell * minCost;
  };
  S.stamp[s] = gen;
  S.g[s] = 0;
  S.parent[s] = -1;
  let size = heapPush(S, 0, s, heur(s));
  let best = s;
  let bestH = heur(s);
  let expanded = 0;
  let found = false;
  astarStats.searches++;
  while (size > 0) {
    const cur = S.heapIdx[0];
    size = heapPop(S, size);
    if (S.closed[cur] === gen) continue;
    S.closed[cur] = gen;
    if (cur === t) {
      found = true;
      break;
    }
    if (++expanded > NAV.maxExpansions) break;
    const hc = heur(cur);
    if (hc < bestH) {
      bestH = hc;
      best = cur;
    }
    const cx = cur % w;
    const cz = (cur - cx) / w;
    const gc = S.g[cur];
    const cc = costs[cls[cur]] + hug[cur];
    for (let k = 0; k < 8; k++) {
      const nx = cx + NB_DX[k];
      const nz = cz + NB_DZ[k];
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      const ni = nz * w + nx;
      const kn = cls[ni];
      if (kn === CELL_BLOCKED || S.closed[ni] === gen) continue;
      if (k >= 4 && (cls[cz * w + nx] === CELL_BLOCKED || cls[nz * w + cx] === CELL_BLOCKED)) continue;
      const cn = costs[kn] + hug[ni];
      const ng = gc + (k >= 4 ? Math.SQRT2 : 1) * cell * 0.5 * (cc + cn);
      if (S.stamp[ni] === gen && ng >= S.g[ni]) continue;
      S.stamp[ni] = gen;
      S.g[ni] = ng;
      S.parent[ni] = cur;
      size = heapPush(S, size, ni, ng + heur(ni));
    }
  }
  astarStats.expanded += expanded;
  const end = found ? t : best;
  const cells: number[] = [];
  for (let c = end; c !== -1; c = S.parent[c]) cells.push(c);
  cells.reverse();
  return { cells, complete: found };
}

/**
 * Plan a route for the monster from `from` to (near) `to`. Writes string-pulled waypoints into
 * `out` (cleared first; the last one is the goal) and returns whether the goal itself was reached
 * by the search. The goal is snapped to the nearest cell its body fits in with no wall between.
 */
export function planRoute(
  g: NavGrid,
  from: Vec3,
  to: Vec3,
  out: RoutePoint[],
  exitOpen = false,
  costs: ClassCosts = DEFAULT_COSTS,
): boolean {
  out.length = 0;
  let s = cellIndex(g, from.x, from.z);
  if (s < 0 || g.cls[s] === CELL_BLOCKED) s = nearestCell(g, from.x, from.z, 1.5, false);
  let t = nearestCell(g, to.x, to.z, 3, true);
  if (t < 0) t = nearestCell(g, to.x, to.z, 4, false);
  if (s < 0 || t < 0) return false;
  const res = astar(g, s, t, costs);
  if (!res) return false;
  const cells = res.cells;
  // Points: start = actual position, then cell centers.
  const pts: Vec3[] = [{ x: from.x, y: 0, z: from.z }];
  const kinds: SegKind[] = [kindOfCell(g.cls[cells[0]])];
  for (let k = 1; k < cells.length; k++) {
    pts.push({ x: cellX(g, cells[k]), y: 0, z: cellZ(g, cells[k]) });
    kinds.push(kindOfCell(g.cls[cells[k]]));
  }
  if (res.complete) {
    // Finish exactly at the goal when the last stretch to it is clear.
    const last = pts[pts.length - 1];
    const lastKind = kinds[kinds.length - 1];
    const goal = { x: to.x, y: 0, z: to.z };
    if (Math.hypot(goal.x - last.x, goal.z - last.z) > 1e-3 && segmentClearFor(g, lastKind, last, goal, exitOpen)) {
      pts.push(goal);
      kinds.push(lastKind);
    }
  }
  if (pts.length === 1) {
    // Already in the goal cell.
    out.push({ x: pts[0].x, z: pts[0].z, kind: kinds[0] });
    return res.complete;
  }
  // Segment i (pts[i-1] -> pts[i]) kind.
  const seg: SegKind[] = [kinds[0]];
  for (let i = 1; i < pts.length; i++) seg.push(maxKind(kinds[i - 1], kinds[i]));
  let a = 0;
  while (a < pts.length - 1) {
    // Run of segments with the same kind starting at segment a+1.
    const kind = seg[a + 1];
    let b = a + 1;
    while (b + 1 < pts.length && seg[b + 1] === kind) b++;
    let anchor = a;
    while (anchor < b) {
      let bestJ = anchor + 1;
      let fails = 0;
      for (let j = anchor + 2; j <= b; j++) {
        if (segmentClearFor(g, kind, pts[anchor], pts[j], exitOpen)) {
          bestJ = j;
          fails = 0;
        } else if (++fails > 5) break;
      }
      out.push({ x: pts[bestJ].x, z: pts[bestJ].z, kind });
      anchor = bestJ;
    }
    a = b;
  }
  return res.complete;
}

/** Total XZ length of a route starting at `from`. */
export function routeLength(from: Vec3, route: readonly RoutePoint[]): number {
  let len = 0;
  let px = from.x;
  let pz = from.z;
  for (const p of route) {
    len += Math.hypot(p.x - px, p.z - pz);
    px = p.x;
    pz = p.z;
  }
  return len;
}

/**
 * Likely hiding spots around `center`: enclosed spots a player could stand in (corners, behind
 * furniture, beside doorways), within `radius` m, with no wall between them and `center`.
 * Up to `max`, at least `spacing` m apart, randomized with `rng`.
 */
export function hidingSpots(
  g: NavGrid,
  center: Vec3,
  radius: number,
  max: number,
  rng: () => number,
  spacing = 1.2,
): Vec3[] {
  const R = Math.ceil(radius / g.cell);
  const cx0 = Math.floor((center.x - g.ox) / g.cell);
  const cz0 = Math.floor((center.z - g.oz) / g.cell);
  const cand: { i: number; score: number }[] = [];
  for (let dz = -R; dz <= R; dz++) {
    for (let dx = -R; dx <= R; dx++) {
      const cx = cx0 + dx;
      const cz = cz0 + dz;
      if (cx < 0 || cz < 0 || cx >= g.w || cz >= g.h) continue;
      const i = cz * g.w + cx;
      if (!g.stand[i]) continue;
      const nk = g.nook[i] + (g.lintel[i] ? 2 : 0);
      if (nk < 3) continue;
      const d = Math.hypot(cellX(g, i) - center.x, cellZ(g, i) - center.z);
      if (d > radius || d < 0.5) continue;
      cand.push({ i, score: nk + rng() * 2.5 - d * 0.15 });
    }
  }
  cand.sort((a, b) => b.score - a.score || a.i - b.i);
  const out: Vec3[] = [];
  for (const c of cand) {
    if (out.length >= max) break;
    const x = cellX(g, c.i);
    const z = cellZ(g, c.i);
    if (out.some((p) => Math.hypot(p.x - x, p.z - z) < spacing)) continue;
    if (wallsCrossed(g, center.x, center.z, x, z) > 0) continue;
    out.push({ x, y: 0, z });
  }
  return out;
}
