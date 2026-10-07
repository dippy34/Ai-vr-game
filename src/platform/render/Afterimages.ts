/**
 * Afterimages: pale, unlit "burned into your eyes" copies of posed geometry that fade out. Only
 * the catch sequence uses them now (the monster's face hanging in the black after a jumpscare);
 * the old camera flash, which froze every hand and the monster into ghosts, is gone.
 *
 * Merged, unlit (matcap: no light needed), additive, depthWrite=false meshes: one draw call per
 * afterimage for the bright core + one for an optional soft halo shell, fading over
 * RENDER.afterimageDuration.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RENDER } from '../../config';
import { ghostMatcapTexture } from './textures';

/** Seconds an afterimage takes to fade in (the real thing is seen first, then the ghost remains). */
const RAMP_IN = 0.2;

/**
 * Afterimages are pulled this far toward the viewer along the view ray in the vertex shader: they
 * look exactly the same on screen, but the live (dark) body that moved a few cm since no longer
 * cuts holes in its own ghost, while walls/furniture further in front still hide it.
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

export class Afterimages {
  private readonly coreMat: THREE.MeshMatcapMaterial;
  private readonly haloMat: THREE.MeshBasicMaterial;
  private readonly ghosts: Afterimage[] = [];
  private readonly warm: THREE.Mesh[] = [];

  constructor(private readonly scene: THREE.Scene) {
    // Pulled toward the viewer with polygonOffset so the frozen copy never z-fights the live thing
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
    // Warm-up meshes so the afterimage shaders are compiled with the level, not mid-jumpscare.
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
  }

  /** Add an afterimage from world-space geometries (position + normal + colour only). */
  add(parts: THREE.BufferGeometry[], halo: THREE.BufferGeometry[], time: number, strength = 1): void {
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
    while (this.ghosts.length > 3) this.remove(this.ghosts[0]);
  }

  update(time: number): void {
    const AD = RENDER.afterimageDuration;
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const gh = this.ghosts[i];
      const age = time - gh.start;
      if (age >= AD || age < -1) {
        this.remove(gh);
        continue;
      }
      // Ramp in, hold briefly, then ease out.
      const rampIn = THREE.MathUtils.smoothstep(age, 0.03, RAMP_IN);
      const hold = 0.15 * AD;
      const f = rampIn * (age < hold ? 1 : Math.pow(1 - (age - hold) / (AD - hold), 1.7));
      // A subtle shimmer while it fades, like a retinal afterimage.
      const shimmer = 1 - 0.06 * Math.max(0, Math.sin(age * 31)) * (age / AD);
      (gh.core.material as THREE.MeshMatcapMaterial).opacity = f * shimmer * gh.strength * 0.92;
      if (gh.halo) (gh.halo.material as THREE.MeshBasicMaterial).opacity = f * gh.strength * 0.16;
    }
  }

  get active(): number {
    return this.ghosts.length;
  }

  clear(): void {
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
    this.clear();
    this.coreMat.dispose();
    this.haloMat.dispose();
    for (const w of this.warm) {
      this.scene.remove(w);
      w.geometry.dispose();
    }
  }
}
