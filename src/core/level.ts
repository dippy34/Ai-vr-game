import type { Box, LevelData, PropStyle, Vec3 } from './types';
import { v3 } from './math';
import { buildNavGraph } from './nav';

/*
 * "The Old House": a hand-made, single-floor abandoned house, 22 m (X) x 16 m (Z), centered on the
 * origin. North is -Z. The front door is in the middle of the SOUTH wall (z = +8); players spawn in
 * the foyer just inside it, facing north (yaw 0) into the house.
 *
 *   z=-8 +-----------+--------+------------+---------------+
 *        |           |  bath  |            |               |
 *        |  bedroom  +--------+   study    D    kitchen    |
 *        |           D storage|            |               |
 * z=-1.2 +----D------+---D----+------D-----+---D-----------+
 *        |                    hallway                      |
 * z=+1.2 +-------D------------+---arch---+--------D--------+
 *        |                    |          |                 |
 *        |      living        D  foyer   D     dining      |
 *        |                    |          |                 |
 *   z=+8 +--------------------+==EXIT====+-----------------+
 *      x=-11               x=-3   x=0   x=3              x=11
 *
 * Walls are centered on the grid lines above. Doorways are open gaps (with an overhead lintel from
 * DOORWAY_HEIGHT to the ceiling, which is "overhead" and ignored by collision/sound).
 */

export const LEVEL_ID = 'old-house';
export const WALL_HEIGHT = 2.8;
export const WALL_THICKNESS = 0.2;
/** Height of the underside of door lintels (doorways are open below this). */
export const DOORWAY_HEIGHT = 2.4;
/** Clearance used when linking nav nodes (monster radius 0.35 + safety margin). */
export const NAV_LINK_CLEARANCE = 0.4;
/** Nav nodes farther apart than this are never linked directly. */
export const NAV_MAX_LINK = 8.5;

export interface RoomInfo {
  name: string;
  /** Wall-centerline rectangle of the room (XZ). */
  min: { x: number; z: number };
  max: { x: number; z: number };
}

/** Room rectangles (wall centerlines), handy for debugging, UI and tests. */
export const HOUSE_ROOMS: readonly RoomInfo[] = [
  { name: 'foyer', min: { x: -3, z: 1.2 }, max: { x: 3, z: 8 } },
  { name: 'hallway', min: { x: -11, z: -1.2 }, max: { x: 11, z: 1.2 } },
  { name: 'living', min: { x: -11, z: 1.2 }, max: { x: -3, z: 8 } },
  { name: 'dining', min: { x: 3, z: 1.2 }, max: { x: 11, z: 8 } },
  { name: 'bedroom', min: { x: -11, z: -8 }, max: { x: -5, z: -1.2 } },
  { name: 'bathroom', min: { x: -5, z: -8 }, max: { x: -2, z: -4.5 } },
  { name: 'storage', min: { x: -5, z: -4.5 }, max: { x: -2, z: -1.2 } },
  { name: 'study', min: { x: -2, z: -8 }, max: { x: 4, z: -1.2 } },
  { name: 'kitchen', min: { x: 4, z: -8 }, max: { x: 11, z: -1.2 } },
];

/** Name of the room containing (x, z), or null when outside the house. */
export function roomAt(x: number, z: number): string | null {
  for (const r of HOUSE_ROOMS) {
    if (x >= r.min.x && x <= r.max.x && z >= r.min.z && z <= r.max.z) return r.name;
  }
  return null;
}

const HT = WALL_THICKNESS / 2;

const COLOR = {
  wood: 0x4a3426,
  darkWood: 0x3b2a1e,
  fabric: 0x4a4f5a,
  redFabric: 0x5a3a3a,
  bench: 0x5a4636,
  piano: 0x161412,
  counter: 0x6b6456,
  island: 0x5c5446,
  fridge: 0x8c8c86,
  porcelain: 0xcfcfc4,
  bedding: 0x6e5a5a,
  shelfStorage: 0x4d4033,
  crate: 0x7a5c3a,
  crateDark: 0x6d5233,
  door: 0x3a2618,
} as const;

/** A wall along X at `z` from x0 to x1, with doorway gaps [start, end] (in x). */
function wallAlongX(out: Box[], z: number, x0: number, x1: number, gaps: [number, number][] = []): void {
  let cur = x0;
  for (const [g0, g1] of [...gaps].sort((a, b) => a[0] - b[0])) {
    if (g0 > cur) out.push({ kind: 'wall', min: v3(cur, 0, z - HT), max: v3(g0, WALL_HEIGHT, z + HT) });
    out.push({ kind: 'wall', min: v3(g0, DOORWAY_HEIGHT, z - HT), max: v3(g1, WALL_HEIGHT, z + HT) });
    cur = g1;
  }
  if (cur < x1) out.push({ kind: 'wall', min: v3(cur, 0, z - HT), max: v3(x1, WALL_HEIGHT, z + HT) });
}

