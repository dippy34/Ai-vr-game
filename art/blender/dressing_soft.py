"""
Set dressing, soft pieces: a worn teddy bear with a missing eye, sitting slumped (toys) and a
worn, stained oriental rug with a curled corner and fringe (rug).
Helper module: build() is a no-op; dressing.py calls build_<name>().
"""

from __future__ import annotations

import math
import random

import bpy  # noqa: I001
import bmesh
import numpy as np
from mathutils import Euler, Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

import common as C
import dressing_img as I
import dressing_lib as L
from dressing_lib import G, hexc, xf


def build() -> None:
    print('dressing_soft: helper module (built through dressing.py)')


# =============================================================================================
# Metaballs -> mesh
# =============================================================================================

K = 1 / 0.57  # metaball radius for a wanted surface radius (stiffness 2, threshold 0.6)


class Blobs:
    def __init__(self, res=0.004):
        self.mb = bpy.data.metaballs.new('blobs')
        self.mb.resolution = res
        self.mb.render_resolution = res
        self.mb.threshold = 0.6
        self.obj = bpy.data.objects.new('blobs', self.mb)
        bpy.context.scene.collection.objects.link(self.obj)

    def ball(self, co, R, neg=False, stiff=2.0):
        e = self.mb.elements.new(type='BALL')
        e.co = co
        e.radius = R * K
        e.stiffness = stiff
        e.use_negative = neg
        return e

    def ell(self, co, R, s, rot=None, neg=False, stiff=2.0):
        e = self.mb.elements.new(type='ELLIPSOID')
        e.co = co
        e.radius = R * K
        e.size_x, e.size_y, e.size_z = s
        if rot is not None:
            e.rotation = rot
        e.stiffness = stiff
        e.use_negative = neg
        return e

    def cap(self, p0, p1, R, stiff=2.0):
        p0, p1 = Vector(p0), Vector(p1)
        e = self.mb.elements.new(type='CAPSULE')
        e.co = (p0 + p1) / 2
        e.radius = R * K
        e.size_x = (p1 - p0).length / 2
        e.rotation = Vector((1, 0, 0)).rotation_difference((p1 - p0).normalized())
        e.stiffness = stiff
        return e

    def mesh(self, name):
        deps = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(self.obj.evaluated_get(deps))
        me.name = name
        obj = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(obj)
        bpy.data.objects.remove(self.obj)
        return obj


def surface_hit(bvh, origin, direction):
    hit = bvh.ray_cast(Vector(origin), Vector(direction).normalized(), 1.0)
    if hit[0] is None:
        raise RuntimeError(f'no surface hit from {tuple(origin)} along {tuple(direction)}')
    return hit[0], hit[1]


def orient(normal, up=(0, 0, 1)):
    """Rotation matrix whose Z axis = normal (Y roughly toward `up`)."""
    n = Vector(normal).normalized()
    u = Vector(up)
    if abs(n.dot(u)) > 0.95:
        u = Vector((0, 1, 0))
    x = u.cross(n).normalized()
    y = n.cross(x)
    return Matrix((x, y, n)).transposed().to_4x4()


# =============================================================================================
# Teddy bear
# =============================================================================================

