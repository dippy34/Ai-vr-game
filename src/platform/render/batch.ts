/**
 * Static batching for Blender models placed into the level (furniture, set dressing, the fuse box
 * body, the door frame): every placed copy of the same source mesh is transformed into world space
 * and merged into ONE static mesh, so N chairs cost one draw call (Quest budget).
 *
 * Copies can optionally be split into spatial chunks (a key per placement) so that a far-away
 * room's merged mesh can be frustum culled; by default everything merges into one chunk.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _inv = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _full = new THREE.Matrix4();

interface Batch {
  material: THREE.Material | THREE.Material[];
  geos: THREE.BufferGeometry[];
  name: string;
  renderOrder: number;
}

export class StaticBatcher {
  private readonly batches = new Map<string, Batch>();
  private tris = 0;

  /**
   * Queue every visible mesh under `root` (taken in root's own frame, i.e. root's transform is
   * ignored) transformed by `place`. `filter` can skip meshes (e.g. animated parts).
   */
  add(root: THREE.Object3D, place: THREE.Matrix4, chunk = '', filter?: (mesh: THREE.Mesh) => boolean): void {
    root.updateMatrixWorld(true);
    _inv.copy(root.matrixWorld).invert();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible || (filter && !filter(mesh))) return;
      _rel.multiplyMatrices(_inv, mesh.matrixWorld);
      _full.multiplyMatrices(place, _rel);
      this.addGeometry(mesh, _full, chunk);
    });
  }

  /** Queue one mesh's geometry with an explicit world matrix. */
  addGeometry(mesh: THREE.Mesh, world: THREE.Matrix4, chunk = ''): void {
    const g = mesh.geometry.clone();
    g.userData = {}; // the copy is ours (the source is library-owned and marked shared)
    g.applyMatrix4(world);
    // A mirrored copy would flip its winding (back faces out); placements never mirror, but be safe.
    if (world.determinant() < 0) flipWinding(g);
    const key = `${mesh.geometry.uuid}|${uuidOf(mesh.material)}|${chunk}`;
    let b = this.batches.get(key);
    if (!b) {
      b = { material: mesh.material, geos: [], name: mesh.name, renderOrder: mesh.renderOrder };
      this.batches.set(key, b);
    }
    b.geos.push(g);
    this.tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }

  /** Triangles queued so far. */
  get triangles(): number {
    return this.tris;
  }

  /** Merge everything queued into static meshes added to `group`. */
  build(group: THREE.Group): void {
    for (const b of this.batches.values()) {
      const merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
      if (b.geos.length > 1) for (const g of b.geos) g.dispose();
      if (!merged) continue;
      merged.userData = {};
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, b.material);
      mesh.name = `batch:${b.name}`;
      mesh.renderOrder = b.renderOrder;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    this.batches.clear();
    this.tris = 0;
  }
}

function uuidOf(m: THREE.Material | THREE.Material[]): string {
  return Array.isArray(m) ? m.map((x) => x.uuid).join(',') : m.uuid;
}

function flipWinding(g: THREE.BufferGeometry): void {
  const idx = g.index;
  if (!idx) return;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, a);
  }
  idx.needsUpdate = true;
}
