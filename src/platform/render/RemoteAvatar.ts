/**
 * Remote player avatar: head + torso + two hands, exponentially smoothed toward the latest pose.
 *
 * Head and torso are the Blender models (avatar_head.glb: origin = eye center; avatar_body.glb:
 * origin = neck base, both facing -Z) when loaded, tinted per player through the material of the
 * node named `tint`. Until then (or if missing) a procedural head with a visor + color band and a
 * procedural torso stand in. The torso hangs under the head and its yaw follows the head lazily.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Handedness, PlayerPose, PlayerStatus } from '../../core/types';
import { bakeObject, type ModelLibrary } from './assets';
import type { Hand, HandFactory } from './hands';
import { damp, ensureIndexed, paint, positionNormalOnly, setQ, setV } from './util';
const HEAD_CENTER = new THREE.Vector3(0, 0.028, 0.07);

function headParts(bandColor: number, withColor: boolean): THREE.BufferGeometry {
  const skull = new THREE.SphereGeometry(1, 20, 14);
  skull.scale(0.094, 0.118, 0.108).translate(HEAD_CENTER.x, HEAD_CENTER.y, HEAD_CENTER.z);
  const bandY = 0.066;
  const f = Math.sqrt(1 - Math.pow((bandY - HEAD_CENTER.y) / 0.118, 2));
  const band = new THREE.CylinderGeometry(1, 1, 0.03, 24, 1, true);
  band.scale(0.094 * f + 0.004, 1, 0.108 * f + 0.004).translate(HEAD_CENTER.x, bandY, HEAD_CENTER.z);
  const visor = new RoundedBoxGeometry(0.176, 0.072, 0.07, 2, 0.022);
  visor.translate(0, -0.004, -0.024);
  const parts = [skull, band, visor];
  if (withColor) {
    paint(skull, 0xa89a8e);
    paint(band, bandColor);
    paint(visor, 0x1c1d20);
  }
  for (const p of parts) {
    p.deleteAttribute('uv');
    ensureIndexed(p);
    if (!withColor) positionNormalOnly(p);
  }
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return g;
}

let ghostHead: THREE.BufferGeometry | null = null;
/** Head geometry (eye-center origin, -Z forward) without colors, for afterimages. Shared. */
export function headGhostGeometry(): THREE.BufferGeometry {
  if (!ghostHead) {
    ghostHead = headParts(0, false);
    ghostHead.userData.shared = true;
  }
  return ghostHead;
}

function torsoGeometry(color: number): THREE.BufferGeometry {
  // Muted clothing with a hint of the player's color (the head band carries the real color).
  const cloth = new THREE.Color(0x1f1e1d).lerp(new THREE.Color(color), 0.22).getHex();
  const darkCloth = new THREE.Color(cloth).multiplyScalar(0.75).getHex();
  const neck = paint(new THREE.CylinderGeometry(0.045, 0.052, 0.16, 10).translate(0, -0.07, 0.01), 0x8a7a6e);
  const chest = paint(new THREE.CylinderGeometry(0.17, 0.13, 0.44, 14, 1), cloth);
  chest.scale(1, 1, 0.62).translate(0, -0.38, 0.02);
  const shoulders = paint(new THREE.CapsuleGeometry(0.5, 1, 3, 10).rotateZ(Math.PI / 2), cloth);
  shoulders.scale(0.2, 0.1, 0.18).translate(0, -0.18, 0.02);
  const belly = paint(new THREE.CapsuleGeometry(0.5, 1, 3, 10).rotateZ(Math.PI / 2), darkCloth);
  belly.scale(0.14, 0.09, 0.17).translate(0, -0.6, 0.02);
  const collar = paint(new THREE.TorusGeometry(0.06, 0.016, 6, 14).rotateX(Math.PI / 2), darkCloth);
  collar.translate(0, -0.14, 0.01);
  const parts = [neck, chest, shoulders, belly, collar];
  for (const p of parts) p.deleteAttribute('uv');
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return g;
}

// ---------------------------------------------------------------------------------------------
// Avatar parts: procedural mesh or GLB instance behind one small interface
// ---------------------------------------------------------------------------------------------

/** Neck base relative to the eye center, in the head's yaw frame (avatar GLB convention). */
const HEAD_TO_NECK = new THREE.Vector3(0, -0.215, 0.063);

interface AvatarPart {
  readonly object: THREE.Object3D;
  /** True for a Blender model (placed by its own origin convention). */
  readonly model: boolean;
  setColor(color: number): void;
  /** Swap every material for `ghost` (caught player), or back (null). */
  setGhost(ghost: THREE.Material | null): void;
  dispose(): void;
}

