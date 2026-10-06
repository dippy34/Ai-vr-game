"""
doorway_casing.glb: painted interior doorway trim for a 1.1 m x 2.4 m opening in a 0.2 m wall.

Origin = bottom center of the opening, in the middle of the wall (the wall faces are y = +-0.1 in
Blender; front = +Y). Casing on BOTH wall faces: 9 cm side casings with a back band, plinth blocks
at the floor (the baseboard butts into them), head casing with a cap. Inside the opening: jamb
liners, the door stop of a door that was taken off long ago, its painted-over hinge leaves and the
strike plate. All painted wood maps at real scale onto the tileable wood_trim set.

glTF extras: size [1.1, 2.4, 0.2] (the opening it fits, three.js axes), opening [1.1, 2.4, 0.2],
bounds (full extent), placement 'doorway'. Helper module (built through trims.py).
"""

from __future__ import annotations

import common as C
import trims_lib as T

OW, OH, WD = 1.1, 2.4, 0.2
HX = OW / 2
HY = WD / 2


def build() -> None:
    print('trims_door: built through trims.py')


def build_doorway() -> list:
    C.reset()
    b = T.board
    parts = []
    jt = 0.018  # jamb liner thickness
    # --- jamb liners -------------------------------------------------------------------------
    parts.append(b('jamb_l', (-HX, -HY, 0.0), (-HX + jt, HY, OH), drop=('-x', '-z'), long_axis='z', bevel=0.002))
    parts.append(b('jamb_r', (HX - jt, -HY, 0.0), (HX, HY, OH), drop=('+x', '-z'), long_axis='z', bevel=0.002))
    parts.append(b('jamb_head', (-HX + jt, -HY, OH - jt), (HX - jt, HY, OH), drop=('+z',), long_axis='x', bevel=0.002))
    # --- door stop (the door itself is long gone) ---------------------------------------------------
    sy0, sy1 = -0.048, -0.012
    parts.append(b('stop_l', (-HX + jt, sy0, 0.0), (-HX + jt + 0.012, sy1, OH - jt), drop=('-x', '-z'), long_axis='z',
                   bevel=0.003, segments=2))
    parts.append(b('stop_r', (HX - jt - 0.012, sy0, 0.0), (HX - jt, sy1, OH - jt), drop=('+x', '-z'), long_axis='z',
                   bevel=0.003, segments=2))
    parts.append(b('stop_head', (-HX + jt + 0.012, sy0, OH - jt - 0.012), (HX - jt - 0.012, sy1, OH - jt), drop=('+z',),
                   long_axis='x', bevel=0.003, segments=2))
    # painted-over hinge leaves + knuckles on the left jamb, strike plate on the right
    for z in (0.2, 1.08, 2.0):
        parts.append(b(f'hinge_{z}', (-HX + jt, -0.012, z), (-HX + jt + 0.0025, 0.03, z + 0.09), drop=('-x',), bevel=0.001))
        parts.append(b(f'knuckle_{z}', (-HX + jt, 0.024, z - 0.004), (-HX + jt + 0.012, 0.036, z + 0.094), drop=('-x',),
                       bevel=0.004, segments=2))
    parts.append(b('strike', (HX - jt - 0.002, -0.01, 0.95), (HX - jt, 0.018, 1.06), drop=('+x',), bevel=0.001))
    # --- casings on both faces -----------------------------------------------------------------
    reveal = 0.006
    cw = 0.09
    ci = HX - reveal          # casing inner edge
    co = ci + cw              # casing outer edge
    hz = OH + reveal          # head casing bottom
    for face, sgn in (('f', 1), ('b', -1)):
        y0 = sgn * HY
        drop = ('-y',) if sgn > 0 else ('+y',)

        def ys(t):
            return (min(y0, y0 + sgn * t), max(y0, y0 + sgn * t))

        for side in (-1, 1):
            def xs(a, c):
                return (min(side * a, side * c), max(side * a, side * c))
            x0, x1 = xs(ci, co)
            ya, yb = ys(0.019)
            parts.append(b(f'{face}_casing_{side}', (x0, ya, 0.2), (x1, yb, hz + cw), drop=drop + ('-z',), long_axis='z',
                           bevel=0.003))
            x0, x1 = xs(co - 0.008, co + 0.012)
            ya, yb = ys(0.03)
            parts.append(b(f'{face}_band_{side}', (x0, ya, 0.2), (x1, yb, hz + cw + 0.012), drop=drop + ('-z',),
                           long_axis='z', bevel=0.005, segments=2))
            x0, x1 = xs(ci - 0.008, co + 0.02)
            ya, yb = ys(0.034)
            parts.append(b(f'{face}_plinth_{side}', (x0, ya, 0.0), (x1, yb, 0.2), drop=drop + ('-z',), long_axis='z',
                           bevel=0.005, segments=2))
        ya, yb = ys(0.021)
        parts.append(b(f'{face}_head', (-(co - 0.008), ya, hz), (co - 0.008, yb, hz + cw), drop=drop, long_axis='x',
                       bevel=0.003))
        ya, yb = ys(0.036)
        parts.append(b(f'{face}_cap', (-(co + 0.03), ya, hz + cw + 0.012), (co + 0.03, yb, hz + cw + 0.036), drop=drop,
                       long_axis='x', bevel=0.005, segments=2))
        ya, yb = ys(0.026)
        parts.append(b(f'{face}_bead', (-(co + 0.016), ya, hz + cw), (co + 0.016, yb, hz + cw + 0.012), drop=drop,
                       long_axis='x', bevel=0.004, segments=2))
    wood = T.finish_objects(parts, T.wood_trim_material(), 'doorway_casing')
    return [wood]
