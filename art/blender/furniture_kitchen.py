"""
Kitchen modules, all exactly 0.6 W x 0.9 H(work top) x 0.6 D and tileable along X:
  counter_module (base cabinet + laminate top), counter_sink (enamel sink + bridge faucet),
  counter_stove (1950s enamel gas range; its backguard rises above the 0.9 m work top).
Countertop/toe-kick materials are periodic in X (period 0.6 m), so neighbours join seamlessly.
Helper module: build() is a no-op (see furniture.py).
"""

from __future__ import annotations

import math

import furniture_lib as F
import furniture_parts as J
from furniture_lib import hexc

W, H, D = 0.6, 0.9, 0.6
TOP_T = 0.035
TOE_H, TOE_D = 0.1, 0.07
FY = D / 2 - 0.025          # carcass front plane (doors sit on it)
PERIOD = W


def build() -> None:
    print('furniture_kitchen: built through furniture.py')


def _mats(seed=0.0):
    paint = F.mat_paint('kitchen_paint', hexc('c2b896'), hexc('6a5034'), gloss=0.5, chip=0.6, flake=0.8,
                        layer2=hexc('8fa088'), dust=0.55, grime=1.0, tide=0.1, seed=seed, grease=0.7, edge_chip=0.45)
    inner = F.mat_paint('kitchen_inside', hexc('9a9078'), hexc('4a3a28'), gloss=0.3, chip=0.2, dust=0.5, grime=1.0,
                        seed=seed + 1)
    kick = F.mat_paint('kitchen_kick', hexc('2a2622'), hexc('4a3a28'), gloss=0.4, chip=0.4, dust=0.3, grime=1.0,
                       period=PERIOD, brush=0.0, seed=seed + 2)
    lam = F.mat_laminate('kitchen_laminate', hexc('8fa69a'), [hexc('3a4440'), hexc('d6d2c0'), hexc('6a7a72')],
                         period=PERIOD, stains=0.7, burn=0.6, chip=0.5, seed=seed)
    trim = F.mat_metal('kitchen_trim', hexc('9a9a96'), rough=0.35, metal=0.9, tarnish=0.5, pitting=0.4,
                       brushed=0.6, period=PERIOD)
    chrome = F.mat_metal('kitchen_chrome', hexc('a8a8a4'), rough=0.22, metal=1.0, tarnish=0.45, rust=0.25,
                         pitting=0.6)
    return paint, inner, kick, lam, trim, chrome


def _carcass(P, paint, inner, kick, chrome, door_open=0.0, drawer=True, false_drawer=False):
    side = 0.018
    zt = H - TOP_T
    # sides with a toe-kick notch (outline in the YZ plane, extruded along X)
    prof = [(-D / 2 + 0.02, 0.0), (FY - TOE_D, 0.0), (FY - TOE_D, TOE_H), (FY, TOE_H), (FY, zt),
            (-D / 2 + 0.02, zt)]
    for sx in (-1, 1):
        P.prism([(y, z) for y, z in prof], side, (sx * (W / 2 - side / 2), 0, 0), {'default': paint}, rot=(0, 0, 90),
                bevel=0.002, name='side', grain='y')
    P.box((W, 0.016, TOE_H), (0, FY - TOE_D - 0.008, TOE_H / 2), kick, bevel=0.002, name='kick')
    P.box((W - 2 * side, D - 0.06, 0.018), (0, -0.015, TOE_H + 0.009), {'default': inner, '-z': paint}, bevel=0.002,
          name='bottom')
    P.box((W - 2 * side, 0.008, zt - TOE_H), (0, -D / 2 + 0.024, (zt + TOE_H) / 2), {'default': inner, '-y': paint},
          bevel=0.0, name='back')
    # face frame: stiles + rails
    st = 0.035
    for sx in (-1, 1):
        P.box((st, 0.02, zt - TOE_H), (sx * (W / 2 - st / 2), FY - 0.01, (zt + TOE_H) / 2), paint, bevel=0.003,
              grain='z', name='stile')
    P.box((W - 2 * st, 0.02, 0.03), (0, FY - 0.01, zt - 0.015), paint, bevel=0.003, name='rail')
    zr = zt - 0.17
    P.box((W - 2 * st, 0.02, 0.03), (0, FY - 0.01, zr), paint, bevel=0.003, name='rail')
    P.box((W - 2 * st, 0.02, 0.02), (0, FY - 0.01, TOE_H + 0.01), paint, bevel=0.003, name='rail')
    # drawer (or false front) + door with butterfly hinges
    dw = W - 2 * st + 0.016
    if drawer or false_drawer:
        J.drawer(P, 0, FY, (zt - 0.03 + zr + 0.015) / 2, dw, zt - 0.03 - zr - 0.015 + 0.016, paint, inside=inner,
                 kind='bar', hw=chrome, open_=0.0, t=0.019, lip=0.004)
    z0, z1 = TOE_H + 0.012, zr - 0.017
    x0, x1 = -dw / 2, dw / 2
    objs = J.panel_door(P, x0 + 0.004, x1 - 0.004, z0, z1, FY, paint, t=0.019, stile=0.07, raised=False,
                        hinge='left', angle=door_open, hw=chrome, kind='bar')
    for zz in (z0 + 0.06, z1 - 0.06):
        h = P.box((0.035, 0.002, 0.05), (x0 + 0.02, FY + 0.019 + 0.001, zz), chrome, bevel=0.0008, name='hinge')
        if door_open:
            from furniture_lib import _xf
            h.data.transform(_xf((0, 0, 0), (0, 0, door_open), pivot=(x0 + 0.004, FY + 0.019, 0)))
    return zt


