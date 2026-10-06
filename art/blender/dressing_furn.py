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

import numpy as np

import dressing_img as I
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


# =============================================================================================
# Boarded-up window
# =============================================================================================

WALL = Matrix.Rotation(math.radians(180), 4, 'Z') @ Matrix.Rotation(math.radians(90), 4, 'X')


def plank_outline(length, width, seed, broken=False):
    """Rough-sawn board face (X along the board): wavy long edges, off-square saw cuts, or a
    jagged snapped end on the right."""
    rnd = random.Random(seed)
    n = 6
    bot, top = [], []
    for i in range(n + 1):
        x = -length / 2 + length * i / n
        bot.append((x, -width / 2 + rnd.uniform(-0.002, 0.004)))
        top.append((x, width / 2 + rnd.uniform(-0.004, 0.002)))
    if broken:
        right = []
        k = 5
        for i in range(1, k):
            t = i / k
            right.append((length / 2 - rnd.uniform(0.0, 0.07) - (0.04 if i % 2 else 0.0),
                          -width / 2 + width * t))
        bot[-1] = (length / 2 - 0.02, bot[-1][1])
        top[-1] = (length / 2 - 0.09, top[-1][1])
    else:
        right = []
    bot[0] = (bot[0][0] + rnd.uniform(-0.01, 0.01), bot[0][1])
    top[0] = (top[0][0] + rnd.uniform(-0.01, 0.01), top[0][1])
    return bot + right + list(reversed(top))


def mat_planks(name, light, dark, seed, nails, gray=0.0):
    """Weathered raw boards with checks along the grain and rust streaks running down from nails.
    nails: [(x, z)] in final Blender coordinates (front view)."""
    mat = L.new_material(name)
    g = L.G(mat)
    col, h = L.wood_pattern(g, light, dark, ring=0.008, figure=0.9, seed=seed)
    p = g.pos()
    x, y, z = g.sep(p)
    rough = g.add(0.78, g.mul(g.noise(None, 8.0, 2, 0.5), 0.15))
    # weather checks
    ck = g.vor(g.vmul(g.gc(), (1.2, 30.0, 30.0)), 3.0, 'DISTANCE_TO_EDGE', offset=(seed, 0, 0))
    cm = g.mul(g.rng(ck, 0.05, 0.0), g.rng(g.noise(g.gc(), 2.0, 2, 0.5, stretch=(0.5, 3.0, 3.0)), 0.4, 0.6))
    col = g.mix(cm, col, hexc('100b07'))
    h = g.sub(h, g.mul(cm, 1.5))
    # sawmill marks (circular saw arcs) on the faces
    saw = g.wave(g.vmul(g.gc(), (1.0, 1.0, 0.0)), 18.0, 'RINGS', rings_dir='SPHERICAL', dist=0.5)
    col = g.mix(g.mul(g.rng(saw, 0.4, 0.6), 0.12), col, g.hsv(col, v=0.75))
    rust = None
    for (nx, nz) in nails:
        dx = g.absf(g.sub(x, nx))
        dz = g.sub(nz, z)  # > 0 below the nail
        width = g.add(0.005, g.mul(g.mx(dz, 0.0), 0.06))
        streak = g.mul(g.rng(dx, width, 0.0), g.mul(g.rng(dz, 0.22, 0.0), g.rng(dz, -0.004, 0.004)))
        ring = g.rng(g.m('SQRT', g.add(g.mul(dx, dx), g.mul(dz, dz))), 0.014, 0.004)
        r = g.mx(streak, ring)
        rust = r if rust is None else g.mx(rust, r)
    if rust is not None:
        rn = g.noise(p, 60.0, 2, 0.6, stretch=(3.0, 1.0, 0.3))
        rust = g.mul(rust, g.rng(rn, 0.25, 0.6, 0.3, 1.0))
        col = g.mix(g.mul(rust, 0.95), col, hexc('4a220e'))
        rough = g.mixf(rust, rough, 0.9)
    if gray:
        col = g.mix(gray, col, g.mix(0.5, g.hsv(col, s=0.2, v=1.1), hexc('7a7468')))
    col, rough, h = L.age(g, col, rough, h, dust=0.55, grime=0.8, wear=0.3, scratch=0.3, stains=0.4, seed=seed,
                          film=0.08)
    return g.finish(col, rough, h, bump_dist=0.0012, soft=0.003)


