"""
Set dressing, small pieces: messy book pile, dusty bottles, melted candles, broken plate + fork,
bare hanging bulb with a broken shade, scattered papers.
Helper module: build() is a no-op; dressing.py calls build_<name>().
"""

from __future__ import annotations

import math
import random

import bpy  # noqa: I001
import bmesh
import numpy as np
from mathutils import Matrix, Vector

import dressing_img as I
import dressing_lib as L
from dressing_lib import G, hexc, xf


def build() -> None:
    print('dressing_small: helper module (built through dressing.py)')


def text_block(g, uv, *, lines=34.0, margin=0.1, ink=hexc('2a241c'), col=None, seed=0.0, cols=1):
    """Printed text as a shader (src UV): ruled lines broken into words, inside page margins."""
    u, v, _ = g.sep(uv)
    ln = g.fract(g.mul(v, lines))
    line = g.mul(g.rng(ln, 0.2, 0.3), g.rng(ln, 0.75, 0.65))
    word = g.noise(g.vmul(uv, (1.0, lines, 1.0)), 9.0, 1, 0.5, stretch=(4.0, 1.0, 1.0), offset=(seed, 0, 0))
    words = g.rng(word, 0.36, 0.42)
    inside = g.mul(g.mul(g.rng(u, margin, margin + 0.01), g.rng(u, 1 - margin, 1 - margin - 0.01)),
                   g.mul(g.rng(v, margin, margin + 0.01), g.rng(v, 1 - margin * 1.2, 1 - margin * 1.2 - 0.01)))
    if cols > 1:
        gut = g.absf(g.sub(g.fract(g.mul(u, cols)), 0.5))
        inside = g.mul(inside, g.rng(gut, 0.47, 0.44))
    t = g.mul(g.mul(line, words), inside)
    return g.mix(g.mul(t, 0.85), col, ink)


def mat_paper(name, base=hexc('cfc2a2'), *, image=None, text=False, seed=0.0, dust=0.5, stains=0.6, edge=0.6,
              lines=34.0, cols=1, rough=0.85):
    mat = L.new_material(name)
    g = G(mat)
    uv = g.uv('src')
    u, v, _ = g.sep(uv)
    p = g.pos()
    if image is not None:
        col, _ = g.img(image)
    else:
        col = g.mix(g.rng(g.noise(p, 20.0, 3, 0.5), 0.3, 0.7), base, g.hsv(base, v=0.88))
        if text:
            col = text_block(g, uv, lines=lines, seed=seed, col=col, cols=cols)
    # yellowed, browned edges, foxing, tide marks
    de = g.mn(g.mn(u, g.sub(1.0, u)), g.mn(v, g.sub(1.0, v)))
    col = g.mix(g.mul(g.rng(de, 0.06, 0.0), edge), col, hexc('8a6a3c'))
    fox = g.noise(p, 90.0, 2, 0.5, offset=(seed, 0, 0))
    col = g.mix(g.mul(g.rng(fox, 0.68, 0.74), 0.6), col, hexc('7a5530'))
    h = g.mul(g.noise(p, 120.0, 2, 0.5), 0.2)
    col, r, h = L.age(g, col, rough, h, dust=dust, grime=0.8, wear=0.0, scratch=0.0, stains=stains,
                      stain_col=hexc('8a6a40'), seed=seed, film=0.06, up_lo=0.3)
    return g.finish(col, r, h, bump_dist=0.0004)


# =============================================================================================
# Books
# =============================================================================================

def book(P, name, w, hgt, t, M, cover_mat, page_mat, title_mat=None):
    """Closed hardback: two cover boards, an inset page block and a rounded spine.
    Local: x = width (spine at -w/2), y = height, z = thickness (0..t)."""
    ct = 0.0028
    P.add(L.box(f'{name}_cb', (w, hgt, ct), M @ xf((0, 0, ct / 2)), bevel=0.0012), cover_mat, weight=0.9)
    P.add(L.box(f'{name}_ct', (w, hgt, ct), M @ xf((0, 0, t - ct / 2)), bevel=0.0012), cover_mat, weight=0.9)
    pb = L.box(f'{name}_pg', (w - 0.006, hgt - 0.007, t - 2 * ct + 0.0006), M @ xf((0.002, 0, t / 2)), bevel=0.0)
    P.add(pb, page_mat, weight=0.8, flat=True)
    r = t / 2
    prof = [(math.cos(math.radians(a)), math.sin(math.radians(a))) for a in range(180, 361, 45)]
    path = [M @ Vector((-w / 2 + r * 0.3, -hgt / 2, r)), M @ Vector((-w / 2 + r * 0.3, hgt / 2, r))]
    sp = L.tube(f'{name}_sp', path, r * 0.98, profile=[(px, py * 0.55) for px, py in prof], caps=True,
                up_hint=tuple((M.to_3x3() @ Vector((0, 0, 1)))))
    P.add(sp, cover_mat, smooth=50, weight=0.9)


def mat_cloth_cover(name, color, seed):
    def bands(g, p, col):
        # faded gilt bands near the spine ends (gc = local coords of each part; y = height)
        return col
    m = L.mat_fabric(name, color, L.srgb(*[c * 0.85 for c in (0.5, 0.5, 0.5)]) if False else None, weave=900.0,
                     fade=0.45, stains=0.7, dust=0.8, grime=0.9, seed=seed, rough=0.82)
    return m


