/**
 * WebAudio plumbing shared by every sound in the audio module:
 *   - the bus graph (world / voice / ui -> master -> compressor -> speakers),
 *   - pre-generated noise + heartbeat buffers and distortion curves (made once, reused),
 *   - `Shot`/`ShotPool`: one-shot sound voices with a concurrency cap and automatic cleanup,
 *   - panner / listener helpers with fallbacks for browsers missing the AudioParam API.
 * Only imported by AudioManager after a successful unlock(); nothing here runs in node tests.
 */

import type { Vec3 } from '../../core/types';
import { makeDriveCurve } from './audioMath';

export type NoiseKind = 'white' | 'pink' | 'brown';

/** Distance tuning per sound family (PannerNode, distanceModel 'inverse'). */
export const SPATIAL = {
  /** Voices: 1/(1 + 1.3 * (d - 1)) -> ~-7 dB at 2 m, ~-20 dB at 8 m. */
  voice: { ref: 1, rolloff: 1.3 },
  /** Monster: ~-19 dB at 12 m (~-6 dB at 3 m): heard across a room, faint across the house. */
  monster: { ref: 1.6, rolloff: 1.2 },
  /** Small props / clicks / steps. */
  prop: { ref: 1, rolloff: 1.15 },
  /** Ambient creaks and knocks. */
  ambient: { ref: 1.5, rolloff: 1.0 },
  /** The exit door: meant to be heard everywhere. */
  loud: { ref: 4, rolloff: 0.7 },
} as const;

export interface PannerOpts {
  ref: number;
  rolloff: number;
  /** [innerAngleDeg, outerAngleDeg, outerGain]; omit for omnidirectional. */
  cone?: [number, number, number];
}

export interface Engine {
  ctx: AudioContext;
  /** Spatial world sounds + ambience. Muffled when the local player is a ghost. */
  world: GainNode;
  /** Remote voices (lightly muffled for ghosts so spectators can still follow their team). */
  voice: GainNode;
  /** Non-spatial body/UI sounds: heartbeat, stings, round chords. Never muffled. */
  ui: GainNode;
  master: GainNode;
  worldLp: BiquadFilterNode;
  worldDuck: GainNode;
  voiceLp: BiquadFilterNode;
  voiceDuck: GainNode;
  noise: Record<NoiseKind, AudioBuffer>;
  curves: { soft: Float32Array<ArrayBuffer>; hard: Float32Array<ArrayBuffer>; brutal: Float32Array<ArrayBuffer> };
  heart: { lub: AudioBuffer; dub: AudioBuffer };
  pool: ShotPool;
  /** Highest filter frequency that is safe at this sample rate. */
  nyquistSafe: number;
}

type AudioContextCtor = new (opts?: AudioContextOptions) => AudioContext;

/** Creates an AudioContext if the browser has WebAudio, else null (node, very old browsers). */
export function createAudioContext(): AudioContext | null {
  const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor({ latencyHint: 'interactive' });
  } catch {
    try {
      return new Ctor();
    } catch {
      return null;
    }
  }
}

