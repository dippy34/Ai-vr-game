"""
Game mesh for the Listener (helper for monster.py; build() is a no-op): decimate the sculpt to
the triangle budget with extra density where it matters (face, hands, ears, joints), cut UV charts
from body-part labels and bake the sculpt's procedural skin into 2048^2 images.
"""

from __future__ import annotations

import math

import bpy
import bmesh
import numpy as np
from mathutils import kdtree

import common
import monster_anatomy as A
import monster_sdf as S


def build() -> None:
    print('[monster_mesh] helper module, nothing to build')


def verts_np(ob) -> np.ndarray:
    a = np.empty(len(ob.data.vertices) * 3, np.float32)
    ob.data.vertices.foreach_get('co', a)
    return a.reshape(-1, 3).astype(np.float64)


def kd(points) -> kdtree.KDTree:
    t = kdtree.KDTree(len(points))
    for i, p in enumerate(points):
        t.insert(p, i)
    t.balance()
    return t


def transfer_labels(high_V, high_labels, P) -> np.ndarray:
    """Body-part label of the nearest sculpt vertex for each point of P (same units)."""
    t = kd(high_V)
    return np.array([high_labels[t.find(p)[1]] for p in P], np.int16)


# ---------------------------------------------------------------------------------------------
# decimation
# ---------------------------------------------------------------------------------------------

def density(Vd, labels, J) -> np.ndarray:
    """Per sculpt vertex importance for the decimator (0..1, design units): face, mouth, hands,
    ears and the bending joints keep more triangles; the back of the legs gets fewer."""
    lab = np.array(A.LABEL_NAMES)[labels]
    w = np.full(len(Vd), 0.30)
    head = np.isin(lab, ['head', 'jaw_L', 'jaw_R'])
    w[head] = 0.75
    w[np.isin(lab, ['ear_L', 'ear_R'])] = 0.65
    face = head & (Vd[:, 1] > 0.27)
    w[face] = 0.95
    w[np.isin(lab, ['neck'])] = 0.5
    for side in ('L', 'R'):
        R_ = J[side]
        w[np.isin(lab, [f'hand_{side}'] + [f'{f}_{side}' for f in A.FINGERS])] = 0.9
        for jnt, rad, val in ((R_['E'], 0.075, 0.75), (R_['K'], 0.09, 0.7), (R_['S'], 0.11, 0.65),
                              (R_['W'], 0.05, 0.8), (R_['H'], 0.10, 0.55), (R_['A'], 0.06, 0.55)):
            d = np.linalg.norm(Vd - jnt, axis=1)
            w = np.maximum(w, val * (1 - S.smoothstep(rad * 0.5, rad, d)))
    return np.clip(w, 0, 1)


def decimate(low, target_tris, weights=None) -> None:
    m = low.modifiers.new('decimate', 'DECIMATE')
    m.ratio = target_tris / max(1, sum(len(p.vertices) - 2 for p in low.data.polygons))
    m.use_collapse_triangulate = True
    m.use_symmetry = True
    m.symmetry_axis = 'X'
    if weights is not None:
        g = low.vertex_groups.new(name='density')
        for val in np.unique(np.round(weights, 2)):
            idx = np.nonzero(np.round(weights, 2) == val)[0]
            g.add([int(i) for i in idx], float(val), 'REPLACE')
        m.vertex_group = 'density'
        m.vertex_group_factor = 4.0
        m.invert_vertex_group = True
    common.apply_modifiers(low)
    if weights is not None and low.vertex_groups.get('density'):
        low.vertex_groups.remove(low.vertex_groups['density'])
    low.data.validate()


# ---------------------------------------------------------------------------------------------
# UV charts
# ---------------------------------------------------------------------------------------------

# texel-density weights per chart (area multiplier): the face, hands and ears get the most
CHART_WEIGHT = {'head': 3.6, 'ear': 1.5, 'neck': 1.4, 'torso_f': 1.15, 'torso_b': 0.95, 'pelvis_f': 0.7,
                'pelvis_b': 0.6, 'upper_arm': 0.95, 'forearm': 1.25, 'hand': 2.6, 'finger': 2.6,
                'thigh': 0.6, 'shin': 0.6, 'foot': 0.7}


