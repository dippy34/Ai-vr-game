/**
 * The monster: very tall and thin, arms past the knees, eyeless egg head with a vertical mouth slit,
 * dark slightly glossy skin. One InstancedMesh of capsules (one draw call), animated procedurally
 * through an Object3D joint hierarchy: walk cycle scaled by speed, listening head-tilt, twitches.
 * The catch (Jumpscare.setCatch) is a procedural copy of the Blender Attack clip's timing: rear up,
 * lunge with the mouth slit tearing wide open, claws closing.
 */

import * as THREE from 'three';
import { MONSTER } from '../../config';
import type { MonsterState } from '../../core/types';
import type { CatchPoser } from './Jumpscare';
import { damp, positionNormalOnly, setV, unitCapsule } from './util';

interface Part {
  joint: THREE.Object3D;
  local: THREE.Matrix4;
  color: number;
  /** Mouth part: scaled by alert. */
  mouth?: boolean;
}

const SKIN = 1.0;
const BONE = 1.12;
const MOUTH = 0.06;

/** Face point in the 'face' joint frame: just in front of the mouth slit. */
const FACE_POINT = new THREE.Vector3(0, 0.1, -0.13);

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _c = new THREE.Color();

/** Catch arm pose on top of the normal one: flung wide (ra), reaching (rl), claws closing (rg). */
function catchArm(sh: THREE.Object3D, el: THREE.Object3D, fi: THREE.Object3D, sx: number, ra: number, rl: number, rg: number): void {
  sh.rotation.x += 2.3 * ra + 1.25 * rl * (1 - ra);
  sh.rotation.z += sx * (1.0 * ra + 0.55 * rl * (1 - rg * 0.8));
  el.rotation.x += 0.2 * ra + 0.15 * rl + 0.9 * rg;
  fi.rotation.x += -0.4 * (ra + rl) * (1 - rg) + 1.2 * rg;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class MonsterModel implements CatchPoser {
  readonly mesh: THREE.InstancedMesh;
  readonly facePitch = 0.12;
  lungeReach = 0.6;
  readonly root = new THREE.Object3D();
  private readonly parts: Part[] = [];
  private readonly j: Record<string, THREE.Object3D> = {};
  private readonly material: THREE.MeshPhongMaterial;
  private phase = 0;
  private speed = 0;
  private time = 0;
  private listenK = 0;
  private chaseK = 0;
  private feedK = 0;
  private alert = 0;
  private yaw = 0;
  private initialized = false;
  private twitchTimer = 0;
  private readonly twitch = { hx: 0, hy: 0, hz: 0, sl: 0, sr: 0, fl: 0, fr: 0, sp: 0 };
  private readonly twitchTarget = { hx: 0, hy: 0, hz: 0, sl: 0, sr: 0, fl: 0, fr: 0, sp: 0 };
  private readonly hipHeight = 1.12;
  /** Smoothed sim position (the root may be placed elsewhere by the catch). */
  private readonly pos = new THREE.Vector3();
  // Catch override (Jumpscare): Attack-clip time and placement, set every frame while active.
  private catchClip = -1;
  private catchPlace: 'face' | 'root' = 'face';
  private readonly catchTarget = new THREE.Vector3();
  private catchYaw = 0;
  private catchPitch = 0;
  private catchWeight = 1;
  /** Rear-up, lunge, claws-closed and mouth-open factors 0..1 from the catch clip time. */
  private readonly atk = { a: 0, l: 0, g: 0, jaw: 0 };

  constructor() {
    this.material = new THREE.MeshPhongMaterial({
      color: 0x1c1b1c, specular: 0x262422, shininess: 95,
    });
    this.buildSkeleton();
    this.mesh = new THREE.InstancedMesh(unitCapsule(), this.material, this.parts.length);
    this.mesh.name = 'monster';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    // Slight per-part tone variation so it doesn't read as one smooth plastic.
    this.parts.forEach((p, i) => this.mesh.setColorAt(i, _c.setScalar(p.color * (p.color === MOUTH ? 1 : 0.88 + ((i * 37) % 11) / 40))));
    this.root.scale.setScalar(MONSTER.height / 2.3);
    // Measure how far ahead of its feet the face gets at the peak of the lunge.
    this.setAttack(0.5);
    this.pose(0);
    this.root.worldToLocal(this.facePoint(_f)).multiply(this.root.scale);
    this.lungeReach = Math.max(0.3, Math.hypot(_f.x, _f.z));
    this.setAttack(-1);
    this.pose(0);
  }

  setCatch(clip: number, place: 'face' | 'root', target: THREE.Vector3, yaw: number, pitch: number, weight: number): void {
    this.catchClip = Math.max(0, clip);
    this.catchPlace = place;
    this.catchTarget.copy(target);
    this.catchYaw = yaw;
    this.catchPitch = pitch;
    this.catchWeight = weight;
  }

  clearCatch(): void {
    if (this.catchClip < 0) return;
    this.catchClip = -1;
    this.setAttack(-1);
    this.root.position.copy(this.pos);
    this.root.rotation.set(0, this.yaw, 0);
  }

  /** Attack factors at clip time t (same beats as the Blender clip); t < 0 = none. */
  private setAttack(t: number): void {
    const k = this.atk;
    if (t < 0) {
      k.a = k.l = k.g = k.jaw = 0;
      return;
    }
    k.a = smooth(0, 0.3, t) * (1 - smooth(0.3, 0.46, t));
    k.l = smooth(0.28, 0.5, t) * (1 - smooth(0.85, 1.2, t));
    k.g = smooth(0.48, 0.6, t) * (1 - smooth(0.95, 1.2, t));
    k.jaw = Math.min(1, Math.max(0, (3 + 14 * k.a + 26 * k.l - 12 * k.g) / 29));
  }

  /** World position of the face (in front of the mouth). Needs up-to-date joint matrices. */
  private facePoint(out: THREE.Vector3): THREE.Vector3 {
    return this.j.face.localToWorld(out.copy(FACE_POINT));
  }

  private joint(name: string, parent: THREE.Object3D | null, x: number, y: number, z: number): THREE.Object3D {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(x, y, z);
    (parent ?? this.root).add(o);
    this.j[name] = o;
    return o;
  }

  /** Capsule centered at `c` in the joint frame with full extents (sx, sy, sz); `axis` = long axis. */
  private part(joint: THREE.Object3D, c: [number, number, number], s: [number, number, number], axis: 'x' | 'y' | 'z', color = SKIN, rot: [number, number, number] = [0, 0, 0]): Part {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
    const qa = new THREE.Quaternion();
    let scale: THREE.Vector3;
    if (axis === 'y') {
      qa.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      scale = new THREE.Vector3(s[0], s[2], s[1] / 2);
    } else if (axis === 'x') {
      qa.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
      scale = new THREE.Vector3(s[2], s[1], s[0] / 2);
    } else {
      scale = new THREE.Vector3(s[0], s[1], s[2] / 2);
    }
    q.multiply(qa);
    const p: Part = { joint, local: new THREE.Matrix4().compose(new THREE.Vector3(...c), q, scale), color };
    this.parts.push(p);
    return p;
  }

  /** A limb segment hanging down (-Y) from its joint, length L. */
  private limb(joint: THREE.Object3D, L: number, w: number, d = w, color = SKIN): void {
    this.part(joint, [0, -L / 2, 0], [w, L * 1.08, d], 'y', color);
  }

  private buildSkeleton(): void {
    const hips = this.joint('hips', null, 0, this.hipHeight, 0);
    this.part(hips, [0, 0.02, 0.01], [0.28, 0.11, 0.15], 'x');
    const spine = this.joint('spine', hips, 0, 0.04, 0);
    this.part(spine, [0, 0.16, 0.01], [0.12, 0.34, 0.09], 'y');
    const chest = this.joint('chest', spine, 0, 0.3, 0);
    this.part(chest, [0, 0.17, 0.0], [0.26, 0.38, 0.16], 'y');
    // Clavicles angled up into shrugged, bony shoulders.
    for (const sx of [-1, 1]) this.part(chest, [sx * 0.11, 0.345, 0.012], [0.24, 0.05, 0.07], 'x', BONE, [0, 0, sx * 0.24]);
    // Spine knobs and a few ribs that catch the flash.
    for (let i = 0; i < 5; i++) this.part(i < 2 ? spine : chest, [0, (i < 2 ? 0.1 + i * 0.12 : 0.04 + (i - 2) * 0.1), i < 2 ? 0.055 : 0.085], [0.035, 0.05, 0.035], 'y', BONE);
    for (const sx of [-1, 1]) for (let r = 0; r < 3; r++) {
      this.part(chest, [sx * 0.07, 0.08 + r * 0.075, -0.045], [0.12, 0.02, 0.028], 'x', BONE, [0, sx * 0.35, sx * -0.3]);
    }
    const neck = this.joint('neck', chest, 0, 0.35, 0.01);
    this.part(neck, [0, 0.11, 0], [0.06, 0.24, 0.06], 'y');
    const head = this.joint('head', neck, 0, 0.22, 0);
    // Long eyeless skull drooping forward; the face (and its vertical mouth slit) tilts down.
    const face = this.joint('face', head, 0, 0.02, 0);
    face.rotation.x = -0.45;
    this.part(face, [0, 0.17, 0.015], [0.178, 0.38, 0.215], 'y');
    this.part(face, [0, 0.04, -0.035], [0.115, 0.19, 0.15], 'y');
    this.part(face, [0, 0.27, 0.05], [0.13, 0.15, 0.15], 'y');
    const mouth = this.part(face, [0, 0.075, -0.106], [0.016, 0.17, 0.03], 'y', MOUTH);
    mouth.mouth = true;

    for (const side of [-1, 1]) {
      const n = side < 0 ? 'L' : 'R';
      const sh = this.joint(`shoulder${n}`, chest, side * 0.22, 0.37, 0.012);
      this.part(sh, [0, -0.01, 0], [0.075, 0.07, 0.075], 'y', BONE);
      this.limb(sh, 0.58, 0.06);
      const el = this.joint(`elbow${n}`, sh, 0, -0.58, 0);
      this.part(el, [0, 0, 0.005], [0.052, 0.06, 0.05], 'y', BONE);
      this.limb(el, 0.55, 0.046);
      const wr = this.joint(`wrist${n}`, el, 0, -0.55, 0);
      this.part(wr, [0, -0.09, 0], [0.065, 0.19, 0.024], 'y');
      const fi = this.joint(`fingers${n}`, wr, 0, -0.17, 0);
      for (let k = 0; k < 4; k++) {
        const x = (k - 1.5) * 0.017;
        this.part(fi, [x, -0.085, 0], [0.014, 0.18 - Math.abs(k - 1.5) * 0.025, 0.014], 'y', SKIN, [0, 0, (k - 1.5) * 0.05 * side]);
      }
      const hp = this.joint(`hip${n}`, hips, side * 0.1, -0.02, 0);
      this.part(hp, [0, -0.2, 0.005], [0.1, 0.36, 0.105], 'y');
      this.limb(hp, 0.56, 0.072);
      const kn = this.joint(`knee${n}`, hp, 0, -0.56, 0);
      this.part(kn, [0, 0, -0.012], [0.064, 0.07, 0.06], 'y', BONE);
      this.limb(kn, 0.52, 0.056);
      const an = this.joint(`ankle${n}`, kn, 0, -0.52, 0);
      this.part(an, [0, -0.025, -0.08], [0.06, 0.045, 0.27], 'z');
    }
  }

  /** Per-frame: follow the sim state and animate. */
  update(m: MonsterState, dt: number): void {
    this.time += dt;
    setV(_v, m.position);
    if (!this.initialized || this.pos.distanceToSquared(_v) > 9) {
      this.pos.copy(_v);
      this.yaw = m.yaw;
      this.initialized = true;
    } else {
      this.pos.lerp(_v, damp(12, dt));
      let d = m.yaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * damp(10, dt);
    }
    const catching = this.catchClip >= 0;
    if (catching) {
      this.setAttack(this.catchClip);
      const w = this.catchWeight;
      if (this.catchPlace === 'face') {
        this.root.rotation.set(this.catchPitch, this.catchYaw, 0, 'YXZ');
      } else {
        this.root.position.lerpVectors(this.pos, this.catchTarget, w);
        const d = Math.atan2(Math.sin(this.catchYaw - this.yaw), Math.cos(this.catchYaw - this.yaw));
        this.root.rotation.set(0, this.yaw + d * w, 0);
      }
    } else {
      this.root.position.copy(this.pos);
      this.root.rotation.set(0, this.yaw, 0);
    }
    this.speed += (m.speed - this.speed) * damp(6, dt);
    this.alert += (m.alert - this.alert) * damp(4, dt);
    const listening = m.mode === 'feeding' || (m.mode === 'investigate' && m.speed < 0.35);
    this.listenK += ((listening ? 1 : 0) - this.listenK) * damp(2.5, dt);
    this.chaseK += ((m.mode === 'chase' ? 1 : 0) - this.chaseK) * damp(3, dt);
    this.feedK += ((m.mode === 'feeding' ? 1 : 0) - this.feedK) * damp(2, dt);
    // Stride ~1.7 m per full cycle (two steps), a bit shorter when running for a frantic gait.
    const stride = 1.7 - this.chaseK * 0.3;
    this.phase += dt * (this.speed / stride) * Math.PI * 2;
    this.updateTwitch(dt);
    this.pose(dt);
    if (catching && this.catchPlace === 'face') {
      // Move the whole body so its face lands on the target, then re-write the instances.
      this.root.worldToLocal(this.facePoint(_f)).multiply(this.root.scale).applyQuaternion(this.root.quaternion);
      this.root.position.copy(this.catchTarget).sub(_f);
      this.writeInstances();
    }
  }

  private updateTwitch(dt: number): void {
    const a = this.alert;
    this.twitchTimer -= dt;
    const tt = this.twitchTarget;
    if (a > 0.45 && this.twitchTimer <= 0) {
      const amp = (a - 0.45) / 0.55;
      const r = (): number => (Math.random() * 2 - 1) * amp;
      tt.hx = r() * 0.35; tt.hy = r() * 0.6; tt.hz = r() * 0.55;
      tt.sl = r() * 0.25; tt.sr = r() * 0.25;
      tt.fl = Math.random() * amp; tt.fr = Math.random() * amp;
      tt.sp = r() * 0.12;
      this.twitchTimer = 0.08 + Math.random() * (0.7 - 0.5 * amp);
    } else if (this.twitchTimer <= -0.15 || a <= 0.45) {
      tt.hx = tt.hy = tt.hz = tt.sl = tt.sr = tt.fl = tt.fr = tt.sp = 0;
    }
    // Snap toward the target fast (a jerk), then the target clears and it relaxes.
    const k = damp(28, dt);
    const tw = this.twitch;
    for (const key of Object.keys(tw) as (keyof typeof tw)[]) tw[key] += (tt[key] - tw[key]) * k;
  }

  private pose(dt: number): void {
    void dt;
    const J = this.j;
    const t = this.time;
    const s = this.speed;
    const amp = Math.min(1, s / 1.1);
    const ph = this.phase;
    const sinP = Math.sin(ph), cosP = Math.cos(ph);
    const ck = this.chaseK, lk = this.listenK, tw = this.twitch;
    const fk = this.feedK;
    const breathe = Math.sin(t * 1.3);
    const { a: ra, l: rl, g: rg } = this.atk;
    // During the catch the feeding crouch waits until the lunge is over.
    const fkc = fk * (1 - Math.max(ra, rl));

    // Legs.
    const swing = (0.42 + 0.12 * ck) * amp;
    J.hipL.rotation.x = 0.1 + sinP * swing - fkc * 0.5;
    J.hipR.rotation.x = 0.1 - sinP * swing - fkc * 0.5;
    J.kneeL.rotation.x = -(0.2 + amp * (0.85 + 0.3 * ck) * Math.max(0, cosP)) - fkc * 0.9;
    J.kneeR.rotation.x = -(0.2 + amp * (0.85 + 0.3 * ck) * Math.max(0, -cosP)) - fkc * 0.9;
    J.ankleL.rotation.x = -(J.hipL.rotation.x + J.kneeL.rotation.x) * 0.6;
    J.ankleR.rotation.x = -(J.hipR.rotation.x + J.kneeR.rotation.x) * 0.6;
    J.hipL.rotation.z = 0.03;
    J.hipR.rotation.z = -0.03;

    // Body: bob, sway, hunch (more when chasing / feeding).
    const crouch = fkc * 0.36;
    J.hips.position.y = this.hipHeight - amp * 0.045 * sinP * sinP - crouch + 0.006 * breathe;
    J.hips.rotation.y = sinP * 0.12 * amp;
    J.hips.rotation.z = cosP * 0.05 * amp;
    J.spine.rotation.x = -0.22 - 0.32 * ck - 0.55 * fkc + tw.sp;
    J.spine.rotation.y = -sinP * 0.1 * amp;
    J.chest.rotation.x = -0.16 - 0.12 * ck + 0.015 * breathe;
    J.neck.rotation.x = -0.62 - 0.2 * ck + 0.2 * fkc;

    // Head: hangs forward; listening = slow tilt and turn; twitches when agitated.
    J.head.rotation.x = 0.55 + 0.3 * ck - 0.3 * fkc + tw.hx + lk * 0.12 * Math.sin(t * 0.9);
    J.head.rotation.y = lk * 0.65 * Math.sin(t * 0.37) + tw.hy;
    J.head.rotation.z = lk * (0.5 * Math.sin(t * 0.61) + 0.15) + tw.hz;

    // Arms: long dangling swing, opposite the legs; reach forward when chasing.
    const armSwing = 0.32 * amp * (1 - 0.6 * ck);
    J.shoulderL.rotation.x = -sinP * armSwing + 0.12 + ck * 1.0 + tw.sl + fkc * 0.9;
    J.shoulderR.rotation.x = sinP * armSwing + 0.12 + ck * 0.85 + tw.sr + fkc * 0.7;
    J.shoulderL.rotation.z = -0.07 - 0.15 * ck - 0.02 * breathe;
    J.shoulderR.rotation.z = 0.07 + 0.15 * ck + 0.02 * breathe;
    J.elbowL.rotation.x = 0.16 + 0.12 * amp + 0.25 * ck + 0.6 * fkc;
    J.elbowR.rotation.x = 0.16 + 0.12 * amp + 0.25 * ck + 0.6 * fkc;
    J.fingersL.rotation.x = 0.2 + 0.9 * tw.fl - 0.25 * ck;
    J.fingersR.rotation.x = 0.2 + 0.9 * tw.fr - 0.25 * ck;

    if (ra > 0 || rl > 0 || rg > 0) {
      // Catch: rear up with the arms flung wide, then the whole body lunges, head thrust straight
      // out (face level), arms reaching past the prey; the claws then close in.
      J.spine.rotation.x += 0.25 * ra - 0.35 * rl;
      J.chest.rotation.x += 0.1 * ra - 0.1 * rl;
      J.neck.rotation.x += 0.35 * ra + 0.25 * rl;
      J.head.rotation.x += -0.55 * ra - 0.2 * rl;
      J.head.rotation.y *= 1 - Math.max(ra, rl);
      J.head.rotation.z *= 1 - Math.max(ra, rl);
      J.hips.position.y += 0.06 * ra;
      catchArm(J.shoulderL, J.elbowL, J.fingersL, -1, ra, rl, rg);
      catchArm(J.shoulderR, J.elbowR, J.fingersR, 1, ra, rl, rg);
    }

    this.writeInstances();
  }

  private writeInstances(): void {
    this.root.updateMatrixWorld(true);
    const jaw = this.atk.jaw;
    const alertMouth = 1 + this.alert * 1.2 + this.chaseK * 0.6;
    // The slit tears open into a wide maw during the catch.
    const mouthW = Math.max(alertMouth, 1 + 5.5 * jaw);
    const mouthH = 1 + this.alert * 0.25 + 0.45 * jaw;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      _m.multiplyMatrices(p.joint.matrixWorld, p.local);
      if (p.mouth) _m.multiply(_m2.makeScale(mouthW, mouthH, 1 + jaw));
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** World position of the head (for afterimage range tests). */
  /** The scene object to add (same role as SkinnedMonster.object). */
  get object(): THREE.Object3D {
    return this.mesh;
  }

  headWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.j.head.getWorldPosition(out);
  }

  /** Append world-space copies of the current pose (position + normal only) for afterimages. */
  bake(out: THREE.BufferGeometry[], inflate = 1): void {
    const base = unitCapsule();
    _m2.makeScale(inflate, inflate, inflate);
    for (let i = 0; i < this.parts.length; i++) {
      this.mesh.getMatrixAt(i, _m);
      if (inflate !== 1) _m.multiply(_m2);
      out.push(positionNormalOnly(base.clone()).applyMatrix4(_m));
    }
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.dispose();
  }
}
