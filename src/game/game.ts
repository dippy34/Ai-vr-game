/**
 * The game loop: reads input, moves the local player (with collision), turns grips/triggers into
 * actions, makes footstep/voice noise, and feeds the Session's state to the renderer and audio.
 *
 * This file is web glue (it knows about the three.js rig), but all game RULES live in src/core.
 */

import * as THREE from 'three';
import { GAME, LIGHT, NET, NOISE, PLAYER } from '../config';
import { add3, dist3, forwardFromYaw, v3, yawFromQuat } from '../core/math';
import { moveCircle, pushOut, wallsBetween } from '../core/physics';
import type {
  Handedness,
  HeldRef,
  PlayerPose,
  PlayerState,
  SimEvent,
  Vec3,
  WorldState,
} from '../core/types';
import type { IAudioManager, IGameRenderer, IInputManager, InputFrame, Readable } from '../platform/types';
import type { UI } from '../ui/ui';
import type { Session } from './session';

const HANDS: Handedness[] = ['left', 'right'];

/**
 * Desktop reading: aim at a note within `reach` (m), at most `aim` rad off the crosshair, press
 * E, and the eyes lean in `above` m over it looking down at `pitch` (what a VR player does with
 * their real head). E again, moving or the menu stands you back up.
 */
const READ = { reach: 1.9, aim: 0.2, above: 0.3, pitch: -1.35, wallDistance: 0.32, wallPitch: -0.06 } as const;

/** What desktop E would do right now. */
type UseTarget =
  | { kind: 'read'; note: Readable }
  | { kind: 'grab'; hand: Handedness; probe: Vec3 }
  | { kind: 'drop'; hand: Handedness }
  | null;

/** Angle (rad) between the view direction `look` and the direction from `eye` to `p`. */
function aimAngle(eye: Vec3, look: Vec3, p: Vec3): number {
  const v = { x: p.x - eye.x, y: p.y - eye.y, z: p.z - eye.z };
  const l = Math.hypot(v.x, v.y, v.z);
  if (l < 1e-6) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (v.x * look.x + v.y * look.y + v.z * look.z) / l)));
}

function defaultPose(): PlayerPose {
  const hand = () => ({
    tracked: false,
    position: v3(0, 1, 0),
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    curls: [0.3, 0.3, 0.3, 0.3, 0.3] as [number, number, number, number, number],
  });
  return {
    head: { position: v3(0, PLAYER.eyeHeight, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } },
    left: hand(),
    right: hand(),
  };
}

function shiftPose(pose: PlayerPose, dx: number, dz: number): PlayerPose {
  const s = (p: Vec3): Vec3 => ({ x: p.x + dx, y: p.y, z: p.z + dz });
  return {
    head: { position: s(pose.head.position), rotation: pose.head.rotation },
    left: { ...pose.left, position: s(pose.left.position) },
    right: { ...pose.right, position: s(pose.right.position) },
  };
}

export class Game {
  private session: Session | null = null;
  private micStream: MediaStream | null = null;
  private localPose: PlayerPose = defaultPose();

  private lastTime = 0;
  private voiceTimer = 0;
  private lastVoiceSent = 0;
  private stepAccum = 0;
  private lastHead: Vec3 | null = null;
  private promptTimer = 0;
  private roundEndedAt = -1;
  /** For the end-of-round summary. */
  private roundStartedAt = -1;
  /** Times the local player wound their light this round (for the round summary). */
  private roundWinds = 0;
  /**
   * Local prediction of the Crank Light: the switch you just flipped (until the host's state
   * agrees, or a second passes) and whether you are winding, so the beam reacts instantly.
   */
  private lightWant: { on: boolean; at: number } | null = null;
  private cranking = false;
  /** The "your light is dying" hint was shown (once per charge-up). */
  private lowLightHinted = false;
  private paused = false;
  /** Desktop: the note we are leaning in over (READ), else null. */
  private reading: Readable | null = null;
  /** A desktop HUD message waiting for the renderer to let go of the screen (see message()). */
  private heldMessage: { text: string; seconds: number } | null = null;
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();