export function buildEngine(ctx: AudioContext): Engine {
  const nyquistSafe = Math.min(20000, ctx.sampleRate / 2 - 200);

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.knee.value = 10;
  compressor.ratio.value = 5;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;
  compressor.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(compressor);

  const worldLp = ctx.createBiquadFilter();
  worldLp.type = 'lowpass';
  worldLp.frequency.value = nyquistSafe;
  worldLp.Q.value = 0.5;
  const worldDuck = ctx.createGain();
  const world = ctx.createGain();
  world.connect(worldLp).connect(worldDuck).connect(master);

  const voiceLp = ctx.createBiquadFilter();
  voiceLp.type = 'lowpass';
  voiceLp.frequency.value = nyquistSafe;
  voiceLp.Q.value = 0.5;
  const voiceDuck = ctx.createGain();
  const voice = ctx.createGain();
  // Makeup gain: mics run with AGC off, so raw voices are quiet next to the synthesized world.
  voice.gain.value = 2.2;
  voice.connect(voiceLp).connect(voiceDuck).connect(master);

  const ui = ctx.createGain();
  ui.connect(master);

  const sr = ctx.sampleRate;
  const eng: Engine = {
    ctx,
    world,
    voice,
    ui,
    master,
    worldLp,
    worldDuck,
    voiceLp,
    voiceDuck,
    noise: {
      white: noiseBuffer(ctx, 'white', 2.5),
      pink: noiseBuffer(ctx, 'pink', 3.1),
      brown: noiseBuffer(ctx, 'brown', 3.7),
    },
    curves: { soft: makeDriveCurve(2), hard: makeDriveCurve(9), brutal: makeDriveCurve(40) },
    heart: {
      lub: thumpBuffer(ctx, sr, 0.24, 54, 36, 1.0),
      dub: thumpBuffer(ctx, sr, 0.2, 66, 44, 0.72),
    },
    pool: null as unknown as ShotPool,
    nyquistSafe,
  };
  eng.pool = new ShotPool(eng, 18);
  return eng;
}

// ---------------------------------------------------------------------------------------------
// Buffers (generated in JS once: far cheaper on Quest than running noise generators live)
// ---------------------------------------------------------------------------------------------

/** Seamlessly loopable mono noise buffer (crossfaded seam). */
function noiseBuffer(ctx: BaseAudioContext, kind: NoiseKind, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const fade = Math.floor(sr * 0.05);
  const raw = new Float32Array(len + fade);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') {
      raw[i] = w;
    } else if (kind === 'pink') {
      // Paul Kellet's refined pink filter.
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      raw[i] = last * 3.5;
    }
  }
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = raw[i];
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    data[i] = raw[i] * t + raw[len + i] * (1 - t);
  }
  // Normalize peak to ~0.9 so every kind has a comparable level.
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) for (let i = 0; i < len; i++) data[i] *= 0.9 / peak;
  return buf;
}

/**
 * One heartbeat thump: a pitch-dropping low sine, saturated so its harmonics survive small
 * headset speakers that cannot reproduce 50 Hz, plus a soft tissue "knock".
 */
function thumpBuffer(ctx: BaseAudioContext, sr: number, seconds: number, f0: number, f1: number, amp: number): AudioBuffer {
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  let phase = 0;
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / 0.05);
    phase += (2 * Math.PI * f) / sr;
    const env = Math.min(1, t / 0.006) * Math.exp(-t / 0.065);
    lp += 0.08 * (Math.random() * 2 - 1 - lp);
    const s = Math.sin(phase) + 0.35 * Math.sin(phase * 2) + lp * 0.5 * Math.exp(-t / 0.015);
    d[i] = amp * Math.tanh(1.8 * s * env) * 0.8;
  }
  return buf;
}

// ---------------------------------------------------------------------------------------------
// One-shots
// ---------------------------------------------------------------------------------------------

/**
 * A one-shot sound: a tiny node graph ending in `out`. Every node/source made through it is
 * tracked so the pool can disconnect it once `end` has passed.
 */
export class Shot {
  readonly out: GainNode;
  readonly ctx: AudioContext;
  end: number;
  dead = false;
  private nodes: AudioNode[] = [];
  private sources: AudioScheduledSourceNode[] = [];

  constructor(readonly eng: Engine, readonly priority: number, readonly t: number) {
    this.ctx = eng.ctx;
    this.out = this.add(this.ctx.createGain());
    this.end = t + 0.05;
  }

  /** Keep the shot alive (not disposed) until at least `time`. */
  hold(time: number): void {
    if (time > this.end) this.end = time;
  }

