"""
Set dressing, wall pieces: oval family portrait (cracked glass, scratched-out face), crooked
landscape painting (slashed canvas), pendulum regulator clock (stopped, door ajar).

Wall convention: built in a local "picture" frame (X right, Y up, Z out of the wall toward the
viewer), then WALL = Rz(180) @ Rx(90) maps it to Blender (front = +Y, up = +Z). The pipeline puts
the origin at the center of the back plane.
Helper module: build() is a no-op; dressing.py calls build_<name>().
"""

from __future__ import annotations

import math
import random

import bpy  # noqa: F401,I001
import bmesh
import numpy as np
from mathutils import Matrix, Vector

import dressing_img as I
import dressing_lib as L
from dressing_lib import G, hexc, xf

WALL = Matrix.Rotation(math.radians(180), 4, 'Z') @ Matrix.Rotation(math.radians(90), 4, 'X')


def build() -> None:
    print('dressing_wall: helper module (built through dressing.py)')


# =============================================================================================
# Shared materials
# =============================================================================================

def mat_gilt(name, *, ornament='oval', seed=0.0, dust=0.8, bole=0.5):
    """Gilded gesso frame: tarnished gold leaf, rubbed through to red bole / white gesso on the
    high points, black grime packed into the carving, dust on top. Carving comes from gc = (L, d, h)."""
    mat = L.new_material(name)
    g = G(mat)
    gc = g.gc()
    Lc, d, hh = g.sep(gc)
    p = g.pos()
    # carving height
    # leaves along the torus band
    f = g.fract(g.mul(Lc, 1 / 0.028))
    t = g.mul(g.sub(d, 0.0375 if ornament == 'oval' else 0.040), 1 / 0.011)
    leafw = g.mul(g.sin(g.mul(f, math.pi)), 0.95)
    leaf = g.rng(g.sub(leafw, g.absf(t)), 0.0, 0.25)
    vein = g.mul(g.rng(g.absf(t), 0.12, 0.0), leaf)
    band = g.mul(g.rng(d, 0.024, 0.028), g.rng(d, 0.052 if ornament == 'oval' else 0.056, 0.048))
    leaf = g.mul(leaf, band)
    # pearls on the inner flat
    f2 = g.sub(g.fract(g.mul(Lc, 1 / 0.009)), 0.5)
    r0 = 0.0535 if ornament == 'oval' else 0.06
    t2 = g.mul(g.sub(d, r0), 1 / 0.0045)
    pr = g.m('SQRT', g.add(g.mul(f2, f2), g.mul(t2, t2)))
    pearl = g.rng(pr, 0.48, 0.2)
    # rope twist on the outer bead
    rope = g.mul(g.rng(d, 0.0, 0.004), g.rng(d, 0.02, 0.015))
    rp = g.mul(g.add(g.sin(g.mul(g.add(Lc, g.mul(d, 1.5)), 2 * math.pi / 0.007)), 1.0), 0.5)
    rope = g.mul(rope, rp)
    carve = g.add(g.add(g.mul(leaf, 0.9), g.add(g.mul(vein, -0.3), pearl)), g.mul(rope, 0.6))
    # damage: chipped gesso chunks exposing dark wood
    ch = g.noise(p, 9.0, 4, 0.65, offset=(seed, 1.0, 2.0))
    chip = g.rng(g.add(ch, g.mul(g.convex(), 0.3)), 0.70, 0.72, smooth=False)
    gold = hexc('8c6a2c')
    tarn = hexc('4a3a1e')
    tn = g.noise(p, 6.0, 3, 0.6, offset=(seed, 4.0, 0))
    col = g.mix(g.rng(tn, 0.35, 0.7), gold, tarn)
    rough = g.mixf(g.rng(tn, 0.35, 0.7), 0.32, 0.55)
    metal = g.add(0.95, 0.0)
    # rubbed through on high points of the carving and convex edges
    rub = g.clamp(g.add(g.mul(carve, 0.55), g.mul(g.convex(), 0.8)))
    rubn = g.noise(p, 30.0, 3, 0.6, offset=(0, seed, 0))
    rubm = g.rng(g.add(rub, g.mul(g.sub(rubn, 0.5), 0.6)), 0.55, 0.75)
    rubm = g.mul(rubm, bole)
    col = g.mix(rubm, col, g.mix(g.rng(rubn, 0.4, 0.6), hexc('7a3420'), hexc('b8aa8a')))
    rough = g.mixf(rubm, rough, 0.8)
    metal = g.mixf(rubm, metal, 0.0)
    # grime packed into the carving recesses + geometric cavities
    low = g.mul(g.rng(carve, 0.25, 0.0), g.add(band, g.mul(g.rng(d, 0.05, 0.056), 1.0)))
    grime = g.clamp(g.add(g.mul(low, 0.65), g.mul(g.cavity(0.45, 0.95), 0.85)))
    col = g.mix(grime, col, hexc('120d08'))
    rough = g.mixf(grime, rough, 0.9)
    metal = g.mixf(grime, metal, 0.0)
    col = g.mix(chip, col, hexc('2a1e14'))
    metal = g.mixf(chip, metal, 0.0)
    rough = g.mixf(chip, rough, 0.85)
    h = g.sub(carve, g.mul(chip, 0.6))
    col, rough, h = L.age(g, col, rough, h, dust=dust, grime=0.0, wear=0.0, scratch=0.15, seed=seed, film=0.18,
                          up_lo=0.15)
    metal = g.mixf(g.mul(g.up(0.15, 0.9), dust * 0.8), metal, 0.0)
    return g.finish(col, rough, h, metal=metal, bump_dist=0.0012)


