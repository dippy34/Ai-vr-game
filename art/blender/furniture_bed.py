"""Old painted iron double bed with stained mattress, rumpled sheet and pillow (furniture_bed).
Helper module: build() is a no-op (see furniture.py)."""

from __future__ import annotations

import math

import furniture_lib as F
from furniture_lib import hexc


def build() -> None:
    print('furniture_bed: built through furniture.py')


# mattress layout (shared by the mattress and the sheet that lies on it)
MW, ML, MH = 1.42, 1.92, 0.22
MY = 0.02                   # mattress center Y (head is -Y, foot +Y)
MTOP = 0.60                 # mattress top height (= level box height)
M_SAG = (0.05, 0.34, 0.3)
M_DENT = (0.18, -0.25, 0.035, 0.28)
M_BULGE = 0.014


def _mattress_top(x, y):
    """Approximate top surface height of the mattress (low-poly shape, see cushion.shape)."""
    lx, ly = x, y - MY
    u, v = max(-1.0, min(1.0, lx / (MW / 2))), max(-1.0, min(1.0, ly / (ML / 2)))
    z = MTOP + M_BULGE * (1 - u * u) * (1 - v * v)
    dep, sx, sy = M_SAG
    z -= dep * math.exp(-((lx / (MW * sx)) ** 2 + (ly / (ML * sy)) ** 2))
    dx, dy, dd, rad = M_DENT
    z -= dd * math.exp(-(((lx - dx) ** 2 + (ly - dy) ** 2) / (rad * rad)))
    return z


