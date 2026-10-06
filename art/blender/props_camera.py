"""
camera.glb: a 1970s boxy instant camera, the "VESPER INSTANT 70", with a pop-up electronic
flash bar. Black pebbled leatherette band between brushed-aluminum top/bottom plates, black
enamel lens barrel (brassing through at the edges) with a knurled focus ring and an engraved
bezel, selenium meter window, viewfinder, red shutter button, exposure wheel, strap lugs, and on
the back an eyepiece and the film-counter window.

Nodes (art/README.md): `camera_body` (atlas), `lens` (front element, own material sharing the
atlas images; node origin = glass front center = where the flash/shot comes from),
`flash_reflector` (own material: the game makes it glow; origin = reflector center),
`film_screen` (40 x 20 mm plane on the back, own material, UVs 0..1 with u -> +X and v -> up
as seen from behind; the game draws the film counter on it).

Frame: Blender +Y = front (three.js -Z), origin = center of the right-hand grip (+X end).
"""

from __future__ import annotations

import math

import bpy
import bmesh
from mathutils import Vector

import common
import props_lib as L
import props_mats as M


def build() -> None:
    """art/build.py imports every module here and calls build(); props.py drives this one."""


# Body frame (before the final shift to the grip origin). Units: meters.
BW, BD = 0.150, 0.058          # leatherette band footprint
PW, PD = 0.1516, 0.0596        # aluminum plates footprint (overhang the band a little)
Z_BOT, Z_TOP, Z_TT = 0.008, 0.060, 0.072
FRONT = BD / 2                 # band front face (y)
BACK = -BD / 2
LX, LZ = -0.012, 0.034         # lens axis (x, z); axis along +Y
GRIP = (0.057, 0.004, 0.034)   # final origin
FLASH_X0, FLASH_X1 = -0.058, 0.030
FLASH_Y0, FLASH_Y1 = -0.008, 0.022
FLASH_Z0, FLASH_Z1 = 0.079, 0.105
FLASH_ZC = (FLASH_Z0 + FLASH_Z1) / 2
OPEN_X0, OPEN_X1 = -0.0525, 0.0245
OPEN_H = 0.0130
SCREEN = dict(cx=-0.010, cz=0.034, w=0.040, h=0.020)
EYEPIECE = dict(cx=-0.054, cz=0.047)
KNOB = (-0.059, 0.006)
SHUTTER = (0.053, 0.006)
VIEWF = dict(cx=-0.058, cz=0.049)
METER = dict(cx=0.027, cz=0.048)


def _delete_faces(obj, pred):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    kill = [f for f in bm.faces if pred(f)]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(obj.data)
    bm.free()


def _lens_lathe(name, prof, segs):
    """Lathe around the lens axis: profile (r, d) with d measured forward from the band front."""
    o = L.lathe(name, prof, segs, smooth_deg=38)
    L.xform(o, (LX, FRONT, LZ), (-90, 0, 0))
    return o


