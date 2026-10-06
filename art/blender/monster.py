"""
MUTE monster: "the Listener" -> public/models/monster.glb (+ art/previews/monster_*.png).

Pipeline (all procedural, headless):
  1. Sculpt: the body is a signed-distance program (monster_anatomy: skin envelopes with ribs,
     spine knobs, clavicles, knobby joints, sunken sockets, split vertical mouth, ragged ears,
     skull ear-holes pushed through it) polygonized at 2.5 mm with surface nets (monster_sdf).
  2. Paint: per-vertex masks (cavity, mouth/holes, sockets, extremities, gums, veins, ears)
     drive a procedural wet-skin shader (mottling, bruises, voronoi veins, AO, bump detail).
  3. Game mesh: collapse-decimate the sculpt to ~12.9k tris, smart-UV, bake color/roughness/
     tangent normals from the sculpt at 2048^2 (WebP). Needle teeth + dark claws are separate
     low-poly geometry with a tiny second material (2 materials total).
  4. Rig: 59 bones, automatic weights + label-based cleanup + hand-authored jaw/ear weights.
  5. Actions: Idle, Walk (1.0 m/s), Run (3.1 m/s), Listen, Attack (one-shot), Feed - in place.

Run: `npm run assets -- monster`. Env: MONSTER_H (voxel size, default 0.0025), MONSTER_FAST=1
(lower-res everything for quick iteration), MONSTER_NOPREVIEW=1.
"""

from __future__ import annotations

import math
import os
import sys
import time

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import common  # noqa: E402
import monster_anatomy as A  # noqa: E402
import monster_rig as RIG  # noqa: E402
import monster_sdf as S  # noqa: E402

FAST = os.environ.get('MONSTER_FAST') == '1'
H_HIGH = float(os.environ.get('MONSTER_H', '0.004' if FAST else '0.0025'))
TEX = 1024 if FAST else 2048
LOW_TRIS = 12900
SCALE = 1.15          # design units -> meters (hunched Idle stands ~2.1 m, upright ~2.6 m)
NAME = 'monster'


def log(msg, t0=[time.time()]):
    print(f'[monster {time.time() - t0[0]:6.1f}s] {msg}', flush=True)


# ---------------------------------------------------------------------------------------------
# mesh helpers
# ---------------------------------------------------------------------------------------------

def mesh_obj(name, V, Q) -> bpy.types.Object:
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(V))
    me.vertices.foreach_set('co', V.astype(np.float32).ravel())
    me.loops.add(Q.size)
    me.loops.foreach_set('vertex_index', Q.astype(np.int32).ravel())
    me.polygons.add(len(Q))
    me.polygons.foreach_set('loop_start', np.arange(0, Q.size, Q.shape[1], dtype=np.int32))
    me.update(calc_edges=True)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def verts_np(ob) -> np.ndarray:
    a = np.empty(len(ob.data.vertices) * 3, np.float32)
    ob.data.vertices.foreach_get('co', a)
    return a.reshape(-1, 3).astype(np.float64)


def vertex_normals(V, Q) -> np.ndarray:
    a, b, c, d = V[Q[:, 0]], V[Q[:, 1]], V[Q[:, 2]], V[Q[:, 3]]
    fn = np.cross(c - a, d - b)
    N = np.zeros_like(V)
    for k in range(4):
        for ax in range(3):
            N[:, ax] += np.bincount(Q[:, k], weights=fn[:, ax], minlength=len(V))
    return N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)


def graph_smooth_scalar(E, nv, x, iters):
    deg = np.bincount(E.ravel(), minlength=nv).astype(np.float64)
    for _ in range(iters):
        s = np.bincount(E[:, 0], weights=x[E[:, 1]], minlength=nv) + np.bincount(E[:, 1], weights=x[E[:, 0]], minlength=nv)
        x = 0.5 * x + 0.5 * s / np.maximum(deg, 1)
    return x


def graph_smooth_pos(E, nv, V, iters):
    out = V.copy()
    for ax in range(3):
        out[:, ax] = graph_smooth_scalar(E, nv, V[:, ax], iters)
    return out


def set_color_attr(ob, name, rgba):
    me = ob.data
    at = me.color_attributes.new(name, 'FLOAT_COLOR', 'POINT')
    at.data.foreach_set('color', np.clip(rgba, 0, 1).astype(np.float32).ravel())


def eval_labels(B, P) -> np.ndarray:
    out = np.zeros(len(P), np.int16)
    for s in range(0, len(P), 60000):
        _, lab = B.eval(P[s:s + 60000].astype(np.float32), want_label=True)
        out[s:s + 60000] = lab
    return out


def _labels_job(chunk):
    B, P = S._JOB
    return eval_labels(B, P[chunk[0]:chunk[1]])


