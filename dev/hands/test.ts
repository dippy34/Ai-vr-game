/**
 * Dev-only check of the rigged hand GLBs with the game's sign presets.
 *   /dev/hands/                 studio light, rows: right (signer view), right (teammate view),
 *                               left (signer view), left (teammate view); columns: SIGN_PRESETS
 *   &mood=flash                 black room lit by a camera flash from the viewer
 *   &t=0.35                     time into the animated "come here" sign
 * Curl convention (from the GLB extras, see art/blender/hands.py):
 *   bone.quaternion = rest * axisAngle(bone.userData.curlAxis, curlSign * curls[finger] * curlAngle)
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { SIGN_PRESETS, signCurlsAt } from '../../src/platform/input/signs';
import { frameFromFingersBack } from '../../src/platform/input/handMath';
import type { FingerCurls, Handedness, Vec3 } from '../../src/core/types';

const q = new URLSearchParams(location.search);
const mood = q.get('mood') ?? 'studio';
const tAnim = Number(q.get('t') ?? 0.35);
const info = document.getElementById('info')!;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(mood === 'flash' ? 0x000000 : 0x2a2a2d);
const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.01, 50);
camera.position.set(0, 0, 0);

if (mood === 'flash') {
  scene.add(new THREE.HemisphereLight(0x8899cc, 0x000000, 0.05));
  const flash = new THREE.SpotLight(0xf2f5ff, 40, 8, THREE.MathUtils.degToRad(50), 0.5, 1.2);
  flash.position.set(0, 0.05, 0.1);
  flash.target.position.set(0, 0, -2);
  scene.add(flash, flash.target);
} else {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3530, 1.1));
  const key = new THREE.DirectionalLight(0xfff4ea, 2.0);
  key.position.set(1.5, 2.5, 1.5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xaabbff, 0.8);
  rim.position.set(-2, 1, -3);
  scene.add(rim);
}

const mirrorX = (v: Vec3): Vec3 => ({ x: -v.x, y: v.y, z: v.z });

interface CurlBone {
  bone: THREE.Bone;
  rest: THREE.Quaternion;
  axis: THREE.Vector3;
  angle: number;
  finger: number;
}

/** Collect curl data from glTF extras (three.js puts them in userData). */
function curlBones(root: THREE.Object3D): CurlBone[] {
  const out: CurlBone[] = [];
  root.traverse((o) => {
    const ud = o.userData as { curlAxis?: number[]; curlAngle?: number; finger?: number };
    if ((o as THREE.Bone).isBone && ud.curlAxis) {
      out.push({
        bone: o as THREE.Bone,
        rest: o.quaternion.clone(),
        axis: new THREE.Vector3().fromArray(ud.curlAxis).normalize(),
        angle: ud.curlAngle ?? 0,
        finger: ud.finger ?? 0,
      });
    }
  });
  return out;
}

const _q = new THREE.Quaternion();
function applyCurls(bones: CurlBone[], curls: FingerCurls, sign: number): void {
  for (const b of bones) {
    _q.setFromAxisAngle(b.axis, sign * curls[b.finger] * b.angle);
    b.bone.quaternion.copy(b.rest).multiply(_q);
  }
}

const loader = new GLTFLoader();
const load = (name: string) => loader.loadAsync(`../../models/${name}.glb`);

function pairView(gr: THREE.Group, gl: THREE.Group): void {
  // Both hands flat, back up, seen from above with a grazing light from +X: raised detail
  // (tendons, veins, knuckles) must be lit on the +X side on BOTH hands (mirror/tangent check).
  scene.clear();
  scene.background = new THREE.Color(0x202022);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 0.25));
  const sun = new THREE.DirectionalLight(0xffffff, 3.0);
  sun.position.set(3, 0.6, 0);
  scene.add(sun);
  const zoom = q.get('zoom') === '1';
  [gr, gl].forEach((g, i) => {
    g.position.set(i === 0 ? 0.06 : -0.06, 0, zoom ? -0.04 : -0.08);
    scene.add(g);
  });
  camera.position.set(0, zoom ? 0.2 : 0.42, zoom ? -0.04 : -0.08);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, zoom ? -0.04 : -0.08);
  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
    (window as unknown as { __ready: boolean }).__ready = true;
  });
}

