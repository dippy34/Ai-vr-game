/**
 * InputManager behaviour with fake WebXR / DOM objects (node test environment, no browser).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PLAYER } from '../../config';
import { quatFromYaw, rotate3, yawFromQuat } from '../../core/math';
import type { FingerCurls, Handedness } from '../../core/types';
import type { InputFrame, RenderContext } from '../types';
import { InputManager } from './InputManager';
import { wristFromGrip } from './handMath';
import { SIGN_MIN_SECONDS, SIGN_PRESETS } from './signs';
import { syntheticHandJoints, transformJoints } from './syntheticHand';

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

class FakeDoc extends EventTarget {
  pointerLockElement: unknown = null;
  readonly defaultView = new EventTarget();
  exitPointerLock() {
    this.pointerLockElement = null;
    this.dispatchEvent(new Event('pointerlockchange'));
  }
}

interface Btn {
  value: number;
  pressed: boolean;
  touched: boolean;
}
const btn = (): Btn => ({ value: 0, pressed: false, touched: false });

function setup() {
  const scene = new THREE.Scene();
  const rig = new THREE.Group();
  const camera = new THREE.PerspectiveCamera();
  rig.add(camera);
  scene.add(rig);

  const slots = [0, 1].map(() => {
    const ray = new THREE.Group();
    const grip = new THREE.Group();
    grip.matrixAutoUpdate = false;
    grip.visible = false;
    const hand = Object.assign(new THREE.Group(), { joints: {} as Record<string, THREE.Group>, inputState: { pinching: false } });
    hand.matrixAutoUpdate = false;
    hand.visible = false;
    return { ray, grip, hand };
  });

  const viewer = { position: new THREE.Vector3(0, 1.7, 0), quaternion: new THREE.Quaternion() };
  const xr = {
    isPresenting: false,
    getController: (i: number) => slots[i].ray,
    getControllerGrip: (i: number) => slots[i].grip,
    getHand: (i: number) => slots[i].hand,
    getReferenceSpace: () => ({}),
    getFrame: () =>
      xr.isPresenting
        ? {
            getViewerPose: () => {
              const m = new THREE.Matrix4().compose(viewer.position, viewer.quaternion, new THREE.Vector3(1, 1, 1));
              return { transform: { position: { x: viewer.position.x, y: viewer.position.y, z: viewer.position.z }, matrix: m.toArray() } };
            },
          }
        : null,
    updateCamera: () => {},
  };
  const ctx = { renderer: { xr } as unknown as THREE.WebGLRenderer, scene, camera, rig } as RenderContext;

  const doc = new FakeDoc();
  const el = new EventTarget() as EventTarget & { ownerDocument: FakeDoc; requestPointerLock: () => void };
  el.ownerDocument = doc;
  el.requestPointerLock = () => {
    doc.pointerLockElement = el;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  const input = new InputManager(ctx, el as unknown as HTMLElement);

  const ev = (type: string, props: Record<string, unknown> = {}) => Object.assign(new Event(type), props);
  const key = (code: string, down: boolean, repeat = false) =>
    doc.defaultView.dispatchEvent(ev(down ? 'keydown' : 'keyup', { code, repeat }));

  /** Connect a fake XR input source to slot `i`. */
  const connect = (i: number, handedness: Handedness, opts: { hand?: boolean } = {}) => {
    const buttons = [btn(), btn(), btn(), btn(), btn(), btn(), btn()];
    const axes = [0, 0, 0, 0];
    const source = { handedness, hand: opts.hand ? new Map() : undefined, gamepad: opts.hand ? undefined : { buttons, axes } };
    slots[i].ray.dispatchEvent({ type: 'connected', data: source } as never);
    return { source, buttons, axes, slot: slots[i] };
  };

  return { ctx, rig, camera, xr, viewer, doc, el, input, key, ev, connect, slots };
}

const run = (input: InputManager, n: number, dt = 1 / 60): InputFrame => {
  let f!: InputFrame;
  for (let i = 0; i < n; i++) f = input.update(dt);
  return f;
};

// ---------------------------------------------------------------------------------------------
// Desktop
// ---------------------------------------------------------------------------------------------

