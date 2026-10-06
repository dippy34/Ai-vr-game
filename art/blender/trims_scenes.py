"""
In-context review renders for the trim models (used by trims.py): each model installed in a piece
of papered wall with floor + ceiling, under dim moonlight and a camera flash from the viewer.
Writes art/previews/trim_<name>_room.png. Helper module only: build() is a no-op.
"""

from __future__ import annotations

import math
import os

import bpy
from mathutils import Vector

import common as C
import surfaces_preview as P

TILES = {'wallpaper_a': (1.0, 1.0), 'wallpaper_b': (1.0, 1.0), 'plaster_ceiling': (2.0, 2.0),
         'wood_floor': (2.0, 2.0), 'tile_floor': (1.0, 1.0), 'wood_trim': (0.5, 0.5)}


def build() -> None:
    print('trims_scenes: helper module (built through trims.py)')


def _wall_with_hole(name, y, x0, x1, z0, z1, hx0, hx1, hz0, hz1, mat, facing=+1, tile=(1.0, 1.0), zfloor=0.0):
    """Wall plane at y (normal +Y if facing > 0) spanning x0..x1, z0..z1 with a rectangular hole."""
    tu, tv = tile
    rects = [(x0, hx0, z0, z1), (hx1, x1, z0, z1), (hx0, hx1, z0, hz0), (hx0, hx1, hz1, z1)]
    out = []
    for i, (a0, a1, b0, b1) in enumerate(rects):
        if a1 - a0 < 1e-4 or b1 - b0 < 1e-4:
            continue
        cs = [(a0, y, b0), (a1, y, b0), (a1, y, b1), (a0, y, b1)]
        uv = [(a0 / tu, (b0 - zfloor) / tv), (a1 / tu, (b0 - zfloor) / tv), (a1 / tu, (b1 - zfloor) / tv), (a0 / tu, (b1 - zfloor) / tv)]
        if facing < 0:
            cs = cs[::-1]
            uv = [(-c[0] / tu, (c[2] - zfloor) / tv) for c in cs]
        out.append(P.quad(f'{name}{i}', cs, uv, mat))
    return out


def _floor(x0, x1, y0, y1, z, mat, tile):
    return P.quad('floor', [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)],
                  [(x0 / tile[0], y0 / tile[1]), (x1 / tile[0], y0 / tile[1]), (x1 / tile[0], y1 / tile[1]), (x0 / tile[0], y1 / tile[1])], mat)


def _ceiling(x0, x1, y0, y1, z, mat, tile):
    return P.quad('ceil', [(x0, y0, z), (x0, y1, z), (x1, y1, z), (x1, y0, z)],
                  [(x0 / tile[0], y0 / tile[1]), (x0 / tile[0], y1 / tile[1]), (x1 / tile[0], y1 / tile[1]), (x1 / tile[0], y0 / tile[1])], mat)


def _baseboard(x0, x1, y, z, facing=+1):
    trim = P.surface_material('wood_trim')
    if facing > 0:
        P.box_world_uv('base', (x0, y, z), (x1, y + 0.02, z + 0.15), 0.5, 0.5, trim)
    else:
        P.box_world_uv('base', (x0, y - 0.02, z), (x1, y, z + 0.15), 0.5, 0.5, trim)


def _flash(eye, look, energy=220):
    P._light('SPOT', energy, Vector(eye) + Vector((0.1, 0.0, -0.08)), look, color=(1.0, 0.98, 0.95), size=0.02, spot=95)


