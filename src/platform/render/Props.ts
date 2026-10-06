/**
 * Item props: fuse, film canister and the vintage flash camera (with a film counter screen).
 * `placeInHand` / `placeInWorld` position a prop either in a hand (canonical hand frame) or
 * resting in the world.
 *
 * Each prop uses its Blender model (camera.glb, fuse.glb, film.glb) when the ModelLibrary has it,
 * else a procedural stand-in. Model holds and resting poses are derived from the model's bounding
 * box (not hard-coded vertex numbers), so re-exported models keep sitting right.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Handedness } from '../../core/types';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { findNode, localBounds, meshesOf, type ModelLibrary } from './assets';
import { ensureIndexed, paint } from './util';

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
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

/**
 * Where the palm is in the canonical hand frame (wrist origin, fingers -Z, back of hand +Y):
 * the palm surface is ~2.4 cm below the wrist axis, the knuckles ~9 cm forward.
 */
const PALM_Y = -0.024;

/**
 * Hold `obj` so that its own point `objPoint` lands on `handPoint` (right-hand numbers; x is
 * mirrored for the left hand), with the object rotated by `rot` relative to the hand.
 */
function placeHeld(
  obj: THREE.Object3D, hand: Handedness, wristPos: THREE.Vector3, wristQuat: THREE.Quaternion,
  rot: THREE.Quaternion, objPoint: THREE.Vector3, handPoint: readonly [number, number, number],
): void {
  const mx = hand === 'left' ? -1 : 1;
  _v.copy(objPoint).applyQuaternion(rot).negate().add(_v2.set(handPoint[0] * mx, handPoint[1], handPoint[2]));
  _m.compose(wristPos, wristQuat, _s);
  _m2.compose(_v, rot, _s);
  _m.multiply(_m2);
  _m.decompose(obj.position, obj.quaternion, obj.scale);
}

/** Place `obj` at `offset` (hand frame, right-hand numbers; mirrored for the left) with `rot`. */
function placeHand(
  obj: THREE.Object3D, hand: Handedness, wristPos: THREE.Vector3, wristQuat: THREE.Quaternion,
  offset: [number, number, number], rot: THREE.Quaternion,
): void {
  placeHeld(obj, hand, wristPos, wristQuat, rot, ZERO, offset);
}

function placeWorld(obj: THREE.Object3D, x: number, y: number, z: number, yaw: number, lift: number): void {
  obj.position.set(x, y + lift, z);
  obj.quaternion.setFromAxisAngle(_v.set(0, 1, 0), yaw);
  obj.scale.set(1, 1, 1);
}

/**
 * Rest `obj` on a surface: rotated by `rest` (e.g. a fuse lying on its side), then turned by `yaw`,
 * with the bottom of its rotated bounds at `y` and `pivot` (rotated-bounds point) above (x, z).
 */
function placeResting(obj: THREE.Object3D, x: number, y: number, z: number, yaw: number, rest: THREE.Quaternion, pivot: THREE.Vector3): void {
  _q.setFromAxisAngle(_v.set(0, 1, 0), yaw);
  obj.quaternion.copy(_q).multiply(rest);
  obj.position.copy(pivot).negate().applyQuaternion(_q).add(_v2.set(x, y, z));
  obj.scale.set(1, 1, 1);
}

/** Bounds of a model rotated by `rest`: returns the bottom-center pivot and the bounds. */
function restPivot(bounds: THREE.Box3, rest: THREE.Quaternion, center: 'bounds' | 'origin'): THREE.Vector3 {
  const b = bounds.clone().applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(rest));
  const c = b.getCenter(new THREE.Vector3());
  return center === 'bounds' ? new THREE.Vector3(c.x, b.min.y, c.z) : new THREE.Vector3(0, b.min.y, 0);
}

/** Per-prop copy of a GLB material with a warm "glint" emission driven by the base color map. */
function glintMaterial(src: THREE.Material, warm: number): THREE.MeshStandardMaterial | null {
  if (!(src instanceof THREE.MeshStandardMaterial)) return null;
  const m = src.clone();
  m.userData = {};
  m.emissive.set(warm);
  // Bright parts (brass, the label) catch the glint, dark parts barely do.
  m.emissiveMap = src.map;
  m.emissiveIntensity = 0;
  return m;
}

/** GLB part of a prop: the instance plus the materials it owns. */
class ModelBody {
  readonly root: THREE.Object3D;
  readonly bounds: THREE.Box3;
  private readonly owned: THREE.Material[] = [];

  constructor(lib: ModelLibrary, name: string) {
    this.root = lib.instance(name)!;
    this.bounds = localBounds(this.root);
    for (const m of meshesOf(this.root)) {
      m.castShadow = m.receiveShadow = false;
    }
  }

