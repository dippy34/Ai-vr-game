/**
 * Render module preview: mock level + fake world state. Not part of the game build.
 *
 *   npx vite --port 5174   ->   http://localhost:5174/dev/render/index.html
 *
 * URL params:
 *   view=signs|room|roomB|monster|meter|exit|wide   camera preset (default signs)
 *   bright=1     add a strong debug light to inspect geometry
 *   manual=1     no auto loop; drive frames with window.preview.step(n, dt)
 *   noflash=1    don't auto-flash every 3 s
 *   flashBy=p3   who fires the auto flash (default: me)
 *   open=1       fuses all in + exit open
 *   level=real   use src/core/level createLevel(seed) instead of the mock (view=spawn recommended)
 * Desktop: drag to look, WASD to move, F = flash, M = message.
 */

import * as THREE from 'three';
import { GameRenderer } from '../../src/platform/render/GameRenderer';
import type {
  FingerCurls, FlashEvent, HandPose, ItemState, PlayerPose, PlayerState, Quat, Vec3, WorldState,
} from '../../src/core/types';
import { mockLevel } from './mockLevel';
import { createLevel } from '../../src/core/level';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'signs';
const manual = params.has('manual');
const autoFlash = !params.has('noflash');
const flashBy = params.get('flashBy') ?? 'me';
const open = params.has('open');
const p2Sign = (params.get('sign') ?? 'stop') as 'stop';

const app = document.getElementById('app')!;
const hud = document.getElementById('hud')!;
const gr = new GameRenderer(app);
// level=real uses the core level generator (if it is implemented), else the mock.
const level = params.get('level') === 'real' ? createLevel(Number(params.get('seed') ?? 1)) : mockLevel();
gr.loadLevel(level);
if (params.has('bright')) {
  gr.ctx.scene.add(new THREE.AmbientLight(0xffffff, 2.2));
  gr.ctx.scene.fog = null;
}

// ---------------------------------------------------------------------------------------------
// Pose helpers (canonical hand frame: -Z = fingers, +Y = back of hand)
// ---------------------------------------------------------------------------------------------

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const toV = (v: THREE.Vector3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const toQ = (q: THREE.Quaternion): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });

function frame(fingers: THREE.Vector3, back: THREE.Vector3): THREE.Quaternion {
  const z = fingers.clone().normalize().negate();
  const y = back.clone().sub(z.clone().multiplyScalar(back.dot(z))).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

function headQuat(yaw: number, pitch = 0, roll = 0): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
}

/** A hand pose expressed relative to a head (x right, y up, -z forward). */
function handRel(head: THREE.Vector3, hq: THREE.Quaternion, offset: THREE.Vector3, fingers: THREE.Vector3, back: THREE.Vector3, curls: FingerCurls, tracked = true): HandPose {
  const pos = offset.clone().applyQuaternion(hq).add(head);
  const q = frame(fingers.clone().applyQuaternion(hq), back.clone().applyQuaternion(hq));
  return { tracked, position: toV(pos), rotation: toQ(q), curls };
}

const SIGNS: Record<string, { off: THREE.Vector3; fingers: THREE.Vector3; back: THREE.Vector3; curls: FingerCurls }> = {
  stop: { off: V(0.12, -0.12, -0.38), fingers: V(0, 1, 0.08), back: V(0, 0, 1), curls: [0.05, 0, 0, 0, 0] },
  thumbsUp: { off: V(0.14, -0.2, -0.36), fingers: V(-0.1, 0, -1), back: V(1, 0, 0), curls: [0, 1, 1, 1, 1] },
  fist: { off: V(0.12, -0.12, -0.38), fingers: V(0, 1, 0.08), back: V(0, 0, 1), curls: [0.8, 1, 1, 1, 1] },
  three: { off: V(0.12, -0.12, -0.38), fingers: V(0, 1, 0.08), back: V(0, 0, 1), curls: [0.9, 0, 0, 0, 1] },
  point: { off: V(0.12, -0.1, -0.32), fingers: V(-0.05, 0.12, -1), back: V(0.6, 0.8, 0), curls: [0.75, 0, 1, 1, 1] },
  rest: { off: V(0.2, -0.75, -0.05), fingers: V(0, -1, -0.15), back: V(1, 0, 0), curls: [0.3, 0.35, 0.4, 0.45, 0.5] },
  holdCam: { off: V(0.16, -0.28, -0.42), fingers: V(0, 0.05, -1), back: V(1, 0, 0), curls: [0.4, 0.15, 0.85, 0.9, 0.9] },
  meter: { off: V(-0.02, -0.13, -0.3), fingers: V(0.35, 0.55, -1), back: V(0, -1, 0.35), curls: [0.15, 0.1, 0.12, 0.15, 0.2] },
};

