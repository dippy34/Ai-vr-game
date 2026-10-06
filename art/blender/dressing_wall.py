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
    if ornament == 'shell':
        # scallop shell: radial ribs fanning from the hinge (gc = local coords, hinge at origin)
        ang = g.m('ARCTAN2', d, Lc)
        rad = g.m('SQRT', g.add(g.mul(Lc, Lc), g.mul(d, d)))
        ribs = g.mul(g.add(g.sin(g.mul(ang, 22.0)), 1.0), 0.5)
        carve = g.add(g.mul(ribs, g.rng(rad, 0.004, 0.012)), g.mul(g.rng(rad, 0.03, 0.036), 0.0))
    # damage: chipped gesso chunks exposing dark wood
    ch = g.noise(p, 9.0, 4, 0.65, offset=(seed, 1.0, 2.0))
    chip = g.rng(g.add(ch, g.mul(g.convex(), 0.3)), 0.70, 0.72, smooth=False)
    gold = hexc('a07a34')
    tarn = hexc('5a4624')
    tn = g.noise(p, 6.0, 3, 0.6, offset=(seed, 4.0, 0))
    col = g.mix(g.rng(tn, 0.35, 0.7), gold, tarn)
    rough = g.mixf(g.rng(tn, 0.35, 0.7), 0.32, 0.55)
    metal = g.add(0.65, 0.0)  # no env map in game: keep a diffuse share so the gilt reads
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
    return g.finish(col, rough, h, metal=metal, bump_dist=0.0028)


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
    P = L.Piece('frame_portrait', 'wall', tex=512, glass_tex=512, max_tris=1500, ao=0.05, bevel=0.003,
                ao_small=0.006)
    rx, ry = 0.205, 0.255
    N = 40
    path = L.ellipse_pts(rx, ry, N)
    # profile (d = inward from the outer edge, h = height off the wall), outer back -> sight edge
    prof = [(0.0, 0.0), (0.0, 0.020), (0.003, 0.028), (0.009, 0.033), (0.015, 0.031), (0.019, 0.026),
            (0.025, 0.027), (0.031, 0.035), (0.038, 0.039), (0.045, 0.036), (0.049, 0.030), (0.054, 0.027),
            (0.059, 0.020), (0.0595, 0.010)]
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
    glass = L.mat_glass('portrait_glass', tint=hexc('202420'), alpha=0.1, dust=0.6, grime=0.5, cracks=gimg)
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
    P.add(frame, mat_gilt('landscape_gilt', ornament='rect', seed=3.0, bole=0.35), smooth=40, weight=1.0)
    # corner cartouches (raised shells) on the four corners
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
    cr = g.vor(g.vmul(uv, (1.0, 0.69, 1.0)), 34.0, 'DISTANCE_TO_EDGE')
    crack = g.mul(g.rng(cr, 0.018, 0.0), g.rng(g.noise(uv, 3.0, 2, 0.5), 0.35, 0.6))
    col = g.mix(g.mul(crack, 0.45), c, hexc('15100a'))
    brush = g.noise(g.vmul(uv, (1.0, 5.0, 1.0)), 28.0, 3, 0.5)
    h = g.add(g.mul(brush, 0.25), g.mul(crack, -0.3))
    h = g.add(h, g.mul(sl, 1.2))
    rough = g.add(g.mixf(crack, 0.55, 0.75), g.mul(g.inv(sl), 0.35))
    col, rough, h = L.age(g, col, rough, h, dust=0.5, grime=0.6, wear=0.0, scratch=0.05, seed=5.0, film=0.1,
                          up_lo=0.1)
    g.finish(col, rough, h, bump_dist=0.0008)
    W2, H2 = cw / 2, chh / 2
    can = L.grid('canvas', 2, 2, lambda u, v: (-W2 + 2 * W2 * u, -H2 + 2 * H2 * v, 0.0), M=M @ xf((0, 0, 0.012)))
    P.add(can, mat, flat=True, uv='src', weight=3.5)
    wire_and_nail(P, H, 0.16, M)
    P.finish(previews=dict(yaw=15, pitch=5))


