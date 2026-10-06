/**
 * The local player's side of the second chance (SECOND_CHANCE in config.ts): prying its jaws
 * apart. Checked on the player's own device, because a reaction can't wait for the network; the
 * host only checks that the claim arrives inside the window.
 *
 *   desktop  two keys are shown on its jaws: press both (any order) before the window closes.
 *            Any other key from the pool is a fumble and the pry fails, so mashing loses.
 *   VR       grip each glowing spot with that hand, then pull your hands apart.
 *
 * Pure logic over plain data: the game loop feeds it input each frame and hands `prompt()` to the
 * renderer, which draws the spots.
 */

import { add3, rotate3, scale3 } from '../core/math';
import type { Handedness, HeadPose, Quat, Vec3 } from '../core/types';
import type { StrugglePrompt } from '../platform/types';

export const PRY = {
  /** The pair is drawn from these (left hand around WASD; no movement or sign keys). */
  keys: ['KeyQ', 'KeyE', 'KeyR', 'KeyF', 'KeyZ', 'KeyX', 'KeyC', 'KeyV'] as readonly string[],
  /** Spot centers from the eyes along the (pitch-clamped) view: right, up, forward (m). */
  spotSide: 0.17,
  spotUp: -0.11,
  spotForward: 0.36,
  /** Same pitch clamp as the catch sequence, so the spots stay on its face. */
  pitchDown: 0.4,
  pitchUp: 0.25,
  /** VR: a gripping hand this close to its spot latches on (m). */
  latchRadius: 0.2,
  /** VR: with both latched, pull the hands this much farther apart (m). */
  pullApart: 0.16,
} as const;

export type StruggleResult = 'pending' | 'free' | 'fumbled' | 'expired';

export interface StruggleInput {
  mode: 'xr' | 'desktop';
  /** Desktop: KeyboardEvent.codes pressed this frame. */
  keysPressed: readonly string[];
  hands: Record<Handedness, { position: Vec3; grip: boolean }>;
}

const SIDES: readonly Handedness[] = ['left', 'right'];

/** "KeyQ" -> "Q". */
export const keyLabel = (code: string): string => (code.startsWith('Key') ? code.slice(3) : code);

export class Struggle {
  readonly keys: Record<Handedness, string>;
  readonly done: Record<Handedness, boolean> = { left: false, right: false };
  result: StruggleResult = 'pending';
  elapsed = 0;
  private spots: Record<Handedness, Vec3>;
  /** VR: hand distance when both latched (null = not both). */
  private latchedAt: number | null = null;

  constructor(
    readonly window: number,
    private readonly mode: 'xr' | 'desktop',
    head: HeadPose,
    rnd: () => number = Math.random,
  ) {
    const pool = [...PRY.keys];
    const a = pool.splice(Math.floor(rnd() * pool.length) % pool.length, 1)[0];
    const b = pool[Math.floor(rnd() * pool.length) % pool.length];
    this.keys = { left: a, right: b };
    this.spots = spotsFor(head);
  }

  /** Feed one frame. Returns the result (sticky once it isn't 'pending'). */
  update(dt: number, head: HeadPose, input: StruggleInput): StruggleResult {
    if (this.result !== 'pending') return this.result;
    this.elapsed += dt;
    this.spots = spotsFor(head, this.spots);
    if (input.mode === 'desktop') this.keysUpdate(input.keysPressed);
    else this.handsUpdate(input.hands);
    if (this.result === 'pending' && this.elapsed > this.window) this.result = 'expired';
    return this.result;
  }

  private keysUpdate(pressed: readonly string[]): void {
    for (const code of pressed) {
      if (code === this.keys.left) this.done.left = true;
      else if (code === this.keys.right) this.done.right = true;
      else if (PRY.keys.includes(code)) {
        this.result = 'fumbled';
        return;
      }
      if (this.done.left && this.done.right) {
        this.result = 'free';
        return;
      }
    }
  }

  private handsUpdate(hands: StruggleInput['hands']): void {
    for (const side of SIDES) {
      const h = hands[side];
      if (!h.grip) this.done[side] = false;
      else if (!this.done[side] && dist(h.position, this.spots[side]) <= PRY.latchRadius) this.done[side] = true;
    }
    if (!this.done.left || !this.done.right) {
      this.latchedAt = null;
      return;
    }
    const apart = dist(hands.left.position, hands.right.position);
    if (this.latchedAt === null) this.latchedAt = apart;
    else if (apart >= this.latchedAt + PRY.pullApart) this.result = 'free';
  }

  /** What the renderer draws this frame. `hint` = extra line under the spots. */
  prompt(hint: string): StrugglePrompt {
    const desktop = this.mode === 'desktop';
    return {
      spots: { left: { ...this.spots.left }, right: { ...this.spots.right } },
      labels: desktop ? { left: keyLabel(this.keys.left), right: keyLabel(this.keys.right) } : { left: '', right: '' },
      done: { ...this.done },
      timeLeft: Math.max(0, 1 - this.elapsed / this.window),
      state: this.result,
      hint,
    };
  }
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** World positions of the two spots for this head pose (written into `out` if given). */
export function spotsFor(head: HeadPose, out?: Record<Handedness, Vec3>): Record<Handedness, Vec3> {
  const f = rotate3(head.rotation as Quat, { x: 0, y: 0, z: -1 });
  const h = Math.hypot(f.x, f.z);
  const pitch = Math.min(PRY.pitchUp, Math.max(-PRY.pitchDown, Math.atan2(f.y, h)));
  const yaw = h > 1e-4 ? Math.atan2(f.x, f.z) : 0;
  const c = Math.cos(pitch);
  const fwd = { x: Math.sin(yaw) * c, y: Math.sin(pitch), z: Math.cos(yaw) * c };
  // right = fwd x up (normalized); up' = right x fwd
  const rl = Math.hypot(fwd.z, fwd.x) || 1;
  const right = { x: -fwd.z / rl, y: 0, z: fwd.x / rl };
  const up = {
    x: right.y * fwd.z - right.z * fwd.y,
    y: right.z * fwd.x - right.x * fwd.z,
    z: right.x * fwd.y - right.y * fwd.x,
  };
  const base = add3(add3(head.position, scale3(fwd, PRY.spotForward)), scale3(up, PRY.spotUp));
  const l = add3(base, scale3(right, -PRY.spotSide));
  const r = add3(base, scale3(right, PRY.spotSide));
  if (!out) return { left: l, right: r };
  Object.assign(out.left, l);
  Object.assign(out.right, r);
  return out;
}