def mat_mohair(name, seed=0.0):
    """Matted, worn mohair: honey fur rubbed bald to the woven backing, grime, stains, dust, a
    plaid repair patch on the left leg."""
    mat = L.new_material(name)
    g = G(mat)
    p = g.pos()
    x, y, z = g.sep(p)
    # fur clumps + strands lying downward
    clump = g.noise(p, 55.0, 3, 0.6, offset=(seed, 0, 0))
    strand = g.noise(p, 260.0, 2, 0.7, stretch=(1.0, 1.0, 0.25))
    tip = g.noise(p, 18.0, 2, 0.5, offset=(0, seed, 1))
    fur = g.mix(g.rng(tip, 0.35, 0.7), hexc('5e4428'), hexc('86643c'))
    fur = g.mix(g.mul(g.rng(clump, 0.55, 0.3), 0.6), fur, hexc('34261a'))
    # bald patches (fur rubbed off by hugging): belly, paws, muzzle tip, ear edges
    bn = g.noise(p, 14.0, 4, 0.65, offset=(seed, 2.0, 0))
    hug = g.rng(g.v('LENGTH', g.vmul(g.vadd(p, (0.012, -0.045, -0.095)), (1.0, 1.4, 0.8))), 0.085, 0.03)
    bald = g.rng(g.add(g.add(bn, g.mul(hug, 0.35)), g.mul(g.convex(), 0.2)), 0.68, 0.74)
    wv = g.mul(g.add(g.wave(p, 900.0, 'BANDS', 'X'), g.wave(p, 900.0, 'BANDS', 'Z')), 0.5)
    backing = g.mix(wv, hexc('6e5c42'), hexc('8a7856'))
    col = g.mix(bald, fur, backing)
    h = g.mixf(bald, g.add(g.mul(clump, 0.6), g.mul(strand, 0.5)), g.mul(wv, 0.15))
    rough = g.mixf(bald, 0.92, 0.85)
    # plaid repair patch, stitched on the left thigh
    pc = g.vadd(p, (-0.062, -0.085, -0.055))
    pd = g.mx(g.absf(g.sep(pc)[0]), g.mx(g.absf(g.sep(pc)[1]), g.absf(g.sep(pc)[2])))
    patch = g.rng(pd, 0.026, 0.023)
    px_, py_, pz_ = g.sep(p)
    plaid = g.mx(g.rng(g.sin(g.mul(px_, 520.0)), 0.6, 0.9), g.rng(g.sin(g.mul(pz_, 520.0)), 0.6, 0.9))
    pcol = g.mix(g.mul(plaid, 0.7), hexc('3e4a5a'), hexc('7a3a30'))
    col = g.mix(patch, col, pcol)
    stitch = g.mul(g.mul(g.rng(g.absf(g.sub(pd, 0.0245)), 0.0012, 0.0), g.rng(g.sin(g.mul(g.add(px_, pz_), 900.0)), 0.0, 0.5)), 1.0)
    col = g.mix(stitch, col, hexc('d0c4a0'))
    h = g.add(h, g.mul(patch, 0.4))
    # dark stains (one big one down the front of the chest), grime from the floor
    sn = g.noise(p, 8.0, 3, 0.6, offset=(seed, 5.0, 2.0))
    chest = g.v('LENGTH', g.vmul(g.vadd(p, (0.02, -0.06, -0.15)), (1.3, 1.0, 0.7)))
    st = g.rng(g.add(chest, g.mul(sn, 0.05)), 0.055, 0.035)
    col = g.mix(g.mul(st, 0.75), col, hexc('2a1810'))
    h = g.sub(h, g.mul(st, 0.3))  # matted flat where it soaked in
    col, rough, h = L.age(g, col, rough, h, dust=0.6, grime=1.0, wear=0.0, scratch=0.0, stains=0.5,
                          stain_col=hexc('3a2818'), floor=0.9, floor_h=0.05, fade=0.15, seed=seed, film=0.05,
                          dust_scale=3.0)
    return g.finish(col, rough, h, bump_dist=0.0012)


def blob_part(name, build_fn, max_tris, M=None, res=0.004):
    B = Blobs(res)
    build_fn(B)
    o = B.mesh(name)
    C.decimate_to(o, max_tris)
    if M is not None:
        o.data.transform(M)
    return o


