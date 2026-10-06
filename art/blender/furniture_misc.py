"""Wooden shipping crates (furniture_crate, furniture_crate_small). Helper module: build() is a no-op."""

from __future__ import annotations

import math

import furniture_lib as F
from furniture_lib import hexc


def build() -> None:
    print('furniture_misc: built through furniture.py')


def _pine(name, seed=0.0, decal=None):
    return F.mat_wood(name, hexc('7d6e5a'), hexc('3b3127'), finish=0.84, ring=0.014, figure=1.0, pores=0.3,
                      dust=0.75, grime=0.95, wear=0.6, raw=hexc('a8977a'), scratch=0.5, tide=0.07,
                      stains=0.6, seed=seed, tone=0.35, bevel_r=0.004, decal=decal)


def _stencil(color=(0.02, 0.018, 0.015)):
    def decal(g, col, rough, h):
        n1 = g.noise(None, 18.0, 4, 0.7, offset=(3.0, 1.0, 0.0))
        n2 = g.noise(None, 90.0, 2, 0.6)
        cover = g.mul(g.rng(n1, 0.28, 0.5), g.rng(n2, 0.25, 0.55, 0.6, 1.0))
        paint = g.mix(g.rng(n2, 0.3, 0.7), color, tuple(c * 2.5 for c in color))
        col = g.mix(g.mul(cover, 0.92), col, paint)
        rough = g.mixf(cover, rough, 0.7)
        return col, rough, h
    return decal


