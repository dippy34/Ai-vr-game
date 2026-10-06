"""
door.glb: the heavy old front door (the exit). A frame-and-panel leaf painted dark green over a
cream undercoat, peeling down to grey wood, four fielded panels, a small frosted window boarded
over from the inside, tarnished brass knob + deadbolt + mail slot, three butt hinges. The frame
has jambs + stops, molded casings with plinth and corner blocks on both faces, and a worn oak
threshold.

Fits the game's opening box 1.2 m wide x 2.4 m tall x 0.2 m deep (the wall thickness). Origin =
bottom center of the opening. Blender +Y = inside the house (three.js -Z).
Nodes:
  door_frame     static frame (jambs, stops, casings, threshold, hinge knuckles)
  door_leaf      the moving leaf; ORIGIN ON THE HINGE AXIS (-X side, at the interior face), so
                 rotation.y = +angle (three.js) swings it into the house
  door_window    the frosted pane (child of door_leaf, own material: faint moonlight emission)
extras (scene): opening = [1.2, 2.4, 0.2], hinge = [x, z] (three.js, relative to the origin)
"""

from __future__ import annotations

import math

import bpy
import bmesh
from mathutils import Matrix, Vector

import common
import props_lib as L
import props_mats as M


def build() -> None:
    """art/build.py imports every module here and calls build(); props.py drives this one."""


OW, OH, OD = 1.2, 2.4, 0.2
JAMB = 0.035
GAP = 0.003
LX0, LX1 = -OW / 2 + JAMB + GAP, OW / 2 - JAMB - GAP        # leaf x range (hinge at LX0)
LZ0, LZ1 = 0.025, OH - JAMB - GAP
LT = 0.055
LY1 = 0.072                                                  # interior face
LY0 = LY1 - LT
LYM = (LY0 + LY1) / 2
HINGE = (LX0 - 0.0015, LY1 + 0.0035)                         # knuckle axis (x, y)
STILE = 0.135
XB = [LX0, LX0 + STILE, -0.30, -0.055, 0.055, 0.30, LX1 - STILE, LX1]
ZB = [LZ0, 0.285, 0.92, 1.12, 1.52, 1.70, 2.12, LZ1]
PANELS = [((XB[1], XB[3]), (ZB[1], ZB[2])), ((XB[4], XB[6]), (ZB[1], ZB[2])),
          ((XB[1], XB[3]), (ZB[3], ZB[4])), ((XB[4], XB[6]), (ZB[3], ZB[4]))]
WINDOW = ((XB[2], XB[5]), (ZB[5], ZB[6]))
KNOB = (0.497, 1.00)
BOLT = (0.497, 1.19)
MAIL = (-0.16, 1.02)
HINGES_Z = (0.26, 1.20, 2.14)
CASE_W = 0.110
BAKE_OFFSET = 10.0
CASE_IN = OW / 2 - JAMB + 0.005 - 0.0                        # casing inner edge |x| = 0.57


def _members(hi: bool):
    """High-poly frame-and-panel members: (x0, x1, z0, z1, grain axis)."""
    g = 0.0008 if hi else 0.0
    m = [(XB[0], XB[1], ZB[0], ZB[7], 'Z'), (XB[6], XB[7], ZB[0], ZB[7], 'Z'),            # stiles
         (XB[1] + g, XB[6] - g, ZB[0], ZB[1], 'X'), (XB[1] + g, XB[6] - g, ZB[2], ZB[3], 'X'),
         (XB[1] + g, XB[6] - g, ZB[4], ZB[5], 'X'), (XB[1] + g, XB[6] - g, ZB[6], ZB[7], 'X'),   # rails
         (XB[3], XB[4], ZB[1] + g, ZB[2] - g, 'Z'), (XB[3], XB[4], ZB[3] + g, ZB[4] - g, 'Z'),   # muntins
         (XB[1] + g, XB[2], ZB[5] + g, ZB[6] - g, 'Z'), (XB[5], XB[6] - g, ZB[5] + g, ZB[6] - g, 'Z')]
    return m


