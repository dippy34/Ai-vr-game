/**
 * Shared tunables. Every "feel" number that more than one module needs lives here so the game can
 * be balanced in one place. Module-private constants stay in their own module.
 * Plain data only (no imports) so it ports easily.
 */

export const GAME = {
  maxPlayers: 4,
  /** Fuses that must go into the fuse box to open the exit. */
  fusesRequired: 3,
  /** Seconds the monster pauses after catching someone. */
  feedingTime: 4,
  /** Seconds the win/lose screen shows before the host can restart. */
  roundEndDelay: 3,
} as const;

export const PLAYER = {
  /** Standing eye height used for desktop players and as the "not crouching" reference. */
  eyeHeight: 1.6,
  /** Desktop crouch eye height. */
  crouchEyeHeight: 1.0,
  /** Head lower than this (meters) counts as crouching -> quieter footsteps. */
  crouchThreshold: 1.15,
  /** Collision radius around the head on the XZ plane. */
  radius: 0.25,
  walkSpeed: 1.9,
  sneakSpeed: 0.9,
  sprintSpeed: 3.3,
  /** VR snap turn angle (radians). */
  snapTurnAngle: Math.PI / 6,
  /** Hand must be this close (m) to grab something in VR. */
  vrGrabReach: 0.35,
  /** Desktop players grab with a key, so they get generous reach. */
  desktopGrabReach: 1.6,
} as const;

/**
 * How the blind monster hears.
 *
 * Every noise has a loudness in 0..1 at its source. The monster can hear a noise if
 *     effectiveDistance <= loudness * HEARING.rangeMeters
 * where effectiveDistance = distance * (1 + HEARING.wallOcclusion * wallsBetween).
 *
 * Reference loudness values (what the numbers mean):
 *   whisper ~0.12   normal talk ~0.5   shout/scream ~0.95
 *   sneaking step ~0.06   walking step ~0.18   sprinting step ~0.45
 *   light switch click ~0.04   winding the light ~0.42   dropping an item ~0.3   exit door 1.0
 */
export const HEARING = {
  rangeMeters: 26,
  /** Each wall between the noise and the monster multiplies distance by (1 + this). */
  wallOcclusion: 0.7,
  /** If loudness * range / effectiveDistance exceeds this, the monster charges (chase) instead of investigating. */
  chaseRatio: 2.2,
  /** Seconds of silence after which a chasing monster gives up and investigates the last spot. */
  chaseForget: 3.5,
  /** Within this distance (m) it notices even a perfectly silent player (it bumped into you). */
  touchRadius: 0.7,
  /** Within this distance (m) of a player's head (XZ) the monster catches them. */
  catchRadius: 0.75,
} as const;

export const NOISE = {
  whisper: 0.12,
  talk: 0.5,
  shout: 0.95,
  sneakStep: 0.06,
  walkStep: 0.18,
  sprintStep: 0.45,
  /** Switching the Crank Light on or off: a tiny click, heard only right next to it. */
  lightClick: 0.04,
  /** Winding the Crank Light: a loud ratcheting whirr (louder than a sprinting step). */
  crank: 0.42,
  itemDrop: 0.3,
  itemPickup: 0.08,
  fuseInsert: 0.35,
  exitDoor: 1.0,
  /** Footstep emitted every this many meters of horizontal head travel. */
  stepLength: 0.7,
} as const;

/**
 * The Crank Light: a wind-up flashlight strapped to every player's left wrist (desktop: held low
 * on the right). Light is safe (the monster is blind) but charging it is loud.
 */
export const LIGHT = {
  /** Seconds a full charge lasts with the beam on. */
  batterySeconds: 60,
  /** Seconds of winding that fill an empty battery. */
  crankSecondsToFull: 6,
  /** Every round starts with this charge (0..1), switched on. */
  startCharge: 1,
  startOn: true,
  /** Below this charge the beam dims and flickers (a warning to wind it). */
  lowCharge: 0.2,
  /** While winding, a NOISE.crank noise is made this often (s). */
  crankNoiseInterval: 0.3,
} as const;

