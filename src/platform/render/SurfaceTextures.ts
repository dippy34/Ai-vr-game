/**
 * Blender-baked, seamlessly tiling PBR texture sets for the house's walls, floors, ceilings and
 * trim (public/textures/<name>_{color,normal,orm}.webp + textures.json, built by
 * art/blender/surfaces.py). Optional at runtime: without them the level uses its canvas textures.
 *
 * Conventions (from the texture artist): color = sRGB; normal = OpenGL (+Y up, three.js default);
 * orm = linear R ambient occlusion / G roughness / B metalness. `tile` = meters one repeat covers,
 * so UV = world meters / tile. On walls v = 0 is the floor.
 *
 * Production builds also have GPU-compressed copies (<name>_<map>.ktx2, made by
 * scripts/optimize-assets.mjs, which marks those sets `"ktx2": true` in textures.json). They're
 * used when the KTX2 transcoder works, else the WebP files (the only ones in plain `npm run dev`).
 */

import * as THREE from 'three';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { trimAfterUpload } from './assets';
import { patchSurfaceMaterial } from './fx/roomAO';

/**
 * Roughness remap per set (roughness = map * a + b): varnished wood and glazed tiles catch the
 * flash as highlights, paper and plaster stay matte. Measured map means: wood floor 0.58, tiles
 * 0.33 (grout ~1), wallpaper 0.79, plaster 0.86, trim 0.44.
 */
const ROUGHNESS: Record<string, readonly [number, number]> = {
  wood_floor: [1.0, -0.2],
  tile_floor: [0.9, -0.06],
  wallpaper_a: [1.0, 0.04],
  wallpaper_b: [1.0, 0.04],
  plaster_ceiling: [1.0, 0.08],
  wood_trim: [1.0, -0.1],
};

export interface SurfaceSet {
  name: string;
  /** Meters covered by one repeat: [u, v]. */
  tile: [number, number];
  map: THREE.Texture;
  normalMap: THREE.Texture;
  orm: THREE.Texture;
}

const BASE = `${import.meta.env.BASE_URL}textures/`;

export class SurfaceLibrary {
  private readonly sets = new Map<string, SurfaceSet>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly loader = new THREE.TextureLoader();
  private ktx2: KTX2Loader | null = null;

  constructor(private readonly anisotropy = 4) {}

  /** Prefer the build's GPU-compressed (KTX2) copies where textures.json lists them (call before load()). */
  useKTX2(loader: KTX2Loader | null): void {
    this.ktx2 = loader;
  }

  /** Load every set listed in textures.json. Missing/broken sets are skipped with a warning. */
  async load(): Promise<void> {
    let index: Record<string, { tile?: unknown; ktx2?: unknown }>;
    try {
      const res = await fetch(`${BASE}textures.json`, { cache: 'no-store' });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return;
      index = await res.json();
    } catch {
      return;
    }
    await Promise.all(
      Object.entries(index).map(async ([name, info]) => {
        const tile = Array.isArray(info.tile) && info.tile.length === 2 ? (info.tile as [number, number]) : [1, 1];
        try {
          const [map, normalMap, orm] = await this.loadMaps(name, info.ktx2 === true);
          map.colorSpace = THREE.SRGBColorSpace;
          normalMap.colorSpace = orm.colorSpace = THREE.NoColorSpace;
          for (const t of [map, normalMap, orm]) {
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.anisotropy = this.anisotropy;
            t.userData.shared = true;
            trimAfterUpload(t);
          }
          this.sets.set(name, { name, tile: [Number(tile[0]) || 1, Number(tile[1]) || 1], map, normalMap, orm });
        } catch (err) {
          console.warn(`[textures] ${name} not loaded, using the built-in fallback`, err);
        }
      }),
    );
  }

  /** color, normal, orm: the KTX2 copies if available and working, else the WebP files. */
  private async loadMaps(name: string, compressed: boolean): Promise<THREE.Texture[]> {
    const kinds = ['color', 'normal', 'orm'];
    const ktx2 = this.ktx2;
    if (compressed && ktx2) {
      try {
        // Encoded upside down already (compressed textures can't be flipped on upload like WebP).
        return await Promise.all(kinds.map((kind) => ktx2.loadAsync(`${BASE}${name}_${kind}.ktx2`)));
      } catch (err) {
        console.warn(`[textures] ${name}: compressed copy failed, loading the WebP files`, err);
      }
    }
    return Promise.all(kinds.map((kind) => this.loader.loadAsync(`${BASE}${name}_${kind}.webp`)));
  }

  has(name: string): boolean {
    return this.sets.has(name);
  }

  get(name: string): SurfaceSet | undefined {
    return this.sets.get(name);
  }

  get loaded(): boolean {
    return this.sets.size > 0;
  }

  /**
   * One shared material per set. Vertex colors stay on so the level's per-room tint hints still
   * add a little variety. roughness/metalness are 1 so the ORM map is used as-is (roughness then
   * remapped per set, see ROUGHNESS).
   */
  material(name: string): THREE.MeshStandardMaterial | null {
    const cached = this.materials.get(name);
    if (cached) return cached;
    const s = this.sets.get(name);
    if (!s) return null;
    const m = new THREE.MeshStandardMaterial({
      map: s.map,
      normalMap: s.normalMap,
      roughnessMap: s.orm,
      metalnessMap: s.orm,
      aoMap: s.orm,
      roughness: 1,
      metalness: 1,
      vertexColors: true,
    });
    m.name = `surface_${name}`;
    m.userData.shared = true;
    // Room corner / contact AO + the roughness remap (fx/roomAO).
    patchSurfaceMaterial(m, ROUGHNESS[name] ?? [1, 0]);
    this.materials.set(name, m);
    return m;
  }
}
