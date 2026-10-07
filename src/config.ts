/**
 * Shared tunables. Every "feel" number that more than one module needs lives here so the game can
 * be balanced in one place. Module-private constants stay in their own module.
 * Plain data only (no imports) so it ports easily.
 */

export const GAME = {
  maxPlayers: 4,
  /** Fuses that must go into the fuse box to open the exit. */
  fusesRequired: 3,
  /** Film shots the camera starts with. */
  startingFilm: 6,
  /** Shots added by each film roll pickup. */
  filmPerRoll: 3,
  /** Minimum seconds between flashes. */
  flashCooldown: 1.2,
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
 *   camera click ~0.22   dropping an item ~0.3   exit door opening 1.0
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
  cameraClick: 0.22,
  itemDrop: 0.3,
  itemPickup: 0.08,
  fuseInsert: 0.35,
  exitDoor: 1.0,
  /** Footstep emitted every this many meters of horizontal head travel. */
  stepLength: 0.7,
} as const;

export const MONSTER = {
  wanderSpeed: 1.0,
  investigateSpeed: 1.9,
  chaseSpeed: 3.1,
  /** Turn rate rad/s. */
  turnSpeed: 4.5,
  /** Seconds it lingers at an investigated spot, "listening", before wandering again. */
  listenTime: 3,
  /** How far its body is from the ground to the top of its head (visual + hearing origin). */
  height: 2.3,
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
      /** Flash shadow map (px, square); rendered only while the flash is lit. */
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
      /** Dust motes around the viewer (lit by moon shafts and the flash). */
      motes: 260,
      /** Lens glare sprite on flashes aimed at you. */
      glare: true,
    },
    desktop: {
      shadowMapSize: 1024,
      shadowRadius: 2.6,
      grain: 0.06,
      vignette: 0.42,
      fringe: 0.6,
      fogNoise: 0.5,
      motes: 520,
      glare: true,
    },
  },
  /** Filmic tone mapping (AgX + look): exposure, toe/contrast power and saturation. */
  exposure: 1.5,
  tonePower: 1.12,
  toneSaturation: 1.15,
  /** Faint ambient light so the world isn't 100% black (eyes "adjusted to the dark"). */
  ambientIntensity: 0.05,
  /** Fog makes far things vanish into black: fully fogged by fogFar (the level culls beyond it). */
  fogNear: 1.5,
  fogFar: 11,
  /** Exponential height fog on top: base density (1/m), its falloff with height, floor boost. */
  fogDensity: 0.07,
  fogHeightFalloff: 1.6,
  fogGroundBoost: 1.4,
  /** Flash light scattered by the haze (output-space colour, strength). */
  hazeColor: [0.78, 0.84, 1.0] as readonly [number, number, number],
  hazeStrength: 0.09,
  /** Seconds the flash light takes to fade. */
  flashDuration: 0.22,
  /** Seconds the frozen afterimages from a flash take to fade. */
  afterimageDuration: 2.2,
  /** Max distance (m) from the flash at which things get an afterimage. */
  flashRange: 14,
  /**
   * Flash spot light: peak intensity (candela-like; inverse-square falloff, decay 2), cone half
   * angle (deg) and penumbra. The omni "bounce" sits where the beam first hits a wall.
   */
  flashPeak: 34,
  flashAngle: 56,
  flashPenumbra: 0.75,
  flashBounce: 1.5,
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