/** Procedural monster limits (rad), turns (rad/s), blends (1/s), and clearance (m). */
export const MONSTER_ANIMATION = {
  elbowTurnSpeed: 4.5,
  armTurnSpeed: 18,
  wristTurnSpeed: 7,
  wristMaxAngle: 1.5,
  hipRecoverSpeed: 6,
  handPlantBlendSpeed: 8,
  rearUpSpeed: 10,
  preyFaceClearance: 0.65,
} as const;

export const MONSTER = {
  /** Patrol pace inside a room (a hunched prowl), and when roaming over to another room. */
  wanderSpeed: 1.1,
  roamSpeed: 1.45,
  investigateSpeed: 1.9,
  chaseSpeed: 3.1,
  /** Stalking a faint sound / probing hiding spots: slow, near-silent steps (gait 'creep'). */
  creepSpeed: 0.6,
  probeSpeed: 0.85,
  /** Turn rate rad/s. */
  turnSpeed: 4.5,
  /** Seconds it stands listening where it heard something before searching around. */
  listenTime: 1.4,
  /** How far its body is from the ground to the top of its head (visual + hearing origin). */
  height: 2.3,
  /** Full standing height (m): door lintels are lower (2.4 m), so it ducks under them. */
  standHeight: 2.6,
  /** Body radius on the XZ plane standing up, and on all fours (squeezing through gaps). */
  radius: 0.35,
  crawlRadius: 0.24,
  /** Furniture whose top is at most this high (beds, tables, couches, crates) is climbed over. */
  climbMaxHeight: 0.86,
  /** Speed while ducking under a lintel (multiplier), crawling and climbing (multiplier + cap, m/s). */
  duckSpeedMul: 0.8,
  crawlSpeedMul: 0.6,
  crawlSpeedMax: 1.2,
  climbSpeedMul: 0.5,
  climbSpeedMax: 0.9,
  /** How fast (m/s) its body rises onto / sinks off a furniture top. */
  climbRiseSpeed: 1.8,

  // ---- hearing reactions ----
  /** Hearing ratios (see HEARING) below this are "faint": it stalks instead of walking over. */
  stalkRatio: 1.4,
  /** Hearing a stalked sound again within this distance (m) makes it lunge (chase). */
  lungeRange: 4.5,
  /** It only creeps within this distance (m) of a stalked sound; farther away it walks closer first. */
  stalkRange: 6,
  /** Seconds it freezes to orient on a new sound (faint: random in [min, max]). */
  orientTime: 0.35,
  stalkOrientMin: 0.8,
  stalkOrientMax: 1.4,
  /** While stalking it stops to listen every [min, max] s of creeping. */
  stalkListenEvery: [2.2, 3.6] as readonly [number, number],
  stalkListenTime: [0.8, 1.3] as readonly [number, number],
  /** Chase prediction: aim at most this many seconds ahead along a noisy runner's track. */
  chaseLead: 1.0,

  // ---- searching (after arriving where it heard something and finding nothing) ----
  /** Hiding spots it checks around the spot (m radius), and how many. */
  searchRadius: 3.5,
  searchSpotsMin: 2,
  searchSpotsMax: 3,
  /** 'search' act: feeling around; a player within this reach (m, frontal, no wall) is noticed. */
  searchFeel: 1.1,
  searchTime: [1.4, 2.2] as readonly [number, number],
  sniffTime: [1.1, 1.7] as readonly [number, number],
  /**
   * 'sweep' act: a telegraphed long-armed swipe. `sweepWindup` s of wind-up (no catch: time to
   * react), then the strike: for `sweepStrike` s any alive player within `sweepReach` m (XZ),
   * inside +-`sweepArc` rad of where it faces and with no wall in between is caught. Then it
   * recovers for `sweepRecover` s. actStart marks the start of the wind-up.
   */
  sweepWindup: 0.5,
  sweepStrike: 0.3,
  sweepRecover: 0.45,
  sweepReach: 1.6,
  sweepArc: 1.2,

  // ---- lurking ----
  /** Chance to lurk after a search turns up nothing (+ `lurkAfterChase` if it lost a chase). */
  lurkChance: 0.3,
  lurkAfterChase: 0.35,
  lurkTime: [6, 12] as readonly [number, number],
  /** While lurking it lunges (chase) at sounds with at least this hearing ratio. */
  lurkChaseRatio: 1.6,

  // ---- patrol ----
  /** Chance to stop at a patrol point (listen / sniff) and for how long. */
  patrolPauseChance: 0.35,
  patrolPause: [1.2, 3] as readonly [number, number],
  /** While it stands frozen listening (act 'listen') it hears this much farther. */
  listenHearing: 1.25,

  // ---- escalation ----
  /**
   * Escalation 0..1 = 65% fuses inserted + 35% round time (ramps from `escalationGrace` s to
   * `escalationTime` s). It scales speeds by up to (1 + escalationSpeed), hearing range by up to
   * (1 + escalationHearing) and shortens its pauses. Once the exit opens it is in a frenzy.
   */
  escalationSpeed: 0.15,
  escalationHearing: 0.1,
  escalationGrace: 120,
  escalationTime: 600,
  frenzySpeed: 1.2,
  frenzyHearing: 1.15,
  /** In a frenzy it charges at sounds with hearing ratio >= HEARING.chaseRatio * this. */
  frenzyChaseRatio: 0.75,
} as const;

