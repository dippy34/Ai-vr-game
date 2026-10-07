/**
 * Moonlight through the windows: soft volumetric shafts, the window's light pool (with the
 * mullion shadows) on the floor, and slow dust motes that glow where they drift through a shaft
 * (or light up for an instant in the camera flash). All additive, no real lights:
 *  - shafts + pools: the level's two existing merged meshes (one draw call each), with materials
 *    that fade the shaft's sides when seen edge-on or from inside, add drifting density and a slow
 *    "cloud over the moon" breathing shared by shafts and pools;
 *  - motes: ONE Points draw call for the whole house, a box of dust that wraps around the viewer
 *    (positions are computed in the vertex shader; brightness from the window list below and the
 *    flash in the shared FX uniforms).
 */

import * as THREE from 'three';
import { FX } from './pipeline';

/** Elevation of the moonlight (rad) as it comes in through the windows. */
export const MOON_ELEVATION = THREE.MathUtils.degToRad(38);
/** Max windows the motes know about. */
const MAX_WINDOWS = 16;

export interface MoonWindow {
  /** Center of the pane (world). */
  center: THREE.Vector3;
  /** Unit vector into the room (horizontal). */
  inward: THREE.Vector3;
  width: number;
  height: number;
  /** 1 = open, lower for boarded (light leaks between the planks). */
  light: number;
}

/** Slow breathing of the moonlight (clouds), GLSL, uses muteFx.misc.x = time. */
const CLOUDS = /* glsl */ `
float muteClouds() {
	float t = muteFx.misc.x;
	return 0.82 + 0.18 * sin( t * 0.071 + 1.3 ) * sin( t * 0.029 + 0.4 ) + 0.06 * sin( t * 0.23 );
}
`;

/** Shafts: MeshBasicMaterial (additive, map = shaftTexture) with view-dependent fades. */
export function moonShaftMaterial(map: THREE.Texture, color: THREE.ColorRepresentation): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    map, color, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShaftW;\nvarying vec3 vShaftN;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvShaftW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvShaftN = normalize( mat3( modelMatrix ) * normal );');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vShaftW;\nvarying vec3 vShaftN;\n${CLOUDS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
	{
		vec3 toEye = cameraPosition - vShaftW;
		float dEye = length( toEye );
		// Sides seen edge-on would be hard lines; inside the shaft, its near faces fade out.
		float faceOn = abs( dot( vShaftN, toEye / max( dEye, 1e-4 ) ) );
		float k = smoothstep( 0.0, 0.45, faceOn ) * smoothstep( 0.2, 1.4, dEye );
		// Drifting dust density.
		float t = muteFx.misc.x;
		vec3 p = vShaftW * 2.1 + vec3( t * 0.04, - t * 0.025, t * 0.03 );
		float n = 0.78 + 0.22 * sin( p.x + sin( p.y * 1.7 + t * 0.1 ) ) * sin( p.z * 1.3 - p.y * 0.8 );
		// The mullion cross's shadow planes run down the middle of each face (u = 0.5).
		float mull = mix( 0.4, 1.0, smoothstep( 0.012, 0.045 + 0.05 * vMapUv.y, abs( vMapUv.x - 0.5 ) ) );
		diffuseColor.rgb *= k * n * mull * muteClouds();
	}`);
  };
  m.customProgramCacheKey = () => 'mute-moon-shaft';
  return m;
}

/** Light pools on the floor: additive, breathing with the shafts. */
export function moonPatchMaterial(map: THREE.Texture, color: THREE.ColorRepresentation): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    map, color, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2,
  });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CLOUDS}`)
      .replace('#include <map_fragment>', '#include <map_fragment>\n\tdiffuseColor.rgb *= muteClouds();');
  };
  m.customProgramCacheKey = () => 'mute-moon-patch';
  return m;
}

/** Window-pool cookie: the pane's light with soft mullion shadows (crisp near the wall). */
export function moonCookieTexture(): THREE.Texture {
  const W = 128, H = 128;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    // v = 0: the edge nearest the window wall (crisp), v = 1: the far edge (softer, dimmer).
    const v = y / (H - 1);
    const blur = THREE.MathUtils.lerp(0.025, 0.06, v);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const box = (a: number, e: number): number => THREE.MathUtils.smoothstep(a, 0, e) * THREE.MathUtils.smoothstep(a, 1, 1 - e);
      const pane = box(u, blur * 1.4) * box(v, blur * 1.4);
      // Mullion cross (frame shadow) and a slight glass ripple.
      const mull = (c: number): number => THREE.MathUtils.smoothstep(Math.abs(c - 0.5), 0.018, 0.018 + blur);
      const ripple = 0.93 + 0.07 * Math.sin(u * 37 + Math.sin(v * 11) * 2.2) * Math.sin(v * 29);
      const b = pane * mull(u) * mull(v) * ripple * THREE.MathUtils.lerp(1, 0.75, v);
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(255 * Math.max(0, Math.min(1, b)));
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, W, H);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  t.userData.shared = true;
  return t;
}

