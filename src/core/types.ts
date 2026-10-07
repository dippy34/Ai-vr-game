/**
 * Shared, engine-agnostic data types for MUTE.
 *
 * Everything in `src/core` is plain TypeScript with no three.js / DOM / WebXR imports, so the
 * game rules can be reused as-is in another web wrapper or ported line-by-line to C# / GDScript
 * when the game moves to a native app. Keep it that way.
 *
 * Conventions:
 *  - Units are meters and seconds. Y is up. The level lives on the XZ plane, floor at y = 0.
 *  - Yaw is radians around +Y, 0 = facing -Z, positive = counter-clockwise seen from above
 *    (same as three.js `Object3D.rotation.y`).
 *  - All positions/rotations are world space unless a name says otherwise.
 *  - State objects are plain JSON (no classes, no Maps) so they can be sent over the network.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export type PlayerId = string;

export type Handedness = 'left' | 'right';

/**
 * Finger curl per finger, 0 = fully straight, 1 = fully curled into the palm.
 * Order: [thumb, index, middle, ring, pinky].
 * This is the only finger data we network. It is produced by both hand tracking and controller
 * button approximations, and it is enough to read hand signs (point, fist, thumbs up, counting...).
 */
export type FingerCurls = [number, number, number, number, number];

/**
 * Canonical hand frame (input converts WebXR data into this, renderer draws from it):
 *  - `position` is the wrist.
 *  - local -Z points from the wrist toward the middle fingertip (the way fingers extend),
 *  - local +Y points out of the BACK of the hand,
 *  - the thumb is on local -X for the right hand and local +X for the left hand.
 * So a right hand held flat, palm down, fingers forward has identity-ish rotation with yaw only.
 */
export interface HandPose {
  /** False when the hand/controller is not tracked this frame (renderer hides it). */
  tracked: boolean;
  position: Vec3;
  rotation: Quat;
  curls: FingerCurls;
}

export interface HeadPose {
  /** Eye-center position. */
  position: Vec3;
  rotation: Quat;
}

export interface PlayerPose {
  head: HeadPose;
  left: HandPose;
  right: HandPose;
}

/** Something held in a hand. */
export type HeldRef = { kind: 'camera' } | { kind: 'item'; itemId: number };

export type PlayerStatus = 'alive' | 'caught' | 'escaped';

export interface PlayerState {
  id: PlayerId;
  name: string;
  /** 0xRRGGBB, used for avatar tint. */
  color: number;
  /** True for keyboard/mouse players (they get bigger grab reach). */
  isDesktop: boolean;
  status: PlayerStatus;
  /** Where this player's rig (feet) should be placed when a round starts. Assigned by the host. */
  spawn: Vec3;
  /** Yaw the player should face at spawn. */
  spawnYaw: number;
  pose: PlayerPose;
  held: Record<Handedness, HeldRef | null>;
}

export type ItemKind = 'fuse' | 'film';

export interface ItemState {
  id: number;
  kind: ItemKind;
  /** 'world' = lying around, 'held' = in someone's hand, 'used' = consumed (inserted fuse / loaded film). */
  where: 'world' | 'held' | 'used';
  position: Vec3;
  /** Yaw of the item when lying in the world (visual only). */
  yaw: number;
  holder: PlayerId | null;
  hand: Handedness | null;
}

export interface CameraState {
  holder: PlayerId | null;
  hand: Handedness | null;
  /** World position (follows the holder's hand while held, stays put when dropped). */
  position: Vec3;
  /** Yaw when lying in the world (visual only). */
  yaw: number;
  film: number;
  /** Sim time of the last successful flash (for cooldown + visuals). -Infinity-like if never: use -1e9. */
  lastFlashTime: number;
}

export type MonsterMode =
  /** Patrolling the house, not aware of anyone. */
  | 'wander'
  /** Heard something: stalking or walking over to it, then searching around (maybe lurking). */
  | 'investigate'
  /** Heard something loud and close; running at it. */
  | 'chase'
  /** Just caught someone; pauses before roaming again. */
  | 'feeding';

export interface MonsterState {
  position: Vec3;
  yaw: number;
  mode: MonsterMode;
  /** Where it is currently heading (null when idle). */
  target: Vec3 | null;
  /** Player it is chasing, if it knows (only set in 'chase'). */
  targetPlayer: PlayerId | null;
  /** Current speed in m/s (renderer/audio use it for animation & footsteps). */
  speed: number;
  /** 0..1 agitation, rises with what it hears, decays over time. Drives growls/heartbeat. */
  alert: number;
  // ---- body language (set by the sim, drives the procedural animation and its sounds) ----
  /** How it is moving its body right now. */
  gait: MonsterGait;
  /** Body height for the space it is in (it is taller than the doorways). */
  posture: MonsterPosture;
  /** What it is doing besides moving (a listen, a sniff, an arm sweep...). */
  act: MonsterAct;
  /** Sim time `act` started (animation phase; also restarts when the same act repeats). */
  actStart: number;
  /** Where its attention (head) is aimed: the sound it is listening for, the spot it searches. */
  focus: Vec3 | null;
}

/**
 * still  standing or crouched in place
 * creep  slow, deliberate, near-silent steps (stalking a faint sound)
 * walk   hunched, roaming pace
 * run    charging (all fours allowed)
 */
export type MonsterGait = 'still' | 'creep' | 'walk' | 'run';

/**
 * tall   full height, open rooms
 * duck   head and back bent low under something overhead (door lintels are 2.4 m, it is ~2.6 m)
 * crawl  on all fours: squeezing through a doorway, under or over furniture
 */
