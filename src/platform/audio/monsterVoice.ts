/**
 * The monster's voice, v2: resting sounds that never repeat the same way, a listening layer that
 * grows the louder you are, the "it heard you" activation and the jumpscare. All procedural (no
 * recordings), on the same Shot API as sfx.ts.
 *
 * The story behind them (docs/STORY.md): the Listener steals voices. Some resting sounds are its
 * victims' voices (Tom crying, Ellie humming) played back through its throat like a broken tape
 * recorder, and its activation scream is every stolen voice at once.
 *
 * Not wired into MonsterAudio yet: the owner approves the sounds first (dev/sounds/ renders them).
 */

import { chance, glide, perc, pick, rand, swell, type Engine, type Shot } from './engine';
import { clicks, creak, metal } from './sfx';

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

const waveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();

function periodic(ctx: BaseAudioContext, key: string, n: number, amp: (k: number) => readonly [number, number]): PeriodicWave {
  let m = waveCache.get(ctx);
  if (!m) {
    m = new Map();
    waveCache.set(ctx, m);
  }
  let w = m.get(key);
  if (!w) {
    const re = new Float32Array(n + 1);
    const im = new Float32Array(n + 1);
    for (let k = 1; k <= n; k++) [re[k], im[k]] = amp(k);
    w = ctx.createPeriodicWave(re, im);
    m.set(key, w);
  }
  return w;
}

/** A glottal pulse: harmonics falling off like a throat's (bigger tilt = softer, rounder voice). */
const glottal = (ctx: BaseAudioContext, tilt: number): PeriodicWave =>
  periodic(ctx, `g${tilt}`, 96, (k) => [0, Math.pow(k, -tilt) * (k % 2 ? 1 : 0.8)]);

/** Narrow non-negative pulses (a Fejér kernel): one sharp tick per cycle, nothing in between. */
const pulses = (ctx: BaseAudioContext): PeriodicWave => periodic(ctx, 'pulse', 64, (k) => [1 - k / 65, 0]);

const crushCurves = new Map<number, Float32Array<ArrayBuffer>>();
/** Amplitude quantizer: the grit of a cheap digital recorder. */
function crushCurve(steps: number): Float32Array<ArrayBuffer> {
  let c = crushCurves.get(steps);
  if (!c) {
    c = new Float32Array(4096);
    for (let i = 0; i < c.length; i++) c[i] = Math.round(((i / (c.length - 1)) * 2 - 1) * steps) / steps;
    crushCurves.set(steps, c);
  }
  return c;
}

/** Formants: [Hz, Q, level] for F1..F4 of an adult voice. */
type Vowel = readonly (readonly [number, number, number])[];
export const VOWELS = {
  ah: [[730, 8, 1], [1090, 10, 0.5], [2440, 14, 0.28], [3400, 16, 0.14]],
  uh: [[640, 7, 1], [1190, 10, 0.42], [2390, 14, 0.22], [3300, 16, 0.1]],
  oo: [[300, 5, 1], [870, 8, 0.3], [2240, 14, 0.12], [3300, 16, 0.06]],
  ee: [[270, 5, 1], [2290, 14, 0.4], [3010, 16, 0.3], [3700, 16, 0.12]],
  eh: [[530, 7, 1], [1840, 12, 0.45], [2480, 14, 0.3], [3500, 16, 0.12]],
  mm: [[260, 4, 1], [1050, 6, 0.06], [2300, 10, 0.04], [3300, 12, 0.02]],
} as const satisfies Record<string, Vowel>;

interface VoiceOpts {
  /** Pitch contour: [seconds from start, Hz] points, exponential glides between them. */
  pitch: readonly (readonly [number, number])[];
  vowel: Vowel;
  /** Morph to another vowel between two offsets (s). */
  to?: { vowel: Vowel; from: number; until: number };
  /** Formant scale: 1 adult, ~1.3 child, ~0.65 the monster's huge throat. */
  size?: number;
  /** Glide the formant scale (a tape slowing down drags the formants with the pitch). */
  sizeTo?: { size: number; from: number; until: number };
  /** 'pulse' = a creaky, popping vocal fry; 'glottal' = a voiced tone. */
  wave?: 'glottal' | 'pulse';
  tilt?: number;
  /** Breath noise mixed into the source, 0..1. */
  breath?: number;
  /** Random pitch wander (cents). */
  jitter?: number;
  /** Vibrato [Hz, cents]. */
  vib?: readonly [number, number];
  /** Tape wow and flutter on the pitch. */
  wow?: boolean;
  /** Random loudness wobble, 0..1 (makes a creak's pops ragged instead of machine-even). */
  shimmer?: number;
}

/**
 * A formant voice: a glottal (or pulse) source through four vowel resonances. Returns its output
 * gain at 0: the caller shapes the envelope on `.gain` and routes it.
 */
