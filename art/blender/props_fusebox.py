"""
fusebox.glb: a wall-mounted 1950s steel fuse cabinet, chipped gray-green enamel over red-oxide
primer, rusting at the seams. Hinged pan door swung open ~115 deg (circuit directory card inside,
DANGER stencil outside), a black dead-front panel with three chrome-bezel jewel indicator lamps
and three porcelain cartridge-fuse blocks with brass spring clips, a big side throw lever and a
galvanized conduit running up the wall to the ceiling.

Frame: Blender +Y = front (three.js -Z); the back face lies on the wall plane y = 0; origin =
center of that back face. Nodes:
  fusebox_body          static atlas mesh (enclosure, panel, blocks, clips, conduit)
  fusebox_door          the open door (origin on its hinge axis, rotate about Y to swing it)
  lever                 side throw lever (origin on its pivot, rotate about X: up = ON)
  lamp_0..lamp_2        jewel lenses, each with its own material (game drives color/emission)
  slot_0..slot_2        empties at the center of where a fuse.glb sits (fuse long axis = up)
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


W, H, D = 0.42, 0.56, 0.14            # enclosure
PANEL_Y = 0.092                       # dead-front panel front face
SLOT_XS = (-0.095, 0.0, 0.095)
LAMP_Z = 0.165
SLOT_Z = -0.035
BLOCK_Y0 = PANEL_Y                    # porcelain block back
BLOCK_D = 0.022
FUSE_Y = BLOCK_Y0 + BLOCK_D + 0.0118  # fuse axis (y)
CLIP_DZ = 0.046
HINGE = (W / 2 + 0.004, D + 0.010)    # door hinge axis (x, y)
DOOR_ANGLE = -115.0                   # degrees about Z
LEVER_PIVOT = (-W / 2 - 0.012, 0.075, 0.075)
LEVER_TILT = 16.0                     # degrees forward from straight down (OFF)
CONDUIT = (0.105, 0.030)              # x, y of the pipe axis
CONDUIT_TOP = 1.40


def _door_matrix():
    return (Matrix.Translation((HINGE[0], HINGE[1], 0)) @ Matrix.Rotation(math.radians(DOOR_ANGLE), 4, 'Z')
            @ Matrix.Translation((-HINGE[0], -HINGE[1], 0)))


def _rot(v):
    return (_door_matrix().to_3x3() @ Vector(v)).normalized()


def _decals():
    imgs = {}
    # Dead-front panel stencils (white): numbers under the lamps, notes under the fuses.
    pw, ph = 0.384, 0.52
    Wd, Hd = 768, int(768 * ph / pw)
    px = Wd / pw
    d = L.Decal('fb_panel', Wd, Hd)

    def at(x, z):
        return ((x + pw / 2) * px, (z + ph / 2) * px)

    for i, x in enumerate(SLOT_XS):
        cx, cy = at(x, LAMP_Z - 0.034)
        d.text(cx, cy, str(i + 1), 0.016 * px / 0.72, (1, 1, 1), kind='sans_bold')
        cx, cy = at(x, SLOT_Z - 0.100)
        d.text(cx, cy, '30 A', 0.0075 * px / 0.72, (1, 1, 1), kind='sans_bold', spacing=1.2)
    cx, cy = at(0, LAMP_Z + 0.045)
    d.text(cx, cy, 'CIRCUIT  INDICATORS', 0.0085 * px / 0.72, (1, 1, 1), kind='sans_bold', spacing=1.35)
    cx, cy = at(0, SLOT_Z - 0.130)
    d.text(cx, cy, 'USE CARTRIDGE FUSES ONLY  •  250 V MAX', 0.0062 * px / 0.72, (1, 1, 1), kind='sans_bold',
           spacing=1.2)
    cx, cy = at(0, -0.225)
    d.rect(cx - 0.075 * px, cy - 0.016 * px, cx + 0.075 * px, cy + 0.016 * px, (0.5, 0.5, 0.5))
    d.text(cx, cy + 0.005 * px, 'WESTFIELD ELECTRIC MFG. CO.', 0.0052 * px / 0.72, (0, 0, 0), kind='sans_bold',
           spacing=1.1)
    d.text(cx, cy - 0.006 * px, 'TYPE C-3   •   3 CIRCUIT   •   60 A', 0.0042 * px / 0.72, (0, 0, 0),
           kind='sans_bold', spacing=1.1)
    imgs['panel'] = d.render()
    # Door outside: DANGER stencil.
    d = L.Decal('fb_danger', 512, 256)
    d.text(256, 170, 'DANGER', 120, (1, 1, 1), kind='sans_bold', spacing=1.1)
    d.text(256, 72, '220  VOLTS', 64, (1, 1, 1), kind='sans_bold', spacing=1.2)
    d.rect(40, 18, 472, 30, (1, 1, 1))
    imgs['danger'] = d.render()
    # Door inside: circuit directory card (ink).
    d = L.Decal('fb_card', 512, 640, bg=(0, 0, 0, 1))
    d.text(256, 590, 'CIRCUIT  DIRECTORY', 38, (1, 1, 1), kind='serif_bold', spacing=1.1)
    d.rect(40, 560, 472, 563, (1, 1, 1))
    rows = [('1', 'KITCHEN  &  PANTRY'), ('2', 'HALL  •  STAIRS  •  PORCH'), ('3', 'CELLAR')]
    for i in range(8):
        y = 500 - i * 58
        d.rect(40, y - 22, 472, y - 20, (0.6, 0.6, 0.6))
        if i < len(rows):
            d.text(62, y, rows[i][0], 34, (1, 1, 1), kind='mono_bold', align='LEFT')
            d.text(110, y, rows[i][1], 28, (1, 1, 1), kind='mono_bold', align='LEFT')
    d.text(300, 92, 'do NOT touch  - F.', 30, (1, 1, 1), kind='serif', rot=4.0)
    imgs['card'] = d.render()
    # Side wall: ON / OFF by the lever.
    d = L.Decal('fb_side', 256, 512)
    d.text(128, 470, 'ON', 64, (1, 1, 1), kind='sans_bold')
    d.poly([(128, 410), (100, 380), (156, 380)], (1, 1, 1))
    d.text(128, 40, 'OFF', 64, (1, 1, 1), kind='sans_bold')
    d.poly([(128, 100), (100, 130), (156, 130)], (1, 1, 1))
    imgs['side'] = d.render()
    return imgs


def _materials(imgs):
    def panel_text(k):
        m = k.decal(imgs['panel'], k.plane_uv((0, PANEL_Y, 0), (-1, 0, 0), (0, 0, 1), 0.384, 0.52))
        return k.mul(m, k.ramp_f(k.xyz(k.coord())[1], PANEL_Y - 0.0008, PANEL_Y - 0.0002))

    def danger(k):
        c = _door_matrix() @ Vector((0.0, D + 0.0215, 0.06))
        m = k.decal(imgs['danger'], k.plane_uv(tuple(c), tuple(_rot((-1, 0, 0))), (0, 0, 1), 0.26, 0.13))
        n = k.vmath('DOT_PRODUCT', k.geo('Normal'), tuple(_rot((0, 1, 0))), out=1)
        rough = k.ramp_f(k.noise(scale=70, detail=5), 0.35, 0.55)
        return k.mul(k.mul(m, k.ramp_f(n, 0.5, 0.8)), k.add(0.35, k.mul(rough, 0.65)))

    def side_text(k):
        m = k.decal(imgs['side'], k.plane_uv((-W / 2, 0.075, 0.07), (0, -1, 0), (0, 0, 1), 0.05, 0.10))
        x = k.xyz(k.coord())[0]
        return k.mul(m, k.ramp_f(x, -W / 2 + 0.0008, -W / 2 + 0.0002))

    def card_ink(k):
        c = _door_matrix() @ Vector((0.0, D + 0.0035, 0.02))
        # seen from inside the door: u toward +X (closed frame), v up
        m = k.decal(imgs['card'], k.plane_uv(tuple(c), tuple(_rot((1, 0, 0))), (0, 0, 1), 0.20, 0.25))
        return k.ramp_f(m, 0.15, 0.8)

    mats = dict(
        steel=M.painted_steel('fb_steel', marks=[M.printed(side_text, (0.42, 0.40, 0.34), rough=0.6)]),
        steel_door=M.painted_steel('fb_steel_door', marks=[M.printed(danger, (0.30, 0.035, 0.02), rough=0.55)]),
        panel=M.painted_steel('fb_panel', paint=(0.020, 0.021, 0.020), chips=0.6, rust=0.45, dust=0.8,
                              marks=[M.printed(panel_text, (0.48, 0.46, 0.40), rough=0.6)]),
        porcelain=M.porcelain('fb_porcelain'),
        brass=M.brass('fb_brass', s=0.6, tarnish=0.7),
        chrome=M.chrome('fb_chrome', s=1.5),
        conduit=M.galvanized('fb_conduit'),
        bakelite=M.bakelite('fb_bakelite'),
        lever=M.black_enamel('fb_lever', s=2.0, under=(0.12, 0.11, 0.10), under_metal=0.8),
        card=M.paper('fb_card', card_ink),
    )
    return mats


def _drop_back(obj, y0):
    """Delete faces lying on the plane y = y0 facing -Y (against the wall / panel, never seen)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    kill = [f for f in bm.faces if f.normal.y < -0.9 and abs(f.calc_center_median().y - y0) < 2e-4]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(obj.data)
    bm.free()


