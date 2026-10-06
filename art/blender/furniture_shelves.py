"""
Tileable bookcase sections, exactly 1.0 W x 2.0 H x 0.45 D: furniture_shelf_module(_b).
Each module is a complete bookcase (both side panels), so a long shelf box is filled by repeating
modules side by side along X; mix A and B to avoid visible repetition.
Helper module: build() is a no-op (see furniture.py).
"""

from __future__ import annotations

import math
import random

import furniture_lib as F
from furniture_lib import G, Masks, age, hexc, _finish, new_material

W, H, D = 1.0, 2.0, 0.45
SIDE = 0.022
SHELF_T = 0.022
BACK_Y = -D / 2 + 0.012
FRONT_Y = D / 2 - 0.005


def build() -> None:
    print('furniture_shelves: built through furniture.py')


# --- materials ----------------------------------------------------------------------------------

BOOK_COLORS = ['5a1f1a', '2a3a2c', '1f2a3d', '6b5a3a', '3a2a1e', '7a6a50', '4a1a22', '2e3a40', '5c4a2a',
               '1a1a18', '6a3a20', '3d4a35', '8a7a5e', '402818', '23303a', '5a5040']


def mat_books(name, seed=0.0):
    """Cloth/leather book covers: color per book (pv), spine bands + title blocks from local position."""
    mat = new_material(name)
    g = G(mat)
    mk = Masks(g, 0.003, 0.06)
    pv = g.attr('pv', 'Fac')
    lp = g.attr('lp')
    lx, ly, lz = g.sep(lp)
    stops = [(i / len(BOOK_COLORS), hexc(c)) for i, c in enumerate(BOOK_COLORS)]
    col = g.ramp(pv, stops, 'CONSTANT')
    pv2 = g.m('FRACT', g.mul(pv, 7.31))
    pv3 = g.m('FRACT', g.mul(pv, 3.17))
    col = g.mix(g.mul(g.sub(pv3, 0.5), 0.5), col, g.hsv(col, v=1.6))
    # cloth texture
    n = g.noise(None, 150.0, 2, 0.6)
    col = g.mix(g.mul(n, 0.25), col, g.hsv(col, v=0.6))
    # bands near the head/tail of the spine (gilt or dark)
    band = g.add(g.mul(g.rng(lz, 0.055, 0.065), g.rng(lz, 0.095, 0.085)),
                 g.mul(g.rng(lz, 0.905, 0.915), g.rng(lz, 0.945, 0.935)))
    band = g.mul(band, g.rng(pv2, 0.25, 0.3))
    gilt = g.mix(g.rng(pv2, 0.6, 0.62), hexc('8a7038'), hexc('1a1410'))
    col = g.mix(g.mul(band, 0.85), col, gilt)
    # title label block (some books) + gold "lettering" dashes
    lab = g.mul(g.mul(g.rng(lz, 0.58, 0.6), g.rng(lz, 0.8, 0.78)), g.rng(pv3, 0.55, 0.6))
    lab = g.mul(lab, g.mul(g.rng(lx, 0.12, 0.18), g.rng(lx, 0.88, 0.82)))
    col = g.mix(g.mul(lab, 0.9), col, g.mix(g.rng(pv2, 0.4, 0.45), hexc('16120e'), hexc('a49a7a')))
    let = g.wave(g.v('MULTIPLY', lp, (1.0, 1.0, 1.0)), 60.0, 'BANDS', 'Z', dist=2.0, detail=1.0)
    letm = g.mul(g.mul(g.rng(let, 0.75, 0.85), g.rng(lz, 0.3, 0.32)), g.rng(lz, 0.52, 0.5))
    letm = g.mul(letm, g.rng(g.noise(None, 300.0, 1, 0.5), 0.35, 0.6))
    letm = g.mul(letm, g.mul(g.rng(lx, 0.25, 0.3), g.rng(lx, 0.75, 0.7)))
    col = g.mix(g.mul(letm, 0.8), col, hexc('9a8048'))
    # sun fade on the exposed spines + water damage on some
    col = g.mix(g.mul(g.rng(pv3, 0.2, 0.0), 0.5), col, g.hsv(col, s=0.4, v=1.5))
    rough = g.add(0.75, g.mul(n, 0.1))
    rough = g.mixf(g.mul(band, 0.6), rough, 0.4)
    h = g.mul(n, 0.4)
    col, rough, h = age(g, mk, col, rough, h, dust=0.75, grime=0.8, wear=0.6, wear_col=g.hsv(col, s=0.3, v=1.8),
                        stains=0.6, scratch=0.0, seed=seed, film=0.15, floor=0.0)
    _finish(g, mk, col, rough, h)
    return mat


