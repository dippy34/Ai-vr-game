/**
 * Wrist noise meter: 10 segments (green -> yellow -> red) on the inside of the local LEFT wrist,
 * with tick marks at NOISE.whisper / talk / shout. One InstancedMesh (one draw call), self-lit.
 */

import * as THREE from 'three';
import { NOISE } from '../../config';
import { damp } from './util';

const SEGMENTS = 10;
const TICKS = [NOISE.whisper, NOISE.talk, NOISE.shout];
/** Bar layout in the left-hand frame: across the wrist (X), on the palm side (-Y), just behind the wrist (+Z). */
const BAR_W = 0.055;
const SEG_GAP = 0.0012;
const Y = -0.0205;
const Z = 0.03;

const _root = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();

export class NoiseMeter {
  readonly mesh: THREE.InstancedMesh;
  private readonly local: THREE.Matrix4[] = [];
  private readonly segColor: THREE.Color[] = [];
  private shown = 0;
  private peak = 0;
  private peakHold = 0;
  private target = 0;

  constructor() {
    const count = 1 + SEGMENTS + TICKS.length;
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }),
      count,
    );
    this.mesh.name = 'noiseMeter';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    // Left hand: thumb on +X; reading low -> high from the thumb side toward the pinky side
    // (left -> right when you turn the palm up to look at it).
    const xAt = (f: number): number => BAR_W / 2 - f * BAR_W;
    // Backplate.
    this.local.push(new THREE.Matrix4().compose(new THREE.Vector3(0, Y + 0.0012, Z), new THREE.Quaternion(), new THREE.Vector3(BAR_W + 0.006, 0.0016, 0.017)));
    this.mesh.setColorAt(0, _c.set(0x030405));
    const sw = BAR_W / SEGMENTS;
    for (let i = 0; i < SEGMENTS; i++) {
      const f = (i + 0.5) / SEGMENTS;
      this.local.push(new THREE.Matrix4().compose(new THREE.Vector3(xAt(f), Y, Z), new THREE.Quaternion(), new THREE.Vector3(sw - SEG_GAP, 0.0014, 0.0085)));
      // Green -> yellow -> red.
      const hue = 0.34 * (1 - i / (SEGMENTS - 1));
      this.segColor.push(new THREE.Color().setHSL(hue, 1, 0.5));
    }
    for (const t of TICKS) {
      this.local.push(new THREE.Matrix4().compose(new THREE.Vector3(xAt(t), Y - 0.0004, Z + 0.0015), new THREE.Quaternion(), new THREE.Vector3(0.0009, 0.0018, 0.0135)));
    }
    for (let i = 0; i < TICKS.length; i++) this.mesh.setColorAt(1 + SEGMENTS + i, _c.setRGB(0.55, 0.58, 0.62));
    this.mesh.visible = false;
  }

  setLevel(level: number): void {
    this.target = Math.max(0, Math.min(1, level));
  }

  update(position: THREE.Vector3, quaternion: THREE.Quaternion, tracked: boolean, dt: number): void {
    this.mesh.visible = tracked;
    if (!tracked) return;
    // Instant attack, smooth release (the audio module already smooths; this just avoids flicker).
    this.shown = this.target > this.shown ? this.target : this.shown + (this.target - this.shown) * damp(8, dt);
    if (this.shown >= this.peak) { this.peak = this.shown; this.peakHold = 0.6; }
    else if ((this.peakHold -= dt) <= 0) this.peak = Math.max(this.shown, this.peak - dt * 0.8);
    _root.compose(position, quaternion, _one);
    for (let i = 0; i < this.local.length; i++) this.mesh.setMatrixAt(i, _m.multiplyMatrices(_root, this.local[i]));
    const lit = this.shown * SEGMENTS;
    const peakSeg = Math.min(SEGMENTS - 1, Math.floor(this.peak * SEGMENTS - 1e-6));
    for (let i = 0; i < SEGMENTS; i++) {
      const on = Math.max(0, Math.min(1, lit - i));
      let k = 0.1 + 0.9 * on;
      if (i === peakSeg && this.peak > 0.02 && on < 1) k = Math.max(k, 0.7);
      this.mesh.setColorAt(1 + i, _c.copy(this.segColor[i]).multiplyScalar(k * 0.85));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
