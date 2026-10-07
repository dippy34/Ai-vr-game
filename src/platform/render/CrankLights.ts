/**
 * The Crank Light: every player's wind-up flashlight (the only real light in the house).
 *
 *  - One SpotLight per player slot, all created up front and never added or removed (a change in
 *    light count recompiles every material: a hitch on the Quest). Idle beams sit at intensity 0,
 *    which the light loops skip (fx/pipeline).
 *  - Slot 0 is always the local player's: it casts soft PCF shadows through a lens cookie (hot
 *    centre, reflector ring, wide dim spill), throws a faint bounce light into the room it points
 *    into, and drives the shared FX uniforms (haze in-scatter + dust motes along the beam).
 *    Remote beams are plain spots (no shadow map, no cookie) to keep Quest frame time sane.
 *  - LightProp is the flashlight model: strapped to the back of the left wrist in VR (it never
 *    takes up a hand), held low on the right on desktop. Its lens glows with the beam, a little
 *    battery bar shows the charge and the crank handle spins while winding.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GAME, LIGHT, RENDER } from '../../config';
import type { CrankLightState } from '../../core/types';
import { FX } from './fx/pipeline';
import { ensureIndexed, paint } from './util';

/** Shadow camera near plane (m): the light's own body and the holder's hand never cast. */
const SHADOW_NEAR = 0.12;
/** Bounce light range past the wall the beam hits (m): limits leaking into the next room. */
const BOUNCE_REACH = 2.4;

/** Lens pattern of an old incandescent flashlight: hot centre, darker gap, reflector ring, spill. */
function beamCookie(): THREE.DataTexture {
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = ((x + 0.5) / N) * 2 - 1;
      const v = ((y + 0.5) / N) * 2 - 1;
      const r = Math.hypot(u, v);
      const hot = Math.exp(-r * r * 14);
      const ring = 0.32 * Math.exp(-Math.pow((r - 0.42) / 0.07, 2));
      const spill = 0.34 * (1 - THREE.MathUtils.smoothstep(r, 0.3, 1.0));
      const gap = 1 - 0.18 * Math.exp(-Math.pow((r - 0.3) / 0.06, 2));
      // A faint filament smudge off-centre: no two beams look like perfect discs.
      const smudge = 1 + 0.06 * Math.exp(-((u - 0.08) ** 2 + (v + 0.05) ** 2) * 60);
      const b = Math.min(1, (0.62 * hot + ring + spill) * gap * smudge);
      const i = (y * N + x) * 4;
      data[i] = Math.round(255 * b);
      data[i + 1] = Math.round(255 * b * 0.97);
      data[i + 2] = Math.round(255 * b * 0.9);
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N);
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = false;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Cheap smooth 1D value noise in 0..1 (deterministic). */
function noise1(t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const h = (n: number): number => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const k = f * f * (3 - 2 * f);
  return h(i) * (1 - k) + h(i + 1) * k;
}

/**
 * How bright a Crank Light is right now (0..1): full while charged, dimming and browning out
 * (random flickers, more often as it dies) below LIGHT.lowCharge, dark when flat. Winding pushes
 * current straight into the bulb, so it surges with each turn, even from flat.
 */
export function beamBrightness(light: Pick<CrankLightState, 'on' | 'charge' | 'cranking'>, time: number, seed = 0): number {
  if (!light.on) return 0;
  const crank = light.cranking ? 0.5 + 0.3 * (0.5 + 0.5 * Math.sin(time * 24 + seed)) : 0;
  const c = Math.max(0, Math.min(1, light.charge));
  if (c <= 0) return crank * 0.7;
  let k = 1;
  if (c < LIGHT.lowCharge) {
    const t = c / LIGHT.lowCharge;
    k = 0.3 + 0.7 * t;
    const n = noise1(time * 7 + seed * 13.7);
    if (n > 0.5 + 0.42 * t) k *= 0.12 + 0.5 * noise1(time * 31 + seed);
  }
  return Math.max(k, crank);
}

export class CrankLights {
  readonly spots: THREE.SpotLight[] = [];
  /** Fill bounced off whatever the local beam is pointed at. */
  readonly bounce: THREE.PointLight;
  private readonly cookie: THREE.DataTexture;
  private localK = 0;
  /** The shadow map exists and matches the light (re-rendered while lit, once after load). */
  private shadowFresh = false;

