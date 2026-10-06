"""
Architectural trim models for MUTE (models-as-code):

  public/models/window_frame.glb    double-hung window + casing + stool, for a 1.0 x 1.2 m opening
  public/models/doorway_casing.glb  interior doorway casing on both wall faces, 1.1 x 2.4 m, 0.2 m wall
  public/models/radiator.glb        cast-iron column radiator, 0.9 x 0.65 x 0.18 m

Front faces Blender +Y (three.js -Z). Painted wood uses the tileable wood_trim set (real-scale
UVs), so trims match the baseboards. Review renders: art/previews/trim_<name>_{studio,flash,room}.png

    npm run assets -- surfaces trims     (trims needs public/textures/wood_trim_* from surfaces)
    TRIMS=radiator npm run assets -- trims
    TRIMS_PREVIEW=0 ...                  skip the Cycles renders
"""

from __future__ import annotations

import math
import os
import time

import bpy
from mathutils import Vector

import common as C

PIECES = ('window_frame', 'doorway_casing', 'radiator')


def _previews(name: str, objs, yaw=25.0, pitch=10.0, zoom=1.0, room=None) -> None:
    if os.environ.get('TRIMS_PREVIEW', '1') == '0':
        return
    C.preview(f'trim_{name}_studio', objs, yaw_deg=yaw, pitch_deg=pitch, samples=24, zoom=zoom)
    C.preview(f'trim_{name}_flash', objs, yaw_deg=-yaw * 0.6, pitch_deg=pitch, mood='flash', samples=24, zoom=zoom)
    if room:
        room(objs)


def build_one(name: str) -> None:
    t0 = time.time()
    if name == 'window_frame':
        import trims_window as M
        import trims_lib as T
        objs = M.build_window()
        root = objs[0]
        print(f'[report] window_frame: {C.tri_count(objs)} tris (wood {C.tri_count([objs[0]])}, glass {C.tri_count([objs[1]])})')
        lo, hi = T.bounds(objs)
        T.export('window_frame', root, {
            'size': [1.0, 1.2, 0.2], 'opening': [1.0, 1.2], 'placement': 'wall',
            'bounds': [round(lo.x, 3), round(lo.z, 3), round(-hi.y, 3), round(hi.x, 3), round(hi.z, 3), round(-lo.y, 3)],
        })
        import trims_scenes as S
        _previews('window_frame', objs, yaw=28, pitch=8, room=S.window_room)
    elif name == 'doorway_casing':
        import trims_door as M
        import trims_lib as T
        objs = M.build_doorway()
        print(f'[report] doorway_casing: {C.tri_count(objs)} tris')
        lo, hi = T.bounds(objs)
        T.export('doorway_casing', objs[0], {
            'size': [1.1, 2.4, 0.2], 'opening': [1.1, 2.4, 0.2], 'placement': 'doorway',
            'bounds': [round(lo.x, 3), round(lo.z, 3), round(-hi.y, 3), round(hi.x, 3), round(hi.z, 3), round(-lo.y, 3)],
        })
        import trims_scenes as S
        _previews('doorway_casing', objs, yaw=30, pitch=6, room=S.doorway_room)
    elif name == 'radiator':
        import trims_radiator as M
        import trims_lib as T
        objs = M.build_radiator()
        print(f'[report] radiator: {C.tri_count(objs)} tris')
        lo, hi = T.bounds(objs)
        d = hi - lo
        T.export('radiator', objs[0], {'size': [round(d.x, 3), round(d.z, 3), round(d.y, 3)], 'placement': 'floor'})
        import trims_scenes as S
        _previews('radiator', objs, yaw=30, pitch=14, room=S.radiator_room)
    print(f'[trims] {name} done in {time.time() - t0:.0f}s')


def build() -> None:
    import subprocess
    import sys

    wanted = [s for s in os.environ.get('TRIMS', '').split(',') if s] or list(PIECES)
    if len(wanted) == 1:
        build_one(wanted[0])
        return
    # one fresh Blender process per piece (clean state)
    here = os.path.dirname(os.path.abspath(__file__))
    failed = []
    for name in wanted:
        env = dict(os.environ, TRIMS=name)
        code = f'import sys; sys.path.insert(0, {here!r}); import trims; trims.build()'
        r = subprocess.run([sys.executable, '-c', code], env=env)
        if r.returncode != 0:
            failed.append(name)
    if failed:
        raise SystemExit(f'trims failed: {failed}')
