/**
 * Camera flash: a short, very bright spot light (+ a weaker omni bounce) and frozen afterimages.
 *
 * The lights always exist (intensity 0 when idle) so the light count never changes, which would
 * force every material to recompile and hitch on the Quest. The spot casts soft (PCF) shadows and
 * carries a beam cookie (hot centre, Fresnel-lens falloff); its shadow map is only re-rendered
 * while the flash is lit (needsShadowUpdate), so idle frames cost nothing for it, and the light
 * loops skip it entirely at intensity 0 (fx/pipeline). Its position / direction / brightness also
 * feed the shared FX uniforms (haze in-scatter, dust motes).
 *
 * Afterimages are merged, unlit (matcap: no light needed), additive, depthWrite=false copies of
 * the posed hands/heads/monster at the moment of the flash: one draw call per flash for the bright
 * core + one for a soft halo shell, fading over RENDER.afterimageDuration.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RENDER } from '../../config';
import { FX } from './fx/pipeline';
import { ghostMatcapTexture } from './textures';

/** Max time a full-view whiteout may last (VR comfort: no strobe longer than ~80 ms). */
const WHITEOUT_SECONDS = 0.07;
/** Shadow camera near plane (m): the flasher's own hand / camera body never cast. */
const SHADOW_NEAR = 0.22;
/** Bounce light range past the wall the beam hits (m): limits leaking into the next room. */
const BOUNCE_REACH = 2.6;

/** Beam pattern of a camera flash (Fresnel lens): hot centre, slightly squared falloff, faint rings. */
function flashCookie(): THREE.DataTexture {
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N * 2 - 1, v = (y + 0.5) / N * 2 - 1;
      const sq = Math.pow(Math.pow(Math.abs(u), 3.2) + Math.pow(Math.abs(v * 1.08), 3.2), 1 / 3.2);
      const r = Math.hypot(u, v);
      const body = 1 - 0.42 * THREE.MathUtils.smoothstep(sq, 0.05, 0.9);
      const hot = 0.28 * Math.exp(-r * r * 9);
      const rings = 1 + 0.045 * Math.sin(r * 46) * THREE.MathUtils.smoothstep(r, 0.25, 0.85);
      const b = Math.min(1, (body + hot) / 1.28 * rings);
      const i = (y * N + x) * 4;
      data[i] = Math.round(255 * b);
      data[i + 1] = Math.round(255 * b);
      data[i + 2] = Math.round(255 * Math.min(1, b * 1.02));
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N);
  t.colorSpace = THREE.NoColorSpace;
  // No mipmaps: it is sampled in a branch (only where the flash reaches).
  t.generateMipmaps = false;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Afterimages are pulled this far toward the viewer along the view ray in the vertex shader: they
 * look exactly the same on screen, but the live (dark) body that moved a few cm since the flash no
 * longer cuts holes in its own ghost, while walls/furniture further in front still hide it.
 */
const GHOST_PULL = { value: 0.25 };

