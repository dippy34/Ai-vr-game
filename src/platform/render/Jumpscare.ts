/**
 * The catch sequence ("jumpscare"), ~1.6 s, played when the monster catches the LOCAL player:
 *
 *   0.00 s  The monster's face snaps in front of yours (0.52 m -> 0.40 m in 70 ms) mid-lunge, jaws
 *           splitting open (Attack clip, time-driven), and a harsh flash-like burst from your eyes
 *           lights it (the existing near "dark-adapted eyes" light, boosted: no extra light).
 *           A single red/black vignette pulse floods in from the edges.
 *   ~0.3 s  The burst settles to a dim, harsh glow; the face keeps pressing in (0.34 m), the claws
 *           close around you and the vignette closes in like tunnel vision.
 *   0.90 s  Cut to black over 0.22 s. A pale afterimage of the face (the flash "burned" into your
 *           eyes, same look as camera-flash afterimages) hangs in the black.
 *   1.12 s  While black: the monster goes back to where the sim has it (feeding) and the ghost
 *           look turns on (red-tinted, desaturated fog/ambient).
 *   1.30 s  Fade into the ghost (spectator) view, done at 1.60 s.
 *
 * VR comfort: the camera is never moved (the MONSTER is placed relative to the head pose, visual
 * only; the sim keeps its position). There is no full-view white at all (the burst lights only
 * what is within ~1.3 m, i.e. the face, the arms and your hands); full-view effects are a single
 * red edge pulse and smooth fades, no flicker. The vignette is computed per eye from the view
 * direction, so it sits at infinity instead of at the overlay quad's depth.
 *
 * Other players being caught: the monster turns to their head and plays Attack at them (no screen
 * effects); a flash during the grab freezes it into an afterimage like anything else.
 *
 * The timing curves are pure functions (jumpscareFrame / remoteGrabFrame) so they are unit tested.
 */

import * as THREE from 'three';
import type { PlayerId, WorldState } from '../../core/types';
import type { FlashEffect } from './FlashEffect';
import type { Aabb } from './util';
import { damp, paint } from './util';

// ---------------------------------------------------------------------------------------------
// Timing (pure)
// ---------------------------------------------------------------------------------------------

export const JUMPSCARE_TIMING = {
  /** The face snaps from `far` to `near` over this many seconds. */
  lunge: 0.07,
  far: 0.52,
  near: 0.4,
  /** Where it has pressed in to by the cut. */
  press: 0.34,
  /** Fade to black. */
  cutStart: 0.9,
  cutEnd: 1.12,
  /** Black hold ends; the ghost view fades in until `end`. */
  holdEnd: 1.3,
  end: 1.6,
  /** The retinal-burn afterimage of the face is baked here (it ramps in over the black). */
  burnAt: 0.84,
  /** Attack clip time at 0 s, when the jaws are fully split (`jawOpenAt` s later), and at the cut. */
  clipStart: 0.3,
  clipOpen: 0.5,
  jawOpenAt: 0.2,
  clipCut: 0.66,
} as const;

export const REMOTE_GRAB_TIMING = {
  clipStart: 0.22,
  /** Blend the visual from the sim position into the grab and back. */
  blendIn: 0.14,
  blendOutStart: 0.95,
  end: 1.3,
} as const;

/** Everything the local sequence needs at one instant (filled in place: no allocations). */
export interface JumpscareFrame {
  /** Eye -> face distance (m). */
  dist: number;
  /** Attack clip time (s). */
  clip: number;
  /** Face-burst light 0..1. */
  light: number;
  /** Red flood 0..1, edge darkening ("tunnel") 0..1, full black 0..1. */
  red: number;
  tunnel: number;
  black: number;
  /** Head-shake amplitude (m) of the face. */
  shake: number;
  /** True once the monster should be back at its sim position (hidden by the black). */
  released: boolean;
  /** True once the sequence is over. */
  done: boolean;
}

