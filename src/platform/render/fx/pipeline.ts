/**
 * The look pipeline, done inside the materials' own shaders so it works in WebXR (no
 * post-processing passes there: three renders each eye straight into the XR framebuffer).
 *
 * installShaderFx() patches three's shared shader chunks once, before anything compiles:
 *  - Filmic tone mapping (CustomToneMapping = AgX with a contrast "look", see TONE below).
 *  - Fog: the scene's linear THREE.Fog stays the hard limit (fully fogged by fogFar, which the
 *    level's fog culling relies on) and is joined by exponential height fog (denser near the floor)
 *    whose density drifts slowly (cheap analytic noise at the view ray's midpoint). While the camera
 *    flash is lit, the haze along each view ray scatters its light (closed-form single scattering of
 *    a point light, masked by the flash cone): the flash "reveals" the air.
 *  - Finish (last thing every mesh material does): per-eye vignette from the view direction, film
 *    grain (multiplicative, so black stays black) and +-1 LSB triangular dither against banding in
 *    the dark gradients, plus an optional lateral-colour fringe at the edges (desktop).
 *  - Light loops skip the BRDF (and shadow / cookie lookups) for lights that don't reach the
 *    fragment: the flash lights are at intensity 0 almost all the time, and the near light only
 *    reaches ~2 m, so idle frames pay almost nothing for them.
 *
 * Every built-in material shares ONE uniform struct (`muteFx`, the FX object below): its value is
 * a plain object, which three's uniform cloning copies by reference, so updating FX once a frame
 * updates every program. Materials that never compiled these chunks are unaffected.
 *
 * Quality tiers only change uniform values / shadow settings at runtime (no recompiles when a
 * Quest enters or leaves VR).
 */

import * as THREE from 'three';
import { RENDER } from '../../../config';

export type RenderQuality = 'quest' | 'desktop';

/** Shared `muteFx` uniform struct (vec4 members, see GLSL_FX). */
export const FX = {
  /** xyz = flash position, w = flash brightness 0..1. */
  flashPos: new THREE.Vector4(0, -1000, 0, 0),
  /** xyz = flash direction, w = cos of the cone's half angle. */
  flashDir: new THREE.Vector4(0, 0, -1, 0.5),
  /** x = base density (1/m), y = height falloff (1/m), z = extra density at the floor, w = noise. */
  fog: new THREE.Vector4(0, 1, 0, 0),
  /** x = grain, y = vignette, z = fringe, w = frame counter (temporal noise). */
  post: new THREE.Vector4(0, 0, 0, 0),
  /** rgb = flash in-scatter colour (output space), w = strength. */
  haze: new THREE.Vector4(1, 1, 1, 0),
  /** x = time (s), y = floor height, z/w spare. */
  misc: new THREE.Vector4(0, 0, 0, 0),
};

const GLSL_FX = /* glsl */ `
struct MuteFx { vec4 flashPos; vec4 flashDir; vec4 fog; vec4 post; vec4 haze; vec4 misc; };
uniform MuteFx muteFx;
varying vec3 vMuteView;
`;

/**
 * AgX (three's constants) followed by a look in display space: contrast around middle grey with a
 * deeper toe (darkness stays dark), a little saturation back (AgX desaturates), and a shoulder
 * that rolls a burnt-out flash hotspot to white without hue skews. Measured against ACES and plain
 * AgX on the house at night (ACES crushed the dark-adapted range to black and turned flash-lit
 * wood orange; plain AgX lifted the blacks to grey).
 */