def _decals():
    imgs = {}
    # Top plate, front edge (seen from the front: u runs toward -X).
    d = L.Decal('cam_top_front', 1024, 80)
    d.text(1024 * 0.205, 40, 'VESPER', 58, (1, 1, 1), kind='serif_bold', spacing=1.12)
    d.text(1024 * 0.865, 40, 'INSTANT 70', 30, (1, 1, 1), kind='sans_bold', spacing=1.25)
    imgs['top_front'] = d.render()
    # Top plate, back edge (seen from behind: u runs toward +X).
    d = L.Decal('cam_top_back', 1024, 80)
    d.text(1024 * 0.33, 40, 'No. 70-41187', 20, (1, 1, 1), kind='sans_bold', spacing=1.2)
    d.text(1024 * 0.70, 40, 'VESPER CAMERA CO.  •  MADE IN U.S.A.', 19, (1, 1, 1), kind='sans_bold', spacing=1.2)
    imgs['top_back'] = d.render()
    # Top plate, top face around the exposure wheel and shutter.
    W, H = 1024, int(1024 * PD / PW)
    px = W / PW
    d = L.Decal('cam_top_top', W, H)

    def at(x, y):
        return ((x + PW / 2) * px, (y + PD / 2) * px)

    kx, ky = at(*KNOB)
    d.text(kx - 0.0085 * px, ky + 0.0118 * px, 'L', 26, (1, 1, 1), kind='sans_bold')
    d.text(kx + 0.0085 * px, ky + 0.0118 * px, 'D', 26, (1, 1, 1), kind='sans_bold')
    d.poly([(kx - 0.0045 * px, ky + 0.0118 * px), (kx - 0.0015 * px, ky + 0.0133 * px),
            (kx - 0.0015 * px, ky + 0.0103 * px)], (1, 1, 1))
    d.poly([(kx + 0.0045 * px, ky + 0.0118 * px), (kx + 0.0015 * px, ky + 0.0103 * px),
            (kx + 0.0015 * px, ky + 0.0133 * px)], (1, 1, 1))
    sx, sy = at(*SHUTTER)
    d.ring(sx, sy, 0.0074 * px, 0.0080 * px, (1, 1, 1))
    d.poly([(sx, sy - 0.0098 * px), (sx - 0.0016 * px, sy - 0.0122 * px), (sx + 0.0016 * px, sy - 0.0122 * px)],
           (1, 1, 1))
    d.text(sx, sy - 0.0150 * px, 'PUSH', 16, (1, 1, 1), kind='sans_bold', spacing=1.2)
    imgs['top_top'] = d.render()
    # Flash housing back (faces the photographer).
    d = L.Decal('cam_flash_back', 512, 128)
    d.text(256, 74, 'VESPER', 86, (1, 1, 1), kind='serif_bold', spacing=1.15)
    d.text(256, 22, 'ELECTRONIC  FLASH  •  70', 21, (1, 1, 1), kind='sans_bold', spacing=1.25)
    imgs['flash_back'] = d.render()
    # Lens bezel ring (polar, 200 degrees over the top).
    d = L.Decal('cam_bezel', 1024, 44)
    d.text(512, 22, 'VESPAR-ANASTIGMAT   1:8   f = 114 mm   No. 418873', 29, (1, 1, 1), kind='sans_bold',
           spacing=1.1)
    imgs['bezel'] = d.render()
    # Paper film sticker on the back (full color).
    d = L.Decal('cam_sticker', 512, 448, bg=(0.56, 0.50, 0.36, 1))
    red, ink = (0.30, 0.03, 0.02, 1), (0.03, 0.025, 0.02, 1)
    d.rect(0, 340, 512, 448, red)
    d.text(256, 394, 'VESPER', 74, (0.62, 0.56, 0.42, 1), kind='serif_bold', spacing=1.1)
    d.text(256, 292, 'INSTANT 70 FILM', 40, ink, kind='sans_bold', spacing=1.15)
    d.text(256, 240, '8 EXPOSURES  \u2022  ASA 400', 28, ink, kind='sans_bold', spacing=1.1)
    d.rect(36, 196, 476, 199, ink)
    d.text(48, 150, 'LOADED:', 30, ink, kind='sans_bold', align='LEFT')
    d.text(250, 148, 'oct 3', 44, (0.04, 0.05, 0.16, 1), kind='serif', align='LEFT', rot=-3.0)
    d.text(48, 84, 'EXPOSED:', 30, ink, kind='sans_bold', align='LEFT')
    d.text(262, 84, '\u2716 \u2716 \u2716 \u2716 \u2716', 28, (0.04, 0.05, 0.16, 1), kind='sans', align='LEFT')
    d.rect(0, 0, 512, 26, red)
    imgs['sticker'] = d.render()
    return imgs


