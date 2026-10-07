/**
 * The monster's skin and keratin (teeth / claws), made to read as horribly alive under the flash:
 *  - Skin: physically based (MeshPhysicalMaterial) with a wet clearcoat whose wetness is patchy
 *    (procedural mask over the UVs: slick in places, tacky in others), plus a fake subsurface term
 *    added inside the light loop for every light that reaches the pixel:
 *      wrap lighting (light bleeding past the terminator, tinted warm like blood under skin) and
 *      translucency (light through the thin parts, from behind: ears, fingers, the jaw flaps),
 *    where "thin" is a per-vertex value computed once from the bind pose (distance from the vertex
 *    to its main bone, so fingers / ears are thin, the torso and skull are not).
 *  - Keratin: glossy, slightly yellowed, a little translucent at the tips.
 *
 * Applied from GameRenderer to the skinned monster instance (its own materials: the library's
 * source materials are left alone). Shadows: the monster casts and receives the flash's shadow.
 */

import * as THREE from 'three';

const SKIN = {
  /** Warm subsurface colour (what bleeds through thin skin). */
  scatter: new THREE.Color(1.0, 0.36, 0.26),
  /** Wrap amount (0 = Lambert) and translucency strength. */
  wrap: 0.35,
  translucency: 2.2,
  clearcoat: 0.55,
  clearcoatRoughness: 0.08,
  /** Fine wet film / fuzz: edge brightening under frontal light (the flash). */
  sheen: 0.06,
  sheenColor: new THREE.Color(1.0, 0.8, 0.76),
  sheenRoughness: 0.45,
  /** Albedo tint: sallow, bloodless. */
  tint: new THREE.Color(0.72, 0.65, 0.63),
  /** Overall skin roughness multiplier (the texture's own variation is kept). */
  roughness: 0.9,
  /** Bone distances (m) mapped to thin = 1 .. 0. */
  thinNear: 0.014,
  thinFar: 0.075,
};

/** GLSL added to the light loop of these materials (after each light's normal BRDF). */
const SSS_FUNC = /* glsl */ `
varying float vThin;
uniform vec3 skinScatter;
uniform vec2 skinSss;
void muteSkinLight( const in IncidentLight L, const in vec3 N, const in vec3 V, const in vec3 albedo, inout ReflectedLight rl ) {
	float ndl = dot( N, L.direction );
	float w = skinSss.x * ( 0.4 + 0.6 * vThin );
	float wrapped = max( 0.0, ( ndl + w ) / ( 1.0 + w ) ) - max( 0.0, ndl );
	// Translucency: view through the surface toward the light (distorted by the normal).
	vec3 H = normalize( L.direction + N * 0.3 );
	float back = pow( saturate( dot( V, - H ) ), 4.0 ) * vThin * skinSss.y;
	rl.directDiffuse += L.color * RECIPROCAL_PI * skinScatter * ( albedo * wrapped * 1.4 + ( albedo + 0.08 ) * back );
}
`;

function wetMaskGlsl(): string {
  return /* glsl */ `
float muteWetHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float muteWetNoise( vec2 p ) {
	vec2 i = floor( p ), f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( muteWetHash( i ), muteWetHash( i + vec2( 1, 0 ) ), f.x ), mix( muteWetHash( i + vec2( 0, 1 ) ), muteWetHash( i + vec2( 1, 1 ) ), f.x ), f.y );
}
`;
}

function patchSkinShader(mat: THREE.MeshPhysicalMaterial, scatter: THREE.Color, wrap: number, translucency: number, wetUv: boolean): void {
  const uniforms = {
    skinScatter: { value: scatter.clone() },
    skinSss: { value: new THREE.Vector2(wrap, translucency) },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float thin;\nvarying float vThin;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvThin = thin;');
    // The light loop with the skin term after each light (three's chunk, already patched by fx/pipeline).
    const loop = THREE.ShaderChunk.lights_fragment_begin.replace(
      /if \( directLight\.visible \) RE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);/g,
      'if ( directLight.visible ) { RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight ); muteSkinLight( directLight, geometryNormal, geometryViewDir, material.diffuseColor, reflectedLight ); }',
    );
    let fs = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SSS_FUNC}\n${wetUv ? wetMaskGlsl() : ''}`)
      .replace('#include <lights_fragment_begin>', loop);
    if (wetUv) {
      // Patchy wetness: slick streaks and dry patches (clearcoat amount and roughness).
      fs = fs.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
	#ifdef USE_CLEARCOAT
	{
		vec2 wq = vMapUv * vec2( 9.0, 23.0 );
		float wet = muteWetNoise( wq ) * 0.65 + muteWetNoise( wq * 2.7 + 3.1 ) * 0.35;
		wet = smoothstep( 0.32, 0.75, wet );
		material.clearcoat *= mix( 0.25, 1.0, wet );
		material.clearcoatRoughness = mix( 0.42, material.clearcoatRoughness, wet );
	}
	#endif`);
    }
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => `mute-skin-${wetUv ? 'wet' : 'dry'}`;
}