describe('InputManager desktop', () => {
  it('WASD moves relative to view, diagonal normalized, shift sprints, C sneaks', () => {
    const t = setup();
    t.key('KeyW', true);
    let f = t.input.update(1 / 60);
    expect(f.mode).toBe('desktop');
    expect(f.move).toEqual({ x: 0, y: 1 });
    t.key('KeyD', true);
    f = t.input.update(1 / 60);
    expect(Math.hypot(f.move.x, f.move.y)).toBeCloseTo(1);
    expect(f.move.x).toBeGreaterThan(0);
    t.key('ShiftLeft', true);
    expect(t.input.update(1 / 60).sprint).toBe(true);
    t.key('KeyC', true);
    f = t.input.update(1 / 60);
    expect(f.sneak).toBe(true);
    expect(f.sprint).toBe(false);
    f = run(t.input, 120);
    expect(t.camera.position.y).toBeCloseTo(PLAYER.crouchEyeHeight, 3);
    expect(f.head.position.y).toBeCloseTo(PLAYER.crouchEyeHeight, 3);
    t.key('KeyC', false);
    run(t.input, 120);
    expect(t.camera.position.y).toBeCloseTo(PLAYER.eyeHeight, 3);
  });

  it('E is a one-frame edge', () => {
    const t = setup();
    t.key('KeyE', true);
    expect(t.input.update(1 / 60).usePressed).toBe(true);
    expect(t.input.update(1 / 60).usePressed).toBe(false);
    t.key('KeyE', true, true); // auto-repeat does not re-fire
    expect(t.input.update(1 / 60).usePressed).toBe(false);
  });

  it('click locks the pointer; mouse looks (yaw on rig, clamped pitch on camera); left click = right trigger', () => {
    const t = setup();
    t.el.dispatchEvent(t.ev('mousedown', { button: 0 }));
    expect(t.input.update(1 / 60).triggerPressed.right).toBe(false); // not locked yet
    t.el.dispatchEvent(t.ev('click'));
    expect(t.doc.pointerLockElement).toBe(t.el);

    t.doc.dispatchEvent(t.ev('mousemove', { movementX: 100, movementY: 0 }));
    let f = t.input.update(1 / 60);
    expect(t.rig.rotation.y).toBeLessThan(0); // mouse right = turn right = negative yaw
    expect(yawFromQuat(f.head.rotation)).toBeCloseTo(t.rig.rotation.y, 6);

    for (let i = 0; i < 20; i++) t.doc.dispatchEvent(t.ev('mousemove', { movementX: 0, movementY: -200 }));
    t.input.update(1 / 60);
    expect(t.camera.rotation.x).toBeCloseTo((85 * Math.PI) / 180, 6);

    t.el.dispatchEvent(t.ev('mousedown', { button: 0 }));
    f = t.input.update(1 / 60);
    expect(f.triggerPressed.right).toBe(true);
    expect(f.triggerPressed.left).toBe(false);
    expect(t.input.update(1 / 60).triggerPressed.right).toBe(false);
  });

  it('pointer-lock loss = one menu press; setEnabled(false) releases the lock without a menu press and zeroes input', () => {
    const t = setup();
    t.el.dispatchEvent(t.ev('click'));
    t.doc.exitPointerLock(); // user pressed Escape
    expect(t.input.update(1 / 60).menuPressed).toBe(true);
    expect(t.input.update(1 / 60).menuPressed).toBe(false);

    t.el.dispatchEvent(t.ev('click'));
    t.key('KeyW', true);
    expect(t.input.update(1 / 60).move.y).toBe(1);
    t.input.setEnabled(false);
    expect(t.doc.pointerLockElement).toBeNull();
    const f = t.input.update(1 / 60);
    expect(f.menuPressed).toBe(false);
    expect(f.move).toEqual({ x: 0, y: 0 });
    t.el.dispatchEvent(t.ev('click')); // no lock while disabled
    expect(t.doc.pointerLockElement).toBeNull();
    t.key('KeyE', true);
    expect(t.input.update(1 / 60).usePressed).toBe(false);
    t.input.setEnabled(true);
    expect(t.doc.pointerLockElement).toBe(t.el); // re-enabling (from a menu click) re-locks
    t.key('KeyW', true);
    expect(t.input.update(1 / 60).move.y).toBe(1);
  });

  it('Escape key = menu (debounced against the lock loss it causes)', () => {
    const t = setup();
    t.key('Escape', true);
    expect(t.input.update(1 / 60).menuPressed).toBe(true);
    expect(t.input.update(1 / 60).menuPressed).toBe(false);
  });

  it('sign keys: shown while held and at least SIGN_MIN_SECONDS after a tap, raised in front of the face', () => {
    const t = setup();
    const stop = SIGN_PRESETS.find((p) => p.id === 'stop')!;
    let f = t.input.update(1 / 60);
    const restRight = f.right.position;
    expect(f.right.tracked && f.left.tracked).toBe(true);

    t.key('Digit2', true);
    t.key('Digit2', false); // quick tap
    f = run(t.input, 60); // 1 s
    for (let i = 0; i < 5; i++) expect(f.right.curls[i]).toBeCloseTo(stop.curls[i], 2);
    // raised in front of the face: ~0.4 m ahead (camera looks down -Z at yaw 0)
    expect(f.right.position.z - f.head.position.z).toBeCloseTo(-0.4, 1);
    expect(f.right.position.y).toBeGreaterThan(restRight.y);
    const fingersUp = rotate3(f.right.rotation, { x: 0, y: 0, z: -1 });
    expect(fingersUp.y).toBeGreaterThan(0.9);

    f = run(t.input, Math.ceil((SIGN_MIN_SECONDS - 1 + 0.6) * 60));
    expect(f.right.curls[1]).toBeCloseTo(0.3, 2); // back to rest

    t.key('Digit4', true); // hold fist for 3 s
    f = run(t.input, 180);
    expect(Math.min(...f.right.curls.slice(1))).toBeGreaterThan(0.95);
    t.key('Digit4', false);
    f = run(t.input, 60);
    expect(f.right.curls[1]).toBeCloseTo(0.3, 2);
  });

  it('hands follow the view in world space', () => {
    const t = setup();
    t.rig.position.set(3, 0, -2);
    t.rig.rotation.y = Math.PI / 2; // facing -X
    const f = t.input.update(1 / 60);
    // right hand is to the right of the view direction (-X) => toward -Z, and ahead (-X)
    expect(f.right.position.x).toBeLessThan(3);
    expect(f.right.position.z).toBeLessThan(-2);
    expect(f.left.position.z).toBeGreaterThan(-2);
    const fingers = rotate3(f.right.rotation, { x: 0, y: 0, z: -1 });
    expect(fingers.x).toBeLessThan(-0.9);
  });
});