def chart_unwrap(low, llab, J, scale):
    """UV charts from body-part labels: region borders + one hidden cut per tube, angle-based
    (minimum stretch) unwrap, texel density weighted per chart, concave packing."""
    me = low.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    bm.verts.ensure_lookup_table()
    names = A.LABEL_NAMES
    nf = len(bm.faces)
    fl = np.array([np.bincount([llab[v.index] for v in f.verts]).argmax() for f in bm.faces])
    nbr = [[e.link_faces[0].index if e.link_faces[0] != f else e.link_faces[1].index
            for e in f.edges if len(e.link_faces) == 2] for f in bm.faces]
    for _ in range(3):
        new = fl.copy()
        for i in range(nf):
            cnt = np.bincount([fl[j] for j in nbr[i]] + [fl[i]])
            if cnt.max() >= 2 and cnt.argmax() != fl[i] and (np.array([fl[j] for j in nbr[i]]) != fl[i]).sum() >= 2:
                new[i] = cnt.argmax()
        fl = new
    cen = np.array([f.calc_center_median()[:] for f in bm.faces])
    fno = np.array([f.normal[:] for f in bm.faces])

    def chart_of(i):
        n = names[fl[i]]
        c, nn = cen[i], fno[i]
        if n in ('head', 'jaw_L', 'jaw_R'):
            return 'head'
        if n.startswith('ear'):
            side = n[-1]
            e_w = J[side]['ear'][2]
            return f'ear_{side}_' + ('f' if np.dot(nn, e_w) > 0 else 'b')
        if n == 'neck':
            return 'neck'
        if n in ('torso', 'pelvis'):
            front = c[1] / scale > (0.025 if c[2] / scale > 1.25 else -0.03)
            return ('torso_' if n == 'torso' else 'pelvis_') + ('f' if front else 'b')
        side = n[-2:]
        part = n[:-2]
        if part == 'clav':
            part = 'upper_arm'
        if part == 'hand':
            return 'hand' + side + ('_p' if np.dot(nn, J[side[1]]['hn']) > 0 else '_d')
        if part == 'foot':
            return 'foot' + side + ('_t' if nn[2] > -0.35 else '_b')
        return part + side

    ch = [chart_of(i) for i in range(nf)]
    # absorb small disconnected fragments of a chart into the neighbouring chart they touch most
    for _ in range(6):
        comp = -np.ones(nf, int)
        sizes = []
        for i in range(nf):
            if comp[i] >= 0:
                continue
            stack, cid = [i], len(sizes)
            comp[i] = cid
            n_ = 0
            while stack:
                k = stack.pop()
                n_ += 1
                for j in nbr[k]:
                    if comp[j] < 0 and ch[j] == ch[k]:
                        comp[j] = cid
                        stack.append(j)
            sizes.append(n_)
        sizes = np.array(sizes)
        small = sizes[comp] < 40
        if not small.any():
            break
        changed = False
        for i in np.nonzero(small)[0]:
            votes = {}
            for j in nbr[i]:
                if ch[j] != ch[i]:
                    votes[ch[j]] = votes.get(ch[j], 0) + (0 if sizes[comp[j]] < 40 else 1) + 0.01
            if votes:
                ch[i] = max(votes, key=votes.get)
                changed = True
        if not changed:
            break
    # tube cuts: (axis a->b, hidden-side reference direction)
    cuts = {'head': (S.v3(0, 0.20, 1.98) * scale, S.v3(0, 0.20, 2.40) * scale, S.v3(0, -1, 0)),
            'neck': (S.v3(J['C7']), S.v3(J['atlas']), S.v3(0, -1, 0))}
    for side, s_ in (('L', -1), ('R', 1)):
        R_ = J[side]
        sf = '_' + side
        inward = S.v3(-s_, 0, -1.0)
        cuts['upper_arm' + sf] = (R_['S'], R_['E'], inward)
        cuts['forearm' + sf] = (R_['E'], R_['W'], inward)
        cuts['thigh' + sf] = (R_['H'], R_['K'], S.v3(-0.7 * s_, -0.7, 0))
        cuts['shin' + sf] = (R_['K'], R_['A'], S.v3(0, -1, 0))
        for f in A.FINGERS:
            pts = R_[f + '_pts']
            cuts[f + sf] = (pts[0], pts[3], R_['hn'])
    theta = np.zeros(nf)
    for i in range(nf):
        c = ch[i]
        if c in cuts:
            a, b, r = cuts[c]
            ax = S.normalize(b - a)
            q = cen[i] - a
            q = q - ax * np.dot(q, ax)
            r1 = S.normalize(r - ax * np.dot(r, ax))
            r2 = np.cross(ax, r1)
            theta[i] = math.atan2(np.dot(q, r2), np.dot(q, r1))
    bm.edges.ensure_lookup_table()
    ne = len(bm.edges)
    seam = np.zeros(ne, bool)
    ef = [[f.index for f in e.link_faces] for e in bm.edges]
    for e in bm.edges:
        lf = ef[e.index]
        if len(lf) != 2:
            seam[e.index] = True
            continue
        i, j = lf
        if ch[i] != ch[j]:
            seam[e.index] = True
        elif ch[i] in cuts:
            ti, tj = theta[i], theta[j]
            if abs(ti) < math.pi / 2 and abs(tj) < math.pi / 2 and ti * tj < 0:
                seam[e.index] = True
    # cut graph: per chart, a spanning tree of its faces that prefers to keep visible edges
    # (crossing them), every other interior edge becomes a cut, then dangling cuts are pruned
    # back to the boundary. Each chart is then a topological disk with its seams on its hidden
    # side (the forced tube cuts above stay).
    hidden = {c: S.normalize(v[2]) for c, v in cuts.items()}
    ev = np.array([[v.index for v in e.verts] for e in bm.edges])
    enrm = np.array([sum((fno[f] for f in lf), np.zeros(3)) for lf in ef])
    enrm /= np.maximum(np.linalg.norm(enrm, axis=1, keepdims=True), 1e-9)
    import heapq
    chart_faces: dict = {}
    for i in range(nf):
        chart_faces.setdefault(ch[i], []).append(i)
    face_edges = [[e.index for e in f.edges] for f in bm.faces]
    n_cut = 0
    for c, fs in chart_faces.items():
        hd = hidden.get(c, S.v3(0, -1, 0))
        in_tree = set()
        seen = np.zeros(nf, bool)
        fset = set(fs)
        for seed in fs:
            if seen[seed]:
                continue
            seen[seed] = True
            pq = []
            for e in face_edges[seed]:
                if not seam[e]:
                    heapq.heappush(pq, (float(enrm[e] @ hd), e, seed))
            while pq:
                w, e, src = heapq.heappop(pq)
                lf = ef[e]
                other = lf[0] if lf[1] == src else lf[1]
                if seen[other] or other not in fset:
                    continue
                seen[other] = True
                in_tree.add(e)
                for e2 in face_edges[other]:
                    if not seam[e2] and e2 not in in_tree:
                        heapq.heappush(pq, (float(enrm[e2] @ hd), e2, other))
        # cut candidates: interior chart edges not crossed by the tree
        cand = set()
        for f in fs:
            for e in face_edges[f]:
                lf = ef[e]
                if len(lf) == 2 and ch[lf[0]] == ch[lf[1]] and not seam[e] and e not in in_tree:
                    cand.add(e)
        # prune dangling candidate edges (vertex of degree 1 in candidates + existing seams)
        deg: dict = {}
        vert_edges: dict = {}
        for f in fs:
            for e in face_edges[f]:
                if seam[e] or e in cand:
                    for v in ev[e]:
                        vert_edges.setdefault(v, set()).add(e)
        for v, es_ in vert_edges.items():
            deg[v] = len(es_)
        stack = [v for v, d in deg.items() if d == 1]
        while stack:
            v = stack.pop()
            if deg.get(v, 0) != 1:
                continue
            es_ = [e for e in vert_edges[v] if e in cand]
            if not es_:
                continue
            e = es_[0]
            cand.discard(e)
            for u in ev[e]:
                vert_edges[u].discard(e)
                deg[u] -= 1
                if deg[u] == 1:
                    stack.append(u)
        for e in cand:
            seam[e] = True
        n_cut += len(cand)
    for e in bm.edges:
        e.seam = bool(seam[e.index])
    bm.to_mesh(me)
    bm.free()
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    common.activate(low)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    try:
        bpy.ops.uv.unwrap(method='MINIMUM_STRETCH', fill_holes=False, margin=0.004, iterations=30)
    except Exception as exc:
        print('[monster_mesh] SLIM unwrap failed, ABF instead:', exc)
        bpy.ops.uv.unwrap(method='ANGLE_BASED', fill_holes=False, margin=0.004)
    bpy.ops.uv.average_islands_scale()
    print(f'[monster_mesh] cut graph: {n_cut} cut edges')
    bpy.ops.object.mode_set(mode='OBJECT')
    # weight texel density per chart: scale each face's loops about its chart's UV centroid
    uv = me.uv_layers.active.data
    loops_by_chart: dict = {}
    for p in me.polygons:
        loops_by_chart.setdefault(ch[p.index], []).extend(range(p.loop_start, p.loop_start + p.loop_total))
    co = np.zeros(len(uv) * 2)
    uv.foreach_get('uv', co)
    co = co.reshape(-1, 2)
    for c, loops in loops_by_chart.items():
        key = c.split('_')[0] if not c.startswith(('upper_arm', 'torso', 'pelvis')) else '_'.join(c.split('_')[:2])
        key = {'thumb': 'finger', 'index': 'finger', 'middle': 'finger', 'ring': 'finger', 'pinky': 'finger',
               'upper': 'upper_arm'}.get(key, key)
        if key.startswith('upper_arm'):
            key = 'upper_arm'
        w = CHART_WEIGHT.get(key, 1.0)
        L = np.array(loops)
        ctr = co[L].mean(0)
        co[L] = ctr + (co[L] - ctr) * math.sqrt(w)
    uv.foreach_set('uv', co.ravel())
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.0030, shape_method='CONCAVE')
    bpy.ops.object.mode_set(mode='OBJECT')
    me.uv_layers.active.name = 'UVMap'
    print(f'[monster_mesh] uv charts: {len(set(ch))}')


