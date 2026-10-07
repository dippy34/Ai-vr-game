/**
 * The monster skeleton, read BY NAME and MEASURED from the bind pose, so an upgraded model with
 * the same bone names just works (different proportions included).
 *
 * The rig keeps its own pose buffers: a local rotation per bone plus the hips position, and an
 * object-space forward-kinematics pass (quaternion + position per bone, in the model's own frame:
 * -Z forward, +Y up, feet at y = 0) so the body solver never needs three's matrix updates.
 */

import * as THREE from 'three';
import { aimFrame, type AimFrame } from './ik';

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;
const SIDES = ['L', 'R'] as const;

const CORE = ['root', 'hips', 'spine_1', 'spine_2', 'spine_3', 'neck', 'neck_2', 'head', 'jaw'] as const;
const OPTIONAL = ['jaw_L', 'jaw_R', 'ear_L', 'ear_R'] as const;
const ARM = ['shoulder', 'upper_arm', 'forearm', 'hand'] as const;
const LEG = ['thigh', 'shin', 'foot', 'toe'] as const;

/** Bone names the procedural body needs (fingers, ears and the split jaw are optional). */
export const REQUIRED_BONES: readonly string[] = [
  ...CORE,
  ...SIDES.flatMap((s) => [...ARM, ...LEG].map((b) => `${b}_${s}`)),
];

export interface ArmBones {
  shoulder: number;
  upper: number;
  fore: number;
  hand: number;
  /** [finger][phalanx] bone indices (-1 if missing). */
  fingers: number[][];
  lenA: number;
  lenB: number;
  /** Wrist to middle fingertip (m). */
  handLen: number;
  upperAim: AimFrame;
  foreAim: AimFrame;
  /** Hand frame: aim = toward the middle finger, ref = palm normal (the side fingers curl to). */
  handAim: AimFrame;
  /** Curl axis per finger bone, in that bone's own frame (+ angle curls toward the palm). */
  curlAxis: THREE.Vector3[][];
  /** Spread axis per finger (first phalanx frame; + angle fans away from the middle finger). */
  spreadAxis: THREE.Vector3[];
}

export interface LegBones {
  thigh: number;
  shin: number;
  foot: number;
  toe: number;
  lenA: number;
  lenB: number;
  thighAim: AimFrame;
  shinAim: AimFrame;
  /** Rest ankle position relative to the ball (toe joint), model space. */
  readonly ankleFromBall: THREE.Vector3;
  /** Ball (toe joint) height above the floor at rest. */
  ballHeight: number;
  /** Rest ball position (model space): the home contact. */
  readonly restBall: THREE.Vector3;
  /** Toe flex axis in the toe's own frame (+ = toes up). */
  readonly toeAxis: THREE.Vector3;
}

export class MonsterRig {
  readonly bones: THREE.Bone[] = [];
  readonly names: string[] = [];
  readonly parent: number[] = [];
  /** Bind pose (local). */
  readonly restQ: THREE.Quaternion[] = [];
  readonly restP: THREE.Vector3[] = [];
  /** Working pose (local). */
  readonly q: THREE.Quaternion[] = [];
  readonly hipsPos = new THREE.Vector3();
  /** Object-space FK of the working pose (model frame). */
  readonly mq: THREE.Quaternion[] = [];
  readonly mp: THREE.Vector3[] = [];
  /** Object-space bind pose. */
  readonly restMQ: THREE.Quaternion[] = [];
  readonly restMP: THREE.Vector3[] = [];
  readonly index = new Map<string, number>();
  readonly arms: [ArmBones, ArmBones];
  readonly legs: [LegBones, LegBones];
  /** Root's parent transform (model space): usually identity. */
  private readonly baseQ = new THREE.Quaternion();
  private readonly baseP = new THREE.Vector3();
  readonly hips: number;
  readonly spine: number[];
  readonly neck: number[];
  readonly head: number;
  readonly jaw: number;
  readonly jawL: number;
  readonly jawR: number;
  readonly earL: number;
  readonly earR: number;
  /** Measurements (m, model space). */
  readonly hipHeight: number;
  readonly shoulderHeight: number;
  readonly headHeight: number;
  /** Hips to the base of the neck. */
  readonly trunkLen: number;
  readonly hipWidth: number;
  readonly shoulderWidth: number;
  /** Top of the head above the head bone (the skull/ears). */
  readonly headTop: number;
  /** The mouth, in the head bone frame. */
  readonly faceLocal = new THREE.Vector3();
  /** Face forward (out of the mouth) in the head bone frame. */
  readonly faceDir = new THREE.Vector3();
  /** Model-space axes in each bone's own rest frame: left (pitch forward with +), up, forward. */
  readonly leftAxis: THREE.Vector3[] = [];
  readonly upAxis: THREE.Vector3[] = [];
  readonly fwdAxis: THREE.Vector3[] = [];