def window_room(objs) -> None:
    """Window in a damask wall, moonlight through the glass, flash from the room."""
    zf = -1.5  # floor (window center at 1.5 m)
    wall = P.surface_material('wallpaper_a')
    _wall_with_hole('wall', 0.0, -1.6, 1.6, zf, zf + 2.8, -0.5, 0.5, -0.6, 0.6, wall, zfloor=zf)
    _floor(-1.6, 1.6, 0.0, 3.0, zf, P.surface_material('wood_floor'), TILES['wood_floor'])
    _ceiling(-1.6, 1.6, 0.0, 3.0, zf + 2.8, P.surface_material('plaster_ceiling'), TILES['plaster_ceiling'])
    _baseboard(-1.6, 1.6, 0.0, zf)
    # outside: dim night sky backdrop + the exterior wall face around the hole
    sky = C.material('sky', color=(0, 0, 0), emission=(0.05, 0.07, 0.13), emission_strength=1.0)
    P.quad('sky', [(-6, -5, -4), (6, -5, -4), (6, -5, 6), (-6, -5, 6)], [(0, 0), (1, 0), (1, 1), (0, 1)], sky)
    dark = C.material('ext', color=(0.05, 0.05, 0.05), roughness=0.9)
    _wall_with_hole('ext', -0.2, -1.6, 1.6, zf, zf + 2.8, -0.5, 0.5, -0.6, 0.6, dark, facing=-1, zfloor=zf)
    eye = Vector((1.05, 2.3, 0.15))
    look = Vector((0.0, 0.0, -0.12))
    P._camera(eye, look, lens=30)
    P._world((0.01, 0.012, 0.02), 0.3)
    P._light('SUN', 0.9, (0.6, -3.0, 2.0), (0, 0.5, -0.8), color=(0.55, 0.65, 1.0), angle=1.0)
    _flash(eye, look, 160)
    P._render(os.path.join(C.PREVIEW_DIR, 'trim_window_frame_room.png'), 900, 720, 40)


def doorway_room(objs) -> None:
    """Doorway between a damask room (front) and a striped room behind it."""
    wa = P.surface_material('wallpaper_a')
    wb = P.surface_material('wallpaper_b')
    _wall_with_hole('wf', 0.1, -2.0, 2.0, 0.0, 2.8, -0.55, 0.55, -1.0, 2.4, wa)
    _wall_with_hole('wb', -0.1, -2.0, 2.0, 0.0, 2.8, -0.55, 0.55, -1.0, 2.4, wb, facing=-1)
    # reveal soffit above the doorway (hidden behind the head jamb anyway)
    _floor(-2.0, 2.0, -3.2, 3.2, 0.0, P.surface_material('wood_floor'), TILES['wood_floor'])
    _ceiling(-2.0, 2.0, -3.2, 3.2, 2.8, P.surface_material('plaster_ceiling'), TILES['plaster_ceiling'])
    _baseboard(-2.0, -0.645, 0.1, 0.0)
    _baseboard(0.645, 2.0, 0.1, 0.0)
    _baseboard(-2.0, -0.645, -0.1, 0.0, facing=-1)
    _baseboard(0.645, 2.0, -0.1, 0.0, facing=-1)
    # far wall of the back room
    P.quad('far', [(2.0, -3.2, 0), (-2.0, -3.2, 0), (-2.0, -3.2, 2.8), (2.0, -3.2, 2.8)][::-1],
           [(-2.0, 0), (2.0, 0), (2.0, 2.8), (-2.0, 2.8)][::-1], wb)
    eye = Vector((1.15, 2.6, 1.6))
    look = Vector((0.0, 0.0, 1.15))
    P._camera(eye, look, lens=24)
    P._world((0.01, 0.012, 0.02), 0.3)
    P._light('SPOT', 60, (-1.5, -2.6, 2.4), (0.0, 0.0, 0.8), color=(0.55, 0.65, 1.0), size=0.3, spot=60)
    _flash(eye, look, 260)
    P._render(os.path.join(C.PREVIEW_DIR, 'trim_doorway_casing_room.png'), 720, 900, 40)


def radiator_room(objs) -> None:
    lo, hi = C._bounds(objs)
    yw = lo.y - 0.004
    wall = P.surface_material('wallpaper_b')
    _wall_with_hole('wall', yw, -1.6, 1.6, 0.0, 2.8, 0, 0, 0, 0, wall)
    _floor(-1.6, 1.6, yw, yw + 2.5, 0.0, P.surface_material('wood_floor'), TILES['wood_floor'])
    _baseboard(-1.6, 1.6, yw, 0.0)
    eye = Vector((0.85, yw + 1.45, 1.15))
    look = Vector((0.0, yw + 0.1, 0.33))
    P._camera(eye, look, lens=32)
    P._world((0.01, 0.012, 0.02), 0.3)
    P._light('SPOT', 40, (-1.4, yw + 1.8, 1.9), (0, yw, 0.3), color=(0.55, 0.65, 1.0), size=0.3, spot=50)
    _flash(eye, look, 120)
    P._render(os.path.join(C.PREVIEW_DIR, 'trim_radiator_room.png'), 900, 720, 40)