def build_boards():
    P = L.Piece('boards', 'wall', tex=512, max_tris=1500, ao=0.12, bevel=0.004, ao_small=0.012, seed=31)
    M = WALL
    paint = L.mat_paint('window_paint', hexc('b0a88e'), hexc('6a5038'), gloss=0.5, chip=0.75, dust=0.7, grime=1.0,
                        wear=0.6, seed=1.0, stains=0.6, fade=0.3)
    # casing (molded trim) around the opening + stool + apron
    OW, OH = 0.51, 0.71
    path = [(-OW, -OH), (OW, -OH), (OW, OH), (-OW, OH)]
    prof = [(0.0, 0.0), (0.0, 0.016), (0.006, 0.022), (0.05, 0.022), (0.062, 0.019), (0.072, 0.014), (0.08, 0.012),
            (0.08, 0.0)]
    P.add(L.sweep('casing', prof, path, M=M), paint, smooth=30)
    P.add(L.box('stool', (1.12, 0.028, 0.065), M @ xf((0, -OH + 0.06, 0.0325)), bevel=0.004), paint)
    P.add(L.box('apron', (0.9, 0.06, 0.018), M @ xf((0, -OH - 0.012, 0.009)), bevel=0.003), paint, weight=0.6)
    # two-over-two sash inside the opening (lower sash a touch proud of the upper one)
    IW, IH = OW - 0.08, OH - 0.08
    sash = L.mat_paint('sash_paint', hexc('a49c84'), hexc('5a4430'), gloss=0.45, chip=0.85, dust=0.8, grime=1.0,
                       wear=0.5, seed=2.0, stains=0.7, fade=0.35)
    panes = []
    for si, (y0, y1, z0) in enumerate(((0.0, IH, 0.004), (-IH, 0.0, 0.012))):
        t = 0.045
        cy = (y0 + y1) / 2
        hh = y1 - y0
        for nm, sz, loc in (('l', (t, hh, 0.02), (-IW + t / 2, cy, z0 + 0.01)), ('r', (t, hh, 0.02), (IW - t / 2, cy, z0 + 0.01)),
                            ('t', (2 * IW - 2 * t, t, 0.02), (0, y1 - t / 2, z0 + 0.01)),
                            ('b', (2 * IW - 2 * t, t, 0.02), (0, y0 + t / 2, z0 + 0.01)),
                            ('m', (0.022, hh - 2 * t, 0.016), (0, cy, z0 + 0.008))):
            P.add(L.box(f'sash{si}_{nm}', sz, M @ xf(loc), bevel=0.0), sash, weight=0.5, flat=True)
        for k, (xa, xb) in enumerate(((-IW + t, -0.011), (0.011, IW - t))):
            panes.append((xa, xb, y0 + t, y1 - t, z0 + 0.006, len(panes)))
    # dark, dirty glass; one pane smashed (hole + cracks), one cracked
    crack_tiles = []
    for i in range(4):
        if i == 1:
            crack_tiles.append(I.crack_map_rays(128, 192, 0.45, 0.4, [a * 0.7 for a in range(9)], seed=40 + i))
        elif i == 2:
            crack_tiles.append(I.crack_map_rays(128, 192, 0.6, 0.7, [1.0, 2.4, 3.9, 5.2], seed=40 + i) * 0.8)
        else:
            crack_tiles.append(np.zeros((192, 128), dtype=np.float32))
    cimg = L.np_image('window_cracks', np.concatenate(crack_tiles, axis=1), non_color=True)
    gm = L.new_material('window_glass')
    g = L.G(gm)
    p = g.pos()
    cr = g.sep(g.img(cimg)[0])[0]
    uvp = g.uv('src')
    u_, v_, _ = g.sep(uvp)
    # the smashed hole in tile 1: black void with sharp edges
    hole = g.rng(g.v('LENGTH', g.vmul(g.vadd(uvp, (-0.3625, -0.4, 0.0)), (4.0, 1.0, 0.0))), 0.13, 0.11)
    streak = g.noise(p, 3.0, 4, 0.6, stretch=(1.0, 1.0, 0.25))
    dirt = g.rng(streak, 0.4, 0.75)
    col = g.mix(dirt, hexc('0b0d0f'), hexc('3a3a34'))
    col = g.mix(cr, col, hexc('9a9c98'))
    col = g.mix(hole, col, hexc('000000'))
    rough = g.mixf(dirt, 0.08, 0.6)
    rough = g.mixf(hole, rough, 1.0)
    col, rough, _ = L.age(g, col, rough, 0.0, dust=0.6, grime=0.9, wear=0.0, scratch=0.0, seed=5.0, film=0.05,
                          up_lo=0.2)
    g.finish(col, rough, None)
    for (xa, xb, ya, yb, zz, k) in panes:
        o = L.grid(f'pane_{k}', 1, 1, lambda u, v: (xa + (xb - xa) * u, ya + (yb - ya) * v, zz), M=M)
        for d_ in o.data.uv_layers['src'].data:
            d_.uv = ((k + d_.uv[0]) / 4.0, d_.uv[1])
        P.add(o, gm, flat=True, uv='smart', weight=0.8)
    # planks: (center y, angle, width, length, z, broken, seed, material)
    boards = [(0.43, -4.0, 0.17, 1.12, 0.026, False, 1, 0), (0.12, 3.0, 0.19, 1.16, 0.026, False, 2, 1),
              (-0.21, -2.0, 0.15, 1.10, 0.026, False, 3, 0), (-0.52, 6.0, 0.18, 1.06, 0.026, True, 4, 1),
              (-0.02, 37.0, 0.16, 1.52, 0.05, False, 5, 0)]
    nails, heads = [], []
    for (cy, ang, wd, ln, zz, broken, sd, mi) in boards:
        R = Matrix.Rotation(math.radians(ang), 4, 'Z')
        T = Matrix.Translation((0.0 if ang < 20 else 0.0, cy, zz))
        for cx in (-0.47, 0.47):
            if ang > 20:
                break
            if broken and cx > 0:
                continue
            for sy in (-0.28, 0.28):
                lp = (T @ R) @ Vector((cx / math.cos(math.radians(ang)), sy * wd, 0.022))
                heads.append(lp)
        if ang > 20:
            for t in (-0.62, 0.0, 0.62):
                heads.append((T @ R) @ Vector((t, 0.0, 0.022)))
    for lp in heads:
        bp = M @ lp
        nails.append((bp.x, bp.z))
    mats = [mat_planks('planks_gray', hexc('7a7062'), hexc('4a4238'), 3.0, nails, gray=0.4),
            mat_planks('planks_brown', hexc('6e5236'), hexc('3e2c1a'), 7.0, nails)]
    for (cy, ang, wd, ln, zz, broken, sd, mi) in boards:
        o = L.prism(f'plank_{sd}', plank_outline(ln, wd, sd, broken), 0.022)
        L.place(o, M @ Matrix.Translation((0, cy, zz)) @ Matrix.Rotation(math.radians(ang), 4, 'Z'), 'x')
        P.add(o, mats[mi], smooth=30, weight=1.0)
    iron = L.mat_metal('nail_iron', hexc('3a3632'), rough=0.6, tarnish=0.4, rust=0.8, dust=0.2, seed=8.0)
    for k, lp in enumerate(heads):
        pts = [(0.0045 * math.cos(2 * math.pi * i / 5), 0.0045 * math.sin(2 * math.pi * i / 5)) for i in range(5)]
        o = L.prism(f'nail_{k}', pts, 0.0015)
        L.place(o, M @ Matrix.Translation(lp))
        P.add(o, iron, flat=True, weight=0.3)
    P.finish(origin=(0, 0, 0), previews=dict(yaw=25, pitch=5, extra=[dict(tag='flash_front', yaw=0, pitch=0,
                                                                          mood='flash')]))


