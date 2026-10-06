/**
 * Blender-baked, seamlessly tiling PBR texture sets for the house's walls, floors, ceilings and
 * trim (public/textures/<name>_{color,normal,orm}.webp + textures.json, built by
 * art/blender/surfaces.py). Optional at runtime: without them the level uses its canvas textures.
 *
 * Conventions (from the texture artist): color = sRGB; normal = OpenGL (+Y up, three.js default);
 * orm = linear R ambient occlusion / G roughness / B metalness. `tile` = meters one repeat covers,
 * so UV = world meters / tile. On walls v = 0 is the floor.
 */

import * as THREE from 'three';

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

  constructor(private readonly anisotropy = 4) {}

  /** Load every set listed in textures.json. Missing/broken sets are skipped with a warning. */
  async load(): Promise<void> {
    let index: Record<string, { tile?: unknown }>;
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
          const [map, normalMap, orm] = await Promise.all(
            ['color', 'normal', 'orm'].map((kind) => this.loader.loadAsync(`${BASE}${name}_${kind}.webp`)),
          );
          map.colorSpace = THREE.SRGBColorSpace;
          normalMap.colorSpace = orm.colorSpace = THREE.NoColorSpace;
          for (const t of [map, normalMap, orm]) {
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.anisotropy = this.anisotropy;
            t.userData.shared = true;
          }
          this.sets.set(name, { name, tile: [Number(tile[0]) || 1, Number(tile[1]) || 1], map, normalMap, orm });
        } catch (err) {
          console.warn(`[textures] ${name} not loaded, using the built-in fallback`, err);
        }
      }),
    );
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
   * add a little variety. roughness/metalness are 1 so the ORM map is used as-is.
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
    this.materials.set(name, m);
    return m;
  }
}