function mirror(off: THREE.Vector3): THREE.Vector3 { return V(-off.x, off.y, off.z); }

function signHand(side: 'left' | 'right', sign: keyof typeof SIGNS, head: THREE.Vector3, hq: THREE.Quaternion): HandPose {
  const s = SIGNS[sign];
  const off = side === 'left' ? mirror(s.off) : s.off;
  const fingers = side === 'left' ? V(-s.fingers.x, s.fingers.y, s.fingers.z) : s.fingers;
  const back = side === 'left' ? V(-s.back.x, s.back.y, s.back.z) : s.back;
  return handRel(head, hq, off, fingers, back, [...s.curls] as FingerCurls);
}

function playerPose(feet: THREE.Vector3, yaw: number, pitch: number, left: keyof typeof SIGNS, right: keyof typeof SIGNS, eye = 1.62): PlayerPose {
  const head = feet.clone().add(V(0, eye, 0));
  const hq = headQuat(yaw, pitch);
  return {
    head: { position: toV(head), rotation: toQ(hq) },
    left: signHand('left', left, head, hq),
    right: signHand('right', right, head, hq),
  };
}

/** Yaw facing from a to b (0 = -Z). */
const yawTo = (a: THREE.Vector3, b: THREE.Vector3): number => Math.atan2(-(b.x - a.x), -(b.z - a.z));

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

interface View { feet: THREE.Vector3; yaw: number; pitch: number; left: keyof typeof SIGNS; right: keyof typeof SIGNS }
const P2 = V(-3.55, 0, 2.15);
const VIEWS: Record<string, View> = {
  signs: { feet: V(-1.95, 0, 2.2), yaw: yawTo(V(-1.95, 0, 2.2), P2) - 0.12, pitch: -0.04, left: 'rest', right: 'holdCam' },
  hands: { feet: V(-2.35, 0, 2.2), yaw: yawTo(V(-2.35, 0, 2.2), P2) - 0.06, pitch: 0.06, left: 'rest', right: 'holdCam' },
  close: { feet: V(-2.6, 0, 2.25), yaw: yawTo(V(-2.6, 0, 2.25), P2) - 0.05, pitch: 0.02, left: 'rest', right: 'holdCam' },
  wide: { feet: V(-0.9, 0, 2.9), yaw: Math.PI / 2 - 0.25, pitch: -0.1, left: 'rest', right: 'holdCam' },
  room: { feet: V(-0.8, 0, 2.6), yaw: Math.PI / 2 + 0.35, pitch: -0.18, left: 'rest', right: 'holdCam' },
  roomB: { feet: V(0.8, 0, 2.9), yaw: -Math.PI / 2 + 0.5, pitch: -0.12, left: 'rest', right: 'holdCam' },
  monster: { feet: V(1.9, 0, 2.9), yaw: yawTo(V(1.9, 0, 2.9), V(3.4, 0, 1.0)), pitch: 0.12, left: 'rest', right: 'holdCam' },
  meter: { feet: V(-1.95, 0, 2.2), yaw: Math.PI / 2, pitch: -0.5, left: 'meter', right: 'holdCam' },
  portrait: { feet: V(2.0, 0, 2.6), yaw: yawTo(V(2.0, 0, 2.6), V(3.4, 0, 1.2)), pitch: 0.18, left: 'rest', right: 'holdCam' },
  items: { feet: V(-2.75, 0, 0.75), yaw: yawTo(V(-2.75, 0, 0.75), V(-3.1, 0, -0.1)), pitch: -0.75, left: 'rest', right: 'holdCam' },
  exit: { feet: V(2.6, 0, 1.6), yaw: yawTo(V(2.6, 0, 1.6), V(3.0, 0, 4.0)), pitch: 0.0, left: 'rest', right: 'holdCam' },
};
const sp = level.playerSpawns[Number(params.get('spawn') ?? 0)] ?? level.playerSpawns[0];
VIEWS.spawn = { feet: V(sp.position.x, 0, sp.position.z), yaw: sp.yaw + Number(params.get('turn') ?? 0), pitch: -0.05, left: 'rest', right: 'holdCam' };
const cam: View = { ...(VIEWS[view] ?? VIEWS.signs) };

// Desktop look/move for manual inspection.
let dragging = false;
addEventListener('pointerdown', () => { dragging = true; });
addEventListener('pointerup', () => { dragging = false; });
addEventListener('pointermove', (e) => {
  if (!dragging) return;
  cam.yaw -= e.movementX * 0.004;
  cam.pitch = Math.max(-1.4, Math.min(1.4, cam.pitch - e.movementY * 0.004));
});
const keys = new Set<string>();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyF') fireFlash('me');
  if (e.code === 'KeyM') gr.showMessage('Fuse inserted (2/3)', 3);
});
addEventListener('keyup', (e) => keys.delete(e.code));