def _clip(name, x, z, hi):
    """Brass spring clip: a C around the fuse ferrule, open toward the front."""
    ro, ri = 0.0119, 0.0107
    n = 14 if hi else 4
    a0, a1 = math.radians(145), math.radians(395)
    outer = [(ro * math.cos(a0 + (a1 - a0) * i / n), ro * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]
    inner = [(ri * math.cos(a0 + (a1 - a0) * i / n), ri * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]
    outline = outer + list(reversed(inner))
    o = L.prism(name, outline, 0.013, loc=(x, FUSE_Y, z))
    if hi:
        L.bevel(o, 0.0003, 2, angle=40, harden=False)
    L.smooth_by_angle(o, 40)
    return o


def _parts(hi: bool, mats):
    out = []

    def add(o, key, pid=0):
        out.append((o, key, pid))
        return o

    sv = 6 if hi else 2
    # --- enclosure: rounded box, front removed, shelled inward, outer back removed
    box = L.rounded_box('enclosure', (W, D, H), (0, D / 2, 0), 0.010, 0.003, sv, 3 if hi else 1, axis='Y')
    bm = bmesh.new()
    bm.from_mesh(box.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.y > 0.9 and f.calc_center_median().y > D - 1e-4],
                     context='FACES')
    bm.to_mesh(box.data)
    bm.free()
    L.solidify(box, 0.0025, offset=-1.0)
    bm = bmesh.new()
    bm.from_mesh(box.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.y < -0.9 and f.calc_center_median().y < 1e-4],
                     context='FACES')
    if hi:  # round the rolled front lip
        lip = [e for e in bm.edges if all(v.co.y > D - 0.003 for v in e.verts) and len(e.link_faces) == 2
               and e.calc_face_angle(0) > math.radians(40)]
        bmesh.ops.bevel(bm, geom=lip, offset=0.0009, segments=3, profile=0.5, affect='EDGES', clamp_overlap=True)
    bm.to_mesh(box.data)
    bm.free()
    L.smooth_by_angle(box, 50)
    add(box, 'steel')
    # mounting ears top/bottom
    for sz in (-1, 1):
        ear = L.rounded_box('ear', (0.12, 0.0025, 0.045), (0, 0.00125, sz * (H / 2 + 0.012)), 0.006 if hi else 0.0,
                            0.0006, sv, 2 if hi else 1, axis='Y')
        if not hi:
            _drop_back(ear, 0.0)
        add(ear, 'steel')
        if hi:
            add(L.lathe('ear_screw', [(0.0, 0.0), (0.0062, 0.0), (0.0058, 0.0012), (0.0035, 0.0024), (0.0, 0.0027)],
                        32, loc=(0, 0.0025, sz * (H / 2 + 0.017)), rot=(-90, 0, 0)), 'chrome')
    # --- dead-front panel
    panel = L.rounded_box('panel', (0.384, 0.004, 0.52), (0, PANEL_Y - 0.002, 0), 0.006, 0.0008, sv,
                          2 if hi else 1, axis='Y')
    if not hi:
        _drop_back(panel, PANEL_Y - 0.004)
    add(panel, 'panel')
    if hi:
        for sx in (-0.175, 0.175):
            for sz in (-0.245, 0.245):
                add(L.lathe('panel_screw', [(0.0, 0.0), (0.0045, 0.0), (0.0042, 0.0008), (0.0025, 0.0016),
                                            (0.0, 0.0018)], 32, loc=(sx, PANEL_Y, sz), rot=(-90, 0, 0)), 'chrome')
    # --- lamps (bezels in the atlas; jewels are separate, returned with part ids 10+)
    for i, x in enumerate(SLOT_XS):
        add(L.lathe('lamp_bezel', [(0.0170, 0.0), (0.0170, 0.0030), (0.0160, 0.0048), (0.0140, 0.0060),
                                   (0.0120, 0.0058), (0.0116, 0.0040)] if hi else
                    [(0.0170, 0.0), (0.0170, 0.0034), (0.0118, 0.0058)],
                    48 if hi else 12, loc=(x, PANEL_Y, LAMP_Z), rot=(-90, 0, 0)), 'chrome')
    # --- porcelain fuse blocks + brass clips
    for x in SLOT_XS:
        blk = L.rounded_box('block', (0.060, BLOCK_D, 0.165), (x, BLOCK_Y0 + BLOCK_D / 2, SLOT_Z),
                            0.007 if hi else 0.0, 0.0025 if hi else 0.0035, sv, 3 if hi else 1, axis='Y')
        if not hi:
            _drop_back(blk, BLOCK_Y0)
        add(blk, 'porcelain')
        for dz in (-CLIP_DZ, CLIP_DZ):
            add(_clip('clip', x, SLOT_Z + dz, hi), 'brass')
            if hi:  # rivet holding the clip
                add(L.lathe('clip_rivet', [(0.0, 0.0), (0.0030, 0.0), (0.0027, 0.0007), (0.0012, 0.0012),
                                           (0.0, 0.0013)], 24, loc=(x, BLOCK_Y0 + BLOCK_D, SLOT_Z + dz + 0.0105),
                            rot=(-90, 0, 0)), 'brass')
    # --- conduit: lock-nut + connector on the box top, pipe, coupling, one-hole strap
    cx, cy = CONDUIT
    zt = H / 2
    add(L.lathe('locknut', [(0.0185, 0.0), (0.0185, 0.0045), (0.0150, 0.0060), (0.0128, 0.0060)], 6,
                loc=(cx, cy, zt), start=30.0, smooth_deg=None), 'conduit')
    add(L.lathe('connector', [(0.0158, 0.0058), (0.0158, 0.0220), (0.0140, 0.0250), (0.0122, 0.0250)],
                32 if hi else 10, loc=(cx, cy, zt)), 'conduit')
    add(L.lathe('pipe', [(0.0117, zt + 0.024), (0.0117, CONDUIT_TOP)], 32 if hi else 10, loc=(cx, cy, 0)), 'conduit')
    zc = 0.86
    add(L.lathe('coupling', [(0.0118, zc - 0.022), (0.0142, zc - 0.020), (0.0145, zc - 0.016), (0.0145, zc + 0.016),
                             (0.0142, zc + 0.020), (0.0118, zc + 0.022)] if hi else
                [(0.0118, zc - 0.022), (0.0145, zc - 0.018), (0.0145, zc + 0.018), (0.0118, zc + 0.022)],
                32 if hi else 10, loc=(cx, cy, 0)), 'conduit')
    zs = 1.16
    strap = L.lathe('strap', [(0.0127, zs - 0.009), (0.0127, zs + 0.009)], 24 if hi else 8, loc=(cx, cy, 0),
                    angle=180.0, start=0.0, smooth_deg=40)
    L.solidify(strap, 0.0012, offset=1.0)
    add(strap, 'conduit')
    for sx in (cx + 0.025, cx - 0.025):
        foot = (L.rounded_box('strap_foot', (0.024, 0.0014, 0.018), (sx, 0.0007, zs), 0.004, 0.0004, 2, 1, axis='Y')
                if hi else L.box('strap_foot', (0.024, 0.0014, 0.018), (sx, 0.0007, zs)))
        if not hi:
            _drop_back(foot, 0.0)
        add(foot, 'conduit')
    if hi:
        add(L.lathe('strap_screw', [(0.0, 0.0), (0.0040, 0.0), (0.0036, 0.0008), (0.0020, 0.0014), (0.0, 0.0015)], 24,
                    loc=(cx + 0.028, 0.0014, zs), rot=(-90, 0, 0)), 'chrome')

    # --- door (closed geometry, then swung open about the hinge)
    door = []
    dw, dh, dd = W - 0.006, H - 0.006, 0.020
    pan = L.rounded_box('door_pan', (dw, dd, dh), (0, D + 0.002 + dd / 2, 0), 0.009, 0.0025, sv, 3 if hi else 1,
                        axis='Y')
    bm = bmesh.new()
    bm.from_mesh(pan.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.y < -0.9 and f.calc_center_median().y < D + 0.0025],
                     context='FACES')
    bm.to_mesh(pan.data)
    bm.free()
    L.solidify(pan, 0.0018, offset=-1.0)
    L.smooth_by_angle(pan, 50)
    door.append((pan, 'steel_door'))
    card = L.box('card', (0.20, 0.0006, 0.25), (0.0, D + 0.0035, 0.02))
    if hi:
        L.subdivide(card, 3, simple=True)
        for v in card.data.vertices:
            x, z = v.co.x, v.co.z
            v.co.y -= 0.0007 * math.sin(x * 31 + 1.3) * math.sin(z * 23) + 0.0004 * math.sin(z * 70)
        card.data.update()
    door.append((card, 'card'))
    # latch: round base + flat lever on the outside of the free edge
    door.append((L.lathe('latch_base', [(0.0, 0.0), (0.011, 0.0), (0.011, 0.0025), (0.0085, 0.0045), (0.0, 0.0048)]
                         if hi else [(0.011, 0.0), (0.011, 0.0028), (0.0, 0.0048)], 32 if hi else 10,
                         loc=(-dw / 2 + 0.028, D + 0.002 + dd, 0.0), rot=(-90, 0, 0)), 'chrome'))
    lat = L.rounded_box('latch_lever', (0.008, 0.006, 0.038), (-dw / 2 + 0.028, D + 0.002 + dd + 0.0075, -0.010),
                        0.0, 0.0012, 1, 3 if hi else 1)
    door.append((lat, 'chrome'))
    if hi:  # rivets of the (painted) nameplate area + door stiffening ribs suggestion
        for sx in (-0.13, 0.13):
            door.append((L.lathe('door_rivet', [(0.0, 0.0), (0.0032, 0.0), (0.0028, 0.0008), (0.0, 0.0013)], 24,
                                 loc=(sx, D + 0.002 + dd, 0.15), rot=(-90, 0, 0)), 'chrome'))
    # hinge knuckles (fixed to the box side and to the door)
    for hz in (-0.19, 0.19):
        add(L.lathe('hinge', [(0.0, -0.028), (0.0052, -0.028), (0.0055, -0.026), (0.0055, 0.026), (0.0052, 0.028),
                              (0.0, 0.028)] if hi else [(0.0, -0.028), (0.0055, -0.027), (0.0055, 0.027),
                                                         (0.0, 0.028)],
                    24 if hi else 8, loc=(HINGE[0], HINGE[1], hz)), 'steel')
        add(L.rounded_box('hinge_leaf', (0.004, 0.012, 0.050), (W / 2 + 0.002, D + 0.004, hz), 0.0, 0.0005, 1, 2)
            if hi else L.box('hinge_leaf', (0.004, 0.012, 0.050), (W / 2 + 0.002, D + 0.004, hz)), 'steel')
    dm = _door_matrix()
    door_objs = []
    for o, key in door:
        o.data.transform(dm)
        o.data.update()
        door_objs.append(add(o, key, 1))
    for hz in (-0.19, 0.19):
        leaf = (L.rounded_box('door_leaf', (0.020, 0.0035, 0.050), (HINGE[0] - 0.012, D + 0.010, hz), 0.0, 0.0005,
                              1, 2) if hi else L.box('door_leaf', (0.020, 0.0035, 0.050), (HINGE[0] - 0.012, D + 0.010, hz)))
        leaf.data.transform(dm)
        add(leaf, 'steel', 1)

    # --- throw lever (part 2): boss on the side wall, flat arm, bakelite grip
    px_, py_, pz_ = LEVER_PIVOT
    add(L.lathe('lever_boss', [(0.024, 0.0), (0.024, 0.008), (0.021, 0.011)] if not hi else
                [(0.024, 0.0), (0.0242, 0.006), (0.0235, 0.009), (0.021, 0.011)], 40 if hi else 14,
                loc=(-W / 2, py_, pz_), rot=(0, -90, 0)), 'steel')
    hub = L.lathe('lever_hub', [(0.016, 0.009), (0.016, 0.017), (0.012, 0.021), (0.0, 0.022)] if not hi else
                  [(0.016, 0.009), (0.0162, 0.016), (0.015, 0.019), (0.012, 0.021), (0.005, 0.0222), (0.0, 0.0222)],
                  32 if hi else 12, loc=(-W / 2, py_, pz_), rot=(0, -90, 0))
    add(hub, 'lever', 2)
    t = math.radians(LEVER_TILT)
    arm_len = 0.20
    dirv = Vector((0, math.sin(t), -math.cos(t)))
    arm_c = Vector((-W / 2 - 0.016, py_, pz_)) + dirv * (arm_len / 2)
    arm = L.rounded_box('lever_arm', (0.007, 0.020, arm_len), tuple(arm_c), 0.0, 0.0018, 1, 3 if hi else 1,
                        rot=(-LEVER_TILT, 0, 0))
    add(arm, 'lever', 2)
    gp = Vector((-W / 2 - 0.016, py_, pz_)) + dirv * (arm_len + 0.002)
    grip = L.lathe('lever_grip', [(0.0, 0.0), (0.010, 0.0), (0.0135, 0.008), (0.0145, 0.030), (0.0135, 0.060),
                                  (0.0110, 0.072), (0.0, 0.074)] if not hi else
                   [(0.0, 0.0), (0.009, 0.0), (0.0115, 0.002), (0.0135, 0.008), (0.0145, 0.020), (0.0145, 0.040),
                    (0.0138, 0.058), (0.0125, 0.068), (0.0105, 0.073), (0.006, 0.0745), (0.0, 0.075)],
                   48 if hi else 10, loc=(gp.x - 0.022, gp.y, gp.z), rot=(0, -90, 0))
    add(grip, 'bakelite', 2)

    if mats:
        for o, key, _ in out:
            L.assign(o, mats[key])
    return out