def uv_report(low) -> dict:
    """UV coverage, texel density spread (UV area / 3D area per face, normalized) and flips."""
    me = low.data
    me.calc_loop_triangles()
    uv = np.zeros(len(me.loops) * 2)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    co = np.array([v.co[:] for v in me.vertices])
    tl = np.array([t.loops[:] for t in me.loop_triangles])
    tv = np.array([t.vertices[:] for t in me.loop_triangles])
    a, b, c = uv[tl[:, 0]], uv[tl[:, 1]], uv[tl[:, 2]]
    uva = 0.5 * ((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0]))
    pa = 0.5 * np.linalg.norm(np.cross(co[tv[:, 1]] - co[tv[:, 0]], co[tv[:, 2]] - co[tv[:, 0]]), axis=1)
    dens = np.abs(uva) / np.maximum(pa, 1e-12)
    med = np.median(dens)
    r = dens / med
    flips = int((uva < 0).sum())
    rep = {'coverage': float(np.abs(uva).sum()), 'flipped': flips,
           'density_p05_p95': (float(np.percentile(r, 5)), float(np.percentile(r, 95))),
           'texel_mm_median': float(1000 * math.sqrt(1 / (med * 2048 * 2048)))}
    print('[monster_mesh] uv', rep)
    # islands (faces sharing a vertex at the same UV), with their Euler characteristic
    key = np.round(uv * 2 ** 20).astype(np.int64)
    lv = np.array([l.vertex_index for l in me.loops])
    uvv: dict = {}
    corner = np.array([uvv.setdefault((lv[i], key[i, 0], key[i, 1]), len(uvv)) for i in range(len(lv))])
    par = np.arange(len(uvv))

    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x
    for p in me.polygons:
        cs = corner[p.loop_start:p.loop_start + p.loop_total]
        for cc in cs[1:]:
            ra, rb = find(cs[0]), find(cc)
            if ra != rb:
                par[ra] = rb
    isl: dict = {}
    for p in me.polygons:
        cs = corner[p.loop_start:p.loop_start + p.loop_total]
        d = isl.setdefault(find(cs[0]), {'F': 0, 'V': set(), 'E': set(), 'faces': []})
        d['F'] += 1
        d['faces'].append(p.index)
        d['V'].update(cs.tolist())
        for k in range(len(cs)):
            a_, b_ = cs[k], cs[(k + 1) % len(cs)]
            d['E'].add((min(a_, b_), max(a_, b_)))
    bad = []
    for d in isl.values():
        chi = len(d['V']) - len(d['E']) + d['F']
        if chi != 1:
            bad.append((chi, d['F'], np.round(np.mean([me.polygons[f].center[:] for f in d['faces']], 0), 3).tolist()))
    rep['islands'] = len(isl)
    rep['non_disk'] = bad
    print(f'[monster_mesh] uv islands: {len(isl)}, non-disk (chi, faces, center): {bad}')
    return rep


def build_low(high, high_V_design, high_labels, J, scale, target_tris, density_w=None):
    """Decimated, UV-charted copy of the sculpt `high` (meters). Returns (low, labels per vertex)."""
    low = high.copy()
    low.data = high.data.copy()
    low.name = 'monster_body'
    low.data.name = 'monster_body'
    bpy.context.scene.collection.objects.link(low)
    for nm in [a.name for a in low.data.color_attributes]:
        low.data.color_attributes.remove(low.data.color_attributes[nm])
    low.data.materials.clear()
    decimate(low, target_tris, density_w)
    print(f'[monster_mesh] decimated: {common.tri_count([low])} tris')
    common.smooth(low, 180)
    llab = transfer_labels(high_V_design, high_labels, verts_np(low) / scale)
    chart_unwrap(low, llab, J, scale)
    return low, llab
