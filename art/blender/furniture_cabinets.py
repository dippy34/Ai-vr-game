"""Case furniture: wardrobe, Hoosier kitchen cupboard, dresser, nightstand. Helper module (no-op build)."""

from __future__ import annotations

import math

import furniture_lib as F
import furniture_parts as J
from furniture_lib import hexc


def build() -> None:
    print('furniture_cabinets: built through furniture.py')


def build_cabinet_tall():
    """1950s walnut wardrobe: two raised-panel doors (left one ajar), two drawers, plinth, cornice."""
    P = F.Piece('cabinet_tall', seed=21)
    wood = J.walnut('wardrobe_walnut', seed=2.0, peel=0.45, crack=0.35)
    inner = J.interior('wardrobe_inside')
    brass = J.brass('wardrobe_brass')
    iron = F.mat_metal('wardrobe_wire', hexc('5a5550'), rough=0.5, metal=0.7, rust=0.6, tarnish=0.4)
    mirror = F.mat_mirror('wardrobe_mirror', seed=3.0)
    W, H, D = 1.4, 2.0, 0.6
    side = 0.022
    zp = 0.1                    # plinth top
    ztop = H - 0.07             # carcass top
    fy = D / 2 - 0.03           # front plane of the carcass (doors sit on it)
    # plinth + cornice
    P.box((W - 0.03, D - 0.05, zp), (0, -0.01, zp / 2), wood, bevel=0.004, name='plinth')
    P.box((W, D - 0.02, 0.02), (0, -0.0, zp + 0.01), wood, bevel=0.004, segs=2, name='plinthcap')
    P.box((W - 0.01, D - 0.03, 0.03), (0, -0.01, ztop + 0.015), wood, bevel=0.004, name='top')
    P.box((W + 0.03, D + 0.0, 0.025), (0, 0.0, ztop + 0.03 + 0.0125), wood, bevel=0.006, segs=2, name='cornice')
    P.box((W + 0.01, D - 0.02, 0.015), (0, -0.01, H - 0.0075), wood, bevel=0.004, name='cornice2')
    # sides (interior face darker) + back
    for sx in (-1, 1):
        mats = {'default': wood, ('+x' if sx < 0 else '-x'): inner}
        P.box((side, D - 0.04, ztop - zp - 0.02), (sx * (W / 2 - side / 2 - 0.005), -0.02, (ztop + zp + 0.02) / 2),
              mats, bevel=0.003, grain='z', name='side')
    P.box((W - 0.05, 0.008, ztop - zp), (0, -D / 2 + 0.02, (ztop + zp) / 2), {'default': inner, '-y': wood},
          bevel=0.0, name='back')
    # drawers (bottom) + mid rail
    zd0, zd1 = zp + 0.02, zp + 0.28
    dw = (W - 2 * side - 0.03) / 2
    for i, sx in enumerate((-1, 1)):
        J.drawer(P, sx * (dw / 2 + 0.005), fy, (zd0 + zd1) / 2, dw, zd1 - zd0, wood, inside=inner, kind='bail',
                 hw=brass, open_=0.06 if i == 1 else 0.0, depth=0.5)
    P.box((W - 2 * side - 0.01, D - 0.06, 0.022), (0, -0.01, zd1 + 0.011), {'default': wood, '+z': inner},
          bevel=0.003, name='midrail')
    # interior: hat shelf, hanging rod, a wire hanger
    zs = 1.62
    P.box((W - 2 * side - 0.02, D - 0.1, 0.02), (0, -0.04, zs), inner, bevel=0.003, name='hatshelf')
    P.cyl(0.013, W - 2 * side - 0.03, (-(W - 2 * side - 0.03) / 2, -0.03, zs - 0.07), iron, rot=(0, 90, 0), segs=8,
          caps=(False, False), name='rod')
    hx = -0.32
    hz = zs - 0.07
    hook = [(hx, -0.03, hz + 0.02), (hx + 0.012, -0.03, hz + 0.022), (hx + 0.016, -0.03, hz + 0.008),
            (hx + 0.006, -0.03, hz - 0.012), (hx, -0.03, hz - 0.03)]
    body = [(hx, -0.03, hz - 0.03), (hx - 0.2, -0.05, hz - 0.21), (hx + 0.2, -0.01, hz - 0.21), (hx, -0.03, hz - 0.03)]
    P.tube(hook + body[1:], 0.0022, iron, segs=4, name='hanger')
    # doors
    zd, zt = zd1 + 0.025, ztop - 0.005
    door_w = (W - 2 * side - 0.016) / 2
    for i, (x0, x1, hinge, ang) in enumerate(((-W / 2 + side + 0.004, -0.004, 'left', 28.0),
                                             (0.004, W / 2 - side - 0.004, 'right', 0.0))):
        J.panel_door(P, x0, x1, zd, zt, fy, wood, t=0.022, stile=0.07, rail=0.09,
                     raised=True if i == 0 else 'mirror', panel_mat=mirror if i else None, hinge=hinge,
                     angle=ang, hw=brass, kind='knob', keyhole=brass)
    P.finish(tex=1024, max_tris=2500, fit=(W, H, D), preview_yaw=32, preview_pitch=12)


