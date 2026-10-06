/**
 * Blender-made GLB models (public/models/*.glb, built by art/build.py).
 *
 * Models are optional at runtime: anything that fails to load falls back to the procedural
 * geometry built in code, so the game always runs (and tests don't need the files).
 *
 * Production builds also ship GPU-compressed copies (models/ktx2/<name>.glb, KTX2 / Basis
 * textures, made by scripts/optimize-assets.mjs). Those are preferred when listed in
 * models/ktx2/manifest.json and the KTX2 transcoder works; otherwise the WebP originals load.
 */

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
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
/**
 * Basis Universal transcoder (three's examples/jsm/libs/basis). Builds use KTX2Loader's own URL,
 * which Vite emits as a content-hashed asset (so the service worker's cache can never pair a stale
 * transcoder with a newer three); the dev server serves it at /basis/ (vite.config.ts) because
 * pre-bundled dependencies break that relative URL.
 */
const BASIS_PATH = import.meta.env.DEV ? `${import.meta.env.BASE_URL}basis/` : '';
/** scripts/optimize-assets.mjs stamps a content hash on texture names: same hash = same texels. */
const CONTENT_HASH = /#([0-9a-f]{12})$/;

/**
 * The one shared KTX2 (Basis) texture loader, or null where it can't work (no WebAssembly or
 * Worker). Transcodes on worker threads to whatever the GPU samples natively: ETC2 / ASTC on
 * Quest, BC on desktop (RGBA8 only as a last resort).
 */
export function createKTX2Loader(renderer: THREE.WebGLRenderer): KTX2Loader | null {
  if (typeof WebAssembly === 'undefined' || typeof Worker === 'undefined') return null;
  try {
    const loader = new KTX2Loader();
    if (BASIS_PATH) loader.setTranscoderPath(BASIS_PATH);
    loader.detectSupport(renderer);
    // three turns ETC/ASTC off on "desktop Linux" (Mesa emulates them), and standalone headset
    // browsers say "X11; Linux" too, but their mobile GPUs really have them (ETC2/ASTC are what
    // Quest samples best): keep them there.
    if (typeof navigator !== 'undefined' && /OculusBrowser|Quest|Pico/i.test(navigator.userAgent)) {
      const cfg = (loader as unknown as { workerConfig: Record<string, boolean> | null }).workerConfig;
      const ext = renderer.extensions;
      if (cfg) {
        cfg.astcSupported = ext.has('WEBGL_compressed_texture_astc');
        cfg.etc2Supported = ext.has('WEBGL_compressed_texture_etc');
        cfg.etc1Supported = ext.has('WEBGL_compressed_texture_etc1');
      }
    }
    return loader;
  } catch (err) {
    console.warn('[models] KTX2 textures unavailable, using WebP', err);
    return null;
  }
}

/**
 * GPU-compressed textures keep their transcoded data in JS memory after upload by default. Note
 * its size (for the perf HUD) and drop that CPU copy once it is on the GPU (tens of MB on Quest).
 */
export function trimAfterUpload(tex: THREE.Texture): void {
  const c = tex as THREE.CompressedTexture;
  if (!c.isCompressedTexture || tex.userData.gpuBytes !== undefined) return;
  const mips = c.mipmaps as unknown as { data?: ArrayBufferView }[] | undefined;
  if (!mips?.length) return;
  tex.userData.gpuBytes = mips.reduce((a, m) => a + (m.data?.byteLength ?? 0), 0);
  const prev = tex.onUpdate;
  tex.onUpdate = (t: THREE.Texture) => {
    prev?.call(tex, t);
    c.mipmaps = [];
  };
}

/** Fetch a JSON list of names, or null if it's missing (the dev server answers with index.html). */
export async function fetchNameList(url: string): Promise<Set<string> | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const list: unknown = await res.json();
    return Array.isArray(list) ? new Set(list.filter((n): n is string => typeof n === 'string')) : null;
  } catch {
    return null;
  }
}

