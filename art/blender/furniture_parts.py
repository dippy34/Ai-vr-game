"""Reusable joinery for case furniture: legs, drawers, pulls, panel doors. Helper module (no-op build)."""

from __future__ import annotations

import math

import furniture_lib as F
from furniture_lib import hexc


def build() -> None:
    print('furniture_parts: helper module (built through furniture.py)')


# --- shared materials ---------------------------------------------------------------------------

def walnut(name='walnut', seed=0.0, **kw):
    args = dict(finish=0.36, ring=0.007, figure=0.7, pores=0.6, dust=0.65, grime=0.85, wear=0.7,
                raw=hexc('8a6a4a'), scratch=0.5, seed=seed, tide=0.08, bevel_r=0.004, peel=0.25,
                peel_col=hexc('8a7354'), stains=0.3, crack=0.2)
    args.update(kw)
    return F.mat_wood(name, hexc('5c3d26'), hexc('2a1a10'), **args)


def oak(name='oak', seed=0.0, **kw):
    args = dict(finish=0.42, ring=0.011, figure=0.9, pores=0.8, dust=0.65, grime=0.85, wear=0.6,
                raw=hexc('a08458'), scratch=0.5, seed=seed, tide=0.08, bevel_r=0.004, stains=0.3, crack=0.25)
    args.update(kw)
    return F.mat_wood(name, hexc('8a6438'), hexc('4a3018'), **args)


def mahogany(name='mahogany', seed=0.0, **kw):
    args = dict(finish=0.3, ring=0.008, figure=0.6, pores=0.5, dust=0.75, grime=0.85, wear=0.6,
                raw=hexc('8a5a40'), scratch=0.6, seed=seed, tide=0.0, bevel_r=0.005, stains=0.4, crack=0.5,
                rings=0.8)
    args.update(kw)
    return F.mat_wood(name, hexc('5a2c1c'), hexc('24100a'), **args)


def brass(name='brass', seed=0.0):
    return F.mat_metal(name, hexc('8f7038'), rough=0.42, metal=0.85, tarnish=0.7, tarnish_col=hexc('34301a'),
                       pitting=0.35, seed=seed)


def interior(name='interior'):
    """Raw dark wood inside carcasses and drawers."""
    return F.mat_wood(name, hexc('33261a'), hexc('1c140c'), finish=0.85, ring=0.012, figure=0.4, pores=0.2,
                      dust=0.25, grime=1.0, wear=0.0, scratch=0.0, tone=0.2, film=0.1)


# --- legs ----------------------------------------------------------------------------------------

def taper_leg(P, x, y, z_top, h, mat, top=0.045, bot=0.025, splay=(0.0, 0.0), bevel=0.003):
    """Square tapered leg hanging from z_top (mid-century / farmhouse)."""
    return P.box((top, top, h), (x, y, z_top - h / 2), mat, taper=(bot / top, bot / top), bevel=bevel, grain='z',
                 rot=(splay[1], -splay[0], 0), pivot=(x, y, z_top), name='leg')


def round_leg(P, x, y, z_top, h, mat, ferrule=None, r_top=0.022, r_bot=0.013, splay=7.0, segs=8):
    """Round tapered (splayed) leg with optional brass ferrule; hangs from z_top."""
    sx = 1 if x > 0 else -1
    sy = 1 if y > 0 else -1
    rot = (sy * splay, -sx * splay, 0)
    h = h / math.cos(math.radians(splay))
    fh = 0.024 if ferrule is not None else 0.0
    P.lathe([(r_bot, -h + fh), (r_bot + 0.0015, -h * 0.7), (r_top, -0.012), (r_top + 0.002, 0.0)],
            (x, y, z_top), mat, segs=segs, rot=rot, cap_top=False, cap_bot=ferrule is None, name='leg')
    if ferrule is not None:
        P.lathe([(r_bot - 0.0008, -h), (r_bot + 0.0004, -h + 0.002), (r_bot + 0.0006, -h + fh),
                 (r_bot - 0.0004, -h + fh + 0.002)], (x, y, z_top), ferrule, segs=segs, rot=rot, cap_top=False,
                cap_bot=True, name='ferrule')


