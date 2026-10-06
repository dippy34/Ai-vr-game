/**
 * The Blender-made, rigged monster (public/models/monster.glb). Same role as MonsterModel (the
 * procedural fallback): follow MonsterState, animate, and bake its current pose for afterimages.
 *
 * Animation choice from the AI state:
 *   feeding            -> Attack once, then Feed (loop)
 *   chase              -> Run, timeScale by speed / runSpeed
 *   investigate + slow -> Listen
 *   barely moving      -> Idle (Listen when agitated)
 *   otherwise          -> Walk, timeScale by speed / walkSpeed
 *
 * The catch sequence (Jumpscare) overrides this per frame via setCatch(): Attack at a time it
 * drives, and a visual-only placement (in the local player's face, or lunging at another player).
 */

import * as THREE from 'three';
import { MONSTER } from '../../config';
import type { MonsterMode, MonsterState } from '../../core/types';
import { bakeObject, type ModelAsset } from './assets';
import type { CatchPoser } from './Jumpscare';
import { setV } from './util';

type Clip = 'Idle' | 'Walk' | 'Run' | 'Listen' | 'Attack' | 'Feed';

const FADE = 0.28;
/** Attack clip time at the peak of the lunge (head fully extended, jaws split). */
const LUNGE_PEAK = 0.5;
/** Face point in the jaw bone's frame: mid-mouth, between the split mandibles. */
const FACE_IN_JAW = new THREE.Vector3(0, 0.05, 0.015);
/** Its lunging face points ~18 degrees down; this lifts it to look straight at the camera. */
const FACE_PITCH = 0.26;
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _box = new THREE.Box3();

const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

export class SkinnedMonster implements CatchPoser {
  readonly object: THREE.Group;
  readonly lungeReach: number;
  readonly facePitch = FACE_PITCH;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<Clip, THREE.AnimationAction>();
  private readonly head: THREE.Object3D | null;
  private readonly jaw: THREE.Object3D | null;
  /** Smoothed sim position (the object itself may be placed elsewhere by the catch). */
  private readonly pos = new THREE.Vector3();
  private readonly walkSpeed: number;
  private readonly runSpeed: number;
  private current: Clip | null = null;
  private initialized = false;
  private yaw = 0;
  private speed = 0;
  private prevMode: MonsterMode | null = null;
  private attackUntil = 0;
  private time = 0;
  // Catch override (Jumpscare), set every frame while active.
  private catchClip = -1;
  private catchPlace: 'face' | 'root' = 'face';
  private readonly catchTarget = new THREE.Vector3();
  private catchYaw = 0;
  private catchPitch = 0;
  private catchWeight = 1;
  private catchStarted = false;
  private lastCatch = -1e9;

