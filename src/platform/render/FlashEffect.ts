/**
 * Camera flash: a short, very bright spot light (+ a weaker omni bounce) and frozen afterimages.
 *
 * The lights always exist (intensity 0 when idle) so the light count never changes, which would
 * force every material to recompile and hitch on the Quest.
 *
 * Afterimages are merged, unlit (matcap: no light needed), additive, depthWrite=false copies of
 * the posed hands/heads/monster at the moment of the flash: one draw call per flash for the bright
 * core + one for a soft halo shell, fading over RENDER.afterimageDuration.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RENDER } from '../../config';
import { ghostMatcapTexture } from './textures';

/** Max time a full-view whiteout may last (VR comfort: no strobe longer than ~80 ms). */
const WHITEOUT_SECONDS = 0.07;
const SPOT_PEAK = 70;
const POINT_PEAK = 5;

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

  constructor(private readonly scene: THREE.Scene, camera: THREE.Camera) {
    this.spot = new THREE.SpotLight(0xf1f4ff, 0, RENDER.flashRange, THREE.MathUtils.degToRad(58), 0.7, 1.55);
    this.spot.name = 'flashSpot';
    this.point = new THREE.PointLight(0xe6ecff, 0, 9, 1.8);
    this.point.name = 'flashBounce';
    scene.add(this.spot, this.spot.target, this.point);

    this.whiteMat = new THREE.MeshBasicMaterial({
      color: 0xf4f7ff, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    });
    this.whiteout = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 2.5), this.whiteMat);
    this.whiteout.position.z = -0.12;
    this.whiteout.renderOrder = 10000;
    this.whiteout.frustumCulled = false;
    this.whiteout.visible = false;
    camera.add(this.whiteout);

    this.coreMat = new THREE.MeshMatcapMaterial({
      matcap: ghostMatcapTexture(), color: 0xdfe8ff, vertexColors: true, transparent: true, opacity: 1, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    });
    this.haloMat = new THREE.MeshBasicMaterial({
      color: 0x8fa6d8, vertexColors: true, transparent: true, opacity: 1, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
    });
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

  /** Make the hidden warm-up meshes visible for a renderer.compile() call. */
  setWarmupVisible(v: boolean): void {
    for (const w of this.warm) w.visible = v;
    this.whiteout.visible = v;
  }

  /** Fire the lights. `whiteout` 0..1 = how much this flash blinds the local viewer. */
  fire(time: number, position: THREE.Vector3, direction: THREE.Vector3, whiteout: number): void {
    this.start = time;
    // Nudge the light a few cm forward so it isn't inside the camera/hand geometry.
    this.spot.position.copy(position).addScaledVector(direction, 0.06);
    this.spot.target.position.copy(position).addScaledVector(direction, 3);
    this.spot.target.updateMatrixWorld();
    this.point.position.copy(position).addScaledVector(direction, 0.25);
    this.whiteAmount = Math.max(0, Math.min(1, whiteout));
    this.update(time);
  }

  /** Add a frozen afterimage from world-space geometries (position + normal only). */
  addAfterimage(parts: THREE.BufferGeometry[], halo: THREE.BufferGeometry[], time: number, strength = 1): void {
    if (parts.length === 0) return;
    const g = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!g) return;
    g.computeBoundingSphere();
    const core = new THREE.Mesh(g, this.coreMat.clone());
    core.renderOrder = 20;
    let haloMesh: THREE.Mesh | null = null;
    if (halo.length) {
      const hg = mergeGeometries(halo, false);
      for (const p of halo) p.dispose();
      if (hg) {
        hg.computeBoundingSphere();
        haloMesh = new THREE.Mesh(hg, this.haloMat.clone());
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
    this.spot.intensity = SPOT_PEAK * k;
    this.point.intensity = POINT_PEAK * k;
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
      const hold = 0.15 * AD;
      const f = age < hold ? 1 : Math.pow(1 - (age - hold) / (AD - hold), 1.7);
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
  }
}
