/**
 * MUTE audio: 100% procedural WebAudio (no asset files).
 *
 * Graph:   world bus (spatial sfx, monster, ambience) -> lowpass -> duck --\
 *          voice bus (remote players)                 -> lowpass -> duck ---> master -> compressor -> out
 *          ui/body bus (heartbeat, stings, chords) ------------------------/
 * When the local player is caught the world bus is muffled + ducked ("ghost hearing") until the
 * next round starts.
 *
 * Every public method is a safe no-op until unlock() has created a running AudioContext, and in
 * environments without WebAudio / getUserMedia (node tests, old browsers). update() and
 * playEvent() never throw.
 */

import { PLAYER } from '../../config';
import { dist3, distXZ } from '../../core/math';
import { wallsBetween } from '../../core/physics';
import type { GamePhase, HeadPose, LevelData, PlayerId, SimEvent, Vec3, WorldState } from '../../core/types';
import type { IAudioManager } from '../types';
import { headVectors, heartbeatIntensity } from './audioMath';
import { Ambience } from './ambience';
import { SPATIAL, approach, buildEngine, createAudioContext, setListenerPose, type Engine } from './engine';
import { Heartbeat } from './heartbeat';
import { MicInput } from './mic';
import { MonsterAudio } from './monster';
import { RemotePlayers } from './remote';
import {
  sfxCaughtSting,
  sfxDrop,
  sfxDryFire,
  sfxExitDoor,
  sfxFuse,
  sfxLose,
  sfxPickup,
  sfxRatchet,
  sfxRelief,
  sfxRoundStart,
  sfxScream,
  sfxShutter,
  sfxWin,
  sfxWoodStep,
} from './sfx';

/** Ghost hearing: world bus lowpass (Hz) and gain while the local player is caught. */
const GHOST = { worldLp: 650, worldGain: 0.42, voiceLp: 2800, voiceGain: 0.85 } as const;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | void> =>
  Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, ms))]);

export class AudioManager implements IAudioManager {
  private eng: Engine | null = null;
  private monster: MonsterAudio | null = null;
  private ambience: Ambience | null = null;
  private heart: Heartbeat | null = null;
  private remotes: RemotePlayers | null = null;
  private readonly mic = new MicInput();
  private readonly pendingVoices = new Map<PlayerId, MediaStream>();
  private unlocking: Promise<void> | null = null;
  private gestureHooked = false;
  private ghost = false;
  /** After a round-start event, ignore a stale "caught" status from the previous round briefly. */
  private ghostHoldoffUntil = 0;
  private phase: GamePhase | null = null;
  private listener: Vec3 = { x: 0, y: PLAYER.eyeHeight, z: 0 };
  private warned = false;
  private level: LevelData | null = null;

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  unlock(): Promise<void> {
    if (this.eng && this.eng.ctx.state === 'running') return Promise.resolve();
    if (!this.unlocking) {
      this.unlocking = this.doUnlock().finally(() => {
        this.unlocking = null;
      });
    }
    return this.unlocking;
  }

  private async doUnlock(): Promise<void> {
    try {
      if (!this.eng) {
        const ctx = createAudioContext();
        if (!ctx) return;
        // resume() first, synchronously inside the user gesture, before building anything.
        const resuming = ctx.state === 'running' ? Promise.resolve() : ctx.resume().catch(() => undefined);
        const eng = buildEngine(ctx);
        this.eng = eng;
        this.monster = new MonsterAudio(eng);
        this.ambience = new Ambience(eng);
        this.heart = new Heartbeat(eng);
        this.remotes = new RemotePlayers(eng);
        this.mic.attach(ctx);
        for (const [id, stream] of this.pendingVoices) this.remotes.addVoice(id, stream);
        this.pendingVoices.clear();
        ctx.addEventListener?.('statechange', () => {
          if (ctx.state !== 'running' && ctx.state !== 'closed') this.hookGestureResume();
        });
        await withTimeout(resuming, 2000);
      } else if (this.eng.ctx.state !== 'running' && this.eng.ctx.state !== 'closed') {
        await withTimeout(this.eng.ctx.resume().catch(() => undefined), 2000);
      }
      if (this.eng && this.eng.ctx.state !== 'running') this.hookGestureResume();
    } catch (err) {
      this.warn('unlock failed', err);
    }
  }

