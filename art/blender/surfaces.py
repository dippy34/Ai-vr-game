"""
Tileable PBR texture sets for MUTE's walls, floors, ceilings and trim (models-as-code).

Builds public/textures/<name>_{color,normal,orm}.webp (1024 x 1024) + public/textures/textures.json,
then Cycles review renders in art/previews/surface_*.png.

  * color:  sRGB base color.
  * normal: tangent-space normal map, OpenGL convention (+Y / green = up the texture), as glTF and
            three.js expect (no green flip needed).
  * orm:    linear R = ambient occlusion, G = roughness, B = metalness (three.js aoMap /
            roughnessMap / metalnessMap read exactly these channels).

Every set is periodic by construction (see surfaces_lib), so it tiles seamlessly. Apply with UV =
world meters / tile size (textures.json "tile" = [width_m, height_m] of one repeat), with
RepeatWrapping. On walls v = 0 is the floor line (v = height / tile height).

`npm run assets -- surfaces` builds everything; SURFACES=wood_floor,tile_floor builds a subset;
SURFACES_PREVIEW=0 skips the Cycles renders.
"""

from __future__ import annotations

import json
import os
import time

import common as C
from surfaces_lib import save_image, seam_report

TEX_DIR = os.path.join(C.REPO, 'public', 'textures')

# name -> (module, function, tile [w, h] in meters, note)
SETS = {
    'wallpaper_a': ('surfaces_paper', 'wallpaper_a', (1.0, 1.0), 'faded olive/sepia damask, stains, mildew, hip scuffs, lifting seams'),
    'wallpaper_b': ('surfaces_paper', 'wallpaper_b', (1.0, 1.0), 'dusty blue-gray stripe with small diamonds, same grime, torn patch'),
    'plaster_ceiling': ('surfaces_plaster', 'plaster_ceiling', (2.0, 2.0), 'off-white plaster, hairline cracks, water-stain rings, flaking'),
    'wood_floor': ('surfaces_wood', 'wood_floor', (2.0, 2.0), 'worn oak strips (~9.1 cm, along u), dusty gaps, scratches, traffic patina'),
    'tile_floor': ('surfaces_tile', 'tile_floor', (1.0, 1.0), 'black/white checker, 8 x 8 tiles of 12.5 cm, dark grout, cracks'),
    'wood_trim': ('surfaces_wood', 'wood_trim', (0.5, 0.5), 'chipped cream enamel over green, over dark wood; grain along u'),
}

QUALITY = {'color': 92, 'normal': 95, 'orm': 92}
# the trim set is dense fine detail (0.5 mm texels) and ships inside the trim GLBs too: lighter
QUALITY_OVERRIDE = {'wood_trim': {'color': 86, 'normal': 88, 'orm': 84}}


def build_set(name: str) -> dict:
    mod_name, fn, tile, _ = SETS[name]
    mod = __import__(mod_name)
    t0 = time.time()
    maps = getattr(mod, fn)()
    for kind in ('color', 'normal', 'orm'):
        path = os.path.join(TEX_DIR, f'{name}_{kind}.webp')
        save_image(path, maps[kind], quality=QUALITY_OVERRIDE.get(name, QUALITY)[kind])
        print(f'[texture] {path} ({os.path.getsize(path) / 1024:.0f} KB)  {seam_report(kind, maps[kind])}')
    print(f'[surfaces] {name} built in {time.time() - t0:.1f}s')
    return maps


def write_json() -> str:
    path = os.path.join(TEX_DIR, 'textures.json')
    data = {name: {'tile': list(tile), 'maps': ['color', 'normal', 'orm']} for name, (_, _, tile, _) in SETS.items()}
    os.makedirs(TEX_DIR, exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
    print(f'[texture] {path}')
    return path


def previews(names) -> None:
    import surfaces_preview as P

    tiles = {n: SETS[n][2] for n in SETS}
    for name in names:
        P.tiled_preview(name, tiles[name])
    if set(names) & {'wallpaper_a', 'wood_floor', 'plaster_ceiling', 'wood_trim'}:
        P.room_corner(os.path.join(C.PREVIEW_DIR, 'surface_room_flash.png'), 'wallpaper_a', 'wood_floor', tiles=tiles)
        # arm's-length look at the wall / baseboard / floor junction, as a crouching player sees it
        P.room_corner(os.path.join(C.PREVIEW_DIR, 'surface_room_closeup.png'), 'wallpaper_a', 'wood_floor', tiles=tiles,
                      eye=(2.35, 2.3, 0.75), look=(3.2, 2.9, 0.35), lens=22, size=(800, 800), samples=40)
    if set(names) & {'wallpaper_b', 'tile_floor', 'plaster_ceiling', 'wood_trim'}:
        P.room_corner(os.path.join(C.PREVIEW_DIR, 'surface_room_flash_b.png'), 'wallpaper_b', 'tile_floor', tiles=tiles)


def build() -> None:
    wanted = [s for s in os.environ.get('SURFACES', '').split(',') if s] or list(SETS)
    for name in wanted:
        build_set(name)
    write_json()
    if os.environ.get('SURFACES_PREVIEW', '1') != '0':
        previews(wanted)
