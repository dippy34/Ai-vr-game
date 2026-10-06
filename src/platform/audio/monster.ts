/**
 * The monster's sound: a continuous wet, ragged breath (inhale/exhale envelopes scheduled ahead on
 * persistent nodes), heavy footsteps synced to its speed, echolocation clicks and sniffs while it
 * investigates, a growl / shriek on alerts and wet crunching while it feeds.
 * Two persistent HRTF panners follow it: one at head height (voice) and one at the floor (feet).
 */

import { GAME, MONSTER } from '../../config';
import { distXZ, forwardFromYaw } from '../../core/math';
import type { GamePhase, MonsterMode, Vec3, WorldState } from '../../core/types';
import { MONSTER_STRIDE, breathPeriod, occlusionMix, smoothFactor } from './audioMath';
import {
  SPATIAL,
  approach,
  chance,
  makePanner,
  rand,
  setPannerOrientation,
  setPannerPosition,
  type Engine,
} from './engine';
import { sfxCrunch, sfxGrowl, sfxMonsterClicks, sfxMonsterStep, sfxShriek, sfxSniff } from './sfx';

const HEAD_Y = MONSTER.height * 0.9;

export class MonsterAudio {
  private readonly head: PannerNode;
  private readonly feet: PannerNode;
  private readonly out: GainNode;
  /** Walls between the monster and the listener muffle it (lowpass + gain). */
  private readonly occLp: BiquadFilterNode;
  private readonly occGain: GainNode;
  private occWalls = -1;
  private readonly voiceIn: GainNode;

