/**
 * `?perf=1` performance readout: fps, draw calls, triangles, textures resident (+ an estimate of
 * their GPU memory) on a small head-locked panel, so it also works inside the headset. The same
 * line is logged to the console every few seconds (chrome://inspect on a Quest).
 *
 * Draw calls / triangles are renderer.info for the last frame: in VR that counts both eyes.
 */

import * as THREE from 'three';

const W = 512;
const H = 96;
/** Panel width (m) and where it hangs in front of the eyes (camera space). */
const PANEL_W = 0.3;
const REFRESH_MS = 500;
const LOG_MS = 5000;
const MEMORY_MS = 2000;

export function perfHudRequested(): boolean {
  try {
    return new URLSearchParams(location.search).get('perf') === '1';
  } catch {
    return false;
  }
}

export class PerfHud {
  readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly tex: THREE.CanvasTexture;
  private readonly mat: THREE.MeshBasicMaterial;
  private frames = 0;
  private windowStart = -1;
  private lastLog = 0;
  private lastMemory = -Infinity;
  private textureMB = 0;
  private worstMs = 0;
  private lastFrame = -1;
  private readonly seen = new Set<THREE.Texture>();

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
    // Head-locked, low in the view, 0.6 m away (child of the camera).
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, (PANEL_W * H) / W), this.mat);
    this.mesh.position.set(0, -0.17, -0.6);
    this.mesh.name = 'perfHud';
    this.mesh.renderOrder = 9999;
    this.mesh.frustumCulled = false;
    this.draw('perf', 'waiting for frames');
  }

  /** Call once per rendered frame, right after renderer.render(). */
  frame(renderer: THREE.WebGLRenderer, scene: THREE.Scene, now: number): void {
    if (this.lastFrame >= 0) this.worstMs = Math.max(this.worstMs, now - this.lastFrame);
    this.lastFrame = now;
    if (this.windowStart < 0) this.windowStart = now;
    this.frames++;
    const elapsed = now - this.windowStart;
    if (elapsed < REFRESH_MS) return;
    if (now - this.lastMemory >= MEMORY_MS) {
      this.lastMemory = now;
      this.textureMB = estimateTextureBytes(scene, this.seen) / 1048576;
    }
    const fps = (this.frames * 1000) / elapsed;
    const info = renderer.info;
    const xr = renderer.xr.isPresenting ? ' (2 eyes)' : '';
    const a = `${fps.toFixed(0)} fps  worst ${this.worstMs.toFixed(0)} ms`;
    const b = `${info.render.calls} calls${xr}  ${(info.render.triangles / 1000).toFixed(0)}k tris  `
      + `${info.memory.textures} tex ~${this.textureMB.toFixed(0)} MB`;
    this.draw(a, b);
    if (now - this.lastLog >= LOG_MS) {
      this.lastLog = now;
      console.info(`[perf] ${a}  ${b}  geometries=${info.memory.geometries} programs=${info.programs?.length ?? 0}`);
    }
    this.frames = 0;
    this.worstMs = 0;
    this.windowStart = now;
  }

  private draw(a: string, b: string): void {
    const g = this.g;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#9cff9c';
    g.textBaseline = 'middle';
    g.font = '700 34px ui-monospace, Menlo, Consolas, monospace';
    g.fillText(a, 10, H * 0.3, W - 20);
    g.font = '600 25px ui-monospace, Menlo, Consolas, monospace';
    g.fillText(b, 10, H * 0.74, W - 20);
    this.tex.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}

/**
 * Rough GPU memory of every texture referenced by the scene's materials (incl. the batcher's
 * texture arrays): compressed = its real data size, otherwise RGBA8; +1/3 for mipmaps.
 */
export function estimateTextureBytes(scene: THREE.Object3D, seen = new Set<THREE.Texture>()): number {
  seen.clear();
  let bytes = 0;
  const add = (t: unknown): void => {
    if (!(t instanceof THREE.Texture) || seen.has(t)) return;
    seen.add(t);
    bytes += textureBytes(t);
  };
  scene.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      for (const v of Object.values(m)) add(v);
      const arrays = m.userData.textureArrays as unknown[] | undefined;
      if (arrays) for (const a of arrays) add(a);
    }
  });
  return bytes;
}

function textureBytes(t: THREE.Texture): number {
  if (typeof t.userData.gpuBytes === 'number') return t.userData.gpuBytes;
  const img = t.image as { width?: number; height?: number; depth?: number } | null;
  const mips = (t as THREE.CompressedTexture).mipmaps as unknown as { data?: ArrayBufferView }[] | undefined;
  if ((t as THREE.CompressedTexture).isCompressedTexture && mips?.length) {
    return mips.reduce((a, m) => a + (m.data?.byteLength ?? 0), 0);
  }
  const w = img?.width ?? 0, h = img?.height ?? 0, d = img?.depth ?? 1;
  const mipK = t.generateMipmaps || (mips?.length ?? 0) > 1 ? 4 / 3 : 1;
  return w * h * d * 4 * mipK;
}