def build_toys():
    P = L.Piece('toys', 'floor', tex=512, max_tris=2000, ao=0.06, bevel=0.003, ao_small=0.012, seed=11)
    hips = Vector((0.0, 0.0, 0.058))
    # slumped: torso sagged back and toward its right (-X); head lolled further over and down
    Sb = Matrix.Translation(hips) @ Euler((math.radians(-13), math.radians(-15), math.radians(-6)), 'XYZ').to_matrix().to_4x4() \
        @ Matrix.Translation(-hips)
    neck = Vector((0.0, 0.004, 0.212))
    Sh = Sb @ Matrix.Translation(neck) @ Euler((math.radians(-20), math.radians(-24), math.radians(-14)), 'XYZ').to_matrix().to_4x4() \
        @ Matrix.Translation(-neck)

    def body(B):
        B.ell((0, -0.004, 0.128), 0.06, (1.0, 0.92, 1.38))
        B.ball((0, 0.016, 0.112), 0.054)       # round tummy
        B.ball((0, -0.026, 0.17), 0.04)        # humped back
        B.ell((0, 0.0, 0.195), 0.045, (1.25, 0.9, 0.6))  # shoulders
    torso = blob_part('torso', body, 360, Sb)

    def headf(B):
        B.ball((0, 0.008, 0.27), 0.058)
        B.ell((0, 0.016, 0.285), 0.05, (1.1, 0.9, 0.9))   # broad forehead / cheeks
        B.ell((0, 0.06, 0.252), 0.026, (1.0, 1.3, 0.85))  # snout
        for sx in (-1, 1):
            B.ell((sx * 0.05, -0.004, 0.322), 0.022, (1.0, 0.45, 1.0))
            B.ball((sx * 0.05, 0.009, 0.323), 0.0105, neg=True)  # cupped ears
        B.ball((0.024, 0.06, 0.281), 0.0082, neg=True)  # its LEFT eye: torn out
    head = blob_part('head', headf, 560, Sh, res=0.0035)

    shoulder = {sx: Sb @ Vector((sx * 0.062, 0.002, 0.185)) for sx in (-1, 1)}
    hipj = {sx: Vector((sx * 0.046, 0.014, 0.05)) for sx in (-1, 1)}
    # its right arm fallen to the floor at its side; its left arm limp in its lap
    arm_pts = {-1: (Vector((-0.105, 0.03, 0.12)), Vector((-0.122, 0.07, 0.03))),
               1: (Vector((0.088, 0.05, 0.12)), Vector((0.05, 0.11, 0.078)))}
    feet = {-1: Vector((-0.09, 0.158, 0.036)), 1: Vector((0.072, 0.165, 0.038))}
    parts = [torso, head]
    for sx in (-1, 1):
        el, paw = arm_pts[sx]
        sh = shoulder[sx]

        def armf(B, sh=sh, el=el, paw=paw):
            B.cap(sh, el, 0.025)
            B.cap(el, paw, 0.022)
            B.ell(paw, 0.025, (1.0, 1.0, 1.15))  # spoon paw
        parts.append(blob_part(f'arm_{sx}', armf, 170))

        def legf(B, sx=sx):
            hp, ft = hipj[sx], feet[sx]
            B.cap(hp, ft - Vector((0, 0.02, 0)), 0.034)
            B.ell(ft, 0.035, (0.95, 0.72, 1.2))
        parts.append(blob_part(f'leg_{sx}', legf, 200))
    deps = bpy.context.evaluated_depsgraph_get()
    for o in parts:
        L.displace(o, lambda v: Vector((v.x, v.y, max(v.z, 0.0))))
        L.place(o, None, 'z', gc_off=(0, 0, 0))
    fur = mat_mohair('bear_mohair', 2.0)
    for o in parts:
        P.add(o, fur, smooth=180, weight=1.4 if o.name == 'head' else 1.0)
    bvh_head = BVHTree.FromObject(head, deps)
    bvh_body = BVHTree.FromObject(torso, deps)

    felt = L.mat_fabric('bear_felt', hexc('9a8262'), hexc('7a6448'), weave=700.0, fade=0.3, stains=0.8, dust=0.35,
                        grime=1.0, seed=3.0, holes=0.5, floor=0.6)
    thread = L.mat_fabric('bear_thread', hexc('1e1610'), None, weave=1600.0, fade=0.1, stains=0.0, dust=0.3,
                          grime=0.6, seed=4.0)
    button = L.mat_plain('bear_button', hexc('0a0908'), 0.16, dust=0.35, grime=0.6, noise_amt=0.1, wear=0.4,
                         scratch=0.5, seed=5.0)
    stuffing = L.mat_fabric('bear_stuffing', hexc('aaa28a'), hexc('857d68'), weave=300.0, fade=0.0, stains=0.6,
                            dust=0.4, grime=1.0, seed=6.0, rough=0.98)
    ribbon = L.mat_fabric('bear_ribbon', hexc('5e2420'), hexc('4e1e1a'), weave=1200.0, fade=0.45, stains=0.5,
                          dust=0.6, grime=0.9, seed=7.0, rough=0.6)
    # foot pads (felt) on the forward-facing soles
    for sx, ft in feet.items():
        bvh_leg = BVHTree.FromObject(next(o for o in parts if o.name == f'leg_{sx}'), deps)
        hit, n = surface_hit(bvh_leg, ft + Vector((0, 0.08, 0)), (0, -1, 0))
        pad = L.prism('pad', L.ellipse_pts(0.023, 0.03, 12), 0.003, bevel=0.0012)
        L.place(pad, Matrix.Translation(hit - n * 0.0015) @ orient(n, (0, 0, 1)), 'x')
        P.add(pad, felt, smooth=40, weight=0.8)

    def head_ray(local, hitpad=0.0):
        p0 = Sh @ Vector((0, 0.008, 0.27))
        tgt = Sh @ Vector(local)
        d = (tgt - p0).normalized()
        return surface_hit(bvh_head, p0 + d * 0.2, -d)
    up_h = (Sh.to_3x3() @ Vector((0, 0, 1))).normalized()
    right_h = (Sh.to_3x3() @ Vector((1, 0, 0))).normalized()
    # remaining eye (its right): a black shoe button, a little crooked
    hit, n = head_ray((-0.024, 0.06, 0.281))
    btn = L.lathe('button', [(0, 0), (0.0088, 0.0), (0.0083, 0.003), (0.0057, 0.0057), (0, 0.0064)], segs=10)
    L.place(btn, Matrix.Translation(hit - n * 0.001) @ orient(n.lerp(-up_h, 0.18), up_h))
    P.add(btn, button, smooth=50, weight=0.7)
    # torn-out eye: stuffing tuft + two loose threads hanging
    hit, n = head_ray((0.024, 0.06, 0.281))
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.0075)
    tuft = L._link(bm, 'tuft')
    rnd = random.Random(3)
    L.displace(tuft, lambda v: Vector((v.x, v.y, v.z * 0.6)) * (1 + rnd.uniform(-0.3, 0.3)))
    L.place(tuft, Matrix.Translation(hit - n * 0.0045) @ orient(n))
    P.add(tuft, stuffing, smooth=80, weight=0.6)
    for k, (dx, L_) in enumerate(((0.003, 0.03), (-0.0025, 0.019))):
        st = hit + right_h * dx
        pts = [st - n * 0.002, st + n * 0.004 - up_h * 0.003, st + n * 0.006 - up_h * L_ * 0.55 + right_h * dx,
               st + n * 0.004 - up_h * L_]
        P.add(L.tube(f'thread_{k}', pts, 0.0008, segs=4, caps=False), thread, smooth=80, weight=0.25)
    # embroidered nose + mouth on the snout
    hit, n = head_ray((0, 0.1, 0.258))
    nose = L.prism('nose', [(-0.011, 0.004), (0.011, 0.004), (0.006, -0.004), (0.0, -0.007), (-0.006, -0.004)],
                   0.0025, bevel=0.001)
    L.place(nose, Matrix.Translation(hit - n * 0.0008) @ orient(n, up_h))
    P.add(nose, thread, smooth=50, weight=0.6)
    m0 = hit - up_h * 0.008
    for a_, b_ in ((m0, m0 - up_h * 0.009), (m0 - up_h * 0.009, m0 - up_h * 0.013 + right_h * 0.009),
                   (m0 - up_h * 0.009, m0 - up_h * 0.013 - right_h * 0.009)):
        mid = (a_ + b_) / 2
        h1, n1 = surface_hit(bvh_head, a_ + n * 0.04, -n)
        h2, n2 = surface_hit(bvh_head, mid + n * 0.04, -n)
        h3, n3 = surface_hit(bvh_head, b_ + n * 0.04, -n)
        P.add(L.tube('mouth', [h1 + n1 * 0.0004, h2 + n2 * 0.0006, h3 + n3 * 0.0004], 0.0011, segs=4), thread,
              smooth=80, weight=0.3)
    # split side seam on the torso: stuffing bulging out
    side_p = Sb @ Vector((0.065, 0.01, 0.1))
    hit, n = surface_hit(bvh_body, side_p + Vector((0.15, 0, 0)), (-1, 0, 0))
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.012)
    t2 = L._link(bm, 'seam_tuft')
    L.displace(t2, lambda v: Vector((v.x * 0.6, v.y * 1.25, v.z * 0.9)) * (1 + rnd.uniform(-0.25, 0.25)))
    L.place(t2, Matrix.Translation(hit - n * 0.006) @ orient(n))
    P.add(t2, stuffing, smooth=80, weight=0.5)
    # faded ribbon around the neck (on the torso, under the chin) with a limp bow
    axis = (Sb.to_3x3() @ Vector((0, 0, 1))).normalized()
    nc = Sb @ Vector((0, 0.0, 0.2))
    t1 = Vector((1, 0, 0)) - axis * axis.x
    t1.normalize()
    t2v = axis.cross(t1)
    ring = []
    for k in range(12):
        a = 2 * math.pi * k / 12
        d = t1 * math.cos(a) + t2v * math.sin(a)
        h_, n_ = surface_hit(bvh_body, nc + d * 0.15, -d)
        ring.append(h_ + n_ * 0.0025)
    prof = [(0.5, 0.06), (-0.5, 0.06), (-0.5, -0.06), (0.5, -0.06)]
    P.add(L.tube('ribbon', ring, 0.016, profile=prof, closed=True, caps=False, up_hint=tuple(axis)), ribbon,
          smooth=40, weight=0.6)
    front = max(ring, key=lambda v: (v - nc).normalized().dot(Vector((0.2, 1, 0)).normalized()))
    fn = (front - nc).normalized()
    side = axis.cross(fn).normalized()
    flat = [(0.0, 1.0), (-0.25, 0.0), (0.0, -1.0), (0.25, 0.0)]
    for sx in (-1, 1):
        lp = [front, front + side * sx * 0.017 + axis * 0.011 + fn * 0.007, front + side * sx * 0.029 + fn * 0.006,
              front + side * sx * 0.017 - axis * 0.009 + fn * 0.007, front]
        P.add(L.tube(f'bow_{sx}', lp, 0.006, profile=flat, caps=False), ribbon, smooth=40, weight=0.4)
        tail = [front, front + side * sx * 0.007 - axis * 0.02 + fn * 0.01, front + side * sx * 0.012 - axis * 0.042 + fn * 0.012]
        P.add(L.tube(f'tail_{sx}', tail, 0.006, profile=flat, caps=False), ribbon, smooth=40, weight=0.3)
    P.finish(previews=dict(yaw=30, pitch=14, extra=[dict(tag='face', yaw=40, pitch=8, zoom=2.2, mood='flash')]))