def build_cabinet_narrow():
    """Hoosier-style kitchen cupboard: painted base with drawer + door, enamel work top, recessed
    glazed upper cabinet (one pane missing)."""
    P = F.Piece('cabinet_narrow', seed=22)
    paint = F.mat_paint('hoosier_paint', hexc('8f9e86'), hexc('6a5034'), gloss=0.45, chip=0.75, flake=0.9,
                        layer2=hexc('c2b48e'), dust=0.6, grime=0.95, tide=0.1, seed=5.0, grease=0.5, edge_chip=0.5)
    inner = F.mat_paint('hoosier_inside', hexc('b0a68a'), hexc('5a4630'), gloss=0.3, chip=0.3, dust=0.8, grime=1.0,
                        seed=6.0)
    enamel = F.mat_enamel('hoosier_enamel', hexc('d2ccb8'), chip=0.6, rust=0.7, grease=0.6, seed=2.0)
    glass = F.mat_glass('hoosier_glass', tint=hexc('0a0c0a'), dust=0.9)
    chrome = F.mat_metal('hoosier_nickel', hexc('9a968c'), rough=0.3, metal=0.9, tarnish=0.6, rust=0.25,
                         pitting=0.5)
    jar = F.mat_glass('hoosier_jar', tint=hexc('1a2014'), dust=0.6)
    W, H, D = 0.7, 1.9, 0.7
    side = 0.02
    zb = 0.86           # work surface
    leg_h = 0.1
    by = D / 2 - 0.02   # base front plane
    # base carcass on short legs
    for sx in (-1, 1):
        for sy in (-1, 1):
            J.taper_leg(P, sx * (W / 2 - 0.03), sy * (D / 2 - 0.05), leg_h + 0.01, leg_h + 0.01, paint, top=0.045,
                        bot=0.035)
    for sx in (-1, 1):
        P.box((side, D - 0.04, zb - leg_h - 0.02), (sx * (W / 2 - side / 2), -0.02, (zb + leg_h - 0.02) / 2),
              {'default': paint, ('+x' if sx < 0 else '-x'): inner}, bevel=0.003, grain='z', name='side')
    P.box((W - 2 * side, D - 0.06, 0.02), (0, -0.03, leg_h + 0.01), {'default': paint, '+z': inner}, bevel=0.003,
          name='bottom')
    P.box((W - 2 * side, 0.008, zb - leg_h), (0, -D / 2 + 0.024, (zb + leg_h) / 2), {'default': inner, '-y': paint},
          bevel=0.0, name='back')
    # drawer + door
    J.drawer(P, 0, by, zb - 0.09, W - 2 * side - 0.01, 0.13, paint, inside=inner, kind='cup', hw=chrome, open_=0.0)
    P.box((W - 2 * side, 0.02, 0.02), (0, by - 0.01, zb - 0.165), paint, bevel=0.003, name='rail')
    J.panel_door(P, -W / 2 + side + 0.003, W / 2 - side - 0.003, leg_h + 0.03, zb - 0.18, by, paint, t=0.02, stile=0.06,
                 raised=False, hinge='left', angle=6.0, hw=chrome, kind='knob')
    # enamel work surface (pulled out a few cm)
    P.box((W + 0.02, D - 0.02, 0.022), (0, 0.025, zb + 0.011), enamel, bevel=0.005, segs=2, name='worktop')
    P.box((W + 0.024, 0.01, 0.03), (0, D / 2 + 0.02, zb + 0.006), chrome, bevel=0.003, name='worktop_edge')
    # recessed upper section
    ud = 0.32
    uy0 = -D / 2 + 0.02
    uz0 = zb + 0.022
    for sx in (-1, 1):
        P.box((side, ud, H - uz0), (sx * (W / 2 - side / 2), uy0 + ud / 2, (H + uz0) / 2),
              {'default': paint, ('+x' if sx < 0 else '-x'): inner}, bevel=0.003, grain='z', name='uside')
    P.box((W - 2 * side, 0.008, H - uz0), (0, uy0 + 0.004, (H + uz0) / 2), {'default': inner, '-y': paint},
          bevel=0.0, name='uback')
    P.box((W + 0.02, ud + 0.03, 0.03), (0, uy0 + ud / 2 + 0.01, H - 0.015), paint, bevel=0.005, segs=2, name='utop')
    zg = uz0 + 0.24    # bottom of the glazed cabinet
    P.box((W - 2 * side, ud - 0.01, 0.02), (0, uy0 + ud / 2, zg), {'default': paint, '+z': inner}, bevel=0.003,
          name='ubottom')
    P.box((W - 2 * side, ud - 0.03, 0.016), (0, uy0 + ud / 2 - 0.01, zg + 0.3), inner, bevel=0.002, name='ushelf')
    # jars inside (seen through the missing pane)
    for (x, h, r) in ((-0.17, 0.16, 0.045), (-0.05, 0.12, 0.04), (0.12, 0.2, 0.05)):
        P.lathe([(r * 0.85, 0.0), (r, 0.012), (r, h * 0.8), (r * 0.65, h * 0.9), (r * 0.62, h), (0.0, h + 0.004)],
                (x, uy0 + 0.14, zg + 0.01), jar, segs=8, cap_top=False, name='jar')
    # glazed door: 2x3 panes, the middle-left pane gone with a few shards left
    gx0, gx1 = -W / 2 + side + 0.003, W / 2 - side - 0.003
    gz0, gz1 = zg - 0.01, H - 0.035
    fy_u = uy0 + ud
    st = 0.055
    P.box((st, 0.022, gz1 - gz0), (gx0 + st / 2, fy_u + 0.011, (gz0 + gz1) / 2), paint, bevel=0.004, grain='z',
          name='gstile')
    P.box((st, 0.022, gz1 - gz0), (gx1 - st / 2, fy_u + 0.011, (gz0 + gz1) / 2), paint, bevel=0.004, grain='z',
          name='gstile')
    for z in (gz0 + st / 2, gz1 - st / 2):
        P.box((gx1 - gx0 - 2 * st, 0.021, st), (0, fy_u + 0.011, z), paint, bevel=0.004, name='grail')
    ix0, ix1, iz0, iz1 = gx0 + st, gx1 - st, gz0 + st, gz1 - st
    cols, rows = 2, 3
    mw = 0.016
    for i in range(1, cols):
        x = ix0 + (ix1 - ix0) * i / cols
        P.box((mw, 0.016, iz1 - iz0), (x, fy_u + 0.011, (iz0 + iz1) / 2), paint, bevel=0.003, grain='z', name='muntin')
    for j in range(1, rows):
        z = iz0 + (iz1 - iz0) * j / rows
        P.box((ix1 - ix0, 0.016, mw), (0, fy_u + 0.011, z), paint, bevel=0.003, name='muntin')
    for i in range(cols):
        for j in range(rows):
            px0 = ix0 + (ix1 - ix0) * i / cols
            px1 = ix0 + (ix1 - ix0) * (i + 1) / cols
            pz0 = iz0 + (iz1 - iz0) * j / rows
            pz1 = iz0 + (iz1 - iz0) * (j + 1) / rows
            if (i, j) == (0, 1):
                # shards stuck in the corners
                P.prism([(px0, pz0), (px0 + 0.07, pz0), (px0, pz0 + 0.11)], 0.003, (0, fy_u + 0.009, 0), glass,
                        rot=(0, 0, 0), bevel=0.0, name='shard')
                P.prism([(px1, pz1), (px1 - 0.05, pz1), (px1 - 0.012, pz1 - 0.04), (px1, pz1 - 0.08)], 0.003,
                        (0, fy_u + 0.009, 0), glass, bevel=0.0, name='shard')
                continue
            P.box((px1 - px0, 0.003, pz1 - pz0), ((px0 + px1) / 2, fy_u + 0.009, (pz0 + pz1) / 2), glass, bevel=0.0,
                  name='pane')
    J.pull(P, 'knob', gx1 - st / 2, fy_u + 0.022, (gz0 + gz1) / 2, chrome)
    # open bay between work top and the glazed cabinet: a bread board shelf
    P.box((W - 2 * side, 0.2, 0.012), (0, uy0 + 0.11, uz0 + 0.1), inner, bevel=0.002, name='baysh')
    P.finish(tex=1024, max_tris=2500, fit=(W, H, D), preview_yaw=35, preview_pitch=12)