def build_books_pile():
    P = L.Piece('books_pile', 'surface', tex=512, max_tris=1500, ao=0.05, bevel=0.002, ao_small=0.006, seed=51)
    pages = L.new_material('book_pages')
    g = G(pages)
    p = g.pos()
    gc = g.gc()
    # page edges: fine stripes across the thickness (gc z = thickness axis after placement)
    st = g.wave(gc, 700.0, 'BANDS', 'Z', dist=2.0)
    col = g.mix(g.mul(st, 0.25), hexc('c8b890'), hexc('9a8660'))
    water = g.noise(p, 12.0, 3, 0.6)
    col = g.mix(g.mul(g.rng(water, 0.55, 0.7), 0.5), col, hexc('8a6a40'))
    h = g.mul(st, 0.6)
    col, r, h = L.age(g, col, 0.9, h, dust=0.8, grime=1.0, wear=0.0, scratch=0.0, stains=0.6, seed=2.0, film=0.1)
    g.finish(col, r, h, bump_dist=0.0004)
    colors = ['5a2a24', '3e4a34', '2c3448', '5a4630', '4a4a44', '6a3a20']
    covers = [L.mat_fabric(f'book_cloth_{i}', hexc(c), None, weave=900.0, fade=0.2, stains=0.7, dust=0.22,
                           grime=0.9, seed=10.0 + i, rough=0.82) for i, c in enumerate(colors)]
    # stack: (w, h, t, yaw, tilt_x, tilt_y, dx, dy, cover)
    specs = [(0.19, 0.27, 0.045, 8, 0, 0, 0.0, 0.0, 3), (0.16, 0.235, 0.055, -14, 0, 0, 0.012, -0.01, 0),
             (0.15, 0.22, 0.03, 27, 0, 0, -0.01, 0.015, 1), (0.17, 0.24, 0.035, -6, 0, 0, 0.02, 0.0, 4),
             (0.13, 0.19, 0.025, 48, 0, 0, -0.02, -0.02, 5)]
    z = 0.0
    rnd = random.Random(4)
    for i, (w, hh, t, yaw, tx, ty, dx, dy, ci) in enumerate(specs):
        M = xf((dx, dy, z), (rnd.uniform(-1.5, 1.5), rnd.uniform(-1.5, 1.5), yaw))
        book(P, f'b{i}', w, hh, t, M, covers[ci], pages)
        z += t + 0.0005
    # one fallen off the pile, leaning against it
    # standing on its tail, leaning against the stack
    book(P, 'lean', 0.15, 0.22, 0.032, Matrix.Translation((0.205, 0.035, 0.0)) @ Matrix.Rotation(math.radians(8), 4, 'Z')
         @ Matrix.Rotation(math.radians(-24), 4, 'Y') @ Matrix.Rotation(math.radians(90), 4, 'X')
         @ Matrix.Translation((0, 0.11, 0)), covers[2], pages)
    # an open book face-up on top, pages swollen and fanned
    top = z
    ow, oh = 0.145, 0.21
    yawo = math.radians(-22)
    Mo = Matrix.Translation((-0.01, 0.0, top)) @ Matrix.Rotation(yawo, 4, 'Z')
    cov = covers[0]
    for sx in (-1, 1):
        ang = math.radians(6) * sx
        Mc = Mo @ Matrix.Rotation(-ang, 4, 'Y') @ xf((sx * ow / 2, 0, 0.0014))
        P.add(L.box(f'open_cover_{sx}', (ow, oh, 0.0028), Mc, bevel=0.0012), cov, weight=0.8)
    page_img = None
    ptext = mat_paper('open_pages', hexc('cdbf9c'), text=True, seed=3.0, dust=0.7, stains=0.8, lines=30.0)
    for sx in (-1, 1):
        for k, (lift, curl) in enumerate(((0.012, 0.0), (0.016, 0.25))):
            if k == 1 and sx < 0:
                continue

            def fn(u, v, sx=sx, lift=lift, curl=curl):
                x = u * ow * 0.97
                # pages bulge up from the gutter, then flatten; the loose top page lifts at its edge
                zz = lift * math.sin(min(1.0, u * 1.6) * math.pi / 2) * (1 - 0.35 * u) + curl * 0.06 * u ** 3
                return (sx * (x + 0.002), (v - 0.5) * (oh - 0.008), zz + 0.003)
            o = L.grid(f'open_page_{sx}_{k}', 6, 1, fn, M=Mo)
            if sx < 0:
                bm = bmesh.new()
                bm.from_mesh(o.data)
                bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
                bm.to_mesh(o.data)
                bm.free()
            P.add(o, ptext, smooth=40, weight=1.4 if k == 0 else 0.9)
        # page block under the open pages (thickness of the half book)
        blk = L.box(f'open_block_{sx}', (ow * 0.96, oh - 0.01, 0.011), Mo @ xf((sx * ow * 0.49, 0, 0.0085)), bevel=0.0)
        P.add(blk, pages, flat=True, weight=0.5)
    P.finish(previews=dict(yaw=35, pitch=30))


# =============================================================================================
# Bottles
# =============================================================================================