/**
 * The monster's navigation grid (precomputed per level in src/core/navgrid.ts). Cells are classed
 * by what its body must do there: walk tall, duck (under a lintel), crawl (squeeze on all fours)
 * or climb (over low furniture). A* (octile) minimizes travel TIME: the monster passes per-meter
 * costs of (its open-floor speed / its speed there) at its current pace, times a little
 * reluctance, so it climbs over a bed while searching but runs around it in a chase.
 * `cost*` are the fixed defaults used without a pace (tools, tests).
 */
export const NAV = {
  cellSize: 0.2,
  /** Extra clearance (m) a cell center needs beyond the body radius. */
  margin: 0.04,
  costDuck: 1.3,
  costCrawl: 2.6,
  costClimb: 2.8,
  crawlReluctance: 1.1,
  climbReluctance: 1.1,
  /** Extra cost per meter for hugging walls/furniture closer than `hugDistance` (m) beyond the radius. */
  costHug: 0.35,
  hugDistance: 0.2,
  /** A* gives up after this many expanded cells and walks toward the closest cell it found. */
  maxExpansions: 14000,
  /** Route planning budget: tokens per second and burst (one A* per token, at most one per tick). */
  plansPerSecond: 6,
  planBurst: 3,
} as const;

/**
 * Microphone → loudness mapping. RMS level in dBFS is mapped linearly so that
 * MIC.dbFloor -> 0 and MIC.dbCeil -> 1. Below MIC.gate the voice makes no noise at all
 * (so breathing / room tone don't constantly alert the monster).
 */
export const MIC = {
  dbFloor: -58,
  dbCeil: -12,
  gate: 0.06,
  /** Seconds for the loudness meter to fall back (attack is instant). */
  release: 0.25,
} as const;

export const NET = {
  /** PeerJS ids are `${idPrefix}${ROOMCODE}` for hosts. */
  idPrefix: 'mute-vr-room-',
  /** Room codes use these characters (no 0/O/1/I confusion). */
  codeAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  codeLength: 5,
  /** Client -> host pose updates per second. */
  poseRate: 20,
  /** Host -> clients full snapshots per second. */
  snapshotRate: 12,
  /** Client -> host voice loudness reports per second. */
  voiceRate: 10,
} as const;