  /** Called when the desktop player opens the menu (Esc). */
  onMenu: () => void = () => {};
  /** Called when the session drops (host left, kicked...). */
  onDisconnected: (reason: string) => void = () => {};

  constructor(
    private readonly renderer: IGameRenderer,
    private readonly input: IInputManager,
    private readonly audio: IAudioManager,
    private readonly ui: UI,
  ) {
    renderer.ctx.renderer.setAnimationLoop((t) => this.frame(t));
  }

  get current(): Session | null {
    return this.session;
  }

  setMicStream(stream: MediaStream | null): void {
    this.micStream = stream;
    this.session?.voice?.setLocalStream(stream);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  attach(session: Session): void {
    this.detach();
    this.session = session;
    this.renderer.loadLevel(session.level);
    this.audio.setLevel(session.level);
    // Per-session bookkeeping. Joining a round already in progress (or already over) starts the
    // clocks now rather than leaving them at "never" from the previous session.
    const now = performance.now() / 1000;
    const phase = session.state.phase;
    this.roundStartedAt = phase === 'playing' ? now : -1;
    this.roundEndedAt = phase === 'won' || phase === 'lost' ? now : -1;
    this.roundWinds = 0;
    this.lightWant = null;
    this.cranking = false;
    this.lastPhase = '';

    session.callbacks = {
      onEvent: (e) => this.onEvent(e),
      onRemotePose: (id, pose) => this.renderer.setRemotePose(id, pose),
      onRound: (state) => this.onRound(state),
      onLobby: (players) => this.ui.setLobbyPlayers(players, session.localId),
      onDisconnected: (reason) => this.onDisconnected(reason),
    };

    if (session.voice) {
      session.voice.onRemoteStream((id, stream) => this.audio.addRemoteVoice(id, stream));
      session.voice.onRemoteStreamEnded((id) => this.audio.removeRemoteVoice(id));
      session.voice.setLocalStream(this.micStream);
    }

    this.placeAtSpawn(session.state);
  }

  detach(): void {
    if (!this.session) return;
    for (const id of Object.keys(this.session.state.players)) this.audio.removeRemoteVoice(id);
    this.session.close();
    this.session = null;
    this.heldMessage = null;
    this.stopReading();
    this.audio.setLevel(null);
  }

  /** Host only. */
  startRound(): void {
    if (this.session?.isHost) this.session.startRound();
  }

  // -------------------------------------------------------------------------------------------

  private frame(timeMs: number): void {
    const dt = this.lastTime ? Math.min(0.1, Math.max(0, (timeMs - this.lastTime) / 1000)) : 1 / 60;
    this.lastTime = timeMs;

    const frame = this.input.update(dt);
    const session = this.session;
    const micLevel = this.audio.getMicLevel();
    this.ui.setMicLevel(micLevel);

    if (!session) {
      this.renderer.render();
      return;
    }

    if (frame.menuPressed && frame.mode === 'desktop' && !this.paused) this.onMenu();
    if (frame.menuPressed && frame.mode === 'xr') this.statusCard(session);

    const state = session.state;
    const me = state.players[session.localId];
    if (this.reading) {
      const moving = Math.hypot(frame.move.x, frame.move.y) > 0.1;
      if (moving || frame.menuPressed || frame.mode !== 'desktop' || state.phase !== 'playing' || me?.status !== 'alive') {
        this.stopReading();
      }
    }

    this.localPose = { head: frame.head, left: frame.left, right: frame.right };
    if (!this.paused) this.locomote(frame, dt, state);
    this.footsteps(frame, dt, state, me);
    if (!this.paused) this.interact(frame, state, me);
    this.updateLight(this.paused ? null : frame, state, me);

    // network
    session.sendPose(this.localPose);
    this.voiceTimer += dt;
    if (this.voiceTimer >= 1 / NET.voiceRate) {
      this.voiceTimer = 0;
      // Only send while there's something to say (plus one 0 to settle).
      if (micLevel > 0 || this.lastVoiceSent > 0) session.sendVoice(micLevel);
      this.lastVoiceSent = micLevel;
    }
    session.update(dt);

    this.prompts(dt, session.state, frame);
    this.updateHud(session.state, session.state.players[session.localId]);

    this.renderer.setLocalNoiseLevel(micLevel);
    this.renderer.setLocalLight(this.localLightOn(me), this.cranking);
    this.renderer.update(session.state, session.localId, this.localPose, dt);
    this.flushHeldMessage();
    this.audio.update(session.state, session.localId, this.localPose.head, dt);
    this.renderer.render();
  }

  private locomote(frame: InputFrame, dt: number, state: WorldState): void {
    const session = this.session!;
    const rig = this.renderer.ctx.rig;
    // A desktop lean (reading a note) moves only the eyes, over the table: collide with the body
    // under the normal eye point instead (on desktop that is the rig's own position).
    const head =
      frame.mode === 'desktop' && this.input.leaning ? v3(rig.position.x, frame.head.position.y, rig.position.z) : frame.head.position;
    const crouched = this.isCrouched(frame);
    const speed = frame.sprint ? PLAYER.sprintSpeed : crouched ? PLAYER.sneakSpeed : PLAYER.walkSpeed;

    let mx = frame.move.x;
    let my = frame.move.y;
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }
    const f = forwardFromYaw(yawFromQuat(frame.head.rotation));
    const right = { x: -f.z, z: f.x };
    const delta = v3((right.x * mx + f.x * my) * speed * dt, 0, (right.z * mx + f.z * my) * speed * dt);

    const opts = { exitOpen: state.exitOpen };
    // Caught players are ghosts: they drift through walls to watch the others.
    const ghost = state.phase === 'playing' && state.players[session.localId]?.status === 'caught';
    const moved = ghost ? add3(head, delta) : moveCircle(session.level, head, delta, PLAYER.radius, opts);
    // Also undo real-world walking into walls (room-scale VR).
    const corr = ghost ? v3() : pushOut(session.level, moved, PLAYER.radius, opts);
    const dx = moved.x + corr.x - head.x;
    const dz = moved.z + corr.z - head.z;
    if (dx !== 0 || dz !== 0) {
      rig.position.x += dx;
      rig.position.z += dz;
      rig.updateMatrixWorld(true);
      this.localPose = shiftPose(this.localPose, dx, dz);
    }
  }