# =============================================================================================
# Coat rack with an old overcoat and a fedora
# =============================================================================================

def mat_coat(name, buttons_z, front_y, seed=0.0):
    """Heavy wool overcoat: dark olive-brown twill, sun-faded shoulders, moth holes, stains, a
    button placket down the front."""
    mat = L.new_material(name)
    g = L.G(mat)
    p = g.pos()
    x, y, z = g.sep(p)
    tw = g.wave(g.vadd(g.vmul(p, (1.0, 1.0, 1.0)), g.vmul(g.comb(z, z, 0.0), (1.0, 1.0, 0.0))), 700.0, 'BANDS', 'X')
    base = g.mix(g.rng(g.noise(p, 30.0, 3, 0.6), 0.3, 0.7), hexc('34301f'), hexc('2a261c'))
    col = g.mix(g.mul(tw, 0.2), base, hexc('46402c'))
    h = g.add(g.mul(tw, 0.4), g.mul(g.noise(p, 200.0, 2, 0.6), 0.4))
    # placket + buttons (front-facing surfaces near x = 0)
    fy = g.rng(g.sep(g.geo('Normal'))[1], 0.3, 0.7)
    plack = g.mul(g.rng(g.absf(g.sub(x, 0.012)), 0.003, 0.0015), fy)
    col = g.mix(g.mul(plack, 0.8), col, hexc('15130e'))
    for bz in buttons_z:
        d = g.m('SQRT', g.add(g.mul(g.sub(x, -0.03), g.sub(x, -0.03)), g.mul(g.sub(z, bz), g.sub(z, bz))))
        b = g.mul(g.rng(d, 0.012, 0.009), fy)
        col = g.mix(b, col, hexc('1a1410'))
        h = g.add(h, g.mul(b, 1.2))
    col, rough, h = L.age(g, col, 0.92, h, dust=0.6, grime=0.9, wear=0.0, scratch=0.0, stains=0.6, fade=0.25,
                          seed=seed, film=0.03, up_lo=0.3)
    # moth holes
    hv = g.vor(p, 40.0, 'F1', offset=(seed, 1.0, 0))
    hc = g.sep(g.vor(p, 40.0, 'F1', out='Color', offset=(seed, 1.0, 0)))[0]
    hm = g.mul(g.rng(hv, 0.1, 0.06), g.rng(hc, 0.9, 0.91))
    col = g.mix(hm, col, hexc('050404'))
    h = g.sub(h, g.mul(hm, 2.0))
    return g.finish(col, rough, h, bump_dist=0.0008)