  constructor(scene: THREE.Scene, count: number = GAME.maxPlayers) {
    this.cookie = beamCookie();
    // `?shadows=0` (or RENDER.beamShadows = false): plain spots, no shadow map, no cookie.
    const shadows = RENDER.beamShadows && (typeof location === 'undefined' || new URLSearchParams(location.search).get('shadows') !== '0');
    for (let i = 0; i < count; i++) {
      const s = new THREE.SpotLight(RENDER.beamColor, 0, Math.min(RENDER.beamRange, RENDER.fogFar),
        THREE.MathUtils.degToRad(RENDER.beamAngle), RENDER.beamPenumbra, 2);
      s.name = i === 0 ? 'beamLocal' : `beam${i}`;
      if (i === 0 && shadows) {
        s.castShadow = true;
        s.map = this.cookie;
        s.shadow.camera.near = SHADOW_NEAR;
        s.shadow.bias = -0.0006;
        s.shadow.normalBias = 0.025;
      }
      s.position.set(0, -1000, 0);
      s.target.position.set(0, -1001, 0);
      scene.add(s, s.target);
      this.spots.push(s);
    }
    this.setShadowQuality(RENDER.tiers.desktop.shadowMapSize, RENDER.tiers.desktop.shadowRadius);
    this.bounce = new THREE.PointLight(RENDER.beamColor, 0, 4, 2);
    this.bounce.name = 'beamBounce';
    scene.add(this.bounce);
  }

  /** The local beam (casts shadows when enabled). */
  get local(): THREE.SpotLight {
    return this.spots[0];
  }

  /** Shadow map size (px) and PCF radius (texels); a new size reallocates the map on the next update. */
  setShadowQuality(size: number, radius: number): void {
    const sh = this.local.shadow;
    if (sh.mapSize.x !== size) {
      sh.mapSize.set(size, size);
      sh.map?.dispose();
      sh.map = null;
      this.shadowFresh = false;
    }
    sh.radius = radius;
  }

  /** Should the renderer re-render the beam shadow map this frame? (while the local beam is lit) */
  needsShadowUpdate(): boolean {
    if (!this.local.castShadow) return false;
    if (this.localK > 0 || !this.shadowFresh) {
      this.shadowFresh = true;
      return true;
    }
    return false;
  }

  /**
   * Aim beam `i` (0 = local) this frame. `k` 0..1 brightness; `hitDist` (local only) = how far the
   * beam's axis goes before it hits something (m), for the bounce light.
   */
  set(i: number, k: number, position: THREE.Vector3, direction: THREE.Vector3, hitDist = 4): void {
    const s = this.spots[i];
    if (!s) return;
    s.intensity = RENDER.beamIntensity * k;
    if (k > 0) {
      s.position.copy(position);
      s.target.position.copy(position).addScaledVector(direction, 3);
      s.target.updateMatrixWorld();
      s.updateMatrixWorld();
    }
    if (i !== 0) return;
    this.localK = k;
    const hit = Math.max(0.3, Math.min(hitDist, RENDER.beamRange));
    this.bounce.intensity = RENDER.beamBounce * k * Math.min(1, 2.5 / hit);
    this.bounce.position.copy(position).addScaledVector(direction, Math.max(0.2, hit * 0.8));
    this.bounce.distance = hit * 0.5 + BOUNCE_REACH;
    // The local beam is what lights the haze and the dust in front of you.
    FX.flashPos.set(s.position.x, s.position.y, s.position.z, k * RENDER.beamHaze);
    FX.flashDir.set(direction.x, direction.y, direction.z, Math.cos(s.angle));
  }

  /** Brightness of the local beam this frame. */
  get localBrightness(): number {
    return this.localK;
  }

