"""
Small pickups: fuse.glb (glass cartridge fuse).
Built by props.py; see art/README.md for budgets and node names.
"""

from __future__ import annotations

import math

import common
import props_lib as L
import props_mats as M


def build() -> None:
    """art/build.py imports every module here and calls build(); props.py drives this one."""


# =============================================================================================
# Fuse: ~11 cm renewable cartridge fuse, brass ferrules, glass tube, wire + solder bead.
# Long axis = Blender Z (three.js Y), origin = center.
# =============================================================================================

FUSE_R_GLASS = 0.0084
FUSE_R_CAP = 0.0105


def _fuse_cap_profile(hi: bool):
    """(r, z) for the +Z ferrule, from the glass junction out and up to the axis."""
    R = FUSE_R_CAP
    if not hi:
        return [(0.0087, 0.0357), (0.0101, 0.0360), (R, 0.0369), (R, 0.0526), (0.0099, 0.0547),
                (0.0062, 0.0553), (0.0, 0.0555)]
    p = [(0.0087, 0.0357), (0.0097, 0.03575), (0.01025, 0.0361), (R + 0.0001, 0.0367), (R + 0.0001, 0.0372),
         (R, 0.0376)]
    # two rolled/stamped grooves
    for zc in (0.0388, 0.0512):
        p += [(R, zc - 0.0007), (R - 0.00035, zc - 0.0003), (R - 0.00035, zc + 0.0003), (R, zc + 0.0007)]
    p += [(R, 0.0524), (0.01035, 0.0538), (0.0099, 0.0547), (0.0092, 0.0551), (0.0062, 0.0554),
          (0.0024, 0.0556), (0.0018, 0.0554), (0.0, 0.0553)]
    return p


def _fuse_parts(hi: bool, mats: dict | None):
    segs = 48 if hi else 14
    parts = []
    for sign, nm in ((1, 'cap_top'), (-1, 'cap_bot')):
        prof = [(r, z * sign) for r, z in _fuse_cap_profile(hi)]
        if sign < 0:
            prof = list(reversed(prof))
        cap = L.lathe(nm, prof, segs, smooth_deg=40 if hi else 50)
        parts.append(cap)
    # Fuse wire: diagonal from cap to cap with a slight sag, solder bead in the middle.
    pts = []
    n = 12 if hi else 7
    for i in range(n + 1):
        t = i / n
        z = -0.0365 + 0.073 * t
        x = -0.0045 + 0.009 * t
        y = 0.0012 * math.sin(math.pi * t)
        pts.append((x, y, z))
    wire = L.sweep('wire', pts, 0.00038, sides=6 if hi else 4, caps=False)
    bead = L.lathe('bead', [(0, -0.0013), (0.0009, -0.0009), (0.00125, 0.0), (0.0009, 0.0009), (0, 0.0013)],
                   12 if hi else 6, loc=(0.0, 0.0012, 0.0), rot=(0, 30, 0), smooth_deg=80)
    parts += [wire, bead]
    if mats:
        for o in parts[:2]:
            L.assign(o, mats['brass'])
        L.assign(wire, mats['wire'])
        L.assign(bead, mats['solder'])
    return parts


def build_fuse(final: bool = True) -> None:
    common.reset()
    stamp_a = L.Decal('fuse_a', 1024, 64)
    stamp_a.text(512, 32, '30 AMP  •  250 V  •  RENEWABLE', 50, (1, 1, 1), kind='sans_bold', spacing=1.15)
    img_a = stamp_a.render()
    stamp_b = L.Decal('fuse_b', 1024, 64)
    stamp_b.text(512, 32, 'NORA ELECTRIC  •  No. 4  •  U.S.A.', 50, (1, 1, 1), kind='sans_bold', spacing=1.15)
    img_b = stamp_b.render()

    def stamp(k: L.Kit):
        a = k.decal(img_a, k.cyl_uv(-80, 160, 0.0425, 0.0477))
        b = k.decal(img_b, k.cyl_uv(100, 160, -0.0477, -0.0425))
        return k.ramp_f(k.maxf(a, b), 0.2, 0.8)

    mats = dict(
        brass=M.brass('fuse_brass_src', s=0.35, tarnish=0.8, stamp=stamp, warm=1.0, grime=1.3),
        wire=M.copper_wire('fuse_wire_src'),
        solder=M.tin('fuse_solder_src', s=0.2, rust=0.0),
    )
    highs = _fuse_parts(True, mats)
    lows = _fuse_parts(False, None)
    low = L.join(lows, 'fuse_body')
    L.triangulate(low)
    glass = L.lathe('glass', [(FUSE_R_GLASS, -0.0372), (FUSE_R_GLASS, 0.0372)], 16, smooth_deg=60)
    L.uv_unwrap(low, margin=0.006)
    size = L.tex_size(512)
    L.bake_atlas(low, 'fuse', size, highs, samples_=L.samples(24), extrusion=0.0008, max_ray=0.0025)
    for o in highs:
        L.delete(o)
    # Old glass: faint green-gray, clear, glossy.
    L.assign(glass, L.flat_material('fuse_glass', color=(0.36, 0.44, 0.40), rough=0.04, alpha=0.2,
                                    culling=False))
    common.report('fuse', [low, glass])
    common.export_glb('fuse', [low, glass])
    L.previews('fuse', [low, glass], [('3q', dict(yaw=35, pitch=15, mood='studio')),
                                      ('flash', dict(yaw=20, pitch=10, mood='flash'))], final=final)
