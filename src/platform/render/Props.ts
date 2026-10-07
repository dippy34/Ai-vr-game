/**
 * Item props: the fuse (the only pickup; everyone's Crank Light lives in CrankLights.ts).
 * `placeInHand` / `placeInWorld` position a prop either in a hand (canonical hand frame) or
 * resting in the world.
 *
 * Each prop uses its Blender model (fuse.glb) when the ModelLibrary has it,
 * else a procedural stand-in. Model holds and resting poses are derived from the model's bounding
 * box (not hard-coded vertex numbers), so re-exported models keep sitting right.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Handedness } from '../../core/types';
import { localBounds, meshesOf, type ModelLibrary } from './assets';
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
  glassMat: THREE.Material;
  metalMat: THREE.Material;
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
  shared = {
    fuseGlass,
    fuseMetal,
    fuseCore,
    glassMat: new THREE.MeshPhongMaterial({
      color: 0x9aa4a8, specular: 0xffffff, shininess: 90, transparent: true, opacity: 0.38, depthWrite: false,
    }),
    metalMat: new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0x777777, shininess: 60 }),
  };
  for (const m of [shared.glassMat, shared.metalMat]) m.userData.shared = true;
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

/**
 * How the holder's hand is posed: 'grip' = a VR hand/controller (natural handshake orientation,
 * thumb up), 'palmDown' = a desktop player's resting hand (palm down, back of the hand up).
 */
export type HoldStyle = 'grip' | 'palmDown';

export interface Prop {
  readonly group: THREE.Group;
  /** Update the glint for the viewer distance. */
  setGlint(distance: number): void;
  placeInHand(hand: Handedness, wristPos: THREE.Vector3, wristQuat: THREE.Quaternion, style?: HoldStyle): void;
  placeInWorld(x: number, y: number, z: number, yaw: number): void;
  dispose(): void;
}

const IDENT = new THREE.Quaternion();
const ZERO = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const rotZ = (a: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(AXIS_Z, a);
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

  /** True when this is the Blender model (long axis = Y), false for the procedural one (axis X). */
  get modelled(): boolean {
    return this.model !== null;
  }

  setGlint(distance: number): void {
    const k = glintFactor(distance);
    if (this.coreMat) this.coreMat.emissiveIntensity = 0.9 * k;
    for (const m of this.glint) m.emissiveIntensity = 0.55 * k;
  }

  placeInHand(hand: Handedness, p: THREE.Vector3, q: THREE.Quaternion): void {
    if (this.model) {
      // Lying across the palm, the fingers closing around it.
      // Shifted toward the thumb so one end pokes out past it (visible, like gripping a stick).
      placeHeld(this.group, hand, p, q, ACROSS_PALM[hand], ZERO, [-0.022, PALM_Y - this.radius - 0.002, -0.058]);
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