def build_coat_rack():
    P = L.Piece('coat_rack', 'floor', tex=512, max_tris=1500, ao=0.15, bevel=0.003, ao_small=0.015, seed=41)
    wood = L.mat_wood('rack_wood', hexc('3e2618'), hexc('1c100a'), gloss=0.3, ring=0.006, figure=0.6, dust=0.8,
                      grime=0.9, wear=0.7, scratch=0.5, fade=0.15, seed=2.0, peel=0.15, peel_col=hexc('6a4a30'),
                      film=0.06)
    pole = [(0.0, 0.17), (0.02, 0.175), (0.027, 0.22), (0.024, 0.3), (0.028, 0.33), (0.021, 0.37), (0.019, 1.56),
            (0.024, 1.59), (0.019, 1.62), (0.018, 1.8), (0.027, 1.82), (0.029, 1.85), (0.017, 1.88), (0.0, 1.885)]
    P.add(L.lathe('pole', pole, segs=10), wood, smooth=50)
    # three bentwood feet curling up at the toes
    leg = [(0.015, 0.36), (0.07, 0.29), (0.15, 0.15), (0.23, 0.045), (0.29, 0.013), (0.335, 0.016), (0.352, 0.042)]
    for k in range(3):
        a = math.radians(90 + 120 * k + 60)
        pts = [(r * math.cos(a), r * math.sin(a), z) for r, z in leg]
        P.add(L.tube(f'leg_{k}', pts, [0.014, 0.014, 0.013, 0.012, 0.0115, 0.011, 0.0105], segs=6), wood, smooth=50)
    # four hooks near the top
    hook = [(0.015, 1.6), (0.065, 1.625), (0.11, 1.675), (0.13, 1.735), (0.122, 1.772), (0.1, 1.775), (0.093, 1.752)]
    hook_tips = []
    for k in range(4):
        a = math.radians(45 + 90 * k)
        pts = [(r * math.cos(a), r * math.sin(a), z) for r, z in hook]
        P.add(L.tube(f'hook_{k}', pts, [0.011, 0.011, 0.0105, 0.01, 0.0095, 0.009, 0.0085], segs=6), wood, smooth=50)
        hook_tips.append(Vector(pts[3]))
    # overcoat hanging by its collar from the front-left hook: shoulders collapsed, deep folds
    hk = hook_tips[1]
    ca = math.radians(135)
    fwd = Vector((math.cos(ca), math.sin(ca), 0))   # away from the pole
    side = Vector((-fwd.y, fwd.x, 0))
    # (z, half width across the shoulders, half depth, fold amplitude)
    rings = [(1.735, 0.035, 0.025, 0.0), (1.69, 0.085, 0.05, 0.02), (1.62, 0.15, 0.085, 0.04),
             (1.53, 0.175, 0.105, 0.06), (1.38, 0.18, 0.11, 0.08), (1.2, 0.19, 0.115, 0.1),
             (1.0, 0.205, 0.12, 0.12), (0.82, 0.215, 0.125, 0.13), (0.66, 0.225, 0.13, 0.14)]
    nseg = 16
    rnd = random.Random(5)
    folds = [(rnd.uniform(0, 6.28), rnd.uniform(0, 6.28)) for _ in range(3)]
    verts, faces = [], []
    c0 = Vector((hk.x, hk.y, 0)) + fwd * 0.115
    for ri, (z, w, d, fa) in enumerate(rings):
        for k in range(nseg):
            a_ = 2 * math.pi * k / nseg
            # vertical folds that run the whole length (same phase on every ring) + some twist
            f = (math.sin(5 * a_ + folds[0][0]) * 0.6 + math.sin(3 * a_ + folds[1][0] + z * 2.0) * 0.4)
            r = 1 + fa * f
            pos = c0 + side * (math.cos(a_) * w * r) + fwd * (math.sin(a_) * d * r)
            zz = z
            if ri == len(rings) - 1:
                zz += 0.03 * math.sin(3 * a_ + folds[2][0]) - 0.02 * max(0.0, math.sin(a_))  # uneven hem, front hangs lower
            verts.append((pos.x, pos.y, zz))
    for ri in range(len(rings) - 1):
        for k in range(nseg):
            a0, b0 = ri * nseg + k, ri * nseg + (k + 1) % nseg
            faces.append((a0 + nseg, b0 + nseg, b0, a0))
    faces.append(list(range(nseg)))  # collar cap
    base = len(verts)
    last = (len(rings) - 1) * nseg
    for k in range(nseg):
        v = Vector(verts[last + k])
        inner = c0 + (Vector((v.x, v.y, 0)) - Vector((c0.x, c0.y, 0))) * 0.88
        verts.append((inner.x, inner.y, 0.71))
    for k in range(nseg):
        a0, b0 = last + k, last + (k + 1) % nseg
        faces.append((a0, b0, base + (k + 1) % nseg, base + k))
    faces.append(list(range(base, base + nseg))[::-1])
    coat = L.mesh('coat', verts, faces)
    L.recalc_normals(coat)
    cmat = mat_coat('coat_wool', [1.45, 1.31, 1.17, 1.03], 0.0, seed=3.0)
    P.add(coat, cmat, smooth=80, weight=1.1)
    # sleeves hang down the front of the body, a little bent
    for sx in (-1, 1):
        sh = c0 + side * (sx * 0.15) + Vector((0, 0, 1.585))
        pts = [sh, sh + side * sx * 0.012 + fwd * 0.045 + Vector((0, 0, -0.2)),
               sh - side * sx * 0.005 + fwd * 0.085 + Vector((0, 0, -0.4)),
               sh - side * sx * 0.02 + fwd * 0.095 + Vector((0, 0, -0.58))]
        P.add(L.tube(f'sleeve_{sx}', pts, [0.062, 0.06, 0.056, 0.054], segs=8, caps=True, scale_xy=(1.0, 0.8)),
              cmat, smooth=80, weight=0.8)
    # fedora sitting a little crooked on the top knob
    hat = [(0.088, 0.0), (0.158, 0.0), (0.168, 0.009), (0.162, 0.007), (0.09, 0.006), (0.087, 0.032),
           (0.081, 0.088), (0.068, 0.112), (0.034, 0.104), (0.0, 0.098)]
    ho = L.lathe('hat', hat, segs=14, cap_bot=False)

    def crease(v):
        # center dent along the crown + front pinch, oval brim
        if v.z > 0.09:
            v.z -= 0.014 * math.exp(-(v.x / 0.03) ** 2)
        if v.z > 0.05 and v.x > 0.03:
            v.y *= 1 - 0.18 * (v.x / 0.08)
        v.x *= 1.06
        v.y *= 0.94
        return v
    L.displace(ho, crease)
    felt = L.mat_fabric('hat_felt', hexc('302a24'), hexc('3a332b'), weave=1500.0, fade=0.4, stains=0.6, dust=1.0,
                        grime=0.8, seed=6.0, rough=0.9)
    L.place(ho, xf((0.0, 0.0, 1.795), (12, -8, 30)), 'z')
    P.add(ho, felt, smooth=60, weight=0.9)
    P.finish(previews=dict(yaw=30, pitch=10))
