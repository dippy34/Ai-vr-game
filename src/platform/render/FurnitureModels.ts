/**
 * Places Blender furniture (public/models/furniture_<variant>.glb) into the level's furniture
 * boxes: picks the best-fitting variant for each box's style, faces it away from the nearest
 * wall, scales it to fit, and tiles modular pieces (shelves, counters) along long boxes.
 *
 * All placed copies of the same source mesh are merged into one static mesh, so the whole
 * furniture set costs roughly one draw call per unique mesh (Quest budget).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Box, PropStyle } from '../../core/types';
import type { ModelLibrary } from './assets';

/** Variants per level style, by GLB name (without the furniture_ prefix). */
export const FURNITURE_VARIANTS: Record<PropStyle, string[]> = {
  table: ['table_small', 'table_coffee', 'desk', 'table_dining'],
  cabinet: ['cabinet_tall', 'cabinet_narrow', 'cabinet_low', 'nightstand'],
  couch: ['couch', 'armchair', 'bench'],
  piano: ['piano'],
  shelf: ['shelf_module', 'shelf_module_b'],
  counter: ['counter_module', 'counter_sink', 'counter_stove'],
  bed: ['bed'],
  crate: ['crate', 'crate_small'],
};

export const FURNITURE_MODEL_NAMES = [...new Set(Object.values(FURNITURE_VARIANTS).flat())].map((v) => `furniture_${v}`);

/** Where a furniture box's front faces (from LevelView's wall analysis). */
export interface FurnitureFrame {
  /** Bottom center of the box. */
  center: THREE.Vector3;
  /** Yaw that points the model's FRONT (glTF -Z) toward the room. */
  yaw: number;
  /** Size in the furniture's own frame: width (across the front), height, depth. */
  w: number;
  h: number;
  d: number;
}

interface Variant {
  name: string;
  scene: THREE.Object3D;
  size: THREE.Vector3;
  tileable: boolean;
}

const _box = new THREE.Box3();
const _m = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _inv = new THREE.Matrix4();

function variantInfo(lib: ModelLibrary, name: string): Variant | null {
  const asset = lib.get(`furniture_${name}`);
  if (!asset) return null;
  const extra = asset.extras.size;
  const size = new THREE.Vector3();
  if (Array.isArray(extra) && extra.length === 3 && extra.every((v) => typeof v === 'number' && v > 0)) {
    size.set(extra[0], extra[1], extra[2]);
  } else {
    _box.setFromObject(asset.scene).getSize(size);
  }
  return { name, scene: asset.scene, size, tileable: asset.extras.tileable === true };
}

const err = (want: number, have: number): number => Math.abs(Math.log(want / have));

export class FurnitureSet {
  readonly group = new THREE.Group();
  /** source mesh uuid -> transformed geometry copies + material */
  private readonly batches = new Map<string, { material: THREE.Material | THREE.Material[]; geos: THREE.BufferGeometry[] }>();

  constructor(private readonly lib: ModelLibrary) {
    this.group.name = 'furniture-models';
  }

  /** True if this style has at least one loaded model. */
  covers(style: PropStyle | undefined): boolean {
    return FURNITURE_VARIANTS[style ?? 'crate'].some((v) => this.lib.has(`furniture_${v}`));
  }

  /** Place models for one furniture box. Returns false if no model fits (caller keeps its fallback). */
  place(box: Box, frame: FurnitureFrame, seed: number): boolean {
    const style = box.style ?? 'crate';
    const variants = FURNITURE_VARIANTS[style].map((v) => variantInfo(this.lib, v)).filter((v): v is Variant => !!v);
    if (!variants.length) return false;

    const tileable = variants.filter((v) => v.tileable);
    if (tileable.length) {
      this.tile(tileable, frame, seed);
      return true;
    }
    // Best overall fit (log-ratio error on each axis); height matters a bit more.
    let best = variants[0];
    let bestErr = Infinity;
    for (const v of variants) {
      const e = err(frame.w, v.size.x) + 1.5 * err(frame.h, v.size.y) + err(frame.d, v.size.z);
      if (e < bestErr) {
        bestErr = e;
        best = v;
      }
    }
    this.add(best, frame, 0, frame.w / best.size.x, frame.h / best.size.y, frame.d / best.size.z);
    return true;
  }

  /** Lay modules side by side across the box width, alternating variants for variety. */
  private tile(variants: Variant[], frame: FurnitureFrame, seed: number): void {
    const unit = variants[0].size.x;
    const n = Math.max(1, Math.round(frame.w / unit));
    const sx = frame.w / (n * unit);
    // Counters: put the sink/stove somewhere in the run, the plain module everywhere else.
    const plain = variants[0];
    const specials = variants.slice(1);
    let s = (seed >>> 0) || 1;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < n; i++) {
      let v = plain;
      if (specials.length && n >= 2 && rnd() < (plain.name.startsWith('shelf') ? 0.5 : 0.28)) {
        v = specials[Math.floor(rnd() * specials.length)];
      }
      const offset = (-frame.w / 2) + (i + 0.5) * (frame.w / n);
      this.add(v, frame, offset, sx * (unit / v.size.x), frame.h / v.size.y, frame.d / v.size.z);
    }
  }

  /** Queue one placed copy: model scaled (sx, sy, sz) in its own frame, shifted `offset` across the front. */
  private add(v: Variant, frame: FurnitureFrame, offset: number, sx: number, sy: number, sz: number): void {
    const place = new THREE.Matrix4()
      .makeTranslation(frame.center.x, frame.center.y, frame.center.z)
      .multiply(_m.makeRotationY(frame.yaw))
      .multiply(new THREE.Matrix4().makeTranslation(offset, 0, 0))
      .multiply(new THREE.Matrix4().makeScale(sx, sy, sz));
    v.scene.updateMatrixWorld(true);
    _inv.copy(v.scene.matrixWorld).invert();
    v.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      _rel.multiplyMatrices(_inv, mesh.matrixWorld);
      const g = mesh.geometry.clone();
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(place, _rel));
      let batch = this.batches.get(mesh.uuid);
      if (!batch) {
        batch = { material: mesh.material, geos: [] };
        this.batches.set(mesh.uuid, batch);
      }
      batch.geos.push(g);
    });
  }

  /** Merge everything queued into static meshes. Call once after all place() calls. */
  build(): void {
    for (const { material, geos } of this.batches.values()) {
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (geos.length > 1) for (const g of geos) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
    this.batches.clear();
  }

  dispose(): void {
    for (const c of this.group.children) (c as THREE.Mesh).geometry?.dispose();
    this.group.clear();
    // Materials/textures belong to the ModelLibrary.
  }
}