const TONE = /* glsl */ `
vec3 muteAgxContrast( vec3 x ) {
	vec3 x2 = x * x;
	vec3 x4 = x2 * x2;
	return + 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 CustomToneMapping( vec3 color ) {
	const mat3 LINEAR_SRGB_TO_LINEAR_REC2020_M = mat3(
		vec3( 0.6274, 0.0691, 0.0164 ), vec3( 0.3293, 0.9195, 0.0880 ), vec3( 0.0433, 0.0113, 0.8956 ) );
	const mat3 LINEAR_REC2020_TO_LINEAR_SRGB_M = mat3(
		vec3( 1.6605, - 0.1246, - 0.0182 ), vec3( - 0.5876, 1.1329, - 0.1006 ), vec3( - 0.0728, - 0.0083, 1.1187 ) );
	const mat3 AgXInsetMatrix = mat3(
		vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
		vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
		vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );
	const mat3 AgXOutsetMatrix = mat3(
		vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
		vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
		vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 ) );
	const float AgxMinEv = - 12.47393;
	const float AgxMaxEv = 4.026069;
	color *= toneMappingExposure;
	color = LINEAR_SRGB_TO_LINEAR_REC2020_M * color;
	color = AgXInsetMatrix * color;
	color = max( color, 1e-10 );
	color = clamp( ( log2( color ) - AgxMinEv ) / ( AgxMaxEv - AgxMinEv ), 0.0, 1.0 );
	color = muteAgxContrast( color );
	// Look (display-encoded): power = contrast / toe depth, then saturation.
	color = pow( max( color, 0.0 ), vec3( MUTE_TONE_POWER ) );
	float lumaT = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
	color = lumaT + MUTE_TONE_SATURATION * ( color - lumaT );
	color = AgXOutsetMatrix * color;
	color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
	color = LINEAR_REC2020_TO_LINEAR_SRGB_M * color;
	return clamp( color, 0.0, 1.0 );
}
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vMuteView = mvPosition.xyz;
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
{
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	float fogLen = max( length( vMuteView ), 1e-4 );
	// World-space ray camera -> fragment (viewMatrix is orthonormal: inverse rotation = transpose).
	vec3 fogRay = ( vec4( vMuteView, 0.0 ) * viewMatrix ).xyz;
	float fogDens = 0.0;
	if ( muteFx.fog.x > 0.0 ) {
		// Mean of exp(-k * height) along the ray: analytic integral of the height falloff.
		float hk = muteFx.fog.y;
		float y0 = max( cameraPosition.y - muteFx.misc.y, 0.0 );
		float y1 = max( cameraPosition.y + fogRay.y - muteFx.misc.y, 0.0 );
		float e0 = exp( - hk * y0 );
		float e1 = exp( - hk * y1 );
		float dy = y1 - y0;
		float hMean = abs( dy ) > 0.02 ? ( e0 - e1 ) / ( hk * dy ) : 0.5 * ( e0 + e1 );
		// Slowly drifting density at the ray's midpoint (cheap: three sines, no texture).
		float t = muteFx.misc.x;
		vec3 q = cameraPosition + fogRay * 0.5;
		float nz = sin( q.x * 1.37 + 0.6 * sin( q.z * 0.91 + t * 0.13 ) + t * 0.05 ) * sin( q.z * 1.13 + q.y * 1.9 - t * 0.07 );
		fogDens = muteFx.fog.x * ( 1.0 + muteFx.fog.z * hMean ) * ( 1.0 + muteFx.fog.w * nz );
		fogFactor = max( fogFactor, 1.0 - exp( - fogDens * fogLen ) );
	}
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
	#ifdef OPAQUE
	if ( muteFx.flashPos.w > 0.0 && fogDens > 0.0 ) {
		// Single scattering of the flash along the view ray: integral of 1 / dist^2 to the light.
		vec3 fv = fogRay / fogLen;
		vec3 fm = cameraPosition - muteFx.flashPos.xyz;
		float fb = dot( fm, fv );
		float fh = sqrt( max( dot( fm, fm ) - fb * fb, 0.0625 ) );
		float fI = ( atan( ( fogLen + fb ) / fh ) - atan( fb / fh ) ) / fh;
		// Inside the cone? (tested a little past the ray's closest approach to the flash)
		vec3 fq = fm + fv * min( clamp( - fb, 0.0, fogLen ) + 0.7, fogLen );
		float fc = dot( fq, muteFx.flashDir.xyz ) / max( length( fq ), 1e-4 );
		float cone = smoothstep( muteFx.flashDir.w - 0.2, muteFx.flashDir.w + 0.15, fc );
		vec3 scatter = muteFx.haze.rgb * ( muteFx.haze.w * muteFx.flashPos.w * fogDens * fI * cone );
		gl_FragColor.rgb = 1.0 - ( 1.0 - gl_FragColor.rgb ) * exp( - scatter );
	}
	#endif
}
#endif
`;

const DITHERING_PARS_FRAGMENT = /* glsl */ `
#ifdef DITHERING
	vec3 dithering( vec3 color ) {
		float grid_position = rand( gl_FragCoord.xy );
		vec3 dither_shift_RGB = vec3( 0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0 );
		dither_shift_RGB = mix( 2.0 * dither_shift_RGB, -2.0 * dither_shift_RGB, grid_position );
		return color + dither_shift_RGB;
	}
#endif
#ifdef TONE_MAPPING
	float muteIgn( vec2 p ) {
		return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
	}
	// Output-space finish: vignette (+ fringe), grain, dither.
	vec3 muteFinish( vec3 c ) {
		// tan of the angles off this eye's view axis (per eye in XR).
		vec2 ta = vMuteView.xy / max( - vMuteView.z, 1e-3 );
		float r2 = dot( ta, ta );
		float vg = muteFx.post.y;
		float fr = muteFx.post.z;
		vec3 vig = 1.0 - vg * smoothstep( vec3( 0.05 + 0.14 * fr, 0.05, 0.05 - 0.04 * fr ), vec3( 1.9 + 0.5 * fr, 1.9, 1.9 - 0.45 * fr ), vec3( r2 ) );
		c *= vig;
		vec2 fc = gl_FragCoord.xy + 5.588238 * mod( muteFx.post.w, 64.0 );
		float n1 = muteIgn( fc );
		float n2 = muteIgn( fc.yx + vec2( 37.0, 71.0 ) );
		float tri = n1 + n2 - 1.0;
		float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
		// Grain: strongest in the shadows-to-mids, none in pure black or burnt white.
		c *= 1.0 + muteFx.post.x * tri * ( 1.0 - l ) * smoothstep( 0.0, 0.06, l ) * 2.0;
		float d = tri / 255.0;
		#ifndef OPAQUE
		d *= clamp( l * 96.0, 0.0, 1.0 );
		#endif
		return c + d;
	}
#endif
`;

