"""
window_frame.glb: a painted wooden double-hung (2-over-2) window for a 1.0 m x 1.2 m wall opening.

Origin = center of the opening on the wall's INNER surface (y = 0 in Blender, the room is +Y, the
wall runs back to y = -0.2). Jamb liners line the opening, the two sashes sit in it (lower sash
on the room side), casing + back band frame it on the wall, and the stool (interior sill) sticks
out 5 cm into the room above an apron. Everything painted is mapped at real scale onto the
tileable wood_trim set; the glass is a separate alpha-blended mesh (`glass`) with a generated
atlas: dirt film, rain streaks, grime packed into the corners, one cracked pane and one pane with a
punched-out hole, and a cobweb.

glTF extras: size [1.0, 1.2, 0.2] (the opening it fits, three.js axes), opening [1.0, 1.2],
placement 'wall'. The game scales the model to each window's width / height.
Helper module (built through trims.py).
"""

from __future__ import annotations

import math
import os

import bpy
import numpy as np

import common as C
import trims_lib as T
from surfaces_lib import F32, Tex, hexc, sstep, standardize

W, H, D = 1.0, 1.2, 0.2   # opening
HW, HH = W / 2, H / 2


def build() -> None:
    print('trims_window: built through trims.py')


# =============================================================================================
# Glass atlas (2 x 2 panes)
# =============================================================================================