def build_bottles():
    P = L.Piece('bottles', 'surface', tex=512, glass_tex=512, max_tris=1500, ao=0.05, bevel=0.002, ao_small=0.006,
                seed=61)
    green = L.mat_glass('glass_green', film=0.4, tint=hexc('1a3020'), alpha=0.5, dust=1.0, grime=0.8, seed=1.0, rough=0.08)
    amber = L.mat_glass('glass_amber', film=0.4, tint=hexc('3a200c'), alpha=0.6, dust=1.0, grime=0.8, seed=2.0)
    clear = L.mat_glass('glass_clear', film=0.4, tint=hexc('6a786e'), alpha=0.24, dust=1.0, grime=0.8, seed=3.0)
    aqua = L.mat_glass('glass_aqua', film=0.4, tint=hexc('4a6a66'), alpha=0.3, dust=1.0, grime=0.7, seed=4.0)
    tin = L.mat_metal('lid_tin', hexc('8a8478'), rough=0.5, tarnish=0.5, rust=0.85, dust=0.6, seed=5.0)
    label = mat_paper('label_wine', image=L.np_image('wine_label', I.wine_label()), seed=6.0, dust=0.5, stains=0.5,
                      edge=0.4)
    label_med = mat_paper('label_med', image=L.np_image('med_label', I.med_label()), seed=7.0, dust=0.5, stains=0.5,
                          edge=0.4)
    residue = L.mat_plain('residue', hexc('2a1810'), 0.35, dust=0.0, grime=0.5, noise_amt=0.4, wear=0.0, scratch=0.0,
                          seed=7.0)
    cork = L.mat_plain('cork', hexc('6a4c30'), 0.9, dust=0.6, grime=0.9, noise_amt=0.5, wear=0.2, seed=8.0)

    # 1) tall wine bottle, standing, cork pushed half out, label peeling
    wine = [(0.0, 0.0), (0.034, 0.0), (0.0375, 0.006), (0.0375, 0.19), (0.035, 0.215), (0.022, 0.25), (0.0145, 0.27),
            (0.0135, 0.3), (0.0155, 0.305), (0.0145, 0.315)]
    P.add(L.lathe('wine', wine, segs=16, M=xf((-0.05, 0.02, 0)), cap_top=False), green, smooth=40, weight=1.2)
    P.add(L.lathe('cork', [(0.0, 0.0), (0.0118, 0.0), (0.0122, 0.03), (0.0, 0.031)], segs=8, M=xf((-0.05, 0.02, 0.298), (4, 0, 0))),
          cork, smooth=40, weight=0.4)
    lab = L.lathe('wine_label', [(0.0381, 0.07), (0.0381, 0.16)], segs=12, arc=250, start=-60, cap_top=False,
                  cap_bot=False, M=xf((-0.05, 0.02, 0)))
    for lp_ in lab.data.vertices:
        pass
    uvl = lab.data.uv_layers.new(name='src')
    for poly in lab.data.polygons:
        for li in poly.loop_indices:
            co = lab.data.vertices[lab.data.loops[li].vertex_index].co
            a = math.atan2(co.y - 0.02, co.x + 0.05)
            uvl.data[li].uv = (((math.degrees(a) + 60) % 360) / 250, (co.z - 0.07) / 0.09)
    # peeled corner
    for vtx in lab.data.vertices:
        a = math.degrees(math.atan2(vtx.co.y - 0.02, vtx.co.x + 0.05))
        if -62 < a < -40 and vtx.co.z > 0.14:
            vtx.co.x += 0.008
    P.add(lab, label, smooth=40, uv='src', weight=0.9)
    P.add(L.lathe('wine_dregs', [(0.0, 0.004), (0.033, 0.004), (0.034, 0.012), (0.0, 0.009)], segs=12,
                  M=xf((-0.05, 0.02, 0))), residue, smooth=40, weight=0.3)
    # 2) brown medicine bottle with a rusted screw cap
    med = [(0.0, 0.0), (0.024, 0.0), (0.026, 0.004), (0.026, 0.078), (0.022, 0.092), (0.012, 0.1), (0.011, 0.112)]
    P.add(L.lathe('med', med, segs=12, M=xf((0.045, -0.035, 0)), cap_top=False), amber, smooth=40)
    P.add(L.lathe('med_cap', [(0.0, 0.0), (0.0135, 0.0), (0.0135, 0.016), (0.011, 0.018), (0.0, 0.018)], segs=10,
                  M=xf((0.045, -0.035, 0.105))), tin, smooth=40, weight=0.4)
    ml = L.lathe('med_label', [(0.0262, 0.02), (0.0262, 0.065)], segs=8, arc=150, start=60, cap_top=False, cap_bot=False,
                 M=xf((0.045, -0.035, 0)))
    uvl = ml.data.uv_layers.new(name='src')
    for poly in ml.data.polygons:
        for li in poly.loop_indices:
            co = ml.data.vertices[ml.data.loops[li].vertex_index].co
            a = math.degrees(math.atan2(co.y + 0.035, co.x - 0.045))
            uvl.data[li].uv = (((a - 60) % 360) / 150, (co.z - 0.02) / 0.045)
    P.add(ml, label_med, smooth=40, uv='src', weight=0.7)
    # 3) mason jar, murky dried residue, rusted lid
    jar = [(0.0, 0.0), (0.036, 0.0), (0.04, 0.008), (0.04, 0.11), (0.036, 0.125), (0.032, 0.13), (0.033, 0.142)]
    P.add(L.lathe('jar', jar, segs=16, M=xf((0.06, 0.06, 0)), cap_top=False), clear, smooth=40, weight=1.0)
    P.add(L.lathe('jar_lid', [(0.0, 0.0), (0.035, 0.0), (0.0355, 0.012), (0.033, 0.014), (0.0, 0.0145)], segs=16,
                  M=xf((0.06, 0.06, 0.134), (3, -2, 0))), tin, smooth=40, weight=0.6)
    P.add(L.lathe('jar_gunk', [(0.0, 0.003), (0.037, 0.003), (0.0385, 0.018), (0.034, 0.015), (0.0, 0.012)], segs=14,
                  M=xf((0.06, 0.06, 0)), jitter=0.05), residue, smooth=40, weight=0.4)
    # 4) a clear-aqua soda bottle tipped over on its side
    soda = [(0.0, 0.0), (0.027, 0.0), (0.03, 0.006), (0.03, 0.12), (0.024, 0.15), (0.0125, 0.18), (0.012, 0.205),
            (0.0145, 0.21), (0.013, 0.214)]
    so = L.lathe('soda', soda, segs=12, cap_top=False)
    L.place(so, Matrix.Translation((-0.02, -0.075, 0.03)) @ Matrix.Rotation(math.radians(-62), 4, 'Z')
            @ Matrix.Rotation(math.radians(90), 4, 'Y') @ Matrix.Rotation(math.radians(8), 4, 'X'), 'z')
    P.add(so, aqua, smooth=40, weight=1.0)
    P.finish(previews=dict(yaw=30, pitch=22, extra=[dict(tag='flash_low', yaw=-10, pitch=8, mood='flash')]))


# =============================================================================================
# Candles
# =============================================================================================