def _materials(imgs):
    def top_front(k):
        m = k.decal(imgs['top_front'], k.plane_uv((0, FRONT + 0.0008, 0.066), (-1, 0, 0), (0, 0, 1), PW,
                                                  PW * 80 / 1024))
        return k.mul(m, k.ramp_f(k.xyz(k.coord())[1], PD / 2 - 0.0006, PD / 2 - 0.0002))

    def top_back(k):
        m = k.decal(imgs['top_back'], k.plane_uv((0, BACK - 0.0008, 0.066), (1, 0, 0), (0, 0, 1), PW,
                                                 PW * 80 / 1024))
        return k.mul(m, k.ramp_f(k.xyz(k.coord())[1], -PD / 2 + 0.0006, -PD / 2 + 0.0002))

    def top_top(k):
        m = k.decal(imgs['top_top'], k.plane_uv((0, 0, Z_TT), (1, 0, 0), (0, 1, 0), PW, PD))
        x, y, z = k.xyz(k.coord())
        return k.mul(m, k.ramp_f(z, Z_TT - 0.0006, Z_TT - 0.0002))

    def flash_back(k):
        m = k.decal(imgs['flash_back'], k.plane_uv(((FLASH_X0 + FLASH_X1) / 2, FLASH_Y0, FLASH_ZC + 0.0005),
                                                   (1, 0, 0), (0, 0, 1), 0.064, 0.016))
        x, y, z = k.xyz(k.coord())
        return k.mul(m, k.ramp_f(y, FLASH_Y0 + 0.0008, FLASH_Y0 + 0.0002))

    def bezel_text(k):
        m = k.decal(imgs['bezel'], k.polar_uv((LX, 0, LZ), (-1, 0, 0), (0, 0, 1), 190.0, 200.0, 0.0172, 0.0199))
        x, y, z = k.xyz(k.coord())
        return k.mul(m, k.ramp_f(y, FRONT + 0.0230, FRONT + 0.0234))

    white_fill = (0.62, 0.60, 0.55)
    black_fill = (0.012, 0.011, 0.010)

    def door_seam(k):
        outer = k.box_mask((-0.0702, BACK - 0.003, 0.0118), (0.0702, BACK + 0.001, 0.0562), soft=0.00015)
        inner = k.box_mask((-0.0695, BACK - 0.004, 0.0125), (0.0695, BACK + 0.002, 0.0555), soft=0.00015)
        return k.sub(outer, inner, clamp=True)

    def peel(k):
        # torn-off leatherette at the bottom corner (front, -X end): organic edge around the corner
        x, y, z = k.xyz(k.coord())
        d = k.vmath('LENGTH', k.vmath('SUBTRACT', k.coord(), (-BW / 2, FRONT, Z_BOT)), out=1)
        n = k.noise(scale=140, detail=6, rough=0.7)
        return k.ramp_f(k.add(d, k.mul(n, 0.008)), 0.0142, 0.0138)

    stk = dict(cx=0.040, cz=0.033, w=0.032, h=0.028)

    def sticker_mask(k):
        x, y, z = k.xyz(k.coord())
        r = k.box_mask((stk['cx'] - stk['w'] / 2, BACK - 0.003, stk['cz'] - stk['h'] / 2),
                       (stk['cx'] + stk['w'] / 2, BACK + 0.0006, stk['cz'] + stk['h'] / 2), soft=0.0002)
        # a corner torn away + ragged edge
        n = k.noise(scale=500, detail=4)
        torn = k.ramp_f(k.add(k.sub(x, z), k.mul(n, 0.004)), stk['cx'] + stk['w'] / 2 - stk['cz'] - stk['h'] / 2 + 0.010,
                        stk['cx'] + stk['w'] / 2 - stk['cz'] - stk['h'] / 2 + 0.0095)
        return k.mul(r, torn)

    def sticker_color(k):
        c = k.decal(imgs['sticker'], k.plane_uv((stk['cx'], BACK, stk['cz']), (1, 0, 0), (0, 0, 1), stk['w'], stk['h']))
        n = k.noise(scale=220, detail=5)
        dirt = k.mul(k.ramp_f(n, 0.45, 0.75), 0.5)
        c = k.mix(dirt, c, (0.20, 0.16, 0.10))
        return k.mix(k.mul(k.ramp_f(k.noise(scale=900, detail=2), 0.6, 0.7), 0.6), c, (0.70, 0.66, 0.55))

    def peel_rim(k):
        d = k.vmath('LENGTH', k.vmath('SUBTRACT', k.coord(), (-BW / 2, FRONT, Z_BOT)), out=1)
        n = k.noise(scale=140, detail=6, rough=0.7)
        v = k.add(d, k.mul(n, 0.008))
        return k.mul(k.ramp_f(v, 0.0138, 0.0142), k.ramp_f(v, 0.0152, 0.0146))

    def slot(k):
        return k.box_mask((-0.040, FRONT, 0.0032), (0.026, FRONT + 0.003, 0.0052), soft=0.00012)

    def tripod(k):
        x, y, z = k.xyz(k.coord())
        r = k.math('SQRT', k.add(k.mul(k.sub(x, LX), k.sub(x, LX)), k.mul(y, y)))
        bottom = k.ramp_f(z, 0.0006, 0.0002)
        return k.mul(k.ramp_f(r, 0.0040, 0.0036), bottom)

    def tripod_hole(k):
        x, y, z = k.xyz(k.coord())
        r = k.math('SQRT', k.add(k.mul(k.sub(x, LX), k.sub(x, LX)), k.mul(y, y)))
        bottom = k.ramp_f(z, 0.0006, 0.0002)
        return k.mul(k.ramp_f(r, 0.0029, 0.0025), bottom)

    def knob_index(k):
        return k.box_mask((KNOB[0] - 0.0004, KNOB[1] + 0.0010, Z_TT + 0.0060), (KNOB[0] + 0.0004, KNOB[1] + 0.0060,
                                                                              Z_TT + 0.0075), soft=0.0001)

    def screw_slot(k):
        # slots of the high-poly screw heads: a thin band through each head's center (along X)
        x, y, z = k.xyz(k.coord())
        m = None
        for sx, sy in ((-0.064, 0.021), (0.064, 0.021), (-0.064, -0.021), (0.064, -0.021)):
            b = k.box_mask((sx - 0.0021, sy - 0.0003, -0.002), (sx + 0.0021, sy + 0.0003, 0.0003), soft=0.0001)
            m = b if m is None else k.maxf(m, b)
        for sx in (-0.068, 0.068):
            b = k.box_mask((sx - 0.0003, -0.0193, Z_TT - 0.0003), (sx + 0.0003, -0.0151, Z_TT + 0.002), soft=0.0001)
            m = k.maxf(m, b)
        return m

    mats = dict(
        leather=M.leatherette('cam_leather', marks=[
            dict(mask=door_seam, color=(0.008, 0.007, 0.006), rough=0.8, height=-1.2),
            dict(mask=peel_rim, color=(0.16, 0.13, 0.09), rough=0.85, height=0.8),
            dict(mask=peel, color=(0.52, 0.52, 0.50), rough=0.38, metal=1.0, height=-1.0),
            dict(mask=sticker_mask, color=sticker_color, rough=0.8, metal=0.0, height=0.5),
        ]),
        alu_top=M.aluminum('cam_alu_top', brush_axis='X', marks=[
            M.engraved(top_front, color=black_fill),
            M.engraved(top_back, color=black_fill, depth=-1.0),
            M.engraved(top_top, color=black_fill, depth=-1.0),
        ]),
        alu_bot=M.aluminum('cam_alu_bot', brush_axis='X', tone=0.92, marks=[
            dict(mask=slot, color=(0.006, 0.006, 0.006), rough=0.9, metal=0.0, height=-2.5),
            dict(mask=tripod, color=(0.55, 0.40, 0.18), rough=0.4, metal=1.0, height=-0.5),
            dict(mask=tripod_hole, color=(0.01, 0.009, 0.008), rough=0.8, metal=0.0, height=-2.0),
        ]),
        alu=M.aluminum('cam_alu', brush_axis='Y'),
        alu_knob=M.aluminum('cam_alu_knob', brush_axis='Z', marks=[
            dict(mask=lambda k: k.mul(k.ramp_f(k.ridges('Z', 32, center=KNOB), 0.5, 0.9),
                                      k.ramp_f(k.xyz(k.coord())[2], Z_TT + 0.0058, Z_TT + 0.0054)),
                 height=1.5),
            M.engraved(knob_index, color=(0.5, 0.06, 0.03), depth=-0.8),
        ]),
        bezel=M.aluminum('cam_bezel', brush_axis='Y', tone=0.95, marks=[
            M.engraved(bezel_text, color=white_fill, rough=0.5, depth=-0.6),
        ]),
        enamel=M.black_enamel('cam_enamel'),
        enamel_flash=M.black_enamel('cam_enamel_flash', under=(0.50, 0.50, 0.48), marks=[
            M.printed(flash_back, (0.55, 0.53, 0.47), rough=0.5),
        ]),
        focus=M.black_enamel('cam_focus', gloss=0.5, height_fn=lambda k: k.knurl('Y', 0.0228, 0.0009,
                                                                                center=(LZ, LX))),
        matte=M.plastic('cam_matte', (0.008, 0.008, 0.008), rough=0.85),
        chrome=M.chrome('cam_chrome', marks=[M.engraved(screw_slot, color=(0.02, 0.018, 0.015), depth=-2.0)]),
        red=M.plastic('cam_red', (0.26, 0.018, 0.012), rough=0.32, wear_color=(0.42, 0.10, 0.06)),
        rubber=M.rubber('cam_rubber'),
        dglass=M.dark_glass('cam_dark_glass'),
        lens=M.lens_glass('cam_lens_glass', (LX, FRONT + 0.0199, LZ), radius=0.0128),
        refl=M.reflector('cam_reflector', bright=1.15),
        xenon=M.frosted('cam_xenon', color=(0.62, 0.62, 0.58), rough=0.12),
        meter=_meter_material(),
    )
    return mats