  dispose(): void {
    for (const s of this.spots) {
      s.removeFromParent();
      s.target.removeFromParent();
      s.shadow.dispose();
    }
    this.bounce.removeFromParent();
    this.cookie.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// The flashlight model
// ---------------------------------------------------------------------------------------------

function part(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  if (g.attributes.uv) g.deleteAttribute('uv');
  return ensureIndexed(paint(g, color));
}

/** A cylinder along the light's axis (local Z), from z0 to z1. */
function tube(r0: number, r1: number, z0: number, z1: number, seg: number, color: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, Math.abs(z1 - z0), seg, 1, false).rotateX(Math.PI / 2);
  // Rotated, the cylinder's top (radius r1) is at +Z (the back) and its bottom (r0) at -Z (front).
  g.translate(0, 0, (z0 + z1) / 2);
  return part(g, color);
}

let propShared: {
  body: THREE.BufferGeometry;
  lens: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  bar: THREE.BufferGeometry;
  bodyMat: THREE.MeshStandardMaterial;
} | null = null;

function propRes(): NonNullable<typeof propShared> {
  if (propShared) return propShared;
  // Lens at z = 0 facing -Z, body runs back along +Z (about 13 cm long).
  const RUBBER = 0x1a1a1c;
  const STEEL = 0x8c8a86;
  const RED = 0x6e1712;
  const body = mergeGeometries([
    tube(0.026, 0.026, 0.0, 0.012, 24, STEEL), // bezel ring
    tube(0.025, 0.02, 0.012, 0.04, 24, RED), // head (an old red "Halcyon" field light)
    tube(0.018, 0.018, 0.04, 0.125, 18, RUBBER), // grip
    tube(0.0185, 0.0185, 0.07, 0.074, 18, STEEL), // grip band
    tube(0.0185, 0.0185, 0.1, 0.104, 18, STEEL),
    tube(0.019, 0.016, 0.125, 0.135, 18, STEEL), // tail cap
    // Crank housing on the side, and the strap block underneath (sits on the back of the wrist).
    part(new THREE.CylinderGeometry(0.013, 0.013, 0.012, 16).rotateZ(Math.PI / 2).translate(0.021, 0, 0.088), STEEL),
    part(new THREE.BoxGeometry(0.03, 0.012, 0.05).translate(0, -0.021, 0.085), RUBBER),
    // Switch on top.
    part(new THREE.BoxGeometry(0.008, 0.005, 0.012).translate(0, 0.02, 0.05), RED),
  ], false)!;
  const lens = new THREE.CircleGeometry(0.0225, 24).rotateY(Math.PI).translate(0, 0, -0.0005);
  // Crank arm + knob, pivoting about the housing axis (local X); built around the pivot.
  const arm = mergeGeometries([
    part(new THREE.BoxGeometry(0.004, 0.006, 0.03).translate(0, 0, 0.015), STEEL),
    part(new THREE.CylinderGeometry(0.0045, 0.0045, 0.012, 10).rotateZ(Math.PI / 2).translate(0.007, 0, 0.03), RUBBER),
  ], false)!;
  // Battery bar on the top of the head (scaled along X by the charge).
  const bar = new THREE.BoxGeometry(0.016, 0.002, 0.004).translate(0.008, 0, 0);
  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.25 });
  for (const g of [body, lens, arm, bar]) g.userData.shared = true;
  bodyMat.userData.shared = true;
  propShared = { body, lens, arm, bar, bodyMat };
  return propShared;
}

export class LightProp {
  readonly group = new THREE.Group();
  private readonly lensMat: THREE.MeshBasicMaterial;
  private readonly barMat: THREE.MeshBasicMaterial;
  private readonly arm: THREE.Mesh;
  private readonly bar: THREE.Mesh;
  private crankAngle = 0;

  constructor() {
    const r = propRes();
    const body = new THREE.Mesh(r.body, r.bodyMat);
    // The lens is "light in your eyes": unlit, its brightness set from the beam.
    this.lensMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const lens = new THREE.Mesh(r.lens, this.lensMat);
    this.arm = new THREE.Mesh(r.arm, r.bodyMat);
    this.arm.position.set(0.028, 0, 0.088);
    this.barMat = new THREE.MeshBasicMaterial({ color: 0x3fae5a });
    this.bar = new THREE.Mesh(r.bar, this.barMat);
    this.bar.position.set(-0.008, 0.026, 0.026);
    this.group.add(body, lens, this.arm, this.bar);
    this.group.name = 'crankLight';
  }

  /** Lens at `lens`, pointing along `quat`'s -Z. */
  place(lens: THREE.Vector3, quat: THREE.Quaternion): void {
    this.group.position.copy(lens);
    this.group.quaternion.copy(quat);
  }

  /** Per frame: lens glow from the beam, battery bar, crank spin. */
  update(k: number, charge: number, cranking: boolean, dt: number): void {
    const glow = 0.06 + 0.94 * k;
    this.lensMat.color.setRGB(k > 0 ? glow : 0.015, k > 0 ? glow * 0.86 : 0.015, k > 0 ? glow * 0.66 : 0.016);
    const c = Math.max(0, Math.min(1, charge));
    this.bar.scale.x = Math.max(0.04, c);
    this.barMat.color.setHex(c < LIGHT.lowCharge ? 0xc2442b : c < 0.5 ? 0xc9a23a : 0x3fae5a);
    if (cranking) this.crankAngle += dt * 14;
    this.arm.rotation.x = this.crankAngle;
  }

  dispose(): void {
    this.lensMat.dispose();
    this.barMat.dispose();
    this.group.removeFromParent();
  }
}