def _top(P, lam, trim, hole=None):
    """Laminate top overhanging the front; `hole` = (x0, x1, y0, y1) cut-out for a sink."""
    zt = H - TOP_T
    y0, y1 = -D / 2, D / 2 - 0.006
    if hole is None:
        P.box((W, y1 - y0, TOP_T), (0, (y0 + y1) / 2, zt + TOP_T / 2), lam, bevel=0.003, name='top')
    else:
        hx0, hx1, hy0, hy1 = hole
        P.box((W, hy0 - y0, TOP_T), (0, (y0 + hy0) / 2, zt + TOP_T / 2), lam, bevel=0.003, name='top')
        P.box((W, y1 - hy1, TOP_T), (0, (hy1 + y1) / 2, zt + TOP_T / 2), lam, bevel=0.003, name='top')
        for (a, b) in ((-W / 2, hx0), (hx1, W / 2)):
            P.box((b - a, hy1 - hy0, TOP_T), ((a + b) / 2, (hy0 + hy1) / 2, zt + TOP_T / 2), lam, bevel=0.003,
                  name='top')
    # ribbed aluminum edge band
    P.box((W, 0.006, TOP_T + 0.004), (0, y1 + 0.003, zt + TOP_T / 2), trim, bevel=0.0015, name='trim')


def build_counter_module():
    P = F.Piece('counter_module', seed=41)
    paint, inner, kick, lam, trim, chrome = _mats(1.0)
    _carcass(P, paint, inner, kick, chrome, door_open=0.0)
    _top(P, lam, trim)
    P.finish(tex=1024, tileable=True, max_tris=2500, fit=(W, H, D), preview_yaw=30, preview_pitch=20)