class ProceduralPart implements AvatarPart {
  readonly object: THREE.Mesh;
  readonly model = false;
  private readonly mat = new THREE.MeshLambertMaterial({ vertexColors: true });

  constructor(private readonly build: (color: number) => THREE.BufferGeometry, color: number) {
    this.object = new THREE.Mesh(build(color), this.mat);
  }

  setColor(color: number): void {
    this.object.geometry.dispose();
    this.object.geometry = this.build(color);
  }

  setGhost(ghost: THREE.Material | null): void {
    this.object.material = ghost ?? this.mat;
    this.object.renderOrder = ghost ? 5 : 0;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.mat.dispose();
  }
}

class ModelPart implements AvatarPart {
  readonly model = true;
  private readonly meshes: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = [];
  private readonly tints: THREE.Material[] = [];

  constructor(readonly object: THREE.Object3D, color: number) {
    // Per-player copy of the `tint` material(s); everything else stays shared with the library.
    object.getObjectByName('tint')?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const clone = (mat: THREE.Material): THREE.Material => {
        const c = mat.clone();
        c.userData = {};
        this.tints.push(c);
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(clone) : clone(m.material);
    });
    object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) this.meshes.push({ mesh: m, material: m.material });
    });
    this.setColor(color);
  }

  setColor(color: number): void {
    for (const t of this.tints) (t as THREE.MeshStandardMaterial).color?.set(color);
  }

  setGhost(ghost: THREE.Material | null): void {
    for (const { mesh, material } of this.meshes) {
      mesh.material = ghost ?? material;
      mesh.renderOrder = ghost ? 5 : 0;
    }
  }

  dispose(): void {
    for (const t of this.tints) t.dispose();
    this.object.removeFromParent();
  }
}

/**
 * Makes avatar heads/bodies: GLB ones after `use(lib)` finds them, procedural ones otherwise.
 * Also bakes a head into world-space geometry (no live avatar needed).
 */
export class AvatarKit {
  private lib: ModelLibrary | null = null;
  private scratchHead: THREE.Object3D | null = null;

  /** Start using whichever avatar GLBs loaded. Returns true if any did. */
  use(lib: ModelLibrary): boolean {
    if (!lib.has('avatar_head') && !lib.has('avatar_body')) return false;
    this.lib = lib;
    this.scratchHead = null;
    return true;
  }

  head(color: number): AvatarPart {
    const inst = this.lib?.instance('avatar_head');
    return inst ? new ModelPart(inst, color) : new ProceduralPart((c) => headParts(c, true), color);
  }

  body(color: number): AvatarPart {
    const inst = this.lib?.instance('avatar_body');
    return inst ? new ModelPart(inst, color) : new ProceduralPart(torsoGeometry, color);
  }

  /** World-space afterimage geometry (position + normal) of a head at this pose. */
  bakeHead(position: THREE.Vector3, quaternion: THREE.Quaternion, out: THREE.BufferGeometry[]): void {
    if (!this.scratchHead && this.lib) this.scratchHead = this.lib.instance('avatar_head');
    const h = this.scratchHead;
    if (!h) {
      out.push(positionNormalOnly(headGhostGeometry().clone()).applyMatrix4(_bm.compose(position, quaternion, _infl)));
      return;
    }
    h.position.copy(position);
    h.quaternion.copy(quaternion);
    bakeObject(h, out, 0.004);
  }
}

const _bm = new THREE.Matrix4();
const _infl = new THREE.Vector3(1.03, 1.03, 1.03);

// ---------------------------------------------------------------------------------------------
// RemoteAvatar
// ---------------------------------------------------------------------------------------------

interface SmoothHand {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  curls: number[];
  tracked: boolean;
}