  private isCrouched(frame: InputFrame): boolean {
    if (frame.mode === 'desktop') return frame.sneak;
    return frame.head.position.y - this.renderer.ctx.rig.position.y < PLAYER.crouchThreshold;
  }

  /** Footstep sound + noise every NOISE.stepLength meters of head travel (stick or real walking). */
  private footsteps(frame: InputFrame, dt: number, state: WorldState, me: PlayerState | undefined): void {
    const head = this.localPose.head.position;
    const last = this.lastHead;
    this.lastHead = { ...head };
    if (!last || dt <= 0) return;
    if (this.input.leaning) return; // leaning in over a note, not walking
    const d = Math.hypot(head.x - last.x, head.z - last.z);
    if (d > 1) return; // teleport, not a step
    this.stepAccum += d;
    if (this.stepAccum < NOISE.stepLength) return;
    this.stepAccum = 0;

    const speed = d / dt;
    const crouched = this.isCrouched(frame);
    const loudness =
      crouched || speed < 1.2 ? NOISE.sneakStep : speed > 2.6 ? NOISE.sprintStep : NOISE.walkStep;
    const feet = v3(head.x, this.renderer.ctx.rig.position.y, head.z);
    this.audio.playFootstep(feet, loudness);
    if (state.phase === 'playing' && me?.status === 'alive') {
      this.session!.sendNoise({ source: 'footstep', position: feet, loudness, playerId: me.id });
    }
  }

