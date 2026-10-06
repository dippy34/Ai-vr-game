/**
 * Short in-world text message ~1.6 m in front of the head. Lazily follows head yaw, fades in/out.
 * Drawn on top of everything (depthTest off) so walls never hide it; works in VR and on desktop.
 */

import * as THREE from 'three';
import { damp } from './util';

const W = 1024;
const H = 256;
const DISTANCE = 1.6;
const PANEL_W = 1.15;

export class MessagePanel {
  readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly tex: THREE.CanvasTexture;
  private readonly mat: THREE.MeshBasicMaterial;
  private age = 0;
  private duration = 0;
  private yaw = 0;
  private placed = false;
  private readonly fwd = new THREE.Vector3();

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.MeshBasicMaterial({
      map: this.tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, (PANEL_W * H) / W), this.mat);
    this.mesh.name = 'message';
    this.mesh.renderOrder = 9000;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  show(text: string, seconds = 3): void {
    const g = this.canvas.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    // Soft dark backing so text reads over the flash too.
    const bg = g.createRadialGradient(W / 2, H / 2, 20, W / 2, H / 2, W / 2);
    bg.addColorStop(0, 'rgba(0,0,0,0.55)');
    bg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    const lines = wrap(g, text, W - 120, 64);
    const size = lines.length > 2 ? 50 : 64;
    g.font = `600 ${size}px Georgia, 'Times New Roman', serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lh = size * 1.18;
    const y0 = H / 2 - ((lines.length - 1) * lh) / 2;
    lines.slice(0, 3).forEach((line, i) => {
      g.shadowColor = 'rgba(140,170,255,0.6)';
      g.shadowBlur = 18;
      g.fillStyle = '#e6ebf5';
      g.fillText(line, W / 2, y0 + i * lh);
    });
    g.shadowBlur = 0;
    this.tex.needsUpdate = true;
    this.age = 0;
    this.duration = Math.max(0.5, seconds);
    this.placed = false;
    this.mesh.visible = true;
  }

  update(headPos: THREE.Vector3, headQuat: THREE.Quaternion, dt: number): void {
    if (!this.mesh.visible) return;
    this.age += dt;
    const fadeIn = Math.min(1, this.age / 0.2);
    const fadeOut = Math.min(1, Math.max(0, (this.duration - this.age) / 0.6));
    const o = Math.min(fadeIn, fadeOut);
    if (this.age >= this.duration) {
      this.mesh.visible = false;
      return;
    }
    this.mat.opacity = o;
    this.fwd.set(0, 0, -1).applyQuaternion(headQuat);
    const yaw = Math.atan2(-this.fwd.x, -this.fwd.z);
    if (!this.placed) {
      this.yaw = yaw;
      this.placed = true;
    } else {
      let d = yaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      // Lazy follow: slow while it's roughly in view, faster when you turn away.
      this.yaw += d * damp(Math.abs(d) > 0.9 ? 6 : 1.6, dt);
    }
    this.mesh.position.set(
      headPos.x - Math.sin(this.yaw) * DISTANCE,
      headPos.y - 0.12,
      headPos.z - Math.cos(this.yaw) * DISTANCE,
    );
    this.mesh.rotation.set(0, this.yaw, 0);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number, size: number): string[] {
  g.font = `600 ${size}px Georgia, 'Times New Roman', serif`;
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (g.measureText(test).width > maxW && line) {
        out.push(line);
        line = word;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}