Promise.all([load('hand_right'), load('hand_left')]).then(([gr, gl]) => {
  if (q.get('pair')) {
    pairView(gr.scene, gl.scene);
    return;
  }
  const src: Record<Handedness, THREE.Group> = { right: gr.scene, left: gl.scene };
  const cols = SIGN_PRESETS.length;
  const rows: { hand: Handedness; view: 'signer' | 'teammate'; label: string }[] = [
    { hand: 'right', view: 'signer', label: 'right · own view' },
    { hand: 'right', view: 'teammate', label: 'right · seen by teammate' },
    { hand: 'left', view: 'signer', label: 'left · own view' },
    { hand: 'left', view: 'teammate', label: 'left · seen by teammate' },
  ];
  const dist = 2.05;
  const dx = 0.255;
  const dy = 0.262;
  let tris = 0;
  const yaw180 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const labels: { text: string; pos: THREE.Vector3; cls: string }[] = [];
  rows.forEach((row, ri) => {
    SIGN_PRESETS.forEach((preset, ci) => {
      const inst = SkeletonUtils.clone(src[row.hand]);
      const extras = (src[row.hand].children[0]?.userData ?? {}) as { curlSign?: number };
      const bones = curlBones(inst);
      const curls = preset.animated ? signCurlsAt(preset, tAnim) : preset.curls;
      applyCurls(bones, curls, extras.curlSign ?? 1);
      const m = row.hand === 'right' ? (v: Vec3) => v : mirrorX;
      const r = frameFromFingersBack(m(preset.fingers), m(preset.back));
      const rot = new THREE.Quaternion(r.x, r.y, r.z, r.w);
      if (row.view === 'teammate') rot.premultiply(yaw180);
      const holder = new THREE.Group();
      holder.quaternion.copy(rot);
      holder.add(inst);
      // centre the cell on the palm (8 cm from the wrist toward the fingers)
      const palm = new THREE.Vector3(0, 0.005, -0.075).applyQuaternion(rot);
      const cx = (ci - (cols - 1) / 2) * dx;
      const cy = ((rows.length - 1) / 2 - ri) * dy - 0.02;
      holder.position.set(cx, cy, -dist).sub(palm);
      scene.add(holder);
      inst.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.frustumCulled = false;
          const g = mesh.geometry;
          tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
        }
      });
      if (ri === 0) labels.push({ text: `${preset.key} · ${preset.name}`, pos: new THREE.Vector3(cx, cy + 0.155, -dist), cls: 'label' });
    });
    labels.push({ text: row.label, pos: new THREE.Vector3(-((cols - 1) / 2) * dx - 0.115, ((rows.length - 1) / 2 - ri) * dy + 0.105, -dist), cls: 'row' });
  });
  for (const l of labels) {
    const p = l.pos.clone().project(camera);
    const div = document.createElement('div');
    div.className = l.cls;
    div.textContent = l.text;
    div.style.left = `${((p.x + 1) / 2) * innerWidth}px`;
    div.style.top = `${((1 - p.y) / 2) * innerHeight}px`;
    document.body.appendChild(div);
  }
  const ex = gr.scene.children[0]?.userData;
  const stats = { trianglesPerHand: Math.round(tris / (rows.length * cols)), extras: ex };
  info.textContent = q.get('shot') ? `MUTE hands · ${stats.trianglesPerHand} tris/hand · curls from SIGN_PRESETS` : JSON.stringify(stats);
  (window as unknown as { __stats: unknown }).__stats = stats;
  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
    (window as unknown as { __ready: boolean }).__ready = true;
  });
}).catch((err) => {
  info.textContent = `failed: ${String(err)}`;
  console.error(err);
});