  add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  gain(value = 0): GainNode {
    const g = this.add(this.ctx.createGain());
    g.gain.value = value;
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.7071, gainDb = 0): BiquadFilterNode {
    const f = this.add(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = Math.min(freq, this.eng.nyquistSafe);
    f.Q.value = q;
    if (gainDb) f.gain.value = gainDb;
    return f;
  }

  shaper(curve: Float32Array<ArrayBuffer>, oversample: OverSampleType = 'none'): WaveShaperNode {
    const w = this.add(this.ctx.createWaveShaper());
    w.curve = curve;
    w.oversample = oversample;
    return w;
  }

  osc(type: OscillatorType, freq: number, start: number, stop: number): OscillatorNode {
    const o = this.add(this.ctx.createOscillator());
    o.type = type;
    o.frequency.value = freq;
    this.startStop(o, start, stop);
    return o;
  }

  /** Noise from a shared buffer, starting at a random offset (looped when longer than the buffer). */
  noise(kind: NoiseKind, start: number, dur: number, rate = 1): AudioBufferSourceNode {
    const buf = this.eng.noise[kind];
    const s = this.add(this.ctx.createBufferSource());
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(start, Math.random() * buf.duration * 0.9);
    try { s.stop(start + dur); } catch { /* ignore */ }
    this.sources.push(s);
    this.hold(start + dur);
    return s;
  }

  private startStop(src: AudioScheduledSourceNode, start: number, stop: number): void {
    src.start(start);
    try { src.stop(stop); } catch { /* ignore */ }
    this.sources.push(src);
    this.hold(stop);
  }

  /** Fade out fast and stop (voice stealing). */
  kill(now: number): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.out.gain.cancelScheduledValues(now);
      this.out.gain.setTargetAtTime(0, now, 0.012);
    } catch { /* ignore */ }
    for (const s of this.sources) {
      try { s.stop(now + 0.07); } catch { /* ignore */ }
    }
    this.end = now + 0.08;
  }

  dispose(): void {
    for (const s of this.sources) {
      try { s.stop(); } catch { /* already stopped */ }
    }
    for (const n of this.nodes) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
    this.dead = true;
  }
}

/**
 * Caps concurrent one-shots (CPU on Quest) and disconnects finished ones.
 * Priority 0 = expendable (ambient creaks, remote steps): dropped when full.
 * Higher priorities steal the oldest lowest-priority voice.
 */
export class ShotPool {
  private active: Shot[] = [];

  constructor(private eng: Engine, private max: number) {}

  get count(): number {
    return this.active.length;
  }

  begin(dest: AudioNode, priority = 1): Shot | null {
    const now = this.eng.ctx.currentTime;
    this.sweep(now);
    let live = 0;
    for (const s of this.active) if (!s.dead) live++;
    if (live >= this.max) {
      if (priority <= 0) return null;
      let victim: Shot | null = null;
      for (const s of this.active) {
        if (s.dead || s.priority > priority) continue;
        if (!victim || s.priority < victim.priority || (s.priority === victim.priority && s.t < victim.t)) victim = s;
      }
      if (!victim) return null;
      victim.kill(now);
    }
    const shot = new Shot(this.eng, priority, now);
    shot.out.connect(dest);
    this.active.push(shot);
    return shot;
  }

  /** One-shot through its own panner at `pos` into the world bus. */
  spatial(pos: Vec3, opts: PannerOpts, priority = 1): Shot | null {
    const p = makePanner(this.eng.ctx, opts);
    setPannerPosition(p, pos);
    const shot = this.begin(p, priority);
    if (!shot) return null;
    shot.add(p);
    p.connect(this.eng.world);
    return shot;
  }

  sweep(now: number): void {
    if (this.active.length === 0) return;
    let w = 0;
    for (let i = 0; i < this.active.length; i++) {
      const s = this.active[i];
      if (s.end + 0.1 < now) s.dispose();
      else this.active[w++] = s;
    }
    this.active.length = w;
  }

