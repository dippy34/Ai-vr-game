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
    covers = [L.mat_fabric(f'book_cloth_{i}', hexc(c), None, weave=900.0, fade=0.45, stains=0.7, dust=0.9,
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
    book(P, 'lean', 0.15, 0.22, 0.032, Matrix.Translation((0.2, 0.05, 0.0)) @ Matrix.Rotation(math.radians(15), 4, 'Z')
         @ Matrix.Rotation(math.radians(-64), 4, 'Y') @ Matrix.Translation((0.075, 0, 0)), covers[2], pages)
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
    green = L.mat_glass('glass_green', tint=hexc('1a3020'), alpha=0.42, dust=0.9, grime=0.7, seed=1.0, rough=0.08)
    amber = L.mat_glass('glass_amber', tint=hexc('3a200c'), alpha=0.5, dust=0.9, grime=0.7, seed=2.0)
    clear = L.mat_glass('glass_clear', tint=hexc('6a786e'), alpha=0.14, dust=0.85, grime=0.6, seed=3.0)
    aqua = L.mat_glass('glass_aqua', tint=hexc('4a6a66'), alpha=0.22, dust=0.8, grime=0.6, seed=4.0)
    tin = L.mat_metal('lid_tin', hexc('8a8478'), rough=0.5, tarnish=0.5, rust=0.85, dust=0.6, seed=5.0)
    label = L.new_material('labels')
    g = G(label)
    uv = g.uv('src')
    u, v, _ = g.sep(uv)
    base = g.mix(g.rng(g.noise(g.pos(), 30.0, 3, 0.5), 0.3, 0.7), hexc('c8b890'), hexc('a8946a'))
    border = g.mx(g.mul(g.rng(v, 0.08, 0.06), g.rng(v, 0.04, 0.06)), g.mul(g.rng(v, 0.92, 0.94), g.rng(v, 0.96, 0.94)))
    col = g.mix(border, base, hexc('6a2a20'))
    col = text_block(g, uv, lines=7.0, margin=0.18, col=col, ink=hexc('3a2a20'))
    col, r, h = L.age(g, col, 0.85, 0.0, dust=0.6, grime=0.9, wear=0.0, scratch=0.0, stains=0.8, fade=0.4,
                      stain_col=hexc('7a5a34'), seed=6.0, film=0.1)
    g.finish(col, r, h)
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
    P.add(ml, label, smooth=40, uv='src', weight=0.6)
    # 3) mason jar, murky dried residue, rusted lid
    jar = [(0.0, 0.0), (0.036, 0.0), (0.04, 0.008), (0.04, 0.11), (0.036, 0.125), (0.032, 0.13), (0.033, 0.142)]
    P.add(L.lathe('jar', jar, segs=16, M=xf((0.06, 0.06, 0)), cap_top=False), clear, smooth=40, weight=1.0)
    P.add(L.lathe('jar_lid', [(0.0, 0.0), (0.035, 0.0), (0.0355, 0.012), (0.033, 0.014), (0.0, 0.0145)], segs=16,
                  M=xf((0.06, 0.06, 0.134), (3, -2, 0))), tin, smooth=40, weight=0.6)
    P.add(L.lathe('jar_gunk', [(0.0, 0.003), (0.037, 0.003), (0.039, 0.03), (0.036, 0.026), (0.0, 0.022)], segs=14,
                  M=xf((0.06, 0.06, 0))), residue, smooth=40, weight=0.4)
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

def build_candles():
    P = L.Piece('candles', 'surface', tex=512, max_tris=1500, ao=0.04, bevel=0.0015, ao_small=0.005, seed=71)
    china = L.new_material('saucer_china')
    g = G(china)
    p = g.pos()
    x, y, z = g.sep(p)
    r = g.m('SQRT', g.add(g.mul(x, x), g.mul(y, y)))
    band = g.mul(g.rng(r, 0.058, 0.06), g.rng(r, 0.066, 0.064))
    col = g.mix(band, hexc('d8d0bc'), hexc('7a6a3a'))  # worn gilt line on the rim
    craze = g.vor(p, 90.0, 'DISTANCE_TO_EDGE')
    col = g.mix(g.mul(g.rng(craze, 0.025, 0.0), 0.5), col, hexc('6a5a40'))
    chip = g.rng(g.add(g.noise(p, 40.0, 3, 0.6), g.mul(g.convex(), 0.4)), 0.78, 0.8, smooth=False)
    col = g.mix(chip, col, hexc('a89e88'))
    col, rough, h = L.age(g, col, g.mixf(chip, 0.18, 0.8), g.mul(chip, -0.5), dust=0.6, grime=1.0, wear=0.0,
                          scratch=0.4, stains=0.6, seed=1.0, film=0.06)
    g.finish(col, rough, h, soft=0.0015)
    wax = L.new_material('wax')
    g = G(wax)
    p = g.pos()
    x, y, z = g.sep(p)
    base = g.mix(g.rng(g.noise(p, 30.0, 3, 0.5), 0.3, 0.7), hexc('cfc2a0'), hexc('b8a880'))
    # soot darkening near the burnt tops, drips glossier
    soot = g.mul(g.rng(z, 0.03, 0.075), g.rng(g.noise(p, 25.0, 3, 0.6), 0.3, 0.7))
    col = g.mix(g.mul(soot, 0.6), base, hexc('3a3228'))
    h = g.mul(g.noise(p, 160.0, 3, 0.6), 0.4)
    col, rough, h = L.age(g, col, 0.42, h, dust=0.7, grime=0.9, wear=0.0, scratch=0.15, stains=0.3, seed=2.0,
                          film=0.08)
    g.finish(col, rough, h, bump_dist=0.0004)
    wick = L.mat_plain('wick', hexc('0e0c0a'), 0.9, dust=0.2, grime=0.3, wear=0.0, scratch=0.0, seed=3.0)
    # saucer
    sau = [(0.0, 0.0), (0.03, 0.0), (0.032, 0.004), (0.045, 0.006), (0.062, 0.013), (0.068, 0.017), (0.066, 0.019),
           (0.06, 0.016), (0.044, 0.01), (0.0, 0.009)]
    so = L.lathe('saucer', sau, segs=18, cap_top=True, cap_bot=True)
    # a chunk missing from the rim
    for v in so.data.vertices:
        a = math.degrees(math.atan2(v.co.y, v.co.x))
        if 20 < a < 44 and math.hypot(v.co.x, v.co.y) > 0.058:
            k = 0.88
            v.co.x *= k
            v.co.y *= k
    P.add(so, china, smooth=35, weight=1.0)
    rnd = random.Random(7)
    # wax pool fused onto the saucer
    pool = []
    for k in range(16):
        a = 2 * math.pi * k / 16
        rr = 0.036 + rnd.uniform(-0.006, 0.008)
        pool.append((rr * math.cos(a) + 0.004, rr * math.sin(a) - 0.002))
    po = L.prism('pool', pool, 0.003, M=xf((0, 0, 0.0085)), bevel=0.0012)
    P.add(po, wax, smooth=50)
    # candle stubs: (x, y, radius, height, lean)
    for i, (cx, cy, cr, ch, lean) in enumerate(((-0.012, 0.006, 0.0115, 0.058, 2), (0.019, -0.006, 0.01, 0.034, -3),
                                                (0.004, 0.024, 0.0095, 0.021, 5))):
        top_r = cr * 0.55
        prof = [(0.0, 0.0), (cr * 1.25, 0.0), (cr * 1.05, 0.004), (cr, 0.01), (cr * 1.02, ch * 0.6), (cr, ch - 0.004),
                (cr * 0.92, ch), (top_r * 1.1, ch - 0.0015), (top_r * 0.6, ch - 0.004), (0.0, ch - 0.0045)]
        o = L.lathe(f'candle_{i}', prof, segs=10, jitter=0.06, seed=i)
        # melted, lopsided rim: one side burnt lower
        for v in o.data.vertices:
            if v.co.z > ch * 0.8:
                a = math.atan2(v.co.y, v.co.x)
                v.co.z -= 0.006 * (0.5 + 0.5 * math.cos(a - 1.0 - i)) * (v.co.z - ch * 0.8) / (ch * 0.2)
        L.place(o, xf((cx, cy, 0.009), (lean, 0, rnd.uniform(0, 90))), 'z')
        P.add(o, wax, smooth=50, weight=1.0)
        # drips running down the side and pooling at the base
        for d in range(3):
            a = rnd.uniform(0, 2 * math.pi)
            z0 = ch - rnd.uniform(0.002, 0.01)
            z1 = rnd.uniform(0.004, z0 * 0.6)
            r0 = cr + 0.0012
            pts = [(cx + math.cos(a) * r0, cy + math.sin(a) * r0, 0.009 + z) for z in np.linspace(z0, z1, 4)]
            rads = [0.0018, 0.0022, 0.0024, 0.003]
            P.add(L.tube(f'drip_{i}_{d}', pts, rads, segs=5, caps=True), wax, smooth=60, weight=0.3)
        # curled black wick
        wz = 0.009 + ch - 0.004
        pts = [(cx, cy, wz), (cx + 0.001, cy, wz + 0.006), (cx + 0.0035, cy + 0.001, wz + 0.009)]
        P.add(L.tube(f'wick_{i}', pts, 0.0009, segs=4, caps=True), wick, smooth=60, weight=0.2)
    # drips over the saucer rim, frozen mid-fall
    for d, a in enumerate((2.3, 3.4, 5.1)):
        r0 = 0.066
        pts = [(math.cos(a) * 0.05, math.sin(a) * 0.05, 0.0115), (math.cos(a) * r0, math.sin(a) * r0, 0.0185),
               (math.cos(a) * 0.069, math.sin(a) * 0.069, 0.012), (math.cos(a) * 0.069, math.sin(a) * 0.069, 0.004 + d * 0.002)]
        P.add(L.tube(f'rimdrip_{d}', pts, [0.0025, 0.0026, 0.0024, 0.003], segs=5), wax, smooth=60, weight=0.3)
    # a spent match on the saucer
    P.add(L.box('match', (0.042, 0.0024, 0.0024), xf((0.03, 0.035, 0.0105), (0, 0, 70)), bevel=0.0004), wick, weight=0.2)
    P.finish(previews=dict(yaw=30, pitch=28))


# =============================================================================================
# Broken plate + fork
# =============================================================================================

def build_plate_broken():
    P = L.Piece('plate_broken', 'floor', tex=512, max_tris=1500, ao=0.03, bevel=0.0015, ao_small=0.004, seed=81)
    pat = L.np_image('plate_pattern', I.plate_pattern(512))
    china = L.new_material('plate_china')
    g = G(china)
    uv = g.uv('src')
    c, _ = g.img(pat)
    p = g.pos()
    craze = g.vor(p, 70.0, 'DISTANCE_TO_EDGE')
    col = g.mix(g.mul(g.rng(craze, 0.02, 0.0), 0.35), c, hexc('6a5a40'))
    # broken edges show the unglazed biscuit (bevel edge mask)
    col = g.mix(g.mul(g.edge(), 0.9), col, hexc('cfc6b4'))
    col, rough, h = L.age(g, col, g.mixf(g.edge(), 0.12, 0.85), 0.0, dust=0.55, grime=0.9, wear=0.0, scratch=0.3,
                          stains=0.5, seed=1.0, film=0.06)
    g.finish(col, rough, h, soft=0.001)
    R = 0.13
    prof_r = [0.0, 0.05, 0.075, 0.09, 0.105, 0.118, 0.13]
    prof_z = [0.002, 0.0, 0.002, 0.009, 0.014, 0.018, 0.019]
    NA = 28
    rnd = random.Random(9)
    # shard regions: nearest of a few seeds in (angle, radius) space
    seeds = [(rnd.uniform(0, 2 * math.pi), rnd.uniform(0.02, 0.12)) for _ in range(9)]

    def owner(a, r):
        best, bi = 1e9, 0
        for i, (sa, sr) in enumerate(seeds):
            dx = math.cos(a) * r - math.cos(sa) * sr
            dy = math.sin(a) * r - math.sin(sa) * sr
            d = dx * dx + dy * dy
            if d < best:
                best, bi = d, i
        return bi
    # cells: (ring j, angle k)
    cells = {}
    for j in range(len(prof_r) - 1):
        for k in range(NA):
            a = 2 * math.pi * (k + 0.5) / NA
            r = (prof_r[j] + prof_r[j + 1]) / 2
            cells[(j, k)] = owner(a, r)
    th = 0.0035

    def pt(j, k):
        a = 2 * math.pi * k / NA
        r = prof_r[j]
        return Vector((r * math.cos(a), r * math.sin(a), prof_z[j]))
    shards = []
    for si in range(len(seeds)):
        mine = [c for c, o in cells.items() if o == si]
        if not mine:
            continue
        bm = bmesh.new()
        uvl = bm.loops.layers.uv.new('src')
        vmap = {}

        def V(j, k):
            key = (0, 0) if j == 0 else (j, k % NA)
            if key not in vmap:
                vmap[key] = bm.verts.new(pt(j, k))
            return vmap[key]
        for (j, k) in mine:
            if j == 0:
                f = bm.faces.new((V(0, 0) if False else V(0, k), V(1, k), V(1, k + 1)))
            else:
                f = bm.faces.new((V(j, k), V(j + 1, k), V(j + 1, k + 1), V(j, k + 1))[::-1][::-1])
            for lp in f.loops:
                co = lp.vert.co
                lp[uvl].uv = (co.x / (2 * R) + 0.5, co.y / (2 * R) + 0.5)
        bm.normal_update()
        for f in bm.faces:
            if f.normal.z < 0:
                f.normal_flip()
        # jagged break: jitter boundary verts slightly in the plane
        boundary = {v for e in bm.edges if e.is_boundary for v in e.verts}
        for v in boundary:
            if math.hypot(v.co.x, v.co.y) < R - 0.002:
                v.co.x += rnd.uniform(-0.003, 0.003)
                v.co.y += rnd.uniform(-0.003, 0.003)
        res = bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=th)
        o = L._link(bm, f'shard_{si}')
        shards.append((o, len(mine)))
    # scatter: big pieces stay near where it landed, small ones skitter away; some flipped
    for i, (o, n) in enumerate(shards):
        cen = sum((v.co for v in o.data.vertices), Vector()) / len(o.data.vertices)
        flip = rnd.random() < 0.3 and n < 12
        dist = 0.02 + (0.18 if n < 6 else 0.05) * rnd.random()
        out = Vector((cen.x, cen.y, 0)).normalized() if cen.length > 1e-4 else Vector((1, 0, 0))
        M = Matrix.Translation(-cen)
        if flip:
            M = Matrix.Rotation(math.pi, 4, 'X') @ M
        M = Matrix.Rotation(rnd.uniform(-0.6, 0.6), 4, 'Z') @ Matrix.Rotation(rnd.uniform(-0.12, 0.12), 4, 'X') @ M
        o.data.transform(M)
        lo = min(v.co.z for v in o.data.vertices)
        o.data.transform(Matrix.Translation(Vector((cen.x, cen.y, 0)) + out * dist + Vector((0, 0, -lo))))
        L.place(o, None, 'x')
        P.add(o, china, smooth=30, weight=1.0, uv='src')
    # fork, dropped next to it (tarnished silver plate)
    silver = L.mat_metal('fork_silver', hexc('a8a49a'), rough=0.3, tarnish=0.7, tarnish_col=hexc('3a3428'), dust=0.4,
                         seed=4.0, wear=0.5, scratch=0.6)
    handle = [(-0.1, 0.0), (-0.09, 0.0), (0.0, 0.0), (0.03, 0.0)]
    pts = [Vector((-0.115 + 0.115 * t, 0.0, 0.004 + 0.006 * math.sin(t * 2.6))) for t in np.linspace(0, 1, 6)]
    widths = [0.0105, 0.012, 0.009, 0.0055, 0.006, 0.008]
    fk = L.tube('fork_handle', pts, widths, segs=6, scale_xy=(0.28, 1.0), up_hint=(0, 0, 1))
    P.add(fk, silver, smooth=50, weight=0.7)
    # head + four tines
    hd = [Vector((0.0, 0.0, 0.0095)), Vector((0.025, 0.0, 0.01))]
    P.add(L.tube('fork_head', hd, [0.008, 0.0115], segs=6, scale_xy=(0.25, 1.0), up_hint=(0, 0, 1)), silver, smooth=50,
          weight=0.5)
    for k in range(4):
        y0 = -0.0083 + k * 0.0055
        tp = [Vector((0.024, y0, 0.0098)), Vector((0.045, y0 * 1.05, 0.0085)), Vector((0.062, y0 * 1.1 + (0.002 if k == 2 else 0.0), 0.0055 + (0.006 if k == 2 else 0)))]
        P.add(L.tube(f'tine_{k}', tp, [0.0016, 0.0014, 0.0009], segs=4), silver, smooth=50, weight=0.3)
    for part in P.parts[-6:]:
        part['obj'].data.transform(Matrix.Translation((0.17, 0.09, -0.002)) @ Matrix.Rotation(math.radians(-35), 4, 'Z'))
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
    glass = L.mat_glass('bulb_glass', tint=hexc('5a5e58'), alpha=0.16, dust=1.0, grime=0.7, seed=5.0)
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
    shade_prof = [(0.026, -0.066), (0.05, -0.08), (0.08, -0.105), (0.098, -0.13)]
    arc = 150
    so = L.lathe('shade', shade_prof, segs=9, arc=arc, start=200, cap_top=False, cap_bot=False, M=None)
    # jag the free edges (lower rim + both side breaks)
    for v in so.data.vertices:
        rr = math.hypot(v.co.x, v.co.y)
        if rr > 0.06:
            v.co.z += rnd.uniform(-0.012, 0.016)
    bm = bmesh.new()
    bm.from_mesh(so.data)
    bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.0025)
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
    mats = {k: mat_paper(f'paper_{k}', image=v, seed=i, dust=0.45, stains=0.4, edge=0.3) for i, (k, v) in
            enumerate(imgs.items())}
    back = mat_paper('paper_back', hexc('c8bb9a'), seed=9.0, dust=0.4, stains=0.7)
    plain = mat_paper('paper_plain', hexc('cdbfa0'), text=True, seed=8.0, dust=0.5, stains=0.6, lines=26.0)
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
        P.add(b, back if mat is not plain else back, smooth=60, weight=back_w, uv='smart')
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