# =============================================================================================
# Pendulum regulator wall clock: stopped, glass door ajar
# =============================================================================================

def mat_clock_glass(name, letters):
    """Dusty door glass with gold-leaf REGULATOR lettering (letters: image in src UV, R = mask)."""
    mat = L.new_material(name)
    g = G(mat)
    mat['glass'] = 1
    p = g.pos()
    lm = g.sep(g.img(letters)[0])[0]
    dn = g.noise(p, 5.0, 3, 0.6, offset=(2.0, 3.0, 0))
    smear = g.noise(p, 2.0, 4, 0.7, stretch=(1.0, 3.0, 1.0))
    d = g.clamp(g.add(g.mul(g.rng(smear, 0.4, 0.75), 0.35), g.mul(g.rng(dn, 0.5, 0.8), 0.2)))
    # a wiped streak where someone's hand dragged across the glass
    x, y, z = g.sep(p)
    streak = g.mul(g.rng(g.absf(g.sub(z, g.add(0.42, g.mul(x, 0.6)))), 0.03, 0.0), g.rng(x, -0.1, 0.05))
    d = g.mul(d, g.inv(g.mul(streak, 0.8)))
    col = g.mix(d, hexc('1c201c'), L.DUST)
    gold = g.mix(g.noise(p, 40.0, 2, 0.5), hexc('b8924a'), hexc('8a6a32'))
    col = g.mix(lm, col, gold)
    a = g.clamp(g.add(g.add(0.08, g.mul(d, 0.55)), lm))
    r = g.mixf(d, 0.05, 0.8)
    r = g.mixf(lm, r, 0.4)
    return g.finish(col, r, None, alpha=a, metal=g.mul(lm, 0.3))


def hand_outline(length, width, tail, kind):
    """Flat clock hand outline (y along the hand). kind 'hour' = spade tip, 'minute' = slim pointer."""
    w = width / 2
    if kind == 'hour':
        return [(0, -tail), (w * 0.8, -tail * 0.6), (w * 0.5, 0), (w * 0.35, length * 0.62), (w * 1.6, length * 0.72),
                (w * 0.9, length * 0.86), (0, length), (-w * 0.9, length * 0.86), (-w * 1.6, length * 0.72),
                (-w * 0.35, length * 0.62), (-w * 0.5, 0), (-w * 0.8, -tail * 0.6)]
    return [(0, -tail), (w * 0.8, -tail * 0.7), (w * 0.45, 0), (w * 0.25, length * 0.85), (w * 0.7, length * 0.88),
            (0, length), (-w * 0.7, length * 0.88), (-w * 0.25, length * 0.85), (-w * 0.45, 0), (-w * 0.8, -tail * 0.7)]