def build_cabinet_low():
    """Mid-century walnut dresser: 2x3 drawers with bar pulls on tapered legs (one drawer open,
    one pull missing), peeling veneer."""
    P = F.Piece('cabinet_low', seed=23)
    wood = J.walnut('dresser_walnut', seed=7.0, peel=0.65, rings=0.8, crack=0.3)
    inner = J.interior('dresser_inside')
    brass = J.brass('dresser_brass')
    W, H, D = 1.4, 0.85, 0.5
    leg_h = 0.17
    t = 0.022
    zb = leg_h
    for sx in (-1, 1):
        for sy in (-1, 1):
            J.round_leg(P, sx * (W / 2 - 0.07), sy * (D / 2 - 0.07), zb + 0.004, zb + 0.004, wood, ferrule=brass,
                        r_top=0.021, r_bot=0.012, splay=6)
    P.box((W, D, t), (0, 0, H - t / 2), wood, bevel=0.005, segs=2, name='top')
    for sx in (-1, 1):
        P.box((t, D - 0.01, H - t - zb), (sx * (W / 2 - t / 2), -0.005, (H - t + zb) / 2), wood, bevel=0.003,
              grain='z', name='side')
    P.box((W - 2 * t, D - 0.02, 0.02), (0, -0.01, zb + 0.01), wood, bevel=0.003, name='bottom')
    P.box((W - 2 * t, 0.008, H - t - zb), (0, -D / 2 + 0.006, (H - t + zb) / 2), wood, bevel=0.0, name='back')
    P.box((0.02, D - 0.03, H - t - zb - 0.02), (0, -0.01, (H - t + zb) / 2), wood, bevel=0.002, grain='z',
          name='divider')
    fy = D / 2 - 0.02
    rows = [0.19, 0.21, 0.21]
    dw = (W - 2 * t - 0.02) / 2
    z = H - t - 0.004
    for r, hh in enumerate(rows):
        zc = z - hh / 2
        for c, sx in enumerate((-1, 1)):
            opn = 0.1 if (r == 1 and c == 0) else 0.0
            hw = None if (r == 2 and c == 1) else brass
            J.drawer(P, sx * (dw / 2 + 0.01), fy, zc, dw, hh, wood, inside=inner, kind='bar', hw=hw, open_=opn,
                     depth=0.45, warp=-0.5 if (r == 0 and c == 1) else 0.0)
        z -= hh
    P.finish(tex=1024, max_tris=2500, fit=(W, H, D), preview_yaw=30, preview_pitch=15)