def seg_dist(g, p, a, b):
    """Shader: distance from p to segment a-b, and the parameter t along it."""
    ab = Vector(b) - Vector(a)
    ap = g.v('SUBTRACT', p, tuple(a))
    t = g.clamp(g.mul(g.v('DOT_PRODUCT', ap, tuple(ab)), 1.0 / max(ab.length_squared, 1e-9)))
    q = g.vadd(g.vmul(g.comb(t, t, t), tuple(ab)), tuple(a))
    return g.v('DISTANCE', p, q), t


def mat_wax(name, base, dark, seed, drips=()):
    """Old candle wax. drips: [(top, bottom, width)] world-space segments on the candle surface; they
    are baked into the normal map as raised, glossier runs ending in a bead."""
    mat = L.new_material(name)
    g = G(mat)
    p = g.pos()
    x, y, z = g.sep(p)
    col = g.mix(g.rng(g.noise(p, 30.0, 3, 0.5, offset=(seed, 0, 0)), 0.3, 0.7), base, dark)
    dh = None
    wob = g.mul(g.sub(g.noise(p, 300.0, 2, 0.5), 0.5), 0.0012)
    for (a, b, w) in drips:
        d, t = seg_dist(g, p, a, b)
        wid = g.add(g.mul(t, w * 0.6), w * 0.7)
        run = g.rng(g.add(d, wob), wid, g.mul(wid, 0.2))
        bead = g.rng(g.v('DISTANCE', p, tuple(b)), w * 1.5, w * 0.3)
        r_ = g.mx(run, bead)
        dh = r_ if dh is None else g.mx(dh, r_)
    # soot darkening around the burnt tops
    soot = g.mul(g.rng(z, 0.035, 0.075), g.rng(g.noise(p, 25.0, 3, 0.6), 0.3, 0.7))
    col = g.mix(g.mul(soot, 0.5), col, hexc('2a241c'))
    h = g.mul(g.noise(p, 160.0, 3, 0.6), 0.4)
    rough = g.add(0.45, 0.0)
    if dh is not None:
        col = g.mix(g.mul(dh, 0.6), col, g.hsv(base, s=0.9, v=1.12))
        h = g.add(h, g.mul(dh, 3.0))
        rough = g.mixf(dh, rough, 0.28)
    col, rough, h = L.age(g, col, rough, h, dust=0.75, grime=0.45, wear=0.0, scratch=0.2, stains=0.4, seed=seed,
                          film=0.12, dust_scale=2.0)
    return g.finish(col, rough, h, bump_dist=0.0008)


