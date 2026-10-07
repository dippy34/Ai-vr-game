/**
 * Procedural one-shot recipes. Each takes a `Shot` (already routed by the caller: spatial panner,
 * monster panner or the ui bus) and a start time in AudioContext seconds, builds a small node
 * graph into `shot.out`, and extends `shot.end` through the nodes it starts.
 * Gains are internal levels; callers scale the whole sound with `shot.out.gain`.
 */

import { clamp } from '../../core/math';
import type { ItemKind } from '../../core/types';
import { chance, glide, perc, rand, swell, type NoiseKind, type Shot } from './engine';

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

interface ClickOpts {
  freq: number;
  q?: number;
  peak?: number;
  decay?: number;
  kind?: NoiseKind;
  type?: BiquadFilterType;
}

/** A train of short filtered-noise clicks from ONE noise source (cheap). `times` are offsets from t, ascending. */
export function clicks(s: Shot, t: number, times: number[], o: ClickOpts): void {
  if (times.length === 0) return;
  const last = times[times.length - 1];
  let minGap = 1;
  for (let i = 1; i < times.length; i++) minGap = Math.min(minGap, times[i] - times[i - 1]);
  const decay = Math.min(o.decay ?? 0.015, Math.max(0.002, minGap * 0.8));
  const src = s.noise(o.kind ?? 'white', t, last + decay + 0.03);
  const f = s.filter(o.type ?? 'bandpass', o.freq, o.q ?? 2);
  const g = s.gain(0);
  src.connect(f).connect(g).connect(s.out);
  const peak = o.peak ?? 0.6;
  for (const dt of times) perc(g.gain, t + dt, peak * rand(0.7, 1), 0.0008, decay);
}

/** Low thump: pitch-dropping sine + low-passed noise body + a little contact tick. */
export function thud(
  s: Shot,
  t: number,
  o: { level?: number; f0?: number; f1?: number; body?: number; dur?: number; tick?: number } = {},
): void {
  const level = o.level ?? 0.6;
  const dur = o.dur ?? 0.18;
  const osc = s.osc('sine', o.f0 ?? 150, t, t + dur + 0.05);
  glide(osc.frequency, t, o.f0 ?? 150, o.f1 ?? 60, dur * 0.6);
  const og = s.gain(0);
  osc.connect(og).connect(s.out);
  perc(og.gain, t, level, 0.003, dur);

  const n = s.noise('brown', t, dur + 0.05);
  const lp = s.filter('lowpass', o.body ?? 650, 0.9);
  const ng = s.gain(0);
  n.connect(lp).connect(ng).connect(s.out);
  perc(ng.gain, t, level * 0.9, 0.002, dur * 0.7);

  const tick = o.tick ?? 0.08;
  if (tick > 0) clicks(s, t, [0], { freq: 2600, q: 0.9, peak: level * tick, decay: 0.02 });
}

/** Inharmonic struck-metal partials (clinks, bolts, clanks). */
export function metal(s: Shot, t: number, partials: number[], decay: number, level: number): void {
  partials.forEach((f, i) => {
    const d = decay * (1 - i * 0.15);
    const o = s.osc('sine', f * rand(0.99, 1.01), t, t + d + 0.05);
    const g = s.gain(0);
    o.connect(g).connect(s.out);
    perc(g.gain, t, level / Math.sqrt(i + 1), 0.001, Math.max(0.03, d));
  });
}

/**
 * Wood creak via stick-slip: a slow sawtooth (each ramp reset = one "slip") with a wandering rate,
 * ringing two narrow resonators. Rates 7..50 Hz sound like boards; low resonance = big/heavy wood.
 */