/** Per-vertex thinness (0..1) from the distance to the vertex's main bone in the bind pose. */
export function computeThinness(mesh: THREE.SkinnedMesh, scale: number): Float32Array {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  const out = new Float32Array(pos.count);
  const skel = mesh.skeleton;
  if (!si || !sw || !skel) return out.fill(0.3);
  // Bone heads (and tails: first child bone) in mesh space at bind time.
  const head: THREE.Vector3[] = [];
  const tail: (THREE.Vector3 | null)[] = [];
  const m = new THREE.Matrix4();
  for (let b = 0; b < skel.bones.length; b++) {
    m.copy(skel.boneInverses[b]).invert().premultiply(mesh.bindMatrixInverse);
    head.push(new THREE.Vector3().setFromMatrixPosition(m));
  }
  for (let b = 0; b < skel.bones.length; b++) {
    const child = skel.bones[b].children.find((c) => (c as THREE.Bone).isBone) as THREE.Bone | undefined;
    const ci = child ? skel.bones.indexOf(child) : -1;
    tail.push(ci >= 0 ? head[ci] : null);
  }
  const p = new THREE.Vector3();
  const seg = new THREE.Line3();
  const q = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    let best = 0, bw = -1;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > bw) { bw = w; best = si.getComponent(i, k); }
    }
    const h = head[best];
    const t = tail[best];
    let d: number;
    if (h && t) {
      seg.set(h, t);
      seg.closestPointToPoint(p, true, q);
      d = q.distanceTo(p);
    } else d = h ? h.distanceTo(p) : 0.1;
    d *= scale;
    out[i] = 1 - THREE.MathUtils.smoothstep(d, SKIN.thinNear, SKIN.thinFar);
  }
  return out;
}

const made = new Map<THREE.Material, THREE.Material>();

function skinFrom(src: THREE.MeshStandardMaterial): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    map: src.map,
    normalMap: src.normalMap,
    normalScale: src.normalScale.clone().multiplyScalar(1.8),
    roughnessMap: src.roughnessMap,
    roughness: (src.roughness ?? 1) * SKIN.roughness,
    metalness: 0,
    color: src.color.clone().multiply(SKIN.tint),
    clearcoat: SKIN.clearcoat,
    clearcoatRoughness: SKIN.clearcoatRoughness,
    sheen: SKIN.sheen,
    sheenColor: SKIN.sheenColor,
    sheenRoughness: SKIN.sheenRoughness,
    specularIntensity: 0.6,
    ior: 1.4,
    side: src.side,
  });
  m.name = 'monster_skin_fx';
  patchSkinShader(m, SKIN.scatter, SKIN.wrap, SKIN.translucency, !!src.map);
  return m;
}

function keratinFrom(src: THREE.MeshStandardMaterial): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    map: src.map,
    color: src.color.clone().multiply(new THREE.Color(1.0, 0.95, 0.84)),
    roughness: Math.min(0.3, src.roughness ?? 0.3),
    metalness: 0,
    clearcoat: 0.8,
    clearcoatRoughness: 0.06,
    ior: 1.55,
    side: src.side,
  });
  m.name = 'monster_keratin_fx';
  patchSkinShader(m, new THREE.Color(1.0, 0.72, 0.42), 0.25, 0.9, false);
  return m;
}

/**
 * Give a monster instance the skin / keratin materials (meshes using 'monster_skin' /
 * 'monster_keratin') and make it cast and receive the flash's shadows.
 */
export function applyMonsterSkin(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const src = mesh.material as THREE.MeshStandardMaterial;
    if (Array.isArray(src) || !(src instanceof THREE.MeshStandardMaterial)) return;
    const skin = src.name.includes('skin');
    const keratin = src.name.includes('keratin');
    if (!skin && !keratin) return;
    let next = made.get(src);
    if (!next) {
      next = skin ? skinFrom(src) : keratinFrom(src);
      next.userData.shared = true;
      made.set(src, next);
    }
    const geo = mesh.geometry;
    if (!geo.getAttribute('thin')) {
      const s = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld);
      const thin = mesh.isSkinnedMesh ? computeThinness(mesh, (s.x + s.y + s.z) / 3) : new Float32Array(geo.getAttribute('position').count).fill(0.3);
      // Keratin (teeth / claws) is thin by nature.
      if (keratin) for (let i = 0; i < thin.length; i++) thin[i] = Math.max(thin[i], 0.6);
      geo.setAttribute('thin', new THREE.BufferAttribute(thin, 1));
    }
    mesh.material = next;
  });
}