def build_nightstand():
    """Walnut nightstand: one drawer over an open shelf, tapered legs."""
    P = F.Piece('nightstand', seed=24)
    wood = J.walnut('night_walnut', seed=9.0, peel=0.4, rings=1.0, burn=0.4)
    inner = J.interior('night_inside')
    brass = J.brass('night_brass')
    W, H, D = 0.5, 0.6, 0.5
    leg_h = 0.16
    t = 0.02
    for sx in (-1, 1):
        for sy in (-1, 1):
            J.round_leg(P, sx * (W / 2 - 0.05), sy * (D / 2 - 0.05), leg_h + 0.004, leg_h + 0.004, wood, ferrule=brass,
                        r_top=0.018, r_bot=0.011, splay=6)
    P.box((W, D, t), (0, 0, H - t / 2), wood, bevel=0.005, segs=2, name='top')
    for sx in (-1, 1):
        P.box((t, D - 0.01, H - t - leg_h), (sx * (W / 2 - t / 2), -0.005, (H - t + leg_h) / 2),
              {'default': wood, ('+x' if sx < 0 else '-x'): inner}, bevel=0.003, grain='z', name='side')
    P.box((W - 2 * t, D - 0.02, 0.018), (0, -0.01, leg_h + 0.009), {'default': wood, '+z': inner}, bevel=0.003,
          name='bottom')
    P.box((W - 2 * t, D - 0.03, 0.016), (0, -0.015, H - t - 0.17), {'default': wood, '+z': inner}, bevel=0.003,
          name='shelf')
    P.box((W - 2 * t, 0.008, H - t - leg_h), (0, -D / 2 + 0.006, (H - t + leg_h) / 2), {'default': inner, '-y': wood},
          bevel=0.0, name='back')
    J.drawer(P, 0, D / 2 - 0.02, H - t - 0.085, W - 2 * t, 0.15, wood, inside=inner, kind='knob', hw=brass,
             open_=0.04, depth=0.42)
    P.finish(tex=512, max_tris=2500, fit=(W, H, D), preview_yaw=35, preview_pitch=18)