def _crate(P: F.Piece, S: float, planks: int, lid_open: bool, stencils, broken=()):
    wood = _pine('crate_pine', seed=P.rng.random() * 10)
    paint = _pine('crate_stencil', seed=P.rng.random() * 10, decal=_stencil())
    straw = F.mat_plain('crate_straw', hexc('8a7440'), 0.95, dust=0.6, grime=1.0, noise_amt=0.5)
    t = 0.018           # board thickness
    bt = 0.022          # batten thickness
    So = S
    S = So - 2 * bt     # wall-to-wall width; So = outer size including the battens
    bw = 0.075 * S / 0.8  # batten width
    skid = 0.05
    gap = 0.007
    Zt = So - t         # top of the walls (lid boards sit on it)
    H = Zt - skid       # body height above skids
    ph = (H - gap * (planks - 1)) / planks
    faces = {}

    def side(axis, sign):
        """One wall: horizontal planks + perimeter battens + a diagonal brace."""
        objs = []
        L = S if axis == 'y' else S - 2 * t  # front/back span full width, sides fit between
        for i in range(planks):
            z = skid + i * (ph + gap) + ph / 2
            if (axis, sign, i) in broken:
                # broken plank: shorter, jagged end
                cut = 0.35 * L
                pts = [(-L / 2, -ph / 2), (cut - 0.03, -ph / 2), (cut + 0.02, -ph * 0.1), (cut - 0.015, ph * 0.15),
                       (cut + 0.035, ph / 2), (-L / 2, ph / 2)]
                if axis == 'y':
                    o = P.prism(pts, t, (0, sign * (S / 2 - t / 2), z), wood, rot=(0, 0, 0 if sign > 0 else 180),
                                bevel=0.002, name='plank')
                else:
                    o = P.prism(pts, t, (sign * (S / 2 - t / 2), 0, z), wood, rot=(0, 0, 90 if sign > 0 else -90),
                                bevel=0.002, name='plank')
            elif axis == 'y':
                o = P.box((L, t, ph), (0, sign * (S / 2 - t / 2), z), wood, bevel=0.003, name='plank')
            else:
                o = P.box((t, L, ph), (sign * (S / 2 - t / 2), 0, z), wood, bevel=0.003, grain='y', name='plank')
            objs.append(o)
        # battens on the outside
        off = S / 2 + bt / 2
        if axis == 'y':
            y = sign * off
            for x in (-S / 2 + bw / 2, S / 2 - bw / 2):
                P.box((bw, bt, H), (x, y, skid + H / 2), wood, bevel=0.004, grain='z', name='batten')
            for z in (skid + bw / 2, skid + H - bw / 2):
                P.box((S - 2 * bw, bt, bw), (0, y, z), wood, bevel=0.004, name='batten')
        else:
            x = sign * off
            for yy in (-S / 2 - bt + bw / 2, S / 2 + bt - bw / 2):
                P.box((bt, bw, H), (x, yy, skid + H / 2), wood, bevel=0.004, grain='z', name='batten')
            for z in (skid + bw / 2, skid + H - bw / 2):
                P.box((bt, S + 2 * bt - 2 * bw, bw), (x, 0, z), wood, bevel=0.004, grain='y', name='batten')
            if sign > 0:  # one diagonal brace (stencils go on the other faces)
                ln = math.hypot(S - 2 * bw, H - 2 * bw)
                ang = math.degrees(math.atan2(H - 2 * bw, S - 2 * bw))
                P.box((bt * 0.9, ln - bw * 0.6, bw * 0.85), (x, 0, skid + H / 2), wood, rot=(ang, 0, 0), bevel=0.004,
                      grain='y', name='brace')
        faces[(axis, sign)] = objs

    for axis, sign in (('y', 1), ('y', -1), ('x', 1), ('x', -1)):
        side(axis, sign)
    # floor + skids
    P.box((S - 2 * t, S - 2 * t, t), (0, 0, skid + t / 2), wood, bevel=0.002, skip=('-z',), name='floor')
    for x in (-S * 0.36, S * 0.36):
        P.box((0.07, S + 2 * bt, skid), (x, 0, skid / 2), wood, bevel=0.005, grain='y', name='skid')
    # straw packing peeking out
    P.box((S - 2 * t - 0.01, S - 2 * t - 0.01, 0.05), (0, 0, Zt - 0.12), straw, bevel=0.01, skip=('-z',),
          name='straw')
    # lid: boards across X with two cleats underneath
    lid = []
    lp = 4 if S < 0.7 else 5
    lw = (S + 2 * bt - gap * (lp - 1)) / lp
    for i in range(lp):
        y = -(S / 2 + bt) + lw / 2 + i * (lw + gap)
        lid.append(P.box((S + 2 * bt, lw, t), (0, y, Zt + t / 2), wood, bevel=0.003, name='lid'))
    for x in (-S / 2 + bw, S / 2 - bw):
        lid.append(P.box((bw, S - 2 * t - 0.01, bt), (x, 0, Zt - bt / 2), wood, bevel=0.004, grain='y',
                         name='cleat'))
    if lid_open:
        import bpy
        from furniture_lib import _xf
        m = _xf((0.025, 0.02, 0.012), (0, 0, 4), pivot=(0, 0, Zt)) @ _xf((0, 0, 0), (-3.5, 0, 0), pivot=(0, S / 2, Zt))
        for o in lid:
            o.data.transform(m)
    # stencils (decal bake on the boards they sit on)
    decals = []
    lows = []
    for (axis, sign, text, size, x, z) in stencils:
        tgt = faces[(axis, sign)]
        lows += [o for o in tgt if o not in lows]
        surf = S / 2 + 0.0006
        if axis == 'y':
            loc, rot = (x, sign * surf, z), (90, 0, 180 if sign > 0 else 0)
        else:
            loc, rot = (sign * surf, x, z), (90, 0, 90 if sign > 0 else -90)
        decals.append(P.text(text, size, loc, paint, rot=rot))
    if decals:
        P.decal_group(lows, decals, ext=0.004)


def build_crate():
    P = F.Piece('crate', seed=11)
    S = 0.8
    _crate(P, S, 5, True, [
        ('y', 1, 'FRAGILE', 0.12, 0.0, 0.50),
        ('y', 1, 'No 47', 0.075, 0.0, 0.33),
        ('x', -1, 'KEEP DRY', 0.08, 0.0, 0.47),
        ('y', -1, 'HANDLE WITH CARE', 0.05, 0.0, 0.55),
        ('y', -1, '1953', 0.08, 0.0, 0.4),
    ], broken=(('x', -1, 4),))
    P.finish(tex=1024, max_tris=2500, fit=(S, S, S))


def build_crate_small():
    P = F.Piece('crate_small', seed=23)
    S = 0.6
    _crate(P, S, 4, False, [
        ('y', 1, 'GLASS', 0.085, 0.0, 0.36),
        ('y', 1, 'THIS SIDE UP', 0.04, 0.0, 0.22),
        ('x', -1, 'No 12', 0.07, 0.0, 0.38),
    ], broken=(('y', -1, 3),))
    P.finish(tex=512, max_tris=2500, fit=(S, S, S))