export const newJumpscareFrame = (): JumpscareFrame => ({
  dist: 0, clip: 0, light: 0, red: 0, tunnel: 0, black: 0, shake: 0, released: false, done: false,
});

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOutCubic = (x: number): number => 1 - Math.pow(1 - clamp01(x), 3);

/** The local catch sequence at `t` seconds after the catch. */
export function jumpscareFrame(t: number, out: JumpscareFrame): JumpscareFrame {
  const J = JUMPSCARE_TIMING;
  t = Math.max(0, t);
  // Distance: snap in, then a slow press, still creeping during the cut.
  const snap = easeOutCubic(t / J.lunge);
  const press = smooth(J.lunge, J.cutEnd, t);
  out.dist = J.far + (J.near - J.far) * snap + (J.press - J.near) * press;
  // Attack clip: jaws split open fast, then the claws close slowly.
  out.clip = t < J.jawOpenAt
    ? J.clipStart + (J.clipOpen - J.clipStart) * easeOutCubic(t / J.jawOpenAt)
    : J.clipOpen + (J.clipCut - J.clipOpen) * smooth(J.jawOpenAt, J.cutEnd, t);
  // Black: fade in, hold, fade out.
  out.black = t < J.holdEnd ? smooth(J.cutStart, J.cutEnd, t) : 1 - smooth(J.holdEnd, J.end, t);
  const lit = 1 - smooth(J.cutStart, J.cutEnd, t);
  // Face burst: full for 35 ms, then one smooth decay to a dim sustained glow (no flicker).
  const burst = t < 0.035 ? 1 : 0.065 + 0.935 * Math.exp(-(t - 0.035) / 0.085);
  out.light = burst * lit;
  // One red pulse (peak at 30 ms), a little red lingers until the cut.
  const pulse = t < 0.03 ? t / 0.03 : Math.exp(-(t - 0.03) / 0.2);
  out.red = Math.max(pulse, 0.18 * smooth(0, 0.2, t)) * lit;
  out.tunnel = (0.5 * smooth(0, 0.12, t) + 0.5 * smooth(0.3, J.cutStart, t)) * lit;
  out.shake = 0.011 * Math.exp(-t / 0.35) * lit;
  out.released = t >= J.cutEnd;
  out.done = t >= J.end;
  return out;
}