def _meter_material():
    def fn(k: L.Kit):
        v = k.mapping(scale=(1, 1, 1))
        cell = k.voronoi(scale=1300, vec=v, feature='F1', rand=0.0)
        n = k.noise(scale=800, detail=2)
        col = k.mix(k.ramp_f(cell, 0.15, 0.5), (0.020, 0.021, 0.024), (0.006, 0.006, 0.008))
        return dict(color=col, rough=k.add(0.06, k.mul(n, 0.1)), metal=0.0, height=k.ramp_f(cell, 0.5, 0.0),
                    bump=0.8, bump_dist=0.0002)

    return L.pbr('cam_meter', fn)


def _parts(hi: bool, mats: dict | None):
    """Returns list of (object, material key, part id)."""
    out = []

    def add(o, key, pid=0):
        out.append((o, key, pid))
        return o

    sv, se = (8, 3) if hi else (3, 1)
    # --- body slabs
    add(L.rounded_box('bot_plate', (PW, PD, Z_BOT), (0, 0, Z_BOT / 2), 0.0062, 0.0012, sv, se), 'alu_bot')
    band = L.rounded_box('band', (BW, BD, Z_TOP - Z_BOT), (0, 0, (Z_TOP + Z_BOT) / 2), 0.0055, 0.0006,
                         sv, 2 if hi else 1)
    add(band, 'leather')
    add(L.rounded_box('top_plate', (PW, PD, Z_TT - Z_TOP), (0, 0, (Z_TOP + Z_TT) / 2), 0.0062, 0.0015, sv, se),
        'alu_top')
    grip = L.rounded_box('grip', (0.032, 0.0145, 0.046), (0.0575, FRONT + 0.0062, 0.034), 0.0058, 0.0016, sv, se)
    _delete_faces(grip, lambda f: f.normal.y < -0.9)
    add(grip, 'leather')

    # --- lens (profiles: r, distance in front of the band)
    ls = 96 if hi else 32
    if hi:
        add(_lens_lathe('lens_mount', [(0.0262, -0.0010), (0.0263, 0.0010), (0.0261, 0.0016), (0.0255, 0.0024),
                                       (0.0247, 0.0026), (0.0222, 0.0026)], ls), 'alu')
        add(_lens_lathe('lens_barrel', [(0.0215, 0.0020), (0.0215, 0.0082), (0.0220, 0.0086), (0.0228, 0.0089),
                                        (0.0228, 0.0159), (0.0220, 0.0163), (0.0212, 0.0167)], ls), 'focus')
        add(_lens_lathe('lens_barrel2', [(0.0212, 0.0167), (0.0212, 0.0200)], ls), 'enamel')
        add(_lens_lathe('lens_bezel', [(0.0212, 0.0200), (0.0210, 0.0222), (0.0207, 0.0230), (0.0201, 0.0235),
                                       (0.0196, 0.0236), (0.0170, 0.0236), (0.0165, 0.0233), (0.0161, 0.0229)], ls),
            'bezel')
        add(_lens_lathe('lens_recess', [(0.0161, 0.0229), (0.0150, 0.0207), (0.0138, 0.0186), (0.0128, 0.0180)], ls),
            'matte')
        add(_lens_lathe('lens_glass', [(0.0128, 0.0180), (0.0110, 0.0189), (0.0080, 0.0195), (0.0040, 0.0198),
                                       (0.0, 0.0199)], ls), 'lens', 1)
    else:
        add(_lens_lathe('lens_mount', [(0.0262, -0.0010), (0.0262, 0.0015), (0.0222, 0.0026)], ls), 'alu')
        add(_lens_lathe('lens_barrel', [(0.0215, 0.0020), (0.0215, 0.0083), (0.0228, 0.0089), (0.0228, 0.0159),
                                        (0.0212, 0.0167), (0.0212, 0.0200)], ls), 'enamel')
        add(_lens_lathe('lens_bezel', [(0.0212, 0.0200), (0.0205, 0.0234), (0.0168, 0.0236), (0.0161, 0.0229)], ls),
            'bezel')
        add(_lens_lathe('lens_recess', [(0.0161, 0.0229), (0.0128, 0.0180)], ls), 'matte')
        add(_lens_lathe('lens_glass', [(0.0128, 0.0180), (0.0072, 0.0195), (0.0, 0.0199)], ls), 'lens', 1)

    # --- flash bar
    hz = OPEN_H / 2
    fx = (FLASH_X0 + FLASH_X1) / 2
    house = L.rounded_box('flash_house', (FLASH_X1 - FLASH_X0, FLASH_Y1 - FLASH_Y0, FLASH_Z1 - FLASH_Z0),
                          (fx, (FLASH_Y0 + FLASH_Y1) / 2, FLASH_ZC), 0.0042, 0.0014, sv, se, axis='X')
    cut = L.box('cut', (OPEN_X1 - OPEN_X0, 0.03, OPEN_H), ((OPEN_X0 + OPEN_X1) / 2, FLASH_Y1, FLASH_ZC))
    L.boolean(house, cut)
    L.smooth_by_angle(house, 50)
    add(house, 'enamel_flash')
    add(L.frame('flash_trim', (OPEN_X1 - OPEN_X0 + 0.0036, OPEN_H + 0.0036), (OPEN_X1 - OPEN_X0, OPEN_H), 0.0011,
                (fx + (OPEN_X1 + OPEN_X0) / 2 - fx, FLASH_Y1 - 0.0002, FLASH_ZC), (-90, 0, 0),
                bevel_w=0.0004 if hi else 0.0003, bevel_segs=3 if hi else 1, back=False), 'chrome')
    # parabolic trough reflector (faces +Y), focus line where the xenon tube sits
    yv, ym = 0.0118, FLASH_Y1 - 0.0004
    f = hz * hz / (4 * (ym - yv))
    nseg = 16 if hi else 8
    bm = bmesh.new()
    rows = []
    for i in range(nseg + 1):
        zo = -hz + 2 * hz * i / nseg
        y = yv + zo * zo / (4 * f)
        rows.append((bm.verts.new((OPEN_X0 + 0.0002, y, FLASH_ZC + zo)), bm.verts.new((OPEN_X1 - 0.0002, y, FLASH_ZC + zo))))
    for i in range(nseg):
        a, b = rows[i], rows[i + 1]
        bm.faces.new((a[0], a[1], b[1], b[0]))
    # end caps (fans from the vertex line at each end)
    for side in (0, 1):
        ring = [r[side] for r in rows]
        bm.faces.new(ring if side == 0 else list(reversed(ring)))
    for fc in bm.faces:
        if fc.calc_center_median().y > 0 and fc.normal.y < 0 and abs(fc.normal.x) < 0.5:
            fc.normal_flip()
    refl = L.from_bmesh('flash_reflector', bm)
    me = refl.data
    # make sure the trough faces forward and the caps face inward
    for p in me.polygons:
        if abs(p.normal.x) < 0.5 and p.normal.y < 0:
            p.flip()
    for p in me.polygons:
        if abs(p.normal.x) > 0.5:
            if (p.center.x < (OPEN_X0 + OPEN_X1) / 2) != (p.normal.x > 0):
                p.flip()
    me.update()
    L.smooth_by_angle(refl, 45)
    add(refl, 'refl', 2)
    tube_y = yv + f
    tpts = [(OPEN_X0 + 0.0003, tube_y, FLASH_ZC), (OPEN_X0 + 0.0030, tube_y, FLASH_ZC),
            (OPEN_X0 + 0.0036, tube_y, FLASH_ZC), (OPEN_X1 - 0.0036, tube_y, FLASH_ZC),
            (OPEN_X1 - 0.0030, tube_y, FLASH_ZC), (OPEN_X1 - 0.0003, tube_y, FLASH_ZC)]
    add(L.sweep('xenon_ends', tpts[:3], [0.0019, 0.0019, 0.0015], sides=16 if hi else 8), 'chrome')
    add(L.sweep('xenon_ends2', tpts[3:], [0.0015, 0.0019, 0.0019], sides=16 if hi else 8), 'chrome')
    add(L.sweep('xenon', tpts[2:4], 0.00135, sides=16 if hi else 8), 'xenon')
    for ax in (FLASH_X0 + 0.006, FLASH_X1 - 0.006):
        arm = L.rounded_box('flash_arm', (0.0045, 0.013, 0.0095), (ax, 0.0035, Z_TT + 0.0045), 0.0, 0.0006, 1,
                            3 if hi else 1)
        add(arm, 'alu')
        if hi:
            for side in (-1, 1):
                add(L.lathe('rivet', [(0.0, 0.0), (0.0016, 0.0), (0.0014, 0.0004), (0.0008, 0.0007), (0.0, 0.0008)], 24,
                            loc=(ax + side * 0.00225, 0.0035, Z_TT + 0.005), rot=(0, side * 90, 0)), 'chrome')

    # --- top controls
    s16 = 64 if hi else 16
    add(L.lathe('shutter_collar', [(0.0068, 0.0), (0.0068, 0.0018), (0.0060, 0.0026), (0.0049, 0.0026)] if not hi else
                [(0.0068, 0.0), (0.0069, 0.0012), (0.0067, 0.0020), (0.0061, 0.0026), (0.0050, 0.0026),
                 (0.0048, 0.0022)], s16, loc=(SHUTTER[0], SHUTTER[1], Z_TT)), 'chrome')
    add(L.lathe('shutter_button', [(0.0044, 0.0015), (0.0044, 0.0048), (0.0036, 0.0058), (0.0, 0.0061)] if not hi else
                [(0.0044, 0.0015), (0.0044, 0.0046), (0.0042, 0.0052), (0.0036, 0.0057), (0.0020, 0.0060),
                 (0.0, 0.0061)], s16, loc=(SHUTTER[0], SHUTTER[1], Z_TT)), 'red')
    add(L.lathe('knob', [(0.0078, 0.0), (0.0078, 0.0058), (0.0070, 0.0067), (0.0042, 0.0068), (0.0, 0.0064)]
                if not hi else [(0.0078, 0.0), (0.0078, 0.0055), (0.0076, 0.0062), (0.0070, 0.0067),
                                (0.0046, 0.0068), (0.0042, 0.0066), (0.0, 0.0063)],
                80 if hi else 20, loc=(KNOB[0], KNOB[1], Z_TT)), 'alu_knob')
    if hi:  # screws on the top plate back corners and the bottom
        for sx in (-0.068, 0.068):
            add(L.lathe('screw', [(0.0, 0.0), (0.0021, 0.0), (0.0019, 0.0003), (0.0010, 0.0005), (0.0, 0.00055)], 24,
                        loc=(sx, -0.0172, Z_TT)), 'chrome')
        for sx, sy in ((-0.064, 0.021), (0.064, 0.021), (-0.064, -0.021), (0.064, -0.021)):
            add(L.lathe('screw', [(0.0, 0.0), (0.0021, 0.0), (0.0019, 0.0003), (0.0010, 0.0005), (0.0, 0.00055)], 24,
                        loc=(sx, sy, 0.0), rot=(180, 0, 0)), 'chrome')

    # --- front windows
    add(L.frame('viewf_bezel', (0.022, 0.0135), (0.0165, 0.0088), 0.0016, (VIEWF['cx'], FRONT - 0.0002, VIEWF['cz']),
                (-90, 0, 0), bevel_w=0.0005 if hi else 0.0004, bevel_segs=3 if hi else 1, back=False), 'chrome')
    add(L.box('viewf_glass', (0.0170, 0.0006, 0.0092), (VIEWF['cx'], FRONT + 0.0004, VIEWF['cz'])), 'dglass')
    add(L.lathe('meter_bezel', [(0.0062, -0.0002), (0.0062, 0.0010), (0.0057, 0.0017), (0.0047, 0.0017),
                                (0.0043, 0.0011)] if hi else
                [(0.0062, -0.0002), (0.0062, 0.0011), (0.0050, 0.0017), (0.0043, 0.0011)], 48 if hi else 16,
                loc=(METER['cx'], FRONT, METER['cz']), rot=(-90, 0, 0)), 'chrome')
    add(L.lathe('meter_cell', [(0.0044, 0.0008), (0.0, 0.0010)], 48 if hi else 16,
                loc=(METER['cx'], FRONT, METER['cz']), rot=(-90, 0, 0)), 'meter')

    # --- strap lugs on both ends
    for sgn in (-1, 1):
        x0 = sgn * (BW / 2 - 0.0004)
        add(L.rounded_box('lug_base', (0.0022, 0.008, 0.012), (x0 + sgn * 0.0007, -0.016, 0.050), 0.0, 0.0005, 1,
                          3 if hi else 1), 'chrome')
        path = [(x0 + sgn * 0.0012, -0.016, 0.0458), (x0 + sgn * 0.0034, -0.016, 0.0458),
                (x0 + sgn * 0.0052, -0.016, 0.0478), (x0 + sgn * 0.0052, -0.016, 0.0522),
                (x0 + sgn * 0.0034, -0.016, 0.0542), (x0 + sgn * 0.0012, -0.016, 0.0542)]
        add(L.sweep('lug_ring', path, 0.0009, sides=12 if hi else 6), 'chrome')

    # --- back: eyepiece + film counter bezel
    add(L.frame('eyecup', (0.0205, 0.0155), (0.0125, 0.0088), 0.0060, (EYEPIECE['cx'], BACK + 0.0003, EYEPIECE['cz']),
                (90, 0, 0), bevel_w=0.0016 if hi else 0.0012, bevel_segs=4 if hi else 1, back=False), 'rubber')
    add(L.box('eyepiece_glass', (0.0128, 0.0006, 0.0092), (EYEPIECE['cx'], BACK - 0.0006, EYEPIECE['cz'])),
        'dglass')
    sw, sh = SCREEN['w'], SCREEN['h']
    add(L.frame('screen_bezel', (sw + 0.0062, sh + 0.0062), (sw, sh), 0.0018, (SCREEN['cx'], BACK + 0.0002,
                                                                              SCREEN['cz']),
                (90, 0, 0), bevel_w=0.0005 if hi else 0.0004, bevel_segs=3 if hi else 1, back=False), 'alu')

    if mats:
        for o, key, _ in out:
            L.assign(o, mats[key])
    return out


