/**
 * Trailer soundtrack, rendered offline (OfflineAudioContext) from the game's own procedural sounds
 * (src/platform/audio/sfx.ts) plus a small score: drones, braams, risers, sub hits and a heartbeat.
 * dev/trailer/trailer.cjs calls window.__renderTrailerAudio(cues, seconds) and gets a WAV back.
 */

import { buildEngine, setPannerPosition, makePanner, SPATIAL, Shot, type Engine } from '../../src/platform/audio/engine';
import * as SFX from '../../src/platform/audio/sfx';

type Vec3 = [number, number, number];
export type Cue =
  | { t: number; k: 'sfx'; fn: keyof typeof SFX; args?: unknown[]; pos?: Vec3; gain?: number }
  | { t: number; k: 'drone'; dur: number; freq?: number; gain?: number; attack?: number; release?: number }
  | { t: number; k: 'braam'; dur?: number; gain?: number; freq?: number }
  | { t: number; k: 'riser'; dur: number; gain?: number }
  | { t: number; k: 'hit'; gain?: number }
  | { t: number; k: 'heart'; dur: number; bpm0: number; bpm1: number; gain?: number }
  | { t: number; k: 'crank'; dur: number; pos?: Vec3; gain?: number }
  | { t: number; k: 'steps'; dur: number; every: number; from: Vec3; to: Vec3; weight?: number; gain?: number }
  | { t: number; k: 'tone'; dur: number; freq: number; gain?: number }
  | { t: number; k: 'whoosh'; dur: number; gain?: number }
  | { t: number; k: 'silence'; dur: number };

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    // Pinkish: one-pole lowpassed white.
    last = last * 0.86 + (Math.random() * 2 - 1) * 0.14;
    d[i] = last * 3;
  }
  return b;
}