def eval_labels_parallel(B, P, workers=3) -> np.ndarray:
    import multiprocessing as mp
    S._JOB = (B, P)
    n = len(P)
    cuts = np.linspace(0, n, workers * 3 + 1).astype(int)
    chunks = [(cuts[i], cuts[i + 1]) for i in range(len(cuts) - 1)]
    with mp.get_context('fork').Pool(workers) as pool:
        res = pool.map(_labels_job, chunks)
    return np.concatenate(res)


# ---------------------------------------------------------------------------------------------
# texture masks (per high-res vertex)
# ---------------------------------------------------------------------------------------------

def masks(V, Q, labels, J, info):
    nv = len(V)
    E = np.concatenate([Q[:, [0, 1]], Q[:, [1, 2]], Q[:, [2, 3]], Q[:, [3, 0]]])
    E = np.unique(np.sort(E, 1), axis=0)
    N = vertex_normals(V, Q)
    # cavity at two scales (positive = concave)
    Vs = graph_smooth_pos(E, nv, V, 5)
    cav_s = ((Vs - V) * N).sum(1) / 0.0012
    Vl = graph_smooth_pos(E, nv, V, 28)
    cav_l = ((Vl - V) * N).sum(1) / 0.005
    lab = np.array(A.LABEL_NAMES)[labels]

    def ss(a, b, x):
        t = np.clip((x - a) / (b - a), 0, 1)
        return t * t * (3 - 2 * t)

    x, y, z = V[:, 0], V[:, 1], V[:, 2]
    # mouth slit + cavity, nostrils, ear canals, skull pits -> near-black wet red
    dark = np.zeros(nv)
    head = np.isin(labels, [A.LAB['head'], A.LAB['jaw_L'], A.LAB['jaw_R']])
    slit = S.Ellipsoid(S.v3(0, 0.366, 2.045), S.v3(0.0042, 0.024, 0.050)).eval(V.astype(np.float32))
    cav = S.Ellipsoid(S.v3(0, 0.336, 2.045), S.v3(0.0140, 0.024, 0.044)).eval(V.astype(np.float32))
    dm = np.minimum(slit, cav)
    dark = np.maximum(dark, (1 - ss(0.0005, 0.0045, dm)) * head)
    for p, nrm, r in info['holes']:
        d = np.linalg.norm(V - (p + nrm * r * 0.25), axis=1) - r
        dark = np.maximum(dark, 1 - ss(0.0, 0.0022, d))
    for side, s_ in (('L', -1), ('R', 1)):
        base = J[side]['ear'][0]
        d = np.linalg.norm(V - (base + S.v3(0.008 * s_, 0.010, -0.010)), axis=1) - 0.0085
        dark = np.maximum(dark, 1 - ss(0.0, 0.004, d))
        for s2 in (1,):
            pass
    for s_ in (1, -1):
        rc = S.RoundCone(S.v3(0.0055 * s_, 0.366, 2.098), S.v3(0.0085 * s_, 0.360, 2.116), 0.0030, 0.0026)
        dark = np.maximum(dark, 1 - ss(0.0, 0.002, rc.eval(V.astype(np.float32))))
    # inflamed rims: around pits, gums, mouth
    infl = np.zeros(nv)
    for p, nrm, r in info['holes']:
        d = np.linalg.norm(V - p, axis=1)
        infl = np.maximum(infl, 1 - ss(r * 1.0, r * 2.4, d))
    infl = np.maximum(infl, (1 - ss(0.002, 0.010, dm)) * head)
    # sockets (bruised, stretched)
    sock = np.zeros(nv)
    for s_ in (1, -1):
        d = S.Ellipsoid(S.v3(0.030 * s_, 0.364, 2.140), S.v3(0.024, 0.020, 0.019)).eval(V.astype(np.float32))
        sock = np.maximum(sock, (1 - ss(-0.004, 0.012, d)) * head)
    # extremities: fingers/toes darken toward the tips; knees/elbows grimy
    ext = np.zeros(nv)
    for side in ('L', 'R'):
        R_ = J[side]
        for f in A.FINGERS:
            pts = R_[f + '_pts']
            k0, tip = pts[0], pts[3]
            ax = tip - k0
            t = np.clip(((V - k0) @ ax) / np.dot(ax, ax), 0, 1)
            sel = (lab == f'{f}_{side}') | (lab == f'hand_{side}')
            ext = np.maximum(ext, sel * ss(0.25, 1.0, t) * 0.9)
        Wp = R_['W']
        ext = np.maximum(ext, (lab == f'hand_{side}') * 0.25)
        for (base, p1, p2, r, d2) in R_['toes'].values():
            t = np.clip(((V - base) @ (p2 - base)) / np.dot(p2 - base, p2 - base), 0, 1)
            dd = np.linalg.norm(V - (base + np.outer(t, p2 - base)), axis=1)
            ext = np.maximum(ext, (lab == f'foot_{side}') * (dd < r * 2.2) * ss(-0.2, 1.0, t))
        ext = np.maximum(ext, (lab == f'foot_{side}') * (0.35 + 0.4 * ss(0.06, 0.0, z)))
        for jnt, rad in ((R_['K'], 0.07), (R_['E'], 0.05)):
            d = np.linalg.norm(V - jnt, axis=1)
            ext = np.maximum(ext, 0.45 * (1 - ss(0.0, rad, d)))
    # veins: where the skin is thinnest
    vein = 0.35 + 0.0 * x
    vein += 0.5 * np.isin(labels, [A.LAB['neck'], A.LAB['ear_L'], A.LAB['ear_R']])
    vein += 0.45 * head * ss(2.12, 2.20, z) * (1 - ss(0.30, 0.34, y))     # temples / skull
    for side in ('L', 'R'):
        vein += 0.45 * np.isin(lab, [f'forearm_{side}', f'hand_{side}', f'upper_arm_{side}'])
        vein += 0.25 * np.isin(lab, [f'thigh_{side}', f'shin_{side}'])
    vein += 0.35 * (lab == 'torso') * ss(1.45, 1.75, z) * ss(-0.02, 0.06, y)   # upper chest
    vein = np.clip(vein, 0, 1)
    ear = np.isin(labels, [A.LAB['ear_L'], A.LAB['ear_R']]).astype(float)
    ear = graph_smooth_scalar(E, nv, ear, 3)
    mA = np.stack([np.clip(cav_s * 0.5 + 0.5, 0, 1), np.clip(cav_l * 0.5 + 0.5, 0, 1), dark, ext], 1)
    mB = np.stack([ear, sock, vein, infl], 1)
    return mA, mB