def _raised_panel(name, x0, x1, z0, z1, field_t=0.026, edge_t=0.010, raise_w=0.045, tongue=0.008):
    bm = bmesh.new()
    xa, xb, za, zb = x0 - tongue, x1 + tongue, z0 - tongue, z1 + tongue
    fa, fb, fz0, fz1 = x0 + raise_w, x1 - raise_w, z0 + raise_w, z1 - raise_w
    rings = []
    for sgn in (1, -1):
        yo = LYM + sgn * edge_t / 2
        yf = LYM + sgn * field_t / 2
        outer = [bm.verts.new((xa, yo, za)), bm.verts.new((xb, yo, za)), bm.verts.new((xb, yo, zb)),
                 bm.verts.new((xa, yo, zb))]
        mid = [bm.verts.new((x0, LYM + sgn * (edge_t / 2 + 0.0015), z0)), bm.verts.new((x1, LYM + sgn * (edge_t / 2 + 0.0015), z0)),
               bm.verts.new((x1, LYM + sgn * (edge_t / 2 + 0.0015), z1)), bm.verts.new((x0, LYM + sgn * (edge_t / 2 + 0.0015), z1))]
        inner = [bm.verts.new((fa, yf, fz0)), bm.verts.new((fb, yf, fz0)), bm.verts.new((fb, yf, fz1)),
                 bm.verts.new((fa, yf, fz1))]
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((outer[i], outer[j], mid[j], mid[i]))
            bm.faces.new((mid[i], mid[j], inner[j], inner[i]))
        bm.faces.new(inner)
        rings.append(outer)
    a, b = rings
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((a[i], b[i], b[j], a[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = L.from_bmesh(name, bm)
    L.smooth_by_angle(o, 20)
    return o


def _casing_profile(hi: bool):
    """Cross-section (offset from the opening edge, thickness off the wall)."""
    if not hi:
        return [(0.0, 0.0), (0.0, 0.019), (0.004, 0.022), (0.034, 0.022), (0.050, 0.016), (0.094, 0.016),
                (0.100, 0.020), (CASE_W, 0.020), (CASE_W, 0.0)]
    p = [(0.0, 0.0), (0.0, 0.018), (0.0008, 0.0205), (0.003, 0.0218), (0.006, 0.022)]
    for i in range(1, 7):   # bead
        a = math.pi * i / 7
        p.append((0.006 + 0.008 * (1 - math.cos(a)) / 2 * 2, 0.022 + 0.003 * math.sin(a)))
    p += [(0.024, 0.022), (0.030, 0.0215)]
    for i in range(1, 8):   # cove down to the flat
        a = (math.pi / 2) * i / 8
        p.append((0.030 + 0.020 * (1 - math.cos(a)), 0.0215 - 0.0055 * math.sin(a)))
    p += [(0.094, 0.016), (0.096, 0.0175), (0.099, 0.0198), (0.103, 0.0205), (CASE_W - 0.002, 0.0205),
          (CASE_W, 0.0195), (CASE_W, 0.0)]
    return p


def _casing_piece(name, length, hi, along: str, side: int, at):
    """Profile extruded along Z (side casings) or X (head casing). side = +1 interior, -1 exterior."""
    prof = _casing_profile(hi)
    bm = bmesh.new()
    lo, hi_ = [], []
    for u, t in prof:
        lo.append(bm.verts.new((u, t, 0.0)))
        hi_.append(bm.verts.new((u, t, length)))
    n = len(prof)
    for i in range(n - 1):
        bm.faces.new((lo[i], lo[i + 1], hi_[i + 1], hi_[i]))
    bm.faces.new(list(reversed(lo)))
    bm.faces.new(hi_)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = L.from_bmesh(name, bm)
    # drop the back face (against the wall)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.y < -0.9 and f.calc_center_median().y < 1e-5],
                     context='FACES')
    bm.to_mesh(o.data)
    bm.free()
    # local frame: u -> away from the opening, t -> off the wall (+Y), w -> along
    return o


def _place_casing(o, mat):
    o.data.transform(mat)
    if mat.to_3x3().determinant() < 0:
        for p in o.data.polygons:
            p.flip()
    o.data.update()
    L.smooth_by_angle(o, 35)
    return o


def _casings(hi: bool, side: int):
    """Casings + plinths + corner blocks on one face of the wall. side +1 = interior (+Y)."""
    out = []
    y0 = side * OD / 2
    flipy = Matrix.Diagonal((1, side, 1, 1))
    zc0, zc1 = 0.20, OH - 0.005
    for sx in (-1, 1):
        o = _casing_piece('casing', zc1 - zc0, hi, 'Z', side, None)
        # u -> -x for the left (sx=-1) casing, +x for the right
        m = Matrix.Translation((sx * 0.570, y0, zc0)) @ flipy @ Matrix.Diagonal((sx, 1, 1, 1))
        out.append((_place_casing(o, m), 'frame_v'))
        plinth = L.rounded_box('plinth', (0.122, 0.028, 0.20), (sx * (0.570 + 0.055), y0 + side * 0.014, 0.10),
                               0.0, 0.004 if hi else 0.003, 1, 3 if hi else 1)
        out.append((plinth, 'frame_v'))
        corner = L.rounded_box('corner_block', (0.122, 0.026, 0.122), (sx * (0.570 + 0.055), y0 + side * 0.013,
                                                                      OH - 0.005 + 0.061), 0.0,
                               0.004 if hi else 0.003, 1, 3 if hi else 1)
        out.append((corner, 'frame_h'))
        if hi:  # turned bullseye rosette
            ros = L.lathe('rosette', [(0.0, 0.0), (0.046, 0.0), (0.046, 0.002), (0.040, 0.004), (0.034, 0.003),
                                      (0.030, 0.006), (0.022, 0.0065), (0.016, 0.004), (0.010, 0.005), (0.004, 0.008),
                                      (0.0, 0.0085)], 64, loc=(sx * (0.570 + 0.055), y0 + side * 0.026,
                                                               OH - 0.005 + 0.061),
                          rot=(-90 * side, 0, 0))
            out.append((ros, 'frame_h'))
    o = _casing_piece('head_casing', 2 * 0.564, hi, 'X', side, None)
    # local: u (profile offset) -> +z (up from the opening), t -> y, w -> x
    m = (Matrix.Translation((-0.564, y0, OH - 0.0)) @ flipy @
         Matrix(((0, 0, 1, 0), (0, 1, 0, 0), (1, 0, 0, 0), (0, 0, 0, 1))))
    out.append((_place_casing(o, m), 'frame_h'))
    for o, _ in out:
        if o.name.startswith(('plinth', 'corner_block')):
            bm = bmesh.new()
            bm.from_mesh(o.data)
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if abs(f.normal.y + side) < 0.1 and
                                       abs(f.calc_center_median().y - y0) < 1e-4], context='FACES')
            bm.to_mesh(o.data)
            bm.free()
    return out