TURNED = [(0.021, 0.0), (0.025, 0.012), (0.024, 0.028), (0.019, 0.055), (0.02, 0.1), (0.03, 0.18), (0.034, 0.235),
          (0.029, 0.29), (0.02, 0.335), (0.025, 0.37), (0.029, 0.385), (0.024, 0.4), (0.022, 0.45), (0.03, 0.5),
          (0.031, 0.52)]


def turned_leg(P, x, y, h, mat, block=0.075, block_h=0.13, segs=10, profile=TURNED):
    """Classic turned leg: lathe profile scaled to fit under a square block (block top at h)."""
    zt = h - block_h
    top = profile[-1][1]
    prof = [(r, z * zt / top) for r, z in profile]
    P.lathe(prof, (x, y, 0), mat, segs=segs, cap_top=False, cap_bot=True, name='leg', phase=0.5)
    P.box((block, block, block_h), (x, y, h - block_h / 2), mat, bevel=0.004, grain='z', name='legblock')


# --- pulls ---------------------------------------------------------------------------------------

def pull(P, kind, x, y, z, mat, w=0.09, rot=(0, 0, 0)):
    """Pull hardware on a front face at y (faces +Y)."""
    if kind == 'knob':
        P.lathe([(0.008, 0.0), (0.006, 0.008), (0.009, 0.014), (0.016, 0.02), (0.017, 0.026), (0.013, 0.031),
                 (0.0, 0.033)], (x, y, z), mat, rot=(-90, 0, 0), segs=8, cap_top=False, name='knob')
    elif kind == 'bail':
        P.box((w + 0.03, 0.002, 0.03), (x, y + 0.001, z + 0.006), mat, bevel=0.0008, name='backplate')
        for sx in (-1, 1):
            P.cyl(0.0045, 0.012, (x + sx * w / 2, y, z + 0.008), mat, rot=(-90, 0, 0), segs=6, name='post')
        pts = []
        for i in range(7):
            t = i / 6
            a = math.pi * t
            pts.append((x - w / 2 * math.cos(a), y + 0.012 + 0.006 * math.sin(a), z + 0.008 - 0.022 * math.sin(a)))
        P.tube(pts, 0.0028, mat, segs=6, name='bail')
    elif kind == 'bar':
        P.box((w, 0.01, 0.012), (x, y + 0.02, z), mat, bevel=0.003, name='bar')
        for sx in (-1, 1):
            P.box((0.012, 0.02, 0.01), (x + sx * (w / 2 - 0.01), y + 0.01, z), mat, bevel=0.002, name='standoff')
    elif kind == 'cup':
        P.prism([(-w / 2, 0.0), (w / 2, 0.0), (w / 2 - 0.006, 0.022), (-w / 2 + 0.006, 0.022)], 0.016,
                (x, y + 0.008, z - 0.01), mat, bevel=0.002, name='cup')


# --- drawers + doors -------------------------------------------------------------------------------

def drawer(P, x, y_face, z, w, h, mat, inside=None, kind='bail', hw=None, open_=0.0, depth=0.4, t=0.02,
           gap=0.003, pulls=1, lip=0.0, warp=0.0):
    """Drawer front (centered at x,z, its back face at y_face). open_ > 0 pulls it out and shows the box."""
    y = y_face + open_
    fw, fh = w - gap * 2, h - gap * 2
    P.box((fw + lip * 2, t, fh + lip * 2), (x, y + t / 2, z), mat, bevel=0.004, segs=1, name='drawer',
          rot=(0, warp, 0))
    if hw is not None:
        if pulls == 1:
            pull(P, kind, x, y + t, z, hw)
        else:
            for sx in (-1, 1):
                pull(P, kind, x + sx * fw * 0.27, y + t, z, hw)
    if open_ > 0.01 and inside is not None:
        bh = fh - 0.025
        bz = z - fh / 2 + 0.012 + bh / 2
        L = min(depth, open_ + 0.15)
        for sx in (-1, 1):
            P.box((0.012, L, bh), (x + sx * (fw / 2 - 0.02), y - L / 2, bz), inside, bevel=0.002, grain='y',
                  name='dside')
        P.box((fw - 0.052, L, 0.006), (x, y - L / 2, z - fh / 2 + 0.015), inside, bevel=0.0, name='dbottom')
    return y + t