function voice(s: Shot, t: number, dur: number, o: VoiceOpts): GainNode {
  const ctx = s.ctx;
  const end = t + dur + 0.05;
  const src = s.osc('sine', o.pitch[0][1], t, end);
  src.setPeriodicWave(o.wave === 'pulse' ? pulses(ctx) : glottal(ctx, o.tilt ?? 1.2));
  src.frequency.setValueAtTime(o.pitch[0][1], t);
  for (let i = 1; i < o.pitch.length; i++) src.frequency.exponentialRampToValueAtTime(Math.max(1, o.pitch[i][1]), t + o.pitch[i][0]);
  if (o.jitter) s.noise('brown', t, dur + 0.05).connect(s.filter('lowpass', 18)).connect(s.gain(o.jitter * 12)).connect(src.detune);
  if (o.vib) s.osc('sine', o.vib[0], t, end).connect(s.gain(o.vib[1])).connect(src.detune);
  if (o.wow) {
    s.osc('sine', rand(0.45, 0.7), t, end).connect(s.gain(22)).connect(src.detune);
    s.osc('sine', rand(6, 8), t, end).connect(s.gain(9)).connect(src.detune);
  }
  const exc = s.gain(1);
  if (o.shimmer) {
    const am = s.gain(1 - o.shimmer * 0.5);
    s.noise('white', t, dur + 0.05).connect(s.filter('lowpass', 60)).connect(s.gain(o.shimmer * 6)).connect(am.gain);
    src.connect(am).connect(exc);
  } else {
    src.connect(exc);
  }
  if (o.breath) s.noise('white', t, dur + 0.05).connect(s.gain(o.breath * 0.35)).connect(exc);

  // Formant frequencies at a few key times (vowel morph x size glide), linear between them.
  const size0 = o.size ?? 1;
  const keys = new Set([0, dur]);
  if (o.to) [o.to.from, o.to.until].forEach((k) => keys.add(Math.min(dur, Math.max(0, k))));
  if (o.sizeTo) [o.sizeTo.from, o.sizeTo.until].forEach((k) => keys.add(Math.min(dur, Math.max(0, k))));
  const times = [...keys].sort((a, b) => a - b);
  const lerpAt = (x: number, a: number, b: number, from: number, until: number) =>
    x <= from ? a : x >= until ? b : a + ((b - a) * (x - from)) / Math.max(1e-3, until - from);
  const out = s.gain(0);
  const sum = s.gain(1);
  sum.connect(out);
  o.vowel.forEach(([f, q, g], i) => {
    const bp = s.filter('bandpass', f * size0, q);
    times.forEach((x, k) => {
      const fv = o.to ? lerpAt(x, f, o.to.vowel[i][0], o.to.from, o.to.until) : f;
      const sz = o.sizeTo ? lerpAt(x, size0, o.sizeTo.size, o.sizeTo.from, o.sizeTo.until) : size0;
      const hz = Math.min(s.eng.nyquistSafe, fv * sz);
      if (k === 0) bp.frequency.setValueAtTime(hz, t);
      else bp.frequency.linearRampToValueAtTime(hz, t + x);
    });
    // Alternate polarity so neighbouring resonances don't cancel into a notch between them.
    exc.connect(bp).connect(s.gain(g * Math.sqrt(q) * 0.9 * (i % 2 ? -1 : 1))).connect(sum);
  });
  return out;
}

/**
 * "Played back": a small speaker's narrow band and honk, a little digital crush and hiss. The
 * crush makes low rumble of its own, so everything is high-passed again at the end.
 */
function tape(s: Shot, t: number, dur: number, input: AudioNode, crush = 0.2): GainNode {
  const lp = s.filter('lowpass', 3600, 0.9);
  input.connect(s.filter('highpass', 320, 0.7)).connect(s.filter('peaking', 1400, 1, 4)).connect(lp);
  const mix = s.gain(1);
  lp.connect(s.gain(1 - crush)).connect(mix);
  lp.connect(s.gain(3)).connect(s.shaper(crushCurve(7))).connect(s.gain(crush / 3)).connect(mix);
  s.noise('white', t, dur).connect(s.filter('bandpass', 5200, 0.6)).connect(s.gain(0.006)).connect(mix);
  const out = s.gain(1);
  mix.connect(s.filter('highpass', 300, 0.8)).connect(s.filter('highpass', 300, 0.8)).connect(out);
  return out;
}

/** A gain envelope from [offset, value] points (linear), starting silent. */
function shape(p: AudioParam, t: number, pts: readonly (readonly [number, number])[]): void {
  p.setValueAtTime(0, t);
  for (const [x, v] of pts) p.linearRampToValueAtTime(v, t + x);
}

// ---------------------------------------------------------------------------------------------
// Resting: one-shots the game scatters while it wanders or waits (never twice the same)
// ---------------------------------------------------------------------------------------------