  private interact(frame: InputFrame, state: WorldState, me: PlayerState | undefined): void {
    const session = this.session!;
    const pose = this.localPose;
    const held: Record<Handedness, HeldRef | null> = me?.held ?? { left: null, right: null };
    const canPlay = state.phase === 'playing' && me?.status === 'alive';

    if (frame.mode === 'xr') {
      for (const hand of HANDS) {
        const hp = pose[hand];
        if (canPlay && frame.gripPressed[hand] && !held[hand]) {
          session.sendAction({ type: 'grab', hand, position: hp.position, reach: PLAYER.vrGrabReach });
        }
        if (canPlay && frame.gripReleased[hand] && held[hand]) {
          session.sendAction({ type: 'release', hand, position: hp.position });
        }
        // (During play the left trigger is the light switch, see updateLight.)
        if (frame.triggerPressed[hand] && !canPlay) this.maybeStartRound(state);
      }
      return;
    }

    // ---- desktop ----
    const look = this.lookDirection();
    const target = canPlay ? this.desktopUseTarget(state, held, look) : null;
    this.ui.hud.setAim(this.reading ? 'E · stand up' : target?.kind === 'read' ? 'E · read' : '', !!this.reading);
    if (frame.usePressed && canPlay) this.desktopUse(target);
    if ((frame.triggerPressed.left || frame.triggerPressed.right) && !canPlay) this.maybeStartRound(state);
  }

  /** The Crank Light: switch it, wind it (sent to the host), hint when it's dying. */
  private updateLight(frame: InputFrame | null, state: WorldState, me: PlayerState | undefined): void {
    const session = this.session!;
    const canPlay = state.phase === 'playing' && me?.status === 'alive';
    const crank = canPlay && !!frame?.crank;
    if (crank !== this.cranking) {
      this.cranking = crank;
      if (canPlay || !crank) session.sendAction({ type: 'crank', on: crank });
      if (crank) this.roundWinds++;
    }
    if (!canPlay || !me) {
      this.lightWant = null;
      return;
    }
    const now = performance.now() / 1000;
    if (this.lightWant && (this.lightWant.on === me.light.on || now - this.lightWant.at > 1)) this.lightWant = null;
    if (frame?.lightPressed) {
      const on = !this.localLightOn(me);
      this.lightWant = { on, at: now };
      session.sendAction({ type: 'light', on });
    }
    if (me.light.charge >= 0.5) this.lowLightHinted = false;
    else if (!this.lowLightHinted && me.light.charge < LIGHT.lowCharge && me.light.on && !this.cranking) {
      this.lowLightHinted = true;
      this.message(this.input.mode === 'xr' ? 'Your light is dying. Hold X (or shake it) to wind it. Winding is LOUD.' : 'Your light is dying. Hold R to wind it. Winding is LOUD.', 5);
    }
  }

  /** Is the local light on (your latest flip of the switch wins until the host catches up)? */
  private localLightOn(me: PlayerState | undefined): boolean {
    if (!me || me.status !== 'alive') return false;
    return this.lightWant ? this.lightWant.on : me.light.on;
  }

  /** Host: trigger/click outside play starts the round (lobby) or the next one (after an ending). */
  private maybeStartRound(state: WorldState): void {
    const session = this.session!;
    if (!session.isHost) return;
    if (state.phase === 'lobby') session.startRound();
    else if ((state.phase === 'won' || state.phase === 'lost') && this.roundEndedAt >= 0) {
      if (performance.now() / 1000 - this.roundEndedAt >= GAME.roundEndDelay) session.startRound();
    }
  }