def panel_door(P, x0, x1, z0, z1, y_back, mat, *, t=0.022, stile=0.06, rail=None, raised=True, hinge='left',
               angle=0.0, hw=None, kind='knob', glass=None, muntins=(0, 0), keyhole=None, panel_mat=None):
    """
    Frame-and-panel door spanning x0..x1, z0..z1, back face at y_back (faces +Y). Swings open by `angle`
    degrees about its hinge edge. Returns the list of objects.
    """
    rail = rail or stile
    w, h = x1 - x0, z1 - z0
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    yc = y_back + t / 2
    objs = []
    objs.append(P.box((stile, t, h), (x0 + stile / 2, yc, cz), mat, bevel=0.004, grain='z', name='stile'))
    objs.append(P.box((stile, t, h), (x1 - stile / 2, yc, cz), mat, bevel=0.004, grain='z', name='stile'))
    objs.append(P.box((w - 2 * stile, t * 0.98, rail), (cx, yc, z1 - rail / 2), mat, bevel=0.004, name='rail'))
    objs.append(P.box((w - 2 * stile, t * 0.98, rail), (cx, yc, z0 + rail / 2), mat, bevel=0.004, name='rail'))
    pw, ph = w - 2 * stile + 0.01, h - 2 * rail + 0.01
    if glass is not None:
        objs.append(P.box((pw, 0.004, ph), (cx, yc, cz), glass, bevel=0.0, name='glass'))
        nx, nz = muntins
        for i in range(1, nx + 1):
            xx = x0 + stile + (w - 2 * stile) * i / (nx + 1)
            objs.append(P.box((0.018, t * 0.7, ph - 0.01), (xx, yc, cz), mat, bevel=0.003, grain='z', name='muntin'))
        for j in range(1, nz + 1):
            zz = z0 + rail + (h - 2 * rail) * j / (nz + 1)
            objs.append(P.box((pw - 0.01, t * 0.7, 0.018), (cx, yc, zz), mat, bevel=0.003, name='muntin'))
    elif raised == 'mirror':
        objs.append(P.box((pw, t * 0.45, ph), (cx, yc - t * 0.15, cz), mat, bevel=0.002, grain='z', name='panel'))
        objs.append(P.box((pw - 0.03, 0.004, ph - 0.03), (cx, yc + t * 0.1, cz), panel_mat, bevel=0.0,
                          name='mirror'))
    elif raised:
        # raised field: thin panel + a chamfered raised center
        objs.append(P.box((pw, t * 0.45, ph), (cx, yc - t * 0.15, cz), panel_mat or mat, bevel=0.002, grain='z',
                          name='panel'))
        objs.append(P.box((pw - 0.05, t * 0.25, ph - 0.05), (cx, yc + t * 0.15, cz), panel_mat or mat, bevel=0.012,
                          grain='z', name='field'))
    else:
        objs.append(P.box((pw, t * 0.5, ph), (cx, yc - t * 0.1, cz), panel_mat or mat, bevel=0.002, grain='z',
                          name='panel'))
    if hw is not None:
        hx = x1 - stile / 2 if hinge == 'left' else x0 + stile / 2
        n_before = len(P.hard)
        pull(P, kind, hx, y_back + t, cz, hw)
        objs += P.hard[n_before:]
        if keyhole:
            objs.append(P.box((0.012, 0.002, 0.03), (hx, y_back + t + 0.001, cz - 0.06), keyhole, bevel=0.0006,
                              name='escutcheon'))
    if abs(angle) > 0.01:
        px = x0 if hinge == 'left' else x1
        sgn = 1 if hinge == 'left' else -1  # free edge swings toward +Y (out of the case)
        from furniture_lib import _xf
        m = _xf((0, 0, 0), (0, 0, sgn * angle), pivot=(px, y_back + t, 0))
        for o in objs:
            o.data.transform(m)
    return objs
