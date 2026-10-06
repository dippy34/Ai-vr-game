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
 */

import * as THREE from 'three';
import { MONSTER } from '../../config';
import type { MonsterMode, MonsterState } from '../../core/types';
import { bakeObject, type ModelAsset } from './assets';
import { setV } from './util';

type Clip = 'Idle' | 'Walk' | 'Run' | 'Listen' | 'Attack' | 'Feed';

const FADE = 0.28;
const _v = new THREE.Vector3();
const _box = new THREE.Box3();

const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

export class SkinnedMonster {
  readonly object: THREE.Group;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<Clip, THREE.AnimationAction>();
  private readonly head: THREE.Object3D | null;
  private readonly walkSpeed: number;
  private readonly runSpeed: number;
  private current: Clip | null = null;
  private initialized = false;
  private yaw = 0;
  private speed = 0;
  private prevMode: MonsterMode | null = null;
  private attackUntil = 0;
  private time = 0;

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
    this.play('Idle', 0);
  }

  /** True when the GLB has the animations this class drives. */
  static usable(asset: ModelAsset): boolean {
    const names = new Set(asset.animations.map((a) => a.name));
    return ['Idle', 'Walk', 'Run'].every((n) => names.has(n));
  }

  update(m: MonsterState, dt: number): void {
    this.time += dt;
    setV(_v, m.position);
    if (!this.initialized || this.object.position.distanceToSquared(_v) > 9) {
      this.object.position.copy(_v);
      this.yaw = m.yaw;
      this.initialized = true;
    } else {
      this.object.position.lerp(_v, damp(12, dt));
      const d = Math.atan2(Math.sin(m.yaw - this.yaw), Math.cos(m.yaw - this.yaw));
      this.yaw += d * damp(10, dt);
    }
    this.object.rotation.y = this.yaw;
    this.speed += (m.speed - this.speed) * damp(6, dt);

    // Lunge when it catches someone (mode flips to feeding), then feed.
    if (m.mode === 'feeding' && this.prevMode !== 'feeding' && this.actions.has('Attack')) {
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