const _tp = new THREE.Vector3();
const _tq = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class RemoteAvatar {
  readonly group = new THREE.Group();
  readonly left: Hand;
  readonly right: Hand;
  readonly headPos = new THREE.Vector3();
  readonly headQuat = new THREE.Quaternion();
  readonly hands: Record<Handedness, SmoothHand>;
  /** Latest pose received (from snapshots or setRemotePose). */
  target: PlayerPose | null = null;
  status: PlayerStatus = 'alive';
  private lastDirect = -1e9;
  private initialized = false;
  private torsoYaw = 0;
  private readonly head: AvatarPart;
  private readonly torso: AvatarPart;
  private readonly handMat: THREE.MeshLambertMaterial;
  private color = -1;

  constructor(
    readonly id: string, color: number, private readonly ghostMat: THREE.Material, hands: HandFactory,
    kit: AvatarKit = new AvatarKit(),
  ) {
    this.group.name = `avatar-${id}`;
    this.head = kit.head(color);
    this.torso = kit.body(color);
    // Gloves tinted toward the player's color so you can tell who is signing in the beam.
    const glove = new THREE.Color(0x7d6e63).lerp(new THREE.Color(color), 0.3);
    this.handMat = new THREE.MeshLambertMaterial({ color: glove });
    this.left = hands.create('left', this.handMat);
    this.right = hands.create('right', this.handMat);
    this.group.add(this.head.object, this.torso.object, this.left.mesh, this.right.mesh);
    const mk = (): SmoothHand => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), curls: [0, 0, 0, 0, 0], tracked: false });
    this.hands = { left: mk(), right: mk() };
    this.color = color;
  }

  setColor(color: number): void {
    if (color === this.color) return;
    this.color = color;
    this.head.setColor(color);
    this.torso.setColor(color);
    this.handMat.color.set(0x7d6e63).lerp(new THREE.Color(color), 0.3);
  }

  /**
   * New pose. `direct` = arrived via setRemotePose (fresher than snapshots); while direct poses
   * keep coming, snapshot poses are ignored so the two sources don't fight.
   */
  setTarget(pose: PlayerPose, direct: boolean, now: number): void {
    if (direct) this.lastDirect = now;
    else if (now - this.lastDirect < 0.5) return;
    this.target = pose;
  }

  setStatus(status: PlayerStatus): void {
    if (status === this.status) return;
    this.status = status;
    const ghost = status === 'caught';
    this.head.setGhost(ghost ? this.ghostMat : null);
    this.torso.setGhost(ghost ? this.ghostMat : null);
    this.left.setMaterial(ghost ? this.ghostMat : this.handMat);
    this.right.setMaterial(ghost ? this.ghostMat : this.handMat);
    this.group.visible = status !== 'escaped';
  }

  update(dt: number): void {
    const t = this.target;
    if (!t) {
      this.group.visible = false;
      return;
    }
    this.group.visible = this.status !== 'escaped';
    setV(_tp, t.head.position);
    setQ(_tq, t.head.rotation);
    const snap = !this.initialized || this.headPos.distanceToSquared(_tp) > 4;
    const kp = snap ? 1 : damp(16, dt);
    const kr = snap ? 1 : damp(14, dt);
    this.headPos.lerp(_tp, kp);
    this.headQuat.slerp(_tq, kr);
    const head = this.head.object;
    head.position.copy(this.headPos);
    head.quaternion.copy(this.headQuat);

    // Torso: hangs under the head, yaw follows the head lazily.
    _fwd.set(0, 0, -1).applyQuaternion(this.headQuat);
    const yaw = Math.atan2(-_fwd.x, -_fwd.z);
    let dy = yaw - this.torsoYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.torsoYaw += dy * (snap ? 1 : damp(5, dt));
    const torso = this.torso.object;
    if (this.torso.model) {
      torso.position.copy(HEAD_TO_NECK).applyAxisAngle(_up, this.torsoYaw).add(this.headPos);
    } else {
      torso.position.set(this.headPos.x, this.headPos.y - 0.08, this.headPos.z);
      torso.position.x += Math.sin(this.torsoYaw) * 0.05;
      torso.position.z += Math.cos(this.torsoYaw) * 0.05;
    }
    torso.rotation.set(0, this.torsoYaw, 0);

    for (const side of ['left', 'right'] as const) {
      const src = t[side];
      const h = this.hands[side];
      const model = side === 'left' ? this.left : this.right;
      if (!src.tracked) {
        h.tracked = false;
        model.visible = false;
        continue;
      }
      setV(_tp, src.position);
      setQ(_tq, src.rotation);
      const hs = snap || !h.tracked || h.pos.distanceToSquared(_tp) > 1;
      h.pos.lerp(_tp, hs ? 1 : damp(18, dt));
      h.quat.slerp(_tq, hs ? 1 : damp(18, dt));
      const kc = hs ? 1 : damp(20, dt);
      for (let i = 0; i < 5; i++) h.curls[i] += (src.curls[i] - h.curls[i]) * kc;
      h.tracked = true;
      model.visible = true;
      model.setTransform(h.pos, h.quat, h.curls);
    }
    this.initialized = true;
  }

  dispose(): void {
    this.head.dispose();
    this.torso.dispose();
    this.handMat.dispose();
    this.left.dispose();
    this.right.dispose();
  }
}