export function creak(
  s: Shot,
  t: number,
  o: { dur: number; rateLo: number; rateHi: number; res: number; res2?: number; q?: number; level: number },
): void {
  const dur = Math.max(0.08, o.dur);
  const osc = s.osc('sawtooth', o.rateLo, t, t + dur + 0.05);
  const n = 18;
  const curve = new Float32Array(n);
  let r = rand(o.rateLo, o.rateHi);
  for (let i = 0; i < n; i++) {
    r = clamp(r + rand(-1, 1) * (o.rateHi - o.rateLo) * 0.4, o.rateLo, o.rateHi);
    curve[i] = r;
  }
  try {
    osc.frequency.setValueCurveAtTime(curve, t, dur);
  } catch {
    osc.frequency.value = (o.rateLo + o.rateHi) / 2;
  }
  const q = o.q ?? 12;
  const hp = s.filter('highpass', 180, 0.7);
  const b1 = s.filter('bandpass', o.res, q);
  const b2 = s.filter('bandpass', o.res2 ?? o.res * 2.37, q * 0.8);
  const m1 = s.gain(9);
  const m2 = s.gain(11);
  const flutter = s.gain(1);
  const env = s.gain(0);
  osc.connect(hp);
  hp.connect(b1).connect(m1).connect(flutter);
  hp.connect(b2).connect(m2).connect(flutter);
  flutter.connect(env).connect(s.out);
  // Ragged amplitude: wood does not creak smoothly.
  const fl = new Float32Array(12);
  for (let i = 0; i < fl.length; i++) fl[i] = rand(0.25, 1);
  try { flutter.gain.setValueCurveAtTime(fl, t, dur); } catch { /* ignore */ }
  const lv = Math.max(0.0002, o.level);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(lv, t + dur * 0.25);
  env.gain.setValueAtTime(lv * rand(0.6, 1), t + dur * 0.65);
  env.gain.linearRampToValueAtTime(0, t + dur);
}

/** Sustained chord pad (sawtooth through an opening lowpass). */
function pad(
  s: Shot,
  t: number,
  freqs: number[],
  o: { type?: OscillatorType; detune?: number; attack: number; hold: number; release: number; level: number; lpFrom: number; lpTo: number },
): void {
  const end = t + o.attack + o.hold + o.release;
  const lp = s.filter('lowpass', o.lpFrom, 0.8);
  glide(lp.frequency, t, o.lpFrom, o.lpTo, o.attack + o.hold * 0.5);
  const env = s.gain(0);
  lp.connect(env).connect(s.out);
  const per = 1 / Math.sqrt(freqs.length);
  for (const f of freqs) {
    const osc = s.osc(o.type ?? 'sawtooth', f, t, end + 0.05);
    osc.detune.value = rand(-1, 1) * (o.detune ?? 6);
    const g = s.gain(per);
    osc.connect(g).connect(lp);
  }
  swell(env.gain, t, o.level, o.attack, o.hold, o.release);
}

// ---------------------------------------------------------------------------------------------
// Props / player actions
// ---------------------------------------------------------------------------------------------

/** Camera flash: two-blade shutter click, xenon tick, then the capacitor whine rising as it recharges. */
export function sfxShutter(s: Shot, t: number): void {
  clicks(s, t, [0, 0.006, 0.052], { freq: 3200, q: 1.2, peak: 1.3, decay: 0.02 });
  const body = s.osc('square', 1400, t, t + 0.06);
  glide(body.frequency, t, 1400, 480, 0.04);
  const bbp = s.filter('bandpass', 1200, 3);
  const bg = s.gain(0);
  body.connect(bbp).connect(bg).connect(s.out);
  perc(bg.gain, t, 0.18, 0.001, 0.035);
  clicks(s, t + 0.004, [0], { freq: 6000, type: 'highpass', q: 0.7, peak: 0.35, decay: 0.012 });

  // Recharge whine (quiet, slightly unstable).
  const t0 = t + 0.18;
  const w = s.osc('sine', 1700, t0, t + 2.7);
  glide(w.frequency, t0, 1700, 8600, 2.1);
  const w2 = s.osc('sine', 3420, t0, t + 2.7);
  glide(w2.frequency, t0, 3420, Math.min(17200, s.eng.nyquistSafe), 2.1);
  const wg = s.gain(0);
  const w2g = s.gain(0.18);
  w.connect(wg);
  w2.connect(w2g).connect(wg);
  wg.connect(s.out);
  wg.gain.setValueAtTime(0, t0);
  wg.gain.linearRampToValueAtTime(0.028, t0 + 0.4);
  wg.gain.setValueAtTime(0.028, t0 + 1.7);
  wg.gain.linearRampToValueAtTime(0, t + 2.65);
}

/** Trigger pulled with no film: small mechanical click. */
export function sfxDryFire(s: Shot, t: number): void {
  clicks(s, t, [0, 0.011], { freq: 2600, q: 3, peak: 1.0, decay: 0.012 });
  const o = s.osc('square', 520, t, t + 0.03);
  glide(o.frequency, t, 520, 280, 0.02);
  const g = s.gain(0);
  o.connect(s.filter('lowpass', 1500)).connect(g).connect(s.out);
  perc(g.gain, t, 0.05, 0.001, 0.02);
}