def _pane(seed: int, kind: str, n: int = 512, aspect: float = 0.85):
    """One pane (n x n px, u across, v up). Returns rgba (sRGB color + alpha), rough, height."""
    P = Tex(n, 0.5, seed)
    rng = P.rng
    u, v = P.u, P.v
    # distance to the frame (meters, using the real pane aspect)
    dx = np.minimum(u, 1 - u) * 0.42
    dy = np.minimum(v, 1 - v) * 0.5
    de = np.minimum(dx, dy)
    film = 0.30 + 0.16 * standardize(P.fbm(3, octaves=4)) * 0.5 + 0.05 * standardize(P.fbm(20, octaves=3)) * 0.5
    streak = np.clip(P.spectral(beta=2.2, fmin=2, aniso=(1.0, 5.0)) * 0.06, -0.08, 0.15)
    edge_grime = sstep(0.045, 0.004, de + 0.012 * P.fbm(10, octaves=3)) * 0.55
    corner = sstep(0.09, 0.0, np.sqrt(dx * dx + dy * dy) * 0.7 + 0.015 * P.fbm(8, octaves=3)) * 0.3
    bottom = sstep(0.12, 0.0, v * 0.5 + 0.01 * P.fbm(12, octaves=2)) * 0.3  # dirt settles low
    alpha = np.clip(film + streak + edge_grime + corner + bottom, 0.08, 0.92)
    # drip runs from the top rail
    drips = P.zeros()
    for _ in range(10):
        x = rng.uniform(0.03, 0.97) * n
        y = n * rng.uniform(0.85, 1.0)
        pts = [(x + rng.normal(0, 0.8) * i ** 0.5, y - i * 6) for i in range(int(rng.uniform(15, 70)))]
        P.stroke(drips, pts, rng.uniform(2, 5), soft=2.0, value=rng.uniform(0.3, 0.7))
    alpha = np.clip(alpha + P.blur(drips, 1.2) * 0.25, 0, 0.95)
    col = np.empty((n, n, 3), F32)
    col[:] = hexc('#565246')
    col = col * (0.8 + 0.3 * np.clip(alpha, 0, 1))[..., None]
    rough = 0.08 + 0.75 * np.clip((alpha - 0.1) / 0.6, 0, 1)
    height = P.fbm(2, 8, octaves=2) * 0.0004  # wavy cylinder glass (horizontal ripples)
    cracks = P.zeros()
    hole = P.zeros()
    if kind == 'cracked':
        x0, y0 = n * 0.08, n * 0.9
        pts = P.crack_path(x0, y0, n * 1.2, -0.85, step=3, wiggle=0.25)
        P.stroke(cracks, pts, 1.6, soft=0.7)
        for _ in range(4):
            k = rng.integers(10, len(pts) - 10)
            bx, by = pts[k]
            br = P.crack_path(bx, by, n * rng.uniform(0.15, 0.45), -0.85 + rng.choice([-1, 1]) * rng.uniform(0.6, 1.2),
                              step=3, wiggle=0.3)
            P.stroke(cracks, br, 1.2, soft=0.7)
    if kind == 'hole':
        cx, cy = n * 0.62, n * 0.38
        du = (u * n - cx)
        dv = (v * n - cy)
        ang = np.arctan2(dv, du)
        r = np.sqrt(du * du + dv * dv)
        jag = 1 + 0.35 * np.abs(np.sin(ang * 2.5 + 0.4)) + 0.2 * np.sin(ang * 7.0) + 0.1 * np.sin(ang * 17.0)
        hole = sstep(n * 0.075, n * 0.07, r / jag)
        for i in range(9):
            a = i / 9 * 2 * math.pi + rng.normal(0, 0.2)
            pts = P.crack_path(cx + math.cos(a) * n * 0.06, cy + math.sin(a) * n * 0.06,
                               n * rng.uniform(0.25, 0.6), a, step=3, wiggle=0.15)
            P.stroke(cracks, pts, np.linspace(1.8, 0.8, len(pts)), soft=0.7)
        for rr in (0.12, 0.2):
            k = 40
            pts = [(cx + math.cos(t) * n * rr * (1 + 0.15 * math.sin(t * 5)), cy + math.sin(t) * n * rr * (1 + 0.15 * math.sin(t * 5)))
                   for t in np.linspace(0, 2 * math.pi, k)]
            seg = P.zeros()
            P.stroke(seg, pts, 1.1, soft=0.7)
            cracks = np.maximum(cracks, seg * (P.fbm(6, octaves=2) > -0.05))
    web = P.zeros()
    if kind == 'web':
        cx, cy = n * 0.985, n * 0.985  # top-right corner
        for i in range(9):
            a = math.pi + (i / 8) * (math.pi / 2) + rng.normal(0, 0.05)
            ln = n * rng.uniform(0.28, 0.42)
            P.stroke(web, [(cx, cy), (cx + math.cos(a) * ln, cy + math.sin(a) * ln)], 0.9, soft=0.6, value=0.8)
        for k in range(1, 16):
            rr = n * 0.02 * k ** 1.15
            pts = [(cx + math.cos(t) * rr * (1 + 0.08 * math.sin(t * 9 + k)), cy + math.sin(t) * rr)
                   for t in np.linspace(math.pi, 1.5 * math.pi, 18)]
            P.stroke(web, pts, 0.7, soft=0.6, value=0.55)
        web = web * (P.fbm(20, octaves=2) > -0.25)
    # compose cracks: bright refracting line + dirt along it
    alpha = np.maximum(alpha, cracks * 0.85)
    col = col + (np.array([0.70, 0.72, 0.70], F32) - col) * cracks[..., None]
    alpha = np.maximum(alpha, web * 0.6)
    col = col + (np.array([0.78, 0.78, 0.74], F32) - col) * web[..., None]
    alpha = alpha * (1 - hole)
    rough = np.where(cracks > 0.3, 0.3, rough) * (1 - hole) + hole * 1.0
    height = height + cracks * 0.0002
    rgba = np.concatenate([col, alpha[..., None]], -1)
    return rgba.astype(F32), rough.astype(F32), height.astype(F32), P


def glass_atlas(n: int = 1024):
    """2 x 2 atlas: [0] lower-left pane, [1] lower-right, [2] upper-left, [3] upper-right."""
    h = n // 2
    rgba = np.zeros((n, n, 4), F32)
    rough = np.zeros((n, n), F32)
    height = np.zeros((n, n), F32)
    kinds = ['plain', 'cracked', 'hole', 'web']
    P = None
    for i, kind in enumerate(kinds):
        r, ro, he, P = _pane(100 + i, kind, h)
        qx, qy = i % 2, i // 2
        rgba[qy * h:(qy + 1) * h, qx * h:(qx + 1) * h] = r
        rough[qy * h:(qy + 1) * h, qx * h:(qx + 1) * h] = ro
        height[qy * h:(qy + 1) * h, qx * h:(qx + 1) * h] = he
    A = Tex(n, 1.0, 1)
    nrm = A.normal_from_height(height, strength=1.0)
    orm = np.stack([np.ones_like(rough), rough, np.zeros_like(rough)], -1)
    return rgba, orm, nrm


