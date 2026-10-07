/**
 * Lens glare on someone else's camera flash: a hot core, a soft halo and a thin horizontal streak
 * at the flash, strongest when it is aimed at you. A world-space billboard (correct per eye in VR,
 * hidden by walls through the depth test), drawn only while the flash is lit: one draw call for
 * ~0.2 s. The local player's own flash never glares (they are behind the lens).
 */

import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	// Billboard: the quad's corners spread in view space around the anchor.
	vec4 mv = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
	mv.xy += position.xy;
	// Pulled toward the viewer so the camera body it sits in doesn't hide it.
	mv.xyz *= max( 0.0, 1.0 - 0.18 / max( length( mv.xyz ), 1e-3 ) );
	gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform float uK;
uniform float uStreak;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
	vec2 p = vUv * 2.0 - 1.0;
	float r = length( p );
	float core = exp( - r * r * 160.0 ) * 2.2;
	float halo = exp( - r * 7.0 ) * 0.42;
	float streak = exp( - abs( p.y ) * 140.0 ) * exp( - abs( p.x ) * 2.6 ) * 0.55 * uStreak;
	float rays = pow( max( 0.0, cos( atan( p.y, p.x ) * 6.0 ) ), 24.0 ) * exp( - r * 9.0 ) * 0.35;
	vec3 c = uColor * ( core + halo + streak + rays ) * uK;
	gl_FragColor = vec4( c, 1.0 );
}
`;

export class FlashGlare {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  /** Set by the quality tier (desktop: anamorphic streak). */
  streak = 1;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uK: { value: 0 }, uStreak: { value: 1 }, uColor: { value: new THREE.Color(0.95, 0.97, 1.0) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), this.mat);
    this.mesh.name = 'flashGlare';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 18;
    this.mesh.visible = false;
  }

  /**
   * `k` = flash brightness 0..1, `facing` = how directly it is aimed at the viewer (0..1),
   * `local` = the viewer fired it (no glare).
   */
  update(position: THREE.Vector3, k: number, facing: number, local: boolean): void {
    const g = local ? 0 : k * (0.25 + 0.75 * facing * facing);
    this.mesh.visible = g > 0.01;
    if (!this.mesh.visible) return;
    this.mesh.position.copy(position);
    this.mesh.updateMatrixWorld();
    this.mat.uniforms.uK.value = g;
    this.mat.uniforms.uStreak.value = this.streak;
  }

  /** For renderer.compile() warm-up. */
  setWarmupVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