/** Pickup: soft clink, colored by what was picked up. */
export function sfxPickup(s: Shot, t: number, what: 'camera' | ItemKind): void {
  if (what === 'fuse') metal(s, t, [2380, 3910, 5420], 0.28, 0.1);
  else if (what === 'film') {
    metal(s, t, [1650, 2730, 4100], 0.12, 0.06);
    clicks(s, t + 0.03, [0, 0.045, 0.08], { freq: 4200, q: 2, peak: 0.35, decay: 0.01 });
  } else metal(s, t, [1180, 2150, 3320], 0.1, 0.05);
  // Handling rustle.
  const n = s.noise('pink', t, 0.2);
  const bp = s.filter('bandpass', 1400, 0.8);
  const g = s.gain(0);
  n.connect(bp).connect(g).connect(s.out);
  perc(g.gain, t, 0.07, 0.02, 0.12);
}

/** Drop: thud, plus a rattle for the camera or a tinkle for a fuse. */
export function sfxDrop(s: Shot, t: number, what: 'camera' | ItemKind): void {
  thud(s, t, { level: what === 'camera' ? 0.7 : 0.45, f0: 160, f1: 70, body: 700, dur: 0.16, tick: 0.15 });
  if (what === 'camera') clicks(s, t + 0.04, [0, 0.03, 0.075, 0.13], { freq: 2900, q: 1.6, peak: 0.6, decay: 0.02 });
  else if (what === 'fuse') metal(s, t + 0.01, [2380, 3910], 0.18, 0.05);
}

/** Film loaded: two ratchet winding strokes and a final snap. */
export function sfxRatchet(s: Shot, t: number): void {
  for (let k = 0; k < 2; k++) {
    const base = k * 0.42;
    const times: number[] = [];
    let dt = 0;
    for (let i = 0; i < 7; i++) {
      times.push(base + dt);
      dt += 0.05 - i * 0.003;
    }
    clicks(s, t, times, { freq: rand(2700, 3200), q: 3, peak: 0.6, decay: 0.012 });
    const n = s.noise('pink', t + base, 0.32);
    const bp = s.filter('bandpass', 1800, 0.6);
    const g = s.gain(0);
    n.connect(bp).connect(g).connect(s.out);
    swell(g.gain, t + base, 0.03, 0.05, 0.15, 0.1);
  }
  clicks(s, t + 0.9, [0, 0.005], { freq: 2200, q: 1.5, peak: 0.6, decay: 0.03 });
  thud(s, t + 0.9, { level: 0.15, f0: 420, f1: 200, body: 1500, dur: 0.06, tick: 0 });
}

/** Fuse inserted: clunk, relay click, then an electrical buzz (longer + power-up whine when the last one goes in). */
export function sfxFuse(s: Shot, t: number, complete: boolean): void {
  thud(s, t, { level: 0.5, f0: 180, f1: 70, body: 900, dur: 0.16 });
  metal(s, t, [620, 1012, 1530], 0.3, 0.1);
  clicks(s, t + 0.16, [0, 0.004], { freq: 3800, q: 2, peak: 1.0, decay: 0.01 });

  const tb = t + 0.18;
  const dur = complete ? 2.8 : 1.4;
  const saw = s.osc('sawtooth', 60, tb, tb + dur + 0.6);
  const sq = s.osc('square', 120.4, tb, tb + dur + 0.6);
  const sqg = s.gain(0.35);
  const mix = s.gain(1);
  saw.connect(mix);
  sq.connect(sqg).connect(mix);
  const gb = s.gain(0);
  mix.connect(s.shaper(s.eng.curves.soft)).connect(s.filter('bandpass', 380, 1.2)).connect(s.filter('highpass', 140)).connect(gb).connect(s.out);
  gb.gain.setValueAtTime(0, tb);
  gb.gain.linearRampToValueAtTime(0.16, tb + 0.04);
  gb.gain.setTargetAtTime(0.07, tb + 0.08, 0.15);
  gb.gain.setTargetAtTime(0, tb + dur, 0.15);
  // Crackle.
  const times: number[] = [];
  let x = rand(0.02, 0.15);
  while (x < dur * 0.85) {
    times.push(x);
    x += rand(0.06, 0.3);
  }
  clicks(s, tb, times, { freq: 5000, q: 0.8, peak: 0.25, decay: 0.006 });
  if (complete) {
    const w = s.osc('sine', 90, tb, tb + 2.4);
    glide(w.frequency, tb, 90, 420, 1.8);
    const wg = s.gain(0);
    w.connect(wg).connect(s.out);
    swell(wg.gain, tb, 0.06, 0.8, 0.8, 0.7);
  }
}