/** A wall along Z at `x` from z0 to z1, with doorway gaps [start, end] (in z). */
function wallAlongZ(out: Box[], x: number, z0: number, z1: number, gaps: [number, number][] = []): void {
  let cur = z0;
  for (const [g0, g1] of [...gaps].sort((a, b) => a[0] - b[0])) {
    if (g0 > cur) out.push({ kind: 'wall', min: v3(x - HT, 0, cur), max: v3(x + HT, WALL_HEIGHT, g0) });
    out.push({ kind: 'wall', min: v3(x - HT, DOORWAY_HEIGHT, g0), max: v3(x + HT, WALL_HEIGHT, g1) });
    cur = g1;
  }
  if (cur < z1) out.push({ kind: 'wall', min: v3(x - HT, 0, cur), max: v3(x + HT, WALL_HEIGHT, z1) });
}

function furn(
  style: PropStyle,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  height: number,
  color: number,
): Box {
  return { kind: 'furniture', style, color, min: v3(x0, 0, z0), max: v3(x1, height, z1) };
}

/** A window on the inner face of an exterior wall. `yaw` faces INTO the house. */
function windowAt(x: number, y: number, z: number, width: number, height: number, yaw: number) {
  return { center: v3(x, y, z), width, height, yaw };
}

/**
 * Build the level. Deterministic: the same seed gives the same level on every client.
 * The layout itself is fixed; `seed` is stored so the sim can randomize item picks from it.
 */