const DITHERING_FRAGMENT = /* glsl */ `
#ifdef DITHERING
	gl_FragColor.rgb = dithering( gl_FragColor.rgb );
#endif
#ifdef TONE_MAPPING
	gl_FragColor.rgb = muteFinish( gl_FragColor.rgb );
#endif
`;

let installed = false;

/** Patch one chunk with a find/replace that must match (warns and leaves it alone otherwise). */
function patchChunk(name: string, edit: (src: string) => string): void {
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  const src = chunks[name];
  const out = typeof src === 'string' ? edit(src) : src;
  if (typeof src !== 'string' || out === src) {
    console.warn(`[fx] shader chunk ${name} did not match; left as is`);
    return;
  }
  chunks[name] = out;
}

/** Install the shader chunk overrides (idempotent; call before the first render/compile). */
export function installShaderFx(): void {
  if (installed) return;
  installed = true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  chunks.common = chunks.common + GLSL_FX;
  patchChunk('project_vertex', (s) => `${s}\nvMuteView = mvPosition.xyz;\n`);
  chunks.fog_vertex = FOG_VERTEX;
  chunks.fog_pars_fragment = FOG_PARS_FRAGMENT;
  chunks.fog_fragment = FOG_FRAGMENT;
  chunks.dithering_pars_fragment = DITHERING_PARS_FRAGMENT;
  chunks.dithering_fragment = DITHERING_FRAGMENT;
  const tone = TONE
    .replace(/MUTE_TONE_POWER/g, RENDER.tonePower.toFixed(4))
    .replace(/MUTE_TONE_SATURATION/g, RENDER.toneSaturation.toFixed(4));
  patchChunk('tonemapping_pars_fragment', (s) => s.replace(/vec3 CustomToneMapping\( vec3 color \) \{ return color; \}/, tone));
  // Light loops: no BRDF / shadow / cookie work for lights that don't reach this fragment.
  patchChunk('lights_fragment_begin', (s) => s
    .replace(/directLight\.color \*= \( directLight\.visible && receiveShadow \) \? (.+) : 1\.0;/g,
      'if ( directLight.visible && receiveShadow ) directLight.color *= $1;')
    .replace(/(\t*)RE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);/g,
      '$1if ( directLight.visible ) RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );')
    .replace('spotLightCoord = vSpotLightCoord[ i ].xyz / vSpotLightCoord[ i ].w;', 'if ( directLight.visible ) {\n\t\t\tspotLightCoord = vSpotLightCoord[ i ].xyz / vSpotLightCoord[ i ].w;')
    .replace('directLight.color = inSpotLightMap ? directLight.color * spotColor.rgb : directLight.color;', 'directLight.color = inSpotLightMap ? directLight.color * spotColor.rgb : directLight.color;\n\t\t\t}'));
  // Every built-in material's uniforms reference the one FX object.
  for (const lib of Object.values(THREE.ShaderLib) as { uniforms: Record<string, THREE.IUniform> }[]) {
    lib.uniforms.muteFx = { value: FX };
  }
}

/** Tunables that differ per quality tier (RENDER.tiers). */
export type TierSettings = (typeof RENDER.tiers)[RenderQuality];

/** `?quality=quest|desktop` forces a tier (desktop testing of the Quest path). */
export function forcedQuality(): RenderQuality | null {
  if (typeof location === 'undefined') return null;
  const q = new URLSearchParams(location.search).get('quality');
  return q === 'quest' || q === 'desktop' ? q : null;
}

/** RENDER.quality, with 'auto' = 'quest' while an XR session presents, else 'desktop'. */
export function pickQuality(setting: string, presenting: boolean, forced: RenderQuality | null = null): RenderQuality {
  if (forced) return forced;
  if (setting === 'quest' || setting === 'desktop') return setting;
  return presenting ? 'quest' : 'desktop';
}

/** Per-frame FX values that don't come from the flash. */
export function setFxFrame(time: number, frame: number, tier: TierSettings): void {
  FX.misc.x = time;
  FX.post.set(tier.grain, tier.vignette, tier.fringe, frame);
  FX.fog.set(RENDER.fogDensity, RENDER.fogHeightFalloff, RENDER.fogGroundBoost, tier.fogNoise);
  FX.haze.set(RENDER.hazeColor[0], RENDER.hazeColor[1], RENDER.hazeColor[2], RENDER.hazeStrength);
}
