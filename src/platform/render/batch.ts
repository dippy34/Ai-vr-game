/**
 * Static batching for Blender models placed into the level (furniture, set dressing, the fuse box
 * body, the door frame, trims): every placed copy is transformed into world space and merged into
 * a few static meshes, so N chairs cost one draw call (Quest budget: WebXR draws every call twice).
 *
 * Merging goes beyond "copies of the same mesh":
 *  - Different meshes that share a material merge (e.g. the fuse box body, door and lever).
 *  - Different MODELS whose materials differ only in their textures (same MeshStandardMaterial
 *    settings, same texture sizes/formats: e.g. all furniture, all set dressing) merge too. Their
 *    textures are stacked into texture arrays (one layer per source material) and a per-vertex
 *    `texLayer` attribute picks the layer in the shader, so a chunk's furniture is ONE draw call
 *    instead of one per furniture model. GPU memory is unchanged: the per-model textures are never
 *    uploaded, the arrays hold the same texels (KTX2 data is copied as-is, still compressed).
 *
 * Copies are split into spatial chunks (a key per placement, or a grid) so that a far-away part of
 * the house can be frustum / fog culled.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _inv = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _full = new THREE.Matrix4();
const _c = new THREE.Vector3();

interface Entry {
  geo: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  chunk: string;
  name: string;
  renderOrder: number;
}

export class StaticBatcher {
  private readonly entries: Entry[] = [];
  private tris = 0;

  private readonly grid: { x0: number; z0: number; sx: number; sz: number; nx: number; nz: number } | null;

  /**
   * With `area` (XZ bounds) and `cell` (target size, m), merged meshes are split into a grid of
   * roughly cell-sized chunks aligned to the area (by where each copy's center lands), so chunks
   * outside the view are culled: a few more draw calls, far fewer triangles per view. Without
   * them, one merged mesh per material for the whole level.
   */
  constructor(area?: { min: { x: number; z: number }; max: { x: number; z: number } }, cell = 0) {
    const ov = (globalThis as unknown as { __muteBatchCell?: number }).__muteBatchCell; // EXPERIMENT
    if (ov) cell = ov; // EXPERIMENT
    if (area && cell > 0) {
      const w = area.max.x - area.min.x, d = area.max.z - area.min.z;
      const nx = Math.max(1, Math.round(w / cell)), nz = Math.max(1, Math.round(d / cell));
      this.grid = { x0: area.min.x, z0: area.min.z, sx: w / nx, sz: d / nz, nx, nz };
    } else {
      this.grid = null;
    }
  }

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
    const grid = this.grid;
    if (!chunk && grid) {
      g.computeBoundingBox();
      g.boundingBox!.getCenter(_c);
      const i = Math.min(grid.nx - 1, Math.max(0, Math.floor((_c.x - grid.x0) / grid.sx)));
      const k = Math.min(grid.nz - 1, Math.max(0, Math.floor((_c.z - grid.z0) / grid.sz)));
      chunk = `${i},${k}`;
    }
    this.entries.push({ geo: g, material: mesh.material, chunk, name: mesh.name, renderOrder: mesh.renderOrder });
    this.tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }

  /** Triangles queued so far. */
  get triangles(): number {
    return this.tris;
  }

  /** Merge everything queued into static meshes added to `group`. */
  build(group: THREE.Group): void {
    const plan = planMaterials(this.entries);
    const buckets = new Map<string, { material: THREE.Material | THREE.Material[]; geos: THREE.BufferGeometry[]; names: Set<string>; renderOrder: number }>();
    for (const e of this.entries) {
      let material = e.material;
      const p = Array.isArray(material) ? undefined : plan.get(material);
      if (p) {
        material = p.material;
        if (p.layer >= 0) {
          const n = e.geo.attributes.position.count;
          e.geo.setAttribute('texLayer', new THREE.BufferAttribute(new Float32Array(n).fill(p.layer), 1));
        }
      }
      // Multi-material meshes keep their own groups: never merged (glTF never makes them).
      const key = Array.isArray(material)
        ? `multi|${e.geo.uuid}`
        : `${material.uuid}|${attributeSignature(e.geo)}|${e.chunk}|${e.renderOrder}`;
      let b = buckets.get(key);
      if (!b) {
        b = { material, geos: [], names: new Set(), renderOrder: e.renderOrder };
        buckets.set(key, b);
      }
      b.geos.push(e.geo);
      b.names.add(e.name);
    }
    for (const b of buckets.values()) {
      const merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
      if (b.geos.length > 1) for (const g of b.geos) g.dispose();
      if (!merged) continue;
      merged.userData = {};
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, b.material);
      const names = [...b.names];
      mesh.name = `batch:${names.slice(0, 4).join('+')}${names.length > 4 ? `+${names.length - 4}` : ''}`;
      mesh.renderOrder = b.renderOrder;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    this.entries.length = 0;
    this.tris = 0;
  }
}