export const RENDER = {
  /**
   * Visual quality tier. 'auto' = 'quest' while a WebXR session presents, else 'desktop'
   * (`?quality=quest` forces a tier for testing). Tiers only change runtime values, never shaders.
   */
  quality: 'auto' as 'auto' | 'quest' | 'desktop',
  tiers: {
    quest: {
      /** Crank Light shadow map (px, square; the local beam only), rendered only while it is on. */
      shadowMapSize: 512,
      /** PCF blur radius in shadow-map texels. */
      shadowRadius: 2.2,
      /** Film grain amount (0 = none). Kept low in VR: per-eye noise shimmers in stereo. */
      grain: 0.02,
      /** Edge darkening (VR lenses already vignette). */
      vignette: 0.12,
      /** Lateral colour fringe at the edges (0 = off). */
      fringe: 0,
      /** How much the fog density drifts (0..1). */
      fogNoise: 0.35,
      /** Dust motes around the viewer (lit by moon shafts and your Crank Light). */
      motes: 260,
      /** Lens glare sprite on other players' beams aimed at you. */
      glare: true,
    },
    desktop: {
      shadowMapSize: 1024,
      shadowRadius: 2.6,
      grain: 0.06,
      vignette: 0.32,
      fringe: 0.6,
      fogNoise: 0.5,
      motes: 520,
      glare: true,
    },
  },
  /** Filmic tone mapping (AgX-style curve, fx/pipeline): exposure and saturation. */
  exposure: 1.5,
  toneSaturation: 1.15,
  /**
   * Faint ambient light so the world isn't 100% black (eyes "adjusted to the dark"): fraction of a
   * surface's colour, scene-linear (before exposure and the tone curve, which crushes the deepest
   * darks). Kept very low on purpose: without your Crank Light you should barely make out a
   * doorway, never read a room (or see the monster coming).
   */
  ambientIntensity: 0.02,
  /** Fog makes far things vanish into black: fully fogged by fogFar (the level culls beyond it). */
  fogNear: 1.5,
  fogFar: 11,
  /** Exponential height fog on top: base density (1/m), its falloff with height, floor boost. */
  fogDensity: 0.07,
  fogHeightFalloff: 1.6,
  fogGroundBoost: 1.4,
  /** Crank Light scattered by the haze (output-space colour, strength). */
  hazeColor: [0.78, 0.84, 1.0] as readonly [number, number, number],
  hazeStrength: 0.07,
  /** Seconds the jumpscare's burned-in afterimage of the face takes to fade. */
  afterimageDuration: 2.2,
  /**
   * Crank Light beam (a spot light per player): intensity (candela-like; inverse-square falloff,
   * decay 2), cone half angle (deg), penumbra, range (m) and colour (a warm incandescent bulb).
   * The weak omni "bounce" sits where the local beam hits something.
   */
  beamIntensity: 20,
  beamAngle: 30,
  beamPenumbra: 0.6,
  beamRange: 13,
  beamColor: 0xffdcb4,
  beamBounce: 0.6,
  /** How much the local beam lights the haze and dust motes (the old camera flash was 1). */
  beamHaze: 0.3,
  /** The local beam casts soft shadows through a lens cookie (`?shadows=0` turns it off). */
  beamShadows: true as boolean,
  /**
   * WebXR eye-buffer size relative to the browser's recommended one (Quest: fill rate is the
   * bottleneck with per-pixel lights; 0.9 = 19% fewer pixels, barely visible with MSAA on).
   */
  xrFramebufferScale: 0.9,
  /** Desktop canvas devicePixelRatio cap. */
  maxPixelRatio: 2,
  /**
   * JUMPSCARE: the ~1.6 s catch sequence (the monster's face lunging into yours, a flash burst, a
   * red vignette pulse, cut to black). false = being caught just turns you into a ghost.
   */
  jumpscare: true as boolean,
} as const;

/** Player colors (avatar tints), assigned in join order. */
export const PLAYER_COLORS = [0xe8c547, 0x4fb3e8, 0xe86a4f, 0x7be84f] as const;
