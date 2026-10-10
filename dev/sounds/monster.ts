/**
 * Renders the monster voice v2 (src/platform/audio/monsterVoice.ts) offline, for the owner to
 * approve before it goes into the game. dev/sounds/render.cjs calls
 * window.__renderMonsterSound(name) and gets a WAV back.
 *
 * Each preview plays through the game's own engine (master bus + compressor) with a light
 * house-sized room reverb, the monster a few metres away unless it is in your face.
 */

import { buildEngine, chance, rand, Shot, type Engine } from '../../src/platform/audio/engine';
import { sfxMonsterStep, sfxWoodStep } from '../../src/platform/audio/sfx';
import * as V from '../../src/platform/audio/monsterVoice';

interface Ctx {
  ctx: OfflineAudioContext;
  eng: Engine;
  /** A one-shot routed to the mix: gain, stereo pan (-1..1), reverb send. */
  shot: (gain?: number, pan?: number, wet?: number) => Shot;
  /** A bus for continuous layers. */
  bus: (gain?: number, pan?: number, wet?: number) => GainNode;
}

type Play = (c: Ctx) => void;

/** Resting: breaths back to back, with one-shots scattered between them (never the same twice). */
function resting(c: Ctx, from: number, until: number, oneShots = true): void {
  let t = from;
  while (t < until - 3) t = V.sfxMonsterBreath(c.shot(0.75, -0.2), t, rand(0.8, 1)) + rand(0.3, 0.9);
  if (!oneShots) return;
  const pool = [
    (s: Shot, at: number) => V.sfxMonsterCroak(s, at),
    (s: Shot, at: number) => V.sfxMonsterWhisper(s, at),
    (s: Shot, at: number) => V.sfxBoneCracks(s, at),
    (s: Shot, at: number) => V.sfxMonsterCroak(s, at),
    (s: Shot, at: number) => V.sfxStolenWhimper(s, at, 0.85),
    (s: Shot, at: number) => V.sfxStolenLullaby(s, at, 0.85),
  ];
  let last = -1;
  let x = from + rand(1.5, 3);
  while (x < until - 4) {
    let i = Math.floor(Math.random() * pool.length);
    if (i === last) i = (i + 1) % pool.length;
    last = i;
    const end = pool[i](c.shot(0.8, rand(-0.5, 0.3)), x);
    x = end + rand(2, 4.5);
  }
}

/** The listening layer following your noise level (sampled at 30 Hz). */
function listen(c: Ctx, from: number, until: number, level: (t: number) => number, pan = -0.15): V.MonsterListening {
  const l = new V.MonsterListening(c.eng, from);
  l.out.connect(c.bus(1, pan, 0.25));
  for (let t = from; t <= until; t += 1 / 30) l.set(level(t), t);
  l.stop(until);
  return l;
}