/** One slow breath: a wet, bubbling inhale, then a long exhale that ends in a throat rattle. Returns its end. */
export function sfxMonsterBreath(s: Shot, t: number, level = 1): number {
  const inDur = rand(1.0, 1.4);
  const exDur = rand(1.5, 2.0);
  const air = s.noise('pink', t, inDur + 0.1);
  const bp = s.filter('bandpass', 500, 2.2);
  glide(bp.frequency, t, 500, rand(1300, 1700), inDur);
  const g = s.gain(0);
  air.connect(s.filter('highpass', 200)).connect(bp).connect(g).connect(s.out);
  shape(g.gain, t, [[inDur * 0.75, 1.1 * level], [inDur, 0.6 * level], [inDur + 0.08, 0]]);
  const pops: number[] = [];
  for (let x = rand(0.15, 0.3); x < inDur; x += rand(0.06, 0.16)) pops.push(x);
  clicks(s, t, pops, { freq: rand(380, 700), q: 9, peak: 0.45 * level, decay: 0.03, kind: 'pink' });

  const t2 = t + inDur + rand(0.12, 0.3);
  const ex = s.noise('pink', t2, exDur + 0.1);
  const ebp = s.filter('bandpass', 900, 1.6);
  glide(ebp.frequency, t2, 900, 380, exDur);
  const eg = s.gain(0);
  ex.connect(ebp).connect(eg).connect(s.out);
  swell(eg.gain, t2, 0.9 * level, 0.15, exDur * 0.35, exDur * 0.5);
  const rattle = voice(s, t2, exDur, {
    pitch: [[0, rand(34, 42)], [exDur, rand(21, 26)]],
    vowel: VOWELS.uh,
    size: 0.62,
    wave: 'pulse',
    jitter: 90,
    shimmer: 0.7,
    breath: 0.15,
  });
  rattle.connect(s.shaper(s.eng.curves.soft)).connect(s.gain(1.1 * level)).connect(s.out);
  shape(rattle.gain, t2, [[exDur * 0.3, 0.2], [exDur * 0.65, 1], [exDur, 0]]);
  return t2 + exDur;
}

/** The croak: a slow, broken clicking from deep in its throat that swells into a groan. */
export function sfxMonsterCroak(s: Shot, t: number, level = 1): number {
  const dur = rand(1.7, 2.6);
  const f0 = rand(19, 25);
  const v = voice(s, t, dur, {
    pitch: [[0, f0], [dur * 0.35, f0 * rand(1.6, 2.1)], [dur * 0.7, f0 * rand(1.2, 1.4)], [dur, f0 * 0.75]],
    vowel: VOWELS.ah,
    to: { vowel: VOWELS.uh, from: dur * 0.4, until: dur },
    size: rand(0.68, 0.8),
    wave: 'pulse',
    jitter: 160,
    shimmer: 0.8,
    breath: 0.06,
  });
  v.connect(s.filter('highpass', 110)).connect(s.shaper(s.eng.curves.soft)).connect(s.gain(1.3 * level)).connect(s.out);
  swell(v.gain, t, 1, 0.15, dur - 0.55, 0.4);
  return t + dur;
}

/** Whispering to itself: breathy, wordless syllables (sometimes two voices, one a child's). */
export function sfxMonsterWhisper(s: Shot, t: number, level = 1): number {
  const voices = chance(0.5) ? 2 : 1;
  let end = t;
  for (let w = 0; w < voices; w++) {
    const t0 = t + w * rand(0.15, 0.45);
    const size = w === 1 ? rand(1.25, 1.35) : rand(0.85, 1.05);
    const n = 6 + Math.floor(Math.random() * 6);
    const src = s.noise('white', t0, n * 0.4 + 0.5);
    const env = s.gain(0);
    const bps = [0, 1, 2].map(() => s.filter('bandpass', 1000, 4.5));
    bps.forEach((bp, k) => src.connect(bp).connect(s.gain([1, 0.8, 0.45][k] * 3.2)).connect(env));
    const sib = s.noise('white', t0, n * 0.4 + 0.5);
    const sibG = s.gain(0);
    const mix = s.gain(1);
    env.connect(mix);
    sib.connect(s.filter('highpass', 4800, 0.8)).connect(sibG).connect(mix);
    const vs = [VOWELS.ah, VOWELS.ee, VOWELS.oo, VOWELS.eh, VOWELS.uh];
    env.gain.setValueAtTime(0, t0);
    sibG.gain.setValueAtTime(0, t0);
    let x = 0;
    for (let i = 0; i < n; i++) {
      const v = pick(vs);
      const len = rand(0.12, 0.26);
      const at = t0 + x;
      bps.forEach((bp, k) => {
        if (i === 0) bp.frequency.setValueAtTime(v[k][0] * size, at);
        else bp.frequency.linearRampToValueAtTime(v[k][0] * size, at + 0.04);
      });
      const pk = rand(0.6, 1);
      env.gain.setValueAtTime(0.0001, at);
      env.gain.linearRampToValueAtTime(pk, at + len * 0.3);
      env.gain.linearRampToValueAtTime(pk * 0.5, at + len * 0.75);
      env.gain.linearRampToValueAtTime(0.0001, at + len);
      if (chance(0.35)) perc(sibG.gain, at, rand(0.5, 0.9), 0.01, rand(0.06, 0.12));
      x += len + (chance(0.2) ? rand(0.18, 0.4) : rand(0.02, 0.06));
    }
    tape(s, t0, x + 0.2, mix, 0.12).connect(s.gain(0.9 * level * (w ? 0.7 : 1))).connect(s.out);
    end = Math.max(end, t0 + x);
  }
  return end;
}

