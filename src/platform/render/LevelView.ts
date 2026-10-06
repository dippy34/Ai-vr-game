/**
 * Static level meshes (merged per material to keep draw calls low) plus the two dynamic level
 * pieces: the fuse box lamps and the exit door.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeRng } from '../../core/math';
import type { Box, LevelData, PropStyle, Vec3, WorldState } from '../../core/types';
import {
  ceilingTexture,
  doorGlowTexture,
  fabricTexture,
  floorTexture,
  fuseBoxTexture,
  glowTexture,
  moonPatchTexture,
  shaftTexture,
  wallpaperTexture,
  windowTexture,
  woodGrainTexture,
} from './textures';
import { aabbOf, damp, disposeTree, rayAabb, unitCapsule, type Aabb } from './util';
import type { ModelLibrary } from './assets';
import { StaticBatcher } from './batch';
import { DressingSet } from './Dressing';
import { FurnitureSet } from './FurnitureModels';
import { FuseProp } from './Props';

// ---------------------------------------------------------------------------------------------
// Geometry buckets (one merged mesh per material)
// ---------------------------------------------------------------------------------------------

type UvMode = { tileU: number; tileV: number; tileTop?: number } | null;

class Bucket {
  readonly parts: THREE.BufferGeometry[] = [];
  constructor(readonly uv: UvMode) {}

  /** Add a geometry already in world space. Adds world-space UVs (if this bucket uses them) and a vertex color. */
  add(g: THREE.BufferGeometry, color: THREE.ColorRepresentation): void {
    if (g.index === null) g = indexify(g);
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (this.uv) worldUv(g, this.uv);
    else if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(g);
  }

  build(material: THREE.Material, name: string): THREE.Mesh | null {
    if (this.parts.length === 0) {
      material.dispose();
      return null;
    }
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    if (!merged) {
      material.dispose();
      return null;
    }
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

function indexify(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  g.setIndex(idx);
  return g;
}

/** Planar UVs from world position, picked by the dominant normal axis (consistent tiling across boxes). */
function worldUv(g: THREE.BufferGeometry, m: NonNullable<UvMode>): void {
  const p = g.attributes.position as THREE.BufferAttribute;
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(p.count * 2);
  const top = m.tileTop ?? m.tileU;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    let u: number, v: number;
    if (ay >= ax && ay >= az) {
      u = x / top;
      v = z / top;
    } else if (ax >= az) {
      u = z / m.tileU;
      v = y / m.tileV;
    } else {
      u = x / m.tileU;
      v = y / m.tileV;
    }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function boxGeo(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(Math.max(1e-3, x1 - x0), Math.max(1e-3, y1 - y0), Math.max(1e-3, z1 - z0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/** Normalize a hint color so its brightest channel is 1 and blend toward white (tint, not darken). */
function tintFromHint(hint: number | undefined): THREE.Color {
  const c = new THREE.Color(0xffffff);
  if (hint === undefined) return c;
  const h = new THREE.Color(hint);
  const m = Math.max(h.r, h.g, h.b, 1e-3);
  h.multiplyScalar(1 / m);
  return c.lerp(h, 0.5);
}

// ---------------------------------------------------------------------------------------------
// Furniture: built in a local frame (width along X, depth along Z, front = +Z, origin = bottom
// center), then rotated by a multiple of 90 degrees into the Box bounds.
// ---------------------------------------------------------------------------------------------

interface FurnitureCtx {
  w: number;
  d: number;
  h: number;
  rnd: () => number;
  hint: number | undefined;
  wood: Bucket;
  fabric: Bucket;
  plain: Bucket;
  /** Add a local-space box (optionally rotated around its own center: rz around Z, rx around X). */
  put(b: Bucket, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number, rz?: number, rx?: number): void;
}

const BOOK_COLORS = [0x6b2a22, 0x2c4a3a, 0x7a5a2a, 0x2a3350, 0x5a4a3a, 0x8a7a5a, 0x3a2a2a, 0x4a3a52, 0x6a5a40];

function pick<T>(rnd: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length) % arr.length];
}

function hintOr(f: FurnitureCtx, fallback: number): number {
  return f.hint ?? fallback;
}

const FURNITURE: Record<PropStyle, (f: FurnitureCtx) => void> = {
  table(f) {
    const { w, d, h } = f;
    const c = hintOr(f, 0x5a3e2a);
    const top = Math.min(0.045, h * 0.1);
    f.put(f.wood, -w / 2, h - top, -d / 2, w / 2, h, d / 2, c);
    const leg = Math.min(0.06, w * 0.12, d * 0.12);
    const ix = w / 2 - leg * 0.9, iz = d / 2 - leg * 0.9;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      f.put(f.wood, sx * ix - leg / 2, 0, sz * iz - leg / 2, sx * ix + leg / 2, h - top, sz * iz + leg / 2, darker(c, 0.85));
    }
    // Apron boards.
    const ah = Math.min(0.08, h * 0.15);
    f.put(f.wood, -ix, h - top - ah, -iz - 0.01, ix, h - top, -iz + 0.01, darker(c, 0.8));
    f.put(f.wood, -ix, h - top - ah, iz - 0.01, ix, h - top, iz + 0.01, darker(c, 0.8));
    f.put(f.wood, -ix - 0.01, h - top - ah, -iz, -ix + 0.01, h - top, iz, darker(c, 0.8));
    f.put(f.wood, ix - 0.01, h - top - ah, -iz, ix + 0.01, h - top, iz, darker(c, 0.8));
    // A forgotten plate or candle stub.
    if (f.rnd() < 0.7 && w > 0.5) {
      const px = (f.rnd() - 0.5) * (w - 0.3), pz = (f.rnd() - 0.5) * (d - 0.3);
      f.put(f.plain, px - 0.1, h, pz - 0.1, px + 0.1, h + 0.012, pz + 0.1, 0x9c968a);
      f.put(f.plain, -px * 0.5 - 0.025, h, -pz * 0.5 - 0.025, -px * 0.5 + 0.025, h + 0.09, -pz * 0.5 + 0.025, 0xb8ae90);
    }
  },

  shelf(f) {
    const { w, d, h, rnd } = f;
    const c = hintOr(f, 0x4a3324);
    const t = 0.025;
    f.put(f.wood, -w / 2, 0, -d / 2, -w / 2 + t, h, d / 2, c);
    f.put(f.wood, w / 2 - t, 0, -d / 2, w / 2, h, d / 2, c);
    f.put(f.wood, -w / 2, h - t, -d / 2, w / 2, h, d / 2, c);
    f.put(f.wood, -w / 2 + t, 0, -d / 2 + 0.02, w / 2 - t, 0.08, d / 2 - 0.01, darker(c, 0.8));
    f.put(f.wood, -w / 2 + t, 0.08, -d / 2, w / 2 - t, h - t, -d / 2 + 0.012, darker(c, 0.7));
    const levels = Math.max(1, Math.round((h - 0.15) / 0.36));
    const gap = (h - 0.08 - t) / levels;
    for (let i = 0; i <= levels; i++) {
      const y = 0.08 + i * gap;
      if (i > 0 && i < levels) f.put(f.wood, -w / 2 + t, y - 0.012, -d / 2 + 0.012, w / 2 - t, y + 0.012, d / 2, c);
      if (i === levels) break;
      // Books on this shelf.
      let x = -w / 2 + t + 0.01 + rnd() * 0.05;
      const yb = y + (i === 0 ? 0 : 0.012);
      const maxH = gap - 0.04;
      while (x < w / 2 - t - 0.05) {
        if (rnd() < 0.12) { x += 0.06 + rnd() * 0.15; continue; }
        const bw = 0.018 + rnd() * 0.03;
        const bh = Math.min(maxH, 0.15 + rnd() * 0.12);
        const bd = Math.min(d - 0.04, 0.14 + rnd() * 0.08);
        const lean = rnd() < 0.08 ? 0.28 : 0;
        const z0 = -d / 2 + 0.02;
        f.put(f.plain, x, yb, z0, x + bw, yb + bh * (lean ? 0.95 : 1), z0 + bd, pick(rnd, BOOK_COLORS), lean);
        x += bw + 0.002 + (lean ? 0.06 : 0);
      }
    }
  },

  bed(f) {
    const { w, d, h } = f;
    const c = hintOr(f, 0x4a3324);
    const frameTop = Math.min(0.32, h * 0.5);
    const matTop = Math.min(frameTop + 0.16, h * 0.8);
    // Legs + frame.
    f.put(f.wood, -w / 2, 0.08, -d / 2, w / 2, frameTop, d / 2, c);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      f.put(f.wood, sx * (w / 2 - 0.03) - 0.03, 0, sz * (d / 2 - 0.03) - 0.03, sx * (w / 2 - 0.03) + 0.03, 0.08, sz * (d / 2 - 0.03) + 0.03, darker(c, 0.8));
    }
    // Headboard at the back (-Z, against the wall).
    f.put(f.wood, -w / 2, frameTop, -d / 2, w / 2, h, -d / 2 + 0.05, darker(c, 0.9));
    f.put(f.wood, -w / 2, h - 0.05, -d / 2 - 0.0, w / 2, h, -d / 2 + 0.07, c);
    // Mattress, blanket, pillows.
    f.put(f.fabric, -w / 2 + 0.03, frameTop, -d / 2 + 0.06, w / 2 - 0.03, matTop, d / 2 - 0.02, 0xa29c90);
    const blanket = pick(f.rnd, [0x5b2c2c, 0x3b4a3a, 0x4a4560, 0x6a5a3a]);
    f.put(f.fabric, -w / 2 + 0.01, matTop - 0.12, -d / 2 + d * 0.38, w / 2 - 0.01, matTop + 0.025, d / 2, blanket);
    f.put(f.fabric, -w / 2 + 0.01, matTop - 0.02, -d / 2 + d * 0.36, w / 2 - 0.01, matTop + 0.045, -d / 2 + d * 0.42, darker(blanket, 1.15));
    const pillows = w > 1.15 ? 2 : 1;
    const pw = (w - 0.16) / pillows;
    for (let i = 0; i < pillows; i++) {
      const x0 = -w / 2 + 0.08 + i * pw;
      f.put(f.fabric, x0 + 0.02, matTop, -d / 2 + 0.08, x0 + pw - 0.02, Math.min(h - 0.01, matTop + 0.11), -d / 2 + 0.08 + 0.32, 0xb4ada0, 0, -0.18);
    }
  },

  couch(f) {
    const { w, d, h } = f;
    const c = hintOr(f, 0x3d4a3a);
    const seat = Math.min(0.42, h * 0.5);
    const arm = Math.min(0.17, w * 0.12);
    const back = Math.min(0.2, d * 0.25);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      f.put(f.wood, sx * (w / 2 - 0.06) - 0.025, 0, sz * (d / 2 - 0.06) - 0.025, sx * (w / 2 - 0.06) + 0.025, 0.09, sz * (d / 2 - 0.06) + 0.025, 0x2a1c12);
    }
    f.put(f.fabric, -w / 2, 0.09, -d / 2, w / 2, seat - 0.08, d / 2, darker(c, 0.85));
    f.put(f.fabric, -w / 2, 0.09, -d / 2, w / 2, h, -d / 2 + back, c);
    f.put(f.fabric, -w / 2, 0.09, -d / 2, -w / 2 + arm, Math.min(h, seat + 0.22), d / 2, c);
    f.put(f.fabric, w / 2 - arm, 0.09, -d / 2, w / 2, Math.min(h, seat + 0.22), d / 2, c);
    const n = w > 1.6 ? 3 : 2;
    const cw = (w - arm * 2) / n;
    for (let i = 0; i < n; i++) {
      const x0 = -w / 2 + arm + i * cw;
      f.put(f.fabric, x0 + 0.005, seat - 0.08, -d / 2 + back, x0 + cw - 0.005, seat, d / 2 - 0.01, darker(c, 1.08));
      f.put(f.fabric, x0 + 0.01, seat, -d / 2 + back - 0.02, x0 + cw - 0.01, h - 0.06, -d / 2 + back + 0.11, darker(c, 1.04), 0, -0.12);
    }
  },

  crate(f) {
    const { w, d, h } = f;
    const c = hintOr(f, 0x6e5636);
    const s = Math.min(0.045, w * 0.1, h * 0.1);
    f.put(f.wood, -w / 2 + 0.01, 0.01, -d / 2 + 0.01, w / 2 - 0.01, h - 0.01, d / 2 - 0.01, darker(c, 0.85));
    const lc = darker(c, 1.15);
    // 12 edge strips.
    for (const sy of [0, 1]) {
      const y0 = sy ? h - s : 0, y1 = sy ? h : s;
      f.put(f.wood, -w / 2, y0, -d / 2, w / 2, y1, -d / 2 + s, lc);
      f.put(f.wood, -w / 2, y0, d / 2 - s, w / 2, y1, d / 2, lc);
      f.put(f.wood, -w / 2, y0, -d / 2 + s, -w / 2 + s, y1, d / 2 - s, lc);
      f.put(f.wood, w / 2 - s, y0, -d / 2 + s, w / 2, y1, d / 2 - s, lc);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      f.put(f.wood, sx > 0 ? w / 2 - s : -w / 2, s, sz > 0 ? d / 2 - s : -d / 2, sx > 0 ? w / 2 : -w / 2 + s, h - s, sz > 0 ? d / 2 : -d / 2 + s, lc);
    }
    // Plank seams.
    const seams = Math.max(1, Math.floor(h / 0.15));
    for (let i = 1; i < seams; i++) {
      const y = (i * h) / seams;
      f.put(f.wood, -w / 2 + 0.005, y - 0.004, -d / 2 + 0.005, w / 2 - 0.005, y + 0.004, d / 2 - 0.005, darker(c, 0.6));
    }
  },

  counter(f) {
    const { w, d, h } = f;
    const c = hintOr(f, 0x7d7a68);
    const top = 0.04;
    f.put(f.plain, -w / 2 + 0.03, 0, -d / 2, w / 2 - 0.03, 0.1, d / 2 - 0.06, 0x1a1612);
    f.put(f.wood, -w / 2, 0.1, -d / 2, w / 2, h - top, d / 2 - 0.03, c);
    f.put(f.plain, -w / 2, h - top, -d / 2, w / 2, h, d / 2, 0x5a5650);
    const n = Math.max(1, Math.round(w / 0.5));
    const dw = w / n;
    for (let i = 0; i < n; i++) {
      const x0 = -w / 2 + i * dw;
      // Drawer + door fronts, knobs.
      f.put(f.wood, x0 + 0.015, h - top - 0.17, d / 2 - 0.03, x0 + dw - 0.015, h - top - 0.02, d / 2 - 0.012, darker(c, 1.1));
      f.put(f.wood, x0 + 0.015, 0.13, d / 2 - 0.03, x0 + dw - 0.015, h - top - 0.19, d / 2 - 0.012, darker(c, 1.1));
      f.put(f.plain, x0 + dw / 2 - 0.04, h - top - 0.1, d / 2 - 0.012, x0 + dw / 2 + 0.04, h - top - 0.085, d / 2, 0x8a7a50);
      f.put(f.plain, x0 + dw - 0.06, h - top - 0.3, d / 2 - 0.012, x0 + dw - 0.045, h - top - 0.24, d / 2, 0x8a7a50);
    }
    // A jar and a bottle on top.
    if (w > 0.6) {
      f.put(f.plain, -w / 2 + 0.15, h, -0.05, -w / 2 + 0.23, h + 0.13, 0.03, 0x4a5a48);
      f.put(f.plain, w / 2 - 0.22, h, -0.1, w / 2 - 0.17, h + 0.24, -0.05, 0x2d3a2a);
    }
  },

  cabinet(f) {
    const { w, d, h } = f;
    const c = hintOr(f, 0x4f3a28);
    f.put(f.wood, -w / 2, 0, -d / 2, w / 2, 0.08, d / 2 - 0.02, darker(c, 0.7));
    f.put(f.wood, -w / 2 + 0.02, 0.08, -d / 2, w / 2 - 0.02, h - 0.06, d / 2 - 0.03, c);
    f.put(f.wood, -w / 2, h - 0.06, -d / 2, w / 2, h, d / 2, darker(c, 1.1));
    const doors = w > 0.55 ? 2 : 1;
    const dw = (w - 0.06) / doors;
    for (let i = 0; i < doors; i++) {
      const x0 = -w / 2 + 0.03 + i * dw;
      f.put(f.wood, x0 + 0.006, 0.11, d / 2 - 0.03, x0 + dw - 0.006, h - 0.09, d / 2 - 0.012, darker(c, 1.12));
      f.put(f.wood, x0 + 0.05, 0.2, d / 2 - 0.012, x0 + dw - 0.05, h - 0.18, d / 2 - 0.004, darker(c, 0.95));
      const kx = i === 0 && doors === 2 ? x0 + dw - 0.04 : x0 + 0.03;
      f.put(f.plain, kx - 0.008, h * 0.5 - 0.03, d / 2 - 0.004, kx + 0.008, h * 0.5 + 0.03, d / 2 + 0.0, 0x8a7a50);
    }
  },

  piano(f) {
    const { w, d, h } = f;
    const c = hintOr(f, 0x1a1411);
    const keysY = Math.min(0.72, h * 0.6);
    const caseD = Math.min(d * 0.55, 0.35);
    const z0 = -d / 2;
    // Upright case + lid.
    f.put(f.wood, -w / 2 + 0.01, 0, z0, w / 2 - 0.01, h - 0.03, z0 + caseD, c);
    f.put(f.wood, -w / 2, h - 0.03, z0, w / 2, h, z0 + caseD + 0.02, darker(c, 1.3));
    // Cheeks (side arms) to the front + keybed.
    f.put(f.wood, -w / 2, 0.0, z0, -w / 2 + 0.05, keysY + 0.08, d / 2, c);
    f.put(f.wood, w / 2 - 0.05, 0.0, z0, w / 2, keysY + 0.08, d / 2, c);
    f.put(f.wood, -w / 2 + 0.05, keysY - 0.06, z0 + caseD, w / 2 - 0.05, keysY, d / 2, darker(c, 1.2));
    // Keys.
    f.put(f.plain, -w / 2 + 0.06, keysY, d / 2 - 0.15, w / 2 - 0.06, keysY + 0.022, d / 2 - 0.005, 0xd2c9b0);
    const kw = 0.0235;
    const nWhite = Math.floor((w - 0.12) / kw);
    const x0 = -(nWhite * kw) / 2;
    for (let i = 0; i < nWhite - 1; i++) {
      const pos = i % 7;
      if (pos === 2 || pos === 6) continue;
      const x = x0 + (i + 1) * kw;
      f.put(f.plain, x - 0.006, keysY + 0.022, d / 2 - 0.15, x + 0.006, keysY + 0.034, d / 2 - 0.06, 0x0e0c0b);
    }
    // Fallboard + music rest.
    f.put(f.wood, -w / 2 + 0.05, keysY + 0.02, z0 + caseD, w / 2 - 0.05, keysY + 0.14, z0 + caseD + 0.04, darker(c, 1.15));
    f.put(f.wood, -w / 2 + 0.2, keysY + 0.14, z0 + caseD, w / 2 - 0.2, keysY + 0.32, z0 + caseD + 0.015, darker(c, 1.25), 0, 0.12);
    // Lower panel, pedals.
    f.put(f.wood, -w / 2 + 0.05, 0.06, z0 + caseD, w / 2 - 0.05, keysY - 0.12, z0 + caseD + 0.02, darker(c, 1.15));
    for (const px of [-0.06, 0, 0.06]) f.put(f.plain, px - 0.012, 0.04, z0 + caseD, px + 0.012, 0.055, z0 + caseD + 0.1, 0x8a7a50);
    // Candle holder sconces (a nice silhouette in the flash).
    for (const sx of [-1, 1]) f.put(f.plain, sx * (w / 2 - 0.12) - 0.012, keysY + 0.32, z0 + caseD, sx * (w / 2 - 0.12) + 0.012, keysY + 0.4, z0 + caseD + 0.05, 0x8a7a50);
  },
};

