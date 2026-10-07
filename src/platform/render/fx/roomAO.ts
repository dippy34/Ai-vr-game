/**
 * Contact / edge ambient occlusion for the house's walls, floors and ceilings, from one small
 * texture over the level's floor plan (built once per level, ~0.2 MB) and a few ALU per pixel.
 *
 * Texel channels (meters / AO_FIELD.maxDist, so 0..1):
 *   R  free distance along +-X to the nearest wall that stands on the floor
 *   G  free distance along +-Z to the nearest wall
 *   B  distance to the nearest furniture footprint (0 under / inside it)
 *   A  that furniture's top height / AO_FIELD.maxHeight
 *
 * Distances are measured along the axes ("how far can I go in X before a wall"), not to the
 * nearest wall in any direction: a wall pixel looks along its own plane for perpendicular walls
 * in front of it, so concave corners darken but convex ones (doorway jambs) don't.
 * Floor pixels darken near walls (corners twice), and under / around furniture; wall pixels near
 * the floor, the ceiling, the room corners and behind furniture (up to its top); ceilings near walls.
 */

import * as THREE from 'three';
import type { Box, LevelData } from '../../../core/types';

export const AO_FIELD = {
  /** Texel size (m). */
  res: 0.05,
  /** Distances are stored up to this (m); further = no occlusion. */
  maxDist: 1.0,
  maxHeight: 3.0,
  /** Margin around the level bounds (m). */
  margin: 0.3,
} as const;

export interface AoFieldData {
  data: Uint8Array;
  width: number;
  height: number;
  /** World XZ of texel (0, 0)'s corner. */
  minX: number;
  minZ: number;
  res: number;
}

const isFloorWall = (b: Box): boolean => b.kind === 'wall' && b.min.y < 0.1 && b.max.y > 1.0;
const isFurniture = (b: Box): boolean => b.kind === 'furniture' && b.max.y - b.min.y > 0.2;

/** Build the field (pure: plain arrays only, no GPU). */
export function buildAoField(level: LevelData, res: number = AO_FIELD.res): AoFieldData {
  const m = AO_FIELD.margin;
  const minX = level.bounds.min.x - m, minZ = level.bounds.min.z - m;
  const width = Math.max(2, Math.ceil((level.bounds.max.x + m - minX) / res));
  const height = Math.max(2, Math.ceil((level.bounds.max.z + m - minZ) / res));
  const n = width * height;
  const solid = new Uint8Array(n);
  const walls = level.boxes.filter(isFloorWall);
  for (const b of walls) {
    // Texels whose centers are inside the box.
    const i0 = Math.max(0, Math.ceil((b.min.x - minX) / res - 0.5));
    const i1 = Math.min(width - 1, Math.floor((b.max.x - minX) / res - 0.5));
    const j0 = Math.max(0, Math.ceil((b.min.z - minZ) / res - 0.5));
    const j1 = Math.min(height - 1, Math.floor((b.max.z - minZ) / res - 0.5));
    for (let j = j0; j <= j1; j++) solid.fill(1, j * width + i0, j * width + i1 + 1);
  }
  const maxD = AO_FIELD.maxDist;
  const enc = (d: number): number => Math.round(255 * Math.min(1, Math.max(0, d) / maxD));
  const data = new Uint8Array(n * 4);
  const big = 1e6;
  // R: scan each row both ways; distance from this texel's center to the solid texel's face.
  const line = new Float32Array(Math.max(width, height));
  for (let j = 0; j < height; j++) {
    let last = -big;
    for (let i = 0; i < width; i++) {
      if (solid[j * width + i]) { last = i; line[i] = 0; } else line[i] = (i - last - 0.5) * res;
    }
    last = big;
    for (let i = width - 1; i >= 0; i--) {
      if (solid[j * width + i]) last = i;
      else line[i] = Math.min(line[i], (last - i - 0.5) * res);
      data[(j * width + i) * 4] = enc(line[i]);
    }
  }
  // G: the same down each column.
  for (let i = 0; i < width; i++) {
    let last = -big;
    for (let j = 0; j < height; j++) {
      if (solid[j * width + i]) { last = j; line[j] = 0; } else line[j] = (j - last - 0.5) * res;
    }
    last = big;
    for (let j = height - 1; j >= 0; j--) {
      if (solid[j * width + i]) last = j;
      else line[j] = Math.min(line[j], (last - j - 0.5) * res);
      data[(j * width + i) * 4 + 1] = enc(line[j]);
    }
  }
  // B/A: nearest furniture footprint (2D) and its top.
  const fd = new Float32Array(n).fill(maxD);
  const ft = new Float32Array(n);
  for (const b of level.boxes) {
    if (!isFurniture(b)) continue;
    const i0 = Math.max(0, Math.floor((b.min.x - maxD - minX) / res));
    const i1 = Math.min(width - 1, Math.ceil((b.max.x + maxD - minX) / res));
    const j0 = Math.max(0, Math.floor((b.min.z - maxD - minZ) / res));
    const j1 = Math.min(height - 1, Math.ceil((b.max.z + maxD - minZ) / res));
    for (let j = j0; j <= j1; j++) {
      const z = minZ + (j + 0.5) * res;
      const dz = Math.max(b.min.z - z, 0, z - b.max.z);
      for (let i = i0; i <= i1; i++) {
        const x = minX + (i + 0.5) * res;
        const dx = Math.max(b.min.x - x, 0, x - b.max.x);
        const d = Math.hypot(dx, dz);
        const k = j * width + i;
        if (d < fd[k]) {
          fd[k] = d;
          ft[k] = b.max.y;
        }
      }
    }
  }
  for (let k = 0; k < n; k++) {
    data[k * 4 + 2] = enc(fd[k]);
    data[k * 4 + 3] = Math.round(255 * Math.min(1, ft[k] / AO_FIELD.maxHeight));
  }
  return { data, width, height, minX, minZ, res };
}

