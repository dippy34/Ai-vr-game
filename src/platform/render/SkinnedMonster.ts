/**
 * The Blender-made, rigged monster (public/models/monster.glb). Same role as MonsterModel (the
 * procedural fallback): follow MonsterState, animate, and bake its current pose for afterimages.
 *
 * The body is procedural (monster/body.ts): steps planned one at a time onto the floor and
 * furniture, hands that use the geometry around it (door jambs, corners, walls, table tops,
 * windows), a trunk and head driven by the body-language contract (gait / posture / act / focus).
 * Authored clips are kept where they are better than procedure:
 *   Attack  the catch lunge (Jumpscare drives it through setCatch(), exactly as before), and the
 *           lunge when the sim says it caught someone;
 *   Feed    while it feeds (crossfaded with the procedural body in and out).
 * A model without the rig's bone names falls back to playing the clips by mode/speed.
 */

import * as THREE from 'three';
import { MONSTER } from '../../config';
import type { LevelData, MonsterMode, MonsterState } from '../../core/types';
import { bakeObject, type ModelAsset } from './assets';
import type { CatchPoser } from './Jumpscare';
import { ProceduralBody } from './monster/body';
import { MonsterRig, REQUIRED_BONES } from './monster/rig';
import { MonsterWorld } from './monster/world';
import { setV } from './util';

type Clip = 'Idle' | 'Walk' | 'Run' | 'Listen' | 'Attack' | 'Feed';

const FADE = 0.28;
/** Attack clip time at the peak of the lunge (head fully extended, jaws split). */
const LUNGE_PEAK = 0.5;
/** Face point in the jaw bone's frame: mid-mouth, between the split mandibles. */
const FACE_IN_JAW = new THREE.Vector3(0, 0.05, 0.015);
/** Its lunging face points ~18 degrees down; this lifts it to look straight at the camera. */
const FACE_PITCH = 0.26;
/** Clip layer fades (s): into an authored clip, back to the procedural body. */
const CLIP_IN = 0.18;
const CLIP_OUT = 0.55;
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
  private readonly rig: MonsterRig | null;
  private readonly body: ProceduralBody | null;
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
  /** Weight of the authored clip layer over the procedural body (0 = fully procedural). */
  private clipW = 0;
  private clipTarget = 0;
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
        // COLOR_0 holds shader masks, not colors (R thinness, G wetness, B cavity: see
        // art/blender/monster.py). GLTFLoader switches vertexColors on for it, which tints the skin.
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          if (mat?.vertexColors) {
            mat.vertexColors = false;
            mat.needsUpdate = true;
          }
        }
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
    this.rig = MonsterRig.build(instance);
    this.body = this.rig ? new ProceduralBody(this.rig, 0x6d6f6e, instance.scale.x) : null;
    this.lungeReach = this.measureLungeReach();
    if (!this.body) this.play('Idle', 0);
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
    // The authored mandible split at the peak drives the procedural jaw's spread.
    const rig = this.rig;
    if (rig && this.body && rig.jawL >= 0 && rig.jawR >= 0) {
      const d = (i: number) => rig.restQ[i].clone().invert().multiply(rig.bones[i].quaternion);
      this.body.setJawSplit(d(rig.jawL), d(rig.jawR));
    }
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

  /** True when the GLB can drive this class: the procedural rig, or the authored clips. */
  static usable(asset: ModelAsset): boolean {
    if (REQUIRED_BONES.every((n) => !!asset.scene.getObjectByName(n))) return true;
    const names = new Set(asset.animations.map((a) => a.name));
    return ['Idle', 'Walk', 'Run'].every((n) => names.has(n));
  }

  /** The level the body reads (walls, doors, furniture, windows). */
  setLevel(level: LevelData | null): void {
    this.body?.setWorld(level ? new MonsterWorld(level) : null);
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
    const body = this.body;
    if (body) {
      // The body keeps tracking the sim even while a clip or the catch owns the pose.
      body.update(m, dt);
      this.pos.copy(body.root);
      this.yaw = body.rootYaw;
      this.initialized = true;
    } else {
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
      this.play('Attack', body ? 0 : 0.12);
    }
    this.prevMode = m.mode;

    if (!body) {
      this.updateClipsOnly(m);
      this.mixer.update(dt);
      return;
    }

    // Clip layer: Attack (once) then Feed while feeding; the procedural body otherwise.
    const feeding = m.mode === 'feeding' && (this.actions.has('Feed') || this.time < this.attackUntil);
    if (feeding && this.time >= this.attackUntil && this.current !== 'Feed') this.play('Feed', this.current ? FADE : 0);
    const target = feeding ? 1 : 0;
    if (target === 0 && this.clipTarget === 1) body.reset();
    this.clipTarget = target;
    this.clipW += (target - this.clipW) * damp(target > this.clipW ? 1 / CLIP_IN * 3 : 1 / CLIP_OUT * 3, dt);
    if (this.clipW < 0.002 && target === 0) {
      this.clipW = 0;
      if (this.current) {
        this.mixer.stopAllAction();
        this.current = null;
      }
    }
    if (this.clipW > 0) this.mixer.update(dt);
    this.rig!.write(1 - this.clipW);
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
        if (prev && this.catchPlace === 'root' && !this.body) prev.crossFadeTo(attack, 0.12, false);
        else for (const a of this.actions.values()) if (a !== attack) a.stop();
        this.current = 'Attack';
      }
    }
    if (attack) attack.time = Math.min(this.catchClip, attack.getClip().duration - 1e-3);
    this.mixer.update(dt);

    const o = this.object;
    const w = this.catchWeight;
    if (this.catchPlace === 'face') {
      // Exactly the authored lunge: the procedural body is off.
      o.rotation.set(this.catchPitch, this.catchYaw, 0, 'YXZ');
      o.updateMatrixWorld(true);
      // Face point in the object's frame, then move the object so it lands on the target.
      o.worldToLocal(this.facePoint(_f));
      _f.multiply(o.scale).applyQuaternion(o.quaternion);
      o.position.copy(this.catchTarget).sub(_f);
    } else {
      // Lunging at another player: the pose blends from the procedural body into the lunge.
      if (this.rig) this.rig.write(1 - w);
      o.position.lerpVectors(this.pos, this.catchTarget, w);
      const d = Math.atan2(Math.sin(this.catchYaw - this.yaw), Math.cos(this.catchYaw - this.yaw));
      o.rotation.set(0, this.yaw + d * w, 0);
    }
    // Afterwards it feeds: the clip layer stays on (Feed) until the sim lets it go.
    this.clipW = this.catchPlace === 'face' ? 1 : w;
    this.clipTarget = 1;
  }

  /** No procedural rig: pick an authored clip by mode / speed (the original behavior). */
  private updateClipsOnly(m: MonsterState): void {
    if (this.time < this.attackUntil) return;
    const clip = this.choose(m);
    this.play(clip, FADE);
    const action = this.actions.get(clip);
    if (action) {
      if (clip === 'Walk') action.timeScale = THREE.MathUtils.clamp(this.speed / this.walkSpeed, 0.45, 2.2);
      else if (clip === 'Run') action.timeScale = THREE.MathUtils.clamp(this.speed / this.runSpeed, 0.6, 1.5);
      else action.timeScale = m.alert > 0.6 ? 1.25 : 1;
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

  /** World-space copy of the current pose (the jumpscare's burned-in afterimage). */
  bake(out: THREE.BufferGeometry[], inflate = 1): void {
    bakeObject(this.object, out, (inflate - 1) * 0.3);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.object.removeFromParent();
    // Geometry/materials are shared with the ModelLibrary's source scene; it owns them.
  }
}