def build_candles():
    P = L.Piece('candles', 'surface', tex=512, max_tris=1500, ao=0.02, bevel=0.0015, ao_small=0.004, seed=71)
    china = L.new_material('saucer_china')
    g = G(china)
    p = g.pos()
    x, y, z = g.sep(p)
    r = g.m('SQRT', g.add(g.mul(x, x), g.mul(y, y)))
    band = g.mul(g.rng(r, 0.058, 0.06), g.rng(r, 0.066, 0.064))
    col = g.mix(band, hexc('bfb7a2'), hexc('6a5a30'))  # worn gilt line on the rim
    tea = g.mul(g.rng(r, 0.028, 0.032), g.rng(r, 0.046, 0.04))
    col = g.mix(g.mul(tea, g.rng(g.noise(p, 18.0, 3, 0.6), 0.3, 0.6, 0.2, 0.7)), col, hexc('6a4a2a'))
    craze = g.vor(p, 90.0, 'DISTANCE_TO_EDGE')
    col = g.mix(g.mul(g.rng(craze, 0.025, 0.0), 0.5), col, hexc('6a5a40'))
    chip = g.rng(g.add(g.noise(p, 40.0, 3, 0.6), g.mul(g.convex(), 0.4)), 0.78, 0.8, smooth=False)
    col = g.mix(chip, col, hexc('a89e88'))
    col, rough, h = L.age(g, col, g.mixf(chip, 0.2, 0.8), g.mul(chip, -0.5), dust=0.9, grime=1.0, wear=0.0,
                          scratch=0.4, stains=0.8, stain_col=hexc('6a5030'), seed=1.0, film=0.15, dust_scale=2.0)
    g.finish(col, rough, h, soft=0.0015)
    specs = ((-0.012, 0.006, 0.0115, 0.058, 2, 'ivory'), (0.019, -0.006, 0.01, 0.034, -3, 'red'),
             (0.004, 0.024, 0.0095, 0.021, 5, 'ivory'))
    rnd = random.Random(7)
    drips = {'ivory': [], 'red': []}
    for (cx, cy, cr, ch, lean, wk) in specs:
        Ml = xf((cx, cy, 0.009), (lean, 0, 0))
        for d in range(4 if ch > 0.04 else 3):
            a = rnd.uniform(0, 2 * math.pi)
            z0 = ch - rnd.uniform(0.002, 0.006)
            z1 = rnd.uniform(0.004, z0 * 0.6)
            top = Ml @ Vector((math.cos(a) * cr, math.sin(a) * cr, z0))
            bot = Ml @ Vector((math.cos(a + 0.1) * cr, math.sin(a + 0.1) * cr, z1))
            drips[wk].append((top, bot, rnd.uniform(0.0018, 0.0026)))
    ivory = mat_wax('wax_ivory', hexc('c8b890'), hexc('a8946a'), 2.0, drips['ivory'])
    red = mat_wax('wax_red', hexc('6a2420'), hexc('4a1814'), 3.0, drips['red'])
    wick = L.mat_plain('wick', hexc('0e0c0a'), 0.9, dust=0.2, grime=0.3, wear=0.0, scratch=0.0, seed=3.0)
    sau = [(0.0, 0.0), (0.03, 0.0), (0.032, 0.004), (0.045, 0.006), (0.062, 0.013), (0.068, 0.017), (0.066, 0.019),
           (0.06, 0.016), (0.044, 0.01), (0.0, 0.009)]
    so = L.lathe('saucer', sau, segs=24, cap_top=True, cap_bot=True)
    for v in so.data.vertices:  # a chunk missing from the rim
        a = math.degrees(math.atan2(v.co.y, v.co.x))
        if 20 < a < 44 and math.hypot(v.co.x, v.co.y) > 0.058:
            v.co.x *= 0.88
            v.co.y *= 0.88
    P.add(so, china, smooth=35, weight=1.0)
    pool = []
    for k in range(14):
        a = 2 * math.pi * k / 14
        rr = 0.034 + rnd.uniform(-0.006, 0.008)
        pool.append((rr * math.cos(a) + 0.004, rr * math.sin(a) - 0.002))
    P.add(L.prism('pool', pool, 0.0025, M=xf((0, 0, 0.0085)), bevel=0.001), ivory, smooth=50)
    # candle stubs: (x, y, radius, height, lean, wax)
    for i, (cx, cy, cr, ch, lean, wk) in enumerate(specs):
        wm = ivory if wk == 'ivory' else red
        top_r = cr * 0.55
        prof = [(0.0, 0.0), (cr * 1.25, 0.0), (cr * 1.05, 0.004), (cr, 0.01), (cr * 1.02, ch * 0.6), (cr, ch - 0.004),
                (cr * 0.92, ch), (top_r * 1.1, ch - 0.0015), (top_r * 0.6, ch - 0.004), (0.0, ch - 0.0045)]
        o = L.lathe(f'candle_{i}', prof, segs=14, jitter=0.04, seed=i)
        for v in o.data.vertices:  # melted, lopsided rim: one side burnt lower
            if v.co.z > ch * 0.8:
                a = math.atan2(v.co.y, v.co.x)
                v.co.z -= 0.006 * (0.5 + 0.5 * math.cos(a - 1.0 - i)) * (v.co.z - ch * 0.8) / (ch * 0.2)
        L.place(o, xf((cx, cy, 0.009), (lean, 0, 0)), 'z')
        P.add(o, wm, smooth=50, weight=1.0)
        wz = ch - 0.004
        Ml = xf((cx, cy, 0.009), (lean, 0, 0))
        pts = [Ml @ Vector((0, 0, wz)), Ml @ Vector((0.001, 0, wz + 0.006)), Ml @ Vector((0.0035, 0.001, wz + 0.009))]
        P.add(L.tube(f'wick_{i}', pts, 0.0009, segs=4, caps=True), wick, smooth=60, weight=0.2)
    # one drip running over the saucer rim, frozen mid-fall
    a = 2.6
    pts = [(math.cos(a) * r_, math.sin(a) * r_, z_) for r_, z_ in ((0.05, 0.01), (0.06, 0.0148), (0.066, 0.0194),
                                                                  (0.0684, 0.016), (0.0686, 0.0095))]
    P.add(L.tube('rimdrip', pts, [0.0024, 0.0026, 0.0026, 0.0026, 0.0034], segs=6, scale_xy=(0.6, 1.0),
                 up_hint=(0, 0, 1)), ivory, smooth=180, weight=0.4)
    # a spent match lying in the well: pale stick, charred head
    matchwood = L.mat_plain('matchwood', hexc('b09a70'), 0.8, dust=0.5, grime=0.6, wear=0.0, scratch=0.0, seed=4.0)
    Mm = xf((0.03, 0.026, 0.0105), (0, 0, 62))
    P.add(L.box('match', (0.034, 0.0024, 0.0024), Mm @ xf((0.004, 0, 0)), bevel=0.0004), matchwood, weight=0.2)
    P.add(L.box('match_head', (0.008, 0.0028, 0.0028), Mm @ xf((-0.017, 0, 0)), bevel=0.0008), wick, weight=0.1)
    P.finish(previews=dict(yaw=30, pitch=28, extra=[dict(tag="close", yaw=10, pitch=10, zoom=2.0)]))


# =============================================================================================
# Broken plate + fork
# =============================================================================================