/** Exit door: three heavy bolts, a chain rattle, a long agonizing creak and the door hitting its stop. */
export function sfxExitDoor(s: Shot, t: number): void {
  [0, 0.32, 0.58].forEach((dt, i) => {
    thud(s, t + dt, { level: 0.9, f0: 120, f1: 45, body: 700, dur: 0.35, tick: 0.2 });
    metal(s, t + dt, [233 * (1 + i * 0.07), 371, 547, 811], 0.6, 0.16);
  });
  const rattle: number[] = [];
  for (let x = 0; x < 0.9; x += rand(0.03, 0.055)) rattle.push(x);
  clicks(s, t + 0.75, rattle, { freq: 2200, q: 1.5, peak: 0.8, decay: 0.02 });
  creak(s, t + 1.3, { dur: 4.2, rateLo: 7, rateHi: 26, res: 380, res2: 940, q: 12, level: 0.9 });
  thud(s, t + 5.45, { level: 0.85, f0: 90, f1: 38, body: 400, dur: 0.7, tick: 0.1 });
}

/** Creaky wooden floor step. `loudness` uses the NOISE.*Step scale (0.06 sneak .. 0.45 sprint). */
export function sfxWoodStep(s: Shot, t: number, loudness: number, creakChance = 0.25): void {
  const L = clamp(0.2 + loudness * 2.0, 0.15, 1.2);
  thud(s, t, { level: 0.45 * L, f0: 120, f1: 65, body: 520, dur: 0.09, tick: 0 });
  // Board knock: mid band so it survives tiny speakers.
  const n = s.noise('brown', t, 0.12);
  const bp = s.filter('bandpass', rand(260, 340), 1.2);
  const g = s.gain(0);
  n.connect(bp).connect(g).connect(s.out);
  perc(g.gain, t, 0.6 * L, 0.002, 0.08);
  clicks(s, t + 0.005, [0], { freq: 2400, q: 0.9, peak: 0.07 * L, decay: 0.05 });
  if (chance(creakChance + loudness * 0.4)) {
    creak(s, t + rand(0.02, 0.06), { dur: rand(0.15, 0.4), rateLo: 18, rateHi: 45, res: rand(600, 1400), q: 10, level: 0.3 * L });
  }
}

// ---------------------------------------------------------------------------------------------
// Monster
// ---------------------------------------------------------------------------------------------

/** Heavy monster footstep. weight 0..1 (speed), drag 0..1 (slow = dragging feet). */
export function sfxMonsterStep(s: Shot, t: number, weight: number, drag: number): void {
  const W = 0.4 + 0.45 * clamp(weight, 0, 1);
  const o = s.osc('sine', 70, t, t + 0.4);
  glide(o.frequency, t, 72, 34, 0.12);
  const og = s.gain(0);
  o.connect(og).connect(s.out);
  perc(og.gain, t, 1.0 * W, 0.004, 0.32);

  const n = s.noise('brown', t, 0.3);
  const lp = s.filter('lowpass', 280, 1);
  const ng = s.gain(0);
  n.connect(lp).connect(ng).connect(s.out);
  perc(ng.gain, t, 0.9 * W, 0.003, 0.22);

  // Floorboard flex, audible on small speakers.
  const b = s.osc('square', 150, t, t + 0.12);
  glide(b.frequency, t, 150, 85, 0.08);
  const bg = s.gain(0);
  b.connect(s.filter('lowpass', 520, 1.5)).connect(bg).connect(s.out);
  perc(bg.gain, t, 0.13 * W, 0.002, 0.09);

  // Toe/claw scrape.
  const d = clamp(drag, 0, 1);
  const sc = s.noise('white', t + 0.02, 0.2 + d * 0.5);
  const sbp = s.filter('bandpass', rand(1300, 2000), 0.7);
  const sg = s.gain(0);
  sc.connect(sbp).connect(s.filter('highpass', 600)).connect(sg).connect(s.out);
  swell(sg.gain, t + 0.02, 0.07 * (0.4 + d), 0.04, d * 0.3, 0.15);

  if (chance(0.25 + 0.3 * weight)) clicks(s, t + 0.01, [0, rand(0.015, 0.03)], { freq: rand(3800, 4800), q: 4, peak: 0.8, decay: 0.01 });
  if (chance(0.3)) creak(s, t + rand(0.03, 0.08), { dur: rand(0.3, 0.7), rateLo: 9, rateHi: 24, res: rand(380, 700), q: 11, level: 0.4 * W });
}

