"""
Set dressing, wooden pieces: dining chair (+ fallen variant), coat rack, boarded-up window.
Helper module: build() is a no-op; dressing.py calls build_<name>().
"""

from __future__ import annotations

import math
import random

import bpy  # noqa: F401,I001 (bpy before bmesh)
import bmesh
from mathutils import Matrix, Vector

import dressing_lib as L
from dressing_lib import hexc, xf


def build() -> None:
    print('dressing_furn: helper module (built through dressing.py)')


def chamfer_rect(w, h, c):
    """Chamfered rectangle profile (8 points, CCW) for tubes: w x h with corner cut c."""
    x, y = w / 2, h / 2
    return [(x, -y + c), (x, y - c), (x - c, y), (-x + c, y), (-x, y - c), (-x, -y + c), (-x + c, -y), (x - c, -y)]


def unit_profile(pts, r):
    return [(px / r, py / r) for px, py in pts]


def taper_box(name, top, bot, h, M, bevel=0.003):
    """Square-section leg from z=0 (bot width) to z=h (top width)."""
    bm = L.bm_box(1, 1, 1, bevel=0)
    for v in bm.verts:
        t = v.co.z + 0.5
        w = bot + (top - bot) * t
        v.co = Vector((v.co.x * w, v.co.y * w, t * h))
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=1, affect='EDGES', clamp_overlap=True)
    obj = L._link(bm, name)
    return L.place(obj, M, 'z')


def jagged_end(obj, ring_verts_world_idx, tangent, amount, seed):
    rnd = random.Random(seed)
    t = Vector(tangent).normalized()
    for i in ring_verts_world_idx:
        v = obj.data.vertices[i]
        v.co += t * rnd.uniform(-amount * 0.6, amount)
    obj.data.update()


def spindle(name, p0, p1, r, M=None, broken=None, seed=1):
    """Turned spindle between p0 and p1 (radius profile with beads). broken=(t0, t1): gap."""
    p0, p1 = Vector(p0), Vector(p1)
    prof = [(0.0, 0.9), (0.08, 1.15), (0.14, 0.85), (0.5, 1.05), (0.86, 0.85), (0.92, 1.15), (1.0, 0.9)]
    parts = []
    spans = [(0.0, 1.0)] if broken is None else [(0.0, broken[0]), (broken[1], 1.0)]
    for si, (a, b) in enumerate(spans):
        ts = [a] + [t for t, _ in prof if a < t < b] + [b]
        pts = [p0 + (p1 - p0) * t for t in ts]

        def rad(t):
            for k in range(len(prof) - 1):
                if prof[k][0] <= t <= prof[k + 1][0]:
                    u = (t - prof[k][0]) / (prof[k + 1][0] - prof[k][0])
                    return r * (prof[k][1] + (prof[k + 1][1] - prof[k][1]) * u)
            return r
        o = L.tube(f'{name}_{si}', pts, [rad(t) for t in ts], segs=7, caps=True)
        if broken is not None:
            # splinter the broken end: cap ring is the last (si == 0) or first (si == 1) ring
            n = 7
            nv = len(o.data.vertices)
            idx = list(range(nv - n, nv)) if si == 0 else list(range(0, n))
            jagged_end(o, idx, (p1 - p0) * (1 if si == 0 else -1), 0.012, seed + si)
        parts.append(o)
    return parts


# =============================================================================================
# Chair
# =============================================================================================

