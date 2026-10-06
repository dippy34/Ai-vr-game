import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { StaticBatcher, TEXTURE_ARRAY_CHUNKS, textureArrayChunk } from './batch';

function tex(size: number, value: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(size * size * 4).fill(value), size, size);
  t.needsUpdate = true;
  return t;
}

function material(size: number, value: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map: tex(size, value), normalMap: tex(size, 128), roughnessMap: tex(size, 200) });
}

function meshes(group: THREE.Group): THREE.Mesh[] {
  return group.children as THREE.Mesh[];
}

describe('StaticBatcher', () => {
  it('patches shader chunks that exist in the installed three.js', () => {
    for (const slot of Object.keys(TEXTURE_ARRAY_CHUNKS) as (keyof typeof TEXTURE_ARRAY_CHUNKS)[]) {
      const chunk = textureArrayChunk(slot);
      expect(chunk).toContain(`${slot}Array`);
      expect(chunk).not.toContain(TEXTURE_ARRAY_CHUNKS[slot].sample);
    }
  });

  it('merges copies of one mesh, and different meshes sharing a material', () => {
    const b = new StaticBatcher();
    const mat = material(4, 10);
    const box = new THREE.Mesh(new THREE.BoxGeometry(), mat);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 4), mat);
    for (let i = 0; i < 3; i++) b.add(box, new THREE.Matrix4().makeTranslation(i, 0, 0));
    b.add(ball, new THREE.Matrix4());
    const g = new THREE.Group();
    b.build(g);
    expect(meshes(g)).toHaveLength(1);
    expect(meshes(g)[0].material).toBe(mat);
    expect(meshes(g)[0].geometry.getAttribute('texLayer')).toBeUndefined();
  });

  it('merges different models into one texture-array material, per texture size', () => {
    const b = new StaticBatcher();
    const a = new THREE.Mesh(new THREE.BoxGeometry(), material(4, 10));
    const c = new THREE.Mesh(new THREE.BoxGeometry(), material(4, 20));
    const big = new THREE.Mesh(new THREE.BoxGeometry(), material(8, 30));
    b.add(a, new THREE.Matrix4());
    b.add(c, new THREE.Matrix4().makeTranslation(2, 0, 0));
    b.add(big, new THREE.Matrix4().makeTranslation(4, 0, 0));
    const g = new THREE.Group();
    b.build(g);
    const out = meshes(g);
    expect(out).toHaveLength(2);
    const merged = out.find((m) => m.geometry.getAttribute('texLayer'))!;
    expect(merged).toBeDefined();
    const layers = new Set(Array.from(merged.geometry.getAttribute('texLayer').array as Float32Array));
    expect([...layers].sort()).toEqual([0, 1]);
    const arrays = (merged.material as THREE.Material).userData.textureArrays as THREE.DataArrayTexture[];
    // map, normalMap, roughnessMap: one array each, 2 layers of 4x4.
    expect(arrays).toHaveLength(3);
    for (const arr of arrays) expect([arr.image.width, arr.image.height, arr.image.depth]).toEqual([4, 4, 2]);
    // The color array holds both materials' texels, one per layer.
    const colorData = arrays.map((t) => t.image.data!).find((d) => d[0] !== 128 && d[0] !== 200)!;
    expect([colorData[0], colorData[4 * 4 * 4]].sort()).toEqual([10, 20]);
    expect(out.find((m) => m !== merged)!.material).toBe(big.material);
  });

  it('keeps materials with different settings apart', () => {
    const b = new StaticBatcher();
    const m1 = material(4, 10);
    const m2 = material(4, 20);
    m2.side = THREE.DoubleSide;
    b.add(new THREE.Mesh(new THREE.BoxGeometry(), m1), new THREE.Matrix4());
    b.add(new THREE.Mesh(new THREE.BoxGeometry(), m2), new THREE.Matrix4());
    const g = new THREE.Group();
    b.build(g);
    expect(meshes(g).map((m) => m.material).sort()).toEqual([m1, m2].sort());
  });

  it('splits by grid chunk', () => {
    const b = new StaticBatcher({ min: { x: 0, z: 0 }, max: { x: 10, z: 10 } }, 5);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), material(4, 10));
    b.add(mesh, new THREE.Matrix4().makeTranslation(1, 0, 1));
    b.add(mesh, new THREE.Matrix4().makeTranslation(2, 0, 2));
    b.add(mesh, new THREE.Matrix4().makeTranslation(8, 0, 8));
    const g = new THREE.Group();
    b.build(g);
    expect(meshes(g)).toHaveLength(2);
  });
});