/** On all fours: a knuckle / knee knock and a dragging scrape. Climbing: wood knocks and creaks. */
export function sfxMonsterCrawl(s: Shot, t: number, climbing: boolean): void {
  thud(s, t, {
    level: climbing ? 0.3 : 0.2,
    f0: climbing ? 190 : 120,
    f1: climbing ? 95 : 58,
    body: climbing ? 1200 : 600,
    dur: 0.1,
    tick: 0.12,
  });
  const sc = s.noise('white', t + 0.03, 0.5);
  const bp = s.filter('bandpass', rand(900, 1600), 0.8);
  const g = s.gain(0);
  sc.connect(bp).connect(s.filter('highpass', 400)).connect(g).connect(s.out);
  swell(g.gain, t + 0.03, 0.06, 0.08, rand(0.05, 0.2), 0.15);
  if (climbing && chance(0.6)) {
    creak(s, t + rand(0.05, 0.15), { dur: rand(0.3, 0.6), rateLo: 10, rateHi: 30, res: rand(450, 900), q: 11, level: 0.35 });
  }
}

/** Sharp hissing intake: the wind-up tell before a sweep. */
export function sfxHiss(s: Shot, t: number): void {
  const n = s.noise('white', t, 0.6);
  const bp = s.filter('bandpass', 3800, 1.4);
  bp.frequency.setValueAtTime(2600, t);
  bp.frequency.linearRampToValueAtTime(5200, t + 0.4);
  const g = s.gain(0);
  n.connect(s.filter('highpass', 1500)).connect(bp).connect(g).connect(s.out);
  swell(g.gain, t, 0.5, 0.25, 0.1, 0.12);
}

/** Long arms cutting the air (the sweep's strike), with a low body thump. */
export function sfxWhoosh(s: Shot, t: number, level = 0.8): void {
  const n = s.noise('pink', t, 0.6);
  const bp = s.filter('bandpass', 400, 1.6);
  glide(bp.frequency, t, 380, 2400, 0.16);
  bp.frequency.exponentialRampToValueAtTime(500, t + 0.4);
  const g = s.gain(0);
  n.connect(bp).connect(g).connect(s.out);
  swell(g.gain, t, level, 0.09, 0.06, 0.25);
  thud(s, t + 0.12, { level: 0.25 * level, f0: 90, f1: 45, body: 300, dur: 0.15, tick: 0 });
}

/** Claws feeling over wood and fabric (searching). */
export function sfxClawScrape(s: Shot, t: number): void {
  const k = 2 + Math.floor(Math.random() * 3);
  const times: number[] = [];
  let x = 0;
  for (let i = 0; i < k; i++) {
    times.push(x);
    x += rand(0.06, 0.16);
  }
  clicks(s, t, times, { freq: rand(2800, 4200), q: 3, peak: 0.5, decay: 0.015 });
  const n = s.noise('white', t, x + 0.3);
  const bp = s.filter('bandpass', rand(1800, 3000), 1.2);
  const g = s.gain(0);
  n.connect(bp).connect(g).connect(s.out);
  swell(g.gain, t, 0.05, 0.05, x, 0.12);
}

/** Echolocation-like tongue clicks (investigating / listening). */
export function sfxMonsterClicks(s: Shot, t: number): void {
  const n = 4 + Math.floor(Math.random() * 5);
  const times: number[] = [];
  let x = 0;
  let gap = rand(0.08, 0.11);
  for (let i = 0; i < n; i++) {
    times.push(x);
    x += gap;
    gap = Math.max(0.032, gap * rand(0.75, 0.9));
  }
  const f = rand(2200, 3600);
  clicks(s, t, times, { freq: f, q: 4, peak: 1.6, decay: 0.012 });
  clicks(s, t + 0.002, times, { freq: f * 0.42, q: 6, peak: 0.6, decay: 0.02, kind: 'pink' });
}

/** Wet sniffing: a few sharp inhales and a snort. */
export function sfxSniff(s: Shot, t: number): void {
  const n = 2 + Math.floor(Math.random() * 3);
  const src = s.noise('pink', t, n * 0.22 + 0.5);
  const hp = s.filter('highpass', 900);
  const bp = s.filter('bandpass', 2500, 1.5);
  const g = s.gain(0);
  src.connect(hp).connect(bp).connect(g).connect(s.out);
  let x = 0;
  for (let i = 0; i < n; i++) {
    const len = rand(0.09, 0.14);
    perc(g.gain, t + x, 1.2, 0.03, len);
    bp.frequency.setValueAtTime(2500, t + x);
    bp.frequency.linearRampToValueAtTime(4200, t + x + len);
    x += len + rand(0.05, 0.09);
  }
  const ex = s.noise('brown', t + x + 0.1, 0.4);
  const ebp = s.filter('bandpass', 700, 2);
  const eg = s.gain(0);
  ex.connect(ebp).connect(eg).connect(s.out);
  perc(eg.gain, t + x + 0.1, 0.35, 0.02, 0.25);
}