// ---------------------------------------------------------------------------------------------
// XR
// ---------------------------------------------------------------------------------------------

describe('InputManager XR controllers', () => {
  function xrSetup() {
    const t = setup();
    t.xr.isPresenting = true;
    const L = t.connect(0, 'left');
    const R = t.connect(1, 'right');
    return { ...t, L, R };
  }

  it('reports xr mode, never sneak/use, stick moves with radial deadzone', () => {
    const t = xrSetup();
    t.L.axes[2] = 0.1;
    t.L.axes[3] = -0.1;
    let f = t.input.update(1 / 72);
    expect(f.mode).toBe('xr');
    expect(t.input.mode).toBe('xr');
    expect(f.move).toEqual({ x: 0, y: 0 });
    expect(f.sneak).toBe(false);
    expect(f.usePressed).toBe(false);
    t.L.axes[2] = 0;
    t.L.axes[3] = -1;
    f = t.input.update(1 / 72);
    expect(f.move.y).toBeCloseTo(1);
    expect(f.move.x).toBeCloseTo(0);
  });

  it('grip edges with hysteresis, exactly one frame each', () => {
    const t = xrSetup();
    const sq = t.R.buttons[1];
    const seq = [0.5, 0.65, 0.8, 0.5, 0.45, 0.35, 0.3, 0.62];
    const pressed: boolean[] = [];
    const released: boolean[] = [];
    const held: boolean[] = [];
    for (const v of seq) {
      sq.value = v;
      sq.pressed = v > 0.1; // Quest flips `pressed` early; must not matter
      const f = t.input.update(1 / 72);
      pressed.push(f.gripPressed.right);
      released.push(f.gripReleased.right);
      held.push(f.grip.right);
      expect(f.gripPressed.left || f.gripReleased.left).toBe(false);
    }
    expect(pressed).toEqual([false, true, false, false, false, false, false, true]);
    expect(released).toEqual([false, false, false, false, false, true, false, false]);
    expect(held).toEqual([false, true, true, true, true, false, false, true]);
  });

  it('trigger edge once per pull', () => {
    const t = xrSetup();
    const tr = t.L.buttons[0];
    tr.value = 0.9;
    expect(t.input.update(1 / 72).triggerPressed.left).toBe(true);
    expect(t.input.update(1 / 72).triggerPressed.left).toBe(false);
    tr.value = 0.2;
    t.input.update(1 / 72);
    tr.value = 1;
    expect(t.input.update(1 / 72).triggerPressed.left).toBe(true);
  });

  it('snap turn rotates the rig around the head (head stays put) and re-arms', () => {
    const t = xrSetup();
    t.rig.position.set(1, 0, 1);
    t.viewer.position.set(0.3, 1.7, -0.2); // head offset from the rig origin
    const before = t.input.update(1 / 72).head;
    t.R.axes[2] = 0.9;
    const f1 = t.input.update(1 / 72);
    expect(t.rig.rotation.y).toBeCloseTo(-PLAYER.snapTurnAngle);
    expect(f1.head.position.x).toBeCloseTo(before.position.x, 6);
    expect(f1.head.position.z).toBeCloseTo(before.position.z, 6);
    expect(yawFromQuat(f1.head.rotation)).toBeCloseTo(-PLAYER.snapTurnAngle, 6);
    run(t.input, 10); // held: no repeat
    expect(t.rig.rotation.y).toBeCloseTo(-PLAYER.snapTurnAngle);
    t.R.axes[2] = 0.4; // inside hysteresis band: still not re-armed
    t.input.update(1 / 72);
    t.R.axes[2] = 0.9;
    t.input.update(1 / 72);
    expect(t.rig.rotation.y).toBeCloseTo(-PLAYER.snapTurnAngle);
    t.R.axes[2] = 0;
    t.input.update(1 / 72);
    t.R.axes[2] = -0.9;
    t.input.update(1 / 72);
    expect(t.rig.rotation.y).toBeCloseTo(0);
  });

  it('left stick click toggles sprint, which turns off when the stick is released', () => {
    const t = xrSetup();
    t.L.axes[3] = -1;
    t.L.buttons[3].pressed = true;
    expect(t.input.update(1 / 72).sprint).toBe(true);
    t.L.buttons[3].pressed = false;
    expect(run(t.input, 30).sprint).toBe(true);
    t.L.axes[3] = 0;
    expect(t.input.update(1 / 72).sprint).toBe(false);
    run(t.input, 60);
    t.L.axes[3] = -1;
    expect(t.input.update(1 / 72).sprint).toBe(false); // latch expired
  });

  it('hand pose comes from the grip pose in world space; curls from buttons', () => {
    const t = xrSetup();
    t.rig.position.set(2, 0, 0);
    t.rig.rotation.y = Math.PI / 2;
    const gp = new THREE.Vector3(0.2, 1.1, -0.3);
    const gq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.2, 0.1));
    t.R.slot.grip.matrix.compose(gp, gq, new THREE.Vector3(1, 1, 1));
    t.R.slot.grip.visible = true;
    t.R.buttons[0].touched = true;
    t.R.buttons[1].value = 1;
    t.R.buttons[4].touched = true;
    const f = t.input.update(1 / 72);
    expect(f.right.tracked).toBe(true);
    expect(f.left.tracked).toBe(false);
    const world = new THREE.Matrix4().multiplyMatrices(t.rig.matrixWorld, t.R.slot.grip.matrix);
    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    world.decompose(wp, wq, new THREE.Vector3());
    const expected = wristFromGrip(wp, wq, 'right');
    expect(f.right.position.x).toBeCloseTo(expected.position.x, 6);
    expect(f.right.position.y).toBeCloseTo(expected.position.y, 6);
    expect(f.right.position.z).toBeCloseTo(expected.position.z, 6);
    const r = f.right.rotation;
    const e = expected.rotation;
    expect(Math.abs(r.x * e.x + r.y * e.y + r.z * e.z + r.w * e.w)).toBeCloseTo(1, 6);
    expect(f.right.curls).toEqual([0.8, 0.35, 1, 1, 1] as FingerCurls);
  });

  it('Y button = menu; disconnect while gripping emits a release', () => {
    const t = xrSetup();
    t.L.buttons[5].pressed = true;
    expect(t.input.update(1 / 72).menuPressed).toBe(true);
    expect(t.input.update(1 / 72).menuPressed).toBe(false);
    t.R.buttons[1].value = 1;
    expect(t.input.update(1 / 72).gripPressed.right).toBe(true);
    t.R.slot.ray.dispatchEvent({ type: 'disconnected', data: t.R.source } as never);
    const f = t.input.update(1 / 72);
    expect(f.gripReleased.right).toBe(true);
    expect(f.grip.right).toBe(false);
    expect(f.right.tracked).toBe(false);
  });

  it('exiting XR restores the desktop camera where the head was', () => {
    const t = xrSetup();
    t.rig.position.set(1, 0, 1);
    t.viewer.position.set(0.4, 1.5, -0.3);
    t.viewer.quaternion.set(...(Object.values(quatFromYaw(0.7)) as [number, number, number, number]));
    t.R.buttons[1].value = 1;
    const xrFrame = t.input.update(1 / 72);
    t.camera.position.set(0.4, 1.5, -0.3); // what three's XR camera update would leave behind
    t.xr.isPresenting = false;
    const f = t.input.update(1 / 60);
    expect(f.mode).toBe('desktop');
    expect(f.gripReleased.right).toBe(true);
    expect(t.camera.position.toArray()).toEqual([0, PLAYER.eyeHeight, 0]);
    expect(t.camera.rotation.x).toBe(0);
    expect(f.head.position.x).toBeCloseTo(xrFrame.head.position.x, 6);
    expect(f.head.position.z).toBeCloseTo(xrFrame.head.position.z, 6);
    expect(yawFromQuat(f.head.rotation)).toBeCloseTo(yawFromQuat(xrFrame.head.rotation), 6);
  });
});