# =============================================================================================
# Rug
# =============================================================================================

def build_rug():
    P = L.Piece('rug', 'floor', tex=1024, max_tris=600, ao=0.05, bevel=0.002, ao_small=0.006, seed=21,
                double_sided=True, cutout_tex=256)
    LX, LY = 1.0, 0.7  # half sizes (2.0 x 1.4 m)
    xs = list(np.linspace(-LX, 0.7, 10)) + list(np.linspace(0.7, LX, 8))[1:]
    ys = list(np.linspace(-LY, 0.4, 6)) + list(np.linspace(0.4, LY, 7))[1:]
    # curled corner at (+X, +Y): roll everything beyond the fold line around a cylinder
    c0 = Vector((0.80, 0.7, 0))
    c1 = Vector((1.0, 0.45, 0))
    fold_t = (c1 - c0).normalized()
    fold_n = Vector((fold_t.y, -fold_t.x, 0))
    if fold_n.dot(Vector((1, 1, 0))) < 0:
        fold_n = -fold_n
    r0 = 0.05
    th = 0.006

    def deform(x, y, top=True):
        p = Vector((x, y, 0))
        # gentle ripple (someone dragged something heavy across it), lying flat elsewhere
        ripple = 0.014 * math.exp(-((x + 0.25 + 0.15 * y) / 0.12) ** 2) * (1 - abs(y) / LY * 0.6)
        z = (th if top else 0.0) + ripple
        s = (p - c0).dot(fold_n)
        if s > 0:
            ang = s / r0
            base = p - fold_n * s
            rr = r0 - (z if top else 0.0) * 0.0
            q = base + fold_n * (rr * math.sin(ang)) + Vector((0, 0, r0 - rr * math.cos(ang) + z * math.cos(ang)))
            return q
        return Vector((x, y, z))

    verts, faces, uvs = [], [], []
    nx, ny = len(xs), len(ys)
    for j, y in enumerate(ys):
        for i, x in enumerate(xs):
            verts.append(tuple(deform(x, y)))
            uvs.append(((x + LX) / (2 * LX), (y + LY) / (2 * LY)))
    for j in range(ny - 1):
        for i in range(nx - 1):
            a = j * nx + i
            faces.append((a, a + 1, a + nx + 1, a + nx))
    top = L.mesh('rug_top', verts, faces, uvs=uvs, grain='x')
    pat, worn = I.rug_pattern(1024, 720)
    pimg = L.np_image('rug_pattern', pat)
    wimg = L.np_image('rug_worn', worn, non_color=True)
    mat = L.new_material('rug_pile')
    g = G(mat)
    uv = g.uv('src')
    col, _ = g.img(pimg)
    wv = g.sep(g.img(wimg)[0])[0]
    p = g.pos()
    # pile: knot rows + fuzz, flattened where worn
    knots = g.mul(g.add(g.wave(g.vmul(uv, (1.0, 0.7, 1.0)), 340.0, 'BANDS', 'X'), g.wave(uv, 240.0, 'BANDS', 'Y')), 0.5)
    fuzz = g.noise(p, 300.0, 2, 0.6)
    h = g.mixf(wv, g.add(g.mul(knots, 0.35), g.mul(fuzz, 0.5)), g.mul(knots, 0.6))
    # big dark stain soaked in near the middle + a drag smear toward the curled corner
    sn = g.noise(p, 3.0, 4, 0.6, offset=(2.0, 0, 0))
    cen = g.v('LENGTH', g.vmul(g.vadd(p, (0.18, 0.05, 0.0)), (1.0, 1.35, 0.0)))
    stain = g.rng(g.add(cen, g.mul(sn, 0.12)), 0.26, 0.17)
    rim = g.mul(g.rng(g.add(cen, g.mul(sn, 0.12)), 0.29, 0.255), g.rng(g.add(cen, g.mul(sn, 0.12)), 0.2, 0.235))
    x_, y_, z_ = g.sep(p)
    smear_d = g.absf(g.sub(y_, g.add(g.mul(x_, 0.35), 0.1)))
    smear = g.mul(g.mul(g.rng(smear_d, 0.09, 0.02), g.rng(x_, -0.1, 0.1)), g.rng(x_, 0.75, 0.45))
    smear = g.mul(smear, g.rng(g.noise(p, 9.0, 3, 0.6, stretch=(0.3, 1.0, 1.0)), 0.35, 0.65))
    dark = hexc('20120c')
    col = g.mix(g.mul(stain, 0.82), col, dark)
    col = g.mix(g.mul(rim, 0.7), col, hexc('140a07'))
    col = g.mix(g.mul(smear, 0.65), col, dark)
    h = g.sub(h, g.mul(g.mx(stain, smear), 0.3))
    rough = g.mixf(stain, 0.95, 0.75)
    col, rough, h = L.age(g, col, rough, h, dust=0.55, grime=0.8, wear=0.0, scratch=0.0, stains=0.6,
                          stain_col=hexc('3a2a1c'), fade=0.0, seed=4.0, film=0.2, dust_scale=0.6)
    g.finish(col, rough, h, bump_dist=0.0015)
    P.add(top, mat, flat=False, smooth=60, uv='src', weight=1.0)
    # bound edge skirt along the perimeter (selvedge)
    edge = L.mat_fabric('rug_edge', hexc('2a1e16'), hexc('4a3020'), weave=500.0, fade=0.3, stains=0.5, dust=0.5,
                        grime=0.9, seed=5.0)
    ring = [(x, -LY) for x in xs] + [(LX, y) for y in ys[1:]] + [(x, LY) for x in reversed(xs[:-1])] + \
           [(-LX, y) for y in reversed(ys[1:-1])]
    sv, sf = [], []
    for k, (x, y) in enumerate(ring):
        sv.append(tuple(deform(x, y, top=True)))
        q = deform(x, y, top=False)
        sv.append(tuple(q))
    n = len(ring)
    for k in range(n):
        a, b = 2 * k, 2 * ((k + 1) % n)
        sf.append((a + 1, b + 1, b, a))
    P.add(L.mesh('rug_edge', sv, sf), edge, smooth=50, weight=0.25)
    # fringe (alpha cutout) on both short ends, following the curl
    fc, fa = I.fringe(512, 64)
    rgba = np.concatenate([fc, fa[..., None]], axis=-1)
    fimg = L.np_image('rug_fringe', rgba, alpha=True)
    fm = L.new_material('rug_fringe')
    g = G(fm)
    c, a = g.img(fimg)
    col, rough, h = L.age(g, c, 0.95, g.mul(a, 0.5), dust=0.5, grime=0.6, wear=0.0, scratch=0.0, stains=0.4,
                          seed=6.0, film=0.2)
    g.finish(col, rough, h, alpha=a)
    FL = 0.07
    for sx in (-1, 1):
        fv, ff, fu = [], [], []
        x0 = sx * LX
        for j, y in enumerate(ys):
            for k, t in enumerate((0.0, 1.0)):
                x = x0 + sx * FL * t
                q = deform(x, y)
                if t > 0 and (Vector((x, y, 0)) - c0).dot(fold_n) <= 0:
                    q = q + Vector((0, (0.01 if j % 2 else -0.008), -th + 0.0015))  # lies on the floor, splayed
                fv.append(tuple(q))
                fu.append(((y + LY) / (2 * LY), 0.98 - 0.96 * t))
        for j in range(len(ys) - 1):
            a = j * 2
            ff.append((a, a + 2, a + 3, a + 1) if sx > 0 else (a, a + 1, a + 3, a + 2))
        fr = L.mesh(f'fringe_{sx}', fv, ff, uvs=fu)
        P.add(fr, fm, group='cutout', flat=False, smooth=60, uv='src')
    P.finish(previews=dict(yaw=30, pitch=38, extra=[dict(tag='corner', yaw=50, pitch=25, zoom=2.6)]))