# ---------------------------------------------------------------------------------------------
# procedural skin shader (lives on the sculpt; baked down to images)
# ---------------------------------------------------------------------------------------------

class NB:
    def __init__(self, mat):
        self.nt = mat.node_tree
        self.nt.nodes.clear()
        self.y = 0

    def n(self, kind, **kw):
        node = self.nt.nodes.new(kind)
        node.location = (self.y * 0, -self.y * 30)
        self.y += 1
        for k, v in kw.items():
            if k.startswith('in_'):
                self.set(node.inputs[k[3:].replace('_', ' ')], v)
            else:
                setattr(node, k, v)
        return node

    def set(self, sock, v):
        if isinstance(v, bpy.types.NodeSocket):
            self.nt.links.new(v, sock)
        elif isinstance(v, (tuple, list)):
            if len(v) == 3 and sock.type == 'RGBA':
                v = (*v, 1.0)
            sock.default_value = v
        else:
            sock.default_value = v

    def math(self, op, a, b=0.0, clamp=False):
        m = self.n('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.set(m.inputs[0], a)
        self.set(m.inputs[1], b)
        return m.outputs[0]

    def mix(self, fac, a, b, blend='MIX', clamp=True):
        m = self.n('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_result=clamp)
        self.set(m.inputs['Factor'], fac)
        self.set(m.inputs[6], a)
        self.set(m.inputs[7], b)
        return m.outputs[2]

    def mixf(self, fac, a, b):
        m = self.n('ShaderNodeMix', data_type='FLOAT')
        self.set(m.inputs['Factor'], fac)
        self.set(m.inputs[2], a)
        self.set(m.inputs[3], b)
        return m.outputs[0]

    def ramp(self, fac, a, b):
        """Smoothstep remap of fac from [a, b] to [0, 1]."""
        m = self.n('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP')
        self.set(m.inputs['Value'], fac)
        m.inputs['From Min'].default_value = a
        m.inputs['From Max'].default_value = b
        return m.outputs[0]

    def noise(self, vec, scale, detail=3.0, rough=0.55, distortion=0.0, w=None):
        m = self.n('ShaderNodeTexNoise', noise_dimensions='3D')
        self.set(m.inputs['Vector'], vec)
        m.inputs['Scale'].default_value = scale
        m.inputs['Detail'].default_value = detail
        m.inputs['Roughness'].default_value = rough
        m.inputs['Distortion'].default_value = distortion
        return m.outputs['Fac']

    def noise_vec(self, vec, scale, detail=2.0):
        m = self.n('ShaderNodeTexNoise', noise_dimensions='3D')
        self.set(m.inputs['Vector'], vec)
        m.inputs['Scale'].default_value = scale
        m.inputs['Detail'].default_value = detail
        return m.outputs['Color']

    def voronoi_edge(self, vec, scale, rand=1.0):
        m = self.n('ShaderNodeTexVoronoi', voronoi_dimensions='3D', feature='DISTANCE_TO_EDGE')
        self.set(m.inputs['Vector'], vec)
        m.inputs['Scale'].default_value = scale
        m.inputs['Randomness'].default_value = rand
        return m.outputs['Distance']


def skin_material() -> bpy.types.Material:
    mat = bpy.data.materials.new('monster_sculpt')
    try:
        mat.use_nodes = True
    except Exception:
        pass
    nb = NB(mat)
    out = nb.n('ShaderNodeOutputMaterial')
    bsdf = nb.n('ShaderNodeBsdfPrincipled')
    nb.nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
    tc = nb.n('ShaderNodeTexCoord')
    P = tc.outputs['Object']
    aA = nb.n('ShaderNodeAttribute', attribute_name='mA', attribute_type='GEOMETRY')
    aB = nb.n('ShaderNodeAttribute', attribute_name='mB', attribute_type='GEOMETRY')
    sA = nb.n('ShaderNodeSeparateColor')
    nb.set(sA.inputs[0], aA.outputs['Color'])
    sB = nb.n('ShaderNodeSeparateColor')
    nb.set(sB.inputs[0], aB.outputs['Color'])
    cav_s = nb.math('SUBTRACT', sA.outputs[0], 0.5)        # + concave / - convex
    cav_l = nb.math('SUBTRACT', sA.outputs[1], 0.5)
    dark = sA.outputs[2]
    ext = aA.outputs['Alpha']
    ear, sock, vein_d = sB.outputs[0], sB.outputs[1], sB.outputs[2]
    infl = aB.outputs['Alpha']

    # warped coordinates for organic patterns
    warp = nb.n('ShaderNodeVectorMath', operation='MULTIPLY_ADD')
    nb.set(warp.inputs[0], nb.noise_vec(P, 7.0, 2.0))
    warp.inputs[1].default_value = (0.035, 0.035, 0.035)
    nb.set(warp.inputs[2], P)
    Pw = warp.outputs[0]

    base = (0.42, 0.41, 0.36)
    col = nb.mix(nb.ramp(nb.noise(P, 1.4, 2, 0.5), 0.3, 0.7), (0.47, 0.45, 0.39), (0.30, 0.29, 0.27))  # broad value drift
    mott = nb.ramp(nb.noise(P, 5.5, 6, 0.62), 0.42, 0.58)
    col = nb.mix(nb.math('MULTIPLY', mott, 0.9), col, (0.20, 0.185, 0.19))                       # mottling
    blot = nb.ramp(nb.noise(Pw, 2.3, 4, 0.55, 0.4), 0.49, 0.60)
    col = nb.mix(nb.math('MULTIPLY', blot, 0.88), col, (0.10, 0.085, 0.095))                    # necrotic blotches
    rim = nb.math('MULTIPLY', nb.ramp(nb.noise(Pw, 2.3, 4, 0.55, 0.4), 0.43, 0.50), nb.math('SUBTRACT', 1.0, blot))
    col = nb.mix(nb.math('MULTIPLY', rim, 0.45), col, (0.24, 0.13, 0.17))                       # bruised purple edges
    sick = nb.ramp(nb.noise(Pw, 3.1, 3, 0.5), 0.53, 0.66)
    col = nb.mix(nb.math('MULTIPLY', sick, 0.55), col, (0.44, 0.38, 0.17))                      # yellowed patches
    # veins: sinuous iso-lines of warped noise (two widths), masked by thin-skin density
    def isoline(vec, scale, width, detail=2.0):
        nz = nb.noise(vec, scale, detail, 0.5)
        dist = nb.math('ABSOLUTE', nb.math('SUBTRACT', nz, 0.5))
        return nb.math('SUBTRACT', 1.0, nb.ramp(dist, 0.0, width))
    v1 = isoline(Pw, 4.5, 0.020)
    off = nb.n('ShaderNodeVectorMath', operation='ADD', in_Vector=Pw)
    off.inputs[1].default_value = (3.7, 1.3, 5.1)
    v2 = nb.math('MULTIPLY', isoline(off.outputs[0], 11.0, 0.016), 0.7)
    brk = nb.ramp(nb.noise(P, 3.0, 2), 0.40, 0.60)
    vmask = nb.math('MULTIPLY', nb.math('ADD', vein_d, 0.25), brk)
    veins = nb.math('MULTIPLY', nb.math('MAXIMUM', v1, v2), vmask, clamp=True)
    col = nb.mix(nb.math('MULTIPLY', veins, 0.92), col, (0.045, 0.055, 0.10))
    cap = nb.math('MULTIPLY', isoline(Pw, 30.0, 0.025), 0.45)
    col = nb.mix(nb.math('MULTIPLY', cap, vein_d), col, (0.22, 0.08, 0.12))                    # capillaries
    # ears: thinner, pinker, veinier
    col = nb.mix(nb.math('MULTIPLY', ear, 0.55), col, (0.27, 0.22, 0.22))
    # stretched skin over bone (convex) lighter; crevices darker + redder
    convex = nb.ramp(nb.math('MULTIPLY', cav_s, -1.0), 0.03, 0.35)
    col = nb.mix(nb.math('MULTIPLY', nb.math('MULTIPLY', convex, 0.50), nb.math('SUBTRACT', 1.0, ear)), col, (0.58, 0.56, 0.49))
    crev = nb.ramp(nb.math('ADD', cav_s, nb.math('MULTIPLY', cav_l, 1.2)), 0.02, 0.38)
    col = nb.mix(crev, col, nb.mix(0.85, col, (0.16, 0.08, 0.08), 'MULTIPLY'), 'MIX')
    # sockets: bruised purple, inflamed rims, extremities necrotic
    col = nb.mix(nb.math('MULTIPLY', sock, 0.65), col, (0.17, 0.12, 0.16))
    col = nb.mix(nb.math('MULTIPLY', infl, 0.7), col, (0.30, 0.09, 0.09))
    col = nb.mix(nb.math('MULTIPLY', ext, 0.85), col, nb.mix(0.5, (0.15, 0.13, 0.12), (0.10, 0.08, 0.08)))
    col = nb.mix(dark, col, (0.030, 0.006, 0.007))
    ao = nb.n('ShaderNodeAmbientOcclusion', only_local=True, samples=8)
    ao.inputs['Distance'].default_value = 0.06
    col = nb.mix(nb.mixf(ao.outputs['AO'], 0.28, 1.0), (0, 0, 0), col, 'MIX')
    # fix: mix(fac, black, col) == col*fac
    nb.set(bsdf.inputs['Base Color'], col)

    # roughness: wet (low) overall, drier blotches/extremities, wettest in the mouth & crevices
    rough = nb.mixf(nb.noise(P, 9.0, 3), 0.18, 0.34)
    rough = nb.mixf(nb.math('MULTIPLY', blot, 0.8), rough, 0.48)
    rough = nb.mixf(ext, rough, 0.50)
    rough = nb.mixf(nb.math('MULTIPLY', crev, 0.6), rough, 0.17)
    rough = nb.mixf(dark, rough, 0.10)
    rough = nb.mixf(nb.math('MULTIPLY', sock, 0.6), rough, 0.15)
    nb.set(bsdf.inputs['Roughness'], rough)

    # bump: raised veins, crepey wrinkles, pores, lumps
    hgt = nb.math('MULTIPLY', veins, 0.55)
    crepe = isoline(Pw, 55.0, 0.05, 3.0)
    hgt = nb.math('SUBTRACT', hgt, nb.math('MULTIPLY', crepe, 0.22))
    hgt = nb.math('ADD', hgt, nb.math('MULTIPLY', nb.noise(P, 160.0, 2), 0.18))
    hgt = nb.math('ADD', hgt, nb.math('MULTIPLY', nb.noise(P, 22.0, 3), 0.25))
    bump = nb.n('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.45
    bump.inputs['Distance'].default_value = 0.0012
    nb.set(bump.inputs['Height'], hgt)
    nb.set(bsdf.inputs['Normal'], bump.outputs['Normal'])
    return mat


def keratin_material() -> bpy.types.Material:
    """Teeth (left half of a tiny gradient texture) + claws (right half)."""
    W, H = 64, 64
    img = bpy.data.images.new('monster_keratin', W, H, alpha=False)
    px = np.zeros((H, W, 4), np.float32)
    v = np.linspace(0, 1, H)                          # 0 = root, 1 = tip
    teeth = np.stack([0.30 + 0.48 * v ** 0.6, 0.22 + 0.44 * v ** 0.6, 0.16 + 0.34 * v ** 0.7], -1)
    teeth[v < 0.12] = [0.22, 0.05, 0.05]              # gum-blood at the root
    claws = np.stack([0.045 - 0.03 * v, 0.040 - 0.028 * v, 0.036 - 0.025 * v], -1)
    claws = np.clip(claws, 0.008, 1)
    px[:, :W // 2, :3] = teeth[:, None, :]
    px[:, W // 2:, :3] = claws[:, None, :]
    px[..., 3] = 1
    img.pixels.foreach_set(px.ravel())
    img.pack()
    mat = bpy.data.materials.new('monster_keratin')
    try:
        mat.use_nodes = True
    except Exception:
        pass
    nt = mat.node_tree
    b = common._bsdf(mat)
    tx = nt.nodes.new('ShaderNodeTexImage')
    tx.image = img
    tx.interpolation = 'Linear'
    nt.links.new(tx.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.22
    return mat


# ---------------------------------------------------------------------------------------------
# teeth + claws (low-poly, appended after the bake)
# ---------------------------------------------------------------------------------------------

def _spike(bm, uv_layer, base, tip, w_dir, r_w, r_t, u0, u1, rings=1, bend=None):
    """4-sided tapered spike from base to tip; cross-section width r_w (along w_dir), r_t."""
    axis = tip - base
    L = np.linalg.norm(axis)
    ax = axis / L
    wv = w_dir - ax * np.dot(w_dir, ax)
    wv /= np.linalg.norm(wv)
    tv = np.cross(ax, wv)
    prof = [(1, 0), (0, 1), (-1, 0), (0, -1)]
    ringsv = []
    for k in range(rings + 1):
        f = k / (rings + 1)
        c = base + axis * f
        if bend is not None:
            c = c + bend * math.sin(math.pi * f * 0.9) * L
        sc = 1 - f * 0.85
        ringsv.append([bm.verts.new(tuple(c + (wv * a * r_w + tv * b * r_t) * sc)) for a, b in prof])
    tipv = bm.verts.new(tuple(tip))
    faces = []
    for k in range(rings):
        for i in range(4):
            a, b = ringsv[k][i], ringsv[k][(i + 1) % 4]
            c, d = ringsv[k + 1][(i + 1) % 4], ringsv[k + 1][i]
            faces.append((bm.faces.new((a, b, c, d)), k / (rings + 1), (k + 1) / (rings + 1)))
    for i in range(4):
        faces.append((bm.faces.new((ringsv[-1][i], ringsv[-1][(i + 1) % 4], tipv)), rings / (rings + 1), 1.0))
    for f, v0, v1 in faces:
        for li, loop in enumerate(f.loops):
            vv = v1 if loop.vert is tipv or (len(f.verts) == 4 and li >= 2) else v0
            loop[uv_layer].uv = (u0 + (u1 - u0) * (0.3 + 0.4 * (li % 2)), 0.02 + 0.96 * vv)
    return ringsv, tipv


def build_teeth_claws(J, high_sdf) -> tuple[bpy.types.Object, dict]:
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    owner = {}   # vertex index -> bone

    def tag(vs, bone):
        for v in vs:
            owner[v] = bone

    rng = np.random.RandomState(5)
    # needle teeth: two interlocking rows on each lip of the vertical slit
    for side, s in (('L', -1), ('R', 1)):
        for row, (bx, by, n_, lenf) in enumerate(((0.0138, 0.349, 16, 1.0), (0.0168, 0.333, 13, 0.85))):
            span = 2.090 - 1.992
            zs = np.linspace(1.992, 2.090, n_) + (0.5 if (row + (s > 0)) % 2 else 0.0) * (span / n_)
            for i, zz in enumerate(zs):
                if zz > 2.092:
                    continue
                mid = max(0.0, 1 - abs((zz - 2.041) / 0.052) ** 2)
                L = (0.013 + 0.011 * mid) * lenf * (0.85 + 0.3 * rng.rand())
                base = S.v3(s * bx, by, zz)
                d = S.normalize(S.v3(-s * 1.0, 0.38 + 0.25 * rng.rand() - 0.18 * row, (rng.rand() - 0.5) * 0.4))
                tip = base + d * L
                rings, tipv = _spike(bm, uv, base, tip, S.v3(0, 0, 1), 0.0024 * (0.8 + 0.4 * mid), 0.0018, 0.0, 0.48)
                tag([v for r in rings for v in r] + [tipv], 'jaw_' + side)
    # claws on fingers and toes
    for side in ('L', 'R'):
        R_ = J[side]
        n = R_['hn']
        for f in A.FINGERS:
            pts = R_[f + '_pts']
            d3 = R_[f + '_dirs'][2]
            r3 = R_[f + '_rad'][2]
            base = pts[3] - d3 * 0.020 - n * (r3 * 0.55)
            tip = pts[3] + d3 * (0.024 if f != 'thumb' else 0.018) + n * 0.010
            b_dir = np.cross(d3, n)
            rings, tipv = _spike(bm, uv, base, tip, b_dir, 0.0058, 0.0024, 0.52, 1.0, rings=2,
                                 bend=-n * 0.10)
            tag([v for r in rings for v in r] + [tipv], f'{f}_3_{side}')
        for i, (tb, p1, p2, r, d2) in R_['toes'].items():
            base = p1 + (p2 - p1) * 0.55 + S.v3(0, 0, r * 0.45)
            tip = p2 + d2 * 0.022 + S.v3(0, 0, -0.008)
            tip[2] = max(tip[2], 0.002)
            rings, tipv = _spike(bm, uv, base, tip, S.v3(1, 0, 0), 0.0060, 0.0026, 0.52, 1.0, rings=2,
                                 bend=S.v3(0, 0, 0.06))
            tag([v for r in rings for v in r] + [tipv], 'toe_' + side)
    me = bpy.data.meshes.new('monster_keratin')
    for v in bm.verts:
        v.co = v.co * SCALE
    bm.verts.index_update()
    owner_idx = {v.index: b for v, b in owner.items()}
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('monster_keratin', me)
    bpy.context.scene.collection.objects.link(ob)
    common.assign(ob, keratin_material())
    for p in me.polygons:
        p.use_smooth = False
    return ob, owner_idx


# ---------------------------------------------------------------------------------------------
# previews
# ---------------------------------------------------------------------------------------------

def render_previews(mesh, arm, J, prefix='monster', samples=40, size=640):
    shots = [
        ('front', 'Idle', 0.6, 0, 6, 'studio', 1.0),
        ('3q', 'Idle', 0.6, 35, 8, 'studio', 1.0),
        ('side', 'Idle', 0.6, 90, 4, 'studio', 1.0),
        ('flash', 'Walk', 0.35, 12, 2, 'flash', 1.0),
        ('walk', 'Walk', 0.35, 60, 6, 'studio', 1.0),
        ('attack', 'Attack', 0.50, 30, 4, 'flash', 1.0),
    ]
    for tag, act, t, yaw, pitch, mood, zoom in shots:
        RIG.apply_pose(arm, J, act, t)
        common.preview(f'{prefix}_{tag}', [mesh], yaw_deg=yaw, pitch_deg=pitch, size=size, mood=mood,
                       samples=samples, zoom=zoom)
    # face close-up in the flash: frame a hidden proxy at the skull
    RIG.apply_pose(arm, J, 'Listen', 0.2)
    hm = arm.matrix_world @ arm.pose.bones['head'].matrix
    c = hm @ (arm.data.bones['head'].matrix_local.inverted() @ (Vector((0, 0.29, 2.10)) * SCALE))
    proxy = bpy.data.objects.new('__face_proxy', bpy.data.meshes.new('__face_proxy'))
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=0.30 * SCALE)
    bm.to_mesh(proxy.data)
    bm.free()
    proxy.location = c
    proxy.hide_render = True
    bpy.context.scene.collection.objects.link(proxy)
    bpy.context.view_layer.update()
    common.preview(f'{prefix}_face', [proxy], yaw_deg=18, pitch_deg=0, size=size, mood='flash', samples=samples)
    bpy.data.objects.remove(proxy)


# ---------------------------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------------------------

def build_high(J):
    B, info = A.body(J, detail=True)
    log('sdf program ready')
    lo, hi = A.bounds(J)
    V, Q = S.polygonize(B, lo, hi, H_HIGH)
    V = S.taubin(V, Q, 1)
    log(f'sculpt polygonized: {len(V)} verts')
    labels = eval_labels_parallel(B, V)
    log('labels')
    mA, mB = masks(V, Q, labels, J, info)
    log('masks')
    high = mesh_obj('monster_sculpt', V * SCALE, Q)
    set_color_attr(high, 'mA', mA)
    set_color_attr(high, 'mB', mB)
    for p in high.data.polygons:
        pass
    high.data.polygons.foreach_set('use_smooth', np.ones(len(Q), bool))
    common.assign(high, skin_material())
    return high, B, info, V, Q, labels


def build_low(high, B, J):
    low = high.copy()
    low.data = high.data.copy()
    low.name = 'monster_body'
    low.data.name = 'monster_body'
    bpy.context.scene.collection.objects.link(low)
    for nm in ('mA', 'mB'):
        a = low.data.color_attributes.get(nm)
        if a:
            low.data.color_attributes.remove(a)
    low.data.materials.clear()
    m = low.modifiers.new('decimate', 'DECIMATE')
    m.ratio = LOW_TRIS / (2 * len(high.data.polygons))
    m.use_collapse_triangulate = True
    m.use_symmetry = True
    m.symmetry_axis = 'X'
    common.apply_modifiers(low)
    low.data.validate()
    log(f'decimated: {common.tri_count([low])} tris')
    common.smooth(low, 180)
    llab = eval_labels(B, verts_np(low) / SCALE)
    chart_unwrap(low, llab, J)
    return low, llab


# texel-density weights per chart (area multiplier): the face, hands and ears get the most
CHART_WEIGHT = {'head': 2.4, 'ear': 1.3, 'neck': 1.3, 'torso_f': 1.25, 'torso_b': 1.0, 'pelvis_f': 0.9,
                'pelvis_b': 0.8, 'upper_arm': 1.0, 'forearm': 1.1, 'hand': 1.6, 'finger': 1.6,
                'thigh': 0.8, 'shin': 0.8, 'foot': 0.8}


def chart_unwrap(low, llab, J):
    """UV charts from body-part labels: region borders + one hidden cut per tube, angle-based
    (minimum stretch) unwrap, texel density weighted per chart, concave packing."""
    me = low.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    bm.verts.ensure_lookup_table()
    names = A.LABEL_NAMES
    nf = len(bm.faces)
    # face label = majority of its vertex labels, then a majority filter over neighbors
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
            base, axes = J[side]['ear'][0], None
            e_w = J[side]['ear'][2]
            return f'ear_{side}_' + ('f' if np.dot(nn, e_w) > 0 else 'b')
        if n == 'neck':
            return 'neck'
        if n in ('torso', 'pelvis'):
            front = c[1] / SCALE > (0.025 if c[2] / SCALE > 1.25 else -0.03)
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
    cuts = {'head': (S.v3(0, 0.20, 1.98) * SCALE, S.v3(0, 0.20, 2.40) * SCALE, S.v3(0, -1, 0)),
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
    for e in bm.edges:
        e.seam = False
        if len(e.link_faces) != 2:
            e.seam = True
            continue
        i, j = e.link_faces[0].index, e.link_faces[1].index
        if ch[i] != ch[j]:
            e.seam = True
        elif ch[i] in cuts:
            ti, tj = theta[i], theta[j]
            if abs(ti) < math.pi / 2 and abs(tj) < math.pi / 2 and ti * tj < 0:
                e.seam = True
    bm.to_mesh(me)
    bm.free()
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    common.activate(low)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    try:
        bpy.ops.uv.unwrap(method='MINIMUM_STRETCH', fill_holes=True, margin=0.004, iterations=12)
    except Exception:
        bpy.ops.uv.unwrap(method='ANGLE_BASED', fill_holes=True, margin=0.004)
    bpy.ops.uv.average_islands_scale()
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
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.0035, shape_method='CONCAVE')
    bpy.ops.object.mode_set(mode='OBJECT')
    me.uv_layers.active.name = 'UVMap'
    log(f'uv charts: {len(set(ch))}')


def build():
    t0 = time.time()
    common.reset()
    scene = bpy.context.scene
    J = A.skeleton()
    Jw = A.scale_skeleton(J, SCALE)
    high, B, info, V, Q, hlabels = build_high(J)
    low, llab = build_low(high, B, Jw)
    log('uv')
    common.bake(low, 'monster_skin', size=TEX, high=high, normal=True, roughness=True,
                cage_extrusion=0.012, margin=12, samples=4 if FAST else 5)
    log('baked')
    dump = os.environ.get('MONSTER_DUMP')
    if dump:
        os.makedirs(dump, exist_ok=True)
        for im in bpy.data.images:
            if im.name.startswith('monster_skin'):
                im2 = im.copy()
                im2.filepath_raw = os.path.join(dump, im.name + '.png')
                im2.file_format = 'PNG'
                im2.save()
    # remove the sculpt (not exported)
    bpy.data.objects.remove(high)
    kera, owner = build_teeth_claws(J, B)
    arm = RIG.build_armature(Jw, NAME)
    arm['walkSpeed'] = 1.0
    arm['runSpeed'] = 3.1
    arm['height'] = round(2.28 * SCALE, 2)
    RIG.skin(low, arm, llab, Jw)
    log('skinned')
    # teeth / claws: rigid to their bones, then join (2 materials, 1 skinned mesh)
    for b in arm.data.bones:
        if b.use_deform:
            kera.vertex_groups.new(name=b.name)
    for vi, bone in owner.items():
        kera.vertex_groups[bone].add([vi], 1.0, 'REPLACE')
    body = common.join([low, kera], 'monster_body')
    body.parent = arm
    mod = body.modifiers.get('Armature') or body.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    for m in list(body.modifiers):
        if m.type == 'ARMATURE' and m != mod:
            body.modifiers.remove(m)
    body['walkSpeed'] = 1.0
    body['runSpeed'] = 3.1
    RIG.make_actions(arm, Jw)
    log('actions')
    common.report(NAME, [body])
    common.export_glb(NAME, [arm], animations=True)
    log('exported')
    if os.environ.get('MONSTER_NOPREVIEW') != '1':
        render_previews(body, arm, Jw, samples=24 if FAST else 48)
        log('previews')
    print(f'[monster] build took {time.time() - t0:.0f}s')


if __name__ == '__main__':
    build()