  disposeAll(): void {
    for (const s of this.active) s.dispose();
    this.active.length = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------------------

const EPS = 0.0001;

/** Percussive envelope on a gain param: silent at t, peak after `attack`, exp decay over `decay`. Returns end time. */
export function perc(param: AudioParam, t: number, peak: number, attack: number, decay: number): number {
  const p = Math.max(EPS * 2, peak);
  param.setValueAtTime(EPS, t);
  param.exponentialRampToValueAtTime(p, t + Math.max(0.001, attack));
  param.exponentialRampToValueAtTime(EPS, t + Math.max(0.001, attack) + Math.max(0.005, decay));
  return t + attack + decay;
}

/** Attack-hold-release envelope (linear attack, exponential release). Returns end time. */
export function swell(param: AudioParam, t: number, peak: number, attack: number, hold: number, release: number): number {
  const p = Math.max(EPS * 2, peak);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(p, t + attack);
  param.setValueAtTime(p, t + attack + hold);
  param.exponentialRampToValueAtTime(EPS, t + attack + hold + release);
  return t + attack + hold + release;
}

/** Exponential glide of a frequency-like param from a to b. */
export function glide(param: AudioParam, t: number, from: number, to: number, dur: number): void {
  param.setValueAtTime(Math.max(EPS, from), t);
  param.exponentialRampToValueAtTime(Math.max(EPS, to), t + Math.max(0.002, dur));
}

export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
export const chance = (p: number): boolean => Math.random() < p;
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

// ---------------------------------------------------------------------------------------------
// Spatial helpers (AudioParam API with legacy fallbacks: Firefox's AudioListener has no params)
// ---------------------------------------------------------------------------------------------

export function makePanner(ctx: BaseAudioContext, opts: PannerOpts): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'inverse';
  p.refDistance = opts.ref;
  p.rolloffFactor = opts.rolloff;
  p.maxDistance = 100;
  if (opts.cone) {
    p.coneInnerAngle = opts.cone[0];
    p.coneOuterAngle = opts.cone[1];
    p.coneOuterGain = opts.cone[2];
  }
  return p;
}

const finite = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

export function setPannerPosition(p: PannerNode, pos: Vec3): void {
  const x = finite(pos.x), y = finite(pos.y), z = finite(pos.z);
  if (p.positionX) {
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
  } else {
    p.setPosition(x, y, z);
  }
}

export function setPannerOrientation(p: PannerNode, dir: Vec3): void {
  const x = finite(dir.x), y = finite(dir.y), z = finite(dir.z, -1);
  if (x === 0 && y === 0 && z === 0) return;
  if (p.orientationX) {
    p.orientationX.value = x;
    p.orientationY.value = y;
    p.orientationZ.value = z;
  } else {
    p.setOrientation(x, y, z);
  }
}

export function setListenerPose(l: AudioListener, pos: Vec3, forward: Vec3, up: Vec3): void {
  const px = finite(pos.x), py = finite(pos.y, 1.6), pz = finite(pos.z);
  if (l.positionX) {
    l.positionX.value = px;
    l.positionY.value = py;
    l.positionZ.value = pz;
    l.forwardX.value = forward.x;
    l.forwardY.value = forward.y;
    l.forwardZ.value = forward.z;
    l.upX.value = up.x;
    l.upY.value = up.y;
    l.upZ.value = up.z;
  } else {
    l.setPosition(px, py, pz);
    l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
  }
}

/**
 * Smoothly move a param toward `value` starting at `at`, replacing anything scheduled from `at`
 * on (so e.g. a delayed fade-out can't fire after a newer fade-in). Never throws.
 */
export function approach(param: AudioParam, value: number, at: number, tau: number): void {
  if (!Number.isFinite(value) || !Number.isFinite(at)) return;
  try {
    param.cancelScheduledValues(at);
    param.setTargetAtTime(value, at, Math.max(0.001, tau));
  } catch { /* ignore */ }
}
