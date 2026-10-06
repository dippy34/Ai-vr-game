"""
MUTE furniture set: public/models/furniture_<name>.glb (+ previews in art/previews/).

    npm run assets -- furniture                       # every piece + the lineup render
    FURNITURE=couch,bed npm run assets -- furniture   # just some pieces (comma list)
    FURNITURE=lineup npm run assets -- furniture      # only re-render the lineup from the GLBs
    FURN_Q=draft ...                                  # fast iteration (512 px bakes, few samples)

Each piece is built in its own Blender process (clean state). Geometry/material/bake helpers live
in furniture_lib.py; the pieces are grouped in furniture_<family>.py modules (their build() is a
no-op so art/build.py can import them safely).

Every GLB is ONE mesh with ONE baked material (base color + metallicRoughness + normal, WebP).
The mesh node carries glTF extras:
    size:     [w, h, d]  actual modeled bounds in meters (three.js axes: X, Y, Z)
    tileable: true for modules meant to be repeated side by side along X
    fit:      [w, h, d]  (only when it differs from size) the level box the piece is designed to
              fill; parts may stick out above it (bed headboard, stove backguard).
Front = Blender +Y (three.js -Z), origin = bottom center.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))

# name -> module that defines build_<name>()
PIECES = {
    'couch': 'furniture_seating',
    'armchair': 'furniture_seating',
    'bench': 'furniture_seating',
    'bed': 'furniture_bed',
    'shelf_module': 'furniture_shelves',
    'shelf_module_b': 'furniture_shelves',
    'table_dining': 'furniture_tables',
    'table_small': 'furniture_tables',
    'table_coffee': 'furniture_tables',
    'desk': 'furniture_tables',
    'cabinet_tall': 'furniture_cabinets',
    'cabinet_narrow': 'furniture_cabinets',
    'cabinet_low': 'furniture_cabinets',
    'nightstand': 'furniture_cabinets',
    'piano': 'furniture_piano',
    'counter_module': 'furniture_kitchen',
    'counter_sink': 'furniture_kitchen',
    'counter_stove': 'furniture_kitchen',
    'crate': 'furniture_misc',
    'crate_small': 'furniture_misc',
}


def build_one(name: str) -> None:
    """Build a single piece in THIS process."""
    import importlib
    sys.path.insert(0, HERE)
    mod = importlib.import_module(PIECES[name])
    getattr(mod, f'build_{name}')()


def build() -> None:
    wanted = [w.strip() for w in os.environ.get('FURNITURE', '').split(',') if w.strip()]
    if not wanted:
        wanted = list(PIECES) + ['lineup']
    failed = []
    for name in wanted:
        t0 = time.time()
        print(f'--- furniture: {name} ---', flush=True)
        if name == 'lineup':
            code = f'import sys; sys.path.insert(0, {HERE!r}); import furniture_lineup; furniture_lineup.render()'
        elif name in PIECES:
            code = f'import sys; sys.path.insert(0, {HERE!r}); import furniture; furniture.build_one({name!r})'
        else:
            print(f'unknown piece {name!r}; known: {", ".join(PIECES)}, lineup')
            failed.append(name)
            continue
        r = subprocess.run([sys.executable, '-c', code])
        print(f'--- {name}: {"ok" if r.returncode == 0 else "FAILED"} in {time.time() - t0:.0f}s ---', flush=True)
        if r.returncode != 0:
            failed.append(name)
    if failed:
        raise SystemExit(f'furniture: failed: {", ".join(failed)}')


if __name__ == '__main__':
    build()
