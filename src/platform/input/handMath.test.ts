import { describe, expect, it } from 'vitest';
import type { FingerCurls, Handedness, Quat, Vec3 } from '../../core/types';
import { makeRng, normalize3, rotate3 } from '../../core/math';
import {
  analyzeHandJoints,
  CONTROLLER_INDEX_TOUCH_CURL,
  CONTROLLER_THUMB_REST_CURL,
  controllerCurls,
  fingerCurlsFromJoints,
  frameFromFingersBack,
  gripToHandRotation,
  gripToWristOffset,
  handFrameFromJoints,
  hysteresisAbove,
  hysteresisBelow,
  mirrorQuatX,
  quatFromAxisAngle,
  quatMul,
  radialDeadzone,
  wristFromGrip,
  type ButtonLike,
} from './handMath';
import { syntheticHandJoints, transformJoints } from './syntheticHand';

const HANDS: Handedness[] = ['left', 'right'];

function expectVec(a: Vec3, b: Vec3, eps = 1e-6) {
  expect(Math.abs(a.x - b.x)).toBeLessThan(eps);
  expect(Math.abs(a.y - b.y)).toBeLessThan(eps);
  expect(Math.abs(a.z - b.z)).toBeLessThan(eps);
}

/** Same rotation (q and -q are equal). */
function expectSameRotation(a: Quat, b: Quat, eps = 1e-6) {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  expect(1 - d).toBeLessThan(eps);
}

function randomQuat(rng: () => number): Quat {
  const axis = normalize3({ x: rng() - 0.5, y: rng() - 0.5, z: rng() - 0.5 });
  return quatFromAxisAngle(axis, rng() * Math.PI * 2);
}

describe('finger curls from joints', () => {
  for (const hand of HANDS) {
    it(`straight ${hand} hand ≈ 0`, () => {
      const curls = fingerCurlsFromJoints(syntheticHandJoints(hand, [0, 0, 0, 0, 0]), handFrameFromJoints(syntheticHandJoints(hand), hand), hand)!;
      for (const c of curls) expect(c).toBeLessThan(0.05);
    });

    it(`fist ${hand} hand ≈ 1`, () => {
      const j = syntheticHandJoints(hand, [1, 1, 1, 1, 1]);
      const curls = fingerCurlsFromJoints(j, handFrameFromJoints(j, hand), hand)!;
      for (const c of curls) expect(c).toBeGreaterThan(0.95);
    });

    it(`${hand} hand curls are rotation/translation invariant and monotonic`, () => {
      const rng = makeRng(hand === 'left' ? 1 : 2);
      let prev = -1;
      for (const c of [0, 0.25, 0.5, 0.75, 1]) {
        const curlsIn: FingerCurls = [c, c, c, c, c];
        const j = transformJoints(syntheticHandJoints(hand, curlsIn), randomQuat(rng), { x: rng() * 4, y: 1, z: -rng() * 4 });
        const r = analyzeHandJoints(j, hand)!;
        // index..pinky: the generator's flexion sums to c * 260°, normalized over 15°..220°.
        const expected = Math.min(1, Math.max(0, (c * 260 - 15) / 205));
        for (let f = 1; f < 5; f++) expect(r.curls[f]).toBeCloseTo(expected, 2);
        expect(r.curls[1]).toBeGreaterThanOrEqual(prev);
        prev = r.curls[1];
      }
    });

    it(`${hand} pointing: index straight, others curled, thumb tucked`, () => {
      const j = syntheticHandJoints(hand, [1, 0, 1, 1, 1]);
      const r = analyzeHandJoints(j, hand)!;
      expect(r.curls[1]).toBeLessThan(0.05);
      expect(r.curls[0]).toBeGreaterThan(0.9);
      for (let f = 2; f < 5; f++) expect(r.curls[f]).toBeGreaterThan(0.95);
    });

    it(`${hand} thumbs up: thumb straight, fingers curled`, () => {
      const r = analyzeHandJoints(syntheticHandJoints(hand, [0, 1, 1, 1, 1]), hand)!;
      expect(r.curls[0]).toBeLessThan(0.05);
      for (let f = 1; f < 5; f++) expect(r.curls[f]).toBeGreaterThan(0.95);
    });
  }

  it('returns null when joints are missing', () => {
    const j = syntheticHandJoints('right');
    delete j['ring-finger-tip'];
    expect(analyzeHandJoints(j, 'right')).toBeNull();
  });
});