function withViewPull<T extends THREE.Material>(m: T): T {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.ghostPull = GHOST_PULL;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform float ghostPull;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          float ghostLen = length( mvPosition.xyz );
          float ghostK = max( 1.0 - ghostPull / max( ghostLen, 1e-4 ), min( 1.0, 0.06 / max( ghostLen, 1e-4 ) ) );
          mvPosition.xyz *= ghostK;
          gl_Position = projectionMatrix * mvPosition;
        }`,
      );
  };
  m.customProgramCacheKey = () => 'mute-ghost-pull';
  return m;
}

interface Afterimage {
  core: THREE.Mesh;
  halo: THREE.Mesh | null;
  start: number;
  strength: number;
}

export class FlashEffect {
  readonly spot: THREE.SpotLight;
  readonly point: THREE.PointLight;
  readonly whiteout: THREE.Mesh;
  private readonly whiteMat: THREE.MeshBasicMaterial;
  private readonly coreMat: THREE.MeshMatcapMaterial;
  private readonly haloMat: THREE.MeshBasicMaterial;
  private readonly ghosts: Afterimage[] = [];
  private start = -1e9;
  private whiteAmount = 0;
  private readonly warm: THREE.Mesh[] = [];
  private readonly cookie: THREE.DataTexture;
  /** Brightness 0..1 this frame. */
  private k = 0;
  /** The shadow map exists and matches the light (re-rendered while lit, once after load). */
  private shadowFresh = false;

  constructor(private readonly scene: THREE.Scene, camera: THREE.Camera) {
    // Range capped at fogFar: beyond it everything is fog anyway. Inverse-square falloff.
    this.spot = new THREE.SpotLight(0xf1f4ff, 0, Math.min(RENDER.flashRange, RENDER.fogFar),
      THREE.MathUtils.degToRad(RENDER.flashAngle), RENDER.flashPenumbra, 2);
    this.spot.name = 'flashSpot';
    this.cookie = flashCookie();
    // `?shadows=0` (or RENDER.flashShadows = false): a plain spot, no shadow map, no cookie.
    const shadows = RENDER.flashShadows && (typeof location === 'undefined' || new URLSearchParams(location.search).get('shadows') !== '0');
    this.spot.map = shadows ? this.cookie : null;
    this.spot.castShadow = shadows;
    const sh = this.spot.shadow;
    sh.camera.near = SHADOW_NEAR;
    sh.bias = -0.0006;
    sh.normalBias = 0.025;
    this.setShadowQuality(RENDER.tiers.desktop.shadowMapSize, RENDER.tiers.desktop.shadowRadius);
    this.point = new THREE.PointLight(0xe6ecff, 0, 6, 2);
    this.point.name = 'flashBounce';
    scene.add(this.spot, this.spot.target, this.point);

    this.whiteMat = new THREE.MeshBasicMaterial({
      color: 0xf4f7ff, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.whiteout = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 2.5), this.whiteMat);
    this.whiteout.position.z = -0.12;
    this.whiteout.renderOrder = 10000;
    this.whiteout.frustumCulled = false;
    this.whiteout.visible = false;
    camera.add(this.whiteout);

    // Pulled toward the viewer with polygonOffset so the frozen copy never z-fights the live hand
    // it was copied from (it is also inflated slightly when baked).
    this.coreMat = withViewPull(new THREE.MeshMatcapMaterial({
      matcap: ghostMatcapTexture(), color: 0xdfe8ff, vertexColors: true, transparent: true, opacity: 1, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
      // Afterimages keep their exact look: they are "light in your eyes", outside the scene's tone curve.
      toneMapped: false,
    }));
    this.haloMat = withViewPull(new THREE.MeshBasicMaterial({
      color: 0x8fa6d8, vertexColors: true, transparent: true, opacity: 1, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
      toneMapped: false,
    }));
    // Warm-up meshes so the afterimage shaders are compiled with the level, not on the first flash.
    for (const m of [this.coreMat, this.haloMat]) {
      const w = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]), m);
      w.geometry.computeVertexNormals();
      w.frustumCulled = false;
      w.visible = false;
      w.position.y = -1000;
      scene.add(w);
      this.warm.push(w);
    }
  }

  /** Shadow map size (px) and PCF radius (texels); a new size reallocates the map on the next update. */
  setShadowQuality(size: number, radius: number): void {
    const sh = this.spot.shadow;
    if (sh.mapSize.x !== size) {
      sh.mapSize.set(size, size);
      sh.map?.dispose();
      sh.map = null;
      this.shadowFresh = false;
    }
    sh.radius = radius;
  }

  /** Should the renderer re-render the flash shadow map this frame? (only while lit) */
  needsShadowUpdate(): boolean {
    if (this.k > 0 || !this.shadowFresh) {
      this.shadowFresh = true;
      return true;
    }
    return false;
  }

  /** Brightness 0..1 right now (0 = idle). */
  get brightness(): number {
    return this.k;
  }

  /** Make the hidden warm-up meshes visible for a renderer.compile() call. */
  setWarmupVisible(v: boolean): void {
    for (const w of this.warm) w.visible = v;
    this.whiteout.visible = v;
  }

  /**
   * Fire the lights. `whiteout` 0..1 = how much this flash blinds the local viewer. `hitDist` =
   * how far the beam's axis goes before it hits a wall (m): the bounce light sits in that room.
   */
  fire(time: number, position: THREE.Vector3, direction: THREE.Vector3, whiteout: number, hitDist = 4): void {
    this.start = time;
    // Nudge the light a few cm forward so it isn't inside the camera/hand geometry.
    this.spot.position.copy(position).addScaledVector(direction, 0.06);
    this.spot.target.position.copy(position).addScaledVector(direction, 3);
    this.spot.target.updateMatrixWorld();
    this.spot.updateMatrixWorld();
    // Fill bounced off the lit room: from about midway to the wall the beam hits.
    const hit = Math.max(0.4, Math.min(hitDist, RENDER.fogFar));
    this.point.position.copy(position).addScaledVector(direction, Math.max(0.25, hit * 0.45));
    this.point.distance = hit * 0.55 + BOUNCE_REACH;
    this.whiteAmount = Math.max(0, Math.min(1, whiteout));
    FX.flashPos.set(this.spot.position.x, this.spot.position.y, this.spot.position.z, 0);
    FX.flashDir.set(direction.x, direction.y, direction.z, Math.cos(this.spot.angle));
    this.update(time);
  }

  /** Add a frozen afterimage from world-space geometries (position + normal only). */
  addAfterimage(parts: THREE.BufferGeometry[], halo: THREE.BufferGeometry[], time: number, strength = 1): void {
    if (parts.length === 0) return;
    const g = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!g) return;
    g.computeBoundingSphere();
    const core = new THREE.Mesh(g, withViewPull(this.coreMat.clone()));
    core.renderOrder = 20;
    let haloMesh: THREE.Mesh | null = null;
    if (halo.length) {
      const hg = mergeGeometries(halo, false);
      for (const p of halo) p.dispose();
      if (hg) {
        hg.computeBoundingSphere();
        haloMesh = new THREE.Mesh(hg, withViewPull(this.haloMat.clone()));
        haloMesh.renderOrder = 19;
        this.scene.add(haloMesh);
      }
    }
    this.scene.add(core);
    this.ghosts.push({ core, halo: haloMesh, start: time, strength });
    // Never keep more than 3 flashes worth of ghosts around.
    while (this.ghosts.length > 3) this.remove(this.ghosts[0]);
  }

  update(time: number): void {
    // Lights: instant attack, fast fall.
    const a = time - this.start;
    const D = RENDER.flashDuration;
    let k = 0;
    if (a >= 0 && a < D) k = a < 0.02 ? 1 : Math.pow(1 - (a - 0.02) / (D - 0.02), 2.4);
    this.k = k;
    this.spot.intensity = RENDER.flashPeak * k;
    this.point.intensity = RENDER.flashBounce * k;
    FX.flashPos.w = k;
    // Whiteout: capped to WHITEOUT_SECONDS.
    const w = a >= 0 && a < WHITEOUT_SECONDS ? this.whiteAmount * Math.pow(1 - a / WHITEOUT_SECONDS, 1.5) : 0;
    this.whiteMat.opacity = w;
    this.whiteout.visible = w > 0.002;

    // Afterimages: hold briefly, then ease out.
    const AD = RENDER.afterimageDuration;
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const gh = this.ghosts[i];
      const age = time - gh.start;
      if (age >= AD || age < -1) {
        this.remove(gh);
        continue;
      }
      // Ramp in as the flash light dies (you see the lit scene first, then the frozen ghost remains),
      // hold briefly, then ease out.
      const rampIn = THREE.MathUtils.smoothstep(age, 0.03, RENDER.flashDuration * 0.9);
      const hold = 0.15 * AD;
      const f = rampIn * (age < hold ? 1 : Math.pow(1 - (age - hold) / (AD - hold), 1.7));
      // A subtle shimmer while it fades, like a retinal afterimage.
      const shimmer = 1 - 0.06 * Math.max(0, Math.sin(age * 31)) * (age / AD);
      (gh.core.material as THREE.MeshMatcapMaterial).opacity = f * shimmer * gh.strength * 0.92;
      if (gh.halo) (gh.halo.material as THREE.MeshBasicMaterial).opacity = f * gh.strength * 0.16;
    }
  }

  get activeAfterimages(): number {
    return this.ghosts.length;
  }

  clearAfterimages(): void {
    while (this.ghosts.length) this.remove(this.ghosts[0]);
  }

  private remove(gh: Afterimage): void {
    const i = this.ghosts.indexOf(gh);
    if (i >= 0) this.ghosts.splice(i, 1);
    for (const m of [gh.core, gh.halo]) {
      if (!m) continue;
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }

  dispose(): void {
    this.clearAfterimages();
    this.whiteout.removeFromParent();
    this.whiteout.geometry.dispose();
    this.whiteMat.dispose();
    this.coreMat.dispose();
    this.haloMat.dispose();
    for (const w of this.warm) {
      this.scene.remove(w);
      w.geometry.dispose();
    }
    this.scene.remove(this.spot, this.spot.target, this.point);
    this.spot.shadow.dispose();
    this.cookie.dispose();
  }
}
