"""Upholstered seating: couch, armchair, bench. Helper module: build() is a no-op (see furniture.py)."""

from __future__ import annotations

import furniture_lib as F
from furniture_lib import hexc


def build() -> None:
    print('furniture_seating: built through furniture.py')


def _walnut(name='walnut', seed=0.0):
    return F.mat_wood(name, hexc('5c3d26'), hexc('2a1a10'), finish=0.38, ring=0.007, figure=0.7, pores=0.6,
                      dust=0.5, grime=0.8, wear=0.7, raw=hexc('8a6a4a'), scratch=0.5, seed=seed, tide=0.0,
                      bevel_r=0.004)


def _brass(name='brass'):
    return F.mat_metal(name, hexc('8f7038'), rough=0.42, metal=0.85, tarnish=0.65, tarnish_col=hexc('3b3219'),
                       pitting=0.3)


def _leg(P, x, y, z_top, h, wood, brass, splay=7.0, r_top=0.021, r_bot=0.0125):
    sx = 1 if x > 0 else -1
    sy = 1 if y > 0 else -1
    rot = (sy * splay, -sx * splay, 0)
    P.lathe([(r_bot, -h + 0.024), (r_bot + 0.0015, -h * 0.7), (r_top, -0.012), (r_top + 0.002, 0.0)],
            (x, y, z_top), wood, segs=8, rot=rot, cap_top=False, cap_bot=False, name='leg')
    P.lathe([(r_bot - 0.0008, -h), (r_bot + 0.0004, -h + 0.002), (r_bot + 0.0006, -h + 0.024),
             (r_bot - 0.0004, -h + 0.026)],
            (x, y, z_top), brass, segs=8, rot=rot, cap_top=False, cap_bot=True, name='ferrule')