describe('canonical hand frame from joints', () => {
  for (const hand of HANDS) {
    it(`${hand}: fingers along -Z, back of hand along +Y, thumb on the ${hand === 'right' ? '-X' : '+X'} side`, () => {
      const j = syntheticHandJoints(hand, [0.2, 0.3, 0.3, 0.3, 0.3]);
      const f = handFrameFromJoints(j, hand)!;
      expectSameRotation(f.rotation, { x: 0, y: 0, z: 0, w: 1 });
      expectVec(f.position, { x: 0, y: 0, z: 0 });
      // thumb metacarpal sits on the thumb side
      const thumbX = j['thumb-metacarpal']!.x;
      expect(hand === 'right' ? thumbX < 0 : thumbX > 0).toBe(true);
    });

    it(`${hand}: recovers an arbitrary world pose`, () => {
      const rng = makeRng(hand === 'left' ? 11 : 12);
      for (let i = 0; i < 20; i++) {
        const q = randomQuat(rng);
        const t = { x: rng() * 10 - 5, y: rng() * 2, z: rng() * 10 - 5 };
        const j = transformJoints(syntheticHandJoints(hand, [rng(), rng(), rng(), rng(), rng()]), q, t);
        const f = handFrameFromJoints(j, hand)!;
        expectSameRotation(f.rotation, q, 1e-6);
        expectVec(f.position, t);
        // -Z of the frame points from the wrist toward the middle knuckle
        const fwd = rotate3(f.rotation, { x: 0, y: 0, z: -1 });
        const mid = j['middle-finger-phalanx-proximal']!;
        expectVec(fwd, normalize3({ x: mid.x - t.x, y: mid.y - t.y, z: mid.z - t.z }), 1e-6);
      }
    });
  }

  it('palm-down right hand with fingers forward has identity rotation (types.ts example)', () => {
    // Already in that pose; flipping it palm-up must flip +Y.
    const flip = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI);
    const f = handFrameFromJoints(transformJoints(syntheticHandJoints('right'), flip, { x: 0, y: 0, z: 0 }), 'right')!;
    expectVec(rotate3(f.rotation, { x: 0, y: 1, z: 0 }), { x: 0, y: -1, z: 0 }, 1e-6);
  });
});

describe('controller curl mapping', () => {
  const btn = (value = 0, touched = false, pressed = value > 0.5): ButtonLike => ({ value, touched, pressed });
  const none = () => [btn(), btn(), btn(), btn(), btn(), btn()];

  it('untouched controller = pointing index, open hand, thumbs up', () => {
    expect(controllerCurls(none())).toEqual([0, 0, 0, 0, 0]);
  });

  it('index: touched = rest curl, full trigger = 1', () => {
    const b = none();
    b[0] = btn(0, true);
    expect(controllerCurls(b)[1]).toBeCloseTo(CONTROLLER_INDEX_TOUCH_CURL);
    b[0] = btn(1, true, true);
    expect(controllerCurls(b)[1]).toBeCloseTo(1);
    b[0] = btn(0.5, true);
    const half = controllerCurls(b)[1];
    expect(half).toBeGreaterThan(CONTROLLER_INDEX_TOUCH_CURL);
    expect(half).toBeLessThan(1);
  });

  it('middle/ring/pinky follow squeeze', () => {
    const b = none();
    b[1] = btn(0.7);
    const c = controllerCurls(b);
    expect(c[2]).toBeCloseTo(0.7);
    expect(c[3]).toBeCloseTo(0.7);
    expect(c[4]).toBeCloseTo(0.7);
  });

  it('thumb curls when resting on stick / A / B / thumbrest', () => {
    for (const i of [3, 4, 5, 6]) {
      const b: ButtonLike[] = [...none(), btn()];
      b[i] = btn(0, true);
      expect(controllerCurls(b)[0]).toBeCloseTo(CONTROLLER_THUMB_REST_CURL);
    }
  });

  it('fist = grip + trigger + thumb down', () => {
    const b = none();
    b[0] = btn(1, true, true);
    b[1] = btn(1, false, true);
    b[4] = btn(0, true);
    const c = controllerCurls(b);
    expect(Math.min(...c.slice(1))).toBeGreaterThan(0.99);
    expect(c[0]).toBeGreaterThan(0.5);
  });

  it('handles short / missing button arrays', () => {
    expect(controllerCurls([])).toEqual([0, 0, 0, 0, 0]);
    expect(controllerCurls([undefined, btn(1)])).toEqual([0, 0, 1, 1, 1]);
  });
});