// ---------------------------------------------------------------------------------------------
// Fake world state
// ---------------------------------------------------------------------------------------------

const player = (id: string, name: string, color: number, pose: PlayerPose, status: PlayerState['status'] = 'alive'): PlayerState => ({
  id, name, color, isDesktop: false, status, spawn: { x: 0, y: 0, z: 0 }, spawnYaw: 0, pose,
  held: { left: null, right: null },
});

const state: WorldState = {
  time: 0,
  phase: 'playing',
  levelSeed: 1,
  players: {},
  monster: { position: { x: -5.2, y: 0, z: 0.4 }, yaw: 0, mode: 'wander', target: null, targetPlayer: null, speed: 1, alert: 0.2 },
  items: [],
  camera: { holder: 'me', hand: 'right', position: { x: 0, y: 0, z: 0 }, yaw: 0, film: 5, lastFlashTime: -1e9 },
  fusesInserted: open ? 3 : 1,
  fusesRequired: 3,
  exitOpen: open,
  lastHeard: null,
};

const items: ItemState[] = [
  { id: 1, kind: 'fuse', where: 'world', position: level.fuseSpawns[0], yaw: 0.7, holder: null, hand: null },
  { id: 2, kind: 'fuse', where: 'world', position: level.fuseSpawns[1], yaw: 0.2, holder: null, hand: null },
  { id: 3, kind: 'fuse', where: 'held', position: { x: 0, y: 0, z: 0 }, yaw: 0, holder: 'p2', hand: 'left', },
  { id: 4, kind: 'film', where: 'world', position: level.filmSpawns[0], yaw: 0, holder: null, hand: null },
  { id: 5, kind: 'film', where: 'world', position: { x: -2.1, y: 0, z: 1.5 }, yaw: 0, holder: null, hand: null },
  { id: 6, kind: 'fuse', where: 'used', position: { x: 0, y: 0, z: 0 }, yaw: 0, holder: null, hand: null },
];
state.items = items;

let localPose: PlayerPose = playerPose(cam.feet, cam.yaw, cam.pitch, cam.left, cam.right);