const MOTE_VERT = /* glsl */ `
#include <common>
attribute vec4 seed;
uniform vec4 uWin[ ${MAX_WINDOWS * 2} ];
uniform int uWinCount;
uniform float uBox;
uniform float uPixel;
uniform vec2 uMoonTrig;
uniform vec2 uGain;
varying float vBright;
${CLOUDS}
void main() {
	float t = muteFx.misc.x;
	float ph = seed.w * 6.2831;
	vec3 p = seed.xyz * uBox + vec3(
		sin( t * 0.11 + ph ) * 0.18 + t * 0.006,
		sin( t * 0.07 + ph * 1.7 ) * 0.07 - t * 0.011,
		cos( t * 0.09 + ph * 2.3 ) * 0.18 );
	// A box of dust that wraps around the viewer (world-stable while you move).
	vec3 rel = mod( p - cameraPosition + 0.5 * uBox, uBox ) - 0.5 * uBox;
	vec3 wp = cameraPosition + rel;
	float edge = 1.0 - smoothstep( 0.3 * uBox, 0.5 * uBox, length( rel ) );
	// Moonlight: back-project along each window's moon ray onto its pane.
	float moon = 0.0;
	for ( int i = 0; i < ${MAX_WINDOWS}; i ++ ) {
		if ( i >= uWinCount ) break;
		vec4 a = uWin[ i * 2 ];
		vec4 b = uWin[ i * 2 + 1 ];
		vec3 d = wp - a.xyz;
		float along = dot( d.xz, b.xz );
		float tau = along / uMoonTrig.x;
		vec3 onPane = d - vec3( b.x * uMoonTrig.x, - uMoonTrig.y, b.z * uMoonTrig.x ) * tau;
		float u = abs( onPane.x * b.z - onPane.z * b.x );
		float v = abs( onPane.y );
		float inside = ( 1.0 - smoothstep( a.w * 0.8, a.w, u ) ) * ( 1.0 - smoothstep( b.y * 0.8, b.y, v ) );
		float mull = smoothstep( 0.01, 0.035, u ) * smoothstep( 0.01, 0.035, v );
		moon += b.w * inside * mull * step( 0.0, along ) * step( 0.02, wp.y ) * exp( - tau * 0.35 );
	}
	moon *= muteClouds();
	// Camera flash: inverse square, inside the cone.
	vec3 fl = wp - muteFx.flashPos.xyz;
	float dl2 = dot( fl, fl );
	float cone = smoothstep( muteFx.flashDir.w - 0.1, muteFx.flashDir.w + 0.08, dot( fl, muteFx.flashDir.xyz ) * inversesqrt( max( dl2, 1e-4 ) ) );
	float flash = muteFx.flashPos.w * cone / ( dl2 + 0.25 );
	vec4 mv = viewMatrix * vec4( wp, 1.0 );
	gl_Position = projectionMatrix * mv;
	float sizePx = uPixel * ( 0.0035 + 0.004 * fract( seed.w * 7.31 ) ) / max( - mv.z, 0.05 );
	float bright = min( 1.4, moon * uGain.x + flash * uGain.y ) * edge;
	// Sub-pixel motes keep a 1.5 px footprint and dim with their area (no shimmer).
	bright *= min( 1.0, sizePx * sizePx / 2.25 );
	gl_PointSize = max( sizePx, 1.5 );
	vBright = bright;
	if ( bright < 0.003 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}
`;

const MOTE_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vBright;
void main() {
	vec2 c = gl_PointCoord * 2.0 - 1.0;
	float a = max( 0.0, 1.0 - dot( c, c ) );
	gl_FragColor = vec4( uColor * vBright * a * a, 1.0 );
}
`;

/** Dust motes around the viewer (one draw call). */
export class DustMotes {
  readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;
  private readonly win: THREE.Vector4[];

  constructor(maxCount: number, box = 5.5) {
    const seed = new Float32Array(maxCount * 4);
    let s = 1234567;
    const rnd = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    for (let i = 0; i < seed.length; i++) seed[i] = rnd();
    const g = new THREE.BufferGeometry();
    // Positions are computed in the shader; three still wants a position attribute.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxCount * 3), 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    this.win = Array.from({ length: MAX_WINDOWS * 2 }, () => new THREE.Vector4());
    this.mat = new THREE.ShaderMaterial({
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      uniforms: {
        muteFx: { value: FX },
        uWin: { value: this.win },
        uWinCount: { value: 0 },
        uBox: { value: box },
        uPixel: { value: 500 },
        uMoonTrig: { value: new THREE.Vector2(Math.cos(MOON_ELEVATION), Math.sin(MOON_ELEVATION)) },
        uGain: { value: new THREE.Vector2(0.55, 0.5) },
        uColor: { value: new THREE.Color(0.62, 0.7, 0.86) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.name = 'dustMotes';
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  /** The windows the moonlight comes through (call when the level changes). */
  setWindows(list: readonly MoonWindow[]): void {
    const n = Math.min(MAX_WINDOWS, list.length);
    for (let i = 0; i < n; i++) {
      const w = list[i];
      this.win[i * 2].set(w.center.x, w.center.y, w.center.z, w.width / 2);
      this.win[i * 2 + 1].set(w.inward.x, w.height / 2, w.inward.z, w.light);
    }
    this.mat.uniforms.uWinCount.value = n;
  }

  /** How many motes to draw, and px per meter at 1 m (for point sizes). */
  setCount(n: number): void {
    this.points.geometry.setDrawRange(0, Math.min(n, (this.points.geometry.getAttribute('seed') as THREE.BufferAttribute).count));
  }

  setPixelScale(pxPerMeterAt1m: number): void {
    this.mat.uniforms.uPixel.value = pxPerMeterAt1m;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}