# =============================================================================================
# Geometry
# =============================================================================================

def build_window() -> list:
    C.reset()
    b = T.board
    parts = []
    # --- jamb liners in the opening ---------------------------------------------------------------
    parts += [b('jamb_l', (-HW, -D, -HH), (-HW + 0.02, 0.0, HH), drop=('-x',), long_axis='z', bevel=0.002),
              b('jamb_r', (HW - 0.02, -D, -HH), (HW, 0.0, HH), drop=('+x',), long_axis='z', bevel=0.002),
              b('jamb_head', (-HW + 0.02, -D, HH - 0.02), (HW - 0.02, 0.0, HH), drop=('+z',), long_axis='x', bevel=0.002)]
    # exterior sill (in the opening) + stool (interior sill, 5 cm proud of the wall) + apron
    parts.append(b('sill_ext', (-HW + 0.02, -D, -HH), (HW - 0.02, -0.08, -HH + 0.015), long_axis='x', bevel=0.003))
    parts.append(b('stool', (-0.63, -0.08, -HH - 0.028), (0.63, 0.05, -HH), long_axis='x', bevel=0.007, segments=2))
    parts.append(b('apron', (-0.575, 0.0, -HH - 0.125), (0.575, 0.016, -HH - 0.028), drop=('-y', '+z'), long_axis='x',
                   bevel=0.003))
    # --- casing + back band ----------------------------------------------------------------------
    ci = 0.485          # casing inner edge (5 mm reveal off the jamb face at 0.48)
    cw = 0.09           # casing width
    top = HH - 0.015    # casing inner edge at the head
    for s, nm in ((-1, 'l'), (1, 'r')):
        x0, x1 = sorted((s * ci, s * (ci + cw)))
        parts.append(b(f'casing_{nm}', (x0, 0.0, -HH), (x1, 0.02, top + cw), drop=('-y', '-z'), long_axis='z', bevel=0.003))
        bx0, bx1 = sorted((s * (ci + cw - 0.004), s * (ci + cw + 0.016)))
        parts.append(b(f'band_{nm}', (bx0, 0.0, -HH), (bx1, 0.03, top + cw + 0.02), drop=('-y', '-z'), long_axis='z',
                       bevel=0.004, segments=2))
    parts.append(b('casing_head', (-(ci + cw - 0.004), 0.0, top), (ci + cw - 0.004, 0.022, top + cw), drop=('-y',),
                   long_axis='x', bevel=0.003))
    parts.append(b('cap', (-(ci + cw + 0.022), 0.0, top + cw), (ci + cw + 0.022, 0.034, top + cw + 0.02), drop=('-y',),
                   long_axis='x', bevel=0.004, segments=2))
    # --- stops + parting beads ---------------------------------------------------------------------
    for s, nm in ((-1, 'l'), (1, 'r')):
        x0, x1 = sorted((s * 0.48, s * 0.465))
        parts.append(b(f'stop_{nm}', (x0, -0.034, -HH + 0.015), (x1, -0.018, HH - 0.02), drop=('-x' if s < 0 else '+x',),
                       long_axis='z', bevel=0.002))
        parts.append(b(f'part_{nm}', (x0, -0.081, -0.0), (x1, -0.073, HH - 0.02), drop=('-x' if s < 0 else '+x',),
                       long_axis='z', bevel=0.0015))
    parts.append(b('stop_head', (-0.465, -0.034, HH - 0.035), (0.465, -0.018, HH - 0.02), drop=('+z',), long_axis='x',
                   bevel=0.002))
    # --- sashes --------------------------------------------------------------------------------
    def sash(tag, y0, y1, z0, z1, bottom_rail, top_rail, meet_low):
        out = []
        out.append(b(f'{tag}_stile_l', (-0.465, y0, z0), (-0.415, y1, z1), long_axis='z', bevel=0.003))
        out.append(b(f'{tag}_stile_r', (0.415, y0, z0), (0.465, y1, z1), long_axis='z', bevel=0.003))
        out.append(b(f'{tag}_rail_b', (-0.415, y0, z0), (0.415, y1, z0 + bottom_rail), long_axis='x', bevel=0.003))
        out.append(b(f'{tag}_rail_t', (-0.415, y0, z1 - top_rail), (0.415, y1, z1), long_axis='x', bevel=0.003))
        ym = (y0 + y1) / 2
        out.append(b(f'{tag}_muntin', (-0.011, ym - 0.009, z0 + bottom_rail), (0.011, ym + 0.009, z1 - top_rail),
                     long_axis='z', bevel=0.003))
        return out

    # lower sash (room side): bottom rail 7.5 cm, meeting rail 3.5 cm
    parts += sash('lo', -0.07, -0.036, -HH + 0.015, 0.02, 0.075, 0.035, True)
    # upper sash (outside): meeting rail at the bottom, top rail 5 cm
    parts += sash('up', -0.115, -0.082, -0.015, HH - 0.02, 0.035, 0.05, False)
    # painted-over sash lock + two lifts
    parts.append(b('lock_base', (-0.035, -0.072, 0.02), (0.035, -0.04, 0.032), drop=('-z',), bevel=0.003, segments=2))
    parts.append(b('lock_cam', (0.0, -0.09, 0.032), (0.045, -0.06, 0.042), drop=('-z',), bevel=0.003, segments=2))
    for x in (-0.25, 0.25):
        parts.append(b(f'lift_{x}', (x - 0.022, -0.036, -HH + 0.045), (x + 0.022, -0.02, -HH + 0.07), drop=('-y',),
                       bevel=0.003, segments=2))
    wood = T.finish_objects(parts, T.wood_trim_material(), 'window_frame')

    # --- glass ---------------------------------------------------------------------------------
    m = 0.006   # glazing overlap hidden in the rails
    e = 4 / 1024  # atlas inset
    panes = [
        # (x0, x1, z0, z1, y, atlas index)
        (-0.415 - m, -0.011 + m, -HH + 0.015 + 0.075 - m, 0.02 - 0.035 + m, -0.053, 0),
        (0.011 - m, 0.415 + m, -HH + 0.015 + 0.075 - m, 0.02 - 0.035 + m, -0.053, 1),
        (-0.415 - m, -0.011 + m, -0.015 + 0.035 - m, HH - 0.02 - 0.05 + m, -0.0985, 2),
        (0.011 - m, 0.415 + m, -0.015 + 0.035 - m, HH - 0.02 - 0.05 + m, -0.0985, 3),
    ]
    gl = []
    for i, (x0, x1, z0, z1, y, idx) in enumerate(panes):
        qx, qy = idx % 2, idx // 2
        u0, u1, v0, v1 = qx * 0.5 + e, qx * 0.5 + 0.5 - e, qy * 0.5 + e, qy * 0.5 + 0.5 - e
        gl.append(T.quad(f'pane{i}', [(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)],
                         [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]))
    rgba, orm, nrm = glass_atlas()
    tmp = bpy.app.tempdir or '/tmp'
    imgs = {}
    orm = orm[::2, ::2]  # roughness varies slowly: 512 px is plenty
    nrm = nrm[::2, ::2]
    for k, arr in (('color', rgba), ('orm', orm), ('normal', nrm)):
        p = os.path.join(tmp, f'window_glass_{k}.webp')
        T.save_rgba(p, arr, quality=84)
        imgs[k] = T.load_image(p, k != 'color')
        imgs[k].pack()
    gmat = T.textured_material('glass', imgs['color'], imgs['orm'], imgs['normal'], alpha=True, occlusion=False,
                               normal_strength=0.6)
    next(n for n in gmat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED').inputs['IOR'].default_value = 1.5
    glass = T.finish_objects(gl, gmat, 'glass', smooth_deg=10)
    glass.parent = wood
    return [wood, glass]
