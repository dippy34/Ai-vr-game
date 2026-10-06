"""Old upright piano (furniture_piano). Helper module: build() is a no-op (see furniture.py)."""

from __future__ import annotations

import math

import furniture_lib as F
import furniture_parts as J
from furniture_lib import G, Masks, _finish, age, hexc, new_material

KW = 0.0235          # white key pitch
NW = 52              # white keys (88-key keyboard)
X0 = -NW * KW / 2    # left edge of the keyboard
KF = 0.29            # key front (Y)
KB = 0.14            # visible back end of the keys (fallboard)
KZ = 0.665           # top of the key bed / bottom of the white keys
KT = 0.022           # white key thickness


def build() -> None:
    print('furniture_piano: built through furniture.py')


def mat_ivory(name):
    """Yellowed ivory keytops with grime between keys, cracks and a few chipped tops."""
    mat = new_material(name)
    g = G(mat)
    mk = Masks(g, 0.0015, 0.04)
    pos = g.pos()
    x, y, z = g.sep(pos)
    f = g.m('FRACT', g.mul(g.sub(x, X0), 1.0 / KW))
    gap = g.vmax(g.rng(f, 0.035, 0.0), g.rng(f, 0.965, 1.0))
    # per-key tone
    kid = g.m('FLOOR', g.mul(g.sub(x, X0), 1.0 / KW))
    kr = g.m('FRACT', g.mul(g.m('SINE', g.mul(kid, 12.9898)), 43758.5453))
    col = g.mix(kr, hexc('b8aa84'), hexc('9a8a60'))
    yell = g.noise(pos, 8.0, 3, 0.5)
    col = g.mix(g.rng(yell, 0.3, 0.8, 0.0, 0.5), col, hexc('7a6438'))
    # front edge of the keytop / its seam
    cr = g.voronoi(pos, 1.0, 'DISTANCE_TO_EDGE', stretch=(30.0, 4.0, 30.0))
    crm = g.mul(g.rng(cr, 0.03, 0.0), g.rng(g.noise(pos, 6.0, 2, 0.5), 0.5, 0.65))
    col = g.mix(crm, col, hexc('4a3a20'))
    chip = g.mul(g.rng(kr, 0.9, 0.92), g.rng(mk.nz(), 0.5, 0.9))
    col = g.mix(chip, col, hexc('6a4a28'))
    col = g.mix(gap, col, hexc('0c0806'))
    rough = g.mixf(chip, 0.3, 0.75)
    rough = g.mixf(gap, rough, 0.9)
    h = g.sub(g.mul(crm, -0.5), g.mul(gap, 1.0))
    h = g.sub(h, g.mul(chip, 0.5))
    col, rough, h = age(g, mk, col, rough, h, dust=0.7, grime=0.9, wear=0.0, scratch=0.2, film=0.12, floor=0.0)
    _finish(g, mk, col, rough, h, bump_dist=0.0006)
    return mat