  private readonly airGain: GainNode;
  private readonly airBp: BiquadFilterNode;
  private readonly rattleGain: GainNode;
  private readonly rattleBp: BiquadFilterNode;
  private readonly rattleLfo: OscillatorNode;
  private readonly groanGain: GainNode;
  private readonly groanA: OscillatorNode;
  private readonly groanB: OscillatorNode;
  private readonly persistent: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];

  private pos: Vec3 | null = null;
  /** Sound is scheduled until this AudioContext time (Infinity while playing). */
  private activeUntil = 0;
  private lastPhase: GamePhase | null = null;
  private prevMode: MonsterMode | null = null;
  private stepAccum = MONSTER_STRIDE * 0.6;
  private nextBreath = 0;
  private nextIdle = 0;
  private feedUntil = 0;
  private nextCrunch = 0;
  private speed = 0;
  private alert = 0;
  private mode: MonsterMode = 'wander';

  constructor(private readonly eng: Engine) {
    const ctx = eng.ctx;
    this.out = this.keep(ctx.createGain());
    this.out.gain.value = 0;
    this.occLp = this.keep(ctx.createBiquadFilter());
    this.occLp.type = 'lowpass';
    this.occLp.frequency.value = eng.nyquistSafe;
    this.occGain = this.keep(ctx.createGain());
    this.out.connect(this.occLp).connect(this.occGain).connect(eng.world);

    this.head = this.keep(makePanner(ctx, { ...SPATIAL.monster, cone: [150, 300, 0.55] }));
    this.head.connect(this.out);
    this.feet = this.keep(makePanner(ctx, SPATIAL.monster));
    this.feet.connect(this.out);

    this.voiceIn = this.keep(ctx.createGain());
    this.voiceIn.gain.value = 1.5;
    this.voiceIn.connect(this.head);

    // Air: pink noise through a moving band (high on inhale, low on exhale).
    const air = this.loop('pink');
    this.airBp = this.keep(ctx.createBiquadFilter());
    this.airBp.type = 'bandpass';
    this.airBp.frequency.value = 700;
    this.airBp.Q.value = 1.1;
    this.airGain = this.keep(ctx.createGain());
    this.airGain.gain.value = 0;
    air.connect(this.airBp).connect(this.airGain).connect(this.voiceIn);

    // Wet rattle: white noise band, amplitude-chopped by a ~25 Hz sawtooth (vocal fry / phlegm).
    const wet = this.loop('white');
    this.rattleBp = this.keep(ctx.createBiquadFilter());
    this.rattleBp.type = 'bandpass';
    this.rattleBp.frequency.value = 1600;
    this.rattleBp.Q.value = 2.5;
    const am = this.keep(ctx.createGain());
    am.gain.value = 0.5;
    this.rattleLfo = this.keep(ctx.createOscillator());
    this.rattleLfo.type = 'sawtooth';
    this.rattleLfo.frequency.value = 24;
    const lfoDepth = this.keep(ctx.createGain());
    lfoDepth.gain.value = 0.5;
    this.rattleLfo.connect(lfoDepth).connect(am.gain);
    this.rattleGain = this.keep(ctx.createGain());
    this.rattleGain.gain.value = 0;
    wet.connect(this.rattleBp).connect(am).connect(this.rattleGain).connect(this.voiceIn);

    // Voiced groan under the exhale (more of it when agitated).
    this.groanA = this.keep(ctx.createOscillator());
    this.groanA.type = 'sawtooth';
    this.groanA.frequency.value = 70;
    this.groanB = this.keep(ctx.createOscillator());
    this.groanB.type = 'sawtooth';
    this.groanB.frequency.value = 72;
    const shaper = this.keep(ctx.createWaveShaper());
    shaper.curve = eng.curves.soft;
    const gbp = this.keep(ctx.createBiquadFilter());
    gbp.type = 'bandpass';
    gbp.frequency.value = 420;
    gbp.Q.value = 2.5;
    this.groanGain = this.keep(ctx.createGain());
    this.groanGain.gain.value = 0;
    this.groanA.connect(shaper);
    this.groanB.connect(shaper);
    shaper.connect(gbp).connect(this.groanGain).connect(this.voiceIn);

    const t = ctx.currentTime;
    for (const s of [this.rattleLfo, this.groanA, this.groanB]) {
      s.start(t);
      this.sources.push(s);
    }
  }

  private keep<T extends AudioNode>(n: T): T {
    this.persistent.push(n);
    return n;
  }

  private loop(kind: 'pink' | 'white' | 'brown'): AudioBufferSourceNode {
    const ctx = this.eng.ctx;
    const src = this.keep(ctx.createBufferSource());
    src.buffer = this.eng.noise[kind];
    src.loop = true;
    src.start(ctx.currentTime, Math.random() * src.buffer.duration);
    this.sources.push(src);
    return src;
  }

  /** Number of walls between the monster and the listener (from the level geometry). */
  setOcclusion(walls: number, now: number): void {
    const w = Math.min(3, Math.max(0, Math.floor(walls)));
    if (w === this.occWalls) return;
    const first = this.occWalls < 0;
    this.occWalls = w;
    const [g, lp] = occlusionMix(w, this.eng.nyquistSafe);
    approach(this.occGain.gain, g, now, first ? 0.01 : 0.12);
    approach(this.occLp.frequency, lp, now, first ? 0.01 : 0.12);
  }

  update(state: WorldState, dt: number, now: number): void {
    const m = state.monster;
    if (!m) return;

    // Audible during a round. After a round ends it keeps breathing/feeding for a few seconds
    // (the last catch still gets its crunch), then fades out and stops scheduling.
    if (state.phase !== this.lastPhase) {
      const was = this.lastPhase;
      this.lastPhase = state.phase;
      if (state.phase === 'playing') {
        approach(this.out.gain, 1, now, 0.3);
        if (was !== 'playing') {
          this.nextBreath = now + 0.3;
          this.nextIdle = now + rand(2, 5);
          this.stepAccum = MONSTER_STRIDE * 0.6;
          this.feedUntil = 0;
        }
        this.activeUntil = Infinity;
      } else if (state.phase === 'lobby') {
        approach(this.out.gain, 0, now, 0.2);
        this.activeUntil = 0;
        this.feedUntil = 0;
      } else {
        approach(this.out.gain, 0, now + 3, 1.0);
        this.activeUntil = was === 'playing' ? now + 7 : 0;
      }
    }

    // Smoothed position (snapshots arrive at ~12 Hz on clients).
    if (!this.pos || distXZ(this.pos, m.position) > 4) this.pos = { x: m.position.x, y: m.position.y, z: m.position.z };
    else {
      const k = smoothFactor(14, dt);
      this.pos.x += (m.position.x - this.pos.x) * k;
      this.pos.y += (m.position.y - this.pos.y) * k;
      this.pos.z += (m.position.z - this.pos.z) * k;
    }
    setPannerPosition(this.head, { x: this.pos.x, y: this.pos.y + HEAD_Y, z: this.pos.z });
    setPannerPosition(this.feet, { x: this.pos.x, y: this.pos.y + 0.05, z: this.pos.z });
    setPannerOrientation(this.head, forwardFromYaw(m.yaw));

    this.speed = Math.max(0, m.speed || 0);
    this.alert = m.alert || 0;
    this.mode = m.mode;

    if (m.mode !== this.prevMode) {
      if (m.mode === 'feeding') {
        this.feedUntil = now + GAME.feedingTime;
        this.nextCrunch = now + 0.15;
      }
      if (m.mode === 'chase' || this.prevMode === 'chase') this.hurryBreath(now, m.mode === 'chase' ? 1.3 : 0.3);
      this.prevMode = m.mode;
    }
    if (now >= this.activeUntil) return;

    // Breathing, scheduled slightly ahead.
    if (this.nextBreath < now - 1) this.nextBreath = now + 0.05;
    if (now + 0.2 >= this.nextBreath) this.nextBreath = this.scheduleBreath(Math.max(this.nextBreath, now + 0.01));

    // Footsteps: one heavy step per stride.
    if (this.speed > 0.12) {
      this.stepAccum += this.speed * dt;
      if (this.stepAccum >= MONSTER_STRIDE) {
        this.stepAccum = Math.min(this.stepAccum - MONSTER_STRIDE, MONSTER_STRIDE * 0.5);
        const weight = (this.speed - MONSTER.wanderSpeed) / (MONSTER.chaseSpeed - MONSTER.wanderSpeed);
        const drag = 1 - Math.min(1, this.speed / MONSTER.investigateSpeed);
        const shot = this.eng.pool.begin(this.feet, 1);
        if (shot) sfxMonsterStep(shot, now + 0.005, weight, drag);
      }
    } else {
      this.stepAccum = Math.min(this.stepAccum, MONSTER_STRIDE * 0.6);
    }

    // Idle vocalizations.
    if (now >= this.nextIdle) {
      if (m.mode === 'investigate') {
        const listening = this.speed < 0.2;
        const shot = this.eng.pool.begin(this.head, 1);
        if (shot) {
          if (chance(0.6)) sfxMonsterClicks(shot, now + 0.01);
          else sfxSniff(shot, now + 0.01);
        }
        this.nextIdle = now + (listening ? rand(1, 2.5) : rand(1.6, 4));
      } else if (m.mode === 'wander') {
        if (chance(0.5)) {
          const shot = this.eng.pool.begin(this.head, 0);
          if (shot) {
            if (chance(0.5)) sfxMonsterClicks(shot, now + 0.01);
            else sfxGrowl(shot, now + 0.01, rand(0.9, 1.4), 0.3);
          }
        }
        this.nextIdle = now + rand(7, 15);
      } else {
        this.nextIdle = now + rand(2, 4);
      }
    }

    // Feeding.
    if (now < this.feedUntil && now >= this.nextCrunch) {
      const shot = this.eng.pool.begin(this.head, 2);
      if (shot) sfxCrunch(shot, now + 0.01, rand(0.7, 1));
      this.nextCrunch = now + rand(0.45, 1.0);
    }
  }

  /** Alert event from the sim: growl when it starts investigating, shriek when it charges. */
  onAlert(mode: MonsterMode, position: Vec3): void {
    const now = this.eng.ctx.currentTime;
    if (!this.pos) {
      this.pos = { x: position.x, y: position.y, z: position.z };
      setPannerPosition(this.head, { x: position.x, y: position.y + HEAD_Y, z: position.z });
    }
    if (mode === 'chase') {
      const shot = this.eng.pool.begin(this.head, 3);
      if (shot) sfxShriek(shot, now + 0.01, 1);
      this.hurryBreath(now, 1.4);
    } else if (mode === 'investigate') {
      const shot = this.eng.pool.begin(this.head, 3);
      if (shot) sfxGrowl(shot, now + 0.01, rand(1.6, 2.1), 0.9);
      this.hurryBreath(now, 1.6);
      this.nextIdle = now + rand(2.5, 4);
    }
  }

  /** Drop the queued breath and start a new one soon (mode changes shouldn't wait for a slow exhale). */
  private hurryBreath(now: number, delay: number): void {
    const target = now + delay;
    if (this.nextBreath <= target) return;
    for (const p of [this.airGain.gain, this.rattleGain.gain, this.groanGain.gain]) {
      try {
        p.cancelScheduledValues(now);
        p.setTargetAtTime(0, now, 0.08);
      } catch { /* ignore */ }
    }
    try { this.airBp.frequency.cancelScheduledValues(now); } catch { /* ignore */ }
    this.nextBreath = target;
  }

  /** Schedules one inhale/hold/exhale cycle starting at t0. Returns when the next should start. */
  private scheduleBreath(t0: number): number {
    const a = Math.min(1, Math.max(0, this.alert));
    const mode = this.mode;
    const P = breathPeriod(a, mode);
    const loud = mode === 'chase' ? 1 : 0.55 + 0.45 * a;
    const air = this.airGain.gain;
    const bp = this.airBp.frequency;
    const rat = this.rattleGain.gain;
    const groan = this.groanGain.gain;

    const inDur = P * rand(0.32, 0.42);
    const gap = P * rand(0.04, 0.1);
    const exDur = P * rand(0.38, 0.5);
    const tEx = t0 + inDur + gap;

    // Inhale: airy, rising band; sometimes stuttered into 2-3 gasps (ragged).
    bp.setTargetAtTime(rand(1300, 1900), t0, inDur * 0.4);
    if (inDur > 0.45 && chance(0.3)) {
      const k = chance(0.5) ? 2 : 3;
      const seg = inDur / k;
      for (let i = 0; i < k; i++) {
        air.setTargetAtTime(0.32 * loud, t0 + i * seg, 0.03);
        air.setTargetAtTime(0.04 * loud, t0 + i * seg + seg * 0.6, 0.03);
      }
    } else {
      air.setTargetAtTime(0.3 * loud * rand(0.8, 1.1), t0, inDur * 0.3);
    }
    rat.setTargetAtTime(0.05 + 0.25 * a, t0, 0.1);

    // Held breath.
    air.setTargetAtTime(0.015, t0 + inDur, 0.04);
    rat.setTargetAtTime(0, t0 + inDur, 0.04);

    // Exhale: lower, louder, wet rattle and a voiced groan that falls in pitch.
    bp.setTargetAtTime(rand(520, 800), tEx, 0.05);
    bp.setTargetAtTime(rand(380, 520), tEx + exDur * 0.3, exDur * 0.5);
    air.setTargetAtTime(0.55 * loud * rand(0.8, 1.15), tEx, 0.05);
    air.setTargetAtTime(0, tEx + exDur * 0.35, exDur * 0.3);
    rat.setTargetAtTime(rand(0.6, 1.4) * (0.5 + a), tEx, 0.06);
    rat.setTargetAtTime(0, tEx + exDur * 0.4, exDur * 0.3);
    const g = 0.04 + 0.35 * a * a + (mode === 'chase' ? 0.2 : mode === 'feeding' ? 0.12 : 0);
    groan.setTargetAtTime(g, tEx + 0.03, 0.08);
    groan.setTargetAtTime(0, tEx + exDur * 0.45, exDur * 0.25);
    const f = rand(62, 82) * (1 + 0.3 * a);
    this.groanA.frequency.setTargetAtTime(f, tEx, 0.02);
    this.groanA.frequency.setTargetAtTime(f * 0.8, tEx + 0.05, exDur * 0.5);
    this.groanB.frequency.setTargetAtTime(f * 1.027, tEx, 0.02);
    this.groanB.frequency.setTargetAtTime(f * 0.82, tEx + 0.05, exDur * 0.5);
    this.rattleLfo.frequency.setTargetAtTime(rand(17, 34), tEx, 0.05);
    this.rattleBp.frequency.setTargetAtTime(rand(900, 2400), tEx, 0.05);

    return t0 + P * rand(0.92, 1.1);
  }

  dispose(): void {
    for (const s of this.sources) {
      try { s.stop(); } catch { /* ignore */ }
    }
    for (const n of this.persistent) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
  }
}