def mat_pages(name):
    mat = new_material(name)
    g = G(mat)
    mk = Masks(g, 0.002, 0.05)
    lp = g.attr('lp')
    pos = g.pos()
    lines = g.noise(pos, 1.0, 1, 0.5, stretch=(600.0, 600.0, 600.0))
    col = g.mix(g.rng(g.noise(pos, 20.0, 3, 0.6), 0.3, 0.8), hexc('b8aa86'), hexc('8a7a58'))
    col = g.mix(g.mul(lines, 0.3), col, hexc('6a5c40'))
    fox = g.mul(g.rng(g.noise(pos, 40.0, 3, 0.6), 0.62, 0.7), 0.7)
    col = g.mix(fox, col, hexc('5a4024'))
    h = g.mul(lines, 0.5)
    col, rough, h = age(g, mk, col, 0.85, h, dust=0.9, grime=1.0, wear=0.0, scratch=0.0, film=0.15, floor=0.0)
    _finish(g, mk, col, rough, h)
    return mat


def _case_wood():
    return F.mat_wood('shelf_oak', hexc('6e4a2c'), hexc('3a2414'), finish=0.45, ring=0.009, figure=0.8, pores=0.6,
                      dust=0.8, grime=0.9, wear=0.6, raw=hexc('9a7a54'), scratch=0.4, tide=0.09, peel=0.35,
                      peel_col=hexc('8e7a5a'), stains=0.4, bevel_r=0.004, seed=3.0, crack=0.3)


def _back_mat():
    return F.mat_plain('shelf_back', hexc('3a2a1e'), 0.8, dust=0.3, grime=1.0, noise_amt=0.4)


# --- case ---------------------------------------------------------------------------------------

def _case(P, wood, back, shelves_z, sag=None, collapsed=None):
    # sides
    for sx in (-1, 1):
        P.box((SIDE, D - 0.01, H - 0.002), (sx * (W / 2 - SIDE / 2), -0.005, H / 2), wood, bevel=0.003, grain='z',
              name='side')
    # top + crown molding along the front
    P.box((W, D - 0.02, 0.024), (0, -0.01, H - 0.034), wood, bevel=0.003, name='top')
    # crown molding: profile in (y, z), extruded along X (prism along local Y rotated 90 deg about Z)
    crown = [(0.0, 0.0), (0.03, 0.0), (0.03, 0.006), (0.018, 0.012), (0.012, 0.022), (0.004, 0.026), (0.0, 0.034)]
    P.prism(crown, W, (0, D / 2 - 0.03, H - 0.034), wood, rot=(0, 0, 90), bevel=0.0015, name='crown', grain='y')
    # plinth (toe board) + bottom shelf
    P.box((W - 2 * SIDE, 0.02, 0.085), (0, D / 2 - 0.03, 0.0425), wood, bevel=0.003, name='plinth')
    # back panel (hardboard)
    P.box((W - 2 * SIDE, 0.006, H - 0.04), (0, BACK_Y, H / 2), back, bevel=0.0, name='back', skip=('-y',))
    # shelves
    objs = []
    for i, z in enumerate(shelves_z):
        if collapsed and collapsed[0] == i:
            continue
        if sag and sag[0] == i:
            # bowed shelf: a few segments along X
            n = 6
            verts, faces = [], []
            L = W - 2 * SIDE
            for k in range(n + 1):
                x = -L / 2 + L * k / n
                dz = -sag[1] * math.sin(math.pi * k / n)
                for (yy, zz) in ((FRONT_Y - 0.002, 0), (BACK_Y + 0.004, 0), (BACK_Y + 0.004, SHELF_T),
                                 (FRONT_Y - 0.002, SHELF_T)):
                    verts.append((x, yy, z + zz + dz))
            for k in range(n):
                a, b = 4 * k, 4 * (k + 1)
                for j in range(4):
                    j2 = (j + 1) % 4
                    faces.append((a + j, a + j2, b + j2, b + j))
            faces.append((3, 2, 1, 0))
            faces.append((4 * n, 4 * n + 1, 4 * n + 2, 4 * n + 3))
            o = P.mesh(verts, faces, (0, 0, 0), wood, name='shelf', bevel=0.002)
        else:
            o = P.box((W - 2 * SIDE, FRONT_Y - BACK_Y - 0.006, SHELF_T), (0, (FRONT_Y + BACK_Y) / 2, z + SHELF_T / 2),
                      wood, bevel=0.003, name='shelf')
        objs.append(o)
    return objs


# --- books --------------------------------------------------------------------------------------

