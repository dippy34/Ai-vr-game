/** Small shared helpers for the render module (three.js side only). */

import * as THREE from 'three';
import type { Quat, Vec3 } from '../../core/types';

export const setV = (out: THREE.Vector3, v: Vec3): THREE.Vector3 => out.set(v.x, v.y, v.z);
export const setQ = (out: THREE.Quaternion, q: Quat): THREE.Quaternion => out.set(q.x, q.y, q.z, q.w);

/** Exponential smoothing factor for a rate `k` (1/s) over `dt` seconds. */
export const damp = (k: number, dt: number): number => 1 - Math.exp(-k * Math.max(0, dt));

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

let unitCapsuleGeo: THREE.BufferGeometry | null = null;
let unitCapsuleLoGeo: THREE.BufferGeometry | null = null;

/**
 * Unit capsule along Z: x,y in [-0.5, 0.5], z in [-1, 1]. Scale an instance by
 * (width, height, length / 2) to get a capsule with those full extents.
 * Shared, never disposed.
 */
export function unitCapsule(): THREE.BufferGeometry {
  if (!unitCapsuleGeo) {
    unitCapsuleGeo = new THREE.CapsuleGeometry(0.5, 1, 3, 8).rotateX(Math.PI / 2);
    unitCapsuleGeo.deleteAttribute('uv');
    unitCapsuleGeo.userData.shared = true;
  }
  return unitCapsuleGeo;
}

/** Lower-poly variant for many small parts (fingers). */
export function unitCapsuleLo(): THREE.BufferGeometry {
  if (!unitCapsuleLoGeo) {
    unitCapsuleLoGeo = new THREE.CapsuleGeometry(0.5, 1, 2, 7).rotateX(Math.PI / 2);
    unitCapsuleLoGeo.deleteAttribute('uv');
    unitCapsuleLoGeo.userData.shared = true;
  }
  return unitCapsuleLoGeo;
}

/** Give a non-indexed geometry a trivial index so it can be merged with indexed ones. */
export function ensureIndexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = new Array<number>(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(idx);
  }
  return g;
}

/** Keep only position + normal (afterimage geometry), make sure it's indexed. */
export function positionNormalOnly(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.userData = {};
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  return ensureIndexed(g);
}

/** Fill a geometry with a constant vertex color attribute. */
export function paint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Dispose all geometries and materials (not textures marked `userData.shared`) under `root`. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (mat) {
      for (const x of Array.isArray(mat) ? mat : [mat]) {
        if (x.userData.shared) continue;
        const map = (x as THREE.MeshBasicMaterial).map;
        if (map && !map.userData.shared) map.dispose();
        x.dispose();
      }
    }
  });
}

/** Axis-aligned box as plain numbers (for cheap line-of-sight tests). */
export interface Aabb {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export function aabbOf(min: Vec3, max: Vec3): Aabb {
  return { minX: min.x, minY: min.y, minZ: min.z, maxX: max.x, maxY: max.y, maxZ: max.z };
}

/**
 * Does the segment a->b pass through the box? Slab test. Ignores the first/last `pad` meters of
 * the segment so things touching a wall (a hand near a wall, a flash fired against it) still count.
 */
export function segmentHitsAabb(a: THREE.Vector3, b: THREE.Vector3, box: Aabb, pad = 0.05): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return false;
  let t0 = pad / len;
  let t1 = 1 - pad / len;
  if (t0 >= t1) return false;
  const axes: [number, number, number, number][] = [
    [a.x, dx, box.minX, box.maxX],
    [a.y, dy, box.minY, box.maxY],
    [a.z, dz, box.minZ, box.maxZ],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return false;
    } else {
      let ta = (lo - o) / d;
      let tb = (hi - o) / d;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** Ray (origin, unit dir) vs box: distance to entry, or Infinity. */
export function rayAabb(o: THREE.Vector3, d: THREE.Vector3, box: Aabb): number {
  let t0 = 0;
  let t1 = Infinity;
  const axes: [number, number, number, number][] = [
    [o.x, d.x, box.minX, box.maxX],
    [o.y, d.y, box.minY, box.maxY],
    [o.z, d.z, box.minZ, box.maxZ],
  ];
  for (const [oo, dd, lo, hi] of axes) {
    if (Math.abs(dd) < 1e-9) {
      if (oo < lo || oo > hi) return Infinity;
    } else {
      let ta = (lo - oo) / dd;
      let tb = (hi - oo) / dd;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return Infinity;
    }
  }
  return t0;
}
