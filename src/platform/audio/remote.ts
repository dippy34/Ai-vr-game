/**
 * Remote players: spatial WebRTC voices that follow their heads, and footsteps derived from
 * their head movement on the floor plane.
 *
 * Chrome quirk: a remote WebRTC MediaStream only delivers audio into WebAudio if the same stream
 * is also attached to a media element that is playing. We attach it to a muted, detached
 * HTMLAudioElement (muted, so the voice is never heard twice / unspatialized).
 */

import { NOISE } from '../../config';
import { headVectors, footstepLoudness, occlusionMix, smoothFactor } from './audioMath';
import { SPATIAL, approach, makePanner, setPannerOrientation, setPannerPosition, type Engine } from './engine';
import { sfxWoodStep } from './sfx';
import type { PlayerId, PlayerStatus, Vec3, WorldState } from '../../core/types';

interface VoiceChain {
  stream: MediaStream;
  el: HTMLAudioElement | null;
  src: MediaStreamAudioSourceNode | null;
  hp: BiquadFilterNode;
  lp: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode;
  pos: Vec3 | null;
  /** Last applied (gain, lp, hp) so params are only touched on change. */
  mix: string;
  onAddTrack: (() => void) | null;
}

interface Body {
  last: Vec3;
  pos: Vec3;
  accum: number;
  speed: number;
  feet: PannerNode | null;
}

/** Voice tone per (remote status, am-I-a-ghost): [gain, lowpass Hz, highpass Hz]. */
function voiceMix(remote: PlayerStatus | undefined, localGhost: boolean, nyq: number): [number, number, number] {
  if (remote === 'escaped') return [0, nyq, 80];
  if (remote === 'caught') return localGhost ? [0.8, 5000, 120] : [0.3, 1000, 350];
  return [1, nyq, 80];
}

export class RemotePlayers {
  private readonly voices = new Map<PlayerId, VoiceChain>();
  private readonly bodies = new Map<PlayerId, Body>();
  private listener: Vec3 = { x: 0, y: 1.6, z: 0 };

  constructor(private readonly eng: Engine) {}

  addVoice(id: PlayerId, stream: MediaStream): void {
    this.removeVoice(id);
    const ctx = this.eng.ctx;
    let el: HTMLAudioElement | null = null;
    try {
      if (typeof Audio !== 'undefined') {
        el = new Audio();
        el.muted = true;
        el.autoplay = true;
        el.setAttribute('playsinline', '');
        el.srcObject = stream;
        const p = el.play();
        if (p && typeof p.catch === 'function') p.catch(() => { /* muted autoplay is allowed; ignore */ });
      }
    } catch {
      el = null;
    }
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 80;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = this.eng.nyquistSafe;
    const gain = ctx.createGain();
    const panner = makePanner(ctx, { ...SPATIAL.voice, cone: [120, 300, 0.5] });
    setPannerPosition(panner, this.listener);
    hp.connect(lp).connect(gain).connect(panner).connect(this.eng.voice);
    const v: VoiceChain = { stream, el, src: null, hp, lp, gain, panner, pos: null, mix: '', onAddTrack: null };
    this.voices.set(id, v);
    if (!this.connectSource(v)) {
      // Stream without audio tracks yet (renegotiation): wire up when one arrives.
      v.onAddTrack = () => {
        if (!v.src && this.voices.get(id) === v) this.connectSource(v);
      };
      try { stream.addEventListener('addtrack', v.onAddTrack); } catch { /* ignore */ }
    }
  }

  private connectSource(v: VoiceChain): boolean {
    try {
      if (v.stream.getAudioTracks().length === 0) return false;
      v.src = this.eng.ctx.createMediaStreamSource(v.stream);
      v.src.connect(v.hp);
      return true;
    } catch {
      return false;
    }
  }

  removeVoice(id: PlayerId): void {
    const v = this.voices.get(id);
    if (!v) return;
    this.voices.delete(id);
    if (v.onAddTrack) {
      try { v.stream.removeEventListener('addtrack', v.onAddTrack); } catch { /* ignore */ }
    }
    for (const n of [v.src, v.hp, v.lp, v.gain, v.panner]) {
      try { n?.disconnect(); } catch { /* ignore */ }
    }
    if (v.el) {
      try {
        v.el.pause();
        v.el.srcObject = null;
      } catch { /* ignore */ }
    }
  }

