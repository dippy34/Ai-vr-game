"""
MUTE story decals + notes: public/models/decal_<name>.glb and note_<name>.glb (+ review renders in
art/previews/decal_* and note_*).

    npm run assets -- decals                         # everything
    DECALS=handprints,note_tutorial npm run assets -- decals   # just some (comma list)
    DECAL_Q=draft ...                                # small, fast preview renders
    DECAL_PREVIEW=0 ...                              # skip the Blender preview renders
    DECAL_SHOOT=1 ...                                # also screenshot each piece in three.js
                                                     # (needs `npx vite --port 5199` running)

Decals are thin alpha-blended quads (a slightly curled sheet for the child's drawing); the
renderer (src/platform/render/Decals.ts) places them where they tell the house's story. Notes are
bent, creased paper sheets with a 1024^2 handwritten message (alpha-masked torn edges), readable
at arm's length in VR. Images are synthesized with numpy (decals_img.py, decals_notes.py,
decals_hand.py = the handwriting), meshes/materials/export in decals_lib.py.

glTF extras on every root node: placement ('wall' | 'floor' | 'door' | 'surface'), size [w, h, d]
(three.js axes, m), kind ('decal' | 'note'), and `text` (the note's message) on notes.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))

# name -> size (w x h, m) + placement. Every decal shares ONE material setup (texture size,
# roughness, alpha blend, no normal map) so the renderer's batcher merges them all into a single
# texture-array draw call per chunk of the house.
DECAL_SPECS = {
    'handprints': dict(size=(0.6, 1.2), placement='wall'),
    'scratches': dict(size=(0.55, 1.1), placement='door'),
    'drag': dict(size=(0.72, 2.4), placement='floor'),
    'mold': dict(size=(0.9, 1.5), placement='wall'),
    'writing_hears': dict(size=(1.7, 0.64), placement='wall'),
    'writing_shh': dict(size=(1.2, 0.9), placement='wall'),
    'writing_dont': dict(size=(1.4, 0.77), placement='wall'),
    'drawing': dict(size=(0.36, 0.48), placement='wall'),
}
DECAL_TEX = (512, 1024)
DECAL_ROUGHNESS = 0.72
NOTE_NAMES = ['tutorial', 'tom', 'whisper', 'light', 'dad', 'kitchen']
PIECES = [f'decal_{n}' for n in DECAL_SPECS] + [f'note_{n}' for n in NOTE_NAMES]


def build_decal(name: str) -> None:
    import decals_img as I
    import decals_lib as L
    import common as C
    C.reset()
    spec = DECAL_SPECS[name]
    w, h = spec['size']
    placement = spec['placement']
    t0 = time.time()
    rgba, nrm = I.DECALS[name]()
    src = rgba.shape
    rgba, rot = I.standard(rgba, DECAL_TEX)
    print(f'[decal_{name}] image {src[1]}x{src[0]} -> {rgba.shape[1]}x{rgba.shape[0]}{" (rotated)" if rot else ""} '
          f'in {time.time() - t0:.1f}s', flush=True)
    col = L.image(f'decal_{name}_color', rgba)
    nimg = L.image(f'decal_{name}_normal', nrm, non_color=True) if nrm is not None else None
    mat = L.material(f'decal_{name}', col, nimg, rough=DECAL_ROUGHNESS, mode='blend')
    if name == 'drawing':
        # paper taped at the top corners: the bottom curls off the wall a little, a lifted corner
        def z_of(u, v):
            return 0.0015 + 0.006 * v ** 2 + 0.008 * max(0.0, (u - 0.6) / 0.4) ** 2 * max(0.0, (v - 0.6) / 0.4) ** 2
        ob = L.grid_sheet('decal_drawing', w, h, L.lines_with(4), L.lines_with(5), placement, z_of)
        depth = L.mesh_depth(ob, 1)
    else:
        ob = L.quad(f'decal_{name}', w, h, placement, rot90=rot)
        depth = 0.0
    ob.data.materials.append(mat)
    ob.name = f'decal_{name}'
    L.finish(f'decal_{name}', ob, dict(placement=placement, size=L.gltf_extras_size(placement, w, h, depth),
                                      kind='decal'))
    L.previews(f'decal_{name}', ob, placement)


def build_note(name: str) -> None:
    import decals_lib as L
    import decals_notes as N
    import common as C
    C.reset()
    t0 = time.time()
    rgba, nrm, spec = N.note_image(name)
    print(f'[note_{name}] image in {time.time() - t0:.1f}s', flush=True)
    w, h = spec['size']
    placement = spec['placement']
    col = L.image(f'note_{name}_color', rgba)
    nimg = L.image(f'note_{name}_normal', nrm, non_color=True)
    mat = L.material(f'note_{name}', col, nimg, rough=0.88, mode='clip', double_sided=True, normal_strength=1.0)
    hf = [f[1] for f in spec.get('folds', []) if f[0] == 'h']
    vf = [f[1] for f in spec.get('folds', []) if f[0] == 'v']
    nu = 8 if w < 0.18 else 10
    nv = max(4, round(nu * h / w))
    if spec.get('crumple'):
        nu, nv = nu + 4, nv + 4
    us = L.lines_with(nu, vf, 0.01)
    vs = L.lines_with(nv, hf, 0.01)
    wall = placement == 'wall'
    ob = L.grid_sheet(f'note_{name}', w, h, us, vs, 'wall' if wall else 'floor', lambda u, v: N.surface_z(spec, u, v),
                      reader_front=True)
    axis = 1 if wall else 2
    L.drop_to(ob, axis, 0.0006 if not wall else 0.001)
    depth = L.mesh_depth(ob, axis) + (0.0006 if not wall else 0.001)
    ob.data.materials.append(mat)
    text = spec['text'].replace('*', '').replace('\n', ' ')
    L.finish(f'note_{name}', ob, dict(placement=placement, size=L.gltf_extras_size(placement, w, h, depth), kind='note',
                                     text=text))
    if wall:
        L.previews(f'note_{name}', ob, 'wall', pitch=4.0, zoom=1.15)
    else:
        L.previews(f'note_{name}', ob, 'surface', pitch=68.0, zoom=1.15, yaw=0.0, flash_yaw=12.0)


def build_one(piece: str) -> None:
    sys.path.insert(0, HERE)
    kind, name = piece.split('_', 1)
    if kind == 'decal':
        build_decal(name)
    else:
        build_note(name)


def shoot(piece: str) -> None:
    """three.js screenshots via the dev viewer (needs `npx vite --port 5199` running)."""
    out = os.path.join(REPO, 'art', 'previews', f'{piece}_threejs.png')
    wall = piece.startswith('decal_') and DECAL_SPECS[piece[6:]]['placement'] in ('wall', 'door')
    if piece == 'note_whisper':
        wall = True
    q = f'model={piece}&yaw=0&pitch={5 if wall else 60}'
    for mood, path in (('studio', out), ('flash', out.replace('_threejs', '_threejs_flash'))):
        r = subprocess.run(['node', os.path.join(REPO, 'dev', 'models', 'shoot.cjs'), path, f'{q}&mood={mood}'],
                           capture_output=True, text=True, cwd=REPO)
        print(f'[three.js] {piece} {mood}: {r.stdout.strip()[:300]} {r.stderr.strip()[:200]}')


def build() -> None:
    wanted = [w.strip() for w in os.environ.get('DECALS', '').split(',') if w.strip()]
    pieces = []
    for w_ in wanted or PIECES:
        if w_ in PIECES:
            pieces.append(w_)
        elif f'decal_{w_}' in PIECES:
            pieces.append(f'decal_{w_}')
        elif f'note_{w_}' in PIECES:
            pieces.append(f'note_{w_}')
        else:
            raise SystemExit(f'unknown piece {w_!r}; known: {", ".join(PIECES)}')
    failed = []
    for piece in pieces:
        t0 = time.time()
        print(f'--- {piece} ---', flush=True)
        code = f'import sys; sys.path.insert(0, {HERE!r}); import decals; decals.build_one({piece!r})'
        r = subprocess.run([sys.executable, '-c', code])
        ok = r.returncode == 0
        print(f'--- {piece}: {"ok" if ok else "FAILED"} in {time.time() - t0:.0f}s ---', flush=True)
        if not ok:
            failed.append(piece)
        elif os.environ.get('DECAL_SHOOT') == '1':
            shoot(piece)
    if failed:
        raise SystemExit(f'decals: failed: {", ".join(failed)}')


if __name__ == '__main__':
    build()