function darker(c: number, k: number): number {
  const col = new THREE.Color(c).multiplyScalar(k);
  col.r = Math.min(1, col.r); col.g = Math.min(1, col.g); col.b = Math.min(1, col.b);
  return col.getHex();
}

// ---------------------------------------------------------------------------------------------
// Level helpers
// ---------------------------------------------------------------------------------------------


/** Distance from a furniture box's side (in direction dir) to the nearest wall in that direction. */
function wallGap(b: Box, dir: [number, number], walls: Box[]): number {
  let best = Infinity;
  for (const w of walls) {
    if (w.max.y < 0.3 || w.min.y > 1.0) continue;
    if (dir[0] !== 0) {
      if (w.max.z < b.min.z + 0.05 || w.min.z > b.max.z - 0.05) continue;
      const gap = dir[0] > 0 ? w.min.x - b.max.x : b.min.x - w.max.x;
      if (gap > -0.05 && gap < best) best = gap;
    } else {
      if (w.max.x < b.min.x + 0.05 || w.min.x > b.max.x - 0.05) continue;
      const gap = dir[1] > 0 ? w.min.z - b.max.z : b.min.z - w.max.z;
      if (gap > -0.05 && gap < best) best = gap;
    }
  }
  return best;
}

/** Yaw that maps local +Z (front) to the given world direction. */
const yawFor = (dir: [number, number]): number => Math.atan2(dir[0], dir[1]);