def build_clock():
    P = L.Piece('clock', 'wall', tex=512, glass_tex=512, max_tris=1500, ao=0.08, bevel=0.003, ao_small=0.01)
    M = WALL @ xf((0, 0, 0)) @ Matrix.Rotation(math.radians(1.2), 4, 'Z')
    wood = L.mat_wood('clock_wood', hexc('4a2c18'), hexc('1e1008'), gloss=0.3, ring=0.005, figure=0.7, dust=0.9,
                      grime=0.9, wear=0.6, scratch=0.4, fade=0.15, seed=6.0, peel=0.2, peel_col=hexc('6e5034'),
                      film=0.08)
    dark = L.mat_plain('clock_inside', hexc('22180f'), 0.85, dust=0.4, grime=0.9, noise_amt=0.3, seed=1.0, wear=0.1)
    brass = L.mat_metal('clock_brass', hexc('a8843e'), rough=0.36, tarnish=0.65, tarnish_col=hexc('3e3216'),
                        dust=0.5, seed=2.0, wear=0.6)
    steel = L.mat_metal('clock_hands', hexc('1a1816'), rough=0.45, tarnish=0.3, rust=0.25, dust=0.2, seed=3.0)
    W, H, D = 0.30, 0.70, 0.11
    # back board + inner back panel
    P.add(L.box('back', (W - 0.01, H - 0.02, 0.012), M @ xf((0, 0, 0.006)), bevel=0.0), dark, weight=0.5)
    # sides, with a small cove at the front
    for sx in (-1, 1):
        P.add(L.box(f'side_{sx}', (0.018, H - 0.06, D), M @ xf((sx * (W / 2 - 0.009), 0, D / 2)), bevel=0.003), wood)
    # crown: cornice + arched pediment + three turned finials
    P.add(L.box('cornice_a', (W + 0.04, 0.022, D + 0.025), M @ xf((0, H / 2 - 0.03, (D + 0.025) / 2)), bevel=0.004), wood)
    P.add(L.box('cornice_b', (W + 0.06, 0.014, D + 0.035), M @ xf((0, H / 2 - 0.012, (D + 0.035) / 2)), bevel=0.003), wood)
    arch = [(-0.15, 0.0), (0.15, 0.0)] + [(0.15 * math.cos(math.radians(a)), 0.075 * math.sin(math.radians(a)))
                                          for a in range(15, 166, 15)]
    o = L.prism('pediment', arch, 0.018, bevel=0.003)
    L.place(o, M @ xf((0, H / 2 - 0.005, D - 0.01), (0, 0, 0)))
    P.add(o, wood, weight=0.8)
    fin = [(0, 0), (0.012, 0), (0.014, 0.008), (0.008, 0.016), (0.011, 0.028), (0.006, 0.04), (0.002, 0.05), (0, 0.052)]
    for fx, fh in ((-0.16, 0.0), (0.16, 0.0), (0.0, 0.07)):
        o = L.lathe(f'finial_{fx}', fin, segs=7, M=M @ xf((fx, H / 2 - 0.005 + fh, D - 0.01), (-90, 0, 0)))
        P.add(o, wood, smooth=50, weight=0.5)
    # base + drop finial
    P.add(L.box('base_a', (W + 0.03, 0.02, D + 0.02), M @ xf((0, -H / 2 + 0.03, (D + 0.02) / 2)), bevel=0.004), wood)
    P.add(L.box('base_b', (W + 0.01, 0.014, D + 0.01), M @ xf((0, -H / 2 + 0.013, (D + 0.01) / 2)), bevel=0.003), wood)
    drop = [(0, 0), (0.012, 0.004), (0.016, 0.02), (0.01, 0.034), (0.013, 0.045), (0.018, 0.05), (0.0, 0.052)]
    o = L.lathe('drop', drop, segs=8, M=M @ xf((0, -H / 2 + 0.006, D / 2), (90, 0, 0)))
    P.add(o, wood, smooth=50, weight=0.5)
    # dial board + dial + brass bezel
    dial_y = H / 2 - 0.175
    P.add(L.box('dial_board', (W - 0.04, 0.26, 0.012), M @ xf((0, dial_y, 0.07)), bevel=0.0), dark, weight=0.5)
    dimg = L.np_image('clock_dial', I.clock_dial(512))
    R = 0.108
    pts = L.ellipse_pts(R, R, 32)
    o = L.mesh('dial', [(x_, y_, 0.0) for x_, y_ in pts], [list(range(len(pts)))], M=M @ xf((0, dial_y, 0.078)),
               uvs=[((x_ + R) / (2 * R), (y_ + R) / (2 * R)) for x_, y_ in pts])
    P.add(o, L.mat_image('clock_dial', dimg, rough=0.5, dust=0.3, grime=0.6, seed=4.0), flat=True, uv='src', weight=3.2)
    bez = [(R - 0.002, 0.0), (R + 0.006, 0.006), (R + 0.003, 0.013), (R - 0.004, 0.011)]
    P.add(L.lathe('bezel', [(r, z) for r, z in bez], segs=24, M=M @ xf((0, dial_y, 0.075)), cap_top=False,
                  cap_bot=False), brass, smooth=40)
    # hands, stopped at 4:47 (hour hand just short of the V)
    for kind, length, width, ang, z in (('hour', 0.062, 0.008, (4 + 47 / 60) / 12 * 360, 0.0805),
                                        ('minute', 0.09, 0.006, 47 / 60 * 360, 0.082)):
        o = L.prism(f'hand_{kind}', hand_outline(length, width, 0.016, kind), 0.0012)
        L.place(o, M @ xf((0, dial_y, z), (0, 0, -ang)))
        P.add(o, steel, flat=True, weight=0.6)
    P.add(L.lathe('arbor', [(0, 0), (0.004, 0), (0.004, 0.006), (0.0025, 0.009), (0, 0.009)], segs=8,
                  M=M @ xf((0, dial_y, 0.078))), brass, smooth=40)
    # pendulum: flat rod + lens bob, hanging still
    rod_top, bob_y = dial_y - 0.07, -H / 2 + 0.16
    P.add(L.box('rod', (0.008, rod_top - bob_y, 0.002), M @ xf((0.002, (rod_top + bob_y) / 2, 0.05)), bevel=0.0005), brass,
          weight=0.6)
    lens = [(0.0, -0.006), (0.032, -0.0035), (0.043, 0.0), (0.032, 0.0035), (0.0, 0.006)]
    o = L.lathe('bob', lens, segs=14, M=M @ xf((0.002, bob_y, 0.05)))
    P.add(o, brass, smooth=50, weight=1.2)
    # door (frame + glass), hinged on the left, standing ajar ~24 degrees
    dw, dh, fw, ft = W - 0.012, H - 0.075, 0.024, 0.016
    hinge = Matrix.Translation((-dw / 2, 0, D + ft / 2)) @ Matrix.Rotation(math.radians(-36), 4, 'Y') \
        @ Matrix.Translation((dw / 2, 0, -(D + ft / 2)))
    DM = M @ hinge
    for nm, sz, loc in (('door_l', (fw, dh, ft), (-dw / 2 + fw / 2, 0, D + ft / 2)),
                        ('door_r', (fw, dh, ft), (dw / 2 - fw / 2, 0, D + ft / 2)),
                        ('door_t', (dw - 2 * fw, fw, ft), (0, dh / 2 - fw / 2, D + ft / 2)),
                        ('door_b', (dw - 2 * fw, fw, ft), (0, -dh / 2 + fw / 2, D + ft / 2)),
                        ('door_m', (dw - 2 * fw, fw * 0.8, ft * 0.8), (0, dial_y - 0.135, D + ft / 2))):
        P.add(L.box(nm, sz, DM @ xf(loc), bevel=0.003), wood, weight=0.8)
    # tiny brass knob + keyhole escutcheon on the free edge
    P.add(L.lathe('knob', [(0, 0), (0.006, 0), (0.007, 0.006), (0.004, 0.012), (0, 0.013)], segs=8,
                  M=DM @ xf((dw / 2 - fw / 2, -0.02, D + ft))), brass, smooth=40)
    letters = L.np_image('clock_regulator', I.regulator_glass(256, 256), non_color=True)
    gm = mat_clock_glass('clock_glass', letters)
    gx0, gx1 = -dw / 2 + fw * 0.6, dw / 2 - fw * 0.6
    # upper pane (dial window) and lower pane (pendulum window, gold lettering near its bottom)
    up0, up1 = dial_y - 0.135, dh / 2 - fw * 0.6
    lo0, lo1 = -dh / 2 + fw * 0.6, dial_y - 0.135
    gz = D + ft * 0.4
    pane = L.grid('pane_up', 1, 1, lambda u, v: (gx0 + (gx1 - gx0) * u, up0 + (up1 - up0) * v, gz), M=DM)
    for d_ in pane.data.uv_layers['src'].data:
        d_.uv = (d_.uv[0], 0.5 + d_.uv[1] * 0.5)  # upper half of the glass texture: no letters
    P.add(pane, gm, flat=True, uv='src')
    pane = L.grid('pane_lo', 1, 1, lambda u, v: (gx0 + (gx1 - gx0) * u, lo0 + (lo1 - lo0) * v, gz), M=DM)
    for d_ in pane.data.uv_layers['src'].data:
        d_.uv = (d_.uv[0], d_.uv[1] * 0.5)
    P.add(pane, gm, flat=True, uv='src')
    P.finish(previews=dict(yaw=28, pitch=6, extra=[dict(tag='front', yaw=0, pitch=0, zoom=1.0)]))