def build_bed():
    P = F.Piece('bed', seed=3)
    iron = F.mat_paint('bed_iron', hexc('a69e88'), hexc('1e1a17'), gloss=0.55, chip=0.8, flake=1.0,
                       layer2=hexc('4a5248'), rust=1.0, metal_under=0.5, dust=0.6, grime=0.9, bevel_r=0.004,
                       brush=0.0, seed=2.0, edge_chip=0.2, chip_scale=11.0)
    brass = F.mat_metal('bed_brass', hexc('94733a'), rough=0.38, metal=0.85, tarnish=0.75,
                        tarnish_col=hexc('2e2914'), pitting=0.4)
    ticking = F.mat_fabric('bed_mattress', hexc('968c74'), hexc('7a705a'), stripe=(hexc('3e4658'), 0.032, 0.18, 'X'),
                           fade=0.1, stains=2.0, dust=0.5, grime=1.0, wear=0.3, mold=0.9, rust_spots=1.0, seed=3.0,
                           foam=hexc('7a6a48'), use_col=hexc('6a5224'))
    sheet_m = F.mat_fabric('bed_sheet', hexc('9a958a'), hexc('7f7a6e'), fade=0.1, stains=1.3, dust=0.6, grime=1.0,
                           wear=0.1, seed=6.0, weave=0.6, mold=0.4)
    pillow_m = F.mat_fabric('bed_pillow', hexc('a49a80'), hexc('8a7f66'), fade=0.1, stains=1.0, dust=0.5,
                            grime=1.0, wear=0.1, seed=9.0, weave=0.5)
    spring_m = F.mat_wiremesh('bed_spring')

    W2 = 0.78                    # half width at the post centers
    YH, YF = -1.03, 1.03         # head / foot post Y
    pr = 0.021                   # post radius
    # posts with cup feet and brass finials
    for (y, top) in ((YH, 1.24), (YF, 0.94)):
        for sx in (-1, 1):
            x = sx * W2
            P.tube([(x, y, 0.045), (x, y, top)], pr, iron, segs=8, name='post', caps=(False, False))
            P.lathe([(0.0, 0.0), (0.028, 0.0), (0.03, 0.012), (0.024, 0.03), (pr + 0.002, 0.05)], (x, y, 0), iron,
                    segs=8, cap_top=False, name='foot')
            P.lathe([(pr + 0.003, 0.0), (pr + 0.006, 0.012), (0.03, 0.03), (0.036, 0.05), (0.03, 0.072),
                     (0.012, 0.085), (0.0, 0.088)], (x, y, top - 0.004), brass, segs=8, cap_top=False, name='finial')
            # brass collar where the top rail meets the post
            P.lathe([(pr + 0.001, 0.0), (pr + 0.007, 0.006), (pr + 0.007, 0.022), (pr + 0.001, 0.028)],
                    (x, y, top - 0.11), brass, segs=8, cap_top=False, name='collar')
    # headboard: arched top rail, lower rail, spindles
    def arch(z0, rise, y, n=7):
        pts = []
        for i in range(n):
            t = i / (n - 1)
            x = -W2 + 2 * W2 * t
            pts.append((x, y, z0 + rise * math.sin(math.pi * t) ** 1.5))
        return pts
    top_pts = arch(1.13, 0.05, YH)
    P.tube(top_pts, 0.016, iron, segs=8, name='rail', caps=(False, False))
    P.tube([(-W2, YH, 0.44), (W2, YH, 0.44)], 0.014, iron, segs=8, name='rail', caps=(False, False))
    n_sp = 11
    for i in range(1, n_sp + 1):
        t = i / (n_sp + 1)
        x = -W2 + 2 * W2 * t
        zt = 1.13 + 0.05 * math.sin(math.pi * t) ** 1.5
        P.tube([(x, YH, 0.44), (x, YH, zt)], 0.0075, iron, segs=6, name='spindle', caps=(False, False))
        if i in (3, 6, 9):
            P.lathe([(0.008, 0.0), (0.016, 0.02), (0.019, 0.045), (0.016, 0.07), (0.008, 0.09)],
                    (x, YH, 0.80), brass, segs=8, cap_top=False, name='bead')
    # footboard
    P.tube([(-W2, YF, 0.86), (W2, YF, 0.86)], 0.016, iron, segs=8, name='rail', caps=(False, False))
    P.tube([(-W2, YF, 0.44), (W2, YF, 0.44)], 0.014, iron, segs=8, name='rail', caps=(False, False))
    n_sp = 7
    for i in range(1, n_sp + 1):
        x = -W2 + 2 * W2 * i / (n_sp + 1)
        P.tube([(x, YF, 0.44), (x, YF, 0.86)], 0.0075, iron, segs=6, name='spindle', caps=(False, False))
    # side rails (angle iron) + link-spring panel
    for sx in (-1, 1):
        x = sx * (W2 - 0.005)
        P.box((0.005, YF - YH - 0.04, 0.055), (x, 0, 0.335), iron, bevel=0.0, name='siderail', grain='y')
        P.box((0.04, YF - YH - 0.04, 0.005), (x - sx * 0.02, 0, 0.31), iron, bevel=0.0, name='siderail', grain='y')
    P.box((MW + 0.04, ML + 0.04, 0.02), (0, MY, 0.355), spring_m, bevel=0.003, name='spring', skip=('-z',))
    # mattress (quilted, sagging, body dent, a tear)
    tufts = []
    for i in range(4):
        for j in range(7):
            tufts.append((-MW / 2 + MW * (i + 0.5) / 4, -ML / 2 + ML * (j + 0.5) / 7))
    P.cushion((MW, ML, MH), (0, MY, MTOP - MH / 2), ticking, radius=0.06, bulge=(0.008, 0.008, M_BULGE),
              sag=M_SAG, dents=[M_DENT], wrinkle=0.005, piping=0.005, tufts=tufts, lowres=(3, 4, 0),
              skip_bottom=True, flat_bottom=True, seed=41, name='mattress',
              tears=[(0.5, 0.75, 0.09)], use=[(0.05, 0.1, 0.42), (-0.3, -0.6, 0.25)])
    # pillow, squashed against the headboard
    P.cushion((0.62, 0.38, 0.13), (-0.28, YH + 0.3, _mattress_top(-0.28, YH + 0.3) + 0.045), pillow_m,
              rot=(-8, 4, 9), radius=0.06, bulge=(0.02, 0.03, 0.035), wrinkle=0.008, piping=0.0, lowres=(1, 1, 0),
              seed=43, name='pillow', dents=[(0.05, 0.0, 0.04, 0.12)], skip_bottom=False)
    # rumpled sheet: lies over most of the mattress and hangs down the left side
    hang = 0.45
    arc_r = 0.09
    x_edge = -MW / 2 - 0.005
    top_len = 1.2

    def sheet_fn(u, v):
        y = -0.62 + v * 1.55 + 0.06 * math.sin(u * 5.0 + 1.0) * v
        # u: 0..0.35 hanging, 0.35..0.45 arc over the edge, 0.45..1 on top
        if u < 0.35:
            t = u / 0.35
            drop = hang * (1 - t)
            fold = 0.03 * math.sin(y * 17.0 + 0.6) * (1 - t) + 0.012 * math.sin(y * 41.0) * (1 - t)
            return (x_edge - arc_r - 0.008 + fold - 0.015 * (1 - t), y, MTOP - 0.04 - drop)
        if u < 0.45:
            t = (u - 0.35) / 0.1
            a = math.pi * (1.0 - 0.5 * t)  # from pointing -X (down side) to up
            cx, cz = x_edge, MTOP - 0.04
            return (cx + math.cos(a) * (arc_r + 0.008), y, cz + math.sin(a) * (arc_r + 0.008) * 1.0 + 0.0)
        t = (u - 0.45) / 0.55
        x = x_edge + t * top_len
        bunch = 0.025 * math.exp(-((t - 0.92) / 0.08) ** 2) * (1.0 + 0.6 * math.sin(y * 9.0))
        return (x, y, _mattress_top(x, y) + 0.012 + bunch + 0.01 * math.sin(x * 11 + y * 5))

    P.sheet(sheet_fn, 16, 11, (0, 0, 0), sheet_m, hi_mult=7, thickness=0.0, folds=0.012, seed=5, name='sheet',
            ext=0.045)
    P.finish(tex=1024, max_tris=3000, fit=(1.6, MTOP, 2.1), preview_yaw=40, preview_pitch=22)
