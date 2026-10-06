/** Small hand-made LevelData for the render preview (two rooms, every furniture style). */

import type { Box, LevelData, Vec3 } from '../../src/core/types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const box = (kind: Box['kind'], a: [number, number, number], b: [number, number, number], extra: Partial<Box> = {}): Box => ({
  kind, min: v(...a), max: v(...b), ...extra,
});

const H = 2.7;
const T = 0.15;

export function mockLevel(): LevelData {
  const boxes: Box[] = [
    box('floor', [-6, -0.1, -4], [6, 0, 4]),
    box('ceiling', [-6, H, -4], [6, H + 0.1, 4]),
    // Exterior walls.
    box('wall', [-6 - T, 0, -4 - T], [6 + T, H, -4]),
    box('wall', [-6 - T, 0, 4], [3, H, 4 + T]),
    box('wall', [4, 0, 4], [6 + T, H, 4 + T]),
    box('wall', [3, 2.1, 4], [4, H, 4 + T]),
    box('wall', [-6 - T, 0, -4], [-6, H, 4]),
    box('wall', [6, 0, -4], [6 + T, H, 4]),
    // Interior wall with a doorway at z 0.5..1.5.
    box('wall', [-T / 2, 0, -4], [T / 2, H, 0.5]),
    box('wall', [-T / 2, 0, 1.5], [T / 2, H, 4]),
    box('wall', [-T / 2, 2.1, 0.5], [T / 2, H, 1.5]),
    // Room A furniture.
    box('furniture', [-5.95, 0, -3.95], [-4.45, 0.95, -1.95], { style: 'bed' }),
    box('furniture', [-1.9, 0, -3.98], [-0.6, 1.9, -3.62], { style: 'shelf' }),
    box('furniture', [-2.7, 0, 3.05], [-0.6, 0.85, 3.98], { style: 'couch' }),
    box('furniture', [-3.6, 0, -0.45], [-2.4, 0.76, 0.45], { style: 'table' }),
    box('furniture', [-5.85, 0, 3.15], [-5.15, 0.6, 3.85], { style: 'crate' }),
    box('furniture', [-5.8, 0.6, 3.2], [-5.25, 1.05, 3.75], { style: 'crate' }),
    // Room B furniture.
    box('furniture', [0.4, 0, -3.98], [2.6, 0.92, -3.38], { style: 'counter' }),
    box('furniture', [5.42, 0, -2.6], [5.98, 2.0, -1.4], { style: 'cabinet' }),
    box('furniture', [5.36, 0, 0.1], [5.98, 1.25, 1.65], { style: 'piano' }),
    box('furniture', [2.6, 0, -0.6], [3.6, 0.75, 0.3], { style: 'table', color: 0x6a4a30 }),
  ];
  const door = box('wall', [3, 0, 4], [4, 2.1, 4 + T]);
  return {
    id: 'mock',
    seed: 1,
    bounds: { min: v(-6 - T, 0, -4 - T), max: v(6 + T, H, 4 + T) },
    boxes,
    nav: [
      { id: 0, position: v(-3, 0, 1.8), links: [1] },
      { id: 1, position: v(0, 0, 1), links: [0, 2] },
      { id: 2, position: v(3, 0, 1.8), links: [1] },
    ],
    playerSpawns: [
      { position: v(-2, 0, 2), yaw: 0 },
      { position: v(-2.5, 0, 2), yaw: 0 },
      { position: v(-3, 0, 2), yaw: 0 },
      { position: v(-3.5, 0, 2), yaw: 0 },
    ],
    monsterSpawn: v(4, 0, -1),
    cameraSpawn: { position: v(-3, 0.76, 0), yaw: 0.4 },
    fuseSpawns: [v(-2.9, 0.76, 0.1), v(1.2, 0.92, -3.7), v(4.5, 0, 2.5)],
    filmSpawns: [v(-3.3, 0.76, -0.2), v(-5.5, 1.05, 3.5)],
    fuseBox: { position: v(2.2, 1.35, 3.98), yaw: 0 },
    exit: { door, zone: { min: v(3, 0, 4 + T), max: v(4, 2.5, 5.3) } },
    windows: [
      { center: v(-3, 1.5, -4 - T / 2), width: 1.0, height: 1.2, yaw: Math.PI },
      { center: v(-6 - T / 2, 1.5, 0.8), width: 0.9, height: 1.2, yaw: -Math.PI / 2 },
      { center: v(3.2, 1.5, -4 - T / 2), width: 1.0, height: 1.2, yaw: Math.PI },
    ],
  };
}