export type MonsterPosture = 'tall' | 'duck' | 'crawl';

/**
 * none    just moving
 * listen  frozen, head turned toward `focus`
 * sniff   head low, breathing in toward `focus`
 * search  feeling around the area near `focus`
 * sweep   a long-armed swipe across `focus` (it can catch a silent player this way)
 * lurk    waiting motionless (e.g. beside a doorway)
 * climb   getting onto / over low furniture (position.y follows the surface)
 */
export type MonsterAct = 'none' | 'listen' | 'sniff' | 'search' | 'sweep' | 'lurk' | 'climb';

export type GamePhase = 'lobby' | 'playing' | 'won' | 'lost';

export interface WorldState {
  /** Seconds since the sim was created. */
  time: number;
  phase: GamePhase;
  levelSeed: number;
  players: Record<PlayerId, PlayerState>;
  monster: MonsterState;
  items: ItemState[];
  camera: CameraState;
  fusesInserted: number;
  fusesRequired: number;
  exitOpen: boolean;
  /** Most recent noise the monster noticed (for debugging / UI). */
  lastHeard: { position: Vec3; loudness: number; time: number } | null;
}

export type NoiseSource = 'voice' | 'footstep' | 'camera' | 'item' | 'door';

/** A sound in the world that the monster might hear. */
export interface NoiseEvent {
  source: NoiseSource;
  position: Vec3;
  /** 0..1 loudness at the source. See HEARING in config.ts for what the numbers mean. */
  loudness: number;
  playerId: PlayerId | null;
}

/** Things a player asks the host to do. */
export type PlayerAction =
  /** Grab the nearest grabbable (camera, fuse, film) within `reach` of `position`. */
  | { type: 'grab'; hand: Handedness; position: Vec3; reach: number }
  /** Let go of whatever is in `hand`, leaving it at `position`. */
  | { type: 'release'; hand: Handedness; position: Vec3 }
  /** Pull the camera trigger. Host checks the player holds the camera in `hand` and has film. */
  | { type: 'flash'; hand: Handedness; position: Vec3; direction: Vec3 };

export interface FlashEvent {
  type: 'flash';
  by: PlayerId;
  position: Vec3;
  /** Unit vector the camera lens is pointing. */
  direction: Vec3;
  time: number;
}

/** Things that happened, produced by the host sim and broadcast to every client. */
export type SimEvent =
  | FlashEvent
  /** Trigger pulled with no film left (or during cooldown): just a dry click. */
  | { type: 'dryFire'; by: PlayerId; position: Vec3 }
  | { type: 'pickup'; by: PlayerId; what: 'camera' | ItemKind; position: Vec3 }
  | { type: 'drop'; by: PlayerId; what: 'camera' | ItemKind; position: Vec3 }
  | { type: 'filmLoaded'; by: PlayerId; amount: number; total: number; position: Vec3 }
  | { type: 'fuseInserted'; by: PlayerId; count: number; required: number; position: Vec3 }
  | { type: 'exitOpened'; position: Vec3 }
  /** Monster changed mode to 'investigate' or 'chase' (audio plays a growl/shriek). */
  | { type: 'monsterAlert'; mode: MonsterMode; position: Vec3 }
  | { type: 'playerCaught'; id: PlayerId; position: Vec3 }
  | { type: 'playerEscaped'; id: PlayerId }
  | { type: 'phase'; phase: GamePhase };

// ---------------------------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------------------------

export type BoxKind =
  /** Solid wall (blocks movement and attenuates sound). */
  | 'wall'
  /** Floor slab (walkable, not collided against horizontally). */
  | 'floor'
  /** Ceiling slab. */
  | 'ceiling'
  /** Furniture: blocks movement, does NOT attenuate sound. */
  | 'furniture';

/** Optional visual hint so the renderer can make furniture look like something. */
export type PropStyle = 'table' | 'shelf' | 'bed' | 'couch' | 'crate' | 'counter' | 'cabinet' | 'piano';

export interface Box {
  kind: BoxKind;
  min: Vec3;
  max: Vec3;
  style?: PropStyle;
  /** Optional base color hint 0xRRGGBB. */
  color?: number;
}

export interface NavNode {
  id: number;
  position: Vec3;
  /** Ids of nodes reachable in a straight, unobstructed line. */
  links: number[];
}

export interface LevelData {
  id: string;
  seed: number;
  /** Outer bounds of the playable area. */
  bounds: { min: Vec3; max: Vec3 };
  /** All static geometry: walls, floors, ceilings, furniture. */
  boxes: Box[];
  /** Coarse waypoint graph (spawn spots, debug). The monster navigates on a grid (navgrid.ts). */
  nav: NavNode[];
  /** Player spawn points (feet), at least 4. */
  playerSpawns: { position: Vec3; yaw: number }[];
  monsterSpawn: Vec3;
  cameraSpawn: { position: Vec3; yaw: number };
  /** Where fuses start (the sim picks `fusesRequired` of these). */
  fuseSpawns: Vec3[];
  filmSpawns: Vec3[];
  /** Wall-mounted fuse box; holding a fuse near `position` inserts it. `yaw` = direction it faces. */
  fuseBox: { position: Vec3; yaw: number };
  /** The exit door. Solid while closed. When open, an alive player whose head enters `zone` escapes. */
  exit: { door: Box; zone: { min: Vec3; max: Vec3 } };
  /** Windows let in faint moonlight (renderer only). Each is a vertical rectangle on a wall. */
  windows: { center: Vec3; width: number; height: number; yaw: number }[];
}
