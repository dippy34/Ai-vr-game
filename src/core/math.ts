/** Tiny pure vector/quaternion helpers for the engine-agnostic core. */

import type { Quat, Vec3 } from './types';

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const copy3 = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale3 = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len3 = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const dist3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** Distance on the floor plane (ignores height). */
export const distXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
});
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

export function normalize3(a: Vec3): Vec3 {
  const l = len3(a);
  return l > 1e-9 ? scale3(a, 1 / l) : v3(0, 0, -1);
}

export const identityQuat = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });

/** Quaternion for a rotation of `yaw` radians around +Y. */
export function quatFromYaw(yaw: number): Quat {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

/** Yaw (rotation around +Y) of the forward (-Z) direction of `q`. */
export function yawFromQuat(q: Quat): number {
  const f = rotate3(q, v3(0, 0, -1));
  return Math.atan2(-f.x, -f.z);
}

/** Forward unit vector (-Z) for a yaw angle. */
export function forwardFromYaw(yaw: number): Vec3 {
  return v3(-Math.sin(yaw), 0, -Math.cos(yaw));
}

/** Rotate vector `v` by unit quaternion `q`. */
export function rotate3(q: Quat, v: Vec3): Vec3 {
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** Smallest signed difference b - a between two angles, in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Small deterministic PRNG (mulberry32). Same seed -> same level on every client. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
