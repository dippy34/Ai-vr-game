/**
 * Local microphone: getUserMedia with automatic gain control OFF (so a whisper stays a whisper
 * and the "whisper to stay safe" rule works) and an AnalyserNode loudness meter.
 * The mic is never routed to the speakers: analyser -> zero gain -> destination only exists so
 * every engine keeps pulling the analyser.
 */

import { MicMeter, rmsOf } from './audioMath';

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class MicInput {
  stream: MediaStream | null = null;
  private pending: Promise<MediaStream | null> | null = null;
  private ctx: AudioContext | null = null;
  private nodes: AudioNode[] = [];
  private analyser: AnalyserNode | null = null;
  private buf: Float32Array<ArrayBuffer> | null = null;
  private readonly meter = new MicMeter();
  private lastPoll = 0;

  get level(): number {
    return this.meter.level;
  }

  start(): Promise<MediaStream | null> {
    if (this.stream && this.isLive()) return Promise.resolve(this.stream);
    if (!this.pending) {
      this.pending = this.request().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private async request(): Promise<MediaStream | null> {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function') return null;
    let stream: MediaStream;
    try {
      stream = await md.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      console.warn('[audio] microphone unavailable or denied:', err);
      return null;
    }
    // Some browsers treat constraints as hints; insist on AGC off if it slipped through.
    const track = stream.getAudioTracks()[0];
    try {
      const settings = track?.getSettings?.() as MediaTrackSettings | undefined;
      if (settings && settings.autoGainControl === true) {
        await track.applyConstraints({ autoGainControl: false, echoCancellation: true, noiseSuppression: true });
      }
    } catch { /* best effort */ }
    this.stream = stream;
    if (this.ctx) this.attach(this.ctx);
    return stream;
  }

  private isLive(): boolean {
    const t = this.stream?.getAudioTracks()[0];
    return !!t && t.readyState !== 'ended';
  }

  /** Builds the meter graph once both the stream and an AudioContext exist. */
  attach(ctx: AudioContext): void {
    this.ctx = ctx;
    if (!this.stream || this.analyser) return;
    try {
      const src = ctx.createMediaStreamSource(this.stream);
      const hp = ctx.createBiquadFilter(); // drop handling rumble / DC
      hp.type = 'highpass';
      hp.frequency.value = 70;
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = 0;
      const sink = ctx.createGain();
      sink.gain.value = 0;
      src.connect(hp).connect(an).connect(sink).connect(ctx.destination);
      this.nodes = [src, hp, an, sink];
      this.analyser = an;
      this.buf = new Float32Array(an.fftSize);
    } catch (err) {
      console.warn('[audio] mic meter failed:', err);
    }
  }

  /** Refreshes the meter (cheap; ignores calls closer than 4 ms apart). Returns the gated level. */
  poll(running: boolean): number {
    const t = nowMs();
    const dt = this.lastPoll ? (t - this.lastPoll) / 1000 : 0;
    if (this.lastPoll && dt < 0.004) return this.meter.level;
    this.lastPoll = t;
    const step = Math.min(dt, 0.25);
    if (!this.analyser || !this.buf || !running || !this.isLive()) return this.meter.push(0, step);
    this.analyser.getFloatTimeDomainData(this.buf);
    return this.meter.push(rmsOf(this.buf), step);
  }

  dispose(): void {
    for (const n of this.nodes) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
    this.nodes = [];
    this.analyser = null;
  }
}
