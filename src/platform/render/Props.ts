/**
 * Item props: fuse, film canister and the vintage flash camera (with a film counter screen).
 * Each prop is a small Group whose origin is its "hold point"; `placeInHand` / `placeInWorld`
 * position it either in a hand (canonical hand frame) or lying in the world.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Handedness } from '../../core/types';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ensureIndexed, paint } from './util';

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  for (const p of parts) {
    if (p.attributes.uv) p.deleteAttribute('uv');
    ensureIndexed(p);
  }
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  g.userData.shared = true;
  return g;
}

function cyl(r: number, h: number, seg: number, axis: 'x' | 'y' | 'z', at: [number, number, number], color: number, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, h, seg, 1, open);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(at[0], at[1], at[2]);
  return paint(g, color);
}

function box(sx: number, sy: number, sz: number, at: [number, number, number], color: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz).translate(at[0], at[1], at[2]);
  return paint(g, color);
}

/** Warm glint that is only visible within ~1.5 m of the viewer. */
export function glintFactor(distance: number): number {
  const k = (1.6 - distance) / 1.0;
  return k <= 0 ? 0 : k >= 1 ? 1 : k * k;
}

// ---------------------------------------------------------------------------------------------
// Shared resources (built lazily, never disposed: tiny and reused across levels)
// ---------------------------------------------------------------------------------------------

let shared: {
  fuseGlass: THREE.BufferGeometry;
  fuseMetal: THREE.BufferGeometry;
  fuseCore: THREE.BufferGeometry;
  filmBody: THREE.BufferGeometry;
  filmLabel: THREE.BufferGeometry;
  camBody: THREE.BufferGeometry;
  glassMat: THREE.Material;
  metalMat: THREE.Material;
  camMat: THREE.Material;
} | null = null;

function res(): NonNullable<typeof shared> {
  if (shared) return shared;
  const fuseGlass = new THREE.CylinderGeometry(0.0118, 0.0118, 0.078, 14, 1, true).rotateZ(Math.PI / 2);
  fuseGlass.userData.shared = true;
  const fuseMetal = merged([
    cyl(0.0138, 0.022, 14, 'x', [-0.045, 0, 0], 0xa08a5a),
    cyl(0.0138, 0.022, 14, 'x', [0.045, 0, 0], 0xa08a5a),
    cyl(0.006, 0.014, 10, 'x', [-0.062, 0, 0], 0x8a7a50),
    cyl(0.006, 0.014, 10, 'x', [0.062, 0, 0], 0x8a7a50),
    cyl(0.0141, 0.004, 14, 'x', [-0.036, 0, 0], 0x5a4a30),
    cyl(0.0141, 0.004, 14, 'x', [0.036, 0, 0], 0x5a4a30),
  ]);
  const fuseCore = new THREE.CylinderGeometry(0.0055, 0.0055, 0.07, 8).rotateZ(Math.PI / 2);
  fuseCore.userData.shared = true;
  // Film canister: standing, bottom at y = 0.
  const filmBody = merged([
    cyl(0.0175, 0.05, 16, 'y', [0, 0.025, 0], 0x1a1a1c),
    cyl(0.0185, 0.006, 16, 'y', [0, 0.003, 0], 0x6a6a6c),
    cyl(0.0185, 0.006, 16, 'y', [0, 0.047, 0], 0x6a6a6c),
    cyl(0.007, 0.01, 10, 'y', [0, 0.055, 0], 0x2a2a2a),
    box(0.003, 0.034, 0.026, [0.0185, 0.025, 0.012], 0x5a3a1c),
  ]);
  const filmLabel = new THREE.CylinderGeometry(0.0178, 0.0178, 0.03, 16, 1, true).translate(0, 0.025, 0);
  filmLabel.userData.shared = true;
  // Camera body: origin at body center, lens along -Z, top +Y. 13 x 8 x 5 cm.
  const body = new RoundedBoxGeometry(0.13, 0.08, 0.05, 2, 0.008);
  const camBody = merged([
    paint(body, 0x1d1b1a),
    box(0.128, 0.012, 0.048, [0, 0.036, 0], 0x8c8b86),
    cyl(0.027, 0.012, 20, 'z', [-0.012, -0.004, -0.031], 0x9a9a96),
    cyl(0.024, 0.026, 20, 'z', [-0.012, -0.004, -0.049], 0x161616),
    cyl(0.026, 0.004, 20, 'z', [-0.012, -0.004, -0.061], 0x8a8a86),
    cyl(0.018, 0.002, 20, 'z', [-0.012, -0.004, -0.0625], 0x0a0d16),
    box(0.034, 0.022, 0.03, [0.036, 0.051, 0.004], 0x2a2928),
    // Flash unit on top: housing + side bracket.
    box(0.056, 0.04, 0.036, [-0.032, 0.066, -0.004], 0x8c8b86),
    box(0.06, 0.006, 0.03, [-0.032, 0.044, -0.004], 0x3a3938),
    cyl(0.005, 0.006, 10, 'y', [0.05, 0.045, 0.01], 0x9a9a96),
    // Wrist strap lug.
    box(0.006, 0.014, 0.01, [0.067, 0.02, 0], 0x6a6a66),
  ]);
  shared = {
    fuseGlass,
    fuseMetal,
    fuseCore,
    filmBody,
    filmLabel,
    camBody,
    glassMat: new THREE.MeshPhongMaterial({
      color: 0x9aa4a8, specular: 0xffffff, shininess: 90, transparent: true, opacity: 0.38, depthWrite: false,
    }),
    metalMat: new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0x777777, shininess: 60 }),
    camMat: new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0x333333, shininess: 35 }),
  };
  for (const m of [shared.glassMat, shared.metalMat, shared.camMat]) m.userData.shared = true;
  return shared;
}