/** Which way a furniture box faces and its size in its own frame (front = local +Z). */
function furnitureFrame(b: Box, walls: Box[]): { yaw: number; w: number; d: number; h: number } {
  const style: PropStyle = b.style ?? 'crate';
  const sx = b.max.x - b.min.x, sz = b.max.z - b.min.z, sy = b.max.y - b.min.y;
  const longX = sx >= sz;
  // Which side faces a wall? Beds put their head along the long axis, couches/shelves etc. their back
  // along the short axis. Tables and crates don't care.
  let candidates: [number, number][];
  if (style === 'bed') candidates = longX ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
  else candidates = longX ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
  let back = candidates[0];
  let bestGap = Infinity;
  for (const dir of candidates) {
    const g = wallGap(b, dir, walls);
    if (g < bestGap) { bestGap = g; back = dir; }
  }
  if (bestGap === Infinity) {
    // No wall: back toward the nearest level edge would be ideal; just pick the first.
    back = candidates[0];
  }
  const front: [number, number] = [-back[0], -back[1]];
  const yaw = yawFor(front);
  const alongX = Math.abs(front[0]) > 0; // front along X => local width is world Z
  const w = alongX ? sz : sx;
  const d = alongX ? sx : sz;
  return { yaw, w, d, h: sy };
}