def _decals():
    imgs = {}
    d = L.Decal('door_mail', 512, 128)
    d.text(256, 64, 'L E T T E R S', 54, (1, 1, 1), kind='serif_bold', spacing=1.1)
    imgs['mail'] = d.render()
    return imgs


def _materials(imgs):
    def claw(k):
        # four parallel gouges on the inside face, low on the lock side (something tried to get in... or out)
        v = k.mapping(loc=(0, 0, 0), rot=(0, 28, 0))
        x, y, z = k.xyz(v)
        m = None
        for i in range(4):
            u0 = 0.26 + i * 0.026
            band = k.mul(k.ramp_f(x, u0 - 0.0035, u0 - 0.0005), k.ramp_f(x, u0 + 0.0035, u0 + 0.0005))
            taper = k.mul(k.ramp_f(z, -0.09 + i * 0.015, 0.0), k.ramp_f(z, 0.42 - i * 0.02, 0.30))
            g = k.mul(band, taper)
            m = g if m is None else k.maxf(m, g)
        ny = k.xyz(k.geo('Normal'))[1]
        wobble = k.ramp_f(k.noise(scale=30, detail=4), 0.3, 0.5)
        return k.mul(k.mul(m, k.ramp_f(ny, 0.5, 0.9)), wobble)

    def knob_grime(k):
        d = k.vmath('LENGTH', k.vmath('SUBTRACT', k.coord(), (KNOB[0], LY1, KNOB[1])), out=1)
        n = k.noise(scale=40, detail=4)
        return k.mul(k.ramp_f(d, 0.20, 0.05), k.add(0.4, k.mul(n, 0.5)))

    def mail_text(k):
        m = k.decal(imgs['mail'], k.plane_uv((MAIL[0], LY0 - 0.004, MAIL[1] + 0.024), (-1, 0, 0), (0, 0, 1),
                                               0.20, 0.05))
        return k.mul(m, k.ramp_f(k.xyz(k.coord())[1], LY0 - 0.0035, LY0 - 0.0045))

    def mail_slot_dark(k):
        return k.box_mask((MAIL[0] - 0.115, LY1 + 0.002, MAIL[1] - 0.016), (MAIL[0] + 0.115, LY1 + 0.02,
                                                                            MAIL[1] + 0.016), soft=0.0015)

    def keyway(k):
        return k.box_mask((BOLT[0] - 0.0012, LY0 - 0.02, BOLT[1] - 0.008), (BOLT[0] + 0.0012, LY0 - 0.006,
                                                                          BOLT[1] + 0.004), soft=0.0003)

    paint = (0.030, 0.045, 0.036)
    leaf_marks = [
        dict(mask=claw, color=(0.20, 0.15, 0.09), rough=0.85, height=-2.5),
        dict(mask=knob_grime, color=(0.018, 0.016, 0.012), rough=0.38),
    ]
    mats = dict(
        leaf_v=M.painted_wood('door_leaf_v', paint=paint, grain='Z', marks=leaf_marks),
        leaf_h=M.painted_wood('door_leaf_h', paint=paint, grain='X', marks=leaf_marks),
        panel=M.painted_wood('door_panel', paint=paint, grain='Z', peel=1.25, marks=leaf_marks),
        frame_v=M.painted_wood('door_frame_v', paint=(0.34, 0.31, 0.235), under=(0.20, 0.22, 0.20), grain='Z',
                               peel=0.45, crack=1.4, flakes=0.5),
        frame_h=M.painted_wood('door_frame_h', paint=(0.34, 0.31, 0.235), under=(0.20, 0.22, 0.20), grain='X',
                               peel=0.45, crack=1.4, flakes=0.5),
        sill=M.raw_wood('door_sill', wood=(0.15, 0.10, 0.06), grain='X', wear_z=True),
        board1=M.raw_wood('door_board1', grain='X', rot=-4.0),
        board2=M.raw_wood('door_board2', wood=(0.13, 0.10, 0.07), grain='X', rot=24.0),
        brass=M.brass('door_brass', s=1.5, tarnish=0.75, marks=[
            M.engraved(mail_text, color=(0.03, 0.022, 0.012), depth=-1.0),
            M.engraved(keyway, color=(0.01, 0.008, 0.006), depth=-3.0),
            dict(mask=mail_slot_dark, color=(0.006, 0.005, 0.004), rough=0.9, metal=0.0, height=-2.0),
        ]),
        iron=M.iron('door_iron'),
    )
    return mats