def chair_parts(P: L.Piece, seed=3):
    random.seed(seed)
    wood = L.mat_wood('chair_wood', hexc('4c311e'), hexc('22140b'), gloss=0.32, ring=0.005, figure=0.8, dust=0.85,
                      grime=0.9, wear=0.8, scratch=0.55, fade=0.12, seed=1.0, peel=0.3, peel_col=hexc('7a5a3c'),
                      film=0.06)

    def stripes(g, p, col):
        # faded regency stripes running front to back: burgundy / olive / thin gold pinstripes
        x = g.sep(p)[0]
        f = g.fract(g.mul(x, 1 / 0.07))
        band = g.rng(f, 0.48, 0.52)
        pin = g.mul(g.rng(f, 0.0, 0.03), g.rng(f, 0.08, 0.05))
        pin2 = g.mul(g.rng(f, 0.5, 0.53), g.rng(f, 0.58, 0.55))
        col = g.mix(band, hexc('5a2a26'), hexc('4c4a30'))
        col = g.mix(g.mul(g.mx(pin, pin2), 0.8), col, hexc('9a8250'))
        # a big dark stain soaked into the seat
        sn = g.noise(p, 9.0, 3, 0.6, offset=(4.0, 1.0, 0.0))
        cen = g.v('LENGTH', g.vmul(g.vadd(p, (-0.03, -0.02, -0.49)), (1.0, 1.3, 0.0)))
        st = g.rng(g.add(cen, g.mul(sn, 0.06)), 0.13, 0.09)
        col = g.mix(g.mul(st, 0.8), col, hexc('241510'))
        rim = g.mul(g.rng(g.add(cen, g.mul(sn, 0.06)), 0.15, 0.13), g.rng(g.add(cen, g.mul(sn, 0.06)), 0.11, 0.13))
        return g.mix(g.mul(rim, 0.6), col, hexc('1a0f0b'))

    fabric = L.mat_fabric('chair_seat', hexc('5a2a26'), None, weave=520.0, fade=0.3, stains=0.4,
                          dust=0.65, grime=0.9, seed=2.0, pattern=stripes, holes=0.2)
    stuffing = L.mat_plain('chair_stuffing', hexc('a09272'), 0.95, dust=0.6, grime=0.9, noise_amt=0.4, wear=0.0,
                           scratch=0.0, seed=3.0)

    # legs
    leg_prof = [(0.0, 0.0), (0.0125, 0.0), (0.0135, 0.012), (0.0145, 0.2), (0.0165, 0.27), (0.0185, 0.285),
                (0.0145, 0.30), (0.0175, 0.33), (0.0185, 0.345), (0.0185, 0.445), (0.0, 0.445)]
    for sx in (-1, 1):
        P.add(L.lathe(f'front_leg_{sx}', leg_prof, segs=10, M=xf((sx * 0.192, 0.188, 0))), wood, smooth=50)
        prof = unit_profile(chamfer_rect(0.034, 0.036, 0.006), 0.018)
        path = [(sx * 0.192, -0.188, 0.0), (sx * 0.192, -0.178, 0.30), (sx * 0.19, -0.176, 0.445),
                (sx * 0.187, -0.196, 0.66), (sx * 0.183, -0.232, 0.90)]
        P.add(L.tube(f'rear_post_{sx}', path, [0.0145, 0.017, 0.018, 0.017, 0.0155], profile=prof, caps=True), wood,
              smooth=30)
        # side apron + side stretcher
        P.add(L.box(f'side_apron_{sx}', (0.02, 0.35, 0.062), xf((sx * 0.19, 0.005, 0.405)), bevel=0.003), wood)
        P.add(L.tube(f'side_stretcher_{sx}', [(sx * 0.192, 0.185, 0.165), (sx * 0.192, -0.18, 0.165)], 0.0105, segs=7),
              wood)
    P.add(L.box('front_apron', (0.35, 0.02, 0.062), xf((0, 0.19, 0.405)), bevel=0.003), wood)
    P.add(L.box('rear_apron', (0.35, 0.02, 0.062), xf((0, -0.175, 0.405)), bevel=0.003), wood)
    P.add(L.tube('cross_stretcher', [(-0.192, 0.01, 0.165), (0.192, 0.01, 0.165)], 0.0105, segs=7), wood)
    P.add(L.tube('front_stretcher', [(-0.192, 0.17, 0.11), (0.192, 0.17, 0.11)], 0.0115, segs=7), wood)
    # seat board (slightly overhanging), then the drop-in upholstered pad
    P.add(L.box('seat_board', (0.432, 0.42, 0.02), xf((0, 0.012, 0.436)), bevel=0.004, segs=1, grain='x'), wood)

    bm = L.bm_box(0.4, 0.39, 0.05, bevel=0.016, segs=2)
    pad = L._link(bm, 'seat_pad')
    L.subdiv(pad, 1)

    def puff(v):
        x, y, z = v.x / 0.2, v.y / 0.195, v.z
        if z > 0:
            # crowned, with a sitter's hollow worn into it (a little back of center)
            crown = 0.012 * max(0.0, 1 - x * x) * max(0.0, 1 - y * y)
            hollow = -0.014 * math.exp(-((x / 0.55) ** 2 + ((y + 0.1) / 0.55) ** 2))
            v.z = z + crown + hollow
        return v
    L.displace(pad, puff)
    L.place(pad, xf((0, 0.012, 0.47)), 'x')
    P.add(pad, fabric, smooth=60)
    # torn front-left corner: stuffing bulging out
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=0.03)
    blob = L._link(bm, 'stuffing')
    rnd = random.Random(5)
    L.displace(blob, lambda v: Vector((v.x * 1.3, v.y * 0.8, v.z * 0.55)) * (1 + rnd.uniform(-0.18, 0.18)))
    L.place(blob, xf((-0.14, 0.17, 0.488), (0, 0, 25)))
    P.add(blob, stuffing, smooth=80)

    # back: curved top rail + mid rail, three spindles (one snapped)
    def arc(z, y0, bow, n=7, half=0.186):
        return [(half * (2 * i / (n - 1) - 1), y0 - bow * (1 - (2 * i / (n - 1) - 1) ** 2), z) for i in range(n)]

    top_prof = unit_profile(chamfer_rect(0.024, 0.075, 0.007), 0.0375)
    top_path = arc(0.862, -0.226, 0.02)
    top = L.tube('top_rail', top_path, 0.0375, profile=[(y, x) for x, y in top_prof], caps=True, up_hint=(0, 0, 1))
    # arched crest: the top edge rises toward the middle
    L.displace(top, lambda v: Vector((v.x, v.y, v.z + (0.02 * (1 - (v.x / 0.19) ** 2) if v.z > 0.87 else 0.0))))
    P.add(top, wood, smooth=30)
    mid_prof = unit_profile(chamfer_rect(0.02, 0.036, 0.005), 0.018)
    mid_path = arc(0.62, -0.192, 0.018)
    P.add(L.tube('mid_rail', mid_path, 0.018, profile=[(y, x) for x, y in mid_prof], caps=True), wood, smooth=30)
    for i, sx in enumerate((-0.085, 0.0, 0.085)):
        bow_m = -0.192 - 0.018 * (1 - (sx / 0.186) ** 2)
        bow_t = -0.226 - 0.02 * (1 - (sx / 0.186) ** 2)
        br = (0.38, 0.62) if i == 2 else None
        for o in spindle(f'spindle_{i}', (sx, bow_m, 0.636), (sx, bow_t, 0.826), 0.0085, broken=br, seed=7 + i):
            P.add(o, wood, smooth=40)
    return wood


def build_chair():
    P = L.Piece('chair', 'floor', tex=512, max_tris=2000, ao=0.1, bevel=0.004)
    chair_parts(P)
    P.finish(previews=dict(yaw=35, pitch=18))


def build_chair_fallen():
    P = L.Piece('chair_fallen', 'floor', tex=512, max_tris=2000, ao=0.1, bevel=0.004, seed=4)
    chair_parts(P, seed=3)
    # tipped over onto its left side, leaning back a little on the top rail
    P.transform_all(Matrix.Rotation(math.radians(-90), 4, 'Y') @ Matrix.Rotation(math.radians(4), 4, 'X'))
    lo, hi = L.bounds([p['obj'] for p in P.parts])
    P.transform_all(Matrix.Rotation(math.radians(-12), 4, 'Z'))
    P.finish(previews=dict(yaw=30, pitch=28))
