import { describe, expect, it } from 'vitest';
import { rotate3 } from '../../core/math';
import { desktopHandTarget, SIGN_MIN_SECONDS, SIGN_PRESETS, signCurlsAt, signForCode } from './signs';

describe('SIGN_PRESETS', () => {
  it('has the six documented signs on keys 1-6', () => {
    expect(SIGN_PRESETS.map((p) => p.key)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(SIGN_PRESETS.map((p) => p.id)).toEqual(['point', 'stop', 'thumbsUp', 'fist', 'three', 'comeHere']);
    expect(new Set(SIGN_PRESETS.map((p) => p.code)).size).toBe(6);
    for (const p of SIGN_PRESETS) {
      expect(p.code).toBe(`Digit${p.key}`);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.curls).toHaveLength(5);
      for (const c of p.curls) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
    expect(SIGN_MIN_SECONDS).toBeGreaterThanOrEqual(1.5);
  });

  it('curls read as the intended sign', () => {
    const by = Object.fromEntries(SIGN_PRESETS.map((p) => [p.id, p.curls]));
    const extended = (c: number[]) => c.map((x) => x < 0.3);
    expect(extended(by.point)).toEqual([false, true, false, false, false]);
    expect(extended(by.stop)).toEqual([true, true, true, true, true]);
    expect(extended(by.thumbsUp)).toEqual([true, false, false, false, false]);
    expect(extended(by.fist)).toEqual([false, false, false, false, false]);
    expect(extended(by.three).filter(Boolean)).toHaveLength(3);
  });

  it('come here animates the fingers, others are static', () => {
    const p = SIGN_PRESETS.find((s) => s.id === 'comeHere')!;
    const samples = [0, 0.1, 0.2, 0.3, 0.4, 0.5].map((t) => signCurlsAt(p, t)[2]);
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.5);
    const stop = SIGN_PRESETS.find((s) => s.id === 'stop')!;
    expect(signCurlsAt(stop, 0.3)).toEqual(stop.curls);
  });

  it('maps key codes (digits and numpad)', () => {
    expect(signForCode('Digit3')?.id).toBe('thumbsUp');
    expect(signForCode('Numpad6')?.id).toBe('comeHere');
    expect(signForCode('Digit7')).toBeNull();
    expect(signForCode('KeyW')).toBeNull();
  });
});

describe('desktop hand targets (camera-local)', () => {
  it('stop: raised ~0.4 m ahead, slightly right, fingers up, palm facing forward', () => {
    const t = desktopHandTarget('right', SIGN_PRESETS[1], 0);
    expect(t.position.z).toBeCloseTo(-0.4, 1);
    expect(t.position.x).toBeGreaterThan(0);
    expect(rotate3(t.rotation, { x: 0, y: 0, z: -1 }).y).toBeGreaterThan(0.95); // fingers up
    expect(rotate3(t.rotation, { x: 0, y: 1, z: 0 }).z).toBeGreaterThan(0.95); // back of hand toward the player
    // right hand: thumb (-X) toward the body's midline (left)
    expect(rotate3(t.rotation, { x: -1, y: 0, z: 0 }).x).toBeLessThan(-0.95);
  });

  it('thumbs up points the thumb up', () => {
    const t = desktopHandTarget('right', SIGN_PRESETS[2], 0);
    expect(rotate3(t.rotation, { x: -1, y: 0, z: 0 }).y).toBeGreaterThan(0.95);
  });

  it('come here: palm up', () => {
    const t = desktopHandTarget('right', SIGN_PRESETS[5], 0);
    expect(rotate3(t.rotation, { x: 0, y: 1, z: 0 }).y).toBeLessThan(-0.95);
  });

  it('rest poses: lower-left / lower-right, fingers forward, back of hand up, thumbs inward', () => {
    for (const hand of ['left', 'right'] as const) {
      const t = desktopHandTarget(hand, hand === 'left' ? SIGN_PRESETS[0] : null, 0); // signs are right-hand only
      expect(Math.sign(t.position.x)).toBe(hand === 'right' ? 1 : -1);
      expect(t.position.y).toBeLessThan(0);
      expect(t.position.z).toBeLessThan(0);
      expect(rotate3(t.rotation, { x: 0, y: 0, z: -1 }).z).toBeLessThan(-0.9);
      expect(rotate3(t.rotation, { x: 0, y: 1, z: 0 }).y).toBeGreaterThan(0.8);
      const thumbDir = rotate3(t.rotation, { x: hand === 'right' ? -1 : 1, y: 0, z: 0 });
      expect(Math.sign(thumbDir.x)).toBe(hand === 'right' ? -1 : 1);
      expect(t.curls).toEqual([0.3, 0.3, 0.3, 0.3, 0.3]);
    }
  });
});