  /**
   * Desktop E: stand back up if reading; else read the note in your sights (unless the thing you
   * would grab is more in the middle of your view), else grab the nearest thing in reach with a
   * free hand, else drop something.
   */
  private desktopUseTarget(state: WorldState, held: Record<Handedness, HeldRef | null>, look: Vec3): UseTarget {
    const head = this.localPose.head.position;
    const probe = add3(head, { x: look.x * 0.5, y: look.y * 0.5, z: look.z * 0.5 });
    const reach = PLAYER.desktopGrabReach;

    let nearest = Infinity;
    let nearestAt: Vec3 | null = null;
    const consider = (p: Vec3) => {
      const d = dist3(probe, p);
      if (d < nearest) {
        nearest = d;
        nearestAt = p;
      }
    };
    for (const item of state.items) if (item.where === 'world') consider(item.position);
    // The left hand carries things on desktop; the right hand does the signing.
    const free: Handedness | null = !held.left ? 'left' : !held.right ? 'right' : null;
    const grab = nearest <= reach && free && nearestAt ? { at: nearestAt as Vec3, hand: free } : null;

    const note = this.noteInSight(look);
    if (note && (!grab || note.angle < aimAngle(head, look, grab.at))) return { kind: 'read', note: note.note };
    if (grab) return { kind: 'grab', hand: grab.hand, probe };
    const drop: Handedness | null =
      held.left?.kind === 'item' ? 'left' : held.right?.kind === 'item' ? 'right' : held.left ? 'left' : held.right ? 'right' : null;
    return drop ? { kind: 'drop', hand: drop } : null;
  }

  private desktopUse(target: UseTarget): void {
    const session = this.session!;
    if (this.reading) {
      this.stopReading();
      return;
    }
    if (!target) return;
    const head = this.localPose.head.position;
    switch (target.kind) {
      case 'read':
        this.startReading(target.note);
        return;
      case 'grab':
        session.sendAction({ type: 'grab', hand: target.hand, position: target.probe, reach: PLAYER.desktopGrabReach });
        return;
      case 'drop': {
        const look = this.lookDirection();
        const at = v3(head.x + look.x * 0.6, Math.max(0, head.y - 0.9), head.z + look.z * 0.6);
        session.sendAction({ type: 'release', hand: target.hand, position: at });
        return;
      }
    }
  }

  /** The note closest to the crosshair within READ.reach / READ.aim (not through a wall). */
  private noteInSight(look: Vec3): { note: Readable; angle: number } | null {
    const session = this.session;
    if (!session) return null;
    const eye = this.localPose.head.position;
    let best: { note: Readable; angle: number } | null = null;
    for (const note of this.renderer.readables()) {
      if (dist3(eye, note.position) > READ.reach) continue;
      const angle = aimAngle(eye, look, note.position);
      if (angle > READ.aim || (best && angle >= best.angle)) continue;
      // Line of sight to a point just in front of it (a note pinned on a wall touches that wall).
      const d = dist3(eye, note.position);
      const k = Math.min(1, 0.08 / Math.max(d, 1e-6));
      const front = v3(
        note.position.x + (eye.x - note.position.x) * k,
        note.position.y + (eye.y - note.position.y) * k,
        note.position.z + (eye.z - note.position.z) * k,
      );
      if (wallsBetween(session.level, eye, front) > 0) continue;
      best = { note, angle };
    }
    return best;
  }

  private startReading(note: Readable): void {
    this.reading = note;
    const s = Math.sin(note.readYaw);
    const c = Math.cos(note.readYaw);
    if (note.upright) {
      // Pinned on a wall: eyes level with it, a hand's length in front.
      const d = READ.wallDistance;
      this.input.setLean({ position: v3(note.position.x + s * d, note.position.y, note.position.z + c * d), yaw: note.readYaw, pitch: READ.wallPitch });
      return;
    }
    // Lying flat: eyes over it, a little back so the downward view centers on it.
    const back = READ.above / Math.tan(-READ.pitch);
    const position = v3(note.position.x + s * back, note.position.y + READ.above, note.position.z + c * back);
    this.input.setLean({ position, yaw: note.readYaw, pitch: READ.pitch });
  }