describe('grip space -> canonical hand frame', () => {
  it('with no tilt: right fingers along -Y_grip, back along +X_grip, thumb along -Z_grip', () => {
    const q = gripToHandRotation('right', 0, 0, 0);
    expectVec(rotate3(q, { x: 0, y: 0, z: -1 }), { x: 0, y: -1, z: 0 });
    expectVec(rotate3(q, { x: 0, y: 1, z: 0 }), { x: 1, y: 0, z: 0 });
    expectVec(rotate3(q, { x: -1, y: 0, z: 0 }), { x: 0, y: 0, z: -1 });
  });

  it('with no tilt: left back of hand along -X_grip, thumb (+X_h) along -Z_grip', () => {
    const q = gripToHandRotation('left', 0, 0, 0);
    expectVec(rotate3(q, { x: 0, y: 0, z: -1 }), { x: 0, y: -1, z: 0 });
    expectVec(rotate3(q, { x: 0, y: 1, z: 0 }), { x: -1, y: 0, z: 0 });
    expectVec(rotate3(q, { x: 1, y: 0, z: 0 }), { x: 0, y: 0, z: -1 });
  });

  it('default tilt leans the fingers toward the handle top, left mirrors right', () => {
    for (const hand of HANDS) {
      const q = gripToHandRotation(hand);
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9);
      const fingers = rotate3(q, { x: 0, y: 0, z: -1 });
      expect(fingers.y).toBeLessThan(-0.8); // still mostly away from the arm
      expect(fingers.z).toBeLessThan(0); // leaning toward the thumb end of the handle
      expect(Math.abs(fingers.x)).toBeLessThan(1e-9);
    }
    expectSameRotation(gripToHandRotation('left'), mirrorQuatX(gripToHandRotation('right')));
  });

  it('wrist sits behind the grip toward the arm and the back of the hand', () => {
    for (const hand of HANDS) {
      const w = wristFromGrip({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, hand);
      const d = Math.hypot(w.position.x, w.position.y, w.position.z);
      expect(d).toBeGreaterThan(0.06);
      expect(d).toBeLessThan(0.09);
      expect(w.position.y).toBeGreaterThan(0.05); // +Y_grip = toward the arm
      expect(hand === 'right' ? w.position.x > 0 : w.position.x < 0).toBe(true); // back of hand side
    }
    const o = gripToWristOffset('left', { x: 0.01, y: 0.025, z: 0.075 });
    expect(o.x).toBeCloseTo(-0.01);
    expect(o.y).toBeCloseTo(0.025);
    expect(o.z).toBeCloseTo(0.075);
  });

  it('follows the grip pose', () => {
    const rng = makeRng(5);
    const gq = randomQuat(rng);
    const gp = { x: 1, y: 1.2, z: -3 };
    const w = wristFromGrip(gp, gq, 'right');
    const local = wristFromGrip({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, 'right');
    expectSameRotation(w.rotation, quatMul(gq, local.rotation));
    const p = rotate3(gq, local.position);
    expectVec(w.position, { x: p.x + gp.x, y: p.y + gp.y, z: p.z + gp.z });
  });
});

describe('helpers', () => {
  it('radial deadzone', () => {
    expect(radialDeadzone(0.1, 0.1, 0.15)).toEqual({ x: 0, y: 0 });
    const full = radialDeadzone(0, -1, 0.15);
    expect(full.y).toBeCloseTo(-1);
    const diag = radialDeadzone(1, 1, 0.15);
    expect(Math.hypot(diag.x, diag.y)).toBeCloseTo(1);
    const edge = radialDeadzone(0.16, 0, 0.15);
    expect(edge.x).toBeGreaterThan(0);
    expect(edge.x).toBeLessThan(0.02);
  });

  it('hysteresis', () => {
    expect(hysteresisAbove(false, 0.5, 0.6, 0.4)).toBe(false);
    expect(hysteresisAbove(false, 0.65, 0.6, 0.4)).toBe(true);
    expect(hysteresisAbove(true, 0.5, 0.6, 0.4)).toBe(true);
    expect(hysteresisAbove(true, 0.35, 0.6, 0.4)).toBe(false);
    expect(hysteresisBelow(false, 0.025, 0.02, 0.035)).toBe(false);
    expect(hysteresisBelow(false, 0.015, 0.02, 0.035)).toBe(true);
    expect(hysteresisBelow(true, 0.03, 0.02, 0.035)).toBe(true);
    expect(hysteresisBelow(true, 0.04, 0.02, 0.035)).toBe(false);
  });

  it('frameFromFingersBack builds an orthonormal canonical frame', () => {
    const q = frameFromFingersBack({ x: 0, y: 1, z: 0.1 }, { x: 0, y: 0, z: 1 });
    expectVec(rotate3(q, { x: 0, y: 0, z: -1 }), normalize3({ x: 0, y: 1, z: 0.1 }));
    const back = rotate3(q, { x: 0, y: 1, z: 0 });
    expect(back.z).toBeGreaterThan(0.99);
    // degenerate input still returns a unit quaternion
    const d = frameFromFingersBack({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(Math.hypot(d.x, d.y, d.z, d.w)).toBeCloseTo(1);
  });
});