/**
 * Tom's voice, stolen: a child sobbing, played back through its throat. The recording stutters,
 * then slows down until it is a man's groan.
 */
export function sfxStolenWhimper(s: Shot, t: number, level = 1): number {
  const bus = s.gain(1);
  const f = rand(420, 500);
  const sob = (at: number, len: number, f0: number, hard = false, slow?: { pitch: number; size: number }) => {
    const v = voice(s, t + at, len, {
      pitch: slow
        ? [[0, f0 * 1.06], [len * 0.15, f0 * 1.1], [len, f0 * slow.pitch]]
        : [[0, f0 * 1.06], [len * 0.25, f0 * 1.12], [len, f0 * 0.78]],
      vowel: VOWELS.mm,
      to: { vowel: VOWELS.uh, from: len * 0.25, until: len * 0.7 },
      size: 1.35,
      sizeTo: slow ? { size: 1.35 * slow.size, from: len * 0.1, until: len } : undefined,
      vib: [9, slow ? 30 : 70],
      jitter: 30,
      breath: 0.5,
      wow: true,
      tilt: 1.5,
    });
    v.connect(bus);
    if (hard) shape(v.gain, t + at, [[0.004, 1], [len - 0.004, 1], [len, 0]]);
    else if (slow) shape(v.gain, t + at, [[0.04, 1], [len * 0.6, 0.9], [len, 0]]);
    else shape(v.gain, t + at, [[0.04, 1], [len * 0.5, 0.8], [len, 0]]);
  };
  let x = 0;
  const sobs = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < sobs; i++) {
    const len = rand(0.3, 0.45);
    sob(x, len, f * rand(0.95, 1.05));
    x += len + rand(0.12, 0.25);
  }
  // A shaky in-breath: "hh-hh".
  for (let k = 0; k < 2; k++) {
    const n = s.noise('white', t + x, 0.12);
    const bp = s.filter('bandpass', 1600, 1.4);
    glide(bp.frequency, t + x, 1600, 2600, 0.1);
    const g = s.gain(0);
    n.connect(bp).connect(g).connect(bus);
    swell(g.gain, t + x, 0.5, 0.03, 0.04, 0.04);
    x += 0.13;
  }
  x += 0.18;
  // The tape catches: the start of a sob twice, cut hard, then it drags down into his voice.
  sob(x, 0.15, f, true);
  x += 0.15;
  sob(x, 0.15, f, true);
  x += 0.15;
  const slowLen = rand(1.1, 1.4);
  sob(x, slowLen, f, false, { pitch: 0.3, size: 0.5 });
  x += slowLen;
  tape(s, t, x + 0.2, bus, 0.2).connect(s.gain(0.6 * level)).connect(s.out);
  return t + x;
}

const PHRASES: readonly (readonly [number, number])[][] = [
  [[69, 1], [72, 1], [71, 1], [69, 1], [64, 2], [65, 1], [64, 1], [62, 1], [64, 3]],
  [[64, 1], [69, 1], [68, 1], [69, 1], [71, 1], [72, 2], [71, 1], [69, 3]],
  [[72, 1], [71, 1], [69, 2], [64, 1], [67, 1], [65, 2], [64, 3]],
];

/**
 * Ellie's voice, stolen: a girl humming a lullaby, played back through its throat. On the last
 * note the tape drags down into a man's groan and its own rattle comes in under it.
 */