def _lying_book(P, cloth, pages, x0, z, w, h, d, setback, rz=0.0):
    """Book lying on its side, spine to the front: an upright book rotated 90 deg about Y."""
    mats = {'default': cloth, '+z': pages, '-z': pages, '-y': pages}
    y = FRONT_Y - setback - d / 2
    P.box((w, d, h), (x0 + h / 2, y, z + w / 2), mats, bevel=0.0, rot=(0, 90, rz), name='book', skip=('+x',))
    return x0 + h


def _fill(P, rng, cloth, pages, x0, x1, z, max_h, plan='mixed'):
    """Fill one shelf from x0 to x1 (shelf top at z) with books; returns nothing."""
    x = x0 + rng.uniform(0.0, 0.02)
    last_h = None
    last_x = None
    while x < x1 - 0.03:
        r = rng.random()
        if plan == 'sparse' and r < 0.35:
            x += rng.uniform(0.06, 0.18)
            last_h = None
            continue
        if r < 0.07 and last_h is not None:
            # a book leaning left against the previous one
            a = math.radians(rng.uniform(12, 28))
            w = rng.uniform(0.022, 0.04)
            h = min(max_h * 0.95, rng.uniform(0.2, 0.28))
            d = rng.uniform(0.14, 0.22)
            px = last_x + last_h * math.tan(a) * 0.98
            if px + w * math.cos(a) > x1:
                break
            # rotate about the bottom-left edge: Blender Ry(+a) tips the top toward -X? (Ry(phi): z->x*sin)
            P.box((w, d, h), (px + w / 2, FRONT_Y - rng.uniform(0.01, 0.04) - d / 2, z + h / 2),
                  {'default': cloth, '+z': pages, '-z': pages, '-y': pages}, bevel=0.0, skip=('-z',),
                  rot=(0, -math.degrees(a), 0), pivot=(px, 0, z), name='book')
            x = px + w * math.cos(a) + h * math.sin(a) * 0.0 + rng.uniform(0.04, 0.12)
            last_h = None
            continue
        if r < 0.15:
            # stack of lying books
            n = rng.randint(2, 5)
            zz = z
            ln = rng.uniform(0.2, 0.27)
            if x + ln > x1:
                break
            for k in range(n):
                t = rng.uniform(0.022, 0.045)
                dd = rng.uniform(0.15, 0.21)
                hh = ln - rng.uniform(0.0, 0.04)
                _lying_book(P, cloth, pages, x + rng.uniform(-0.01, 0.01), zz, t, hh, dd, rng.uniform(0.0, 0.03),
                            rz=rng.uniform(-6, 6))
                zz += t
                if zz - z > max_h * 0.8:
                    break
            x += ln + rng.uniform(0.01, 0.05)
            last_h = None
            continue
        if r < 0.2:
            x += rng.uniform(0.03, 0.1)   # gap
            last_h = None
            continue
        # a run of upright books
        n = rng.randint(3, 9)
        base_h = rng.uniform(0.19, max_h * 0.92)
        for k in range(n):
            w = rng.uniform(0.018, 0.048)
            if x + w > x1:
                break
            h = max(0.14, min(max_h * 0.97, base_h + rng.uniform(-0.04, 0.04)))
            d = min(0.3, h * rng.uniform(0.62, 0.78))
            P.box((w, d, h), (x + w / 2, FRONT_Y - rng.uniform(0.005, 0.035) - d / 2, z + h / 2),
                  {'default': cloth, '+z': pages, '-z': pages, '-y': pages}, bevel=0.0, skip=('-z',),
                  rot=(0, 0, rng.uniform(-2.0, 2.0)), name='book')
            last_h, last_x = h, x + w
            x += w + rng.uniform(0.0, 0.004)
        x += rng.uniform(0.0, 0.02)


def _clutter_jar(P, x, y, z, glass, h=0.12, r=0.04):
    P.lathe([(r * 0.8, 0.0), (r, 0.01), (r, h * 0.75), (r * 0.7, h * 0.88), (r * 0.6, h), (0.0, h)], (x, y, z),
            glass, segs=8, cap_top=False, name='jar')


def _box(P, x, y, z, card, w, d, h, rz=0.0):
    P.box((w, d, h), (x, y, z + h / 2), card, bevel=0.004, rot=(0, 0, rz), name='cardbox', skip=('-z',))