def _leaf_parts(hi: bool, mats):
    out = []

    def add(o, key):
        out.append((o, key))
        return o

    if hi:
        for i, (x0, x1, z0, z1, ax) in enumerate(_members(True)):
            o = L.rounded_box(f'member_{i}', (x1 - x0, LT, z1 - z0), ((x0 + x1) / 2, LYM, (z0 + z1) / 2), 0.0,
                              0.0025, 1, 3)
            add(o, 'leaf_v' if ax == 'Z' else 'leaf_h')
        # sticking: rounded molding ring inside every opening, both faces
        for (xa, xb), (za, zb) in PANELS + [WINDOW]:
            for side in (1, -1):
                yface = LY1 if side > 0 else LY0
                fr = L.frame('sticking', (xb - xa + 0.002, zb - za + 0.002), (xb - xa - 0.026, zb - za - 0.026), 0.012,
                             ((xa + xb) / 2, yface - side * 0.0135, (za + zb) / 2), (-90 * side, 0, 0),
                             bevel_w=0.005, bevel_segs=5, back=False)
                add(fr, 'leaf_h')
    else:
        slab = L.box('leaf_slab', (LX1 - LX0, LT, LZ1 - LZ0), ((LX0 + LX1) / 2, LYM, (LZ0 + LZ1) / 2))
        for (xa, xb), (za, zb) in PANELS + [WINDOW]:
            cut = L.box('cut', (xb - xa, LT + 0.02, zb - za), ((xa + xb) / 2, LYM, (za + zb) / 2))
            L.boolean(slab, cut)
        bm = bmesh.new()
        bm.from_mesh(slab.data)
        inner = [e for e in bm.edges if all(LX0 + 0.01 < v.co.x < LX1 - 0.01 and LZ0 + 0.01 < v.co.z < LZ1 - 0.01
                                            for v in e.verts) and e.calc_face_angle(0) > math.radians(40)]
        bmesh.ops.bevel(bm, geom=inner, offset=0.009, segments=1, profile=0.5, affect='EDGES', clamp_overlap=True)
        outer = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(60)
                 and not all(LX0 + 0.01 < v.co.x < LX1 - 0.01 and LZ0 + 0.01 < v.co.z < LZ1 - 0.01 for v in e.verts)]
        bmesh.ops.bevel(bm, geom=outer, offset=0.003, segments=1, profile=0.5, affect='EDGES', clamp_overlap=True)
        bm.to_mesh(slab.data)
        bm.free()
        L.weighted_normals(slab)
        add(slab, 'leaf_v')
    for i, ((xa, xb), (za, zb)) in enumerate(PANELS):
        p = _raised_panel(f'panel_{i}', xa, xb, za, zb)
        if hi:
            L.subdivide(p, 2, simple=True)
            L.bevel(p, 0.002, 2, angle=10, harden=False)
        add(p, 'panel')
    # boards over the window (inside), nailed into the frame
    b1 = L.rounded_box('board1', (0.86, 0.022, 0.115), (0.0, LY1 + 0.011, 1.875), 0.0, 0.003 if hi else 0.002, 1,
                       3 if hi else 1, rot=(0, 4.0, 0))
    add(b1, 'board1')
    b2 = L.rounded_box('board2', (0.78, 0.020, 0.10), (0.01, LY1 + 0.022 + 0.010, 1.93), 0.0, 0.003 if hi else 0.002,
                       1, 3 if hi else 1, rot=(0, -24.0, 0))
    add(b2, 'board2')
    if hi:
        for (cx, cz, by, ang, half) in ((0.0, 1.875, LY1 + 0.022, 4.0, 0.43), (0.01, 1.93, LY1 + 0.042, -24.0, 0.39)):
            t = math.radians(ang)
            for u in (-(half - 0.045), half - 0.045):
                for w in (-0.028, 0.028):
                    px = cx + u * math.cos(t) + w * math.sin(t)
                    pz = cz - u * math.sin(t) + w * math.cos(t)
                    add(L.lathe('nail', [(0.0, 0.0), (0.0048, 0.0), (0.0045, 0.0012), (0.0, 0.0018)], 16,
                                loc=(px, by, pz), rot=(-90, 0, 0)), 'iron')
    # hardware, both faces
    s = 48 if hi else 10
    for side in (1, -1):
        yface = LY1 if side > 0 else LY0
        rot = (-90 * side, 0, 0)
        ros = [(0.030, 0.0), (0.0295, 0.004), (0.012, 0.0095)] if not hi else \
            [(0.030, 0.0), (0.0302, 0.002), (0.0290, 0.0045), (0.024, 0.0072), (0.016, 0.0088), (0.012, 0.0095)]
        add(L.lathe('rosette', ros, s, loc=(KNOB[0], yface, KNOB[1]), rot=rot), 'brass')
        knob = [(0.0095, 0.0085), (0.0095, 0.028), (0.024, 0.045), (0.029, 0.062), (0.022, 0.078), (0.0, 0.082)] \
            if not hi else [(0.0095, 0.0085), (0.0095, 0.026), (0.0115, 0.031), (0.018, 0.038), (0.024, 0.045),
                            (0.0278, 0.053), (0.0292, 0.062), (0.0282, 0.070), (0.0245, 0.076), (0.017, 0.0805),
                            (0.008, 0.0822), (0.0, 0.0825)]
        add(L.lathe('knob', knob, s, loc=(KNOB[0], yface, KNOB[1]), rot=rot), 'brass')
    # deadbolt: thumb turn inside, key cylinder outside
    add(L.lathe('bolt_rose', [(0.026, 0.0), (0.025, 0.004), (0.0, 0.0072)] if not hi else
                [(0.026, 0.0), (0.0262, 0.002), (0.0245, 0.0045), (0.018, 0.0065), (0.0, 0.0072)], s,
                loc=(BOLT[0], LY1, BOLT[1]), rot=(-90, 0, 0)), 'brass')
    add(L.rounded_box('thumb_turn', (0.013, 0.017, 0.046), (BOLT[0], LY1 + 0.0072 + 0.0085, BOLT[1]), 0.0,
                      0.003 if hi else 0.0025, 1, 3 if hi else 1), 'brass')
    add(L.lathe('key_cyl', [(0.019, 0.0), (0.019, 0.006), (0.016, 0.010), (0.0, 0.011)] if not hi else
                [(0.019, 0.0), (0.0192, 0.004), (0.0185, 0.0075), (0.016, 0.0098), (0.011, 0.0108), (0.0, 0.011)],
                s, loc=(BOLT[0], LY0, BOLT[1]), rot=(90, 0, 0)), 'brass')
    # mail slot: plate + flap outside, plate (with the dark slot) inside
    mx, mz = MAIL
    add(L.rounded_box('mail_plate_out', (0.30, 0.004, 0.078), (mx, LY0 - 0.002, mz), 0.0, 0.0015 if hi else 0.0012,
                      1, 3 if hi else 1), 'brass')
    add(L.rounded_box('mail_flap', (0.25, 0.005, 0.040), (mx, LY0 - 0.0055, mz - 0.006), 0.0,
                      0.0015 if hi else 0.0012, 1, 3 if hi else 1, rot=(-6.0, 0, 0)), 'brass')
    add(L.rounded_box('mail_plate_in', (0.29, 0.004, 0.072), (mx, LY1 + 0.002, mz), 0.0, 0.0015 if hi else 0.0012, 1,
                      3 if hi else 1), 'brass')
    if mats:
        for o, key in out:
            L.assign(o, mats[key])
    return out