function buildState(t: number): void {
  state.time = t;
  // Local: desktop-style rig (feet + yaw) with the camera at eye height + pitch.
  const fwd = V(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
  const right = V(-fwd.z, 0, fwd.x);
  const sp = 1.6 / 60;
  if (keys.has('KeyW')) cam.feet.addScaledVector(fwd, sp);
  if (keys.has('KeyS')) cam.feet.addScaledVector(fwd, -sp);
  if (keys.has('KeyD')) cam.feet.addScaledVector(right, sp);
  if (keys.has('KeyA')) cam.feet.addScaledVector(right, -sp);
  localPose = playerPose(cam.feet, cam.yaw, cam.pitch, cam.left, cam.right, 1.6);
  gr.ctx.rig.position.copy(cam.feet);
  gr.ctx.rig.rotation.set(0, cam.yaw, 0);
  gr.ctx.camera.position.set(0, 1.6, 0);
  gr.ctx.camera.rotation.set(cam.pitch, 0, 0);

  // p2: stop sign right in front of us, holding a fuse in the left hand; slight idle sway.
  const p2feet = P2.clone().add(V(0, 0, Math.sin(t * 0.7) * 0.02));
  const p2 = playerPose(p2feet, yawTo(P2, cam.feet) + Math.sin(t * 0.5) * 0.05, 0.05, 'rest', p2Sign);
  // p3: thumbs up a bit further back.
  const P3 = V(-4.4, 0, 1.15);
  const p3 = playerPose(P3, yawTo(P3, cam.feet), 0, 'three', 'thumbsUp', 1.55);
  // p4: caught (spectator ghost).
  const P4 = V(-4.8, 0, 3.1);
  const p4 = playerPose(P4, yawTo(P4, cam.feet), 0.1, 'rest', 'rest', 1.5);
  state.players = {
    me: player('me', 'Me', 0xe8c547, localPose),
    p2: player('p2', 'Ana', 0x4fb3e8, p2),
    p3: player('p3', 'Bo', 0xe86a4f, p3),
    p4: player('p4', 'Cy', 0x7be84f, p4, 'caught'),
  };
  for (const id in statusOverride) if (state.players[id]) state.players[id].status = statusOverride[id];
  state.camera.position = localPose.right.position;

  // Monster: walks a slow loop through both rooms; investigates (listens) for a while at each end.
  const m = state.monster;
  if (view === 'portrait') {
    // Standing still, facing us, listening.
    m.position = { x: 3.4, y: 0, z: 1.2 };
    m.yaw = yawTo(V(3.4, 0, 1.2), cam.feet);
    m.speed = 0;
    m.mode = 'investigate';
    m.alert = 0.8;
  } else if (view === 'monster') {
    const a = t * 0.35;
    const c = V(3.6, 0, 0.6);
    const pos = V(c.x + Math.cos(a) * 1.2, 0, c.z + Math.sin(a) * 0.9);
    const vel = V(-Math.sin(a) * 1.2, 0, Math.cos(a) * 0.9);
    m.position = toV(pos);
    m.yaw = Math.atan2(-vel.x, -vel.z);
    m.speed = vel.length() * 0.35;
    m.mode = 'wander';
    m.alert = 0.25 + 0.25 * Math.sin(t * 0.3);
  } else {
    const cycle = t % 16;
    const A = V(-5.3, 0, -0.6), B = V(-4.6, 0, 0.9);
    if (cycle < 6) {
      const k = cycle / 6;
      const pos = A.clone().lerp(B, k);
      m.position = toV(pos);
      m.yaw = yawTo(A, B);
      m.speed = 0.85 * A.distanceTo(B) / 6 * 6;
      m.mode = 'wander';
      m.alert = 0.2;
    } else if (cycle < 11) {
      m.position = toV(B);
      m.speed = 0;
      m.mode = 'investigate';
      m.alert = 0.75;
    } else {
      const k = (cycle - 11) / 5;
      m.position = toV(B.clone().lerp(A, k));
      m.yaw = yawTo(B, A);
      m.speed = 0.85;
      m.mode = 'wander';
      m.alert = 0.3;
    }
  }
}

function fireFlash(by: string): void {
  const pose = by === 'me' ? localPose : state.players[by]?.pose;
  if (!pose) return;
  const hq = new THREE.Quaternion(pose.head.rotation.x, pose.head.rotation.y, pose.head.rotation.z, pose.head.rotation.w);
  const dir = V(0, 0, -1).applyQuaternion(hq);
  const pos = V(pose.right.position.x, pose.right.position.y, pose.right.position.z).addScaledVector(dir, 0.12);
  const ev: FlashEvent = { type: 'flash', by, position: toV(pos), direction: toV(dir), time: state.time };
  state.camera.film = Math.max(0, state.camera.film - 1);
  if (state.camera.film === 0) state.camera.film = 6;
  gr.flash(ev, state, 'me', localPose);
}

// ---------------------------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------------------------

let t = 0;
let lastFlash = -1.5;
let noiseOverride: number | null = null;
const statusOverride: Record<string, PlayerState['status']> = {};
let fps = 0;
function frameStep(dt: number): void {
  t += dt;
  buildState(t);
  if (!manual && autoFlash && t - lastFlash >= 3) {
    lastFlash = t;
    fireFlash(flashBy);
  }
  gr.setLocalNoiseLevel(noiseOverride ?? 0.5 + 0.45 * Math.sin(t * 1.7));
  gr.update(state, 'me', localPose, dt);
  gr.render();
  const s = gr.stats();
  hud.textContent = `view=${view}  calls=${s.calls}  tris=${s.triangles}  geo=${s.geometries}  tex=${s.textures}  progs=${s.programs}  fps=${fps.toFixed(0)}`;
}

let prev = performance.now();
let acc = 0, frames = 0;
if (!manual) {
  gr.ctx.renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    acc += dt; frames++;
    if (acc > 0.5) { fps = frames / acc; acc = 0; frames = 0; }
    frameStep(dt);
  });
} else {
  frameStep(1 / 60);
}
gr.showMessage('Find the fuses. Stay quiet.', 4);

declare global {
  interface Window {
    preview: {
      step(n?: number, dt?: number): void;
      flash(by?: string): void;
      message(text: string): void;
      stats(): ReturnType<GameRenderer['stats']>;
      setNoise(v: number): void;
      reload(): void;
      setStatus(id: string, status: PlayerState['status']): void;
      remotePose(id: string): void;
    };
  }
}
window.preview = {
  step(n = 1, dt = 1 / 60) {
    for (let i = 0; i < n; i++) frameStep(dt);
  },
  flash(by = 'me') { fireFlash(by); },
  message(text: string) { gr.showMessage(text, 3); },
  stats: () => gr.stats(),
  setNoise(v: number) { noiseOverride = v; },
  reload() { gr.loadLevel(mockLevel()); },
  setStatus(id, status) { statusOverride[id] = status; },
  /** Push a direct pose (as if from the network) for a remote player. */
  remotePose(id) { const p = state.players[id]; if (p) gr.setRemotePose(id, p.pose); },
};