// ---------------------------------------------------------------------------------------------
// Placement helpers
// ---------------------------------------------------------------------------------------------

/** Place `obj` at `offset` (hand frame, right-hand numbers; mirrored for the left) with `rot`. */
function placeHand(
  obj: THREE.Object3D, hand: Handedness, wristPos: THREE.Vector3, wristQuat: THREE.Quaternion,
  offset: [number, number, number], rot: THREE.Quaternion,
): void {
  const mx = hand === 'left' ? -1 : 1;
  _m.compose(wristPos, wristQuat, _s);
  _m2.compose(_v.set(offset[0] * mx, offset[1], offset[2]), rot, _s);
  _m.multiply(_m2);
  _m.decompose(obj.position, obj.quaternion, obj.scale);
}

function placeWorld(obj: THREE.Object3D, x: number, y: number, z: number, yaw: number, lift: number): void {
  obj.position.set(x, y + lift, z);
  obj.quaternion.setFromAxisAngle(_v.set(0, 1, 0), yaw);
  obj.scale.set(1, 1, 1);
}

export interface Prop {
  readonly group: THREE.Group;
  /** Update the glint for the viewer distance. */
  setGlint(distance: number): void;
  placeInHand(hand: Handedness, wristPos: THREE.Vector3, wristQuat: THREE.Quaternion): void;
  placeInWorld(x: number, y: number, z: number, yaw: number): void;
  dispose(): void;
}

const IDENT = new THREE.Quaternion();
const ROT_Z_NEG90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);

// ---------------------------------------------------------------------------------------------
// Fuse
// ---------------------------------------------------------------------------------------------

export class FuseProp implements Prop {
  readonly group = new THREE.Group();
  private readonly coreMat = new THREE.MeshLambertMaterial({ color: 0x6a5030, emissive: 0xffa040, emissiveIntensity: 0 });

  constructor() {
    const r = res();
    const glass = new THREE.Mesh(r.fuseGlass, r.glassMat);
    glass.renderOrder = 3;
    this.group.add(new THREE.Mesh(r.fuseMetal, r.metalMat), new THREE.Mesh(r.fuseCore, this.coreMat), glass);
    this.group.name = 'fuse';
  }

  setGlint(distance: number): void {
    this.coreMat.emissiveIntensity = 0.9 * glintFactor(distance);
  }

  placeInHand(hand: Handedness, p: THREE.Vector3, q: THREE.Quaternion): void {
    placeHand(this.group, hand, p, q, [0.002, -0.03, -0.058], IDENT);
  }

  placeInWorld(x: number, y: number, z: number, yaw: number): void {
    placeWorld(this.group, x, y, z, yaw, 0.0138);
  }