export class ModelLibrary {
  private readonly models = new Map<string, ModelAsset>();
  private readonly loader = new GLTFLoader();
  /** Loader for the KTX2-textured copies (null: WebP only). */
  private compressedLoader: GLTFLoader | null = null;
  /** Textures with a content hash, shared between models (both hands, a trim set used twice...). */
  private readonly sharedTextures = new Map<string, THREE.Texture>();

  /** Prefer the build's GPU-compressed copies (call before load()). */
  useKTX2(ktx2: KTX2Loader | null): void {
    this.compressedLoader = ktx2 ? new GLTFLoader().setKTX2Loader(ktx2) : null;
  }

  /**
   * Load the given models in parallel, skipping any not listed in models/manifest.json (generated
   * by the Vite config from public/models). Broken files are skipped with a warning.
   * `prefixes` also loads every manifest entry starting with one of them (e.g. 'dressing_'), so
   * new set-dressing pieces are picked up without a code change.
   */
  async load(names: readonly string[], prefixes: readonly string[] = []): Promise<void> {
    const [available, compressed] = await Promise.all([
      fetchNameList(`${MODEL_BASE}manifest.json`),
      this.compressedLoader ? fetchNameList(`${MODEL_BASE}ktx2/manifest.json`) : Promise.resolve(null),
    ]);
    const wanted = new Set(names);
    if (available) for (const n of available) if (prefixes.some((p) => n.startsWith(p))) wanted.add(n);
    await Promise.all(
      [...wanted].map(async (name) => {
        if (available && !available.has(name)) return;
        if (this.models.has(name)) return;
        try {
          const gltf = await this.loadGltf(name, !!compressed?.has(name));
          const extras: Record<string, unknown> = {};
          gltf.scene.traverse((o) => {
            Object.assign(extras, o.userData);
            // Library-owned: instances and merged copies must never dispose these.
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.geometry.userData.shared = true;
            for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) this.prepareMaterial(mat);
          });
          this.models.set(name, { name, scene: gltf.scene, animations: gltf.animations, extras });
        } catch (err) {
          console.warn(`[models] ${name}.glb not loaded, using the built-in fallback`, err);
        }
      }),
    );
  }

  /** The KTX2 copy if there is one (falling back to the original if it fails), else the original. */
  private async loadGltf(name: string, compressed: boolean): Promise<GLTF> {
    if (compressed && this.compressedLoader) {
      try {
        return await this.compressedLoader.loadAsync(`${MODEL_BASE}ktx2/${name}.glb`);
      } catch (err) {
        console.warn(`[models] ${name}: compressed copy failed, loading the WebP original`, err);
      }
    }
    return this.loader.loadAsync(`${MODEL_BASE}${name}.glb`);
  }

  private prepareMaterial(mat: THREE.Material): void {
    mat.userData.shared = true;
    // Thin glass: one pass instead of three's back-then-front pair (half the draw calls; with
    // depthWrite off, as glTF BLEND materials are, the result looks the same).
    if (mat.transparent && mat.side === THREE.DoubleSide) mat.forceSinglePass = true;
    const slots = mat as unknown as Record<string, unknown>;
    for (const key of Object.keys(slots)) {
      const tex = slots[key];
      if (!(tex instanceof THREE.Texture)) continue;
      const hash = CONTENT_HASH.exec(tex.name);
      if (hash) {
        const id = `${hash[1]}|${tex.colorSpace}|${tex.wrapS}|${tex.wrapT}|${tex.flipY}`;
        const prev = this.sharedTextures.get(id);
        if (prev && prev !== tex) {
          slots[key] = prev; // never uploaded, so nothing to free on the GPU
          continue;
        }
        this.sharedTextures.set(id, tex);
      }
      tex.userData.shared = true;
      trimAfterUpload(tex);
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
