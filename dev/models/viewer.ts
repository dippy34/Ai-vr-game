/**
 * Dev-only GLB viewer, used to check models exactly as three.js (the game renderer) sees them.
 *   /dev/models/?model=monster                 studio light, auto framing
 *   &anim=Walk&t=0.4                           play an animation, freeze at t seconds (omit t = play)
 *   &yaw=35&pitch=15                           camera angles (yaw 0 = looking at the model's front)
 *   &mood=flash                                black room lit only by a camera flash (in-game look)
 *   &wire=1                                    wireframe overlay
 * Writes stats (triangles, materials, textures, animations, bones, size) into #info and
 * window.__stats, and sets window.__ready = true when the frame is rendered.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const q = new URLSearchParams(location.search);
const name = q.get('model') ?? 'monster';
const mood = q.get('mood') ?? 'studio';
const yaw = THREE.MathUtils.degToRad(Number(q.get('yaw') ?? 35));
const pitch = THREE.MathUtils.degToRad(Number(q.get('pitch') ?? 15));
const info = document.getElementById('info')!;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(mood === 'flash' ? 0x000000 : 0x2e2e30);
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 100);

if (mood === 'flash') {
  scene.add(new THREE.HemisphereLight(0x8899cc, 0x000000, 0.04));
} else {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(2, 3, 2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xaabbff, 1.0);
  rim.position.set(-2, 1.5, -2);
  scene.add(rim);
}

new GLTFLoader().load(
  `../../models/${name}.glb`,
  (gltf) => {
    const root = gltf.scene;
    scene.add(root);
    let tris = 0;
    let bones = 0;
    const mats = new Set<THREE.Material>();
    const texs = new Set<string>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        const g = m.geometry;
        tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          mats.add(mat);
          for (const v of Object.values(mat)) {
            if (v instanceof THREE.Texture && v.image) texs.add(`${v.name || '?'} ${v.image.width}x${v.image.height}`);
          }
          if (q.get('wire')) (mat as THREE.MeshStandardMaterial).wireframe = true;
        }
      }
      if ((o as THREE.Bone).isBone) bones++;
    });

    let mixer: THREE.AnimationMixer | null = null;
    const animName = q.get('anim');
    if (animName && gltf.animations.length) {
      mixer = new THREE.AnimationMixer(root);
      const clip = gltf.animations.find((a) => a.name === animName) ?? gltf.animations[0];
      mixer.clipAction(clip).play();
      const t = q.get('t');
      if (t !== null) mixer.setTime(Number(t));
    }

    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = size.length() / 2;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
    // yaw 0 = camera in front of the model (model faces -Z, so camera sits at -Z looking toward +Z)
    camera.position.set(
      center.x - Math.sin(yaw) * Math.cos(pitch) * dist,
      center.y + Math.sin(pitch) * dist,
      center.z - Math.cos(yaw) * Math.cos(pitch) * dist,
    );
    camera.lookAt(center);

    if (mood === 'flash') {
      const flash = new THREE.SpotLight(0xf2f5ff, 60, dist * 3, THREE.MathUtils.degToRad(40), 0.4, 1.5);
      flash.position.copy(camera.position);
      flash.target.position.copy(center);
      scene.add(flash, flash.target);
    }

    const stats = {
      triangles: Math.round(tris),
      materials: mats.size,
      textures: [...texs],
      animations: gltf.animations.map((a) => `${a.name} (${a.duration.toFixed(2)}s)`),
      bones,
      size: size.toArray().map((v) => +v.toFixed(3)),
      nodes: root.children.map((c) => c.name),
    };
    (window as unknown as { __stats: unknown }).__stats = stats;
    info.textContent = `${name}\n${JSON.stringify(stats, null, 1)}`;

    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      if (mixer && q.get('t') === null) mixer.update(clock.getDelta());
      renderer.render(scene, camera);
      (window as unknown as { __ready: boolean }).__ready = true;
    });
  },
  undefined,
  (err) => {
    info.textContent = `failed to load ${name}: ${String(err)}`;
    console.error(err);
  },
);