def build_plate_broken():
    P = L.Piece('plate_broken', 'floor', tex=512, max_tris=1500, ao=0.03, bevel=0.0015, ao_small=0.004, seed=81)
    pat = L.np_image('plate_pattern', I.plate_pattern(512))
    china = L.new_material('plate_china')
    g = G(china)
    c, _ = g.img(pat)
    p = g.pos()
    craze = g.vor(p, 70.0, 'DISTANCE_TO_EDGE')
    col = g.mix(g.mul(g.rng(craze, 0.02, 0.0), 0.35), c, hexc('6a5a40'))
    # dried food smear + the broken edges show the unglazed biscuit
    fs = g.noise(p, 14.0, 4, 0.65, offset=(3.0, 0, 0))
    food = g.mul(g.rng(fs, 0.62, 0.7), g.rng(g.v('LENGTH', g.vmul(p, (1, 1, 0))), 0.09, 0.05))
    col = g.mix(g.mul(food, 0.8), col, hexc('4a3220'))
    col = g.mix(g.mul(g.edge(), 0.9), col, hexc('c9c0ae'))
    col, rough, h = L.age(g, col, g.mixf(g.edge(), 0.14, 0.85), g.mul(food, 0.3), dust=0.5, grime=0.5, wear=0.0,
                          scratch=0.4, stains=0.4, stain_col=hexc('7a6040'), seed=1.0, film=0.06, dust_scale=2.0)
    g.finish(col, rough, h, soft=0.001)
    R = 0.13
    prof = [(0.0, 0.002), (0.075, 0.002), (0.095, 0.0105), (0.118, 0.018), (0.13, 0.019), (0.131, 0.0165),
            (0.116, 0.0145), (0.093, 0.006), (0.076, 0.0), (0.0, -0.001)]
    # top surface outer -> rim -> underside back to the center: one closed lathe
    rnd = random.Random(9)
    imp = Vector((0.025, -0.01, 0))
    rays = sorted(rnd.uniform(0, 2 * math.pi) for _ in range(6))
    rays = [r_ for r_ in rays]
    shards = []
    for k in range(len(rays)):
        a0, a1 = rays[k], rays[(k + 1) % len(rays)] + (2 * math.pi if k == len(rays) - 1 else 0)
        span = a1 - a0
        cuts = [(a0, a1)]
        if span > 1.6:  # split wide wedges in two
            m = a0 + span * rnd.uniform(0.4, 0.6)
            cuts = [(a0, m), (m, a1)]
        for (b0, b1) in cuts:
            ring_cut = rnd.uniform(0.05, 0.085) if (b1 - b0) > 0.8 else None
            for part in ((0.0, ring_cut), (ring_cut, None)) if ring_cut else ((0.0, None),):
                o = L.lathe('plate', prof, segs=28, cap_top=False, cap_bot=False)
                bm = bmesh.new()
                bm.from_mesh(o.data)
                planes = []
                for ang, sgn in ((b0, -1), (b1, 1)):
                    n = Vector((-math.sin(ang), math.cos(ang), 0)) * sgn
                    planes.append((imp, n))
                if part[1] is not None:  # keep inside the cross cut
                    ca = (b0 + b1) / 2
                    d = Vector((math.cos(ca), math.sin(ca), 0))
                    planes.append((imp + d * part[1], d))
                if part[0]:
                    ca = (b0 + b1) / 2
                    d = Vector((math.cos(ca), math.sin(ca), 0))
                    planes.append((imp + d * part[0], -d))
                for (co, no) in planes:
                    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
                    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=no, clear_outer=True)
                bnd = [e for e in bm.edges if e.is_boundary]
                if bnd:
                    bmesh.ops.holes_fill(bm, edges=bnd, sides=0)
                if len(bm.faces) < 4:
                    bm.free()
                    bpy.data.objects.remove(o)
                    continue
                uvl = bm.loops.layers.uv.new('src')
                for f in bm.faces:
                    for lp in f.loops:
                        co = lp.vert.co
                        lp[uvl].uv = (co.x / (2 * R) + 0.5, co.y / (2 * R) + 0.5)
                bm.to_mesh(o.data)
                bm.free()
                shards.append(o)
    # scatter around where it landed: big pieces stay close, small ones skitter away, a few flipped
    for i, o in enumerate(shards):
        vs = o.data.vertices
        cen = sum((v.co for v in vs), Vector()) / len(vs)
        area = sum(f.area for f in o.data.polygons)
        small = area < 0.006
        flip = False
        out = Vector((cen.x, cen.y, 0))
        out = out.normalized() if out.length > 1e-4 else Vector((1, 0, 0))
        dist = (0.06 + 0.12 * rnd.random()) if small else (0.008 + 0.025 * rnd.random())
        M = Matrix.Translation(-Vector((cen.x, cen.y, 0)))
        if flip:
            M = Matrix.Rotation(math.pi, 4, 'X') @ M
        M = Matrix.Rotation(rnd.uniform(-0.5, 0.5) if small else rnd.uniform(-0.15, 0.15), 4, 'Z') @ M
        o.data.transform(M)
        # rest on the floor: tilt so the piece lies on its lowest points (rims make them rock)
        lo = min(v.co.z for v in vs)
        o.data.transform(Matrix.Translation(Vector((cen.x, cen.y, 0)) + out * dist + Vector((0, 0, -lo))))
        L.place(o, None, 'x')
        P.add(o, china, smooth=30, weight=1.0, uv='smart')
    # fork, dropped next to it (tarnished silver plate)
    silver = L.mat_metal('fork_silver', hexc('8a8478'), rough=0.32, tarnish=0.8, tarnish_col=hexc('2e2a20'), dust=0.5,
                         seed=4.0, wear=0.5, scratch=0.6)
    n0 = len(P.parts)
    pts = [Vector((-0.115 + 0.115 * t, 0.0, 0.004 + 0.006 * math.sin(t * 2.6))) for t in np.linspace(0, 1, 6)]
    widths = [0.0105, 0.012, 0.009, 0.0055, 0.006, 0.008]
    P.add(L.tube('fork_handle', pts, widths, segs=6, scale_xy=(0.3, 1.0), up_hint=(0, 0, 1)), silver, smooth=50,
          weight=0.8)
    hd = [Vector((0.0, 0.0, 0.0095)), Vector((0.025, 0.0, 0.01))]
    P.add(L.tube('fork_head', hd, [0.008, 0.0115], segs=6, scale_xy=(0.25, 1.0), up_hint=(0, 0, 1)), silver, smooth=50,
          weight=0.5)
    for k in range(4):
        y0 = -0.0083 + k * 0.0055
        bent = 0.006 if k == 2 else 0.0
        tp = [Vector((0.024, y0, 0.0098)), Vector((0.045, y0 * 1.05, 0.0085)), Vector((0.062, y0 * 1.1, 0.0055 + bent))]
        P.add(L.tube(f'tine_{k}', tp, [0.0016, 0.0014, 0.0009], segs=4), silver, smooth=50, weight=0.3)
    for part in P.parts[n0:]:
        part['obj'].data.transform(Matrix.Translation((0.2, 0.1, -0.0025)) @ Matrix.Rotation(math.radians(-35), 4, 'Z'))
    P.finish(previews=dict(yaw=30, pitch=45))


# =============================================================================================
# Bare bulb with a broken shade (ceiling)
# =============================================================================================

