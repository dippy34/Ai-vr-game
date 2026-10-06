/**
 * Blender-made GLB models (public/models/*.glb, built by art/build.py).
 *
 * Models are optional at runtime: anything that fails to load falls back to the procedural
 * geometry built in code, so the game always runs (and tests don't need the files).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ensureIndexed } from './util';

export interface ModelAsset {
  name: string;
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  /** glTF extras of the root node(s), merged (e.g. size, tileable, walkSpeed, curlAxis). */
  extras: Record<string, unknown>;
}

const MODEL_BASE = `${import.meta.env.BASE_URL}models/`;

export class ModelLibrary {
  private readonly models = new Map<string, ModelAsset>();
  private readonly loader = new GLTFLoader();

  /**
   * Load the given models in parallel, skipping any not listed in models/manifest.json (generated
   * by the Vite config from public/models). Broken files are skipped with a warning.
   * `prefixes` also loads every manifest entry starting with one of them (e.g. 'dressing_'), so
   * new set-dressing pieces are picked up without a code change.
   */
  async load(names: readonly string[], prefixes: readonly string[] = []): Promise<void> {
    const available = await this.manifest();
    const wanted = new Set(names);
    if (available) for (const n of available) if (prefixes.some((p) => n.startsWith(p))) wanted.add(n);
    await Promise.all(
      [...wanted].map(async (name) => {
        if (available && !available.has(name)) return;
        if (this.models.has(name)) return;
        try {
          const gltf = await this.loader.loadAsync(`${MODEL_BASE}${name}.glb`);
          const extras: Record<string, unknown> = {};
          gltf.scene.traverse((o) => {
            Object.assign(extras, o.userData);
            // Library-owned: instances and merged copies must never dispose these.
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.geometry.userData.shared = true;
            for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              mat.userData.shared = true;
              for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.userData.shared = true;
            }
          });
          this.models.set(name, { name, scene: gltf.scene, animations: gltf.animations, extras });
        } catch (err) {
          console.warn(`[models] ${name}.glb not loaded, using the built-in fallback`, err);
        }
      }),
    );
  }

  /** Names of the GLBs that exist, or null if the manifest is unavailable (then: try everything). */
  private async manifest(): Promise<Set<string> | null> {
    try {
      const res = await fetch(`${MODEL_BASE}manifest.json`, { cache: 'no-store' });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
      const list: unknown = await res.json();
      return Array.isArray(list) ? new Set(list.filter((n): n is string => typeof n === 'string')) : null;
    } catch {
      return null;
    }
  }

  has(name: string): boolean {
    return this.models.has(name);
  }

  get(name: string): ModelAsset | undefined {
    return this.models.get(name);
  }

  /** A fresh, independent copy (skinned meshes get their own skeleton). Shares geometry/materials. */
  instance(name: string): THREE.Object3D | null {
    const asset = this.models.get(name);
    return asset ? cloneSkinned(asset.scene) : null;
  }

  names(): string[] {
    return [...this.models.keys()];
  }
}

const _v = new THREE.Vector3();

/**
 * Append world-space, position+normal-only copies of every visible mesh under `root` in its
 * CURRENT pose (skinning applied on the CPU). Used to freeze a model into a flash afterimage.
 * `offset` pushes vertices out along their normals (meters), for the glow halo.
 */
export function bakeObject(root: THREE.Object3D, out: THREE.BufferGeometry[], offset = 0): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !isVisible(mesh)) return;
    const src = mesh.geometry;
    const pos = src.getAttribute('position');
    if (!pos) return;
    const arr = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      mesh.getVertexPosition(i, _v); // applies skinning + morphs for SkinnedMesh
      _v.applyMatrix4(mesh.matrixWorld);
      arr[i * 3] = _v.x;
      arr[i * 3 + 1] = _v.y;
      arr[i * 3 + 2] = _v.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    if (src.index) g.setIndex(src.index.clone());
    g.computeVertexNormals();
    if (offset !== 0) {
      const n = g.getAttribute('normal');
      for (let i = 0; i < pos.count; i++) {
        arr[i * 3] += n.getX(i) * offset;
        arr[i * 3 + 1] += n.getY(i) * offset;
        arr[i * 3 + 2] += n.getZ(i) * offset;
      }
    }
    // Afterimage merging needs every part to share attributes (position+normal) and indexing.
    out.push(ensureIndexed(g));
  });
}

function isVisible(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/** Every mesh under `root` (depth first). */
export function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

/** Bounds of all meshes under `root`, in `root`'s own frame (ignores root's transform). */
export function localBounds(root: THREE.Object3D, out = new THREE.Box3()): THREE.Box3 {
  out.makeEmpty();
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const b = new THREE.Box3();
  for (const mesh of meshesOf(root)) {
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    b.copy(g.boundingBox!).applyMatrix4(m.multiplyMatrices(inv, mesh.matrixWorld));
    out.union(b);
  }
  return out;
}

/** `extras.size` = [w, h, d] if present and valid, else null. */
export function extrasSize(extras: Record<string, unknown>): THREE.Vector3 | null {
  const s = extras.size;
  if (Array.isArray(s) && s.length === 3 && s.every((v) => typeof v === 'number' && v > 0)) return new THREE.Vector3(s[0], s[1], s[2]);
  return null;
}

/** Find a node by exact name anywhere under `root`. */
export function findNode<T extends THREE.Object3D = THREE.Object3D>(root: THREE.Object3D, name: string): T | null {
  return (root.getObjectByName(name) as T | undefined) ?? null;
}