function buildFurniture(b: Box, walls: Box[], buckets: { wood: Bucket; fabric: Bucket; plain: Bucket }): void {
  const style: PropStyle = b.style ?? 'crate';
  const sy = b.max.y - b.min.y;
  const { yaw, w, d } = furnitureFrame(b, walls);
  const m = new THREE.Matrix4()
    .makeTranslation((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2)
    .multiply(new THREE.Matrix4().makeRotationY(yaw));
  const seed = Math.floor(b.min.x * 73.1 + b.min.z * 191.7 + sy * 37) | 0;
  const rnd = makeRng(seed);
  const tmp = new THREE.Matrix4();
  const f: FurnitureCtx = {
    w, d, h: sy, rnd, hint: b.color,
    ...buckets,
    put(bucket, x0, y0, z0, x1, y1, z1, color, rz = 0, rx = 0) {
      const g = boxGeo(x0, y0, z0, x1, y1, z1);
      if (rz || rx) {
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
        g.translate(-cx, -cy, -cz);
        if (rz) g.rotateZ(rz);
        if (rx) g.rotateX(rx);
        g.translate(cx, cy, cz);
      }
      g.applyMatrix4(tmp.copy(m));
      bucket.add(g, color);
    },
  };
  FURNITURE[style](f);
}

function insideAny(boxes: Box[], p: Vec3, eps = 0): boolean {
  for (const b of boxes) {
    if (p.x >= b.min.x - eps && p.x <= b.max.x + eps && p.y >= b.min.y - eps && p.y <= b.max.y + eps && p.z >= b.min.z - eps && p.z <= b.max.z + eps) return true;
  }
  return false;
}

function overFloor(floors: Box[], x: number, z: number): boolean {
  for (const b of floors) if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Fuse box
// ---------------------------------------------------------------------------------------------

const _lampC = new THREE.Color();
const _lampM = new THREE.Matrix4();
const LAMP_OFF = new THREE.Color(0x4a0808);
const LAMP_ON = new THREE.Color(0x5cff7e);
const HALO_FACING_NEG_Z = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const _one = new THREE.Vector3(1, 1, 1);

/** fusebox.glb parts the view drives (everything else is merged into the static batch). */
interface FuseBoxModel {
  lamps: { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; pos: THREE.Vector3 }[];
  /** One fuse per slot, shown once that many fuses are in. */
  fuses: THREE.Object3D[];
  props: FuseProp[];
}

class FuseBoxView {
  readonly group = new THREE.Group();
  /** World point at the center of the box's back, on the wall. */
  readonly mount: THREE.Vector3;
  private slots: THREE.InstancedMesh | null = null;
  private lamps: THREE.InstancedMesh | null = null;
  private halos: THREE.InstancedMesh | null = null;
  private fuses: THREE.InstancedMesh | null = null;
  private model: FuseBoxModel | null = null;
  private required = -1;
  private inserted = -1;
  private litAt: number[] = [];
  private readonly lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
  private readonly haloMat = new THREE.MeshBasicMaterial({
    map: glowTexture(), color: 0x5cff7e, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  private readonly slotMat = new THREE.MeshLambertMaterial({ color: 0x141414 });
  private readonly fuseMat = new THREE.MeshBasicMaterial({ color: 0x8a5a22 });

  constructor(level: LevelData, wallBoxes: Aabb[], metal: Bucket, models: ModelLibrary | null, batcher: StaticBatcher) {
    const fb = level.fuseBox;
    const fwd = new THREE.Vector3(-Math.sin(fb.yaw), 0, -Math.cos(fb.yaw));
    // Mount on the wall behind `position` if there is one close by.
    const o = new THREE.Vector3(fb.position.x, fb.position.y, fb.position.z);
    const back = fwd.clone().negate();
    let t = Infinity;
    for (const w of wallBoxes) t = Math.min(t, rayAabb(o, back, w));
    const mount = t < 0.6 ? o.clone().addScaledVector(back, t) : o.clone();
    this.mount = mount;
    this.group.position.copy(mount);
    if (models?.has('fusebox')) {
      // fusebox.glb: origin = center of the back face, faces -Z (= the level's facing yaw).
      this.group.rotation.y = fb.yaw;
      this.group.updateMatrixWorld(true);
      this.model = this.buildModel(models, batcher);
      return;
    }
    this.group.rotation.y = fb.yaw + Math.PI; // local +Z = facing direction
    this.group.updateMatrixWorld(true);
    // Body (merged into the static metal bucket) + conduit pipe going up.
    const m = this.group.matrixWorld;
    const body = boxGeo(-0.17, -0.22, 0, 0.17, 0.22, 0.1).applyMatrix4(m);
    metal.add(body, 0x6a6d70);
    metal.add(boxGeo(-0.185, -0.235, 0, 0.185, 0.235, 0.012).applyMatrix4(m), 0x3c3e40);
    metal.add(boxGeo(0.09, 0.22, 0.02, 0.13, 1.6, 0.06).applyMatrix4(m), 0x4c4e50);
    metal.add(boxGeo(-0.05, -0.32, 0.03, 0.05, -0.22, 0.08).applyMatrix4(m), 0x4c4e50);
    // Front plate with the stenciled label.
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.32, 0.42),
      new THREE.MeshLambertMaterial({ map: fuseBoxTexture() }),
    );
    plate.position.z = 0.1011;
    this.group.add(plate);
  }

  private buildModel(models: ModelLibrary, batcher: StaticBatcher): FuseBoxModel {
    const inst = models.instance('fusebox')!;
    const byIndex = (prefix: string): THREE.Object3D[] => {
      const out: THREE.Object3D[] = [];
      for (let i = 0; ; i++) {
        const n = inst.getObjectByName(`${prefix}${i}`);
        if (!n) break;
        out.push(n);
      }
      return out;
    };
    const lampNodes = byIndex('lamp_');
    const slotNodes = byIndex('slot_');
    const isLamp = (m: THREE.Object3D): boolean => lampNodes.some((l) => l === m || l.getObjectById(m.id) !== undefined);
    // Static parts (body, door, lever) -> one merged mesh per material in the level batch.
    batcher.add(inst, this.group.matrixWorld, '', (m) => !isLamp(m));
    // The instance root is never parented, so its "world" space is the model = group-local space.
    inst.updateMatrixWorld(true);
    const lamps: FuseBoxModel['lamps'] = [];
    for (const node of lampNodes) {
      const mesh = (node as THREE.Mesh).isMesh ? (node as THREE.Mesh) : (node.getObjectByProperty('isMesh', true) as THREE.Mesh | undefined);
      if (!mesh) continue;
      const src = mesh.material as THREE.Material;
      const mat = src instanceof THREE.MeshStandardMaterial ? src.clone() : new THREE.MeshStandardMaterial({ roughness: 0.15 });
      mat.userData = {};
      mat.fog = false;
      mesh.material = mat;
      // Lamp position in the group frame (for the glow halo).
      const pos = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
      const geo = mesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      pos.z += geo.boundingBox!.min.z - 0.004;
      lamps.push({ mesh, mat, pos });
    }
    // Keep only the lamps (+ slot markers) live; everything else is in the batch.
    const live = new THREE.Group();
    live.name = 'fusebox-live';
    for (const l of lamps) {
      const m = l.mesh.matrixWorld.clone();
      l.mesh.removeFromParent();
      m.decompose(l.mesh.position, l.mesh.quaternion, l.mesh.scale);
      live.add(l.mesh);
    }
    // A fuse model in every slot (hidden until inserted). Slots are vertical, like fuse.glb.
    const fuses: THREE.Object3D[] = [];
    const props: FuseProp[] = [];
    for (const slot of slotNodes) {
      const prop = new FuseProp(models.has('fuse') ? models : null);
      const holder = new THREE.Group();
      slot.matrixWorld.decompose(holder.position, holder.quaternion, holder.scale);
      // The procedural fuse lies along X: stand it up.
      if (!prop.modelled) prop.group.rotation.z = Math.PI / 2;
      // Powered fuses glow faintly warm.
      prop.setGlint(0.95);
      holder.add(prop.group);
      holder.visible = false;
      live.add(holder);
      fuses.push(holder);
      props.push(prop);
    }
    this.group.add(live);
    const n = Math.max(1, lamps.length);
    this.halos = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.09, 0.09), this.haloMat, n);
    this.halos.count = 0;
    this.halos.frustumCulled = false;
    this.group.add(this.halos);
    return { lamps, fuses, props };
  }

  update(required: number, inserted: number, time: number): void {
    if (this.model) {
      this.updateModel(required, inserted, time);
      return;
    }
    if (required !== this.required) this.rebuild(required);
    const n = this.required;
    if (inserted !== this.inserted) {
      for (let i = 0; i < n; i++) {
        if (i < inserted && !(this.litAt[i] >= 0)) this.litAt[i] = time;
        if (i >= inserted) this.litAt[i] = -1;
      }
      this.inserted = inserted;
      if (this.fuses) this.fuses.count = Math.min(n, inserted);
    }
    if (!this.lamps || !this.halos) return;
    const c = _lampC;
    let lit = 0;
    const mtx = _lampM;
    for (let i = 0; i < n; i++) {
      const on = i < inserted;
      let k = on ? 1 : 0;
      if (on) {
        const age = time - this.litAt[i];
        // Flicker on for a moment, like an old bulb catching.
        if (age < 0.5) k = Math.sin(age * 70) > 0.1 ? 1 : 0.15;
        mtx.makeTranslation(this.lampX(i), 0.03, 0.125);
        this.halos.setMatrixAt(lit++, mtx);
      }
      c.copy(LAMP_OFF).lerp(LAMP_ON, k);
      this.lamps.setColorAt(i, c);
    }
    this.halos.count = lit;
    this.halos.instanceMatrix.needsUpdate = true;
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }

  private updateModel(required: number, inserted: number, time: number): void {
    const model = this.model!;
    const n = model.lamps.length;
    if (required !== this.required || inserted !== this.inserted) {
      if (required !== this.required) this.litAt = new Array(n).fill(-1);
      this.required = required;
      for (let i = 0; i < n; i++) {
        if (i < inserted && !(this.litAt[i] >= 0)) this.litAt[i] = time;
        if (i >= inserted) this.litAt[i] = -1;
      }
      this.inserted = inserted;
      model.fuses.forEach((f, i) => (f.visible = i < inserted));
    }
    const halos = this.halos!;
    let lit = 0;
    for (let i = 0; i < n; i++) {
      const l = model.lamps[i];
      // Lamps beyond the fuses this round needs stay dark.
      l.mesh.visible = true;
      const on = i < inserted;
      let k = on ? 1 : 0;
      if (on) {
        const age = time - this.litAt[i];
        if (age < 0.5) k = Math.sin(age * 70) > 0.1 ? 1 : 0.15;
        _lampM.compose(l.pos, HALO_FACING_NEG_Z, _one);
        halos.setMatrixAt(lit++, _lampM);
      }
      _lampC.copy(LAMP_OFF).lerp(LAMP_ON, k);
      // Self-lit like an indicator bulb; the dark base keeps a glossy glass look under the flash.
      l.mat.emissive.copy(_lampC);
      l.mat.color.copy(_lampC).multiplyScalar(0.25);
    }
    halos.count = lit;
    halos.instanceMatrix.needsUpdate = true;
  }

  private lampX(i: number): number {
    const n = Math.max(1, this.required);
    const spacing = Math.min(0.075, 0.28 / n);
    return (i - (n - 1) / 2) * spacing;
  }

  private rebuild(required: number): void {
    for (const m of [this.slots, this.lamps, this.halos, this.fuses]) {
      if (!m) continue;
      this.group.remove(m);
      if (!m.geometry.userData.shared) m.geometry.dispose();
      m.dispose();
    }
    this.required = Math.max(0, required | 0);
    this.inserted = -1;
    this.litAt = new Array(this.required).fill(-1);
    const n = Math.max(1, this.required);
    const mtx = new THREE.Matrix4();
    this.slots = new THREE.InstancedMesh(new THREE.BoxGeometry(0.04, 0.11, 0.014), this.slotMat, n);
    this.lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.012, 10, 8), this.lampMat, n);
    this.halos = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.09, 0.09), this.haloMat, n);
    this.fuses = new THREE.InstancedMesh(unitCapsule(), this.fuseMat, n);
    const s = new THREE.Vector3(0.022, 0.022, 0.045);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    for (let i = 0; i < n; i++) {
      const x = this.lampX(i);
      this.slots.setMatrixAt(i, mtx.makeTranslation(x, -0.09, 0.107));
      this.lamps.setMatrixAt(i, mtx.makeTranslation(x, 0.03, 0.108));
      this.lamps.setColorAt(i, LAMP_OFF);
      this.fuses.setMatrixAt(i, mtx.compose(new THREE.Vector3(x, -0.09, 0.118), q, s));
    }
    this.slots.count = this.lamps.count = this.required;
    this.halos.count = 0;
    this.fuses.count = 0;
    for (const m of [this.slots, this.lamps, this.halos, this.fuses]) {
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  dispose(): void {
    this.lampMat.dispose();
    this.haloMat.dispose();
    this.slotMat.dispose();
    this.fuseMat.dispose();
    if (this.model) {
      for (const l of this.model.lamps) l.mat.dispose();
      for (const p of this.model.props) p.dispose();
    }
    if (this.halos && this.model) {
      this.halos.geometry.dispose();
      this.halos.dispose();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Exit door
// ---------------------------------------------------------------------------------------------

const _doorQ = new THREE.Quaternion();
const _doorAxis = new THREE.Vector3(0, 1, 0);
/** How far the Blender door swings open (into the house; more would hit the casing). */
const MODEL_DOOR_OPEN = THREE.MathUtils.degToRad(95);

class DoorView {
  readonly group = new THREE.Group();
  readonly box: Aabb;
  private readonly pivot = new THREE.Group();
  private readonly glow: THREE.Mesh;
  private readonly spill: THREE.Mesh;
  private readonly glowMat: THREE.MeshBasicMaterial;
  private readonly spillMat: THREE.MeshBasicMaterial;
  private readonly openSign: number;
  /** door.glb's leaf (origin on the hinge axis), or null for the procedural door. */
  private leaf: THREE.Object3D | null = null;
  private readonly leafRest = new THREE.Quaternion();
  private open = 0;
  private glowK = 0;

  constructor(level: LevelData, trim: Bucket, models: ModelLibrary | null = null, batcher: StaticBatcher | null = null) {
    const door = level.exit.door;
    this.box = aabbOf(door.min, door.max);
    const sx = door.max.x - door.min.x, sz = door.max.z - door.min.z, h = door.max.y - door.min.y;
    const wideX = sx >= sz;
    const width = wideX ? sx : sz;
    const thick = wideX ? sz : sx;
    const cx = (door.min.x + door.max.x) / 2, cz = (door.min.z + door.max.z) / 2;
    const zone = level.exit.zone;
    const zc = wideX ? (zone.min.z + zone.max.z) / 2 - cz : (zone.min.x + zone.max.x) / 2 - cx;
    const outSign = zc >= 0 ? 1 : -1;
    const out = wideX ? new THREE.Vector3(0, 0, outSign) : new THREE.Vector3(outSign, 0, 0);
    const localOut = wideX ? outSign : -outSign;
    this.openSign = -localOut;

    if (models?.has('door') && batcher) {
      this.buildModel(models, batcher, new THREE.Vector3(cx, door.min.y, cz), out, width, h, thick);
    } else {
      // Pivot at the hinge edge; local +X runs along the door, local Z across it.
      if (wideX) this.pivot.position.set(door.min.x, door.min.y, cz);
      else this.pivot.position.set(cx, door.min.y, door.min.z);
      this.pivot.rotation.y = wideX ? 0 : -Math.PI / 2;
      this.group.add(this.pivot);
      this.buildProcedural(trim, door, wideX, width, thick, h, cx, cz);
    }

    // Cold glow beyond the doorway + light spilling onto the floor inside.
    this.glowMat = new THREE.MeshBasicMaterial({
      map: doorGlowTexture(), color: 0x9fb6e4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(width * 1.05, h), this.glowMat);
    this.glow.position.set(cx, door.min.y + h / 2, cz).addScaledVector(out, thick / 2 + 0.06);
    this.glow.lookAt(this.glow.position.clone().sub(out));
    this.glow.visible = false;
    this.group.add(this.glow);
    this.spillMat = new THREE.MeshBasicMaterial({
      map: shaftTexture(), color: 0x7f97c4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    // Floor quad inside the room, v = 0 (bright) at the door, v = 1 fading 1.8 m into the room.
    const spillLen = 1.8;
    const side = wideX ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const base = new THREE.Vector3(cx, door.min.y + 0.006, cz).addScaledVector(out, -thick / 2);
    const far = base.clone().addScaledVector(out, -spillLen);
    const hw = width * 0.6;
    const sp = [
      base.clone().addScaledVector(side, -hw), base.clone().addScaledVector(side, hw),
      far.clone().addScaledVector(side, hw), far.clone().addScaledVector(side, -hw),
    ];
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp.flatMap((p) => [p.x, p.y, p.z]), 3));
    sg.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    sg.setIndex([0, 1, 2, 0, 2, 3]);
    sg.computeBoundingSphere();
    this.spill = new THREE.Mesh(sg, this.spillMat);
    this.spillMat.side = THREE.DoubleSide;
    this.spill.visible = false;
    this.group.add(this.spill);
  }

  /** door.glb: the frame is merged into the static batch; the leaf swings on its hinge-edge origin. */
  private buildModel(models: ModelLibrary, batcher: StaticBatcher, base: THREE.Vector3, out: THREE.Vector3, width: number, h: number, thick: number): void {
    const inst = models.instance('door')!;
    const op = models.get('door')!.extras.opening;
    const [ow, oh, od] = Array.isArray(op) && op.length === 3 && op.every((v) => typeof v === 'number' && v > 0) ? (op as number[]) : [1.2, 2.4, 0.2];
    // Model -Z faces into the house, so model +Z points outside.
    const root = new THREE.Group();
    root.name = 'door-model';
    root.position.copy(base);
    root.rotation.y = Math.atan2(out.x, out.z);
    root.scale.set(width / ow, h / oh, thick / od);
    root.updateMatrixWorld(true);
    const leaf = inst.getObjectByName('door_leaf');
    const underLeaf = (m: THREE.Object3D): boolean => !!leaf && (m === leaf || leaf.getObjectById(m.id) !== undefined);
    batcher.add(inst, root.matrixWorld, '', (m) => !underLeaf(m));
    if (leaf) {
      leaf.removeFromParent();
      root.add(leaf);
      this.leaf = leaf;
      this.leafRest.copy(leaf.quaternion);
    }
    this.group.add(root);
  }

  private buildProcedural(trim: Bucket, door: Box, wideX: boolean, width: number, thick: number, h: number, cx: number, cz: number): void {
    const t = Math.min(0.05, thick);
    // Panel: slab + raised panels on both faces + knobs, vertex colored, one mesh.
    const parts: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, col: number): void => {
      g.deleteAttribute('uv');
      parts.push(paintGeo(g, col));
    };
    const pw = width - 0.01;
    add(boxGeo(0.005, 0.005, -t / 2, pw, h - 0.008, t / 2), 0x3a271a);
    for (const side of [-1, 1]) {
      const z0 = side > 0 ? t / 2 : -t / 2 - 0.008;
      const z1 = side > 0 ? t / 2 + 0.008 : -t / 2;
      for (const [y0, y1] of [[0.12, h * 0.42], [h * 0.48, h - 0.12]]) {
        add(boxGeo(0.1, y0, z0, pw / 2 - 0.04, y1, z1), 0x4a3424);
        add(boxGeo(pw / 2 + 0.04, y0, z0, pw - 0.1, y1, z1), 0x4a3424);
      }
      const kz0 = side > 0 ? t / 2 : -t / 2 - 0.045;
      add(boxGeo(pw - 0.11, 0.97, kz0, pw - 0.06, 1.03, kz0 + 0.045), 0x8a7440);
    }
    const panelGeo = mergeGeometries(parts, false)!;
    for (const p of parts) p.dispose();
    const panel = new THREE.Mesh(
      panelGeo,
      new THREE.MeshLambertMaterial({ map: woodGrainTexture(), vertexColors: true }),
    );
    // Planar UVs for the grain (door-local).
    const pos = panelGeo.attributes.position as THREE.BufferAttribute;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getY(i); uv[i * 2 + 1] = pos.getX(i) * 0.5 + pos.getZ(i); }
    panelGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.pivot.add(panel);

    // Casing around the opening (static trim, both faces).
    const thickFull = thick + 0.02;
    const cw = 0.07;
    if (wideX) {
      const z0 = cz - thickFull / 2, z1 = cz + thickFull / 2;
      trim.add(boxGeo(door.min.x - cw, door.min.y, z0, door.min.x, door.max.y + cw, z1), 0x2e2016);
      trim.add(boxGeo(door.max.x, door.min.y, z0, door.max.x + cw, door.max.y + cw, z1), 0x2e2016);
      trim.add(boxGeo(door.min.x, door.max.y, z0, door.max.x, door.max.y + cw, z1), 0x2e2016);
    } else {
      const x0 = cx - thickFull / 2, x1 = cx + thickFull / 2;
      trim.add(boxGeo(x0, door.min.y, door.min.z - cw, x1, door.max.y + cw, door.min.z), 0x2e2016);
      trim.add(boxGeo(x0, door.min.y, door.max.z, x1, door.max.y + cw, door.max.z + cw), 0x2e2016);
      trim.add(boxGeo(x0, door.max.y, door.min.z, x1, door.max.y + cw, door.max.z), 0x2e2016);
    }
  }

  update(exitOpen: boolean, dt: number): void {
    const target = exitOpen ? 1 : 0;
    // Heavy door: slow start, settles.
    this.open += (target - this.open) * damp(exitOpen ? 1.6 : 4, dt);
    if (this.leaf) {
      // door.glb: rotation.y = +angle swings the leaf into the house.
      this.leaf.quaternion.copy(this.leafRest).multiply(_doorQ.setFromAxisAngle(_doorAxis, this.open * MODEL_DOOR_OPEN));
    } else {
      const a = this.open * THREE.MathUtils.degToRad(105);
      this.pivot.children[0].rotation.y = this.openSign * a;
    }
    this.glowK += ((exitOpen ? 1 : 0) - this.glowK) * damp(0.9, dt);
    const k = this.glowK;
    this.glow.visible = this.spill.visible = k > 0.01;
    this.glowMat.opacity = 0.42 * k;
    this.spillMat.opacity = 0.35 * k;
  }

  dispose(): void {
    this.glowMat.dispose();
    this.spillMat.dispose();
  }
}

function paintGeo(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

// ---------------------------------------------------------------------------------------------
// LevelView
// ---------------------------------------------------------------------------------------------

export class LevelView {
  readonly group = new THREE.Group();
  /** Wall boxes for line-of-sight tests (flash afterimages). */
  readonly walls: Aabb[] = [];
  private readonly fuseBox: FuseBoxView;
  private readonly door: DoorView;
  private exitOpen = false;

  /** Blender furniture placed into the level (null = all procedural). */
  private readonly furnitureModels: FurnitureSet | null;
  /** Set dressing scattered through the house (null = no dressing models). */
  readonly dressing: DressingSet | null;

  constructor(level: LevelData, models: ModelLibrary | null = null) {
    this.group.name = 'level';
    // Every static Blender model (furniture, dressing, fuse box body, door frame) merges here.
    const batcher = new StaticBatcher();
    this.furnitureModels = models ? new FurnitureSet(models, batcher) : null;
    const wallBoxes = level.boxes.filter((b) => b.kind === 'wall');
    const floorBoxes = level.boxes.filter((b) => b.kind === 'floor');
    for (const w of wallBoxes) this.walls.push(aabbOf(w.min, w.max));

    const walls = new Bucket({ tileU: 2, tileV: 2.7 });
    const floors = new Bucket({ tileU: 2, tileV: 2, tileTop: 2 });
    const ceilings = new Bucket({ tileU: 2, tileV: 2, tileTop: 2 });
    const wood = new Bucket({ tileU: 1, tileV: 1, tileTop: 1 });
    const fabric = new Bucket({ tileU: 0.5, tileV: 0.5, tileTop: 0.5 });
    const plain = new Bucket(null);
    const panes = new Bucket(null);

    for (const b of level.boxes) {
      const g = boxGeo(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z);
      switch (b.kind) {
        case 'wall':
          walls.add(g, tintFromHint(b.color));
          if (b.min.y < 0.05) {
            // Baseboard all around the wall box.
            const e = 0.014;
            wood.add(boxGeo(b.min.x - e, b.min.y, b.min.z - e, b.max.x + e, b.min.y + 0.13, b.max.z + e), 0x2a1d14);
          }
          break;
        case 'floor':
          floors.add(g, tintFromHint(b.color));
          break;
        case 'ceiling':
          ceilings.add(g, tintFromHint(b.color));
          break;
        case 'furniture': {
          g.dispose();
          const fm = this.furnitureModels;
          if (fm?.covers(b.style)) {
            const f = furnitureFrame(b, wallBoxes);
            const center = new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
            const seed = Math.floor(b.min.x * 73.1 + b.min.z * 191.7) | 0;
            // GLB fronts face -Z, the procedural frame's front is +Z: turn half a circle.
            if (fm.place(b, { center, yaw: f.yaw + Math.PI, w: f.w, h: f.h, d: f.d }, seed)) break;
          }
          buildFurniture(b, wallBoxes, { wood, fabric, plain });
          break;
        }
      }
    }

    // Fuse box and door add to the static buckets / batch, so build them before merging.
    this.fuseBox = new FuseBoxView(level, this.walls, plain, models, batcher);
    this.door = new DoorView(level, wood, models, batcher);
    this.group.add(this.fuseBox.group, this.door.group);

    // Set dressing (decides which windows get boarded up before the moonlight is built).
    this.dressing = models ? new DressingSet(models, batcher) : null;
    if (this.dressing?.available) {
      this.dressing.scatter({
        level,
        walls: wallBoxes,
        furniture: level.boxes.filter((b) => b.kind === 'furniture'),
        placed: this.furnitureModels?.placed ?? [],
        fuseBoxMount: this.fuseBox.mount,
      });
    }
    const boarded = this.dressing?.boarded ?? new Set<number>();

    // Windows: pane + frame + mullions + sill, and a cheap additive moonlight shaft + floor patch.
    const shaftPos: number[] = [], shaftUv: number[] = [], shaftIdx: number[] = [], shaftCol: number[] = [];
    const patchPos: number[] = [], patchUv: number[] = [], patchIdx: number[] = [], patchCol: number[] = [];
    const isInside = (x: number, z: number): boolean => {
      const bd = level.bounds;
      if (x < bd.min.x || x > bd.max.x || z < bd.min.z || z > bd.max.z) return false;
      if (floorBoxes.length && !overFloor(floorBoxes, x, z)) return false;
      return !insideAny(wallBoxes, { x, y: 1, z });
    };
    const elev = THREE.MathUtils.degToRad(38);
    for (const [wi, win] of level.windows.entries()) {
      // Boarded windows only leak a little light between the planks.
      const light = boarded.has(wi) ? 0.3 : 1;
      const f = new THREE.Vector3(-Math.sin(win.yaw), 0, -Math.cos(win.yaw));
      const n = Math.abs(f.x) > Math.abs(f.z) ? new THREE.Vector3(Math.sign(f.x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(f.z));
      const c = new THREE.Vector3(win.center.x, win.center.y, win.center.z);
      const inA = isInside(c.x + n.x * 0.6, c.z + n.z * 0.6);
      const inB = isInside(c.x - n.x * 0.6, c.z - n.z * 0.6);
      const inward = !inA && inB ? n.clone().negate() : n.clone();
      // Put the pane on the inner face of the wall if the window is painted onto a solid wall.
      const host = wallBoxes.find((b) => insideAny([b], win.center, 0.02));
      const pane = c.clone();
      if (host) {
        if (inward.x > 0) pane.x = host.max.x;
        else if (inward.x < 0) pane.x = host.min.x;
        else if (inward.z > 0) pane.z = host.max.z;
        else pane.z = host.min.z;
      }
      pane.addScaledVector(inward, 0.004);
      const yaw = Math.atan2(inward.x, inward.z);
      const m = new THREE.Matrix4().makeTranslation(pane.x, pane.y, pane.z).multiply(new THREE.Matrix4().makeRotationY(yaw));
      const W = win.width, H = win.height, fw = 0.065;
      const trim = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col = 0x2c1f16): void => {
        wood.add(boxGeo(x0, y0, z0, x1, y1, z1).applyMatrix4(m), col);
      };
      trim(-W / 2 - fw, -H / 2 - fw, -0.02, -W / 2, H / 2 + fw, 0.035);
      trim(W / 2, -H / 2 - fw, -0.02, W / 2 + fw, H / 2 + fw, 0.035);
      trim(-W / 2, H / 2, -0.02, W / 2, H / 2 + fw, 0.035);
      trim(-W / 2 - fw - 0.04, -H / 2 - fw - 0.03, -0.02, W / 2 + fw + 0.04, -H / 2, 0.09, 0x33241a);
      trim(-0.014, -H / 2, -0.01, 0.014, H / 2, 0.02, 0x1c140e);
      trim(-W / 2, -0.014, -0.01, W / 2, 0.014, 0.02, 0x1c140e);
      const pg = new THREE.PlaneGeometry(W, H).applyMatrix4(m);
      panes.add(pg, 0xffffff);

      // Shaft: extrude the pane rectangle along the moonlight direction down to the floor.
      const d = inward.clone().multiplyScalar(Math.cos(elev)).add(new THREE.Vector3(0, -Math.sin(elev), 0));
      const corner = (sx: number, sy: number): THREE.Vector3 => new THREE.Vector3(sx * W / 2 * 0.92, sy * H / 2 * 0.92, 0.01).applyMatrix4(m);
      const toFloor = (p: THREE.Vector3): THREE.Vector3 => p.clone().addScaledVector(d, Math.max(0, p.y - 0.01) / Math.sin(elev));
      const tl = corner(-1, 1), tr = corner(1, 1), bl = corner(-1, -1), br = corner(1, -1);
      const ftl = toFloor(tl), ftr = toFloor(tr), fbl = toFloor(bl), fbr = toFloor(br);
      const quad = (pos: number[], uvs: number[], idx: number[], a: THREE.Vector3, b: THREE.Vector3, cc: THREE.Vector3, dd: THREE.Vector3, ua: number[]): void => {
        const base = pos.length / 3;
        const col = pos === shaftPos ? shaftCol : patchCol;
        for (const p of [a, b, cc, dd]) {
          pos.push(p.x, p.y, p.z);
          col.push(light, light, light);
        }
        uvs.push(...ua);
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      };
      // u across the face, v 0 at the window -> 1 at the floor.
      const uvq = [0, 0, 1, 0, 1, 1, 0, 1];
      quad(shaftPos, shaftUv, shaftIdx, tl, tr, ftr, ftl, uvq);
      quad(shaftPos, shaftUv, shaftIdx, bl, br, fbr, fbl, uvq);
      quad(shaftPos, shaftUv, shaftIdx, tl, bl, fbl, ftl, uvq);
      quad(shaftPos, shaftUv, shaftIdx, tr, br, fbr, ftr, uvq);
      quad(patchPos, patchUv, patchIdx, fbl, fbr, ftr, ftl, uvq);
    }

    const mk = (bucket: Bucket, mat: THREE.Material, name: string): void => {
      const mesh = bucket.build(mat, name);
      if (mesh) this.group.add(mesh);
    };
    const statics = new THREE.Group();
    statics.name = 'models';
    batcher.build(statics);
    this.group.add(statics);

    mk(walls, new THREE.MeshLambertMaterial({ map: wallpaperTexture(), vertexColors: true }), 'walls');
    mk(floors, new THREE.MeshLambertMaterial({ map: floorTexture(), vertexColors: true }), 'floors');
    mk(ceilings, new THREE.MeshLambertMaterial({ map: ceilingTexture(), vertexColors: true }), 'ceilings');
    mk(wood, new THREE.MeshLambertMaterial({ map: woodGrainTexture(), vertexColors: true }), 'wood');
    mk(fabric, new THREE.MeshLambertMaterial({ map: fabricTexture(), vertexColors: true }), 'fabric');
    mk(plain, new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 30, specular: 0x222222 }), 'plain');
    mk(panes, new THREE.MeshBasicMaterial({ map: windowTexture(), color: 0x46557a, fog: false }), 'windows');

    if (shaftPos.length) {
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(shaftPos, 3));
      sg.setAttribute('uv', new THREE.Float32BufferAttribute(shaftUv, 2));
      sg.setAttribute('color', new THREE.Float32BufferAttribute(shaftCol, 3));
      sg.setIndex(shaftIdx);
      sg.computeBoundingSphere();
      const shafts = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({
        map: shaftTexture(), color: 0x151d30, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      shafts.name = 'moonShafts';
      shafts.renderOrder = 2;
      this.group.add(shafts);
      const pgeo = new THREE.BufferGeometry();
      pgeo.setAttribute('position', new THREE.Float32BufferAttribute(patchPos, 3));
      pgeo.setAttribute('uv', new THREE.Float32BufferAttribute(patchUv, 2));
      pgeo.setAttribute('color', new THREE.Float32BufferAttribute(patchCol, 3));
      pgeo.setIndex(patchIdx);
      pgeo.computeVertexNormals();
      pgeo.computeBoundingSphere();
      const patches = new THREE.Mesh(pgeo, new THREE.MeshBasicMaterial({
        map: moonPatchTexture(), color: 0x2f3d5c, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
      }));
      patches.name = 'moonPatches';
      patches.renderOrder = 1;
      this.group.add(patches);
    }
    this.group.updateMatrixWorld(true);
  }

  /** Walls (+ the exit door while it is closed) that block line of sight. */
  blockers(): Aabb[] {
    return this.exitOpen ? this.walls : [...this.walls, this.door.box];
  }

  update(state: WorldState, dt: number, time: number): void {
    this.exitOpen = state.exitOpen;
    this.fuseBox.update(state.fusesRequired, state.fusesInserted, time);
    this.door.update(state.exitOpen, dt);
  }

  dispose(): void {
    this.fuseBox.dispose();
    this.door.dispose();
    disposeTree(this.group);
  }
}