  /** Null when a required bone is missing. */
  static build(instance: THREE.Object3D): MonsterRig | null {
    for (const n of REQUIRED_BONES) {
      const o = instance.getObjectByName(n);
      if (!o || !(o as THREE.Bone).isBone) return null;
    }
    return new MonsterRig(instance);
  }

  private constructor(instance: THREE.Object3D) {
    // Collect every bone under the root (depth first: parents before children).
    const root = instance.getObjectByName('root') as THREE.Bone;
    const visit = (o: THREE.Object3D, parent: number) => {
      if (!(o as THREE.Bone).isBone) return;
      const i = this.bones.length;
      this.bones.push(o as THREE.Bone);
      this.names.push(o.name);
      this.parent.push(parent);
      this.index.set(o.name, i);
      this.restQ.push(o.quaternion.clone());
      this.restP.push(o.position.clone());
      this.q.push(o.quaternion.clone());
      this.mq.push(new THREE.Quaternion());
      this.mp.push(new THREE.Vector3());
      for (const c of o.children) visit(c, i);
    };
    visit(root, -1);
    // Root's parent chain up to the instance (the model frame).
    instance.updateMatrixWorld(true);
    const m = new THREE.Matrix4().copy(instance.matrixWorld).invert().multiply(root.parent!.matrixWorld);
    const s = new THREE.Vector3();
    m.decompose(this.baseP, this.baseQ, s);
    const I = (n: string) => this.index.get(n) ?? -1;
    this.hips = I('hips');
    this.hipsPos.copy(this.restP[this.hips]);
    this.fk();
    for (let i = 0; i < this.bones.length; i++) {
      this.restMQ.push(this.mq[i].clone());
      this.restMP.push(this.mp[i].clone());
      const inv = this.mq[i].clone().invert();
      this.leftAxis.push(new THREE.Vector3(-1, 0, 0).applyQuaternion(inv));
      this.upAxis.push(new THREE.Vector3(0, 1, 0).applyQuaternion(inv));
      this.fwdAxis.push(new THREE.Vector3(0, 0, -1).applyQuaternion(inv));
    }
    this.spine = ['spine_1', 'spine_2', 'spine_3'].map(I);
    this.neck = ['neck', 'neck_2'].map(I);
    this.head = I('head');
    this.jaw = I('jaw');
    this.jawL = I('jaw_L');
    this.jawR = I('jaw_R');
    this.earL = I('ear_L');
    this.earR = I('ear_R');
    void OPTIONAL;
    const P = this.restMP;
    this.hipHeight = P[this.hips].y;
    this.headHeight = P[this.head].y;
    this.trunkLen = P[this.neck[0]].distanceTo(P[this.hips]);
    this.arms = [this.arm('L'), this.arm('R')];
    this.legs = [this.leg('L'), this.leg('R')];
    this.shoulderHeight = P[this.arms[0].upper].y;
    this.hipWidth = Math.abs(P[this.legs[0].thigh].x - P[this.legs[1].thigh].x);
    this.shoulderWidth = Math.abs(P[this.arms[0].upper].x - P[this.arms[1].upper].x);
    // Head top: the highest of the ears' tips (if any) / a skull estimate above the head bone.
    let top = 0.16;
    for (const e of [this.earL, this.earR]) {
      if (e < 0) continue;
      const ep = P[e];
      top = Math.max(top, ep.y - P[this.head].y + 0.12);
    }
    this.headTop = top;
    // Face: the jaw joint pushed forward a little, in the head frame.
    const headInv = this.restMQ[this.head].clone().invert();
    const jawP = this.jaw >= 0 ? P[this.jaw] : P[this.head];
    this.faceLocal.copy(jawP).add(new THREE.Vector3(0, -0.04, -0.06)).sub(P[this.head]).applyQuaternion(headInv);
    this.faceDir.set(0, 0, -1).applyQuaternion(headInv);
  }