def build_couch():
    P = F.Piece('couch', seed=5)
    fab = F.mat_fabric('couch_tweed', hexc('7b6d40'), hexc('4c4426'), fade=0.45, stains=0.8, dust=0.5, grime=1.0,
                       wear=0.6, seed=1.0)
    wood = _walnut()
    brass = _brass()
    W, D = 2.2, 0.9
    zb = 0.13            # top of legs / bottom of the base
    base_h = 0.15
    zs = zb + base_h     # top of the base deck
    arm_w = 0.17
    # wooden legs with brass ferrules
    for x in (-W / 2 + 0.09, W / 2 - 0.09):
        for y in (-D / 2 + 0.09, D / 2 - 0.1):
            _leg(P, x, y, zb + 0.005, zb, wood, brass)
    # upholstered base (plinth)
    P.cushion((W - 0.04, D - 0.02, base_h), (0, 0, zb + base_h / 2), fab, radius=0.035, bulge=(0.006, 0.008, 0.004),
              wrinkle=0.003, piping=0.003, lowres=(3, 1, 0), seed=1, name='base')
    # track arms
    arm_h = 0.36
    for sx in (-1, 1):
        P.cushion((arm_w, D - 0.03, arm_h), (sx * (W / 2 - arm_w / 2 - 0.005), 0, zs + arm_h / 2 - 0.01), fab,
                  radius=0.055, bulge=(0.012, 0.006, 0.012), wrinkle=0.006, piping=0.004, lowres=(0, 2, 1),
                  crease=0.003, seed=2 + sx, name='arm', use=[(0.0, 0.25, 0.12)], sag=(0.012, 0.6, 0.3),
                  tears=[(0.0, 0.3, 0.06)] if sx > 0 else [])
    # back frame
    inner = W - 2 * arm_w - 0.01
    back_h = 0.85 - zs - 0.005
    P.cushion((inner + 0.04, 0.17, back_h), (0, -D / 2 + 0.095, zs + back_h / 2), fab, radius=0.06,
              bulge=(0.004, 0.015, 0.008), wrinkle=0.004, piping=0.004, lowres=(2, 0, 1), seed=4, name='backframe')
    # seat cushions
    sw = inner / 3
    sd = D - 0.17 - 0.02
    sh = 0.15
    yc = -D / 2 + 0.17 + sd / 2 + 0.01
    seats = [
        dict(sag=(0.04, 0.38, 0.38), dents=[(0.05, 0.06, 0.035, 0.16)], tears=[], front_drop=0.02, twist=0.01,
             off=(0.0, 0.012, 0.0, 1.0)),
        dict(sag=(0.075, 0.42, 0.4), dents=[(-0.04, 0.03, 0.045, 0.18)], tears=[], front_drop=0.035, twist=-0.012,
             off=(0.004, -0.015, -0.006, -1.5)),
        dict(sag=(0.04, 0.36, 0.36), dents=[(-0.06, 0.0, 0.02, 0.14)], tears=[(0.12, 0.16, 0.085)], front_drop=0.015,
             twist=0.015, off=(-0.004, 0.03, 0.004, 2.5)),
    ]
    for i, cfg in enumerate(seats):
        x = -inner / 2 + sw * (i + 0.5)
        dx, dy, dz, rz = cfg.pop('off')
        P.cushion((sw - 0.012, sd, sh), (x + dx, yc + dy, zs + sh / 2 - 0.004 + dz), fab, rot=(0, 0, rz),
                  radius=0.045, bulge=(0.01, 0.012, 0.026), wrinkle=0.009, piping=0.0045, lowres=(2, 2, 0),
                  skip_bottom=True, flat_bottom=True, seed=10 + i, name='seat', **cfg)
    # back cushions (leaning back; the left one slumped sideways and forward)
    bh, bd = 0.44, 0.16
    for i in range(3):
        x = -inner / 2 + sw * (i + 0.5)
        rot = (15, 0, 0)
        loc = (x, -D / 2 + 0.17 + bd / 2 + 0.02, zs + sh + bh / 2 - 0.045)
        if i == 0:   # slumped forward and sideways
            rot = (30, -12, 6)
            loc = (x + 0.04, loc[1] + 0.07, loc[2] - 0.06)
        elif i == 1:
            rot = (18, 2, -2)
            loc = (x, loc[1] + 0.01, loc[2] - 0.02)
        else:
            rot = (12, 4, 3)
        P.cushion((sw - 0.025, bd, bh), loc, fab, rot=rot, radius=0.05, bulge=(0.01, 0.034, 0.012), wrinkle=0.008,
                  piping=0.0045, lowres=(1, 0, 1), seed=20 + i, name='backcushion', squash=-0.02 * i,
                  twist=0.012 * (1 - i), use=[(0.0, 0.0, 0.14)] if i == 1 else [(0.0, 0.05, 0.1)])
    P.finish(tex=1024, max_tris=3000, fit=(W, 0.85, D), preview_yaw=30)


