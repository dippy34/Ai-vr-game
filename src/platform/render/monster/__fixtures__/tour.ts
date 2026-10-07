/** Test helper: a scripted sim (MonsterState per 1/60 s frame) touring the house. */

import type { MonsterAct, MonsterGait, MonsterPosture, MonsterState, Vec3 } from '../../../../core/types';

export const FPS = 60;

export interface Seg {
  to?: [number, number];
  speed?: number;
  wait?: number;
  gait?: MonsterGait;
  posture?: MonsterPosture;
  act?: MonsterAct;
  focus?: Vec3 | null;
  mode?: MonsterState['mode'];
  y?: (x: number, z: number) => number;
}

/** A scripted sim: straight segments at a speed (yaw turns at the sim's 4.5 rad/s), waits. */
export function* script(start: [number, number], segs: Seg[]): Generator<MonsterState> {
  const m: MonsterState = {
    position: { x: start[0], y: 0, z: start[1] }, yaw: 0, mode: 'wander', target: null, targetPlayer: null, speed: 0, alert: 0.4,
    gait: 'still', posture: 'tall', act: 'none', actStart: 0, focus: null,
  };
  let t = 0;
  let y = (_x: number, _z: number) => 0;
  for (const s of segs) {
    if (s.gait) m.gait = s.gait;
    if (s.posture) m.posture = s.posture;
    if (s.mode) m.mode = s.mode;
    if (s.focus !== undefined) m.focus = s.focus;
    if (s.y) y = s.y;
    if (s.act && s.act !== m.act) {
      m.act = s.act;
      m.actStart = t;
    }
    if (s.to) {
      const [tx, tz] = s.to;
      for (;;) {
        const dx = tx - m.position.x;
        const dz = tz - m.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 1e-3) break;
        const want = Math.atan2(-dx, -dz);
        const e = Math.atan2(Math.sin(want - m.yaw), Math.cos(want - m.yaw));
        m.yaw += Math.max(-4.5 / FPS, Math.min(4.5 / FPS, e));
        const step = Math.min(d, (s.speed ?? 1) / FPS);
        m.position = { x: m.position.x + (dx / d) * step, y: 0, z: m.position.z + (dz / d) * step };
        m.position.y = y(m.position.x, m.position.z);
        m.speed = s.speed ?? 1;
        t += 1 / FPS;
        yield m;
      }
    }
    m.speed = 0;
    for (let i = 0; i < (s.wait ?? 0) * FPS; i++) {
      t += 1 / FPS;
      yield m;
    }
  }
}

const coffee = (x: number, z: number) => (x > -8.3 && x < -7.1 && z > 4.2 && z < 4.8 ? 0.45 : 0);

/** Through the living-room door, around the room, over the coffee table, the acts, a run. */
export const TOUR: Seg[] = [
  { to: [-6.45, -0.2], speed: 1 },
  { to: [-6.45, 2.6], speed: 0.9 },
  { to: [-5.6, 3.4], speed: 1 },
  { wait: 0.6 },
  { to: [-6.4, 4.5], speed: 0.6, gait: 'creep' },
  { act: 'climb', posture: 'crawl', y: coffee, to: [-9.2, 4.5], speed: 0.4 },
  { act: 'none', posture: 'tall', gait: 'still', wait: 1 },
  { act: 'listen', focus: { x: -6, y: 1.2, z: 2.5 }, wait: 2 },
  { act: 'sniff', focus: { x: -8.5, y: 0.5, z: 3.5 }, wait: 1.5 },
  { act: 'sweep', focus: { x: -8.6, y: 1, z: 3.6 }, wait: 2.3 },
  { act: 'search', focus: { x: -8.8, y: 0, z: 3.2 }, wait: 3 },
  { act: 'none', focus: null, gait: 'run', mode: 'chase', to: [-5.0, 3.0], speed: 3.1 },
  { gait: 'still', mode: 'wander', wait: 1 },
];