def build_bulb():
    P = L.Piece('bulb', 'ceiling', tex=512, glass_tex=256, max_tris=1500, ao=0.05, bevel=0.002, ao_small=0.006,
                seed=91)
    L_cord = 0.62
    sway = Matrix.Rotation(math.radians(3.5), 4, 'X')  # hangs a hair off plumb
    # ceiling rose / canopy (origin = its top center, on the ceiling)
    paint = L.mat_paint('canopy_paint', hexc('a8a090'), hexc('6a6a62'), gloss=0.5, chip=0.6, dust=0.5, grime=1.0,
                        seed=1.0, base_is_wood=False, fade=0.3)
    can = [(0.0, -0.028), (0.016, -0.028), (0.03, -0.022), (0.048, -0.008), (0.05, 0.0), (0.0, 0.0)]
    P.add(L.lathe('canopy', can, segs=14), paint, smooth=40)
    # twisted cloth cord, in two strands
    cord = L.mat_fabric('cord_cloth', hexc('3a3228'), hexc('2a241c'), weave=1600.0, fade=0.3, stains=0.4, dust=0.9,
                        grime=0.9, seed=2.0, rough=0.85)
    top = Vector((0, 0, -0.026))
    bot = sway @ Vector((0, 0, -L_cord))
    for s in (0, 1):
        pts = []
        for k in range(10):
            t = k / 9
            c = top.lerp(bot, t)
            a = t * 14 * math.pi + s * math.pi
            pts.append(c + Vector((math.cos(a) * 0.0022, math.sin(a) * 0.0022, 0)))
        P.add(L.tube(f'cord_{s}', pts, 0.0024, segs=5, caps=True), cord, smooth=70, weight=0.6)
    # socket: bakelite shell over a brass shade ring
    bake = L.mat_plain('bakelite', hexc('2a1a10'), 0.35, dust=0.7, grime=0.8, noise_amt=0.2, wear=0.4, scratch=0.5,
                       seed=3.0)
    brass = L.mat_metal('socket_brass', hexc('9a7a3a'), rough=0.4, tarnish=0.7, tarnish_col=hexc('3a3018'), dust=0.6,
                        seed=4.0)
    sock = [(0.0, 0.0), (0.006, 0.0), (0.012, -0.006), (0.017, -0.016), (0.0175, -0.05), (0.019, -0.055),
            (0.019, -0.062), (0.0, -0.062)]
    SM = Matrix.Translation(bot) @ sway
    P.add(L.lathe('socket', [(r, z) for r, z in reversed(sock)], segs=12, M=SM), bake, smooth=40)
    P.add(L.lathe('ring', [(0.0195, -0.062), (0.026, -0.064), (0.026, -0.068), (0.0195, -0.068)][::-1], segs=12, M=SM,
                  cap_top=False, cap_bot=False), brass, smooth=30, weight=0.5)
    # bulb: brass screw base + glass envelope (dead, dark, a blackened tip)
    base = [(0.0, -0.068), (0.0125, -0.068), (0.0128, -0.072), (0.012, -0.076), (0.0128, -0.08), (0.012, -0.084),
            (0.0125, -0.088), (0.0095, -0.092), (0.004, -0.094), (0.0, -0.094)]
    P.add(L.lathe('screw', [(r, z) for r, z in reversed(base)], segs=10, M=SM), brass, smooth=40, weight=0.5)
    env = [(0.0, -0.205), (0.012, -0.203), (0.025, -0.193), (0.031, -0.177), (0.03, -0.157), (0.024, -0.135),
           (0.016, -0.11), (0.0128, -0.095), (0.0125, -0.089)]
    glass = L.new_material('bulb_glass')
    g = G(glass)
    glass['glass'] = 1
    p = g.pos()
    x, y, z = g.sep(p)
    # burnt-out: a gray-black mirror of tungsten deposited inside the tip, dust film on top
    blk = g.rng(g.sub(z, bot.z), -0.15, -0.2)
    dn = g.noise(p, 30.0, 3, 0.6)
    col = g.mix(blk, hexc('6a6e68'), hexc('16140f'))
    col = g.mix(g.mul(g.up(0.1, 0.8), g.rng(dn, 0.3, 0.7)), col, L.DUST)
    a_ = g.clamp(g.add(g.add(0.14, g.mul(blk, 0.75)), g.mul(g.up(0.1, 0.8), 0.4)))
    g.finish(col, g.mixf(g.up(0.1, 0.8), 0.08, 0.7), None, alpha=a_)
    P.add(L.lathe('envelope', env, segs=14, M=SM, cap_top=False), glass, smooth=60, weight=1.0)
    # inner glass stem + broken filament
    wire = L.mat_metal('filament', hexc('3a3632'), rough=0.5, tarnish=0.6, dust=0.0, seed=6.0)
    P.add(L.lathe('stem', [(0.004, -0.092), (0.0035, -0.13), (0.002, -0.14), (0.0, -0.141)][::-1], segs=6, M=SM,
                  cap_top=False), wire, smooth=50, weight=0.2)
    for sx in (-1, 1):
        pts = [SM @ Vector((sx * 0.0015, 0, -0.135)), SM @ Vector((sx * 0.008, 0, -0.16)), SM @ Vector((sx * 0.009, 0.001, -0.168))]
        P.add(L.tube(f'lead_{sx}', pts, 0.0005, segs=3, caps=False), wire, smooth=60, weight=0.1)
    coil = [SM @ Vector((-0.009, 0.001, -0.168)), SM @ Vector((-0.004, 0.0015, -0.171)), SM @ Vector((0.0, 0.0, -0.166))]
    P.add(L.tube('coil_a', coil, 0.0007, segs=3, caps=False), wire, smooth=60, weight=0.1)
    coil = [SM @ Vector((0.009, 0.001, -0.168)), SM @ Vector((0.006, -0.001, -0.175)), SM @ Vector((0.004, -0.002, -0.181))]
    P.add(L.tube('coil_b', coil, 0.0007, segs=3, caps=False), wire, smooth=60, weight=0.1)
    # what's left of a milk-glass shade: a jagged fragment still gripped by the ring
    milk = L.new_material('shade_milkglass')
    g = G(milk)
    p = g.pos()
    col = g.mix(g.rng(g.noise(p, 20.0, 2, 0.5), 0.3, 0.7), hexc('d6d2c4'), hexc('bab4a2'))
    col, rough, h = L.age(g, col, 0.15, 0.0, dust=1.0, grime=1.0, wear=0.0, scratch=0.2, stains=0.5,
                          stain_col=hexc('8a7048'), seed=7.0, film=0.1, up_lo=0.2)
    g.finish(col, rough, h, soft=0.0015)
    rnd = random.Random(3)
    shade_prof = [(0.026, -0.066), (0.05, -0.079), (0.075, -0.1), (0.092, -0.124), (0.1, -0.145)]
    arc = 160
    so = L.lathe('shade', shade_prof, segs=10, arc=arc, start=195, cap_top=False, cap_bot=False, M=None)
    # sawtooth break along the lower edge, the side breaks run up at an angle
    for v in so.data.vertices:
        rr = math.hypot(v.co.x, v.co.y)
        a = math.degrees(math.atan2(v.co.y, v.co.x)) % 360
        k = round((a - 195) / (arc / 10))
        if rr > 0.07:
            v.co.z += (0.022 if k % 2 else -0.004) * (rr - 0.07) / 0.03 + rnd.uniform(-0.004, 0.004)
        if k in (0, 10) and rr > 0.045:
            v.co.z += 0.02 * (rr - 0.045) / 0.055
    bm = bmesh.new()
    bm.from_mesh(so.data)
    bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.004)
    bm.to_mesh(so.data)
    bm.free()
    so.data.transform(SM)
    P.add(so, milk, smooth=40, weight=0.8)
    P.finish(origin=(0, 0, 0), previews=dict(yaw=30, pitch=-8, zoom=1.0,
                                             extra=[dict(tag='close', yaw=20, pitch=-5, zoom=2.6, mood='flash')]))