  update(
    state: WorldState,
    localId: PlayerId,
    listener: Vec3,
    dt: number,
    now: number,
    localGhost: boolean,
    /** Walls between the listener and a point (muffles voices in other rooms). */
    wallsTo: (p: Vec3) => number = () => 0,
  ): void {
    this.listener = listener;
    const players = state.players ?? {};
    const k = smoothFactor(12, dt);

    // Voices follow (smoothed) heads; tone follows status.
    for (const [id, v] of this.voices) {
      const p = players[id];
      if (p?.pose?.head) {
        const target = p.pose.head.position;
        if (!v.pos || dist2(v.pos, target) > 9) v.pos = { x: target.x, y: target.y, z: target.z };
        else lerpInto(v.pos, target, k);
        setPannerPosition(v.panner, v.pos);
        setPannerOrientation(v.panner, headVectors(p.pose.head.rotation).forward);
      }
      const [g0, lp0, hpHz] = voiceMix(p?.status, localGhost, this.eng.nyquistSafe);
      const walls = v.pos && !localGhost ? Math.min(3, wallsTo(v.pos)) : 0;
      const [og, olp] = occlusionMix(walls, this.eng.nyquistSafe);
      const g = g0 * og;
      const lpHz = Math.min(lp0, olp);
      const key = `${g}|${lpHz}|${hpHz}`;
      if (key !== v.mix) {
        const first = v.mix === '';
        v.mix = key;
        const tau = first ? 0.01 : 0.3;
        approach(v.gain.gain, g, now, tau);
        approach(v.lp.frequency, lpHz, now, tau);
        approach(v.hp.frequency, hpHz, now, tau);
      }
    }

    // Footsteps from head travel on the floor plane.
    for (const id in players) {
      if (id === localId) continue;
      const p = players[id];
      const head = p?.pose?.head?.position;
      if (!head) continue;
      let b = this.bodies.get(id);
      if (!b) {
        b = { last: { ...head }, pos: { ...head }, accum: 0, speed: 0, feet: null };
        this.bodies.set(id, b);
        continue;
      }
      const d = Math.hypot(head.x - b.last.x, head.z - b.last.z);
      b.last.x = head.x;
      b.last.y = head.y;
      b.last.z = head.z;
      if (d > 2.5) {
        // Teleport (respawn): no steps.
        b.accum = 0;
        b.speed = 0;
        b.pos = { ...head };
        continue;
      }
      lerpInto(b.pos, head, k);
      const inst = dt > 0 ? d / dt : 0;
      b.speed += (Math.min(inst, 8) - b.speed) * smoothFactor(5, dt);
      if (p.status !== 'alive') {
        b.accum = 0;
        continue;
      }
      b.accum += d;
      if (b.accum >= NOISE.stepLength) {
        b.accum = b.accum > NOISE.stepLength * 2 ? 0 : b.accum - NOISE.stepLength;
        if (!b.feet) {
          b.feet = makePanner(this.eng.ctx, SPATIAL.prop);
          b.feet.connect(this.eng.world);
        }
        setPannerPosition(b.feet, { x: b.pos.x, y: 0.05, z: b.pos.z });
        const shot = this.eng.pool.begin(b.feet, 0);
        if (shot) sfxWoodStep(shot, now + 0.005, footstepLoudness(b.speed, head.y));
      } else if (b.feet) {
        setPannerPosition(b.feet, { x: b.pos.x, y: 0.05, z: b.pos.z });
      }
    }
    for (const [id, b] of this.bodies) {
      if (!players[id] || id === localId) {
        try { b.feet?.disconnect(); } catch { /* ignore */ }
        this.bodies.delete(id);
      }
    }
  }

  dispose(): void {
    for (const id of [...this.voices.keys()]) this.removeVoice(id);
    for (const b of this.bodies.values()) {
      try { b.feet?.disconnect(); } catch { /* ignore */ }
    }
    this.bodies.clear();
  }
}

function dist2(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function lerpInto(a: Vec3, b: Vec3, k: number): void {
  a.x += (b.x - a.x) * k;
  a.y += (b.y - a.y) * k;
  a.z += (b.z - a.z) * k;
}