/** Another player caught: Attack clip time and how much the visual is pulled into the grab. */
export function remoteGrabFrame(t: number, out: { clip: number; weight: number; done: boolean }): { clip: number; weight: number; done: boolean } {
  const R = REMOTE_GRAB_TIMING;
  t = Math.max(0, t);
  out.clip = Math.min(1.2, R.clipStart + t);
  out.weight = smooth(0, R.blendIn, t) * (1 - smooth(R.blendOutStart, R.end, t));
  out.done = t >= R.end;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Monster side
// ---------------------------------------------------------------------------------------------

/** What both monster renderers (SkinnedMonster, MonsterModel) implement for the catch. */
export interface CatchPoser {
  /**
   * Catch override for this frame (call before update()). The monster poses its Attack lunge at
   * `clip` seconds and is placed visually (the sim position is untouched):
   *   'face': rotated (yaw, then pitch) and moved so its face point lands exactly on `target`;
   *   'root': its feet blended from the sim position to `target` by `weight`, turned toward `yaw`.
   */
  setCatch(clip: number, place: 'face' | 'root', target: THREE.Vector3, yaw: number, pitch: number, weight: number): void;
  /** Back to following the sim (Feed while it is feeding). */
  clearCatch(): void;
  /** Horizontal distance from the feet to the face at the peak of the lunge (m). */
  readonly lungeReach: number;
  /** Extra pitch (rad) that makes its lunging face look straight at the camera. */
  readonly facePitch: number;
  bake(out: THREE.BufferGeometry[], inflate?: number): void;
}

// ---------------------------------------------------------------------------------------------
// Renderer side
// ---------------------------------------------------------------------------------------------

/** Burst light (re-using the near light at the eyes: the light count never changes). */
const BURST = { intensity: 6, distance: 1.35, color: 0xf2f5ff, below: 0.07 } as const;
/** Ghost view while the local player is caught: tints (and a little more ambient, "ghost sight"). */
const GHOST_LOOK = {
  sky: 0xc09a9a, ground: 0x3c1f1f, ambient: 1.45, fog: 0x0e0405, background: 0x050102, near: 0xd8a0a0,
} as const;
/** Pale afterimage of the face left by the flash, seen over the black. */
const BURN = { brightness: 0.55, strength: 0.4, push: 2.6 } as const;
/** Head pitch the face follows is clamped to this (rad) so it never ends up in the floor/ceiling. */
const PITCH_LIMIT = { down: 0.4, up: 0.25 } as const;

const VERT = /* glsl */ `
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

// Composited back to front: red flood, edge darkening, black. Premultiplied alpha.
const FRAG = /* glsl */ `
uniform float uRed;
uniform float uTunnel;
uniform float uBlack;
varying vec3 vView;
void main() {
  // tan of the angle off this eye's view axis: 0 center, ~1.2 at a Quest's edge.
  float r = length(vView.xy / max(-vView.z, 1e-3));
  float inner = mix(1.25, 0.2, uTunnel);
  float aD = smoothstep(inner, inner + 0.6, r) * min(1.0, uTunnel * 1.8);
  float aR = uRed * mix(0.05, 0.92, smoothstep(0.12, 1.05, r));
  vec3 c = vec3(0.2, 0.0, 0.006) * aR;
  float a = aR;
  c *= 1.0 - aD;
  a = aD + a * (1.0 - aD);
  c *= 1.0 - uBlack;
  a = uBlack + a * (1.0 - uBlack);
  gl_FragColor = vec4(c, a);
  #include <colorspace_fragment>
}`;

const _f = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _t = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _c = new THREE.Color();
const Y = new THREE.Vector3(0, 1, 0);

interface LocalRun {
  start: number;
  /** Smoothed head the face is anchored to, and the (pitch-clamped) direction it is in. */
  readonly head: THREE.Vector3;
  readonly fwd: THREE.Vector3;
  blockers: Aabb[];
  burned: boolean;
  released: boolean;
}

interface RemoteRun {
  id: PlayerId;
  start: number;
  readonly victim: THREE.Vector3;
}

export class Jumpscare {
  /** Off = no local sequence (the ghost look still applies). RENDER.jumpscare by default. */
  enabled: boolean;
  private readonly overlay: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  private readonly frame = newJumpscareFrame();
  private readonly grab = { clip: 0, weight: 0, done: false };
  private readonly local: LocalRun = {
    start: 0, head: new THREE.Vector3(), fwd: new THREE.Vector3(), blockers: [], burned: false, released: false,
  };
  private localActive = false;
  private readonly remote: RemoteRun = { id: '', start: 0, victim: new THREE.Vector3() };
  private remoteActive = false;
  private ghost = 0;
  /** What applyLook() last wrote (it only touches the lights/fog when these change). */
  private appliedGhost = -1;
  private appliedBurst = -1;
  private deferred: { text: string; seconds: number } | null = null;
  /** Shown when the sequence ends (messages that arrived during it). */
  onDeferredMessage: (text: string, seconds: number) => void = () => {};
  private readonly base: {
    sky: THREE.Color; ground: THREE.Color; hemi: number; fog: THREE.Color | null; background: THREE.Color | null;
    near: THREE.Color; nearIntensity: number; nearDistance: number;
  };

  constructor(
    private readonly scene: THREE.Scene,
    camera: THREE.Camera,
    private readonly hemi: THREE.HemisphereLight,
    private readonly nearLight: THREE.PointLight,
    private readonly flashFx: FlashEffect,
    enabled: boolean,
  ) {
    this.enabled = enabled;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uRed: { value: 0 }, uTunnel: { value: 0 }, uBlack: { value: 0 } },
      transparent: true,
      premultipliedAlpha: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.overlay = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 2.5), this.mat);
    this.overlay.name = 'jumpscare';
    this.overlay.position.z = -0.12;
    // After the world and ghost avatars, but BEFORE flash afterimages (19/20), so the burned-in
    // afterimage of the face shows over the black. Messages/whiteout draw later still.
    this.overlay.renderOrder = 15;
    this.overlay.frustumCulled = false;
    this.overlay.visible = false;
    camera.add(this.overlay);

    const fog = scene.fog instanceof THREE.Fog ? scene.fog : null;
    this.base = {
      sky: hemi.color.clone(), ground: hemi.groundColor.clone(), hemi: hemi.intensity,
      fog: fog ? fog.color.clone() : null,
      background: scene.background instanceof THREE.Color ? scene.background.clone() : null,
      near: nearLight.color.clone(), nearIntensity: nearLight.intensity, nearDistance: nearLight.distance,
    };
  }

  /** True while the local sequence runs (until the ghost view has faded in). */
  get active(): boolean {
    return this.localActive;
  }

  /** Is this (other) player being grabbed right now? (They still get flash afterimages.) */
  grabbing(id: PlayerId): boolean {
    return this.remoteActive && this.remote.id === id;
  }

  /** Make the overlay visible for a renderer.compile() call. */
  setWarmupVisible(v: boolean): void {
    this.overlay.visible = v || this.localActive;
  }

  /** Hold a message until the sequence is over (it would float over the monster's face). */
  deferMessage(text: string, seconds: number): boolean {
    if (!this.localActive) return false;
    this.deferred = { text, seconds };
    return true;
  }

  /** The local player was caught. `head`/`headQuat` = their head now; `blockers` = walls. */
  startLocal(time: number, head: THREE.Vector3, headQuat: THREE.Quaternion, blockers: Aabb[]): void {
    if (!this.enabled) return;
    const L = this.local;
    L.start = time;
    L.head.copy(head);
    clampedForward(headQuat, L.fwd);
    L.blockers = blockers;
    L.burned = false;
    L.released = false;
    this.localActive = true;
    this.remoteActive = false;
    this.overlay.visible = true;
  }

  /** Another player was caught at `victimHead`. */
  startRemote(id: PlayerId, time: number, victimHead: THREE.Vector3): void {
    if (this.localActive) return;
    this.remote.id = id;
    this.remote.start = time;
    this.remote.victim.copy(victimHead);
    this.remoteActive = true;
  }

  /** Abort everything (new level / session). */
  reset(monster: CatchPoser | null): void {
    if (this.localActive || this.remoteActive) monster?.clearCatch();
    this.localActive = this.remoteActive = false;
    this.overlay.visible = false;
    this.deferred = null;
    this.ghost = 0;
    this.appliedGhost = -1;
    this.applyLook(0, 0);
  }

  /**
   * Per frame, AFTER the near light was placed at the head and BEFORE monster.update().
   * `victimHead(id, out)` = a remote player's current (smoothed) head, false if unknown.
   */
  update(
    state: WorldState, localId: PlayerId, head: THREE.Vector3, headQuat: THREE.Quaternion, monster: CatchPoser,
    time: number, dt: number, victimHead: (id: PlayerId, out: THREE.Vector3) => boolean,
  ): void {
    const me = state.players[localId];
    const caught = !!me && me.status === 'caught' && state.phase !== 'lobby';

    let light = 0;
    if (this.localActive) {
      // A new round (or lobby) mid-sequence: stop at once.
      if (!caught && time - this.local.start > 0.5) this.finishLocal(monster);
      else light = this.updateLocal(head, headQuat, monster, time, dt);
    } else if (this.remoteActive) {
      this.updateRemote(state, monster, time, victimHead);
    }

    // Ghost look: snaps on in the black, otherwise eases (sequence disabled, joined while caught).
    const target = caught ? 1 : 0;
    if (this.localActive && !this.local.released) this.ghost = 0;
    else if (this.localActive || !caught) this.ghost = target;
    else this.ghost = Math.abs(target - this.ghost) < 0.002 ? target : this.ghost + (target - this.ghost) * damp(3, dt);
    this.applyLook(this.ghost, light);
  }

  private updateLocal(head: THREE.Vector3, headQuat: THREE.Quaternion, monster: CatchPoser, time: number, dt: number): number {
    const L = this.local;
    const t = time - L.start;
    const f = jumpscareFrame(t, this.frame);

    // Follow the head softly: flinching back or turning away doesn't get you out of its face.
    L.head.lerp(head, damp(12, dt));
    clampedForward(headQuat, _fwd);
    L.fwd.lerp(_fwd, damp(5, dt)).normalize();

    // Never put the face behind a wall right in front of you.
    const wall = rayBlockers(L.head, L.fwd, L.blockers);
    const dist = Math.max(0.2, Math.min(f.dist, wall - 0.07));
    _t.copy(L.head).addScaledVector(L.fwd, dist);
    if (f.shake > 0) {
      _side.crossVectors(L.fwd, Y);
      if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
      _side.normalize();
      _up.crossVectors(_side, L.fwd);
      _t.addScaledVector(_side, f.shake * Math.sin(t * 61)).addScaledVector(_up, f.shake * 0.7 * Math.sin(t * 47 + 1.3));
    }
    // Monster faces back along the view; pitched so its face looks into your eyes.
    const yaw = Math.atan2(L.fwd.x, L.fwd.z);
    const pitch = monster.facePitch - Math.asin(THREE.MathUtils.clamp(L.fwd.y, -1, 1));

    if (!f.released) {
      monster.setCatch(f.clip, 'face', _t, yaw, pitch, 1);
      if (!L.burned && t >= JUMPSCARE_TIMING.burnAt) {
        L.burned = true;
        this.burn(monster, L.head, time);
      }
    } else if (!L.released) {
      L.released = true;
      monster.clearCatch();
    }

    // Burst light from just under your eyes (harsh under-lighting), short range: only the face,
    // the arms reaching around you and your own hands catch it.
    this.nearLight.position.copy(L.head).addScaledVector(L.fwd, 0.03);
    this.nearLight.position.y -= BURST.below;

    const u = this.mat.uniforms;
    u.uRed.value = f.red;
    u.uTunnel.value = f.tunnel;
    u.uBlack.value = f.black;
    if (f.done) this.finishLocal(monster);
    return f.light;
  }

  private finishLocal(monster: CatchPoser): void {
    if (!this.local.released) monster.clearCatch();
    this.localActive = false;
    this.overlay.visible = false;
    const d = this.deferred;
    this.deferred = null;
    if (d) this.onDeferredMessage(d.text, d.seconds);
  }

  private updateRemote(state: WorldState, monster: CatchPoser, time: number, victimHead: (id: PlayerId, out: THREE.Vector3) => boolean): void {
    const R = this.remote;
    const g = remoteGrabFrame(time - R.start, this.grab);
    if (g.done) {
      this.remoteActive = false;
      monster.clearCatch();
      return;
    }
    victimHead(R.id, R.victim);
    // Feet placed so the lunging face ends just in front of the victim's head.
    const mp = state.monster.position;
    _f.set(R.victim.x - mp.x, 0, R.victim.z - mp.z);
    if (_f.lengthSq() < 1e-6) _f.set(0, 0, -1);
    _f.normalize();
    const yaw = Math.atan2(-_f.x, -_f.z);
    _t.set(R.victim.x, mp.y, R.victim.z).addScaledVector(_f, -(monster.lungeReach + 0.1));
    monster.setCatch(g.clip, 'root', _t, yaw, 0, g.weight);
  }

  /** Pale afterimage of the face, as if the burst burned it into your eyes. */
  private burn(monster: CatchPoser, eye: THREE.Vector3, time: number): void {
    const parts: THREE.BufferGeometry[] = [];
    monster.bake(parts, 1.0);
    // Scaled up about the eye: identical on screen, but ~1 m away, so afterimage depth tricks
    // (and stereo) never put it a few cm in front of your eyes.
    _m.makeTranslation(eye.x, eye.y, eye.z)
      .multiply(_m2.makeScale(BURN.push, BURN.push, BURN.push))
      .multiply(_m2.makeTranslation(-eye.x, -eye.y, -eye.z));
    _c.setScalar(BURN.brightness);
    for (const g of parts) paint(g.applyMatrix4(_m), _c);
    this.flashFx.addAfterimage(parts, [], time, BURN.strength);
  }

  private applyLook(ghost: number, burst: number): void {
    if (ghost === this.appliedGhost && burst === this.appliedBurst) return;
    this.appliedGhost = ghost;
    this.appliedBurst = burst;
    const b = this.base;
    this.hemi.color.copy(b.sky).lerp(_c.set(GHOST_LOOK.sky), ghost);
    this.hemi.groundColor.copy(b.ground).lerp(_c.set(GHOST_LOOK.ground), ghost);
    this.hemi.intensity = b.hemi * (1 + (GHOST_LOOK.ambient - 1) * ghost);
    const fog = this.scene.fog;
    if (b.fog && fog instanceof THREE.Fog) fog.color.copy(b.fog).lerp(_c.set(GHOST_LOOK.fog), ghost);
    const bg = this.scene.background;
    if (b.background && bg instanceof THREE.Color) bg.copy(b.background).lerp(_c.set(GHOST_LOOK.background), ghost);
    const n = this.nearLight;
    if (burst > 0) {
      n.color.set(BURST.color);
      n.intensity = BURST.intensity * burst;
      n.distance = BURST.distance;
    } else {
      n.color.copy(b.near).lerp(_c.set(GHOST_LOOK.near), ghost);
      n.intensity = b.nearIntensity;
      n.distance = b.nearDistance;
    }
  }

  dispose(): void {
    this.overlay.removeFromParent();
    this.overlay.geometry.dispose();
    this.mat.dispose();
  }
}

/** Head forward with its pitch clamped (looking at your feet doesn't put it in the floor). */
function clampedForward(q: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  out.set(0, 0, -1).applyQuaternion(q);
  const h = Math.hypot(out.x, out.z);
  const pitch = THREE.MathUtils.clamp(Math.atan2(out.y, h), -PITCH_LIMIT.down, PITCH_LIMIT.up);
  const yaw = h > 1e-4 ? Math.atan2(out.x, out.z) : 0;
  const c = Math.cos(pitch);
  return out.set(Math.sin(yaw) * c, Math.sin(pitch), Math.cos(yaw) * c);
}

/** Distance along the ray to the nearest blocker box (Infinity if none). Allocation-free. */
function rayBlockers(o: THREE.Vector3, d: THREE.Vector3, boxes: Aabb[]): number {
  let best = Infinity;
  for (const b of boxes) {
    let t0 = 0;
    let t1 = best;
    let hit = true;
    for (let axis = 0; axis < 3 && hit; axis++) {
      const oa = axis === 0 ? o.x : axis === 1 ? o.y : o.z;
      const da = axis === 0 ? d.x : axis === 1 ? d.y : d.z;
      const lo = axis === 0 ? b.minX : axis === 1 ? b.minY : b.minZ;
      const hi = axis === 0 ? b.maxX : axis === 1 ? b.maxY : b.maxZ;
      if (Math.abs(da) < 1e-9) {
        if (oa < lo || oa > hi) hit = false;
        continue;
      }
      let ta = (lo - oa) / da;
      let tb = (hi - oa) / da;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) hit = false;
    }
    if (hit && t0 < best) best = t0;
  }
  return best;
}