describe('InputManager XR hand tracking', () => {
  function handSetup() {
    const t = setup();
    t.xr.isPresenting = true;
    const R = t.connect(1, 'right', { hand: true });
    const hand = R.slot.hand;
    hand.visible = true;
    const pose = (curls: FingerCurls, tweak?: (j: ReturnType<typeof syntheticHandJoints>) => void) => {
      const j = transformJoints(syntheticHandJoints('right', curls), quatFromYaw(0.5), { x: 0.2, y: 1.2, z: -0.3 });
      tweak?.(j);
      for (const [name, p] of Object.entries(j)) {
        let g = hand.joints[name];
        if (!g) {
          g = new THREE.Group();
          hand.joints[name] = g;
        }
        g.position.set(p!.x, p!.y, p!.z);
        g.visible = true;
      }
    };
    return { ...t, R, hand, pose };
  }

  it('tracked hand: canonical pose + curls, fist = grip, pinch = trigger', () => {
    const t = handSetup();
    t.pose([0, 0, 0, 0, 0]);
    let f = t.input.update(1 / 72);
    expect(f.right.tracked).toBe(true);
    expect(f.right.position).toEqual({ x: 0.2, y: 1.2, z: -0.3 });
    expect(yawFromQuat(f.right.rotation)).toBeCloseTo(0.5, 6);
    for (const c of f.right.curls) expect(c).toBeLessThan(0.05);
    expect(f.grip.right).toBe(false);

    t.pose([1, 1, 1, 1, 1]);
    f = t.input.update(1 / 72);
    expect(f.gripPressed.right).toBe(true);
    expect(f.triggerPressed.right).toBe(false); // fist never counts as pinch
    expect(t.input.update(1 / 72).gripPressed.right).toBe(false);

    t.pose([0.6, 0.4, 0, 0, 0], (j) => {
      const it = j['index-finger-tip']!;
      j['thumb-tip'] = { x: it.x + 0.005, y: it.y, z: it.z };
    });
    f = t.input.update(1 / 72);
    expect(f.gripReleased.right).toBe(true);
    expect(f.triggerPressed.right).toBe(true);
    expect(t.input.update(1 / 72).triggerPressed.right).toBe(false);
  });

  it('lost tracking keeps the last pose flagged untracked', () => {
    const t = handSetup();
    t.pose([0, 0, 0, 0, 0]);
    t.input.update(1 / 72);
    t.hand.visible = false;
    const f = t.input.update(1 / 72);
    expect(f.right.tracked).toBe(false);
    expect(f.right.position).toEqual({ x: 0.2, y: 1.2, z: -0.3 });
  });
});