def build_shelf_module():
    P = F.Piece('shelf_module', seed=17)
    rng = random.Random(4)
    wood = _case_wood()
    back = _back_mat()
    cloth = mat_books('books_cloth', seed=1.0)
    pages = mat_pages('books_pages')
    glass = F.mat_glass('shelf_glass', tint=hexc('0c120c'))
    card = F.mat_plain('shelf_card', hexc('6e5a3c'), 0.9, dust=0.8, grime=0.9, noise_amt=0.3)
    zs = [0.085, 0.455, 0.825, 1.195, 1.565]
    _case(P, wood, back, zs, sag=(2, 0.018))
    tops = [z + SHELF_T for z in zs]
    gaps = [zs[i + 1] - tops[i] for i in range(len(zs) - 1)] + [H - 0.034 - tops[-1]]
    x0, x1 = -W / 2 + SIDE + 0.004, W / 2 - SIDE - 0.004
    plans = ['mixed', 'mixed', 'mixed', 'sparse', 'mixed']
    for i, (zt, gap) in enumerate(zip(tops, gaps)):
        if i == 2:
            zt -= 0.008  # sagging shelf
        if i == 3:
            _clutter_jar(P, 0.3, 0.05, zt, glass)
            _clutter_jar(P, 0.37, 0.0, zt, glass, h=0.09, r=0.035)
            _fill(P, rng, cloth, pages, x0, 0.22, zt, gap - 0.02, plans[i])
            continue
        if i == 0:
            _box(P, 0.3, -0.02, zt, card, 0.3, 0.32, 0.22, rz=4)
            _fill(P, rng, cloth, pages, x0, 0.12, zt, gap - 0.02, plans[i])
            continue
        _fill(P, rng, cloth, pages, x0, x1, zt, gap - 0.02, plans[i])
    P.finish(tex=1024, tileable=True, max_tris=2500, fit=(W, H, D), preview_yaw=25, preview_pitch=10)


def build_shelf_module_b():
    """Variant: sparser, a collapsed shelf with books slid into a heap, boxes."""
    P = F.Piece('shelf_module_b', seed=29)
    rng = random.Random(9)
    wood = _case_wood()
    back = _back_mat()
    cloth = mat_books('books_cloth', seed=5.0)
    pages = mat_pages('books_pages')
    card = F.mat_plain('shelf_card', hexc('6a5638'), 0.9, dust=0.8, grime=0.9, noise_amt=0.3)
    glass = F.mat_glass('shelf_glass', tint=hexc('101410'))
    zs = [0.085, 0.455, 0.825, 1.195, 1.565]
    _case(P, wood, back, zs, collapsed=(3,))
    tops = [z + SHELF_T for z in zs]
    gaps = [zs[i + 1] - tops[i] for i in range(len(zs) - 1)] + [H - 0.034 - tops[-1]]
    x0, x1 = -W / 2 + SIDE + 0.004, W / 2 - SIDE - 0.004
    # collapsed shelf 3: left end still on its pin, right end dropped onto the shelf below
    L = W - 2 * SIDE
    z3 = zs[3]
    drop = z3 - (tops[2] + 0.06)
    ang = math.degrees(math.atan2(drop, L))
    P.box((L - 0.01, FRONT_Y - BACK_Y - 0.006, SHELF_T), (0, (FRONT_Y + BACK_Y) / 2, z3 + SHELF_T / 2), wood,
          bevel=0.003, rot=(0, ang, 0), pivot=(x0, 0, z3), name='shelf_fallen')
    # shelf 0: big books + box
    _fill(P, rng, cloth, pages, x0, 0.05, tops[0], gaps[0] - 0.02, 'mixed')
    _box(P, 0.25, -0.03, tops[0], card, 0.36, 0.34, 0.25, rz=-3)
    # shelf 1: sparse leaning books
    _fill(P, rng, cloth, pages, x0, x1, tops[1], gaps[1] - 0.02, 'sparse')
    # shelf 2: heap of books under the fallen shelf (lying, jumbled), a few still standing at the left
    _fill(P, rng, cloth, pages, x0, -0.15, tops[2], gaps[2] - 0.02, 'mixed')
    zz = tops[2]
    for k in range(7):
        t = rng.uniform(0.025, 0.045)
        xx = rng.uniform(-0.1, 0.25)
        _lying_book(P, cloth, pages, xx, tops[2] + (k % 3) * 0.03, t, rng.uniform(0.18, 0.24), rng.uniform(0.15, 0.19),
                    rng.uniform(0.07, 0.12), rz=rng.uniform(-22, 22))
    # books that slid down the fallen shelf, lying on it near the low end
    # shelf 4 (top compartment): a few books toppled over + jar
    _fill(P, rng, cloth, pages, x0, -0.05, tops[4], gaps[4] - 0.02, 'mixed')
    for k in range(3):
        _lying_book(P, cloth, pages, 0.02 + k * 0.012, tops[4] + k * 0.032, 0.03, 0.24 - k * 0.02, 0.17, 0.02,
                    rz=rng.uniform(-8, 8))
    _clutter_jar(P, 0.36, 0.02, tops[4], glass, h=0.14, r=0.045)
    P.finish(tex=1024, tileable=True, max_tris=2500, fit=(W, H, D), preview_yaw=25, preview_pitch=10)