def mat_backing(name, seed=0.0):
    return L.mat_plain(name, hexc('3a2c1e'), 0.9, dust=0.5, grime=0.9, noise_amt=0.3, seed=seed, wear=0.2)


def mat_iron(name, seed=0.0):
    return L.mat_metal(name, hexc('4a4640'), rough=0.6, tarnish=0.4, rust=0.7, dust=0.3, seed=seed)


def wire_and_nail(P, top_local, half_w, M, seed=1):
    """Picture wire from two screw eyes on the frame back up to a nail (local picture coords)."""
    iron = mat_iron('nail_iron', seed)
    nail = Vector((0.0, top_local + 0.07, 0.0))
    for sx in (-1, 1):
        a = Vector((sx * half_w, top_local - 0.06, 0.006))
        pts = [a, a.lerp(nail, 0.5) + Vector((0, 0.004, 0.003)), nail + Vector((0, -0.004, 0.012))]
        P.add(L.tube(f'wire_{sx}', [M @ p for p in pts], 0.0012, segs=4), iron, smooth=60)
    head = L.lathe('nail_head', [(0, 0), (0.005, 0.0), (0.005, 0.0015), (0, 0.002)], segs=8,
                   M=M @ xf((nail.x, nail.y, 0.016)))
    P.add(head, iron, smooth=30)
    shank = L.tube('nail_shank', [M @ (nail + Vector((0, 0, 0.0))), M @ (nail + Vector((0, 0, 0.016)))], 0.0016, segs=5)
    P.add(shank, iron)


# =============================================================================================
# Oval family portrait
# =============================================================================================

