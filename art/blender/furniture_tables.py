"""Tables: dining table, small kitchen table, coffee table, pedestal desk. Helper module (no-op build)."""

from __future__ import annotations

import math
import random

import furniture_lib as F
import furniture_parts as J
from furniture_lib import hexc


def build() -> None:
    print('furniture_tables: built through furniture.py')


def build_table_dining():
    """2.4 m dining table: three-board top (two halves + a warped leaf), apron, turned legs."""
    P = F.Piece('table_dining', seed=12)
    wood = J.mahogany('dining_mahogany', seed=1.0, rings=1.0, stains=0.5, burn=0.3, peel=0.3)
    wiped = J.mahogany('dining_wiped', seed=1.0, rings=1.0, stains=0.5, burn=0.3, peel=0.3, dust=0.2, film=0.08)
    smear = J.mahogany('dining_smear', seed=1.0, rings=1.0, stains=0.5, burn=0.3, peel=0.3, dust=0.4, film=0.1)
    W, D, H = 2.4, 1.0, 0.76
    t = 0.032
    seams = [-0.32, 0.32]
    xs = [-W / 2] + seams + [W / 2]
    boards = []
    for i in range(3):
        x0, x1 = xs[i] + (0.0015 if i else 0), xs[i + 1] - (0.0015 if i < 2 else 0)
        dz = 0.0025 if i == 1 else 0.0
        b = P.box((x1 - x0, D, t), ((x0 + x1) / 2, 0, H - t / 2 + dz), wood, bevel=0.007, segs=2, name='top',
                  rot=(0.25 if i == 1 else 0, 0, 0))
        boards.append((b, ((x0 + x1) / 2, 0, H - t / 2 + dz)))
    # apron + legs
    inset = 0.07
    ah = 0.1
    leg = 0.075
    lx, ly = W / 2 - inset - leg / 2, D / 2 - inset - leg / 2
    for sy in (-1, 1):
        P.box((2 * lx - leg, 0.024, ah), (0, sy * (ly + leg / 2 - 0.016), H - t - ah / 2), wood, bevel=0.004,
              name='apron')
    for sx in (-1, 1):
        P.box((0.024, 2 * ly - leg, ah), (sx * (lx + leg / 2 - 0.016), 0, H - t - ah / 2), wood, bevel=0.004,
              grain='y', name='apron')
    for sx in (-1, 1):
        for sy in (-1, 1):
            J.turned_leg(P, sx * lx, sy * ly, H - t, wood, block=leg, block_h=ah + 0.02, segs=10)
    # finger trails dragged through the dust on the left board + a palm wipe on the right
    trails = []
    b0, o0 = boards[0]
    for k in range(4):
        pts = []
        for i in range(9):
            u = i / 8
            pts.append((-1.05 + 0.6 * u + 0.02 * k * (1 - u), -0.25 + 0.03 * k + 0.22 * math.sin(u * 2.2) - 0.1 * u))
        trails.append(P.ribbon(b0, pts, 0.014, H + 0.0006, wiped, o0))
    b2, o2 = boards[2]
    for k in range(3):  # a smeared palm wipe: overlapping soft strokes
        pts = [(0.62 + 0.03 * k + 0.035 * i, 0.22 - 0.08 * i + 0.015 * math.sin(i * 1.7 + k)) for i in range(7)]
        trails.append(P.ribbon(b2, pts, 0.035 - 0.008 * k, H + 0.0006 + 0.0001 * k, smear, o2))
    P.decal_group([b0, b2], trails, ext=0.004)
    P.finish(tex=1024, max_tris=3000, fit=(W, H, D), preview_yaw=30, preview_pitch=25)


def build_table_small():
    """Farmhouse kitchen table: scrubbed pine top, chipped cream paint base, one drawer."""
    P = F.Piece('table_small', seed=13)
    pine = F.mat_wood('small_pine', hexc('9a8462'), hexc('5c4630'), finish=0.75, ring=0.012, figure=1.0, pores=0.4,
                      dust=0.7, grime=0.9, wear=0.4, raw=hexc('b09a76'), scratch=0.9, stains=0.8, rings=0.6,
                      burn=0.6, seed=2.0, bevel_r=0.005, tone=0.3)
    paint = F.mat_paint('small_paint', hexc('b5ab8c'), hexc('5c4630'), gloss=0.45, chip=0.7, flake=0.8,
                        layer2=hexc('5d6b55'), dust=0.6, grime=0.9, tide=0.09, seed=3.0, edge_chip=0.5)
    inner = J.interior('small_inside')
    knob = F.mat_wood('small_knob', hexc('6a4a30'), hexc('3a2414'), finish=0.4, dust=0.3, wear=0.9)
    W, D, H = 0.6, 0.8, 0.75
    t = 0.03
    P.box((W, D, t), (0, 0, H - t / 2), pine, bevel=0.006, segs=2, name='top', grain='y')
    leg = 0.05
    ah = 0.11
    lx, ly = W / 2 - 0.045, D / 2 - 0.045
    for sx in (-1, 1):
        for sy in (-1, 1):
            J.taper_leg(P, sx * lx, sy * ly, H - t, H - t, paint, top=leg, bot=0.032)
    # aprons; the front (+Y) one has a drawer opening
    P.box((2 * lx - leg, 0.02, ah), (0, -(ly + leg / 2 - 0.012), H - t - ah / 2), paint, bevel=0.003, name='apron')
    for sx in (-1, 1):
        P.box((0.02, 2 * ly - leg, ah), (sx * (lx + leg / 2 - 0.012), 0, H - t - ah / 2), paint, bevel=0.003,
              grain='y', name='apron')
    fy = ly + leg / 2 - 0.022
    dw = 2 * lx - leg - 0.03
    P.box((2 * lx - leg, 0.02, 0.012), (0, fy + 0.01, H - t - 0.006), paint, bevel=0.002, name='rail')
    P.box((2 * lx - leg, 0.02, 0.014), (0, fy + 0.01, H - t - ah + 0.007), paint, bevel=0.002, name='rail')
    J.drawer(P, 0, fy, H - t - ah / 2, dw, ah - 0.03, paint, inside=inner, kind='knob', hw=knob, open_=0.05,
             depth=0.5, t=0.02)
    P.finish(tex=512, max_tris=2500, fit=(W, H, D), preview_yaw=35, preview_pitch=22)