/** Geometries merge only with the same attribute layout (and indexing). */
function attributeSignature(g: THREE.BufferGeometry): string {
  const parts: string[] = [];
  for (const name of Object.keys(g.attributes).sort()) {
    const a = g.attributes[name];
    const arr = (a as THREE.BufferAttribute).array;
    parts.push(`${name}:${a.itemSize}:${a.normalized ? 1 : 0}:${arr ? arr.constructor.name : 'x'}`);
  }
  const morph = Object.keys(g.morphAttributes);
  return `${parts.join(',')}|${g.index ? 'i' : 'n'}|${morph.join(',')}`;
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

// ---------------------------------------------------------------------------------------------
// Texture-array materials (several models' materials -> one)
// ---------------------------------------------------------------------------------------------

/** Material texture slots that can come from a texture array. */
const ARRAY_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const;
type Slot = (typeof ARRAY_SLOTS)[number];
/** Any of these set: leave the material alone. */
const OTHER_MAPS = ['alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'envMap'] as const;

/**
 * Where each slot is sampled in three's shader chunks (three r186). batch.test.ts checks these
 * still match the installed three.js, so an upgrade can't silently break the merged materials.
 */
export const TEXTURE_ARRAY_CHUNKS: Record<Slot, { chunk: string; sample: string; uv: string }> = {
  map: { chunk: 'map_fragment', sample: 'texture2D( map, vMapUv )', uv: 'vMapUv' },
  normalMap: { chunk: 'normal_fragment_maps', sample: 'texture2D( normalMap, vNormalMapUv )', uv: 'vNormalMapUv' },
  roughnessMap: { chunk: 'roughnessmap_fragment', sample: 'texture2D( roughnessMap, vRoughnessMapUv )', uv: 'vRoughnessMapUv' },
  metalnessMap: { chunk: 'metalnessmap_fragment', sample: 'texture2D( metalnessMap, vMetalnessMapUv )', uv: 'vMetalnessMapUv' },
  aoMap: { chunk: 'aomap_fragment', sample: 'texture2D( aoMap, vAoMapUv )', uv: 'vAoMapUv' },
  emissiveMap: { chunk: 'emissivemap_fragment', sample: 'texture2D( emissiveMap, vEmissiveMapUv )', uv: 'vEmissiveMapUv' },
};

interface Plan {
  material: THREE.Material;
  /** Texture-array layer, or -1 when the material is used as-is (no texLayer attribute). */
  layer: number;
}

interface MergedMaterial {
  material: THREE.Material;
  /** Layer per texture tuple key (-1: the members all share one set of textures). */
  layers: Map<string, number>;
}

/** Merged materials by group signature + members: built once, reused by every level rebuild. */
const mergedCache = new Map<string, MergedMaterial | null>();

/** Bound to the placeholder 2D samplers of merged materials (never actually sampled). */
let placeholder: THREE.DataTexture | null = null;
function placeholderTexture(): THREE.DataTexture {
  if (!placeholder) {
    placeholder = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    placeholder.needsUpdate = true;
    placeholder.userData.shared = true;
  }
  return placeholder;
}

/** Decide which source materials get replaced by a shared texture-array material. */
function planMaterials(entries: readonly Entry[]): Map<THREE.Material, Plan> {
  if ((globalThis as unknown as { __muteNoArrays?: boolean }).__muteNoArrays) return new Map(); // EXPERIMENT
  const groups = new Map<string, THREE.MeshStandardMaterial[]>();
  const seen = new Set<THREE.Material>();
  for (const e of entries) {
    const m = e.material;
    if (Array.isArray(m) || seen.has(m)) continue;
    seen.add(m);
    const sig = groupSignature(m);
    if (!sig) continue;
    let list = groups.get(sig);
    if (!list) groups.set(sig, (list = []));
    list.push(m as THREE.MeshStandardMaterial);
  }
  const plan = new Map<THREE.Material, Plan>();
  for (const [sig, members] of groups) {
    if (members.length < 2) continue;
    const merged = mergedMaterial(sig, members);
    if (!merged) continue;
    for (const m of members) plan.set(m, { material: merged.material, layer: merged.layers.get(tupleKey(m)) ?? -1 });
  }
  return plan;
}

const tupleKey = (m: THREE.MeshStandardMaterial): string => ARRAY_SLOTS.map((s) => m[s]?.uuid ?? '-').join(',');

/** Materials with the same signature can share one texture-array material. Null: not mergeable. */
function groupSignature(m: THREE.Material): string | null {
  if (m.type !== 'MeshStandardMaterial') return null;
  const s = m as THREE.MeshStandardMaterial;
  // Custom shaders / defines: leave alone.
  if (Object.prototype.hasOwnProperty.call(s, 'onBeforeCompile') || Object.prototype.hasOwnProperty.call(s, 'customProgramCacheKey')) return null;
  if (JSON.stringify(s.defines ?? {}) !== '{"STANDARD":""}') return null;
  if (s.clippingPlanes?.length) return null;
  for (const k of OTHER_MAPS) if (s[k]) return null;
  const tex: string[] = [];
  let any = false;
  for (const slot of ARRAY_SLOTS) {
    const t = s[slot];
    if (!t) {
      tex.push('-');
      continue;
    }
    const f = textureSignature(t);
    if (!f) return null;
    tex.push(f);
    any = true;
  }
  if (!any) return null;
  const c = s.color, e = s.emissive;
  return [
    s.side, s.transparent, s.opacity, s.alphaTest, s.alphaToCoverage, s.alphaHash, s.depthWrite, s.depthTest, s.depthFunc,
    s.blending, s.blendSrc, s.blendDst, s.blendEquation, s.premultipliedAlpha, s.colorWrite, s.polygonOffset,
    s.polygonOffsetFactor, s.polygonOffsetUnits, s.forceSinglePass, s.dithering, s.toneMapped, s.fog, s.flatShading,
    s.vertexColors, s.wireframe, s.visible, `${c.r},${c.g},${c.b}`, `${e.r},${e.g},${e.b}`, s.emissiveIntensity,
    s.roughness, s.metalness, s.normalMapType, s.normalScale.x, s.normalScale.y, s.aoMapIntensity, s.envMapIntensity,
    ...tex,
  ].join('|');
}

type Drawable = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;

function isDrawable(img: unknown): img is Drawable {
  return (
    (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap)
    || (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0)
    || (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement)
    || (typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas)
  );
}

interface Mip { data: ArrayBufferView; width: number; height: number }

/** Size/format/sampler of a texture, or null if it can't go into an array. */
function textureSignature(t: THREE.Texture): string | null {
  const x = t as THREE.Texture & Record<string, unknown>;
  if (x.isDataArrayTexture || x.isCompressedArrayTexture || x.isData3DTexture || x.isCubeTexture || x.isVideoTexture || x.isCanvasTexture) return null;
  if (t.channel !== 0 || t.offset.x !== 0 || t.offset.y !== 0 || t.repeat.x !== 1 || t.repeat.y !== 1 || t.rotation !== 0) return null;
  let kind: string, w: number, h: number;
  if ((t as THREE.CompressedTexture).isCompressedTexture) {
    const mips = (t as THREE.CompressedTexture).mipmaps as unknown as Mip[] | undefined;
    if (!mips?.length || !mips.every((m) => m && ArrayBuffer.isView(m.data))) return null;
    w = mips[0].width;
    h = mips[0].height;
    kind = `c${t.format}:${t.type}:${mips.length}`;
  } else if (isDrawable(t.image)) {
    if (t.flipY) return null;
    w = t.image.width;
    h = t.image.height;
    kind = 'i';
  } else {
    const img = t.image as { data?: unknown; width: number; height: number } | null;
    if (!(t as THREE.DataTexture).isDataTexture || !img || !(img.data instanceof Uint8Array)
      || t.format !== THREE.RGBAFormat || t.type !== THREE.UnsignedByteType || t.flipY) return null;
    w = img.width;
    h = img.height;
    kind = 'd';
  }
  return `${kind}:${w}x${h}:${t.colorSpace}:${t.wrapS}:${t.wrapT}:${t.magFilter}:${t.minFilter}:${t.anisotropy}:${t.premultiplyAlpha}:${t.generateMipmaps}`;
}

function mergedMaterial(sig: string, members: THREE.MeshStandardMaterial[]): MergedMaterial | null {
  // One layer per distinct set of textures (materials that share all their textures share a layer).
  const tuples = new Map<string, THREE.MeshStandardMaterial>();
  for (const m of members) if (!tuples.has(tupleKey(m))) tuples.set(tupleKey(m), m);
  const keys = [...tuples.keys()].sort();
  const cacheKey = `${sig}#${keys.join(';')}`;
  if (mergedCache.has(cacheKey)) return mergedCache.get(cacheKey)!;
  let result: MergedMaterial | null = null;
  if (keys.length === 1) {
    // Same settings AND same textures (e.g. a trim set shared by two models): just one material.
    result = { material: tuples.get(keys[0])!, layers: new Map([[keys[0], -1]]) };
  } else {
    try {
      result = buildArrayMaterial(keys.map((k) => tuples.get(k)!), keys);
    } catch (err) {
      console.warn('[batch] texture-array merge failed, keeping separate materials', err);
      result = null;
    }
  }
  mergedCache.set(cacheKey, result);
  return result;
}

function buildArrayMaterial(layers: THREE.MeshStandardMaterial[], keys: string[]): MergedMaterial {
  const base = layers[0];
  const slots = ARRAY_SLOTS.filter((s) => base[s]);
  // Slots that read the same textures (glTF roughness + metalness) share one array.
  const byList = new Map<string, THREE.Texture>();
  const arrays = new Map<Slot, THREE.Texture>();
  for (const slot of slots) {
    const list = layers.map((m) => m[slot]!);
    const id = list.map((t) => t.uuid).join(',');
    let arr = byList.get(id);
    if (!arr) {
      arr = buildArray(list);
      byList.set(id, arr);
    }
    arrays.set(slot, arr);
  }
  const mat = base.clone();
  mat.name = `texarray(${layers.map((m) => m.name).join('+')})`.slice(0, 160);
  const uniforms: Record<string, THREE.IUniform> = {};
  for (const slot of slots) {
    // A 2D placeholder keeps three's USE_<MAP> defines + UV varyings; the shader samples the array.
    mat[slot] = placeholderTexture();
    uniforms[`${slot}Array`] = { value: arrays.get(slot)! };
  }
  mat.userData = { shared: true, textureArrays: [...byList.values()] };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute float texLayer;\nflat varying float vTexLayer;\nvoid main() {')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvTexLayer = texLayer;');
    const decl = slots.map((s) => `uniform sampler2DArray ${s}Array;`).join('\n');
    let fs = shader.fragmentShader.replace('void main() {', `flat varying float vTexLayer;\n${decl}\nvoid main() {`);
    for (const s of slots) fs = fs.replace(`#include <${TEXTURE_ARRAY_CHUNKS[s].chunk}>`, textureArrayChunk(s));
    shader.fragmentShader = fs;
  };
  const programKey = `mute-texarray:${slots.join(',')}`;
  mat.customProgramCacheKey = () => programKey;
  return { material: mat, layers: new Map(keys.map((k, i) => [k, i])) };
}

/** three's shader chunk for `slot`, sampling layer vTexLayer of `<slot>Array` instead of the 2D map. */
export function textureArrayChunk(slot: Slot): string {
  const { chunk, sample, uv } = TEXTURE_ARRAY_CHUNKS[slot];
  const src = (THREE.ShaderChunk as unknown as Record<string, string>)[chunk];
  if (!src || !src.includes(sample)) throw new Error(`three.js shader chunk ${chunk} changed: no "${sample}"`);
  return src.split(sample).join(`texture( ${slot}Array, vec3( ${uv}, vTexLayer ) )`);
}

/** Stack same-size, same-format textures into one array texture (layer i = list[i]). */
function buildArray(list: THREE.Texture[]): THREE.Texture {
  const t0 = list[0];
  const n = list.length;
  let arr: THREE.Texture;
  if ((t0 as THREE.CompressedTexture).isCompressedTexture) {
    // Compressed blocks are copied as they are (each layer = one source texture, all mip levels).
    const src = list.map((t) => (t as THREE.CompressedTexture).mipmaps as unknown as Mip[]);
    const mipmaps: { data: Uint8Array; width: number; height: number }[] = [];
    for (let level = 0; level < src[0].length; level++) {
      const parts = src.map((m) => m[level].data);
      const size = parts[0].byteLength;
      if (parts.some((p) => p.byteLength !== size)) throw new Error('mip level sizes differ');
      const data = new Uint8Array(size * n);
      parts.forEach((p, i) => data.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), i * size));
      mipmaps.push({ data, width: src[0][level].width, height: src[0][level].height });
    }
    const c = new THREE.CompressedArrayTexture(mipmaps as unknown as ImageData[], mipmaps[0].width, mipmaps[0].height, n, t0.format as THREE.CompressedPixelFormat, t0.type);
    c.userData.gpuBytes = mipmaps.reduce((a, m) => a + m.data.byteLength, 0);
    arr = c;
  } else {
    const w = (t0.image as { width: number }).width;
    const h = (t0.image as { height: number }).height;
    const layer = w * h * 4;
    const data = new Uint8Array(layer * n);
    let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
    list.forEach((t, i) => {
      const img = t.image as unknown;
      if (isDrawable(img)) {
        if (!ctx) {
          const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
          ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
          if (!ctx) throw new Error('no 2D canvas');
        }
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        data.set(ctx.getImageData(0, 0, w, h).data, i * layer);
      } else {
        data.set((img as { data: Uint8Array }).data.subarray(0, layer), i * layer);
      }
    });
    const d = new THREE.DataArrayTexture(data, w, h, n);
    d.format = THREE.RGBAFormat;
    d.type = THREE.UnsignedByteType;
    d.generateMipmaps = t0.generateMipmaps;
    d.unpackAlignment = 4;
    d.userData.gpuBytes = data.byteLength * (d.generateMipmaps ? 4 / 3 : 1);
    arr = d;
  }
  arr.colorSpace = t0.colorSpace;
  arr.wrapS = t0.wrapS;
  arr.wrapT = t0.wrapT;
  arr.magFilter = t0.magFilter;
  arr.minFilter = t0.minFilter;
  arr.anisotropy = t0.anisotropy;
  arr.premultiplyAlpha = t0.premultiplyAlpha;
  arr.flipY = false;
  arr.name = `texarray(${list.map((t) => t.name).join('+')})`.slice(0, 160);
  arr.userData.shared = true;
  arr.needsUpdate = true;
  // The GPU keeps the texels; don't also keep a CPU copy of every array for the app's lifetime.
  arr.onUpdate = () => {
    if ((arr as THREE.CompressedArrayTexture).isCompressedArrayTexture) (arr as THREE.CompressedArrayTexture).mipmaps = [];
    else (arr.image as { data: Uint8Array | null }).data = null;
  };
  return arr;
}