def build_piano():
    P = F.Piece('piano', seed=31)
    case = F.mat_wood('piano_case', hexc('3e2416'), hexc('170c07'), finish=0.24, ring=0.008, figure=0.5, pores=0.4,
                      crack=0.9, rings=0.6, peel=0.3, peel_col=hexc('6a5034'), dust=0.85, tide=0.07, grime=0.85,
                      wear=0.7, raw=hexc('7a5a40'), scratch=0.6, seed=3.0, stains=0.4, bevel_r=0.005)
    inner = J.interior('piano_inside')
    ivory = mat_ivory('piano_ivory')
    ebony = F.mat_plain('piano_ebony', hexc('100c0a'), 0.35, dust=0.6, grime=0.6, wear=0.8, noise_amt=0.2,
                        bevel_r=0.002)
    felt = F.mat_plain('piano_felt', hexc('4a1414'), 0.98, dust=0.5, grime=0.9, noise_amt=0.5)
    brass = J.brass('piano_brass')
    gilt_case = F.mat_wood('piano_gilt', hexc('3e2416'), hexc('170c07'), finish=0.24, ring=0.008, figure=0.5,
                           crack=0.9, dust=0.6, seed=3.0, decal=_gilt())
    W, H, D = 1.6, 1.3, 0.6
    back = -D / 2
    fy = 0.02                       # front plane of the upper case
    # upper case sides
    for sx in (-1, 1):
        P.box((0.035, fy - back, H - 0.03), (sx * (W / 2 - 0.0175), (fy + back) / 2, (H - 0.03) / 2), case,
              bevel=0.004, grain='z', name='side')
    # lid (top) with a slight overhang
    P.box((W + 0.01, fy - back + 0.03, 0.028), (0, (fy + back) / 2 + 0.005, H - 0.014), case, bevel=0.006, segs=2,
          name='lid')
    P.box((W - 0.07, 0.01, H - 0.05), (0, back + 0.005, (H - 0.05) / 2), case, bevel=0.0, name='back')
    # key bed, key slip, cheek blocks (arms)
    P.box((W - 0.07, KF - fy + 0.02, 0.04), (0, (KF + fy) / 2, KZ - 0.02), case, bevel=0.003, name='keybed')
    P.box((W - 0.07, 0.022, 0.06), (0, KF + 0.011, KZ - 0.012), case, bevel=0.004, segs=1, name='keyslip')
    arm_w = (W - NW * KW) / 2 - 0.005
    for sx in (-1, 1):
        x = sx * (W / 2 - arm_w / 2)
        P.box((arm_w, KF - fy + 0.03, 0.11), (x, (KF + fy) / 2 + 0.015, KZ + 0.015), case, bevel=0.012, segs=2,
              name='cheek', grain='y')
        # turned front legs under the cheeks + toe blocks
        J.turned_leg(P, sx * (W / 2 - 0.06), KF - 0.04, KZ - 0.04, case, block=0.07, block_h=0.08, segs=10)
        P.box((0.07, 0.4, 0.07), (sx * (W / 2 - 0.06), KF - 0.12, 0.035), case, bevel=0.006, segs=1, grain='y',
              name='toe')
    # white keys: slab segments around two missing keys + one raised key
    missing = {18, 31}
    raised = 40
    runs = []
    start = 0
    for i in range(NW + 1):
        if i == NW or i in missing or i == raised:
            if i > start:
                runs.append((start, i))
            start = i + 1
    for a, b in runs:
        x0, x1 = X0 + a * KW + 0.0004, X0 + b * KW - 0.0004
        P.box((x1 - x0, KF - KB, KT), ((x0 + x1) / 2, (KF + KB) / 2, KZ + KT / 2), ivory, bevel=0.0012,
              name='keys', skip=('-z',))
    x0 = X0 + raised * KW + 0.0008
    P.box((KW - 0.0016, KF - KB, KT), (x0 + KW / 2 - 0.0008, (KF + KB) / 2, KZ + KT / 2), ivory, bevel=0.0012,
          rot=(7, 0, 1.5), pivot=(0, KB, KZ), name='key', skip=('-z',))
    for i in missing:  # the dark gap: key lever stubs / felt down in the hole
        P.box((KW - 0.003, KF - KB - 0.02, 0.004), (X0 + (i + 0.5) * KW, (KF + KB) / 2 - 0.01, KZ + 0.002), felt,
              bevel=0.0, name='hole')
    # black keys
    notes = 'ABCDEFG'
    n_black = 0
    for i in range(NW - 1):
        if notes[i % 7] in 'ACDFG':
            n_black += 1
            if i == 23:
                continue  # one black key gone
            xb = X0 + (i + 1) * KW
            lift = 0.006 if i == 44 else 0.0
            P.box((0.0125, 0.092, 0.012), (xb, KB + 0.046 + 0.004, KZ + KT + 0.006 + lift), ebony, bevel=0.0,
                  taper=(1.15, 1.0), name='black', skip=('-z',), rot=(4 if lift else 0, 0, 0))
    # felt strip + open fallboard (tilted back) with the maker's gilt name
    P.box((NW * KW, 0.01, 0.012), (0, KB - 0.005, KZ + KT + 0.004), felt, bevel=0.0, name='feltstrip')
    fb = P.box((NW * KW + 0.02, 0.018, 0.075), (0, KB - 0.02, KZ + KT + 0.05), case, bevel=0.004, segs=2,
               rot=(18, 0, 0), name='fallboard')
    # upper front panel with two raised fields, music desk ledge
    zp0, zp1 = KZ + KT + 0.1, H - 0.05
    P.box((W - 0.07, 0.022, zp1 - zp0), (0, fy - 0.011, (zp0 + zp1) / 2), case, bevel=0.004, name='upper')
    for sx in (-1, 1):
        cx = sx * 0.46
        P.box((0.46, 0.012, zp1 - zp0 - 0.12), (cx, fy + 0.006, (zp0 + zp1) / 2 + 0.01), case, bevel=0.008,
              segs=1, name='field')
    P.box((0.38, 0.016, zp1 - zp0 - 0.08), (0, fy + 0.008, (zp0 + zp1) / 2 + 0.02), case, bevel=0.012, segs=1,
          name='field')
    P.box((W - 0.12, 0.07, 0.02), (0, fy + 0.035, zp0 + 0.03), case, bevel=0.005, segs=1, name='desk')
    P.box((W - 0.12, 0.012, 0.035), (0, fy + 0.065, zp0 + 0.05), case, bevel=0.004, name='desklip')
    # swing-out candle holders
    for sx in (-1, 1):
        bx = sx * 0.62
        bz = zp0 + 0.32
        P.cyl(0.012, 0.012, (bx, fy, bz), brass, rot=(-90, 0, 0), segs=8, name='plate')
        P.tube([(bx, fy + 0.01, bz), (bx, fy + 0.06, bz + 0.01), (bx + sx * 0.03, fy + 0.11, bz + 0.02)], 0.004, brass,
               segs=6, name='arm')
        P.lathe([(0.0, 0.0), (0.02, 0.003), (0.024, 0.008), (0.016, 0.012), (0.012, 0.032), (0.014, 0.036)],
                (bx + sx * 0.03, fy + 0.11, bz + 0.015), brass, segs=8, cap_top=False, name='cup')
    # lower front (knee board) with a raised field, bottom rail, pedals
    kz0, kz1 = 0.08, KZ - 0.05
    P.box((W - 0.07, 0.02, kz1 - kz0), (0, -0.02, (kz0 + kz1) / 2), case, bevel=0.004, name='knee')
    P.box((W - 0.4, 0.012, kz1 - kz0 - 0.14), (0, -0.004, (kz0 + kz1) / 2 + 0.01), case, bevel=0.01, segs=1,
          name='field')
    P.box((W - 0.07, 0.05, 0.08), (0, -0.0, 0.04), case, bevel=0.004, name='bottomrail')
    P.box((0.28, 0.012, 0.05), (0, 0.026, 0.055), felt, bevel=0.002, name='pedalbox')
    for k, sx in enumerate((-0.09, 0.0, 0.09)):
        P.prism([(-0.018, 0.0), (0.018, 0.0), (0.02, 0.01), (0.012, 0.016), (-0.012, 0.016), (-0.02, 0.01)], 0.13,
                (sx, 0.09, 0.045 + (0.008 if k == 1 else 0.0)), brass, rot=(0, 0, 0), bevel=0.002, name='pedal',
                grain='y')
    n = (0.0, math.cos(math.radians(18)), math.sin(math.radians(18)))
    tl = (0.0, KB - 0.02 + n[1] * 0.0096, KZ + KT + 0.05 + n[2] * 0.0096)
    P.decal_group([fb], [P.text('HALLSTROM & SONS', 0.017, tl, gilt_case, rot=(90 - 18, 0, 180))], ext=0.006)
    P.finish(tex=1024, max_tris=3000, fit=(W, H, D), preview_yaw=30, preview_pitch=14)


def _gilt():
    def decal(g, col, rough, h):
        n = g.noise(None, 300.0, 2, 0.6)
        wear = g.rng(g.noise(None, 25.0, 3, 0.6), 0.3, 0.55)
        gold = g.mix(n, hexc('a08040'), hexc('6a5020'))
        col = g.mix(g.mul(wear, 0.95), col, gold)
        rough = g.mixf(wear, rough, 0.35)
        return col, rough, h
    return decal