def build_armchair():
    P = F.Piece('armchair', seed=8)
    fab = F.mat_fabric('armchair_fabric', hexc('6e3b26'), hexc('3e2216'), fade=0.5, stains=0.7, dust=0.5,
                       grime=1.0, wear=0.7, seed=4.0)
    wood = _walnut('walnut_ac', seed=2.0)
    brass = _brass()
    W, D, H = 0.9, 0.9, 0.85
    zb = 0.14
    base_h = 0.14
    zs = zb + base_h
    arm_w = 0.15
    for x in (-W / 2 + 0.08, W / 2 - 0.08):
        for y in (-D / 2 + 0.08, D / 2 - 0.09):
            _leg(P, x, y, zb + 0.005, zb, wood, brass, splay=8)
    P.cushion((W - 0.03, D - 0.02, base_h), (0, 0, zb + base_h / 2), fab, radius=0.035, bulge=(0.006, 0.008, 0.004),
              wrinkle=0.003, piping=0.003, lowres=(1, 1, 0), seed=1, name='base')
    arm_h = 0.34
    for sx in (-1, 1):
        # arms slope down toward the back a little and are rounded on top
        P.cushion((arm_w, D - 0.04, arm_h), (sx * (W / 2 - arm_w / 2 - 0.005), 0.0, zs + arm_h / 2 - 0.01), fab,
                  radius=0.06, bulge=(0.012, 0.006, 0.014), wrinkle=0.005, piping=0.004, lowres=(0, 2, 1),
                  crease=0.003, seed=3 + sx, name='arm', tears=[(0.0, 0.3, 0.03)] if sx < 0 else [])
    inner = W - 2 * arm_w - 0.01
    back_h = H - zs - 0.005
    # back frame leans back a little
    P.cushion((inner + 0.03, 0.17, back_h), (0, -D / 2 + 0.1, zs + back_h / 2), fab, rot=(6, 0, 0), radius=0.06,
              bulge=(0.004, 0.016, 0.01), wrinkle=0.004, piping=0.004, lowres=(1, 0, 1), seed=6, name='backframe')
    sd = D - 0.19
    sh = 0.15
    P.cushion((inner - 0.006, sd, sh), (0, -D / 2 + 0.18 + sd / 2, zs + sh / 2 - 0.004), fab, radius=0.045,
              bulge=(0.008, 0.01, 0.024), wrinkle=0.007, piping=0.0045, lowres=(2, 2, 0), skip_bottom=True,
              flat_bottom=True, seed=12, name='seat', sag=(0.055, 0.4, 0.38), dents=[(0.02, 0.03, 0.03, 0.17)],
              tears=[(-0.15, 0.2, 0.05)])
    bh, bd = 0.45, 0.15
    P.cushion((inner - 0.02, bd, bh), (0, -D / 2 + 0.19 + bd / 2, zs + sh + bh / 2 - 0.04), fab, rot=(16, 0, 0),
              radius=0.05, bulge=(0.008, 0.03, 0.01), wrinkle=0.006, piping=0.0045, lowres=(1, 0, 1), seed=22,
              name='backcushion', use=[(0.0, 0.05, 0.12)], twist=0.01)
    P.finish(tex=1024, max_tris=2500, fit=(W, H, D), preview_yaw=35)


def build_bench():
    """Long upholstered bench / ottoman (button-tufted top on a walnut frame)."""
    P = F.Piece('bench', seed=9)
    fab = F.mat_fabric('bench_vinyl', hexc('4d2a24'), hexc('2e1915'), fade=0.35, stains=0.6, dust=0.55,
                       grime=1.0, wear=0.8, seed=7.0, weave=0.4)
    wood = _walnut('walnut_b', seed=5.0)
    brass = _brass()
    W, D, H = 1.2, 0.5, 0.5
    apron_h = 0.08
    z_top_frame = H - 0.12
    # frame: four rails + legs
    leg_h = z_top_frame
    for x in (-W / 2 + 0.05, W / 2 - 0.05):
        for y in (-D / 2 + 0.05, D / 2 - 0.05):
            _leg(P, x, y, leg_h, leg_h, wood, brass, splay=5, r_top=0.024, r_bot=0.014)
    for sy in (-1, 1):
        P.box((W - 0.02, 0.022, apron_h), (0, sy * (D / 2 - 0.011), z_top_frame - apron_h / 2), wood, bevel=0.004,
              name='apron')
    for sx in (-1, 1):
        P.box((0.022, D - 0.044, apron_h), (sx * (W / 2 - 0.011), 0, z_top_frame - apron_h / 2), wood, bevel=0.004,
              grain='y', name='apron')
    # tufted top cushion
    tufts = []
    for i in range(5):
        for j in range(2):
            tufts.append((-0.44 + i * 0.22 + (0.11 if j else 0.0), -0.08 + j * 0.16))
    tufts = [t for t in tufts if abs(t[0]) < 0.5]
    P.cushion((W, D, H - z_top_frame), (0, 0, z_top_frame + (H - z_top_frame) / 2), fab, radius=0.04,
              bulge=(0.006, 0.008, 0.018), wrinkle=0.004, piping=0.004, lowres=(3, 1, 0), flat_bottom=True,
              seed=31, name='top', tufts=tufts, tears=[(0.42, 0.12, 0.05)], sag=(0.02, 0.35, 0.5))
    P.finish(tex=512, max_tris=2500, fit=(W, H, D), preview_yaw=30)