/** Uniforms shared by every patched surface material (the current level's field). */
const AO_UNIFORMS = {
  aoField: { value: null as THREE.Texture | null },
  /** xy = world XZ of the field's corner, zw = 1 / field size (m). */
  aoXform: { value: new THREE.Vector4(0, 0, 1, 1) },
  /** x = strength, y = falloff (m), z = ceiling height, w = share applied to direct light. */
  aoParams: { value: new THREE.Vector4(0, 0.45, 2.8, 0.35) },
};

/** GPU texture for a field (LevelView owns and disposes it). */
export function aoFieldTexture(f: AoFieldData): THREE.DataTexture {
  const t = new THREE.DataTexture(f.data, f.width, f.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Point the patched materials at this level's field. strength 0 turns the term off. */
export function useAoField(tex: THREE.Texture | null, f: AoFieldData | null, ceilingY: number, strength = 0.55): void {
  AO_UNIFORMS.aoField.value = tex;
  if (f) AO_UNIFORMS.aoXform.value.set(f.minX, f.minZ, 1 / (f.width * f.res), 1 / (f.height * f.res));
  AO_UNIFORMS.aoParams.value.set(tex ? strength : 0, 0.45, ceilingY, 0.35);
}

const AO_VERT_PARS = /* glsl */ `
varying vec3 vAoPos;
varying vec3 vAoNrm;
`;
const AO_VERT = /* glsl */ `
vAoPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vAoNrm = mat3( modelMatrix ) * objectNormal;
`;
const AO_FRAG_PARS = /* glsl */ `
varying vec3 vAoPos;
varying vec3 vAoNrm;
uniform sampler2D aoField;
uniform vec4 aoXform;
uniform vec4 aoParams;
float aoEdge( float d ) {
	float k = 1.0 - smoothstep( 0.0, aoParams.y, d );
	return 1.0 - aoParams.x * k * k;
}
`;
const AO_FRAG = /* glsl */ `
if ( aoParams.x > 0.0 ) {
	vec3 an = normalize( vAoNrm );
	vec3 ap = vAoPos;
	float ao = 1.0;
	const float MAXD = ${AO_FIELD.maxDist.toFixed(2)};
	const float MAXH = ${AO_FIELD.maxHeight.toFixed(2)};
	if ( abs( an.y ) > 0.5 ) {
		vec4 f = texture2D( aoField, ( ap.xz - aoXform.xy ) * aoXform.zw );
		ao = aoEdge( f.r * MAXD ) * aoEdge( f.g * MAXD );
		if ( an.y > 0.5 ) {
			// Under / beside furniture: stronger the taller it is.
			float fk = 1.0 - smoothstep( 0.0, 0.55, f.b * MAXD );
			ao *= 1.0 - 0.5 * fk * fk * smoothstep( 0.15, 0.9, f.a * MAXH );
		}
	} else {
		// Look along this wall from 12 cm in front of it (clear of its own texels).
		vec2 q = ap.xz + an.xz * 0.12;
		vec4 f = texture2D( aoField, ( q - aoXform.xy ) * aoXform.zw );
		ao = aoEdge( ( abs( an.x ) > abs( an.z ) ? f.g : f.r ) * MAXD + 0.12 );
		ao *= aoEdge( ap.y ) * mix( 1.0, aoEdge( aoParams.z - ap.y ), 0.7 );
		float top = f.a * MAXH;
		float fk = ( 1.0 - smoothstep( 0.0, 0.35, f.b * MAXD ) ) * ( 1.0 - smoothstep( top - 0.15, top + 0.3, ap.y ) );
		ao *= 1.0 - 0.45 * fk;
	}
	reflectedLight.indirectDiffuse *= ao;
	reflectedLight.directDiffuse *= mix( 1.0, ao, aoParams.w );
	reflectedLight.directSpecular *= mix( 1.0, ao, aoParams.w );
}
`;

/**
 * Add the room AO term to a level surface material (MeshStandardMaterial with the usual chunks).
 * `rough` remaps the roughness map: roughness = map * rough.x + rough.y (varnish / glaze / matte).
 */
export function patchSurfaceMaterial(mat: THREE.MeshStandardMaterial, rough: readonly [number, number] = [1, 0]): void {
  const roughU = { value: new THREE.Vector2(rough[0], rough[1]) };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, AO_UNIFORMS, { surfRough: roughU });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${AO_VERT_PARS}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${AO_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${AO_FRAG_PARS}\nuniform vec2 surfRough;`)
      .replace('roughnessFactor *= texelRoughness.g;', 'roughnessFactor *= clamp( texelRoughness.g * surfRough.x + surfRough.y, 0.04, 1.0 );')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${AO_FRAG}`);
  };
  mat.customProgramCacheKey = () => 'mute-room-ao';
  mat.needsUpdate = true;
}