def _frame_parts(hi: bool, mats):
    out = []

    def add(o, key):
        out.append((o, key))
        return o

    b = 0.003 if hi else 0.0025
    sg = 3 if hi else 1
    for sx in (-1, 1):
        j = L.rounded_box('jamb', (JAMB, OD, OH - JAMB), (sx * (OW / 2 - JAMB / 2), 0.0, (OH - JAMB) / 2), 0.0, b,
                          1, sg)
        add(j, 'frame_v')
        st = L.rounded_box('stop', (0.013, 0.046, OH - JAMB - 0.022), (sx * (OW / 2 - JAMB - 0.0065), LY0 - 0.0005 - 0.023,
                                                                   0.022 + (OH - JAMB - 0.022) / 2), 0.0,
                           0.002 if hi else 0.0, 1, sg)
        add(st, 'frame_v')
    add(L.rounded_box('head_jamb', (OW, OD, JAMB), (0.0, 0.0, OH - JAMB / 2), 0.0, b, 1, sg), 'frame_h')
    add(L.rounded_box('head_stop', (OW - 2 * JAMB, 0.046, 0.013), (0.0, LY0 - 0.0005 - 0.023, OH - JAMB - 0.0065),
                      0.0, 0.002, 1, sg), 'frame_h')
    # threshold (sloped to the outside)
    sill = L.prism('sill', [(-0.13, 0.0), (0.105, 0.0), (0.105, 0.022), (-0.02, 0.022), (-0.13, 0.010)], OW)
    # prism: outline in XY, extruded along Z -> outline becomes (y, z), length along X
    sill.data.transform(Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1))))
    sill.data.update()
    if hi:
        L.bevel(sill, 0.002, 2, angle=20, harden=False)
    add(sill, 'sill')
    # hinge knuckles (static)
    for hz in HINGES_Z:
        prof = [(0.0, -0.051), (0.0068, -0.051), (0.0080, -0.049), (0.0080, 0.049), (0.0068, 0.051), (0.0, 0.051)] \
            if hi else [(0.0, -0.051), (0.0080, -0.049), (0.0080, 0.049), (0.0, 0.051)]
        add(L.lathe('knuckle', prof, 32 if hi else 8, loc=(HINGE[0], HINGE[1], hz)), 'brass')
        if hi:
            for sz in (-1, 1):
                add(L.lathe('finial', [(0.0, 0.0), (0.0055, 0.0), (0.004, 0.004), (0.0, 0.006)], 24,
                            loc=(HINGE[0], HINGE[1], hz + sz * 0.051), rot=(0 if sz > 0 else 180, 0, 0)), 'brass')
    for side in (1, -1):
        out += _casings(hi, side)
    # remove faces hidden in the wall / floor
    for o, _ in out:
        if not o.name.startswith(('jamb', 'head_jamb')):
            continue
        bm = bmesh.new()
        bm.from_mesh(o.data)
        kill = []
        for f in bm.faces:
            c, n = f.calc_center_median(), f.normal
            if abs(abs(c.x) - OW / 2) < 1e-4 and abs(n.x) > 0.9:
                kill.append(f)
            elif c.z > OH - 1e-4 and n.z > 0.9:
                kill.append(f)
            elif c.z < 1e-4 and n.z < -0.9:
                kill.append(f)
        bmesh.ops.delete(bm, geom=kill, context='FACES')
        bm.to_mesh(o.data)
        bm.free()
    if mats:
        for o, key in out:
            L.assign(o, mats[key])
    return out