def build_frame_portrait():
    P = L.Piece('frame_portrait', 'wall', tex=512, glass_tex=256, max_tris=1500, ao=0.05, bevel=0.003,
                ao_small=0.006)
    rx, ry = 0.205, 0.255
    N = 44
    path = L.ellipse_pts(rx, ry, N)
    # profile (d = inward from the outer edge, h = height off the wall), outer back -> sight edge
    prof = [(0.0, 0.0), (0.0, 0.020), (0.003, 0.028), (0.009, 0.033), (0.015, 0.031), (0.019, 0.026),
            (0.025, 0.027), (0.031, 0.035), (0.038, 0.039), (0.045, 0.036), (0.049, 0.030), (0.053, 0.028),
            (0.057, 0.026), (0.059, 0.020), (0.0595, 0.010)]
    tilt = Matrix.Rotation(math.radians(2.5), 4, 'Z')  # hangs a touch crooked
    lean = Matrix.Rotation(math.radians(-3.0), 4, 'X')  # top leans off the wall (hung on a wire)
    M = WALL @ xf((0, 0, 0)) @ lean @ tilt
    frame = L.sweep('frame', prof, path, M=M)
    P.add(frame, mat_gilt('portrait_gilt', seed=1.0), smooth=50, weight=1.0)
    # back board
    back = L.prism('backboard', L.ellipse_pts(rx - 0.004, ry - 0.004, 28), 0.006, M=M @ xf((0, 0, 0.001)))
    P.add(back, mat_backing('portrait_back'), flat=True, weight=0.3)
    # photo (planar src UVs over its bounding box)
    ox, oy = rx - 0.045, ry - 0.045
    photo_img = L.np_image('portrait_photo', I.portrait_photo(320, 400))
    pts = L.ellipse_pts(ox, oy, 28)
    ph = L.prism('photo', pts, 0.002, M=M @ xf((0, 0, 0.007)), src_uv=((-ox, -oy), (ox, oy)))
    pm = L.mat_image('portrait_photo', photo_img, rough=0.42, dust=0.25, grime=0.5, fade=0.0, seed=2.0)
    P.add(ph, pm, flat=True, weight=4.0, uv='src')
    # cracked glass: a fan of shards around the impact point, a few tilted, one missing (over his face)
    gz = 0.0125
    imp = Vector((0.018, 0.098))
    n = 26
    gx, gy = ox + 0.004, oy + 0.004
    bnd = [Vector((gx * math.cos(2 * math.pi * i / n), gy * math.sin(2 * math.pi * i / n))) for i in range(n)]
    angs = [math.atan2((b - imp).y, (b - imp).x) for b in bnd]
    rnd = random.Random(4)
    cuts = sorted(rnd.sample(range(n), 9))
    shards = []
    for k in range(len(cuts)):
        a, b = cuts[k], cuts[(k + 1) % len(cuts)]
        idx = list(range(a, b + 1)) if b > a else list(range(a, n)) + list(range(0, b + 1))
        shards.append(idx)
    # missing shard: the one whose fan covers the direction of the father's face
    face = Vector((-ox + 0.63 * 2 * ox, oy - 0.165 * 2 * oy))
    fa = math.atan2((face - imp).y, (face - imp).x)

    def covers(idx):
        a0, a1 = angs[idx[0]], angs[idx[-1]]
        span = (a1 - a0) % (2 * math.pi)
        return ((fa - a0) % (2 * math.pi)) <= span
    crack_rays = [angs[c] for c in cuts]
    gimg = L.np_image('portrait_cracks', I.crack_map_rays(256, 320, (imp.x + gx) / (2 * gx), (gy - imp.y) / (2 * gy),
                                                           [-a for a in crack_rays], seed=5))
    glass = L.mat_glass('portrait_glass', tint=hexc('202420'), alpha=0.16, dust=0.7, grime=0.5, cracks=gimg)
    for si, idx in enumerate(shards):
        if covers(idx):
            continue
        verts = [(imp.x, imp.y, gz)] + [(bnd[i].x, bnd[i].y, gz) for i in idx]
        faces = [(0, k, k + 1) for k in range(1, len(verts) - 1)]
        uvs = [((v[0] + gx) / (2 * gx), (v[1] + gy) / (2 * gy)) for v in verts]
        o = L.mesh(f'shard_{si}', verts, faces, uvs=uvs)
        # tilt a few shards (they've dropped a little inside the frame)
        ax = Vector((math.cos(angs[idx[len(idx) // 2]]), math.sin(angs[idx[len(idx) // 2]]), 0)).orthogonal()
        rot = Matrix.Translation((imp.x, imp.y, gz)) @ Matrix.Rotation(math.radians(rnd.uniform(-2.5, 2.5)), 4, ax) \
            @ Matrix.Translation((-imp.x, -imp.y, -gz))
        o.data.transform(M @ rot)
        P.add(o, glass, flat=True, uv='src', weight=1.0)
    # a loose shard still in the frame, slipped down to the bottom rim
    wire_and_nail(P, ry, 0.09, M)
    P.finish(previews=dict(yaw=20, pitch=5, extra=[dict(tag='close', yaw=10, pitch=4, zoom=2.2)]))


# =============================================================================================
# Crooked landscape painting
# =============================================================================================

def build_frame_landscape():
    P = L.Piece('frame_landscape', 'wall', tex=512, max_tris=1500, ao=0.06, bevel=0.003, ao_small=0.008)
    cw, chh = 0.66, 0.454  # canvas (painting aspect 512:352)
    W, H = cw / 2 + 0.0625, chh / 2 + 0.0625  # sight edge sits 1 cm inside the canvas edge
    path = [(W, -H), (W, H), (-W, H), (-W, -H)]
    path = [path[3], path[0], path[1], path[2]]  # CCW from bottom-left
    prof = [(0.0, 0.0), (0.0, 0.026), (0.004, 0.034), (0.010, 0.038), (0.016, 0.035), (0.020, 0.030),
            (0.026, 0.031), (0.033, 0.041), (0.041, 0.046), (0.049, 0.044), (0.055, 0.037), (0.059, 0.033),
            (0.064, 0.032), (0.068, 0.030), (0.071, 0.024), (0.0725, 0.012)]
    crooked = Matrix.Rotation(math.radians(-6.5), 4, 'Z')
    lean = Matrix.Rotation(math.radians(-2.5), 4, 'X')
    M = WALL @ lean @ crooked
    frame = L.sweep('frame', prof, path, M=M)
    # subdivide the long sides a little so the carving bakes evenly (and silhouettes stay crisp)
    P.add(frame, mat_gilt('landscape_gilt', ornament='rect', seed=3.0, bole=0.6), smooth=40, weight=1.0)
    # corner cartouches (raised shells) on the four corners
    for sx in (-1, 1):
        for sy in (-1, 1):
            bm = bmesh.new()
            bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=4, radius=0.03)
            o = L._link(bm, f'shell_{sx}_{sy}')
            L.displace(o, lambda v: Vector((v.x * 1.0, v.y * 1.0, max(v.z, -0.002) * 0.35)))
            L.place(o, M @ xf((sx * (W - 0.036), sy * (H - 0.036), 0.040), (0, 0, 45 * sx * sy)))
            P.add(o, mat_gilt('landscape_gilt_c', ornament='rect', seed=4.0 + sx + sy, bole=0.7), smooth=60, weight=0.6)
    back = L.box('backboard', (2 * W - 0.01, 2 * H - 0.01, 0.006), M @ xf((0, 0, 0.004)), bevel=0.002)
    P.add(back, mat_backing('landscape_back'), weight=0.2)
    # canvas on its stretcher, painting via src UV (+ slash bump)
    paint = L.np_image('landscape_paint', I.landscape_painting(512, 352))
    slash = L.np_image('landscape_slash', I.slash_mask(512, 352), non_color=True)
    mat = L.new_material('landscape_canvas')
    g = G(mat)
    c, _ = g.img(paint)
    sl = g.sep(g.img(slash)[0])[0]
    uv = g.uv('src')
    # craquelure (fine crack network in the old varnish) + brush strokes
    cr = g.vor(g.vmul(uv, (1.0, 0.69, 1.0)), 38.0, 'DISTANCE_TO_EDGE')
    crack = g.rng(cr, 0.03, 0.0)
    col = g.mix(g.mul(crack, 0.55), c, hexc('15100a'))
    brush = g.noise(g.vmul(uv, (1.0, 6.0, 1.0)), 60.0, 3, 0.6)
    h = g.add(g.mul(brush, 0.35), g.mul(crack, -0.5))
    h = g.add(h, g.mul(sl, 1.2))
    rough = g.add(g.mixf(crack, 0.42, 0.7), g.mul(g.inv(sl), 0.4))
    col, rough, h = L.age(g, col, rough, h, dust=0.5, grime=0.6, wear=0.0, scratch=0.05, seed=5.0, film=0.1,
                          up_lo=0.1)
    g.finish(col, rough, h, bump_dist=0.0008)
    W2, H2 = cw / 2, chh / 2
    can = L.grid('canvas', 2, 2, lambda u, v: (-W2 + 2 * W2 * u, -H2 + 2 * H2 * v, 0.0), M=M @ xf((0, 0, 0.012)))
    P.add(can, mat, flat=True, uv='src', weight=3.5)
    wire_and_nail(P, H, 0.16, M)
    P.finish(previews=dict(yaw=15, pitch=5))