/** Low, rattling growl (monster starts investigating). */
export function sfxGrowl(s: Shot, t: number, dur = 1.9, level = 0.9): void {
  const f = rand(46, 56);
  const mix = s.gain(1);
  for (const [type, ratio, lv] of [['sawtooth', 1, 0.5], ['sawtooth', 1.031, 0.5], ['square', 0.5, 0.35]] as const) {
    const o = s.osc(type, f * ratio, t, t + dur + 0.05);
    o.frequency.setValueAtTime(f * ratio * 0.9, t);
    o.frequency.linearRampToValueAtTime(f * ratio * 1.08, t + 0.4);
    o.frequency.linearRampToValueAtTime(f * ratio * 0.86, t + dur);
    o.connect(s.gain(lv)).connect(mix);
  }
  const lp = s.filter('lowpass', 280, 5);
  lp.frequency.setValueAtTime(280, t);
  lp.frequency.linearRampToValueAtTime(950, t + 0.35);
  lp.frequency.linearRampToValueAtTime(420, t + dur);
  // Vocal-fry rattle via amplitude modulation.
  const am = s.gain(0.5);
  const lfo = s.osc('sawtooth', rand(22, 30), t, t + dur + 0.05);
  lfo.connect(s.gain(0.5)).connect(am.gain);
  const env = s.gain(0);
  mix.connect(s.shaper(s.eng.curves.hard)).connect(lp).connect(am).connect(env).connect(s.out);
  const br = s.noise('brown', t, dur);
  br.connect(s.filter('bandpass', 420, 1)).connect(s.gain(0.45)).connect(am);
  swell(env.gain, t, level, 0.3, Math.max(0.1, dur - 0.9), 0.6);
}

/** Horrible chase shriek: detuned inharmonic saws + rasp, brutally distorted, with vibrato. */
export function sfxShriek(s: Shot, t: number, level = 1): void {
  const dur = 1.7;
  const base = rand(560, 640);
  const mix = s.gain(1);
  const vib = s.osc('sine', rand(6.5, 8.5), t, t + dur + 0.05);
  const vibDepth = s.gain(45);
  vib.connect(vibDepth);
  const jit = s.osc('sawtooth', rand(11, 15), t, t + dur + 0.05);
  const jitDepth = s.gain(25);
  jit.connect(jitDepth);
  for (const [r, lv] of [[1, 0.28], [1.059, 0.28], [1.414, 0.22], [1.89, 0.16], [0.5, 0.4]] as const) {
    const f = base * r;
    const o = s.osc('sawtooth', f, t, t + dur + 0.05);
    o.frequency.setValueAtTime(f * 0.55, t);
    o.frequency.exponentialRampToValueAtTime(f * 1.22, t + 0.18);
    o.frequency.exponentialRampToValueAtTime(f * 1.05, t + 0.7);
    o.frequency.exponentialRampToValueAtTime(f * 0.62, t + dur);
    vibDepth.connect(o.detune);
    jitDepth.connect(o.detune);
    o.connect(s.gain(lv)).connect(mix);
  }
  const rasp = s.noise('white', t, dur);
  rasp.connect(s.filter('bandpass', 2800, 0.7)).connect(s.gain(0.5)).connect(mix);
  const roar = s.osc('sawtooth', 78, t, t + dur + 0.05);
  const env = s.gain(0);
  roar.connect(s.shaper(s.eng.curves.hard)).connect(s.filter('lowpass', 500)).connect(s.gain(0.45)).connect(env);
  mix
    .connect(s.shaper(s.eng.curves.brutal, '2x'))
    .connect(s.filter('highpass', 250))
    .connect(s.filter('peaking', 1500, 1.1, 6))
    .connect(s.filter('lowpass', 7000))
    .connect(env)
    .connect(s.out);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(level * 0.8, t + 0.04);
  env.gain.setTargetAtTime(level * 0.6, t + 0.2, 0.2);
  env.gain.setTargetAtTime(0, t + dur - 0.5, 0.15);
}