export function createLevel(seed: number): LevelData {
  const boxes: Box[] = [];

  // --- Floor + ceiling ---------------------------------------------------------------------
  boxes.push({ kind: 'floor', min: v3(-11.1, -0.2, -8.1), max: v3(11.1, 0, 8.1), color: 0x2b241d });
  // Porch outside the front door (where escaping players step out).
  boxes.push({ kind: 'floor', min: v3(-1.6, -0.2, 8.1), max: v3(1.6, 0, 9.6), color: 0x3a342c });
  boxes.push({
    kind: 'ceiling',
    min: v3(-11.1, WALL_HEIGHT, -8.1),
    max: v3(11.1, WALL_HEIGHT + 0.2, 8.1),
    color: 0x1e1b18,
  });

  // --- Exterior walls ----------------------------------------------------------------------
  wallAlongX(boxes, 8, -11.1, 11.1, [[-0.6, 0.6]]); // south, with the front door
  wallAlongX(boxes, -8, -11.1, 11.1); // north
  wallAlongZ(boxes, -11, -7.9, 7.9); // west
  wallAlongZ(boxes, 11, -7.9, 7.9); // east

  // --- Interior walls ----------------------------------------------------------------------
  // Hallway south wall: living door, foyer arch, dining door.
  wallAlongX(boxes, 1.2, -10.9, 10.9, [
    [-7.0, -5.9],
    [-0.8, 0.8],
    [8.0, 9.1],
  ]);
  // Hallway north wall: bedroom, storage, study, kitchen doors.
  wallAlongX(boxes, -1.2, -10.9, 10.9, [
    [-8.5, -7.4],
    [-4.0, -2.9],
    [2.0, 3.1],
    [6.0, 7.1],
  ]);
  wallAlongX(boxes, -4.5, -4.9, -2.1); // bathroom | storage
  wallAlongZ(boxes, -3, 1.3, 7.9, [[4.5, 5.6]]); // living | foyer
  wallAlongZ(boxes, 3, 1.3, 7.9, [[4.5, 5.6]]); // foyer | dining
  wallAlongZ(boxes, -5, -7.9, -1.3, [[-7.0, -5.9]]); // bedroom | bathroom+storage
  wallAlongZ(boxes, -2, -7.9, -1.3); // bathroom+storage | study
  wallAlongZ(boxes, 4, -7.9, -1.3, [[-5.0, -3.9]]); // study | kitchen

  // --- Furniture ---------------------------------------------------------------------------
  // Foyer
  boxes.push(furn('table', -2.9, 6.1, -2.3, 6.9, 0.75, COLOR.wood)); // foyer table
  boxes.push(furn('cabinet', 2.4, 1.8, 2.9, 3.2, 1.9, COLOR.darkWood)); // coat cabinet
  boxes.push(furn('couch', 2.4, 6.2, 2.9, 7.4, 0.5, COLOR.bench)); // bench
  // Hallway
  boxes.push(furn('cabinet', 3.8, -1.1, 5.2, -0.7, 0.8, COLOR.darkWood)); // console
  boxes.push(furn('table', 10.4, -0.45, 10.9, 0.45, 0.75, COLOR.wood)); // end table
  // Living room
  boxes.push(furn('couch', -8.8, 5.4, -6.6, 6.3, 0.85, COLOR.fabric));
  boxes.push(furn('table', -8.3, 4.2, -7.1, 4.8, 0.45, COLOR.wood)); // coffee table
  boxes.push(furn('piano', -10.9, 2.0, -10.3, 3.6, 1.3, COLOR.piano)); // upright piano
  boxes.push(furn('shelf', -5.6, 7.5, -4.0, 7.9, 2.0, COLOR.darkWood)); // bookshelf
  boxes.push(furn('couch', -4.6, 1.8, -3.7, 2.7, 0.85, COLOR.redFabric)); // armchair
  boxes.push(furn('cabinet', -10.9, 6.4, -10.4, 7.6, 1.0, COLOR.darkWood)); // side cabinet
  // Dining room
  boxes.push(furn('table', 5.8, 4.0, 8.2, 5.0, 0.76, COLOR.wood)); // dining table
  boxes.push(furn('cabinet', 10.4, 2.4, 10.9, 4.4, 1.9, COLOR.darkWood)); // china cabinet
  boxes.push(furn('counter', 5.5, 7.4, 7.5, 7.9, 0.9, COLOR.wood)); // sideboard
  // Kitchen
  boxes.push(furn('counter', 5.0, -7.9, 10.9, -7.3, 0.9, COLOR.counter)); // north counter
  boxes.push(furn('counter', 10.3, -7.3, 10.9, -4.0, 0.9, COLOR.counter)); // east counter
  boxes.push(furn('counter', 6.5, -5.2, 8.5, -4.2, 0.9, COLOR.island)); // island
  boxes.push(furn('cabinet', 4.1, -7.9, 4.8, -7.2, 1.9, COLOR.fridge)); // fridge
  boxes.push(furn('table', 9.3, -2.4, 10.5, -1.6, 0.75, COLOR.wood)); // breakfast table
  // Study / library
  boxes.push(furn('shelf', -1.9, -7.4, -1.4, -2.2, 2.1, COLOR.darkWood)); // west bookshelves
  boxes.push(furn('shelf', -1.0, -7.9, 2.0, -7.4, 2.1, COLOR.darkWood)); // north bookshelves
  boxes.push(furn('table', 1.6, -6.3, 3.2, -5.5, 0.76, COLOR.wood)); // desk
  boxes.push(furn('couch', -0.6, -3.3, 0.3, -2.4, 0.85, COLOR.redFabric)); // reading chair
  // Bedroom
  boxes.push(furn('bed', -10.9, -5.4, -8.8, -3.8, 0.6, COLOR.bedding));
  boxes.push(furn('cabinet', -10.9, -6.1, -10.4, -5.6, 0.6, COLOR.darkWood)); // nightstand
  boxes.push(furn('cabinet', -8.0, -7.9, -6.6, -7.3, 2.0, COLOR.darkWood)); // wardrobe
  boxes.push(furn('cabinet', -5.6, -4.0, -5.1, -2.8, 0.9, COLOR.wood)); // dresser
  // Bathroom
  boxes.push(furn('counter', -4.0, -7.9, -2.1, -7.1, 0.55, COLOR.porcelain)); // bathtub
  boxes.push(furn('cabinet', -2.6, -5.6, -2.1, -5.0, 0.85, COLOR.porcelain)); // sink
  // Storage
  boxes.push(furn('shelf', -4.9, -4.4, -4.4, -2.0, 2.0, COLOR.shelfStorage));
  boxes.push(furn('crate', -2.9, -4.4, -2.1, -3.6, 0.8, COLOR.crate));
  boxes.push(furn('crate', -2.8, -3.5, -2.2, -2.9, 0.6, COLOR.crateDark));

  // --- Exit --------------------------------------------------------------------------------
  const door: Box = { kind: 'wall', min: v3(-0.6, 0, 8 - HT), max: v3(0.6, DOORWAY_HEIGHT, 8 + HT), color: COLOR.door };
  const exitZone = { min: v3(-1.2, 0, 8 + HT), max: v3(1.2, 3.0, 9.6) };

  // --- Nav graph ---------------------------------------------------------------------------
  const navPositions: Vec3[] = [
    // foyer
    v3(0, 0, 1.9), v3(0, 0, 4.0), v3(0, 0, 7.0), v3(-2.3, 0, 5.05), v3(2.3, 0, 5.05),
    // hallway
    v3(-10.2, 0, 0), v3(-7.95, 0, 0), v3(-6.45, 0, 0), v3(-3.45, 0, 0), v3(0, 0, 0),
    v3(2.55, 0, 0), v3(4.5, 0, 0.2), v3(6.55, 0, 0), v3(8.55, 0, 0), v3(9.9, 0, 0),
    // living room
    v3(-6.45, 0, 1.9), v3(-3.7, 0, 5.05), v3(-6.0, 0, 3.6), v3(-9.5, 0, 4.8), v3(-5.6, 0, 6.8), v3(-9.5, 0, 2.4),
    // dining room
    v3(8.55, 0, 1.9), v3(3.7, 0, 5.05), v3(5.0, 0, 3.0), v3(9.4, 0, 5.8), v3(7.0, 0, 6.5), v3(7.0, 0, 2.7),
    // bedroom
    v3(-7.95, 0, -1.9), v3(-7.4, 0, -4.6), v3(-5.7, 0, -6.45), v3(-9.4, 0, -6.8), v3(-9.9, 0, -2.4),
    // bathroom
    v3(-4.3, 0, -6.45), v3(-3.4, 0, -5.6),
    // storage
    v3(-3.45, 0, -1.9), v3(-3.6, 0, -3.0),
    // study
    v3(2.55, 0, -1.9), v3(3.3, 0, -4.45), v3(1.0, 0, -4.2), v3(0.2, 0, -6.6),
    // kitchen
    v3(6.55, 0, -1.9), v3(4.7, 0, -4.45), v3(5.6, 0, -3.2), v3(9.4, 0, -3.2), v3(9.4, 0, -6.4), v3(5.6, 0, -6.4),
  ];

  const HALF_PI = Math.PI / 2;
  const level: LevelData = {
    id: LEVEL_ID,
    seed,
    bounds: { min: v3(-11.1, 0, -8.1), max: v3(11.1, WALL_HEIGHT, exitZone.max.z) },
    boxes,
    nav: [],
    playerSpawns: [
      { position: v3(-0.7, 0, 5.6), yaw: 0 },
      { position: v3(0.7, 0, 5.6), yaw: 0 },
      { position: v3(-0.7, 0, 6.6), yaw: 0 },
      { position: v3(0.7, 0, 6.6), yaw: 0 },
    ],
    // Bathroom: the deepest room from the front door.
    monsterSpawn: v3(-3.4, 0, -5.6),
    // The tutorial note, on the little foyer table by the door (y = table top).
    tutorialSpot: v3(-2.6, 0.75, 6.5),
    // All on furniture tops (y = top surface), one per room.
    fuseSpawns: [
      v3(-10.65, 0.6, -5.85), // bedroom nightstand
      v3(9.2, 0.9, -7.6), // kitchen counter
      v3(2.4, 0.76, -5.9), // study desk
      v3(-2.5, 0.8, -4.0), // storage crate
      v3(-7.7, 0.45, 4.5), // living room coffee table
      v3(6.5, 0.9, 7.65), // dining sideboard
      v3(-2.35, 0.85, -5.3), // bathroom sink
      v3(10.65, 0.75, 0), // hallway end table
    ],
    // On the inside of the south wall, right of the front door, facing into the foyer.
    fuseBox: { position: v3(1.5, 1.4, 8 - HT - 0.05), yaw: 0 },
    exit: { door, zone: exitZone },
    // Centers sit 1 cm inside the inner wall face; yaw faces into the house.
    windows: [
      windowAt(-10.89, 1.5, 5.0, 1.2, 1.1, -HALF_PI), // living, west
      windowAt(-7.5, 1.5, 7.89, 1.2, 1.1, 0), // living, south
      windowAt(7.0, 1.6, 7.89, 1.2, 1.0, 0), // dining, south
      windowAt(10.89, 1.5, 6.0, 1.2, 1.1, HALF_PI), // dining, east
      windowAt(8.0, 1.6, -7.89, 1.2, 0.9, Math.PI), // kitchen, north (over the counter)
      windowAt(10.89, 1.5, -2.5, 1.0, 1.1, HALF_PI), // kitchen, east
      windowAt(3.0, 1.6, -7.89, 0.9, 1.1, Math.PI), // study, north
      windowAt(-10.89, 1.5, -2.5, 1.0, 1.1, -HALF_PI), // bedroom, west
      windowAt(-9.5, 1.5, -7.89, 1.0, 1.1, Math.PI), // bedroom, north
      windowAt(-3.0, 1.8, -7.89, 0.6, 0.5, Math.PI), // bathroom, north (small, over the tub)
      windowAt(-10.89, 1.6, 0, 0.8, 1.2, -HALF_PI), // hallway, west end
      windowAt(10.89, 1.6, 0, 0.8, 1.2, HALF_PI), // hallway, east end
      windowAt(-1.9, 1.6, 7.89, 0.6, 1.2, 0), // foyer, beside the door
    ],
  };

  level.nav = buildNavGraph(level, navPositions, NAV_LINK_CLEARANCE, NAV_MAX_LINK);
  return level;
}