def build_door(final: bool = True) -> None:
    common.reset()
    imgs = _decals()
    mats = _materials(imgs)
    leaf_high = [o for o, _ in _leaf_parts(True, mats)]
    frame_high = [o for o, _ in _frame_parts(True, mats)]
    highs = leaf_high + frame_high
    leaf_low = _leaf_parts(False, None)
    frame_low = _frame_parts(False, None)
    # Bake the frame far away from the leaf: the 3 mm gaps are thinner than the bake cage, so
    # rays from the leaf edges would otherwise start inside the jambs/stops.
    L.shift_all(frame_high + [o for o, _ in frame_low], (BAKE_OFFSET, 0.0, 0.0))
    for o, _ in leaf_low:
        L.tag(o, 1)
    for o, _ in frame_low:
        L.tag(o, 0)
    low = L.join([o for o, _ in leaf_low] + [o for o, _ in frame_low], 'door_atlas')
    L.triangulate(low)
    glass = L.box('door_window', (WINDOW[0][1] - WINDOW[0][0] + 0.016, 0.005, WINDOW[1][1] - WINDOW[1][0] + 0.016),
                  ((WINDOW[0][0] + WINDOW[0][1]) / 2, LYM, (WINDOW[1][0] + WINDOW[1][1]) / 2))
    L.assign(glass, M.frosted('door_window_src'))

    def texel(poly, obj):
        c, n = poly.center, poly.normal
        inside_leaf = LX0 - 0.01 < c.x < LX1 + 0.01 and c.z > 0.02
        if inside_leaf and c.y < LY0 + 0.002 and n.y < -0.5:
            return 0.55   # leaf outside face
        if c.y < -OD / 2 + 0.001 and n.y < -0.5:
            return 0.5    # exterior casings
        if c.x > BAKE_OFFSET / 2:
            return 0.85   # the frame (baked at the offset)
        if abs(n.x) > 0.9 and abs(abs(c.x) - (LX1 + 0.0)) < 0.004:
            return 0.4    # leaf edges in the gap
        return 1.0

    L.uv_unwrap(low, margin=0.002, scale_faces=texel)
    size = L.tex_size(1024)
    L.bake_atlas(low, 'door', size, highs, samples_=L.samples(14), extrusion=0.006, max_ray=0.016)
    for o in highs:
        L.delete(o)
    parts = L.split_parts(low, {0: 'door_frame', 1: 'door_leaf'})
    frame, leaf = parts['door_frame'], parts['door_leaf']
    L.shift_all([frame], (-BAKE_OFFSET, 0.0, 0.0))
    L.assign(glass, L.flat_material('door_window', color=(0.30, 0.33, 0.35), rough=0.35,
                                    emission=(0.020, 0.026, 0.036), emission_strength=1.0))
    L.set_origin(leaf, (HINGE[0], HINGE[1], 0.0))
    L.set_origin(glass, (HINGE[0], HINGE[1], 0.0))
    glass.parent = leaf
    glass.location = (0.0, 0.0, 0.0)      # same origin as the leaf: swings with it
    scene = bpy.context.scene
    scene['opening'] = [OW, OH, OD]
    scene['hinge'] = [round(HINGE[0], 4), round(-HINGE[1], 4)]
    frame['opening'] = [OW, OH, OD]
    objs = [frame, leaf]
    common.report('door', [frame, leaf, glass])
    common.export_glb('door', objs)
    L.previews('door', [frame, leaf, glass], [('3q', dict(yaw=30, pitch=8, mood='studio')),
                                              ('flash', dict(yaw=15, pitch=5, mood='flash')),
                                              ('outside', dict(yaw=200, pitch=8, mood='studio'))], final=final)
    # open-door check (preview only)
    leaf.rotation_euler = (0, 0, math.radians(75))   # = three.js rotation.y = +75 deg: swings inside
    L.previews('door', [frame, leaf, glass], [('open', dict(yaw=35, pitch=12, mood='studio'))], final=False)
    leaf.rotation_euler = (0, 0, 0)
