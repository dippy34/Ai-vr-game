/**
 * Dev-only check of avatar_head.glb + avatar_body.glb in three.js.
 *   /dev/hands/avatar.html            three players (tinted red / blue / yellow), studio light
 *   ?mood=flash                       black room, camera flash from the viewer
 * Composition used here (and suggested for the game): body origin = neck base, placed
 * HEAD_TO_NECK below/behind the head origin (eye centre) in the head's yaw frame.
 * Tint: the `tint` node's material colour is multiplied with its light-neutral texture.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const q = new URLSearchParams(location.search);
const mood = q.get('mood') ?? 'studio';
const info = document.getElementById('info')!;
/** Neck base relative to the eye centre (three.js, head yaw frame): 21.5 cm down, 6.3 cm back. */
export const HEAD_TO_NECK = new THREE.Vector3(0, -0.215, 0.063);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(mood === 'flash' ? 0x000000 : 0x2a2a2d);
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.05, 50);
camera.position.set(0, 1.62, 2.6);
camera.lookAt(0, 1.42, 0);

if (mood === 'flash') {
  scene.add(new THREE.HemisphereLight(0x8899cc, 0x000000, 0.05));
  const flash = new THREE.SpotLight(0xf2f5ff, 60, 10, THREE.MathUtils.degToRad(40), 0.4, 1.3);
  flash.position.copy(camera.position).add(new THREE.Vector3(0.05, 0.03, 0));
  flash.target.position.set(0, 1.4, 0);
  scene.add(flash, flash.target);
} else {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3530, 1.1));
  const key = new THREE.DirectionalLight(0xfff4ea, 2.0);
  key.position.set(2, 3, 2.5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xaabbff, 1.0);
  rim.position.set(-2, 2, -3);
  scene.add(rim);
}

const loader = new GLTFLoader();
Promise.all([loader.loadAsync('../../models/avatar_head.glb'), loader.loadAsync('../../models/avatar_body.glb')]).then(([gh, gb]) => {
  const players = [
    // game yaw: 0 = facing -Z (away from this camera), so +PI faces the viewer
    { color: 0xd0503c, x: -0.62, yaw: Math.PI + 0.25 },
    { color: 0x3c86d6, x: 0.0, yaw: Math.PI - 0.75 },
    { color: 0xe6c23a, x: 0.62, yaw: 0.35 },
  ];
  let tris = 0;
  for (const p of players) {
    const player = new THREE.Group();
    player.position.set(p.x, 0, 0);
    player.rotation.y = p.yaw;
    const head = gh.scene.clone(true);
    const body = gb.scene.clone(true);
    head.position.set(0, 1.62, 0);
    body.position.copy(head.position).add(HEAD_TO_NECK);
    for (const part of [head, body]) {
      part.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
        if (m.name === 'tint') {
          const mat = (m.material as THREE.MeshStandardMaterial).clone();
          mat.color.set(p.color);
          m.material = mat;
        }
      });
    }
    player.add(head, body);
    scene.add(player);
  }
  const names: string[] = [];
  gh.scene.traverse((o) => names.push(o.name));
  gb.scene.traverse((o) => names.push(o.name));
  const stats = { trianglesPerAvatar: Math.round(tris / players.length), nodes: names };
  (window as unknown as { __stats: unknown }).__stats = stats;
  info.textContent = q.get('shot') ? `MUTE avatar · head + body ${stats.trianglesPerAvatar} tris · tint = player colour` : JSON.stringify(stats);
  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
    (window as unknown as { __ready: boolean }).__ready = true;
  });
}).catch((err) => {
  info.textContent = `failed: ${String(err)}`;
  console.error(err);
});
