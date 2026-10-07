/**
 * Coarse waypoint-graph helpers (pure, engine-agnostic). The graph marks open spots in every room
 * (random monster spawns, debug views, level tests); the monster itself navigates on the fine
 * grid in navgrid.ts.
 */

import type { LevelData, NavNode, Vec3 } from './types';
import { distXZ } from './math';
import { segmentClear, type CollisionOptions } from './physics';

/**
 * Build nav nodes from positions, linking every pair closer than `maxLink` whose straight line is
 * clear for a circle of `clearance` radius. Node ids are their index in the returned array.
 */
export function buildNavGraph(
  level: LevelData,
  positions: Vec3[],
  clearance: number,
  maxLink: number,
): NavNode[] {
  const nodes: NavNode[] = positions.map((p, i) => ({ id: i, position: { x: p.x, y: p.y, z: p.z }, links: [] }));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i].position;
      const b = nodes[j].position;
      if (distXZ(a, b) > maxLink) continue;
      if (!segmentClear(level, a, b, clearance)) continue;
      nodes[i].links.push(j);
      nodes[j].links.push(i);
    }
  }
  return nodes;
}

function indexById(nav: NavNode[]): Record<number, number> {
  const idx: Record<number, number> = {};
  for (let i = 0; i < nav.length; i++) idx[nav[i].id] = i;
  return idx;
}

/** A* over the nav graph (edge cost = XZ distance). Returns node ids start..goal, or null. */
export function findPath(nav: NavNode[], startId: number, goalId: number): number[] | null {
  const idx = indexById(nav);
  const s = idx[startId];
  const g = idx[goalId];
  if (s === undefined || g === undefined) return null;
  if (s === g) return [startId];
  const n = nav.length;
  const gScore = new Array<number>(n).fill(Infinity);
  const fScore = new Array<number>(n).fill(Infinity);
  const came = new Array<number>(n).fill(-1);
  const closed = new Array<boolean>(n).fill(false);
  const open: number[] = [s];
  const goalPos = nav[g].position;
  gScore[s] = 0;
  fScore[s] = distXZ(nav[s].position, goalPos);
  while (open.length > 0) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (fScore[open[k]] < fScore[open[bi]]) bi = k;
    const cur = open[bi];
    open.splice(bi, 1);
    if (cur === g) {
      const path: number[] = [];
      for (let c = g; c !== -1; c = came[c]) path.push(nav[c].id);
      return path.reverse();
    }
    closed[cur] = true;
    for (const linkId of nav[cur].links) {
      const nb = idx[linkId];
      if (nb === undefined || closed[nb]) continue;
      const tentative = gScore[cur] + distXZ(nav[cur].position, nav[nb].position);
      if (tentative < gScore[nb]) {
        came[nb] = cur;
        gScore[nb] = tentative;
        fScore[nb] = tentative + distXZ(nav[nb].position, goalPos);
        if (!open.includes(nb)) open.push(nb);
      }
    }
  }
  return null;
}

/**
 * Id of the nav node closest to `p` that can be reached from `p` in a straight line (circle of
 * `clearance` radius). Falls back to the plain nearest node when none is visible; -1 if no nodes.
 */
export function nearestNavNode(
  level: LevelData,
  p: Vec3,
  clearance: number,
  opts?: CollisionOptions,
  exclude: number = -1,
): number {
  const order = level.nav
    .filter((n) => n.id !== exclude)
    .map((n) => ({ id: n.id, d: distXZ(n.position, p), pos: n.position }))
    .sort((a, b) => a.d - b.d || a.id - b.id);
  for (const o of order) {
    if (segmentClear(level, p, o.pos, clearance, opts)) return o.id;
  }
  return order.length > 0 ? order[0].id : -1;
}

/** Number of connected components of the nav graph (1 = fully connected). */
export function navComponents(nav: NavNode[]): number {
  const idx = indexById(nav);
  const seen = new Array<boolean>(nav.length).fill(false);
  let comps = 0;
  for (let i = 0; i < nav.length; i++) {
    if (seen[i]) continue;
    comps++;
    const stack = [i];
    seen[i] = true;
    while (stack.length > 0) {
      const c = stack.pop()!;
      for (const l of nav[c].links) {
        const j = idx[l];
        if (j !== undefined && !seen[j]) {
          seen[j] = true;
          stack.push(j);
        }
      }
    }
  }
  return comps;
}
