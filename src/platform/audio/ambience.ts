/**
 * House ambience: a barely-there detuned low drone with a slow filter sweep (it opens up and gets
 * a little louder as the monster gets close), faint gusting wind, and random creaks / settling
 * knocks / pipe ticks at random spots around the listener every 6-18 s.
 */

import type { Vec3 } from '../../core/types';
import { SPATIAL, approach, chance, rand, type Engine } from './engine';
import { creak, sfxKnock, sfxTicks } from './sfx';

export class Ambience {
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly droneGain: GainNode;
  private readonly droneLp: BiquadFilterNode;
  private readonly windGain: GainNode;
  private readonly windBp: BiquadFilterNode;
  private readonly windPan: StereoPannerNode | null;
  private nextCreak: number;
  private nextGust: number;
  private tension = -1;

  constructor(private readonly eng: Engine) {
    const ctx = eng.ctx;
    const t = ctx.currentTime;
    const out = this.keep(ctx.createGain());
    out.gain.value = 0;
    out.gain.setTargetAtTime(1, t, 1.5); // fade in after unlock
    out.connect(eng.world);

    // Drone: F1 pair beating at ~0.25 Hz plus a tritone above, through a slowly sweeping lowpass.
    this.droneLp = this.keep(ctx.createBiquadFilter());
    this.droneLp.type = 'lowpass';
    this.droneLp.frequency.value = 160;
    this.droneLp.Q.value = 2;
    this.droneGain = this.keep(ctx.createGain());
    this.droneGain.gain.value = 0.016;
    this.droneLp.connect(this.droneGain).connect(out);
    for (const [type, f, g] of [['sawtooth', 41.2, 0.5], ['sawtooth', 41.45, 0.5], ['triangle', 58.27, 0.6], ['sawtooth', 87.3, 0.12]] as const) {
      const o = this.osc(type, f);
      const og = this.keep(ctx.createGain());
      og.gain.value = g;
      o.connect(og).connect(this.droneLp);
    }
    const sweep = this.osc('sine', 0.035);
    const sweepDepth = this.keep(ctx.createGain());
    sweepDepth.gain.value = 70;
    sweep.connect(sweepDepth).connect(this.droneLp.frequency);
    const breathe = this.osc('sine', 0.071);
    const breatheDepth = this.keep(ctx.createGain());
    breatheDepth.gain.value = 0.005;
    breathe.connect(breatheDepth).connect(this.droneGain.gain);

    // Room tone: very low band of brown noise.
    const room = this.loop('brown');
    const roomBp = this.keep(ctx.createBiquadFilter());
    roomBp.type = 'bandpass';
    roomBp.frequency.value = 180;
    roomBp.Q.value = 0.8;
    const roomGain = this.keep(ctx.createGain());
    roomGain.gain.value = 0.014;
    room.connect(roomBp).connect(roomGain).connect(out);

    // Wind: pink noise through a wandering, slightly whistly band.
    const wind = this.loop('pink');
    this.windBp = this.keep(ctx.createBiquadFilter());
    this.windBp.type = 'bandpass';
    this.windBp.frequency.value = 500;
    this.windBp.Q.value = 3;
    this.windGain = this.keep(ctx.createGain());
    this.windGain.gain.value = 0.03;
    wind.connect(this.windBp).connect(this.windGain);
    this.windPan = typeof ctx.createStereoPanner === 'function' ? this.keep(ctx.createStereoPanner()) : null;
    if (this.windPan) this.windGain.connect(this.windPan).connect(out);
    else this.windGain.connect(out);

    this.nextCreak = t + rand(4, 9);
    this.nextGust = t + rand(1, 3);
  }

  private keep<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  private osc(type: OscillatorType, freq: number): OscillatorNode {
    const o = this.keep(this.eng.ctx.createOscillator());
    o.type = type;
    o.frequency.value = freq;
    o.start();
    this.sources.push(o);
    return o;
  }

  private loop(kind: 'pink' | 'white' | 'brown'): AudioBufferSourceNode {
    const src = this.keep(this.eng.ctx.createBufferSource());
    src.buffer = this.eng.noise[kind];
    src.loop = true;
    src.start(this.eng.ctx.currentTime, Math.random() * src.buffer.duration);
    this.sources.push(src);
    return src;
  }

  /** `tension` 0..1 (monster proximity) brightens and swells the drone. */
  update(listener: Vec3, now: number, tension: number): void {
    const tq = Math.round(Math.min(1, Math.max(0, tension)) * 20) / 20;
    if (tq !== this.tension) {
      this.tension = tq;
      approach(this.droneLp.frequency, 160 + 230 * tq, now, 1.2);
      approach(this.droneGain.gain, 0.016 + 0.024 * tq, now, 1.2);
    }

    if (now >= this.nextGust) {
      const tau = rand(0.8, 2.2);
      approach(this.windGain.gain, chance(0.25) ? rand(0.06, 0.1) : rand(0.015, 0.05), now, tau);
      approach(this.windBp.frequency, rand(300, 1000), now, 1.5);
      approach(this.windBp.Q, rand(1.5, 6), now, 2);
      if (this.windPan) approach(this.windPan.pan, rand(-0.7, 0.7), now, 2.5);
      this.nextGust = now + rand(2.5, 6);
    }

    if (now >= this.nextCreak) {
      this.nextCreak = now + rand(6, 18);
      this.houseSound(listener, now + 0.02);
    }
  }

  private houseSound(listener: Vec3, t: number): void {
    const ang = Math.random() * Math.PI * 2;
    const d = rand(2.5, 7);
    const r = Math.random();
    const y = r < 0.5 ? (chance(0.5) ? 0.1 : 2.7) : r < 0.75 ? rand(0.4, 2) : 2.6;
    const pos = { x: listener.x + Math.cos(ang) * d, y, z: listener.z + Math.sin(ang) * d };
    const shot = this.eng.pool.spatial(pos, SPATIAL.ambient, 0);
    if (!shot) return;
    if (r < 0.5) {
      creak(shot, t, { dur: rand(0.6, 1.8), rateLo: rand(9, 18), rateHi: rand(24, 48), res: rand(350, 1300), q: 12, level: rand(0.12, 0.3) });
    } else if (r < 0.75) {
      shot.out.gain.value = rand(0.6, 1);
      sfxKnock(shot, t, 1 + Math.floor(Math.random() * 3));
    } else {
      shot.out.gain.value = rand(0.5, 0.9);
      sfxTicks(shot, t);
    }
  }

  dispose(): void {
    for (const s of this.sources) {
      try { s.stop(); } catch { /* ignore */ }
    }
    for (const n of this.nodes) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
  }
}