  private arm(s: 'L' | 'R'): ArmBones {
    const I = (n: string) => this.index.get(`${n}_${s}`) ?? -1;
    const shoulder = I('shoulder');
    const upper = I('upper_arm');
    const fore = I('forearm');
    const hand = I('hand');
    const P = this.restMP;
    const lenA = P[upper].distanceTo(P[fore]);
    const lenB = P[fore].distanceTo(P[hand]);
    // The elbow's rest bend (it bends back/out): the reference for the arm's twist.
    const bend = this.bendDir(upper, fore, hand, new THREE.Vector3(0, 0, 1));
    const fingers = FINGERS.map((f) => [1, 2, 3].map((k) => I(`${f}_${k}`)));
    const mid = fingers[2][0] >= 0 ? fingers[2] : fingers[1];
    let handLen = 0.25;
    const curlAxis: THREE.Vector3[][] = [];
    const spreadAxis: THREE.Vector3[] = [];
    if (mid[0] >= 0) {
      handLen = P[hand].distanceTo(P[mid[0]]);
      for (let k = 1; k < 3; k++) if (mid[k] >= 0) handLen += P[mid[k - 1]].distanceTo(P[mid[k]]);
      if (mid[2] >= 0 && mid[1] >= 0) handLen += P[mid[1]].distanceTo(P[mid[2]]) * 0.8;
    }
    // Palm normal = the side fingers curl toward: local +Z of the finger bones (+X curls them).
    const palmModel = new THREE.Vector3(0, 0, 1).applyQuaternion(this.restMQ[mid[0] >= 0 ? mid[0] : hand]);
    const toMid = (mid[0] >= 0 ? P[mid[0]] : P[hand]).clone().sub(P[hand]);
    if (toMid.lengthSq() < 1e-8) toMid.set(0, -1, 0);
    const handInv = this.restMQ[hand].clone().invert();
    const handAim = aimFrame(toMid.clone().applyQuaternion(handInv), palmModel.clone().applyQuaternion(handInv));
    for (let f = 0; f < fingers.length; f++) {
      curlAxis.push(fingers[f].map(() => new THREE.Vector3(1, 0, 0)));
      // Spread: rotation about the palm normal; sign so + fans away from the middle finger.
      const b0 = fingers[f][0];
      const ax = new THREE.Vector3(0, 0, 1);
      if (b0 >= 0 && mid[0] >= 0 && f !== 2) {
        const away = P[b0].clone().sub(P[mid[0]]);
        const tipDir = new THREE.Vector3(-1, 0, 0).applyQuaternion(this.restMQ[b0]); // +Z rotation moves Y toward -X
        if (tipDir.dot(away) < 0) ax.set(0, 0, -1);
      }
      spreadAxis.push(ax);
    }
    return {
      shoulder, upper, fore, hand, fingers, lenA, lenB, handLen,
      upperAim: this.aim(upper, fore, bend),
      foreAim: this.aim(fore, hand, bend),
      handAim, curlAxis, spreadAxis,
    };
  }

  private leg(s: 'L' | 'R'): LegBones {
    const I = (n: string) => this.index.get(`${n}_${s}`) ?? -1;
    const thigh = I('thigh');
    const shin = I('shin');
    const foot = I('foot');
    const toe = I('toe');
    const P = this.restMP;
    const bend = this.bendDir(thigh, shin, foot, new THREE.Vector3(0, 0, -1));
    const toeInv = this.restMQ[toe].clone().invert();
    return {
      thigh, shin, foot, toe,
      lenA: P[thigh].distanceTo(P[shin]),
      lenB: P[shin].distanceTo(P[foot]),
      thighAim: this.aim(thigh, shin, bend),
      shinAim: this.aim(shin, foot, bend),
      ankleFromBall: P[foot].clone().sub(P[toe]),
      ballHeight: Math.max(0.01, P[toe].y),
      restBall: P[toe].clone().setY(0),
      // Toes up = rotation about the model's left axis... (+X model = right; toes up is a
      // rotation about +X: forward tilts up).
      toeAxis: new THREE.Vector3(1, 0, 0).applyQuaternion(toeInv),
    };
  }