def build_table_coffee():
    """Mid-century walnut coffee table: rounded-corner top, splayed round legs with brass ferrules."""
    P = F.Piece('table_coffee', seed=14)
    wood = J.walnut('coffee_walnut', seed=4.0, rings=1.2, burn=0.8, stains=0.5, peel=0.4)
    brass = J.brass('coffee_brass')
    W, D, H = 1.2, 0.6, 0.45
    t = 0.03
    # rounded-rectangle top (prism of the outline, extruded along Z)
    r = 0.09
    pts = []
    for cx, cy, a0 in ((W / 2 - r, D / 2 - r, 0), (-W / 2 + r, D / 2 - r, 90), (-W / 2 + r, -D / 2 + r, 180),
                       (W / 2 - r, -D / 2 + r, 270)):
        for i in range(5):
            a = math.radians(a0 + 90 * i / 4)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    verts = [(x, y, H - t) for x, y in pts] + [(x, y, H) for x, y in pts]
    n = len(pts)
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    P.mesh(verts, faces, (0, 0, 0), wood, name='top', bevel=0.005)
    # apron ring under the top
    ah = 0.06
    for sy in (-1, 1):
        P.box((W - 0.34, 0.02, ah), (0, sy * (D / 2 - 0.09), H - t - ah / 2), wood, bevel=0.003, name='apron')
    for sx in (-1, 1):
        P.box((0.02, D - 0.2, ah), (sx * (W / 2 - 0.16), 0, H - t - ah / 2), wood, bevel=0.003, grain='y',
              name='apron')
    # magazine shelf
    P.box((W - 0.36, D - 0.24, 0.016), (0, 0, 0.13), wood, bevel=0.003, name='shelf')
    for sx in (-1, 1):
        for sy in (-1, 1):
            J.round_leg(P, sx * (W / 2 - 0.15), sy * (D / 2 - 0.1), H - t, H - t, wood, ferrule=brass, r_top=0.022,
                        r_bot=0.012, splay=9)
    P.finish(tex=1024, max_tris=2500, fit=(W, H, D), preview_yaw=30, preview_pitch=28)


def build_desk():
    """Double-pedestal oak desk with a worn leatherette writing surface; one drawer pulled out."""
    P = F.Piece('desk', seed=15)
    wood = J.oak('desk_oak', seed=6.0, rings=0.5, stains=0.4, peel=0.2)
    inner = J.interior('desk_inside')
    brass = J.brass('desk_brass')
    leather = F.mat_plain('desk_leather', hexc('2c3626'), 0.6, dust=0.7, grime=0.9, noise_amt=0.5, wear=0.8,
                          bevel_r=0.004)
    W, D, H = 1.6, 0.8, 0.76
    t = 0.03
    P.box((W, D, t), (0, 0, H - t / 2), wood, bevel=0.006, segs=2, name='top')
    P.box((W - 0.2, D - 0.2, 0.003), (0, 0.02, H + 0.0006), leather, bevel=0.0015, name='inlay', skip=('-z',))
    pw = 0.42
    ph = H - t - 0.08
    base = 0.07
    for sx in (-1, 1):
        cx = sx * (W / 2 - pw / 2 - 0.02)
        # pedestal carcass
        for s2 in (-1, 1):
            P.box((0.02, D - 0.06, ph), (cx + s2 * (pw / 2 - 0.01), -0.01, H - t - ph / 2), wood, bevel=0.003,
                  grain='z', name='pside')
        P.box((pw, D - 0.08, 0.02), (cx, -0.01, H - t - ph + 0.01), wood, bevel=0.002, name='pbottom')
        P.box((pw - 0.04, 0.012, ph), (cx, -D / 2 + 0.04, H - t - ph / 2), wood, bevel=0.002, name='pback')
        # plinth
        P.box((pw + 0.02, D - 0.04, base), (cx, -0.01, base / 2), wood, bevel=0.004, name='plinth')
        # three drawers (top one smaller)
        hs = [0.15, 0.2, 0.2]
        z = H - t - 0.01
        fy = D / 2 - 0.045
        for i, hh in enumerate(hs):
            zc = z - hh / 2
            opn = 0.18 if (sx > 0 and i == 1) else (0.015 if (sx < 0 and i == 2) else 0.0)
            J.drawer(P, cx, fy, zc, pw - 0.04, hh, wood, inside=inner, kind='bail', hw=brass, open_=opn,
                     depth=0.6, warp=0.4 if (sx < 0 and i == 0) else 0.0)
            z -= hh
    # center drawer + modesty panel
    cw = W - 2 * (pw + 0.02) - 0.04
    J.drawer(P, 0, D / 2 - 0.045, H - t - 0.05, cw, 0.08, wood, inside=inner, kind='bar', hw=brass, open_=0.0)
    P.box((cw + 0.04, 0.018, 0.4), (0, -D / 2 + 0.06, H - t - 0.2 - 0.06), wood, bevel=0.003, name='modesty')
    P.finish(tex=1024, max_tris=2500, fit=(W, H, D), preview_yaw=30, preview_pitch=18)
