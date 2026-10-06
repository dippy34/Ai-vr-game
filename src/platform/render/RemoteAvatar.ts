/**
 * Remote player avatar: rounded head with a VR-visor and a color band, a torso hanging below the
 * head (yaw follows the head), and two HandModels. Exponentially smoothed toward the latest pose.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Handedness, PlayerPose, PlayerStatus } from '../../core/types';
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

interface SmoothHand {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  curls: number[];
  tracked: boolean;
}

const _tp = new THREE.Vector3();
const _tq = new THREE.Quaternion();
const _fwd = new THREE.Vector3();

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
  private readonly head: THREE.Mesh;
  private readonly torso: THREE.Mesh;
  private readonly headMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly torsoMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly handMat: THREE.MeshLambertMaterial;
  private color = -1;

  constructor(readonly id: string, color: number, private readonly ghostMat: THREE.Material, hands: HandFactory) {
    this.group.name = `avatar-${id}`;
    this.head = new THREE.Mesh(headParts(color, true), this.headMat);
    this.torso = new THREE.Mesh(torsoGeometry(color), this.torsoMat);
    // Gloves tinted toward the player's color so you can tell who is signing in the flash.
    const glove = new THREE.Color(0x7d6e63).lerp(new THREE.Color(color), 0.3);
    this.handMat = new THREE.MeshLambertMaterial({ color: glove });
    this.left = hands.create('left', this.handMat);
    this.right = hands.create('right', this.handMat);
    this.group.add(this.head, this.torso, this.left.mesh, this.right.mesh);
    const mk = (): SmoothHand => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), curls: [0, 0, 0, 0, 0], tracked: false });
    this.hands = { left: mk(), right: mk() };
    this.color = color;
  }

  setColor(color: number): void {
    if (color === this.color) return;
    this.color = color;
    this.head.geometry.dispose();
    this.torso.geometry.dispose();
    this.head.geometry = headParts(color, true);
    this.torso.geometry = torsoGeometry(color);
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
    this.head.material = ghost ? this.ghostMat : this.headMat;
    this.torso.material = ghost ? this.ghostMat : this.torsoMat;
    this.left.setMaterial(ghost ? this.ghostMat : this.handMat);
    this.right.setMaterial(ghost ? this.ghostMat : this.handMat);
    this.head.renderOrder = this.torso.renderOrder = ghost ? 5 : 0;
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
    this.head.position.copy(this.headPos);
    this.head.quaternion.copy(this.headQuat);

    // Torso: hangs under the head, yaw follows the head lazily.
    _fwd.set(0, 0, -1).applyQuaternion(this.headQuat);
    const yaw = Math.atan2(-_fwd.x, -_fwd.z);
    let dy = yaw - this.torsoYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.torsoYaw += dy * (snap ? 1 : damp(5, dt));
    this.torso.position.set(this.headPos.x, this.headPos.y - 0.08, this.headPos.z);
    this.torso.position.x += Math.sin(this.torsoYaw) * 0.05;
    this.torso.position.z += Math.cos(this.torsoYaw) * 0.05;
    this.torso.rotation.set(0, this.torsoYaw, 0);

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
    this.head.geometry.dispose();
    this.torso.geometry.dispose();
    this.headMat.dispose();
    this.torsoMat.dispose();
    this.handMat.dispose();
    this.left.dispose();
    this.right.dispose();
  }
}