export function sfxStolenLullaby(s: Shot, t: number, level = 1): number {
  const notes = pick(PHRASES);
  const beat = rand(0.32, 0.38);
  const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
  const pitch: [number, number][] = [];
  const amp: [number, number][] = [];
  let x = 0;
  notes.forEach(([m, b], i) => {
    const len = b * beat;
    const f = hz(m) * rand(0.995, 1.005);
    if (i === 0) pitch.push([0, f]);
    else pitch.push([x + 0.07, f]);
    pitch.push([x + len, f]);
    amp.push([x + 0.06, 1], [x + len - 0.05, 0.8], [x + len, 0.55]);
    x += len;
  });
  const slow = rand(1.4, 1.8);
  const last = pitch[pitch.length - 1][1];
  pitch.push([x + slow, last * 0.28]);
  amp.push([x + slow * 0.6, 0.85], [x + slow, 0]);
  const dur = x + slow;
  const v = voice(s, t, dur, {
    pitch,
    vowel: VOWELS.mm,
    to: { vowel: VOWELS.uh, from: x, until: x + slow * 0.7 },
    size: 1.3,
    sizeTo: { size: 0.62, from: x, until: dur },
    vib: [5.5, 18],
    jitter: 12,
    breath: 0.22,
    wow: true,
    tilt: 1.8,
  });
  amp[0] = [0.15, 1];
  shape(v.gain, t, amp);
  tape(s, t, dur + 0.2, v, 0.15).connect(s.gain(0.45 * level)).connect(s.out);
  const r = voice(s, t + x, slow, {
    pitch: [[0, 34], [slow, 24]],
    vowel: VOWELS.uh,
    size: 0.62,
    wave: 'pulse',
    jitter: 90,
  });
  r.connect(s.shaper(s.eng.curves.soft)).connect(s.gain(0.9 * level)).connect(s.out);
  shape(r.gain, t + x, [[slow * 0.5, 0.2], [slow * 0.85, 1], [slow, 0]]);
  return t + dur;
}

/** Joints cracking as it shifts its weight: snaps, a crackle, sinew straining between them. */
export function sfxBoneCracks(s: Shot, t: number, level = 1): number {
  const n = 3 + Math.floor(Math.random() * 4);
  let x = 0;
  for (let i = 0; i < n; i++) {
    const at = t + x;
    clicks(s, at, [0, rand(0.004, 0.009)], { freq: rand(1800, 3400), q: 2.5, peak: 1.8 * level, decay: 0.012 });
    const body = s.noise('pink', at, 0.12);
    const bg = s.gain(0);
    body.connect(s.filter('lowpass', rand(260, 420), 2)).connect(bg).connect(s.out);
    perc(bg.gain, at, 0.9 * level, 0.002, 0.07);
    const grit: number[] = [];
    const gl = rand(0.04, 0.1);
    for (let y = 0; y < gl; y += rand(0.006, 0.014)) grit.push(y);
    clicks(s, at + 0.01, grit, { freq: rand(2500, 4500), q: 1.5, peak: 0.5 * level, decay: 0.004 });
    if (i < n - 1 && chance(0.45)) {
      creak(s, at + 0.06, { dur: rand(0.25, 0.5), rateLo: 9, rateHi: 26, res: rand(500, 800), q: 9, level: 0.28 * level });
      x += rand(0.4, 0.7);
    } else {
      x += chance(0.4) ? rand(0.05, 0.12) : rand(0.25, 0.6);
    }
  }
  return t + x;
}

// ---------------------------------------------------------------------------------------------
// Listening: a continuous layer driven by how loud the players are
// ---------------------------------------------------------------------------------------------