def build_camera(final: bool = True) -> None:
    common.reset()
    imgs = _decals()
    mats = _materials(imgs)
    highs = [o for o, _, _ in _parts(True, mats)]
    lows = _parts(False, None)
    for o, key, pid in lows:
        L.tag(o, pid)
        if key in ('leather', 'alu_top', 'alu_bot', 'enamel_flash'):
            L.weighted_normals(o)
    low = L.join([o for o, _, _ in lows], 'camera_atlas')
    L.triangulate(low)

    def texel(poly, obj):
        n = poly.normal
        c = poly.center
        if n.z < -0.9 and c.z < 0.001:
            return 0.6        # underside
        if abs(n.z) > 0.9 and (abs(c.z - Z_BOT) < 1e-4 or abs(c.z - Z_TOP) < 1e-4):
            return 0.25       # band ledges under the plates
        return 1.0

    L.uv_unwrap(low, margin=0.003, scale_faces=texel)
    size = L.tex_size(1024)
    mat = L.bake_atlas(low, 'camera', size, highs, samples_=L.samples(20), extrusion=0.0010, max_ray=0.0025)
    for o in highs:
        L.delete(o)
    parts = L.split_parts(low, {0: 'camera_body', 1: 'lens', 2: 'flash_reflector'})
    body, lens, refl = parts['camera_body'], parts['lens'], parts['flash_reflector']
    # Own materials for the named nodes, sharing the atlas images.
    for o, nm in ((lens, 'lens'), (refl, 'flash_reflector')):
        m = mat.copy()
        m.name = nm
        L.assign(o, m)
    # Film counter screen: plain plane, UVs 0..1 (u -> +X, v -> +Z seen from behind).
    sw, sh = SCREEN['w'], SCREEN['h']
    bm = bmesh.new()
    y = BACK - 0.0004
    vs = [bm.verts.new((SCREEN['cx'] - sw / 2, y, SCREEN['cz'] - sh / 2)),
          bm.verts.new((SCREEN['cx'] + sw / 2, y, SCREEN['cz'] - sh / 2)),
          bm.verts.new((SCREEN['cx'] + sw / 2, y, SCREEN['cz'] + sh / 2)),
          bm.verts.new((SCREEN['cx'] - sw / 2, y, SCREEN['cz'] + sh / 2))]
    f = bm.faces.new(vs)
    f.normal_update()
    if f.normal.y > 0:
        f.normal_flip()
    uvl = bm.loops.layers.uv.new('UVMap')
    for loop in f.loops:
        co = loop.vert.co
        loop[uvl].uv = ((co.x - (SCREEN['cx'] - sw / 2)) / sw, (co.z - (SCREEN['cz'] - sh / 2)) / sh)
    screen = L.from_bmesh('film_screen', bm)
    L.assign(screen, L.flat_material('film_screen', color=(0.018, 0.028, 0.022), rough=0.25,
                                     emission=(0.004, 0.012, 0.006), emission_strength=1.0))
    objs = [body, lens, refl, screen]
    # Final frame: origin at the grip, node origins at meaningful points.
    L.shift_all(objs, (-GRIP[0], -GRIP[1], -GRIP[2]))
    g = Vector(GRIP)
    L.set_origin(lens, Vector((LX, FRONT + 0.0199, LZ)) - g)
    L.set_origin(refl, Vector(((OPEN_X0 + OPEN_X1) / 2, 0.017, FLASH_ZC)) - g)
    L.set_origin(screen, Vector((SCREEN['cx'], BACK - 0.0004, SCREEN['cz'])) - g)
    bpy.context.scene['grip_origin'] = 'right-hand grip, +X end of the body'
    common.report('camera', objs)
    common.export_glb('camera', objs)
    L.previews('camera', objs, [('3q', dict(yaw=35, pitch=15, mood='studio')),
                                ('flash', dict(yaw=25, pitch=10, mood='flash')),
                                ('back', dict(yaw=200, pitch=25, mood='studio'))], final=final)
