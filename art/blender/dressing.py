"""
MUTE set dressing: public/models/dressing_<name>.glb (+ previews in art/previews/dressing_*).

    npm run assets -- dressing                         # every piece + the lineup render
    DRESSING=chair,clock npm run assets -- dressing    # just some pieces (comma list)
    DRESSING=lineup npm run assets -- dressing         # only re-render the lineup from the GLBs
    DRESS_Q=draft ...                                  # fast iteration (256 px bakes, few samples)
    DRESS_PREVIEW=0 ...                                # skip the Blender preview renders
    DRESS_SHOOT=1 ...                                  # also screenshot each piece in three.js

Each piece is built in its own Blender process (clean state). Shared helpers: dressing_lib.py
(materials, aging, geometry, bake/export pipeline) and dressing_img.py (generated 2D images).

Every GLB has ONE root node (the opaque mesh; glass / cutout meshes are its children) with glTF
extras (also on the scene):
    size:      [w, h, d] modeled bounds in meters, three.js axes (X, Y, Z)
    placement: 'floor' | 'surface' | 'wall' | 'ceiling'
       floor/surface: origin bottom center, front faces -Z (three.js)
       wall:          origin at the center of the back face, back on the wall plane, faces -Z
       ceiling:       origin at the top attachment point, hangs down -Y
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))

# name -> module defining build_<name>()
PIECES = {
    'frame_portrait': 'dressing_wall',
    'frame_landscape': 'dressing_wall',
    'chair': 'dressing_furn',
    'chair_fallen': 'dressing_furn',
    'clock': 'dressing_wall',
    'toys': 'dressing_soft',
    'rug': 'dressing_soft',
    'boards': 'dressing_furn',
    'coat_rack': 'dressing_furn',
    'books_pile': 'dressing_small',
    'bottles': 'dressing_small',
    'candles': 'dressing_small',
    'plate_broken': 'dressing_small',
    'bulb': 'dressing_small',
    'papers': 'dressing_small',
}


def build_one(name: str) -> None:
    import importlib
    sys.path.insert(0, HERE)
    mod = importlib.import_module(PIECES[name])
    getattr(mod, f'build_{name}')()


def shoot(name: str) -> None:
    """three.js screenshots via the dev viewer (needs `npx vite --port 5199` running)."""
    out = os.path.join(REPO, 'art', 'previews', f'dressing_{name}_threejs.png')
    for mood, path in (('studio', out), ('flash', out.replace('_threejs', '_threejs_flash'))):
        r = subprocess.run(['node', os.path.join(REPO, 'dev', 'models', 'shoot.cjs'), path,
                            f'model=dressing_{name}&yaw=35&mood={mood}'], capture_output=True, text=True, cwd=REPO)
        print(f'[three.js] {name} {mood}: {r.stdout.strip()[:400]} {r.stderr.strip()[:200]}')


def build() -> None:
    wanted = [w.strip() for w in os.environ.get('DRESSING', '').split(',') if w.strip()]
    if not wanted:
        wanted = list(PIECES) + ['lineup']
    failed = []
    for name in wanted:
        t0 = time.time()
        print(f'--- dressing: {name} ---', flush=True)
        if name == 'lineup':
            code = f'import sys; sys.path.insert(0, {HERE!r}); import dressing_lineup; dressing_lineup.render()'
        elif name in PIECES:
            code = f'import sys; sys.path.insert(0, {HERE!r}); import dressing; dressing.build_one({name!r})'
        else:
            print(f'unknown piece {name!r}; known: {", ".join(PIECES)}, lineup')
            failed.append(name)
            continue
        r = subprocess.run([sys.executable, '-c', code])
        ok = r.returncode == 0
        print(f'--- {name}: {"ok" if ok else "FAILED"} in {time.time() - t0:.0f}s ---', flush=True)
        if not ok:
            failed.append(name)
        elif name != 'lineup' and os.environ.get('DRESS_SHOOT') == '1':
            shoot(name)
    if failed:
        raise SystemExit(f'dressing: failed: {", ".join(failed)}')


if __name__ == '__main__':
    build()