  /** Give `mesh` its own material (tracked for dispose). */
  own<T extends THREE.Material>(mesh: THREE.Mesh, mat: T): T {
    mesh.material = mat;
    this.owned.push(mat);
    return mat;
  }

  dispose(): void {
    for (const m of this.owned) m.dispose();
    this.root.removeFromParent();
  }
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
const ZERO = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const rotZ = (a: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(AXIS_Z, a);
/** Camera held by its end: top toward the thumb (right hand: thumb on -X => +90 deg about Z). */
const CAM_HOLD: Record<Handedness, THREE.Quaternion> = {
  right: rotZ(Math.PI / 2),
  left: rotZ(-Math.PI / 2),
};
const ROT_Z_NEG90 = rotZ(-Math.PI / 2);
/** Long axis (model +Y) across the palm, toward the little finger (+X for the right hand). */
const ACROSS_PALM: Record<Handedness, THREE.Quaternion> = { right: rotZ(-Math.PI / 2), left: rotZ(Math.PI / 2) };
/** Model +Y lying along world -X (on its side). */
const ON_SIDE = rotZ(Math.PI / 2);

// ---------------------------------------------------------------------------------------------
// Fuse
// ---------------------------------------------------------------------------------------------

export class FuseProp implements Prop {
  readonly group = new THREE.Group();
  private readonly coreMat: THREE.MeshLambertMaterial | null = null;
  private readonly model: ModelBody | null = null;
  private readonly glint: THREE.MeshStandardMaterial[] = [];
  private readonly rest: THREE.Vector3 | null = null;
  private readonly radius: number = 0.0138;

  constructor(lib: ModelLibrary | null = null) {
    this.group.name = 'fuse';
    if (lib?.has('fuse')) {
      // fuse.glb: long axis = model Y, origin = center; node `glass` stays transparent.
      const body = (this.model = new ModelBody(lib, 'fuse'));
      for (const m of meshesOf(body.root)) {
        if (m.name === 'glass' || m.parent?.name === 'glass' || (m.material as THREE.Material).transparent) {
          m.renderOrder = 3;
          continue;
        }
        const g = glintMaterial(m.material as THREE.Material, 0xffa040);
        if (g) this.glint.push(body.own(m, g));
      }
      this.group.add(body.root);
      this.rest = restPivot(body.bounds, ON_SIDE, 'origin');
      this.radius = Math.max(0.005, (body.bounds.max.x - body.bounds.min.x) / 2);
      return;
    }
    const r = res();
    this.coreMat = new THREE.MeshLambertMaterial({ color: 0x6a5030, emissive: 0xffa040, emissiveIntensity: 0 });
    const glass = new THREE.Mesh(r.fuseGlass, r.glassMat);
    glass.renderOrder = 3;
    this.group.add(new THREE.Mesh(r.fuseMetal, r.metalMat), new THREE.Mesh(r.fuseCore, this.coreMat), glass);
  }

  setGlint(distance: number): void {
    const k = glintFactor(distance);
    if (this.coreMat) this.coreMat.emissiveIntensity = 0.9 * k;
    for (const m of this.glint) m.emissiveIntensity = 0.55 * k;
  }

  placeInHand(hand: Handedness, p: THREE.Vector3, q: THREE.Quaternion): void {
    if (this.model) {
      // Lying across the palm, the fingers closing around it.
      placeHeld(this.group, hand, p, q, ACROSS_PALM[hand], ZERO, [0.004, PALM_Y - this.radius - 0.002, -0.06]);
      return;
    }
    placeHand(this.group, hand, p, q, [0.002, -0.03, -0.058], IDENT);
  }

  placeInWorld(x: number, y: number, z: number, yaw: number): void {
    if (this.rest) placeResting(this.group, x, y, z, yaw, ON_SIDE, this.rest);
    else placeWorld(this.group, x, y, z, yaw, 0.0138);
  }

  dispose(): void {
    this.coreMat?.dispose();
    this.model?.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Film canister
// ---------------------------------------------------------------------------------------------

export class FilmProp implements Prop {
  readonly group = new THREE.Group();
  private readonly labelMat: THREE.MeshLambertMaterial | null = null;
  private readonly model: ModelBody | null = null;
  private readonly glint: THREE.MeshStandardMaterial[] = [];
  private readonly rest: THREE.Vector3 | null = null;
  private readonly hold = new THREE.Vector3();
  private radius = 0.016;

  constructor(lib: ModelLibrary | null = null) {
    this.group.name = 'film';
    if (lib?.has('film')) {
      // film.glb: standing canister, origin = bottom center (the film leader sticks out to +X).
      const body = (this.model = new ModelBody(lib, 'film'));
      for (const m of meshesOf(body.root)) {
        const g = glintMaterial(m.material as THREE.Material, 0xffb050);
        if (g) this.glint.push(body.own(m, g));
      }
      this.group.add(body.root);
      this.rest = restPivot(body.bounds, IDENT, 'origin');
      const b = body.bounds;
      this.radius = Math.max(0.008, (b.max.z - b.min.z) / 2);
      // Hold point: middle of the canister's axis.
      this.hold.set(0, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
      return;
    }
    const r = res();
    this.labelMat = new THREE.MeshLambertMaterial({ color: 0xc8902a, emissive: 0xffb050, emissiveIntensity: 0 });
    this.group.add(new THREE.Mesh(r.filmBody, r.metalMat), new THREE.Mesh(r.filmLabel, this.labelMat));
  }

  setGlint(distance: number): void {
    const k = glintFactor(distance);
    if (this.labelMat) this.labelMat.emissiveIntensity = 0.35 * k;
    for (const m of this.glint) m.emissiveIntensity = 0.3 * k;
  }

  placeInHand(hand: Handedness, p: THREE.Vector3, q: THREE.Quaternion): void {
    if (this.model) {
      placeHeld(this.group, hand, p, q, ACROSS_PALM[hand], this.hold, [0.004, PALM_Y - this.radius - 0.002, -0.06]);
      return;
    }
    placeHand(this.group, hand, p, q, [-0.025, -0.032, -0.058], ROT_Z_NEG90);
  }

  placeInWorld(x: number, y: number, z: number, yaw: number): void {
    if (this.rest) placeResting(this.group, x, y, z, yaw, IDENT, this.rest);
    else placeWorld(this.group, x, y, z, yaw, 0);
  }

  dispose(): void {
    this.labelMat?.dispose();
    this.model?.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------------------------

/** How far forward of the wrist the camera's front face sits when held (fingers wrap it). */
const CAM_FRONT_Z = -0.088;

export class CameraProp implements Prop {
  readonly group = new THREE.Group();
  private readonly reflectorMat: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
  private readonly screenMat: THREE.MeshBasicMaterial;
  private readonly screenTex: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private film = -1;
  private flashTime = -1e9;
  private readonly lens: THREE.Object3D;
  private readonly model: ModelBody | null = null;
  private readonly rest: THREE.Vector3 | null = null;
  /** Model points that rest in the palm, per hand (the end of the body on that hand's side). */
  private readonly grip: Record<Handedness, THREE.Vector3> | null = null;
  private readonly ownGeo: THREE.BufferGeometry[] = [];

  constructor(lib: ModelLibrary | null = null) {
    this.group.name = 'camera';
    // Film counter screen texture (both versions).
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 128;
    this.screenTex = new THREE.CanvasTexture(this.canvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    this.screenMat = new THREE.MeshBasicMaterial({ map: this.screenTex, fog: false });

    if (lib?.has('camera')) {
      // camera.glb: origin = right-hand grip, lens faces -Z; nodes lens, flash_reflector, film_screen.
      const body = (this.model = new ModelBody(lib, 'camera'));
      const root = body.root;
      this.group.add(root);
      this.lens = findNode(root, 'lens') ?? this.makeLens(root, body.bounds);
      // Flash reflector: its own copy of the material so it can blaze white during a flash.
      let refl: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial | null = null;
      const reflNode = findNode(root, 'flash_reflector');
      if (reflNode) {
        for (const m of meshesOf(reflNode)) {
          const src = m.material as THREE.Material;
          const mat = src instanceof THREE.MeshStandardMaterial ? src.clone() : new THREE.MeshBasicMaterial({ color: 0x1a1c22 });
          mat.userData = {};
          refl = body.own(m, mat);
        }
      }
      this.reflectorMat = refl ?? new THREE.MeshBasicMaterial({ color: 0x1a1c22 });
      // Film counter on the back: unlit canvas texture.
      const screen = findNode(root, 'film_screen');
      if (screen) {
        for (const m of meshesOf(screen)) {
          m.material = this.screenMat;
          orientScreenTexture(m, this.screenTex);
        }
      }
      const b = body.bounds;
      this.rest = restPivot(b, IDENT, 'bounds');
      // Palm against the end of the body on the holding hand's side, at grip height (model origin).
      this.grip = {
        right: new THREE.Vector3(b.max.x, 0, b.min.z),
        left: new THREE.Vector3(b.min.x, 0, b.min.z),
      };
    } else {
      const r = res();
      this.group.add(new THREE.Mesh(r.camBody, r.camMat));
      // Flash reflector (glows during a flash).
      this.reflectorMat = new THREE.MeshBasicMaterial({ color: 0x1a1c22 });
      const reflGeo = new THREE.PlaneGeometry(0.048, 0.03);
      const refl = new THREE.Mesh(reflGeo, this.reflectorMat);
      refl.position.set(-0.032, 0.066, -0.0225);
      refl.rotation.y = Math.PI;
      this.group.add(refl);
      // Back screen with the film count.
      const screenGeo = new THREE.PlaneGeometry(0.07, 0.035);
      const screen = new THREE.Mesh(screenGeo, this.screenMat);
      screen.position.set(0.012, -0.006, 0.0252);
      this.group.add(screen);
      this.ownGeo.push(reflGeo, screenGeo);
      this.lens = new THREE.Object3D();
      this.lens.position.set(-0.012, -0.004, -0.065);
      this.group.add(this.lens);
    }
    this.setFilm(0);
  }

  /** Fallback lens marker at the front center of the bounds (model without a `lens` node). */
  private makeLens(root: THREE.Object3D, b: THREE.Box3): THREE.Object3D {
    const o = new THREE.Object3D();
    o.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z);
    root.add(o);
    return o;
  }

  /** Where the flash comes from (world), for the caller's convenience. */
  getLensWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    return this.lens.getWorldPosition(out);
  }

  setFilm(film: number): void {
    if (film === this.film) return;
    this.film = film;
    const g = this.canvas.getContext('2d');
    if (!g) return;
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
    const m = this.reflectorMat;
    if (m instanceof THREE.MeshStandardMaterial) m.emissive.setRGB(k, k, k);
    else m.color.setRGB(0.012 + k, 0.013 + k, 0.016 + k);
    // The screen is a dim self-lit LCD: brighter when it is close to the viewer (in hand).
    const near = 1 - Math.min(1, Math.max(0, (glintDistance - 0.8) / 4));
    this.screenMat.color.setScalar(0.25 + 0.75 * near);
  }

  setGlint(distance: number): void {
    void distance;
  }

  placeInHand(hand: Handedness, p: THREE.Vector3, q: THREE.Quaternion): void {
    // Held by its right/left end, lens along the fingers (-Z), top toward the thumb.
    if (this.grip) {
      placeHeld(this.group, hand, p, q, CAM_HOLD[hand], this.grip[hand], [0, PALM_Y, CAM_FRONT_Z]);
      return;
    }
    placeHand(this.group, hand, p, q, [0.0, -0.07, -0.055], CAM_HOLD[hand]);
  }

  placeInWorld(x: number, y: number, z: number, yaw: number): void {
    if (this.rest) placeResting(this.group, x, y, z, yaw, IDENT, this.rest);
    else placeWorld(this.group, x, y, z, yaw, 0.04);
  }

  dispose(): void {
    this.reflectorMat.dispose();
    this.screenMat.dispose();
    this.screenTex.dispose();
    for (const g of this.ownGeo) g.dispose();
    this.model?.dispose();
  }
}

/**
 * Make the counter texture read the right way round on the screen mesh, whatever its UV layout:
 * u should grow to the viewer's right and v upward when looking at the screen's front.
 */
function orientScreenTexture(mesh: THREE.Mesh, tex: THREE.Texture): void {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  const nrm = g.getAttribute('normal');
  if (!pos || !uv || !nrm || pos.count < 3) return;
  const n = new THREE.Vector3(nrm.getX(0), nrm.getY(0), nrm.getZ(0)).normalize();
  const up = Math.abs(n.y) > 0.9 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, n).normalize();
  up.crossVectors(n, right).normalize();
  // Least-squares-ish: correlate u with "right" and v with "up" over the vertices.
  let ur = 0, uu = 0, vr = 0, vu = 0;
  const c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) c.add(_v.set(pos.getX(i), pos.getY(i), pos.getZ(i)));
  c.multiplyScalar(1 / pos.count);
  for (let i = 0; i < pos.count; i++) {
    _v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(c);
    const r = _v.dot(right), u = _v.dot(up);
    const du = uv.getX(i) - 0.5, dv = uv.getY(i) - 0.5;
    ur += du * r; uu += du * u; vr += dv * r; vu += dv * u;
  }
  tex.center.set(0.5, 0.5);
  if (Math.abs(ur) >= Math.abs(uu)) {
    // u along right/left, v along up/down: flip as needed.
    tex.repeat.set(ur >= 0 ? 1 : -1, vu >= 0 ? 1 : -1);
    tex.rotation = 0;
  } else {
    // UVs are rotated a quarter turn.
    tex.rotation = uu >= 0 ? -Math.PI / 2 : Math.PI / 2;
    tex.repeat.set(1, vr >= 0 ? -1 : 1);
  }
  tex.needsUpdate = true;
}
