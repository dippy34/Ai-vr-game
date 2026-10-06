/**
 * Contracts between the game loop (src/game) and the platform layer (rendering, input, audio).
 *
 * The platform layer is the ONLY place that touches three.js, WebXR, WebAudio and the DOM canvas.
 * When MUTE moves to a native app, these interfaces are what gets re-implemented; src/core and
 * src/game logic stay the same (or get ported 1:1).
 */

import type * as THREE from 'three';
import type {
  FlashEvent,
  Handedness,
  HandPose,
  HeadPose,
  LevelData,
  PlayerId,
  PlayerPose,
  SimEvent,
  Vec3,
  WorldState,
} from '../core/types';

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

export interface RenderContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /**
   * The local player's rig. Its position is the player's feet on the floor; its rotation.y is the
   * player's turn. The camera and XR controllers/hands are children of it. Locomotion moves this.
   */
  rig: THREE.Group;
}

export interface IGameRenderer {
  readonly ctx: RenderContext;
  /** Build meshes for a level (clears any previous level). */
  loadLevel(level: LevelData): void;
  /**
   * Called once per frame before render().
   * `localPose` is the freshest local pose: use it (not state.players[localId].pose) for the
   * local player's own hands and anything they hold, so there is zero lag.
   * Remote players should be smoothed/interpolated toward their latest pose.
   */
  update(state: WorldState, localId: PlayerId, localPose: PlayerPose, dt: number): void;
  /** Update a remote player's pose as soon as it arrives (between snapshots). */
  setRemotePose(id: PlayerId, pose: PlayerPose): void;
  /**
   * Camera flash: a brief, very bright light from `event.position` along `event.direction`, plus
   * frozen pale "afterimages" of every player's head + hands (with their current finger curls) and
   * of the monster, if within RENDER.flashRange and roughly in front of the flash. Afterimages fade
   * over RENDER.afterimageDuration. This is how hand signs are read in the dark.
   */
  flash(event: FlashEvent, state: WorldState, localId: PlayerId, localPose: PlayerPose): void;
  /**
   * The monster caught a player (sim 'playerCaught' event). For the local player this plays the
   * catch / jumpscare sequence; for others it can show the monster grabbing them.
   */
  caught(event: { id: PlayerId; position: Vec3 }, state: WorldState, localId: PlayerId, localPose: PlayerPose): void;
  /** Local player's current voice loudness 0..1 for the wrist noise meter. */
  setLocalNoiseLevel(level: number): void;
  /** Short in-world message floating in front of the player (works in VR and on desktop). */
  showMessage(text: string, seconds?: number): void;
  render(): void;
}

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

export interface InputFrame {
  mode: 'xr' | 'desktop';
  /**
   * Locomotion intent relative to where the head is facing (yaw only):
   * x = strafe right (+) / left (-), y = forward (+) / back (-). Magnitude 0..1.
   */
  move: { x: number; y: number };
  sprint: boolean;
  sneak: boolean;
  /** World-space head pose (already includes the rig transform). */
  head: HeadPose;
  /** World-space hand poses in the canonical hand frame (see HandPose in core/types). */
  left: HandPose;
  right: HandPose;
  /** Grip/squeeze currently held. */
  grip: Record<Handedness, boolean>;
  /** Grip pressed this frame (edge). */
  gripPressed: Record<Handedness, boolean>;
  /** Grip released this frame (edge). */
  gripReleased: Record<Handedness, boolean>;
  /** Trigger pressed this frame (edge). */
  triggerPressed: Record<Handedness, boolean>;
  /**
   * Desktop only: the "use" key (E) was pressed this frame. The game loop treats it as
   * grab-nearest-or-release for the right hand.
   */
  usePressed: boolean;
  /** Menu button / Escape pressed this frame. */
  menuPressed: boolean;
}

export interface IInputManager {
  readonly mode: 'xr' | 'desktop';
  /**
   * Read all devices for this frame. Applies ROTATION itself (desktop mouse-look: rig yaw + camera
   * pitch; VR: snap turn around the head). Translation is applied by the game loop (it needs
   * collision), using `move`.
   */
  update(dt: number): InputFrame;
  /** Desktop: enable/disable mouse look + keys (disabled while menus are open). */
  setEnabled(enabled: boolean): void;
}

// ---------------------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------------------

export interface IAudioManager {
  /** Must be called from a user gesture. Creates/resumes the AudioContext. Safe to call twice. */
  unlock(): Promise<void>;
  /**
   * Ask for the microphone (echoCancellation/noiseSuppression on). Returns the raw stream to send
   * to other players as voice, or null if denied/unavailable. Starts the loudness meter.
   */
  startMic(): Promise<MediaStream | null>;
  /** Mic sensitivity offset in dB, about -15..+15 (players' mics differ a lot). */
  setMicSensitivity(db: number): void;
  /** Level geometry, so walls can muffle the monster and voices in other rooms (null = none). */
  setLevel(level: LevelData | null): void;
  /** Smoothed local mic loudness 0..1 using the MIC config mapping. 0 below MIC.gate or without a mic. */
  getMicLevel(): number;
  /** Spatialize another player's voice. */
  addRemoteVoice(peerId: PlayerId, stream: MediaStream): void;
  removeRemoteVoice(peerId: PlayerId): void;
  /**
   * Per-frame update: listener = local head, remote voices follow remote heads, monster sounds
   * (breathing, heavy footsteps synced to monster.speed, growls by alert) positioned at the
   * monster, heartbeat that speeds up as the monster gets close, remote players' footsteps
   * derived from their head movement, low ambient drone.
   */
  update(state: WorldState, localId: PlayerId, head: HeadPose, dt: number): void;
  /** One-shot sounds for sim events (flash, dry click, pickup, fuse, door, alert, caught, win/lose...). */
  playEvent(event: SimEvent, localId: PlayerId): void;
  /** Local player's own footstep (the game loop decides when). */
  playFootstep(position: Vec3, loudness: number): void;
}