  private stopReading(): void {
    if (!this.reading) return;
    this.reading = null;
    this.input.setLean(null);
  }

  private lookDirection(): Vec3 {
    const cam = this.renderer.ctx.camera;
    cam.getWorldQuaternion(this.tmpQ);
    this.tmpV.set(0, 0, -1).applyQuaternion(this.tmpQ);
    return v3(this.tmpV.x, this.tmpV.y, this.tmpV.z);
  }

  // -------------------------------------------------------------------------------------------

  private onEvent(e: SimEvent): void {
    const session = this.session;
    if (!session) return;
    const localId = session.localId;
    const nameOf = (id: string) => session.state.players[id]?.name ?? 'Someone';
    this.audio.playEvent(e, localId);

    switch (e.type) {
      case 'pickup':
        if (e.by === localId && e.what === 'fuse') this.message('A fuse. Take it to the fuse box by the front door.');
        break;
      case 'fuseInserted':
        this.message(`Fuse ${e.count} of ${e.required}`);
        break;
      case 'exitOpened':
        this.message('The front door is open. RUN.', 4);
        break;
      case 'playerCaught':
        this.renderer.caught(e, session.state, localId, this.localPose);
        this.message(e.id === localId ? 'It found you.' : `${nameOf(e.id)} was taken.`, 4);
        break;
      case 'playerEscaped':
        this.message(e.id === localId ? 'You got out.' : `${nameOf(e.id)} got out.`, 4);
        break;
      case 'phase':
        if (e.phase === 'playing') {
          this.roundEndedAt = -1;
          this.roundStartedAt = performance.now() / 1000;
          this.roundWinds = 0;
          this.lightWant = null;
          this.lowLightHinted = false;
          this.message(
            this.input.mode === 'xr'
              ? 'Find the fuses. Stay quiet.\nLeft trigger: light · hold X or shake it: wind it (loud)'
              : 'Find the fuses. Stay quiet.\nF: light · hold R: wind it (loud)',
            6,
          );
        } else if (e.phase === 'won' || e.phase === 'lost') {
          this.roundEndedAt = performance.now() / 1000;
          this.message(`${e.phase === 'won' ? 'You escaped.' : 'Nobody made it out.'}\n${this.roundSummary(session.state)}`, 6);
        }
        break;
      default:
        break;
    }
  }

  private onRound(state: WorldState): void {
    this.roundEndedAt = -1;
    this.placeAtSpawn(state);
  }

  /** Put the local rig so the head is at our spawn, facing the spawn yaw. */
  private placeAtSpawn(state: WorldState): void {
    this.stopReading();
    const me = this.session && state.players[this.session.localId];
    if (!me) return;
    const { rig, camera } = this.renderer.ctx;
    rig.updateMatrixWorld(true);
    const head = camera.getWorldPosition(new THREE.Vector3());
    camera.getWorldQuaternion(this.tmpQ);
    const headYaw = yawFromQuat({ x: this.tmpQ.x, y: this.tmpQ.y, z: this.tmpQ.z, w: this.tmpQ.w });
    const dYaw = me.spawnYaw - headYaw;

    // rotate the rig around the head, then slide it so the head sits over the spawn point
    rig.position.sub(head).applyAxisAngle(new THREE.Vector3(0, 1, 0), dYaw).add(head);
    rig.rotation.y += dYaw;
    rig.updateMatrixWorld(true);
    camera.getWorldPosition(head);
    rig.position.x += me.spawn.x - head.x;
    rig.position.z += me.spawn.z - head.z;
    rig.position.y = me.spawn.y;
    rig.updateMatrixWorld(true);

    this.lastHead = null;
    this.stepAccum = 0;
  }

  private roundSummary(state: WorldState): string {
    const secs = this.roundStartedAt >= 0 ? Math.max(0, Math.round(performance.now() / 1000 - this.roundStartedAt)) : 0;
    const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const players = Object.values(state.players);
    const out = players.filter((p) => p.status === 'escaped').length;
    return `${time} in the house · ${state.fusesInserted}/${state.fusesRequired} fuses · wound the light ${this.roundWinds}× · ${out}/${players.length} got out`;
  }