/** One wet crunch while the monster feeds: bone cracks, gritty crunching, a squelch and a slap. */
export function sfxCrunch(s: Shot, t: number, level = 1): void {
  const cracks: number[] = [];
  let x = 0;
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    cracks.push(x);
    x += rand(0.02, 0.05);
  }
  clicks(s, t, cracks, { freq: rand(900, 1600), q: 6, peak: 2.0 * level, decay: 0.03 });
  const grit: number[] = [];
  for (let y = 0; y < 0.16; y += rand(0.008, 0.016)) grit.push(y);
  clicks(s, t + 0.01, grit, { freq: 3000, q: 0.7, peak: 0.4 * level, decay: 0.006 });
  const sq = s.noise('pink', t + 0.05, 0.4);
  const bp = s.filter('bandpass', 350, 7);
  bp.frequency.setValueAtTime(350, t + 0.05);
  bp.frequency.exponentialRampToValueAtTime(rand(1100, 1600), t + 0.18);
  bp.frequency.exponentialRampToValueAtTime(600, t + 0.4);
  const sg = s.gain(0);
  sq.connect(bp).connect(sg).connect(s.out);
  swell(sg.gain, t + 0.05, 0.9 * level, 0.04, 0.12, 0.2);
  const slap = s.noise('brown', t + 0.02, 0.2);
  const g = s.gain(0);
  slap.connect(s.filter('lowpass', 500)).connect(g).connect(s.out);
  perc(g.gain, t + 0.02, 0.5 * level, 0.003, 0.15);
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

/** Scream-ish cry of a teammate being caught (formant-filtered, gliding saw). */
export function sfxScream(s: Shot, t: number, level = 0.9): void {
  const dur = 1.25;
  const f0 = rand(380, 460);
  const o = s.osc('sawtooth', f0, t, t + dur + 0.05);
  o.frequency.setValueAtTime(f0 * 0.8, t);
  o.frequency.exponentialRampToValueAtTime(f0 * 1.7, t + 0.12);
  o.frequency.linearRampToValueAtTime(f0 * 1.55, t + 0.6);
  o.frequency.exponentialRampToValueAtTime(f0 * 0.75, t + dur);
  const vib = s.osc('sine', 5.5, t, t + dur + 0.05);
  vib.connect(s.gain(35)).connect(o.detune);
  const jit = s.osc('sawtooth', 11, t, t + dur + 0.05);
  jit.connect(s.gain(20)).connect(o.detune);
  const sum = s.gain(1);
  for (const [f, q, g] of [[850, 6, 1], [1250, 7, 0.6], [2800, 9, 0.35]] as const) {
    o.connect(s.filter('bandpass', f, q)).connect(s.gain(g * 2.2)).connect(sum);
  }
  s.noise('white', t, dur).connect(s.filter('bandpass', 1800, 0.8)).connect(s.gain(0.12)).connect(sum);
  const env = s.gain(0);
  sum.connect(s.shaper(s.eng.curves.soft)).connect(s.filter('lowpass', 3500)).connect(env).connect(s.out);
  swell(env.gain, t, level, 0.05, 0.6, 0.6);
}

/** Local player caught: violent non-spatial sting, then the ears ring. */
export function sfxCaughtSting(s: Shot, t: number): void {
  const n = s.noise('white', t, 1.3);
  const nlp = s.filter('lowpass', 9000, 1);
  glide(nlp.frequency, t, 9000, 500, 1.2);
  const ng = s.gain(0);
  n.connect(s.shaper(s.eng.curves.brutal)).connect(nlp).connect(ng).connect(s.out);
  perc(ng.gain, t, 0.55, 0.002, 1.2);

  const sub = s.osc('sine', 110, t, t + 1.6);
  glide(sub.frequency, t, 110, 28, 1.0);
  const sg = s.gain(0);
  sub.connect(s.shaper(s.eng.curves.soft)).connect(sg).connect(s.out);
  perc(sg.gain, t, 0.9, 0.004, 1.4);

  const cl = s.gain(1);
  for (const f of [98, 103.8, 146.8, 155.6, 207.7, 220]) {
    s.osc('sawtooth', f, t, t + 3).connect(s.gain(0.12)).connect(cl);
  }
  const clp = s.filter('lowpass', 5000, 2);
  glide(clp.frequency, t, 5000, 300, 2.5);
  const cg = s.gain(0);
  cl.connect(s.shaper(s.eng.curves.hard)).connect(clp).connect(cg).connect(s.out);
  perc(cg.gain, t, 0.6, 0.01, 2.8);

  const sc = s.osc('sawtooth', 1900, t, t + 0.9);
  glide(sc.frequency, t, 1900, 2600, 0.4);
  s.osc('sine', 14, t, t + 0.9).connect(s.gain(80)).connect(sc.detune);
  const scg = s.gain(0);
  sc.connect(s.filter('bandpass', 2500, 2)).connect(scg).connect(s.out);
  swell(scg.gain, t, 0.22, 0.01, 0.3, 0.5);

  // Tinnitus.
  const tin = s.osc('sine', rand(6000, 6800), t + 0.6, t + 9.2);
  const tg = s.gain(0);
  tin.connect(tg).connect(s.out);
  tg.gain.setValueAtTime(0, t + 0.6);
  tg.gain.linearRampToValueAtTime(0.014, t + 1.3);
  tg.gain.exponentialRampToValueAtTime(0.0001, t + 9.1);
}