  /** Unit direction the middle joint sticks out of the root->end line (fallback if straight). */
  private bendDir(a: number, b: number, c: number, fallback: THREE.Vector3): THREE.Vector3 {
    const P = this.restMP;
    const axis = P[c].clone().sub(P[a]).normalize();
    const off = P[b].clone().sub(P[a]);
    off.addScaledVector(axis, -off.dot(axis));
    return off.lengthSq() > 1e-4 ? off.normalize() : fallback.clone();
  }

  /** Aim frame for bone i pointing at child joint j with bend reference `refModel` (model space). */
  private aim(i: number, j: number, refModel: THREE.Vector3): AimFrame {
    const inv = this.restMQ[i].clone().invert();
    const axis = this.restMP[j].clone().sub(this.restMP[i]).applyQuaternion(inv);
    return aimFrame(axis, refModel.clone().applyQuaternion(inv));
  }

  /** Reset the working pose to the bind pose. */
  resetPose(): void {
    for (let i = 0; i < this.bones.length; i++) this.q[i].copy(this.restQ[i]);
    this.hipsPos.copy(this.restP[this.hips]);
  }

  /** Object-space FK of the working pose, for bones [from, to) (parents must be done). */
  fk(from = 0, to = this.bones.length): void {
    for (let i = from; i < to; i++) {
      const p = this.parent[i];
      const lp = i === this.hips ? this.hipsPos : this.restP[i];
      if (p < 0) {
        this.mq[i].copy(this.baseQ).multiply(this.q[i]);
        this.mp[i].copy(lp).applyQuaternion(this.baseQ).add(this.baseP);
      } else {
        this.mq[i].copy(this.mq[p]).multiply(this.q[i]);
        this.mp[i].copy(lp).applyQuaternion(this.mq[p]).add(this.mp[p]);
      }
    }
  }

  /** FK of one bone from its (already solved) parent. */
  fk1(i: number): void {
    this.fk(i, i + 1);
  }

  /** Set bone i's local rotation so its object-space orientation becomes `m` (parent solved). */
  setModelQ(i: number, m: THREE.Quaternion): void {
    const p = this.parent[i];
    if (p < 0) this.q[i].copy(this.baseQ).invert().multiply(m);
    else this.q[i].copy(this.mq[p]).invert().multiply(m);
    this.mq[i].copy(m);
    const lp = i === this.hips ? this.hipsPos : this.restP[i];
    if (p < 0) this.mp[i].copy(lp).applyQuaternion(this.baseQ).add(this.baseP);
    else this.mp[i].copy(lp).applyQuaternion(this.mq[p]).add(this.mp[p]);
  }

  /** Place the hips (object space position + orientation). */
  setHips(pos: THREE.Vector3, m: THREE.Quaternion): void {
    const p = this.parent[this.hips];
    // hipsPos is local to the parent (root).
    this.hipsPos.copy(pos).sub(this.mp[p]).applyQuaternion(_qi.copy(this.mq[p]).invert());
    this.setModelQ(this.hips, m);
  }

  /** Copy the working pose onto the bones. `w` < 1 blends from what the bones hold (a clip). */
  write(w = 1): void {
    if (w >= 0.999) {
      for (let i = 0; i < this.bones.length; i++) this.bones[i].quaternion.copy(this.q[i]);
      this.bones[this.hips].position.copy(this.hipsPos);
      return;
    }
    if (w <= 0.001) return;
    for (let i = 0; i < this.bones.length; i++) this.bones[i].quaternion.slerp(this.q[i], w);
    this.bones[this.hips].position.lerp(this.hipsPos, w);
  }

  /** Read the bones' current local pose into the working pose (e.g. a clip's frame). */
  read(): void {
    for (let i = 0; i < this.bones.length; i++) this.q[i].copy(this.bones[i].quaternion);
    this.hipsPos.copy(this.bones[this.hips].position);
  }
}

const _qi = new THREE.Quaternion();