def build_counter_sink():
    P = F.Piece('counter_sink', seed=42)
    paint, inner, kick, lam, trim, chrome = _mats(2.0)
    enamel = F.mat_enamel('sink_enamel', hexc('cfc9b6'), chip=0.55, rust=0.9, grease=0.7, seed=4.0)
    rust = F.mat_enamel('sink_rust', hexc('7a4a24'), chip=0.2, rust=1.0, grease=0.9, seed=5.0, gloss=0.6)
    pipe = F.mat_metal('sink_pipe', hexc('4a4640'), rough=0.6, metal=0.7, rust=0.8, tarnish=0.6)
    zt = _carcass(P, paint, inner, kick, chrome, door_open=24.0, drawer=False, false_drawer=True)
    hx0, hx1, hy0, hy1 = -0.21, 0.21, -0.18, 0.2
    _top(P, lam, trim, hole=(hx0, hx1, hy0, hy1))
    # enamel basin: rim + inside-out bowl + drain
    depth = 0.17
    P.box((hx1 - hx0 + 0.04, hy1 - hy0 + 0.04, 0.012), (0, (hy0 + hy1) / 2, H + 0.004), enamel, bevel=0.005, segs=2,
          name='rim', skip=('-z',))
    bowl = P.box((hx1 - hx0, hy1 - hy0, depth), (0, (hy0 + hy1) / 2, H - depth / 2 + 0.008), enamel, bevel=0.03,
                 segs=2, name='bowl', skip=('+z',), flip=True)
    P.cyl(0.035, 0.003, (0, (hy0 + hy1) / 2 + 0.02, H - depth + 0.0085), chrome, segs=10, name='drain')
    # P-trap under the sink (seen through the open door)
    yc = (hy0 + hy1) / 2 + 0.02
    P.tube([(0, yc, H - depth), (0, yc, H - depth - 0.15), (0, yc - 0.02, H - depth - 0.22),
            (0, yc - 0.08, H - depth - 0.24), (0, yc - 0.14, H - depth - 0.2), (0, yc - 0.15, H - depth - 0.12),
            (0, -D / 2 + 0.03, H - depth - 0.12)], 0.02, pipe, segs=8, name='trap')
    # bridge faucet at the back: two handles, a gooseneck spout
    by = hy0 - 0.045
    for sx in (-1, 1):
        P.cyl(0.018, 0.04, (sx * 0.1, by, H), chrome, segs=8, name='valve')
        P.lathe([(0.004, 0.0), (0.012, 0.004), (0.02, 0.012), (0.016, 0.02), (0.0, 0.024)], (sx * 0.1, by, H + 0.04),
                chrome, segs=6, cap_top=False, name='handle')
        for a in range(4):
            ang = math.radians(45 + a * 90)
            P.box((0.045, 0.008, 0.008), (sx * 0.1 + 0.018 * math.cos(ang), by + 0.018 * math.sin(ang), H + 0.055),
                  chrome, rot=(0, 0, math.degrees(ang)), bevel=0.002, name='spoke')
    P.tube([(-0.1, by, H + 0.025), (0.1, by, H + 0.025)], 0.011, chrome, segs=8, name='bridge')
    sp = [(0.0, by, H + 0.025), (0.0, by, H + 0.13), (0.0, by + 0.04, H + 0.17), (0.0, by + 0.09, H + 0.15),
          (0.0, by + 0.11, H + 0.11)]
    P.tube(sp, 0.009, chrome, segs=8, name='spout')
    # rust trail from the spout down to the drain (decal on the bowl)
    trail = []
    for k in range(2):
        pts = [(0.0 + 0.01 * k, by + 0.11 + 0.01 * k), (0.004, 0.0), (0.0 - 0.01 * k, 0.03)]
        verts = []
        faces = []
        steps = 10
        for i in range(steps + 1):
            t = i / steps
            y = (by + 0.12) + (yc - (by + 0.12)) * t
            w = 0.03 * (0.4 + 0.6 * math.sin(math.pi * min(1.0, t * 1.1)))
            x = 0.012 * math.sin(t * 5.0 + k) + 0.02 * k
            z = H - depth + 0.0095
            verts += [(x - w / 2, y, z), (x + w / 2, y, z)]
        for i in range(steps):
            faces.append((2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2))
        trail.append(P.decal_like(bowl, verts, faces, rust, (0, 0, 0), name='rust'))
    P.decal_group([bowl], trail, ext=0.003)
    P.finish(tex=1024, tileable=True, max_tris=2500, fit=(W, H, D), preview_yaw=25, preview_pitch=35)