  /** VR menu button: there are no menus in the headset, so show where things stand. */
  private statusCard(session: Session): void {
    const state = session.state;
    const me = state.players[session.localId];
    const lines: string[] = [];
    if (state.phase === 'lobby') {
      lines.push(`${Object.keys(state.players).length} player(s) in the house`);
      lines.push(session.isHost ? 'Pull the trigger to start.' : 'Waiting for the host to start.');
    } else if (state.phase === 'playing') {
      lines.push(state.exitOpen ? 'The front door is OPEN.' : `Fuses ${state.fusesInserted} of ${state.fusesRequired}`);
      if (me?.status === 'alive') lines.push(`Light: ${Math.round(me.light.charge * 100)}%${me.light.on ? '' : ' (off)'}`);
      if (me?.status === 'caught') lines.push('You were caught. Spectating.');
    } else {
      lines.push(state.phase === 'won' ? 'Someone got out.' : 'Nobody got out.');
      if (session.isHost) lines.push('Pull the trigger to play again.');
    }
    if (session.roomCode) lines.push(`Room ${session.roomCode}`);
    this.message(lines.join('\n'), 5);
  }

  private message(text: string, seconds = 3): void {
    if (this.input.mode === 'xr') this.renderer.showMessage(text, seconds);
    // Not over the monster's face mid-catch: the HUD shows it once the renderer lets go.
    else if (this.renderer.holdingMessages()) this.heldMessage = { text, seconds };
    else this.ui.hud.showMessage(text, seconds);
  }

  private flushHeldMessage(): void {
    const m = this.heldMessage;
    if (!m || this.renderer.holdingMessages()) return;
    this.heldMessage = null;
    this.message(m.text, m.seconds);
  }

  /** Occasional reminders of what to do next (mostly for VR, where there are no menus). */
  private prompts(dt: number, state: WorldState, frame: InputFrame): void {
    this.promptTimer -= dt;
    if (this.promptTimer > 0) return;
    this.promptTimer = 7;
    const session = this.session!;
    const action = frame.mode === 'xr' ? 'Pull the trigger' : 'Click';
    if (state.phase === 'lobby') {
      this.message(session.isHost ? `${action} to start the round.` : 'Waiting for the host to start…', 4);
    } else if ((state.phase === 'won' || state.phase === 'lost') && this.roundEndedAt >= 0) {
      if (performance.now() / 1000 - this.roundEndedAt >= GAME.roundEndDelay) {
        this.message(session.isHost ? `${action} to play again.` : 'Waiting for the host…', 4);
      }
    } else {
      this.promptTimer = 1e9; // no nagging during play; reset when the phase changes
    }
  }

  private lastPhase = '';
  private updateHud(state: WorldState, me: PlayerState | undefined): void {
    if (state.phase !== this.lastPhase) {
      this.lastPhase = state.phase;
      this.promptTimer = 1.5;
    }
    const lines: string[] = [];
    if (state.phase === 'lobby') lines.push(`Lobby · ${Object.keys(state.players).length} player(s)`);
    else if (state.phase === 'playing') {
      lines.push(state.exitOpen ? 'EXIT OPEN. GET OUT.' : `Fuses ${state.fusesInserted} / ${state.fusesRequired}`);
      if (me?.status === 'caught') lines.push('You were caught · spectating');
      if (me?.status === 'escaped') lines.push('You escaped · waiting for the others');
    } else lines.push(state.phase === 'won' ? 'Escaped!' : 'Nobody made it out');
    this.ui.hud.setStatus(lines);
    const alive = state.phase === 'playing' && me?.status === 'alive';
    this.ui.hud.setLight(alive && me ? { charge: me.light.charge, on: this.localLightOn(me), cranking: this.cranking } : null);
  }
}