  constructor(asset: ModelAsset, instance: THREE.Object3D) {
    this.object = new THREE.Group();
    this.object.name = 'monster';
    this.object.add(instance);

    // A model that declares its height (extras.height) is authored at final scale: its hunched
    // walk already matches MONSTER.height. Anything else gets fitted to the gameplay height.
    if (typeof asset.extras.height !== 'number') {
      _box.setFromObject(instance);
      const h = _box.max.y - _box.min.y;
      if (h > 0.5) instance.scale.multiplyScalar(MONSTER.height / h);
    }

    instance.updateMatrixWorld(true);
    instance.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) {
        // Skinned bounds don't follow the animation: cull against a fixed, generous sphere around
        // the rest pose (covers the reach of the long arms and the lunge) instead of never culling.
        if (m.isSkinnedMesh) {
          m.computeBoundingSphere();
          if (m.boundingSphere) m.boundingSphere.radius = m.boundingSphere.radius * 1.6 + 0.2;
          m.frustumCulled = !!m.boundingSphere;
        } else {
          m.frustumCulled = false;
        }
        m.castShadow = m.receiveShadow = false;
      }
    });

    this.head = instance.getObjectByName('head') ?? instance.getObjectByName('Head') ?? null;
    this.jaw = instance.getObjectByName('jaw') ?? null;
    const num = (v: unknown, d: number) => (typeof v === 'number' && v > 0 ? v : d);
    this.walkSpeed = num(asset.extras.walkSpeed, 1.0);
    this.runSpeed = num(asset.extras.runSpeed, 3.1);

    this.mixer = new THREE.AnimationMixer(instance);
    for (const clip of asset.animations) {
      const name = clip.name as Clip;
      const action = this.mixer.clipAction(clip);
      if (name === 'Attack') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(name, action);
    }
    this.lungeReach = this.measureLungeReach();
    this.play('Idle', 0);
  }

  /** Pose the lunge peak once to measure how far ahead of its feet the face gets. */
  private measureLungeReach(): number {
    const attack = this.actions.get('Attack');
    if (!attack) return 1.0;
    attack.reset().play();
    attack.paused = true;
    attack.time = LUNGE_PEAK;
    this.mixer.update(0);
    this.object.updateMatrixWorld(true);
    this.object.worldToLocal(this.facePoint(_f));
    attack.stop();
    this.mixer.update(0);
    const reach = Math.hypot(_f.x, _f.z);
    return reach > 0.2 && reach < 3 ? reach : 1.0;
  }

  /** World position of the face (mid-mouth). Needs up-to-date world matrices. */
  private facePoint(out: THREE.Vector3): THREE.Vector3 {
    if (this.jaw) return this.jaw.localToWorld(out.copy(FACE_IN_JAW));
    return this.headWorld(out);
  }

  /** True when the GLB has the animations this class drives. */
  static usable(asset: ModelAsset): boolean {
    const names = new Set(asset.animations.map((a) => a.name));
    return ['Idle', 'Walk', 'Run'].every((n) => names.has(n));
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
    this.catchStarted = false;
    this.attackUntil = 0;
    this.object.rotation.set(0, this.yaw, 0);
    this.object.position.copy(this.pos);
  }

  update(m: MonsterState, dt: number): void {
    this.time += dt;
    setV(_v, m.position);
    if (!this.initialized || this.pos.distanceToSquared(_v) > 9) {
      this.pos.copy(_v);
      this.yaw = m.yaw;
      this.initialized = true;
    } else {
      this.pos.lerp(_v, damp(12, dt));
      const d = Math.atan2(Math.sin(m.yaw - this.yaw), Math.cos(m.yaw - this.yaw));
      this.yaw += d * damp(10, dt);
    }
    this.speed += (m.speed - this.speed) * damp(6, dt);
    if (this.catchClip >= 0) {
      this.updateCatch(dt);
      this.prevMode = m.mode;
      return;
    }
    this.object.position.copy(this.pos);
    this.object.rotation.set(0, this.yaw, 0);

    // Lunge when it catches someone (mode flips to feeding), then feed. (A catch the renderer
    // already played through setCatch() doesn't lunge twice.)
    if (m.mode === 'feeding' && this.prevMode !== 'feeding' && this.actions.has('Attack') && this.time - this.lastCatch > 3) {
      const attack = this.actions.get('Attack')!;
      this.attackUntil = this.time + attack.getClip().duration * 0.92;
      attack.reset();
      this.play('Attack', 0.12);
    }
    this.prevMode = m.mode;

    if (this.time >= this.attackUntil) {
      const clip = this.choose(m);
      this.play(clip, FADE);
      const action = this.actions.get(clip);
      if (action) {
        if (clip === 'Walk') action.timeScale = THREE.MathUtils.clamp(this.speed / this.walkSpeed, 0.45, 2.2);
        else if (clip === 'Run') action.timeScale = THREE.MathUtils.clamp(this.speed / this.runSpeed, 0.6, 1.5);
        else action.timeScale = m.alert > 0.6 ? 1.25 : 1;
      }
    }
    this.mixer.update(dt);
  }

  private updateCatch(dt: number): void {
    const attack = this.actions.get('Attack');
    if (!this.catchStarted) {
      this.catchStarted = true;
      this.lastCatch = this.time;
      if (attack) {
        const prev = this.current && this.current !== 'Attack' ? this.actions.get(this.current) : undefined;
        attack.reset();
        attack.setEffectiveWeight(1).play();
        attack.paused = true;
        // In your face: snap (the face appears at once). Lunging at someone else: a quick blend.
        if (prev && this.catchPlace === 'root') prev.crossFadeTo(attack, 0.12, false);
        else for (const a of this.actions.values()) if (a !== attack) a.stop();
        this.current = 'Attack';
      }
    }
    if (attack) attack.time = Math.min(this.catchClip, attack.getClip().duration - 1e-3);
    this.mixer.update(dt);

    const o = this.object;
    const w = this.catchWeight;
    if (this.catchPlace === 'face') {
      o.rotation.set(this.catchPitch, this.catchYaw, 0, 'YXZ');
      o.updateMatrixWorld(true);
      // Face point in the object's frame, then move the object so it lands on the target.
      o.worldToLocal(this.facePoint(_f));
      _f.multiply(o.scale).applyQuaternion(o.quaternion);
      o.position.copy(this.catchTarget).sub(_f);
    } else {
      o.position.lerpVectors(this.pos, this.catchTarget, w);
      const d = Math.atan2(Math.sin(this.catchYaw - this.yaw), Math.cos(this.catchYaw - this.yaw));
      o.rotation.set(0, this.yaw + d * w, 0);
    }
  }

  private choose(m: MonsterState): Clip {
    const has = (c: Clip) => this.actions.has(c);
    if (m.mode === 'feeding' && has('Feed')) return 'Feed';
    if (m.mode === 'chase' && this.speed > 0.4) return 'Run';
    if (this.speed < 0.25) {
      if ((m.mode === 'investigate' || m.alert > 0.4) && has('Listen')) return 'Listen';
      return 'Idle';
    }
    if (m.mode === 'investigate' && this.speed < 0.45 && has('Listen')) return 'Listen';
    return this.speed > this.walkSpeed * 2.2 && has('Run') ? 'Run' : 'Walk';
  }

  private play(clip: Clip, fade: number): void {
    if (clip === this.current) return;
    const next = this.actions.get(clip);
    if (!next) return;
    const prev = this.current ? this.actions.get(this.current) : undefined;
    next.enabled = true;
    if (clip !== 'Attack') next.reset();
    next.setEffectiveWeight(1).play();
    if (prev && fade > 0) prev.crossFadeTo(next, fade, false);
    else if (prev) prev.stop();
    this.current = clip;
  }

  headWorld(out: THREE.Vector3): THREE.Vector3 {
    if (this.head) return this.head.getWorldPosition(out);
    return out.copy(this.object.position).setY(this.object.position.y + MONSTER.height * 0.92);
  }

  /** World-space copy of the current pose for flash afterimages. */
  bake(out: THREE.BufferGeometry[], inflate = 1): void {
    bakeObject(this.object, out, (inflate - 1) * 0.3);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.object.removeFromParent();
    // Geometry/materials are shared with the ModelLibrary's source scene; it owns them.
  }
}