def build_counter_stove():
    """1950s apartment gas range in cream enamel with chrome trim, oven window, four burners."""
    P = F.Piece('counter_stove', seed=43)
    enamel = F.mat_enamel('stove_enamel', hexc('d4ccb4'), chip=0.6, rust=0.8, grease=0.9, seed=6.0)
    black = F.mat_enamel('stove_black', hexc('1a1816'), chip=0.3, rust=0.6, grease=0.6, seed=7.0, gloss=0.5)
    iron = F.mat_metal('stove_iron', hexc('2a2622'), rough=0.75, metal=0.6, tarnish=0.4, rust=0.7, pitting=0.0)
    chrome = F.mat_metal('stove_chrome', hexc('a8a8a4'), rough=0.2, metal=1.0, tarnish=0.5, rust=0.3, pitting=0.6)
    glass = F.mat_glass('stove_glass', tint=hexc('0a0806'), dust=0.8, grime=1.0)
    burnt = F.mat_enamel('stove_burnt', hexc('4a3018'), chip=0.2, rust=0.5, grease=1.0, seed=8.0, gloss=0.6)
    zt = H
    body_y0, body_y1 = -D / 2 + 0.01, D / 2 - 0.02
    # body (rounded vertical corners), recessed black plinth
    P.box((W - 0.004, body_y1 - body_y0, zt - 0.07 - 0.015), (0, (body_y0 + body_y1) / 2, 0.07 + (zt - 0.085) / 2),
          enamel, bevel=0.012, segs=2, name='body')
    P.box((W - 0.04, body_y1 - body_y0 - 0.05, 0.07), (0, (body_y0 + body_y1) / 2 - 0.02, 0.035), black, bevel=0.004,
          name='plinth')
    # cooktop + chrome edge
    P.box((W, D - 0.02, 0.015), (0, -0.0, zt - 0.0075), enamel, bevel=0.005, segs=2, name='cooktop')
    P.box((W + 0.004, 0.012, 0.018), (0, D / 2 - 0.016, zt - 0.009), chrome, bevel=0.003, name='edge')
    # burners: cap + crossed iron grate + burnt ring decals
    rings = []
    for (bx, byy) in ((-0.145, 0.12), (0.145, 0.12), (-0.145, -0.15), (0.145, -0.15)):
        P.cyl(0.042, 0.012, (bx, byy, zt), iron, segs=10, name='burner')
        P.cyl(0.022, 0.008, (bx, byy, zt + 0.012), black, segs=8, name='cap')
        for a in (45, -45):
            P.box((0.2, 0.012, 0.016), (bx, byy, zt + 0.028), iron, rot=(0, 0, a), bevel=0.002, name='grate')
        for a in range(4):
            ang = math.radians(a * 90)
            P.box((0.012, 0.012, 0.03), (bx + 0.09 * math.cos(ang), byy + 0.09 * math.sin(ang), zt + 0.015), iron,
                  bevel=0.002, name='gratefoot')
        verts, faces = [], []
        n = 12
        for i in range(n):
            a = 2 * math.pi * i / n
            for rr in (0.045, 0.085 + 0.012 * math.sin(a * 3 + bx * 10)):
                verts.append((bx + rr * math.cos(a), byy + rr * math.sin(a), zt + 0.0006))
        for i in range(n):
            j = (i + 1) % n
            faces.append((2 * i, 2 * j, 2 * j + 1, 2 * i + 1))
        rings.append((verts, faces))
    top_obj = P.hard[-1]
    # control panel (front apron) with four knobs
    P.box((W - 0.03, 0.01, 0.07), (0, body_y1 + 0.003, zt - 0.06), chrome, bevel=0.003, name='panel')
    for k in range(4):
        x = -0.21 + k * 0.14
        P.lathe([(0.02, 0.0), (0.021, 0.012), (0.017, 0.022), (0.0, 0.024)], (x, body_y1 + 0.008, zt - 0.06), black,
                rot=(-90, 0, 0), segs=8, cap_top=False, name='knob')
        P.box((0.004, 0.003, 0.018), (x, body_y1 + 0.033, zt - 0.06 + 0.004), chrome, bevel=0.0, name='pointer')
    # oven door with window + handle bar
    dz0, dz1 = 0.27, zt - 0.115
    P.box((W - 0.05, 0.035, dz1 - dz0), (0, body_y1 + 0.0175, (dz0 + dz1) / 2), enamel, bevel=0.01, segs=2,
          name='ovendoor')
    P.box((0.3, 0.004, 0.16), (0, body_y1 + 0.036, (dz0 + dz1) / 2 + 0.03), glass, bevel=0.0, name='window')
    P.box((0.32, 0.006, 0.18), (0, body_y1 + 0.034, (dz0 + dz1) / 2 + 0.03), chrome, bevel=0.002, name='windowframe')
    P.tube([(-0.2, body_y1 + 0.035, dz1 - 0.04), (-0.19, body_y1 + 0.07, dz1 - 0.04), (0.19, body_y1 + 0.07, dz1 - 0.04),
            (0.2, body_y1 + 0.035, dz1 - 0.04)], 0.009, chrome, segs=8, name='handle')
    # broiler / storage drawer
    J.drawer(P, 0, body_y1, 0.17, W - 0.05, 0.16, enamel, kind='bar', hw=chrome, open_=0.0, t=0.03)
    # backguard with a dead clock
    P.box((W, 0.05, 0.17), (0, -D / 2 + 0.035, zt + 0.085), enamel, bevel=0.01, segs=2, name='backguard')
    P.box((W - 0.03, 0.01, 0.04), (0, -D / 2 + 0.06, zt + 0.15), chrome, bevel=0.002, name='bgtrim')
    P.cyl(0.05, 0.012, (0, -D / 2 + 0.06, zt + 0.08), chrome, rot=(-90, 0, 0), segs=12, name='clock')
    P.cyl(0.043, 0.004, (0, -D / 2 + 0.072, zt + 0.08), glass, rot=(-90, 0, 0), segs=12, name='clockface')
    # burnt rings around the burners (decal on the cooktop)
    ck = [o for o in P.hard if o.name.startswith('cooktop')][0]
    decals = [P.decal_like(ck, v, f, burnt, (0, 0, 0), name='burn') for v, f in rings]
    P.decal_group([ck], decals, ext=0.003)
    P.finish(tex=1024, tileable=True, max_tris=2500, fit=(W, H, D), preview_yaw=30, preview_pitch=22)