/** A big dark room impulse response (decaying filtered noise), for the score's reverb. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const b = ctx.createBuffer(2, Math.ceil(seconds * sr), sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4;
      d[i] = lp * Math.pow(1 - t / seconds, 3.2) * Math.exp(-t * 0.9);
    }
  }
  return b;
}

function distCurve(k: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
}

function env(p: AudioParam, t0: number, t1: number, peak: number, attack: number, release: number): void {
  p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(peak, t0 + attack);
  p.setValueAtTime(peak, Math.max(t0 + attack, t1 - release));
  p.linearRampToValueAtTime(0, t1);
}

function wav(buf: AudioBuffer): string {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); data.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, buf.sampleRate, true); data.setUint32(28, buf.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); w(36, 'data'); data.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  // Leave 1.5 dB of peak headroom before converting the float mix to PCM/AAC.
  // The score's overlapping hits can otherwise exceed full scale and hard-clip here.
  let peak = 0;
  for (const channel of chans) for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  const scale = peak > 0 ? Math.min(1, Math.pow(10, -1.5 / 20) / peak) : 1;
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i] * scale));
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  const bytes = new Uint8Array(data.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function render(cues: Cue[], seconds: number): Promise<string> {
  const sr = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  const eng = buildEngine(ctx as unknown as AudioContext) as Engine;
  eng.master.gain.value = 0.9;
  // The score: its own bus with a long reverb send, into the engine's master (and limiter).
  const score = ctx.createGain();
  score.gain.value = 1.0;
  const verb = ctx.createConvolver();
  verb.buffer = impulse(ctx, 5.5);
  const send = ctx.createGain();
  send.gain.value = 0.55;
  score.connect(eng.master);
  score.connect(send).connect(verb).connect(eng.master);
  const noise = noiseBuffer(ctx, 4);
  const dist = distCurve(2.4);

  const shotAt = (pos: Vec3 | undefined, gain = 1): Shot => {
    const s = new Shot(eng, 1, 0);
    const g = ctx.createGain();
    g.gain.value = gain;
    s.out.connect(g);
    if (pos) {
      const p = makePanner(ctx as unknown as AudioContext, SPATIAL.prop);
      setPannerPosition(p, { x: pos[0], y: pos[1], z: pos[2] });
      g.connect(p).connect(eng.world);
      g.connect(send);
    } else {
      g.connect(eng.ui);
    }
    return s;
  };

  for (const c of cues) {
    const t = c.t;
    switch (c.k) {
      case 'sfx': {
        const fn = SFX[c.fn] as unknown as (s: Shot, t: number, ...a: unknown[]) => void;
        fn(shotAt(c.pos, c.gain ?? 1), t, ...(c.args ?? []));
        break;
      }
      case 'crank': {
        for (let x = t; x < t + c.dur; x += 0.085 * (0.9 + Math.random() * 0.2)) {
          SFX.sfxCrankTick(shotAt(c.pos ?? [0.15, 1.35, -0.3], c.gain ?? 1), x, 0.94 + Math.random() * 0.12);
        }
        break;
      }
      case 'steps': {
        const n = Math.max(1, Math.floor(c.dur / c.every));
        for (let i = 0; i < n; i++) {
          const k = i / Math.max(1, n - 1);
          const p: Vec3 = [c.from[0] + (c.to[0] - c.from[0]) * k, c.from[1] + (c.to[1] - c.from[1]) * k, c.from[2] + (c.to[2] - c.from[2]) * k];
          SFX.sfxMonsterStep(shotAt(p, c.gain ?? 1), t + i * c.every + Math.random() * 0.03, c.weight ?? 0.8, 0.3);
        }
        break;
      }
      case 'drone': {
        const f = c.freq ?? 41.2;
        const g = ctx.createGain();
        env(g.gain, t, t + c.dur, c.gain ?? 0.18, c.attack ?? 2.5, c.release ?? 2.5);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 320;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.11;
        const lfoG = ctx.createGain();
        lfoG.gain.value = 140;
        lfo.connect(lfoG).connect(lp.frequency);
        lfo.start(t);
        lfo.stop(t + c.dur);
        for (const [m, type, lvl] of [[1, 'sawtooth', 0.35], [1.0035, 'sawtooth', 0.35], [0.5, 'sine', 0.9], [1.5, 'triangle', 0.12]] as const) {
          const o = ctx.createOscillator();
          o.type = type;
          o.frequency.value = f * m;
          const og = ctx.createGain();
          og.gain.value = lvl;
          o.connect(og).connect(lp);
          o.start(t);
          o.stop(t + c.dur);
        }
        // Air: a faint band of noise.
        const n = ctx.createBufferSource();
        n.buffer = noise;
        n.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 700;
        bp.Q.value = 0.4;
        const ng = ctx.createGain();
        ng.gain.value = 0.05;
        n.connect(bp).connect(ng).connect(g);
        n.start(t);
        n.stop(t + c.dur);
        lp.connect(g).connect(score);
        break;
      }
      case 'braam': {
        const dur = c.dur ?? 3.2;
        const f = c.freq ?? 55;
        const g = ctx.createGain();
        env(g.gain, t, t + dur, c.gain ?? 0.5, 0.04, dur * 0.8);
        const sh = ctx.createWaveShaper();
        sh.curve = dist;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 3;
        lp.frequency.setValueAtTime(180, t);
        lp.frequency.exponentialRampToValueAtTime(1500, t + 0.35);
        lp.frequency.exponentialRampToValueAtTime(120, t + dur);
        for (const [m, d] of [[1, 0], [1, 7], [2, -6], [3, 4], [0.5, 0]] as const) {
          const o = ctx.createOscillator();
          o.type = m === 0.5 ? 'sine' : 'sawtooth';
          o.frequency.value = f * m;
          o.detune.value = d;
          o.connect(sh);
          o.start(t);
          o.stop(t + dur);
        }
        sh.connect(lp).connect(g).connect(score);
        break;
      }
      case 'riser': {
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(c.gain ?? 0.3, t + c.dur);
        g.gain.linearRampToValueAtTime(0, t + c.dur + 0.05);
        const n = ctx.createBufferSource();
        n.buffer = noise;
        n.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 6;
        bp.frequency.setValueAtTime(300, t);
        bp.frequency.exponentialRampToValueAtTime(6000, t + c.dur);
        n.connect(bp).connect(g);
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(80, t);
        o.frequency.exponentialRampToValueAtTime(900, t + c.dur);
        const og = ctx.createGain();
        og.gain.value = 0.25;
        const olp = ctx.createBiquadFilter();
        olp.frequency.value = 2500;
        o.connect(olp).connect(og).connect(g);
        n.start(t);
        n.stop(t + c.dur + 0.1);
        o.start(t);
        o.stop(t + c.dur + 0.1);
        g.connect(score);
        break;
      }
      case 'whoosh': {
        const n = ctx.createBufferSource();
        n.buffer = noise;
        n.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 0.8;
        bp.frequency.setValueAtTime(350, t);
        bp.frequency.exponentialRampToValueAtTime(2400, t + c.dur * 0.65);
        bp.frequency.exponentialRampToValueAtTime(550, t + c.dur);
        const g = ctx.createGain();
        env(g.gain, t, t + c.dur, c.gain ?? 0.1, c.dur * 0.6, c.dur * 0.4);
        n.connect(bp).connect(g).connect(score);
        n.start(t);
        n.stop(t + c.dur);
        break;
      }
      case 'silence': {
        eng.master.gain.setValueAtTime(0.9, t);
        eng.master.gain.linearRampToValueAtTime(0, t + 0.04);
        eng.master.gain.setValueAtTime(0, t + c.dur - 0.02);
        eng.master.gain.linearRampToValueAtTime(0.9, t + c.dur);
        break;
      }
      case 'hit': {
        const g = ctx.createGain();
        g.gain.setValueAtTime(c.gain ?? 0.9, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(90, t);
        o.frequency.exponentialRampToValueAtTime(28, t + 1.2);
        o.connect(g);
        o.start(t);
        o.stop(t + 2.3);
        const n = ctx.createBufferSource();
        n.buffer = noise;
        const nlp = ctx.createBiquadFilter();
        nlp.frequency.value = 2400;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.7, t);
        ng.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
        n.connect(nlp).connect(ng).connect(g);
        n.start(t);
        n.stop(t + 0.6);
        g.connect(score);
        break;
      }
      case 'heart': {
        let x = t;
        while (x < t + c.dur) {
          const k = (x - t) / c.dur;
          const bpm = c.bpm0 + (c.bpm1 - c.bpm0) * k;
          for (const [buf, dt] of [[eng.heart.lub, 0], [eng.heart.dub, 0.16]] as const) {
            const s = ctx.createBufferSource();
            s.buffer = buf;
            const g = ctx.createGain();
            g.gain.value = (c.gain ?? 0.8) * (0.6 + 0.4 * k);
            s.connect(g).connect(eng.ui);
            s.start(x + dt);
          }
          x += 60 / bpm;
        }
        break;
      }
      case 'tone': {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = c.freq;
        const g = ctx.createGain();
        env(g.gain, t, t + c.dur, c.gain ?? 0.05, 0.6, 1.5);
        o.connect(g).connect(score);
        o.start(t);
        o.stop(t + c.dur);
        break;
      }
    }
  }
  eng.master.gain.setValueAtTime(0.9, seconds - 0.45);
  eng.master.gain.linearRampToValueAtTime(0, seconds);
  const out = await ctx.startRendering();
  return wav(out);
}

(window as unknown as { __renderTrailerAudio: typeof render }).__renderTrailerAudio = render;
