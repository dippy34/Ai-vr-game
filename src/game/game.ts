/**
 * The game loop: reads input, moves the local player (with collision), turns grips/triggers into
 * actions, makes footstep/voice noise, and feeds the Session's state to the renderer and audio.
 *
 * This file is web glue (it knows about the three.js rig), but all game RULES live in src/core.
 */

import * as THREE from 'three';
import { GAME, NET, NOISE, PLAYER } from '../config';
import { add3, dist3, forwardFromYaw, rotate3, v3, yawFromQuat } from '../core/math';
import { moveCircle, pushOut } from '../core/physics';
import type {
  Handedness,
  HeldRef,
  PlayerPose,
  PlayerState,
  SimEvent,
  Vec3,
  WorldState,
} from '../core/types';
import type { IAudioManager, IGameRenderer, IInputManager, InputFrame } from '../platform/types';
import type { UI } from '../ui/ui';
import type { Session } from './session';

const HANDS: Handedness[] = ['left', 'right'];

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
  private paused = false;
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
    this.roundEndedAt = -1;

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

    this.localPose = { head: frame.head, left: frame.left, right: frame.right };
    if (!this.paused) this.locomote(frame, dt, state);
    this.footsteps(frame, dt, state, me);
    if (!this.paused) this.interact(frame, state, me);

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
    this.renderer.update(session.state, session.localId, this.localPose, dt);
    this.audio.update(session.state, session.localId, this.localPose.head, dt);
    this.renderer.render();
  }

  private locomote(frame: InputFrame, dt: number, state: WorldState): void {
    const session = this.session!;
    const rig = this.renderer.ctx.rig;
    const head = frame.head.position;
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
    const moved = moveCircle(session.level, head, delta, PLAYER.radius, opts);
    // Also undo real-world walking into walls (room-scale VR).
    const corr = pushOut(session.level, moved, PLAYER.radius, opts);
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
        if (frame.triggerPressed[hand]) {
          if (canPlay && held[hand]?.kind === 'camera') {
            const dir = rotate3(hp.rotation, v3(0, 0, -1));
            session.sendAction({ type: 'flash', hand, position: hp.position, direction: dir });
          } else {
            this.maybeStartRound(state);
          }
        }
      }
      return;
    }

    // ---- desktop ----
    const look = this.lookDirection();
    if (frame.usePressed && canPlay) this.desktopUse(state, held, look);
    if (frame.triggerPressed.left || frame.triggerPressed.right) {
      const camHand: Handedness | null =
        held.left?.kind === 'camera' ? 'left' : held.right?.kind === 'camera' ? 'right' : null;
      if (canPlay && camHand) {
        session.sendAction({ type: 'flash', hand: camHand, position: pose[camHand].position, direction: look });
      } else {
        this.maybeStartRound(state);
      }
    }
  }

  /** Host: trigger/click with nothing to flash starts the round (lobby) or the next one (after an ending). */
  private maybeStartRound(state: WorldState): void {
    const session = this.session!;
    if (!session.isHost) return;
    if (state.phase === 'lobby') session.startRound();
    else if ((state.phase === 'won' || state.phase === 'lost') && this.roundEndedAt >= 0) {
      if (performance.now() / 1000 - this.roundEndedAt >= GAME.roundEndDelay) session.startRound();
    }
  }

  /** Desktop E: grab the nearest thing in reach with a free hand, otherwise drop something. */
  private desktopUse(state: WorldState, held: Record<Handedness, HeldRef | null>, look: Vec3): void {
    const session = this.session!;
    const head = this.localPose.head.position;
    const probe = add3(head, { x: look.x * 0.5, y: look.y * 0.5, z: look.z * 0.5 });
    const reach = PLAYER.desktopGrabReach;

    let nearest = Infinity;
    if (!state.camera.holder) nearest = Math.min(nearest, dist3(probe, state.camera.position));
    for (const item of state.items) {
      if (item.where === 'world') nearest = Math.min(nearest, dist3(probe, item.position));
    }
    // The left hand carries things on desktop; the right hand does the signing.
    const free: Handedness | null = !held.left ? 'left' : !held.right ? 'right' : null;
    if (nearest <= reach && free) {
      session.sendAction({ type: 'grab', hand: free, position: probe, reach });
      return;
    }
    const drop: Handedness | null =
      held.left?.kind === 'item' ? 'left' : held.right?.kind === 'item' ? 'right' : held.left ? 'left' : held.right ? 'right' : null;
    if (drop) {
      const at = v3(head.x + look.x * 0.6, Math.max(0, head.y - 0.9), head.z + look.z * 0.6);
      session.sendAction({ type: 'release', hand: drop, position: at });
    }
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
      case 'flash':
        this.renderer.flash(e, session.state, localId, this.localPose);
        break;
      case 'dryFire':
        if (e.by === localId) this.message(session.state.camera.film <= 0 ? 'Out of film.' : '…');
        break;
      case 'pickup':
        if (e.by === localId) {
          if (e.what === 'camera') this.message(`Camera. Trigger to flash. Film: ${session.state.camera.film}`);
          else if (e.what === 'fuse') this.message('A fuse. Take it to the fuse box by the front door.');
        }
        break;
      case 'filmLoaded':
        if (e.by === localId) this.message(`+${e.amount} film (${e.total} shots)`);
        break;
      case 'fuseInserted':
        this.message(`Fuse ${e.count} of ${e.required}`);
        break;
      case 'exitOpened':
        this.message('The front door is open. RUN.', 4);
        break;
      case 'playerCaught':
        this.message(e.id === localId ? 'It found you.' : `${nameOf(e.id)} was taken.`, 4);
        break;
      case 'playerEscaped':
        this.message(e.id === localId ? 'You got out.' : `${nameOf(e.id)} got out.`, 4);
        break;
      case 'phase':
        if (e.phase === 'playing') {
          this.roundEndedAt = -1;
          this.message('Find the fuses. Stay quiet.', 4);
        } else if (e.phase === 'won' || e.phase === 'lost') {
          this.roundEndedAt = performance.now() / 1000;
          this.message(e.phase === 'won' ? 'You escaped.' : 'Nobody made it out.', 5);
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
      lines.push(`Film: ${state.camera.film} shots`);
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
    else this.ui.hud.showMessage(text, seconds);
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
    const holdsCamera = me?.held.left?.kind === 'camera' || me?.held.right?.kind === 'camera';
    this.ui.hud.setFilm(holdsCamera ? state.camera.film : null);
  }
}