  /** If the context is (or becomes) suspended, resume it on the next user gesture / when visible again. */
  private hookGestureResume(): void {
    if (this.gestureHooked || typeof window === 'undefined' || !this.eng) return;
    this.gestureHooked = true;
    const ctx = this.eng.ctx;
    const events = ['pointerdown', 'keydown', 'touchend', 'click'] as const;
    const tryResume = () => {
      if (ctx.state === 'running' || ctx.state === 'closed') return cleanup();
      ctx.resume().then(() => { if (ctx.state === 'running') cleanup(); }).catch(() => undefined);
    };
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') tryResume();
    };
    const cleanup = () => {
      for (const e of events) window.removeEventListener(e, tryResume, true);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      this.gestureHooked = false;
    };
    for (const e of events) window.addEventListener(e, tryResume, true);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  }

  /** The engine, only while the AudioContext is actually running (otherwise sounds would pile up). */
  private live(): Engine | null {
    const e = this.eng;
    return e && e.ctx.state === 'running' ? e : null;
  }

  // -------------------------------------------------------------------------------------------
  // Mic
  // -------------------------------------------------------------------------------------------

  async startMic(): Promise<MediaStream | null> {
    try {
      const stream = await this.mic.start();
      if (stream && this.eng) this.mic.attach(this.eng.ctx);
      return stream;
    } catch (err) {
      this.warn('startMic failed', err);
      return null;
    }
  }

  getMicLevel(): number {
    try {
      return this.mic.poll(!!this.live());
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------------------------

  addRemoteVoice(peerId: PlayerId, stream: MediaStream): void {
    try {
      if (!stream) return;
      if (this.remotes) this.remotes.addVoice(peerId, stream);
      else this.pendingVoices.set(peerId, stream); // wired up on unlock()
    } catch (err) {
      this.warn('addRemoteVoice failed', err);
    }
  }

  removeRemoteVoice(peerId: PlayerId): void {
    try {
      this.pendingVoices.delete(peerId);
      this.remotes?.removeVoice(peerId);
    } catch (err) {
      this.warn('removeRemoteVoice failed', err);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Per frame
  // -------------------------------------------------------------------------------------------

  /** Mic sensitivity offset in dB (players' mics differ; see the lobby slider). */
  setMicSensitivity(db: number): void {
    this.mic.setSensitivity(db);
  }

  /** The level geometry, so walls can muffle the monster and voices in other rooms. */
  setLevel(level: LevelData | null): void {
    this.level = level;
  }

  update(state: WorldState, localId: PlayerId, head: HeadPose, dt: number): void {
    const e = this.live();
    try {
      this.mic.poll(!!e);
      if (!e || !state || !head) return;
      const now = e.ctx.currentTime;
      const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
      e.pool.sweep(now);

      const { forward, up } = headVectors(head.rotation);
      setListenerPose(e.ctx.listener, head.position, forward, up);
      this.listener = { x: head.position.x, y: head.position.y, z: head.position.z };

      if (state.phase !== this.phase) {
        if (state.phase === 'playing' || state.phase === 'lobby') this.setGhost(false, now);
        this.phase = state.phase;
      }
      const me = state.players?.[localId];
      const status = me?.status ?? 'alive';
      if (status === 'caught' && !this.ghost && state.phase !== 'lobby' && performanceNow() > this.ghostHoldoffUntil) {
        this.setGhost(true, now);
      }

      const m = state.monster;
      const fear = m && state.phase === 'playing' ? heartbeatIntensity(distXZ(head.position, m.position), m.alert) : 0;
      const level = this.level;
      const opts = { exitOpen: !!state.exitOpen };
      const wallsTo = (p: Vec3): number => (level ? wallsBetween(level, this.listener, p, opts) : 0);
      if (m) this.monster?.setOcclusion(wallsTo({ x: m.position.x, y: m.position.y + 2, z: m.position.z }), now);
      this.monster?.update(state, step, now);
      this.heart?.update(state.phase === 'playing' && status === 'alive' && !this.ghost, fear, step, now);
      this.remotes?.update(state, localId, this.listener, step, now, this.ghost, wallsTo);
      this.ambience?.update(this.listener, now, fear);
    } catch (err) {
      this.warn('update failed', err);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------------------------

  playEvent(event: SimEvent, localId: PlayerId): void {
    const e = this.live();
    if (!e || !event) return;
    try {
      const t = e.ctx.currentTime + 0.01;
      const pool = e.pool;
      switch (event.type) {
        case 'flash': {
          const s = pool.spatial(event.position, SPATIAL.prop, 2);
          if (s) sfxShutter(s, t);
          break;
        }
        case 'dryFire': {
          const s = pool.spatial(event.position, SPATIAL.prop, 1);
          if (s) sfxDryFire(s, t);
          break;
        }
        case 'pickup': {
          const s = pool.spatial(event.position, SPATIAL.prop, 1);
          if (s) sfxPickup(s, t, event.what);
          break;
        }
        case 'drop': {
          const s = pool.spatial(event.position, SPATIAL.prop, 1);
          if (s) sfxDrop(s, t, event.what);
          break;
        }
        case 'filmLoaded': {
          const s = pool.spatial(event.position, SPATIAL.prop, 1);
          if (s) sfxRatchet(s, t);
          break;
        }
        case 'fuseInserted': {
          const s = pool.spatial(event.position, SPATIAL.prop, 2);
          if (s) sfxFuse(s, t, event.count >= event.required);
          break;
        }
        case 'exitOpened': {
          const s = pool.spatial(event.position, SPATIAL.loud, 3);
          if (s) sfxExitDoor(s, t);
          break;
        }
        case 'monsterAlert':
          this.monster?.onAlert(event.mode, event.position);
          break;
        case 'playerCaught': {
          if (event.id === localId) {
            const s = pool.begin(e.ui, 4);
            if (s) sfxCaughtSting(s, t);
            this.setGhost(true, t + 0.35);
          } else {
            const s = pool.spatial(event.position, { ref: 2.5, rolloff: 0.9 }, 2);
            if (s) sfxScream(s, t, 0.6);
          }
          break;
        }
        case 'playerEscaped': {
          const s = pool.begin(e.ui, 2);
          if (s) sfxRelief(s, t, event.id === localId ? 0.07 : 0.045);
          break;
        }
        case 'phase': {
          if (event.phase === 'playing') {
            this.setGhost(false, t);
            this.ghostHoldoffUntil = performanceNow() + 1500;
            this.heart?.reset();
            const s = pool.begin(e.ui, 3);
            if (s) sfxRoundStart(s, t);
          } else if (event.phase === 'won') {
            const s = pool.begin(e.ui, 4);
            if (s) sfxWin(s, t);
          } else if (event.phase === 'lost') {
            const s = pool.begin(e.ui, 4);
            if (s) sfxLose(s, t);
          } else if (event.phase === 'lobby') {
            this.setGhost(false, t);
          }
          break;
        }
      }
    } catch (err) {
      this.warn('playEvent failed', err);
    }
  }

  playFootstep(position: Vec3, loudness: number): void {
    const e = this.live();
    if (!e || !position) return;
    try {
      const t = e.ctx.currentTime + 0.005;
      const l = Number.isFinite(loudness) ? Math.max(0, loudness) : 0;
      // Your own feet are right under you: non-spatial (cheaper, and HRTF straight-down is odd).
      // Only spatialize if the game passes a position clearly away from the listener.
      const s = dist3(position, this.listener) > 2.5 ? e.pool.spatial(position, SPATIAL.prop, 1) : e.pool.begin(e.world, 1);
      if (!s) return;
      s.out.gain.value = 0.25;
      sfxWoodStep(s, t, l);
    } catch (err) {
      this.warn('playFootstep failed', err);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private setGhost(on: boolean, at: number): void {
    const e = this.eng;
    if (!e || on === this.ghost) return;
    this.ghost = on;
    const tau = on ? 0.35 : 0.5;
    approach(e.worldLp.frequency, on ? GHOST.worldLp : e.nyquistSafe, at, tau);
    approach(e.worldDuck.gain, on ? GHOST.worldGain : 1, at, tau);
    approach(e.voiceLp.frequency, on ? GHOST.voiceLp : e.nyquistSafe, at, tau);
    approach(e.voiceDuck.gain, on ? GHOST.voiceGain : 1, at, tau);
  }

  private warn(msg: string, err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[audio] ${msg}:`, err);
  }
}

function performanceNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
