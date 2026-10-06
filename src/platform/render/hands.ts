/**
 * Hands: the rigged Blender hands (public/models/hand_left|right.glb) when loaded, otherwise the
 * procedural HandModel. Both are driven by the canonical HandPose (wrist + 5 finger curls).
 *
 * GLB convention (written by art/blender/hands.py into each bone's glTF extras):
 *   bone.quaternion = rest * axisAngle(curlAxis, curl * curlAngle)
 * with `finger` = index into FingerCurls (0 thumb .. 4 pinky).
 */

import * as THREE from 'three';
import type { Handedness, HandPose } from '../../core/types';
import { bakeObject, type ModelLibrary, type ModelAsset } from './assets';
import { HandModel } from './HandModel';
import { setQ, setV } from './util';

/** What the renderer needs from a hand, whichever implementation draws it. */
export interface Hand {
  readonly mesh: THREE.Object3D;
  readonly handedness: Handedness;
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  readonly curls: [number, number, number, number, number];
  visible: boolean;
  setMaterial(m: THREE.Material): void;
  setPose(pose: HandPose): void;
  setTransform(position: THREE.Vector3, quaternion: THREE.Quaternion, curls: ArrayLike<number>): void;
  frameMatrix(out: THREE.Matrix4): THREE.Matrix4;
  dispose(): void;
}

interface CurlBone {
  bone: THREE.Object3D;
  rest: THREE.Quaternion;
  axis: THREE.Vector3;
  angle: number;
  finger: number;
}

const _q = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);

export class SkinnedHand implements Hand {
  readonly mesh = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly curls: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  private readonly bones: CurlBone[] = [];
  private readonly skins: THREE.Mesh[] = [];
  /** The GLB's textured skin, tinted per role (local / remote glove color). */
  private readonly skinMat: THREE.MeshStandardMaterial | null;
  private readonly sourceMat: THREE.Material | null;

  constructor(readonly handedness: Handedness, instance: THREE.Object3D, material: THREE.Material) {
    this.mesh.name = `hand-${handedness}`;
    this.mesh.add(instance);
    instance.traverse((o) => {
      const ud = o.userData as { curlAxis?: number[]; curlAngle?: number; finger?: number };
      if (Array.isArray(ud.curlAxis) && typeof ud.curlAngle === 'number' && typeof ud.finger === 'number') {
        this.bones.push({
          bone: o,
          rest: o.quaternion.clone(),
          axis: new THREE.Vector3().fromArray(ud.curlAxis).normalize(),
          angle: ud.curlAngle,
          finger: ud.finger,
        });
      }
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.frustumCulled = false;
        this.skins.push(m);
      }
    });
    const src = (this.skins[0]?.material ?? null) as THREE.Material | null;
    this.sourceMat = src;
    this.skinMat = src instanceof THREE.MeshStandardMaterial ? src.clone() : null;
    this.setMaterial(material);
    this.apply();
  }

  /** True when the GLB carries the curl metadata this class needs. */
  static usable(asset: ModelAsset): boolean {
    let n = 0;
    asset.scene.traverse((o) => {
      if (Array.isArray((o.userData as { curlAxis?: unknown }).curlAxis)) n++;
    });
    return n >= 10;
  }

  get visible(): boolean {
    return this.mesh.visible;
  }
  set visible(v: boolean) {
    this.mesh.visible = v;
  }

  /**
   * Transparent materials (the caught-player ghost) are used as-is; any other material is a
   * "role" hint: its color tints the textured skin and its emissive (local self-glow) carries over.
   */
  setMaterial(m: THREE.Material): void {
    let use: THREE.Material = m;
    if (!m.transparent && this.skinMat) {
      const hint = m as THREE.MeshLambertMaterial;
      if (hint.color) this.skinMat.color.copy(hint.color).lerp(new THREE.Color(1, 1, 1), 0.55);
      if (hint.emissive) this.skinMat.emissive.copy(hint.emissive).multiplyScalar(hint.emissiveIntensity ?? 1);
      use = this.skinMat;
    } else if (!m.transparent && this.sourceMat) {
      use = this.sourceMat;
    }
    for (const s of this.skins) s.material = use;
  }

  setPose(pose: HandPose): void {
    this.mesh.visible = pose.tracked;
    if (!pose.tracked) return;
    setV(this.position, pose.position);
    setQ(this.quaternion, pose.rotation);
    for (let i = 0; i < 5; i++) this.curls[i] = pose.curls[i];
    this.apply();
  }

  setTransform(position: THREE.Vector3, quaternion: THREE.Quaternion, curls: ArrayLike<number>): void {
    this.position.copy(position);
    this.quaternion.copy(quaternion);
    for (let i = 0; i < 5; i++) this.curls[i] = curls[i];
    this.apply();
  }

  private apply(): void {
    this.mesh.position.copy(this.position);
    this.mesh.quaternion.copy(this.quaternion);
    for (const b of this.bones) {
      const c = THREE.MathUtils.clamp(this.curls[b.finger] ?? 0, 0, 1);
      b.bone.quaternion.copy(b.rest).multiply(_q.setFromAxisAngle(b.axis, c * b.angle));
    }
  }

  frameMatrix(out: THREE.Matrix4): THREE.Matrix4 {
    return out.compose(this.position, this.quaternion, _one);
  }

  bake(out: THREE.BufferGeometry[], inflate = 1): void {
    bakeObject(this.mesh, out, (inflate - 1) * 0.025);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.skinMat?.dispose();
  }
}

/**
 * Creates hands. Before `use(lib)` (or when the GLBs are missing/unusable) it makes procedural
 * HandModels; afterwards SkinnedHands.
 */
export class HandFactory {
  private lib: ModelLibrary | null = null;
  private readonly scratch: Partial<Record<Handedness, SkinnedHand>> = {};
  private readonly scratchMat = new THREE.MeshBasicMaterial();

  /** Start using GLB hands if both loaded and carry curl metadata. Returns true if so. */
  use(lib: ModelLibrary): boolean {
    const l = lib.get('hand_left');
    const r = lib.get('hand_right');
    if (!l || !r || !SkinnedHand.usable(l) || !SkinnedHand.usable(r)) return false;
    this.lib = lib;
    return true;
  }

  get skinned(): boolean {
    return this.lib !== null;
  }

  create(side: Handedness, material: THREE.Material): Hand {
    const inst = this.lib?.instance(`hand_${side}`);
    return inst ? new SkinnedHand(side, inst, material) : new HandModel(side, material);
  }

  /** World-space afterimage geometry for a hand pose (no live instance needed). */
  bakePose(
    side: Handedness,
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
    curls: ArrayLike<number>,
    out: THREE.BufferGeometry[],
    inflate = 1,
  ): void {
    if (!this.lib) {
      HandModel.bakePose(side, position, quaternion, curls, out, inflate);
      return;
    }
    let h = this.scratch[side];
    if (!h) {
      const inst = this.lib.instance(`hand_${side}`);
      if (!inst) {
        HandModel.bakePose(side, position, quaternion, curls, out, inflate);
        return;
      }
      h = this.scratch[side] = new SkinnedHand(side, inst, this.scratchMat);
    }
    h.setTransform(position, quaternion, curls);
    h.bake(out, inflate);
  }
}