# =============================================================================================
# Scattered papers
# =============================================================================================

def build_papers():
    P = L.Piece('papers', 'floor', tex=512, max_tris=400, ao=0.03, bevel=0.001, ao_small=0.003, seed=101)
    portrait = None
    imgs = {
        'news': L.np_image('paper_news', I.newspaper(384, 512)),
        'news_b': L.np_image('paper_news_b', I.newspaper_back(384, 512)),
        'poster': L.np_image('paper_poster', I.missing_poster(320, 420)),
        'child': L.np_image('paper_child', I.child_drawing(384, 288)),
        'letter': L.np_image('paper_letter', I.handwritten(320, 420)),
        'typed': L.np_image('paper_typed', I.typed_page(320, 420, title='NOTICE OF FORECLOSURE')),
    }
    mats = {k: mat_paper(f'paper_{k}', image=v, seed=i, dust=0.5, stains=0.5, edge=0.4, rough=0.9) for i, (k, v) in
            enumerate(imgs.items())}
    back = mat_paper('paper_back', hexc('bcae8a'), seed=9.0, dust=0.4, stains=0.7)
    plain = mat_paper('paper_plain', image=L.np_image('paper_typed2', I.typed_page(320, 420, seed=38, title='MEMO')),
                      seed=8.0, dust=0.5, stains=0.6)
    rnd = random.Random(12)

    def sheet(name, w, h, M, mat, nu=3, nv=2, curl=0.0, lift=0.0, weight=1.0, back_w=0.3):
        """Two-sided sheet (front + back as separate grids) curling up at its far edge."""
        def fn(u, v, s=1.0):
            x = (u - 0.5) * w
            y = (v - 0.5) * h
            z = 0.0012 + curl * max(0.0, u - 0.55) ** 2 * 2.0 + lift * math.sin(v * math.pi) * u
            return (x, y, z)
        f = L.grid(name, nu, nv, fn, M=M)
        P.add(f, mat, smooth=60, weight=weight, uv='src')
        b = L.grid(name + '_b', nu, nv, lambda u, v: (lambda q: (q[0], q[1], q[2] - 0.0006))(fn(u, v)), M=M)
        bm = bmesh.new()
        bm.from_mesh(b.data)
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
        bm.to_mesh(b.data)
        bm.free()
        P.add(b, back, smooth=60, weight=0.08, uv='smart')
    # folded newspaper: front page up, half flipped open
    Mn = xf((0.05, 0.02, 0.0), (0, 0, 14))
    sheet('news', 0.36, 0.48, Mn, mats['news'], nu=3, nv=3, curl=0.04, weight=1.6, back_w=0.2)
    sheet('news2', 0.36, 0.48, xf((0.04, 0.0, 0.0018), (0, 0, 10)) @ xf((0.12, -0.08, 0), (0, 0, -24)), mats['news_b'],
          nu=2, nv=2, curl=0.02, weight=0.7, back_w=0.15)
    sheet('poster', 0.22, 0.29, xf((-0.33, 0.12, 0.0), (0, 0, -32)), mats['poster'], nu=2, nv=2, curl=0.05, weight=1.3)
    sheet('child', 0.28, 0.21, xf((-0.2, -0.28, 0.0), (0, 0, 21)), mats['child'], nu=3, nv=2, curl=0.03, lift=0.006,
          weight=1.4)
    sheet('letter', 0.2, 0.27, xf((0.36, -0.26, 0.0), (0, 0, 58)), mats['letter'], nu=2, nv=2, curl=0.06, weight=1.0)
    sheet('typed', 0.21, 0.28, xf((0.4, 0.22, 0.0), (0, 0, -12)), mats['typed'], nu=2, nv=2, curl=0.02, weight=0.9)
    sheet('plain1', 0.21, 0.28, xf((-0.05, 0.36, 0.0), (0, 0, 75)), plain, nu=2, nv=1, curl=0.08, weight=0.5)
    sheet('plain2', 0.21, 0.28, xf((0.18, 0.4, 0.001), (0, 0, 110)), plain, nu=1, nv=1, weight=0.4)
    P.finish(previews=dict(yaw=20, pitch=60))