const smooth01 = (a: number, b: number, x: number): number => {
  const k = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/**
 * While it listens, it gets louder the louder you are: its head clicks speed up into a rattling
 * chitter, a growl builds in its chest, it breathes faster, and the implant in its head starts to
 * whine (feedback rising in pitch). `set(level)` takes 0 (silence) .. 1 (it is about to snap).
 */
export class MonsterListening {
  readonly out: GainNode;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly clickRate: OscillatorNode;
  private readonly clickBp: BiquadFilterNode;
  private readonly clickGain: GainNode;
  private readonly knockGain: GainNode;
  private readonly growlSrc: OscillatorNode;
  private readonly growlLp: BiquadFilterNode;
  private readonly growlGain: GainNode;
  private readonly growlRide: GainNode;
  private readonly whineA: OscillatorNode;
  private readonly whineB: OscillatorNode;
  private readonly whineGain: GainNode;
  private readonly breathRate: OscillatorNode;
  private readonly breathGain: GainNode;
  private level = 0;

  constructor(eng: Engine, start: number) {
    const ctx = eng.ctx;
    const n = <T extends AudioNode>(x: T): T => (this.nodes.push(x), x);
    const g = (v: number) => {
      const x = n(ctx.createGain());
      x.gain.value = v;
      return x;
    };
    const f = (type: BiquadFilterType, hz: number, q: number) => {
      const x = n(ctx.createBiquadFilter());
      x.type = type;
      x.frequency.value = Math.min(hz, eng.nyquistSafe);
      x.Q.value = q;
      return x;
    };
    const src = <T extends AudioScheduledSourceNode>(x: T): T => {
      n(x);
      this.sources.push(x);
      x.start(start);
      return x;
    };
    const loop = (kind: 'white' | 'pink' | 'brown') => {
      const b = ctx.createBufferSource();
      b.buffer = eng.noise[kind];
      b.loop = true;
      return src(b);
    };
    const osc = (hz: number, wave?: PeriodicWave, type: OscillatorType = 'sine') => {
      const o = ctx.createOscillator();
      if (wave) o.setPeriodicWave(wave);
      else o.type = type;
      o.frequency.value = hz;
      return src(o);
    };
    this.out = g(1);

    // Head clicks: noise gated by a pulse train whose rate follows the level (with a ragged rhythm).
    this.clickRate = osc(1.5, pulses(ctx));
    loop('brown').connect(f('lowpass', 4, 0.7)).connect(g(4000)).connect(this.clickRate.detune);
    const gate = g(0);
    this.clickRate.connect(gate.gain);
    loop('white').connect(gate);
    this.clickBp = f('bandpass', 2600, 3);
    this.clickGain = g(0);
    gate.connect(this.clickBp).connect(this.clickGain).connect(this.out);
    // A wetter knock under every click, from the same gate.
    this.knockGain = g(0);
    gate.connect(f('bandpass', 850, 5)).connect(this.knockGain).connect(this.out);

    // Chest growl: a jittery low voice through an "uh" throat that opens up as it gets angrier.
    this.growlSrc = osc(38, glottal(ctx, 1.1));
    loop('brown').connect(f('lowpass', 18, 0.7)).connect(g(900)).connect(this.growlSrc.detune);
    const sum = g(1);
    VOWELS.uh.forEach(([hz, q, lv], i) =>
      this.growlSrc.connect(f('bandpass', hz * 0.66, q)).connect(g(lv * Math.sqrt(q) * 0.9 * (i % 2 ? -1 : 1))).connect(sum));
    // A guttural rattle (fast, ragged amplitude flutter), so it growls instead of droning.
    const rattle = g(0.55);
    const flutter = osc(rand(22, 30), undefined, 'sawtooth');
    flutter.connect(g(0.45)).connect(rattle.gain);
    loop('white').connect(f('lowpass', 50, 0.7)).connect(g(2.5)).connect(rattle.gain);
    this.growlLp = f('lowpass', 500, 1.5);
    this.growlGain = g(0);
    const shaper = n(ctx.createWaveShaper());
    shaper.curve = eng.curves.hard;
    // It growls on the out-breath: the growl rides the breathing below.
    this.growlRide = g(0.6);
    sum.connect(rattle).connect(shaper).connect(this.growlLp).connect(this.growlRide).connect(this.growlGain).connect(this.out);

    // The implant: two close sines beating, wobbling, rising in pitch with the level.
    this.whineA = osc(2400);
    this.whineB = osc(2414);
    const wob = osc(6.2);
    wob.connect(g(35)).connect(this.whineA.detune);
    wob.connect(g(-28)).connect(this.whineB.detune);
    this.whineGain = g(0);
    this.whineA.connect(this.whineGain);
    this.whineB.connect(this.whineGain);
    this.whineGain.connect(this.out);

    // Breathing that quickens: pink noise, amplitude-modulated at the breath rate.
    this.breathRate = osc(0.4);
    const bAm = g(0.5);
    this.breathRate.connect(g(0.5)).connect(bAm.gain);
    this.breathRate.connect(g(-0.4)).connect(this.growlRide.gain);
    this.breathGain = g(0);
    loop('pink').connect(f('bandpass', 1100, 1.4)).connect(bAm).connect(this.breathGain).connect(this.out);
  }

  /** 0 = silent .. 1 = about to snap. Smoothed, so it can be set every frame. */
  set(level: number, now: number, tau = 0.25): void {
    const x = Math.max(0, Math.min(1, level));
    this.level = x;
    const to = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, tau);
    const on = smooth01(0.02, 0.12, x);
    to(this.clickRate.frequency, 1.4 + 34 * Math.pow(x, 2.2));
    to(this.clickBp.frequency, 2300 + 1900 * x);
    to(this.clickGain.gain, on * (0.5 + 1.6 * x));
    to(this.knockGain.gain, on * (0.6 + 0.8 * x) * (1 - 0.6 * smooth01(0.6, 1, x)));
    const growl = Math.pow(smooth01(0.25, 1, x), 1.4);
    to(this.growlSrc.frequency, 34 + 34 * x);
    to(this.growlLp.frequency, 380 + 2600 * growl);
    to(this.growlGain.gain, 0.5 * growl);
    const whine = smooth01(0.4, 1, x);
    to(this.whineA.frequency, 2300 + 3600 * whine * whine);
    to(this.whineB.frequency, (2300 + 3600 * whine * whine) * 1.006);
    to(this.whineGain.gain, 0.035 * whine);
    to(this.breathRate.frequency, 0.35 + 2.2 * x);
    to(this.breathGain.gain, on * (0.12 + 0.3 * x));
  }

  get value(): number {
    return this.level;
  }

  stop(now: number): void {
    this.out.gain.setTargetAtTime(0, now, 0.05);
    for (const s of this.sources) {
      try { s.stop(now + 0.4); } catch { /* ignore */ }
    }
  }

  dispose(): void {
    for (const s of this.sources) {
      try { s.stop(); } catch { /* ignore */ }
    }
    for (const x of this.nodes) {
      try { x.disconnect(); } catch { /* ignore */ }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Activation and the jumpscare
// ---------------------------------------------------------------------------------------------

/**
 * Every stolen voice screaming at once over its own roar (activation and jumpscare share it).
 * Routed to `s.out`; returns the envelope gain (starts at 1: the caller shapes it).
 */
function screamChoir(
  s: Shot,
  t: number,
  dur: number,
  o: { voices: readonly (readonly [number, number, number])[]; rise: number; ring: number; level: number; to: Vowel },
): GainNode {
  const bus = s.gain(1);
  for (const [f, size, lv] of o.voices) {
    const v = voice(s, t, dur, {
      pitch: [[0, f * 0.7], [0.08, f * 1.15], [dur * 0.6, f * o.rise], [dur, f * 0.62]],
      vowel: VOWELS.ah,
      to: { vowel: o.to, from: dur * 0.2, until: dur * 0.8 },
      size,
      vib: [rand(6, 8.5), rand(45, 80)],
      jitter: 60,
      breath: 0.3,
      tilt: 1.0,
    });
    shape(v.gain, t, [[0.02, lv], [dur - 0.05, lv]]);
    v.connect(bus);
  }
  const env = s.gain(0);
  // Three drives in parallel: the voices stay voices, with a torn edge on top.
  const drive = s.gain(1);
  bus.connect(s.shaper(s.eng.curves.soft, '2x')).connect(s.gain(0.5)).connect(drive);
  bus.connect(s.shaper(s.eng.curves.hard, '2x')).connect(s.gain(0.4)).connect(drive);
  bus.connect(s.shaper(s.eng.curves.brutal, '2x')).connect(s.gain(0.22)).connect(drive);
  drive
    .connect(s.filter('highpass', 180))
    .connect(s.filter('peaking', 2500, 1, 5))
    .connect(s.filter('lowpass', 7500))
    .connect(env);
  // Ring modulation: the inhuman, metallic edge.
  const rm = s.gain(0);
  bus.connect(rm);
  s.osc('sine', o.ring, t, t + dur + 0.05).connect(rm.gain);
  rm.connect(s.shaper(s.eng.curves.hard)).connect(s.filter('highpass', 300)).connect(s.gain(0.4)).connect(env);
  env.connect(s.gain(o.level)).connect(s.out);
  return env;
}

/**
 * It heard you: a sharp wet gasp, a beat of silence, then every stolen voice screams at once, the
 * implant shrieks with feedback, and it snarls into the chase. Returns its end.
 */
export function sfxMonsterActivate(s: Shot, t: number, level = 1): number {
  // 1. The gasp.
  const gasp = s.noise('pink', t, 0.3);
  const gbp = s.filter('bandpass', 900, 1.6);
  glide(gbp.frequency, t, 900, 3000, 0.2);
  const gg = s.gain(0);
  gasp.connect(s.filter('highpass', 400)).connect(gbp).connect(gg).connect(s.out);
  shape(gg.gain, t, [[0.03, 1.4 * level], [0.18, 1.0 * level], [0.24, 0]]);
  const huh = voice(s, t, 0.24, { pitch: [[0, 60], [0.2, 95]], vowel: VOWELS.uh, size: 0.66, wave: 'pulse', jitter: 50, breath: 0.4 });
  huh.connect(s.shaper(s.eng.curves.soft)).connect(s.gain(1.2 * level)).connect(s.out);
  shape(huh.gain, t, [[0.03, 1], [0.2, 0.8], [0.24, 0]]);

  // 2. Silence. 3. The scream.
  const t1 = t + 0.24 + rand(0.12, 0.2);
  const dur = rand(1.3, 1.7);
  const env = screamChoir(s, t1, dur, {
    voices: [
      [rand(560, 640), 1.35, 0.8],
      [rand(380, 440), 1.15, 0.8],
      [rand(180, 220), 1, 0.9],
      [rand(85, 100), 0.65, 1],
    ],
    rise: rand(1.0, 1.12),
    ring: rand(60, 80),
    level,
    to: pick([VOWELS.ee, VOWELS.eh]),
  });
  env.gain.setValueAtTime(0, t1);
  env.gain.linearRampToValueAtTime(0.9, t1 + 0.03);
  env.gain.setTargetAtTime(0.65, t1 + 0.25, 0.25);
  env.gain.setTargetAtTime(0, t1 + dur - 0.3, 0.1);
  // The implant shrieks.
  const sq = s.osc('sine', 2800, t1, t1 + dur + 0.05);
  glide(sq.frequency, t1, 2800, rand(4000, 4600), dur * 0.8);
  s.osc('sine', 12, t1, t1 + dur + 0.05).connect(s.gain(40)).connect(sq.detune);
  const sg = s.gain(0);
  sq.connect(s.shaper(s.eng.curves.soft)).connect(sg).connect(s.out);
  shape(sg.gain, t1, [[0.15, 0.1 * level], [dur * 0.8, 0.13 * level], [dur, 0]]);
  // A rasp of air and a sub hit on the onset.
  const rasp = s.noise('white', t1, 0.5);
  const rg = s.gain(0);
  rasp.connect(s.filter('bandpass', 3000, 0.8)).connect(rg).connect(s.out);
  perc(rg.gain, t1, 0.4 * level, 0.004, 0.3);
  const sub = s.osc('sine', 80, t1, t1 + 0.7);
  glide(sub.frequency, t1, 80, 34, 0.5);
  const subG = s.gain(0);
  sub.connect(subG).connect(s.out);
  perc(subG.gain, t1, 0.8 * level, 0.005, 0.6);

  // 4. Snarling breaths into the chase.
  let x = t1 + dur - 0.05;
  for (let i = 0; i < 3; i++) {
    const len = rand(0.2, 0.28);
    const air = s.noise('pink', x, len + 0.05);
    const ab = s.filter('bandpass', rand(900, 1300), 1.5);
    const ag = s.gain(0);
    air.connect(ab).connect(ag).connect(s.out);
    swell(ag.gain, x, 0.8 * level, 0.03, len * 0.4, len * 0.5);
    const sn = voice(s, x, len, { pitch: [[0, rand(48, 58)], [len, rand(38, 44)]], vowel: VOWELS.uh, size: 0.66, wave: 'pulse', jitter: 60, breath: 0.3 });
    sn.connect(s.shaper(s.eng.curves.hard)).connect(s.filter('lowpass', 1600)).connect(s.gain(0.6 * level)).connect(s.out);
    swell(sn.gain, x, 1, 0.03, len * 0.4, len * 0.5);
    x += len + rand(0.08, 0.14);
  }
  return x;
}

/**
 * The catch, point blank: an impact, every stolen voice screaming in a dissonant cluster right in
 * your face, the implant feedback tearing upward, then a hard cut to ringing ears. Returns its end.
 */
export function sfxMonsterJumpscare(s: Shot, t: number, level = 1): number {
  const dur = rand(1.2, 1.45);
  // Impact.
  const sub = s.osc('sine', 160, t, t + 0.7);
  glide(sub.frequency, t, 160, 32, 0.5);
  const subG = s.gain(0);
  sub.connect(s.shaper(s.eng.curves.soft)).connect(subG).connect(s.out);
  perc(subG.gain, t, 1.1 * level, 0.003, 0.6);
  const burst = s.noise('white', t, 0.5);
  const blp = s.filter('lowpass', 12000, 0.8);
  glide(blp.frequency, t, 12000, 1800, 0.4);
  const bg = s.gain(0);
  burst.connect(s.shaper(s.eng.curves.brutal)).connect(blp).connect(bg).connect(s.out);
  perc(bg.gain, t, 0.6 * level, 0.002, 0.35);
  metal(s, t, [523, 1187, 1670, 2551, 3313], 0.5, 0.22 * level);

  // The cluster: two children a semitone apart, two men a semitone apart, and it.
  const c = rand(600, 660);
  const m = rand(165, 185);
  const env = screamChoir(s, t + 0.01, dur, {
    voices: [
      [c, 1.35, 0.75],
      [c * 1.059, 1.3, 0.65],
      [m, 1, 0.85],
      [m * 1.059, 1, 0.7],
      [rand(88, 98), 0.65, 1],
    ],
    rise: rand(1.25, 1.4),
    ring: rand(42, 52),
    level: 1.15 * level,
    to: VOWELS.ee,
  });
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(1, t + 0.015);
  env.gain.setValueAtTime(1, t + dur - 0.03);
  env.gain.linearRampToValueAtTime(0, t + dur);
  // Feedback tearing upward.
  const sq = s.osc('sawtooth', 1900, t, t + dur + 0.05);
  glide(sq.frequency, t, 1900, rand(6500, 7500), dur);
  s.osc('sine', 15, t, t + dur + 0.05).connect(s.gain(70)).connect(sq.detune);
  const sg = s.gain(0);
  sq.connect(s.filter('bandpass', 3500, 1.2)).connect(sg).connect(s.out);
  shape(sg.gain, t, [[0.05, 0.12 * level], [dur - 0.03, 0.2 * level], [dur, 0]]);

  // Hard cut, then ringing ears and a low hum fading.
  const t2 = t + dur;
  const tin = s.osc('sine', rand(6100, 6700), t2, t2 + 3.2);
  const tg = s.gain(0);
  tin.connect(tg).connect(s.out);
  tg.gain.setValueAtTime(0, t2);
  tg.gain.linearRampToValueAtTime(0.02 * level, t2 + 0.25);
  tg.gain.exponentialRampToValueAtTime(0.0001, t2 + 3.1);
  const hum = s.osc('sine', 46, t2, t2 + 2.2);
  const hg = s.gain(0);
  hum.connect(hg).connect(s.out);
  shape(hg.gain, t2, [[0.1, 0.25 * level], [2.1, 0]]);
  return t2 + 3.2;
}