def _jewel(i):
    x = SLOT_XS[i]
    o = L.lathe(f'lamp_{i}', [(0.0116, 0.0030), (0.0116, 0.0058), (0.0084, 0.0112), (0.0, 0.0136)], 10,
                smooth_deg=None)
    L.flat(o)
    L.xform(o, (x, PANEL_Y, LAMP_Z), (-90, 0, 0))
    m = L.flat_material(f'lamp_{i}', color=(0.16, 0.015, 0.012), rough=0.12, emission=(0.0, 0.0, 0.0))
    L.assign(o, m)
    return o


def build_fusebox(final: bool = True) -> None:
    common.reset()
    imgs = _decals()
    mats = _materials(imgs)
    highs = [o for o, _, _ in _parts(True, mats)]
    lows = _parts(False, None)
    for o, key, pid in lows:
        L.tag(o, pid)
        if o.name.startswith(('enclosure', 'panel', 'block', 'door_pan', 'ear')):
            L.weighted_normals(o)
    low = L.join([o for o, _, _ in lows], 'fusebox_atlas')
    L.triangulate(low)
    lamps = [_jewel(i) for i in range(3)]

    def texel(poly, obj):
        c, n = poly.center, poly.normal
        if c.z > H / 2 + 0.03:
            return 0.35      # conduit up the wall
        if abs(c.x) < W / 2 - 0.004 and abs(c.z) < H / 2 - 0.004 and c.y < PANEL_Y - 0.004:
            return 0.4       # inside walls behind the panel
        return 1.0

    L.uv_unwrap(low, margin=0.002, scale_faces=texel)
    size = L.tex_size(1024)
    L.bake_atlas(low, 'fusebox', size, highs, samples_=L.samples(16), extrusion=0.0015, max_ray=0.004)
    for o in highs:
        L.delete(o)
    parts = L.split_parts(low, {0: 'fusebox_body', 1: 'fusebox_door', 2: 'lever'})
    body, door, lever = parts['fusebox_body'], parts['fusebox_door'], parts['lever']
    L.set_origin(door, (HINGE[0], HINGE[1], 0.0))
    L.set_origin(lever, LEVER_PIVOT)
    for i, lamp in enumerate(lamps):
        L.set_origin(lamp, (SLOT_XS[i], PANEL_Y, LAMP_Z))
    slots = []
    for i, x in enumerate(SLOT_XS):
        e = bpy.data.objects.new(f'slot_{i}', None)
        e.empty_display_type = 'PLAIN_AXES'
        e.empty_display_size = 0.03
        e.location = (x, FUSE_Y, SLOT_Z)
        bpy.context.scene.collection.objects.link(e)
        slots.append(e)
    objs = [body, door, lever] + lamps + slots
    meshes = [body, door, lever] + lamps
    common.report('fusebox', meshes)
    common.export_glb('fusebox', objs)
    # Preview with fuses in two of the slots and the lamps showing on/off states.
    preview_fuses = _preview_fuses(slots[:2])
    for i, lamp in enumerate(lamps):
        b = common._bsdf(lamp.data.materials[0])
        if i < 2:
            b.inputs['Base Color'].default_value = (0.25, 0.9, 0.3, 1)
            b.inputs['Emission Color'].default_value = (0.3, 1.0, 0.35, 1)
            b.inputs['Emission Strength'].default_value = 6.0
    frame = ((-W / 2 - 0.05, 0.0, -H / 2 - 0.04), (W / 2 + 0.05, 0.5, H / 2 + 0.06))
    L.previews('fusebox', meshes + preview_fuses, [('3q', dict(yaw=30, pitch=10, mood='studio')),
                                                  ('flash', dict(yaw=12, pitch=6, mood='flash'))], final=final,
               frame=frame)
    L.previews('fusebox', meshes, [('full', dict(yaw=30, pitch=10, mood='studio'))], final=False)


def _preview_fuses(slots):
    """Import the built fuse.glb into the slots (preview only)."""
    import os
    path = os.path.join(common.MODELS_DIR, 'fuse.glb')
    if not os.path.exists(path):
        return []
    out = []
    for s in slots:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        new = [o for o in bpy.data.objects if o not in before]
        for o in new:
            if o.parent is None:
                o.location = Vector(o.location) + s.location
        out += [o for o in new if o.type == 'MESH']
    bpy.context.view_layer.update()
    return out