const SOUNDS: Record<string, { dur: number; play: Play }> = {
  rest_breath: {
    dur: 11.5,
    play: (c) => {
      let t = 0.4;
      for (let i = 0; i < 3; i++) t = V.sfxMonsterBreath(c.shot(1, -0.2), t) + rand(0.4, 0.8);
    },
  },
  rest_croak: {
    dur: 7,
    play: (c) => {
      V.sfxMonsterCroak(c.shot(1, -0.2), 0.4);
      V.sfxMonsterCroak(c.shot(1, 0.15), 3.8);
    },
  },
  rest_whisper: {
    dur: 8,
    play: (c) => {
      const e = V.sfxMonsterWhisper(c.shot(1, -0.3), 0.4);
      V.sfxMonsterWhisper(c.shot(1, 0.25), e + 1.0);
    },
  },
  rest_tom: { dur: 6, play: (c) => void V.sfxStolenWhimper(c.shot(1, -0.15), 0.4) },
  rest_ellie: { dur: 7, play: (c) => void V.sfxStolenLullaby(c.shot(1, 0.15), 0.4) },
  rest_bones: {
    dur: 6,
    play: (c) => {
      const e = V.sfxBoneCracks(c.shot(1, -0.2), 0.4);
      V.sfxBoneCracks(c.shot(1, 0.1), Math.max(e + 1, 3.2));
    },
  },
  rest_mix: { dur: 32, play: (c) => resting(c, 0.4, 32) },
  // Your footsteps go from tiptoeing to stomping; it listens harder and harder.
  listening: {
    dur: 15,
    play: (c) => {
      const loud = (t: number) => Math.min(1, Math.max(0, (t - 0.8) / 11.5));
      for (let t = 0.8; t < 13.2; t += 0.56) sfxWoodStep(c.shot(1.0, 0.05, 0.1), t, 0.05 + 0.95 * loud(t), 0.1);
      // It reacts a beat behind you.
      listen(c, 0, 14.4, (t) => loud(t - 0.4) ** 0.9);
    },
  },
  activate_1: { dur: 3.8, play: (c) => void V.sfxMonsterActivate(c.shot(1, -0.1), 0.3) },
  activate_2: { dur: 3.8, play: (c) => void V.sfxMonsterActivate(c.shot(1, 0.1), 0.3) },
  activate_3: { dur: 3.8, play: (c) => void V.sfxMonsterActivate(c.shot(1, -0.05), 0.3) },
  jumpscare_1: { dur: 5, play: (c) => void V.sfxMonsterJumpscare(c.shot(1, 0, 0.08), 0.3) },
  jumpscare_2: { dur: 5, play: (c) => void V.sfxMonsterJumpscare(c.shot(1, 0, 0.08), 0.3) },
  // How it plays: it rests, you start walking, it listens, it hears you, the chase, the catch.
  scene: {
    dur: 27,
    play: (c) => {
      resting(c, 0.3, 8.6, false);
      V.sfxStolenLullaby(c.shot(0.7, -0.35), 2.2, 0.85);
      const walkFrom = 8.4;
      const loud = (t: number) => Math.min(1, Math.max(0, (t - walkFrom) / 7));
      for (let t = walkFrom; t < 15.8; t += 0.58) sfxWoodStep(c.shot(1.0, 0.05, 0.1), t, 0.08 + 0.85 * loud(t), 0.15);
      listen(c, 8.4, 16.0, (t) => loud(t - 0.4), -0.25);
      const act = 16.0;
      const end = V.sfxMonsterActivate(c.shot(1, -0.25), act);
      // It charges: heavy running steps closing in, then the catch.
      const catchAt = end + 1.6;
      for (let t = act + 1.9; t < catchAt - 0.1; t += 0.27) {
        const k = (t - act - 1.9) / (catchAt - act - 2);
        sfxMonsterStep(c.shot(0.5 + 0.9 * k, -0.25 * (1 - k)), t, 1, 0);
      }
      for (let t = act + 2.2; t < catchAt; t += 0.5) if (chance(0.8)) V.sfxMonsterCroak(c.shot(0.25), t, 0.4);
      V.sfxMonsterJumpscare(c.shot(1.05, 0, 0.08), catchAt);
    },
  },
};

/** A house-sized room: 1.6 s of decaying, darkening noise (stereo). */
function room(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const b = ctx.createBuffer(2, Math.ceil(seconds * sr), sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const k = 0.35 + 0.6 * Math.min(1, t / seconds);
      lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
      d[i] = lp * Math.exp(-t * 4.2) * (i < sr * 0.012 ? i / (sr * 0.012) : 1);
    }
  }
  return b;
}

function wav(buf: AudioBuffer): { b64: string; peak: number; rms: number } {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); data.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, buf.sampleRate, true); data.setUint32(28, buf.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); w(36, 'data'); data.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let peak = 0;
  let sum = 0;
  let nan = 0;
  for (const c of chans) for (const v of c) {
    if (!Number.isFinite(v)) nan++;
    else { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
  }
  if (nan) throw new Error(`${nan} non-finite samples`);
  const scale = peak > 0 ? Math.min(1, 0.89 / peak) : 1;
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
  return { b64: btoa(s), peak, rms: Math.sqrt(sum / (len * ch)) };
}

async function render(name: string): Promise<{ b64: string; peak: number; rms: number; seconds: number }> {
  const sound = SOUNDS[name];
  if (!sound) throw new Error(`unknown sound ${name}: ${Object.keys(SOUNDS).join(', ')}`);
  const sr = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(sound.dur * sr), sr);
  const eng = buildEngine(ctx as unknown as AudioContext);
  eng.master.gain.value = 0.9;
  const verb = ctx.createConvolver();
  verb.buffer = room(ctx, 1.6);
  verb.connect(eng.master);
  const route = (node: AudioNode, gain: number, pan: number, wet: number) => {
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    node.connect(g).connect(p);
    p.connect(eng.master);
    const send = ctx.createGain();
    send.gain.value = wet;
    p.connect(send).connect(verb);
  };
  const c: Ctx = {
    ctx,
    eng,
    shot: (gain = 1, pan = 0, wet = 0.3) => {
      const s = new Shot(eng, 1, 0);
      route(s.out, gain, pan, wet);
      return s;
    },
    bus: (gain = 1, pan = 0, wet = 0.3) => {
      const g = ctx.createGain();
      route(g, gain, pan, wet);
      return g;
    },
  };
  sound.play(c);
  const out = await ctx.startRendering();
  return { ...wav(out), seconds: sound.dur };
}

const w = window as unknown as { __renderMonsterSound: typeof render; __monsterSounds: string[] };
w.__renderMonsterSound = render;
w.__monsterSounds = Object.keys(SOUNDS);