  dispose(): void {
    this.coreMat.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Film canister
// ---------------------------------------------------------------------------------------------

export class FilmProp implements Prop {
  readonly group = new THREE.Group();
  private readonly labelMat = new THREE.MeshLambertMaterial({ color: 0xc8902a, emissive: 0xffb050, emissiveIntensity: 0 });

  constructor() {
    const r = res();
    this.group.add(new THREE.Mesh(r.filmBody, r.metalMat), new THREE.Mesh(r.filmLabel, this.labelMat));
    this.group.name = 'film';
  }

  setGlint(distance: number): void {
    this.labelMat.emissiveIntensity = 0.35 * glintFactor(distance);
  }

  placeInHand(hand: Handedness, p: THREE.Vector3, q: THREE.Quaternion): void {
    placeHand(this.group, hand, p, q, [-0.025, -0.032, -0.058], ROT_Z_NEG90);
  }

  placeInWorld(x: number, y: number, z: number, yaw: number): void {
    placeWorld(this.group, x, y, z, yaw, 0);
  }

  dispose(): void {
    this.labelMat.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------------------------

export class CameraProp implements Prop {
  readonly group = new THREE.Group();
  private readonly reflectorMat = new THREE.MeshBasicMaterial({ color: 0x1a1c22 });
  private readonly screenMat: THREE.MeshBasicMaterial;
  private readonly screenTex: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private film = -1;
  private flashTime = -1e9;
  private readonly lens = new THREE.Object3D();

  constructor() {
    const r = res();
    this.group.name = 'camera';
    this.group.add(new THREE.Mesh(r.camBody, r.camMat));
    // Flash reflector (glows during a flash).
    const refl = new THREE.Mesh(new THREE.PlaneGeometry(0.048, 0.03), this.reflectorMat);
    refl.position.set(-0.032, 0.066, -0.0225);
    refl.rotation.y = Math.PI;
    this.group.add(refl);
    // Back screen with the film count.
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 128;
    this.screenTex = new THREE.CanvasTexture(this.canvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    this.screenMat = new THREE.MeshBasicMaterial({ map: this.screenTex, fog: false });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.035), this.screenMat);
    screen.position.set(0.012, -0.006, 0.0252);
    this.group.add(screen);
    this.lens.position.set(-0.012, -0.004, -0.065);
    this.group.add(this.lens);
    this.setFilm(0);
  }

  /** Where the flash comes from (world), for the caller's convenience. */
  getLensWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    return this.lens.getWorldPosition(out);
  }

  setFilm(film: number): void {
    if (film === this.film) return;
    this.film = film;
    const g = this.canvas.getContext('2d')!;
    const W = this.canvas.width, H = this.canvas.height;
    g.fillStyle = '#050b07';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#1d3a26';
    g.lineWidth = 6;
    g.strokeRect(3, 3, W - 6, H - 6);
    const on = film > 0 ? '#79e892' : '#e86a5a';
    g.fillStyle = on;
    g.font = 'bold 26px monospace';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillText(film > 0 ? 'FILM' : 'NO FILM', 16, 12);
    g.font = 'bold 74px monospace';
    g.textAlign = 'right';
    g.fillText(String(Math.max(0, film)), W - 16, 6);
    // Frame pips: filled = shots left.
    const total = Math.max(6, Math.min(12, film));
    const pw = Math.min(26, (W - 32) / total - 4);
    for (let i = 0; i < total; i++) {
      const x = 16 + i * (pw + 4);
      if (i < film) {
        g.fillStyle = on;
        g.fillRect(x, 92, pw, 22);
      } else {
        g.strokeStyle = '#2c5a3a';
        g.lineWidth = 2;
        g.strokeRect(x + 1, 93, pw - 2, 20);
      }
    }
    this.screenTex.needsUpdate = true;
  }

  flashed(time: number): void {
    this.flashTime = time;
  }

  update(time: number, glintDistance: number): void {
    const a = time - this.flashTime;
    const k = a >= 0 && a < 0.25 ? Math.pow(1 - a / 0.25, 2) : 0;
    this.reflectorMat.color.setRGB(0.012 + k, 0.013 + k, 0.016 + k);
    // The screen is a dim self-lit LCD: brighter when it is close to the viewer (in hand).
    const near = 1 - Math.min(1, Math.max(0, (glintDistance - 0.8) / 4));
    this.screenMat.color.setScalar(0.25 + 0.75 * near);
  }

  setGlint(distance: number): void {
    void distance;
  }

  placeInHand(hand: Handedness, p: THREE.Vector3, q: THREE.Quaternion): void {
    // Held by its right/left end, lens along the fingers (-Z), top toward the thumb.
    const rot = _q.setFromAxisAngle(_v.set(0, 0, 1), (hand === 'left' ? -1 : 1) * Math.PI / 2);
    placeHand(this.group, hand, p, q, [0.0, -0.07, -0.055], rot.clone());
  }

  placeInWorld(x: number, y: number, z: number, yaw: number): void {
    placeWorld(this.group, x, y, z, yaw, 0.04);
  }

  dispose(): void {
    this.reflectorMat.dispose();
    this.screenMat.dispose();
    this.screenTex.dispose();
    for (const c of this.group.children) {
      const m = c as THREE.Mesh;
      if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
    }
  }
}