/** Someone escaped: soft relief tone. */
export function sfxRelief(s: Shot, t: number, level = 0.1): void {
  pad(s, t, [440, 554.37, 659.25, 880], { type: 'sine', attack: 0.6, hold: 0.4, release: 2.5, level, lpFrom: 3000, lpTo: 3000, detune: 4 });
}

// ---------------------------------------------------------------------------------------------
// Round
// ---------------------------------------------------------------------------------------------

/** Won: uplifting D major (add 9) swell. */
export function sfxWin(s: Shot, t: number): void {
  pad(s, t, [73.42, 146.83, 220, 293.66, 369.99, 440, 659.25], { attack: 2.5, hold: 1.5, release: 4, level: 0.22, lpFrom: 300, lpTo: 4000, detune: 7 });
  pad(s, t + 0.3, [293.66, 369.99, 440], { type: 'triangle', attack: 2.2, hold: 1.5, release: 4, level: 0.08, lpFrom: 3000, lpTo: 3000, detune: 9 });
  const n = s.noise('white', t, 6);
  const g = s.gain(0);
  n.connect(s.filter('highpass', 6000)).connect(g).connect(s.out);
  swell(g.gain, t, 0.008, 2.5, 1, 2.5);
}

/** Lost: low dissonant hit with a sick, beating after-ring. */
export function sfxLose(s: Shot, t: number): void {
  const cl = s.gain(1);
  for (const f of [32.7, 34.65, 46.25, 49.0, 69.3]) s.osc('sawtooth', f, t, t + 5.2).connect(s.gain(0.22)).connect(cl);
  const lp = s.filter('lowpass', 900, 3);
  glide(lp.frequency, t, 900, 120, 4);
  const cg = s.gain(0);
  cl.connect(s.shaper(s.eng.curves.hard)).connect(lp).connect(cg).connect(s.out);
  perc(cg.gain, t, 0.7, 0.01, 5);
  thud(s, t, { level: 0.9, f0: 55, f1: 27, body: 300, dur: 2.5, tick: 0 });
  const hi = s.gain(0);
  for (const f of [1244.5, 1318.5]) s.osc('sine', f, t, t + 5.6).connect(hi);
  hi.connect(s.out);
  swell(hi.gain, t + 0.2, 0.025, 1.5, 1, 2.8);
}

/** Round start: a reversed-noise swell and a rising, beating cluster that cuts to a distant boom. */
export function sfxRoundStart(s: Shot, t: number): void {
  const n = s.noise('pink', t, 2.4);
  const bp = s.filter('bandpass', 300, 1.5);
  glide(bp.frequency, t, 300, 2600, 2.1);
  const ng = s.gain(0);
  n.connect(bp).connect(ng).connect(s.out);
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(0.12, t + 2.1);
  ng.gain.linearRampToValueAtTime(0, t + 2.2);
  const cg = s.gain(0);
  for (const f of [196, 207.65, 293.66, 311.13]) {
    const o = s.osc('sine', f, t, t + 2.7);
    glide(o.frequency, t, f, f * 1.06, 2.2);
    o.connect(cg);
  }
  cg.connect(s.out);
  swell(cg.gain, t, 0.035, 1.8, 0.2, 0.6);
  thud(s, t + 2.2, { level: 0.35, f0: 80, f1: 35, body: 250, dur: 1.0, tick: 0 });
}

// ---------------------------------------------------------------------------------------------
// House
// ---------------------------------------------------------------------------------------------

/** Settling knocks inside a wall (1-3). */
export function sfxKnock(s: Shot, t: number, count: number): void {
  let x = 0;
  for (let i = 0; i < count; i++) {
    thud(s, t + x, { level: 0.2, f0: 210, f1: 110, body: 1100, dur: 0.12, tick: 0.1 });
    x += rand(0.12, 0.38);
  }
}

/** Pipe/beam ticking as the house cools. */
export function sfxTicks(s: Shot, t: number): void {
  const times: number[] = [];
  let x = 0;
  const n = 2 + Math.floor(Math.random() * 4);
  for (let i = 0; i < n; i++) {
    times.push(x);
    x += rand(0.18, 0.7);
  }
  clicks(s, t, times, { freq: rand(1500, 2600), q: 5, peak: 2.0, decay: 0.03 });
}
