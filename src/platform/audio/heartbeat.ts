/**
 * Non-spatial heartbeat ("lub-dub" from two pre-rendered thump buffers), scheduled a little ahead
 * of time so it never stutters with the frame rate. Faster and louder as fear rises.
 */

import { bpmFromIntensity, dubDelay, heartbeatGain, smoothFactor } from './audioMath';
import { approach, rand, type Engine } from './engine';

export class Heartbeat {
  private readonly gain: GainNode;
  private readonly lp: BiquadFilterNode;
  private next = 0;
  private running = false;
  private intensity = 0;
  private lastGain = -1;

  constructor(private readonly eng: Engine) {
    const ctx = eng.ctx;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 900;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(this.lp).connect(eng.ui);
  }

  /** `fear` 0..1 from heartbeatIntensity(). `active` = round playing and local player alive. */
  update(active: boolean, fear: number, dt: number, now: number): void {
    // Rises quickly (adrenaline), calms down slowly.
    const rate = fear > this.intensity ? 1.5 : 0.35;
    this.intensity += (fear - this.intensity) * smoothFactor(rate, dt);

    if (!active) {
      if (this.running) {
        approach(this.gain.gain, 0, now, 0.4);
        this.running = false;
        this.lastGain = -1;
      }
      return;
    }
    if (!this.running) {
      this.running = true;
      this.next = now + 0.25;
    }
    const g = heartbeatGain(this.intensity);
    if (Math.abs(g - this.lastGain) > 0.01) {
      approach(this.gain.gain, g, now, 0.15);
      this.lastGain = g;
    }
    if (this.next < now - 0.5) this.next = now + 0.02;
    let guard = 0;
    while (this.next < now + 0.15 && guard++ < 3) {
      const period = 60 / bpmFromIntensity(this.intensity);
      this.beat(Math.max(this.next, now + 0.005), period);
      this.next += period * rand(0.97, 1.03);
    }
  }

  /** Forget the calm-down so a fresh round starts calm. */
  reset(): void {
    this.intensity = 0;
  }

  private beat(t: number, period: number): void {
    const ctx = this.eng.ctx;
    const play = (buf: AudioBuffer, at: number, rate: number) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      src.connect(this.gain);
      src.onended = () => {
        try { src.disconnect(); } catch { /* ignore */ }
      };
      src.start(at);
    };
    play(this.eng.heart.lub, t, rand(0.97, 1.03));
    play(this.eng.heart.dub, t + dubDelay(period), rand(0.98, 1.04));
  }

  dispose(): void {
    try { this.gain.disconnect(); this.lp.disconnect(); } catch { /* ignore */ }
  }
}
