"""
radiator.glb: an old cast-iron two-column radiator, ~0.9 x 0.65 x 0.18 m (wall dressing, placement
'floor', origin bottom center, back toward the wall at -Y, front +Y).

12 cast sections (each an extruded stadium-loop profile with the open slot between its two
columns) on top + bottom hub bars, cast feet on the end sections, a supply valve with a handwheel
on one end and a return elbow on the other. Low poly: the column faces are flat but carry custom
split normals that curve them like round tubes. Three section variants own UV islands of a
1024 px atlas and the other sections reuse them, so the bake is dense (about 1 mm per pixel).

Baked from a procedural Cycles material: peeling silver (aluminium) radiator paint over dark cast
iron, rust blooming where the paint let go (worst low down and in crevices), dust on top faces,
grime in the gaps. Helper module (built through trims.py).
"""

from __future__ import annotations

import math
import os

import bpy
import bmesh
import numpy as np
from mathutils import Vector

import common as C
import trims_lib as T

N_SECT = 12
WIDTH = 0.78           # span of the sections (pipes + valve bring the total to ~0.9 m)
PITCH = WIDTH / N_SECT  # 6.5 cm, about the classic 2.5" section pitch
THICK = 0.046          # section thickness along X
DEPTH = 0.18           # column depth along Y
Z0, Z1 = 0.06, 0.65    # section bottom / top
R_O = DEPTH / 2
SLOT_W = 0.028         # half width of the open slot between the columns
SLOT_Z0, SLOT_Z1 = 0.17, 0.54
DRAFT = os.environ.get('TRIMS_Q') == 'draft'
TEX = 512 if DRAFT else 1024


def build() -> None:
    print('trims_radiator: built through trims.py')


# =============================================================================================
# Geometry
# =============================================================================================

def _stadium(r, zc0, zc1, n_half=5):
    """Closed loop (y, z) around a vertical stadium: top half-circle at zc1, bottom at zc0, plus
    one midpoint per straight side. 2 * n_half + 2 points, counter-clockwise seen from +X."""
    pts = []
    for i in range(n_half):          # top: from +y (angle 0) over to -y (angle pi)
        a = math.pi * i / (n_half - 1)
        pts.append((r * math.cos(a), zc1 + r * math.sin(a)))
    pts.append((-r, (zc0 + zc1) / 2))
    for i in range(n_half):          # bottom: from -y (pi) to +y (2 pi)
        a = math.pi + math.pi * i / (n_half - 1)
        pts.append((r * math.cos(a), zc0 + r * math.sin(a)))
    pts.append((r, (zc0 + zc1) / 2))
    return pts


def section_mesh(name: str) -> bpy.types.Mesh:
    outer = _stadium(R_O, Z0 + R_O, Z1 - R_O)
    inner = _stadium(SLOT_W, SLOT_Z0 + SLOT_W, SLOT_Z1 - SLOT_W)
    n = len(outer)
    bm = bmesh.new()
    h = THICK / 2
    o = [[bm.verts.new((sx * h, y, z)) for (y, z) in outer] for sx in (-1, 1)]
    i_ = [[bm.verts.new((sx * h, y, z)) for (y, z) in inner] for sx in (-1, 1)]
    for k in range(n):
        k2 = (k + 1) % n
        # caps (+X side counter-clockwise seen from +X, -X side reversed)
        bm.faces.new((o[1][k], o[1][k2], i_[1][k2], i_[1][k]))
        bm.faces.new((o[0][k], i_[0][k], i_[0][k2], o[0][k2]))
        # outer wall (normal outward) and slot wall (normal into the slot)
        bm.faces.new((o[0][k], o[0][k2], o[1][k2], o[1][k]))
        bm.faces.new((i_[0][k], i_[1][k], i_[1][k2], i_[0][k2]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return me


def tube_normals(ob: bpy.types.Object, tilt: float = 0.85) -> None:
    """Custom split normals: flat caps; outer + slot walls smooth around the profile and tilted
    toward +-X at their edges, so each flat column face shades like a round tube."""
    me = ob.data
    me.shade_smooth()
    xs = [v.co.x for v in me.vertices]
    cx = (min(xs) + max(xs)) / 2
    prof = {}
    for p in me.polygons:
        if abs(p.normal.x) > 0.7:
            continue
        for vi in p.vertices:
            co = me.vertices[vi].co
            key = (round(co.y, 5), round(co.z, 5), _wall_kind(p))
            prof[key] = prof.get(key, Vector((0, 0, 0))) + Vector((0, p.normal.y, p.normal.z))
    normals = []
    for p in me.polygons:
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            if abs(p.normal.x) > 0.7:
                normals.append(tuple(p.normal))
                continue
            pn = prof[(round(co.y, 5), round(co.z, 5), _wall_kind(p))].normalized()
            sx = 1.0 if co.x > cx else -1.0
            normals.append(tuple((pn + Vector((sx * tilt, 0, 0))).normalized()))
    me.normals_split_custom_set(normals)


def _wall_kind(p) -> int:
    """0 = outer wall, 1 = slot wall (by distance of the face center from the profile axis)."""
    c = p.center
    return 1 if abs(c.y) < (SLOT_W + R_O) / 2 and SLOT_Z0 - 0.01 < c.z < SLOT_Z1 + 0.01 else 0


def cylinder(name, p0, p1, r, sides=8, caps=(False, False)) -> bpy.types.Object:
    p0, p1 = Vector(p0), Vector(p1)
    axis = (p1 - p0).normalized()
    ref = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((1, 0, 0))
    a = axis.cross(ref).normalized()
    b = axis.cross(a).normalized()
    bm = bmesh.new()
    rings = []
    for p in (p0, p1):
        rings.append([bm.verts.new(p + (a * math.cos(t) + b * math.sin(t)) * r)
                      for t in np.linspace(0, 2 * math.pi, sides, endpoint=False)])
    for k in range(sides):
        k2 = (k + 1) % sides
        bm.faces.new((rings[0][k], rings[0][k2], rings[1][k2], rings[1][k]))
    if caps[0]:
        bm.faces.new(rings[0][::-1])
    if caps[1]:
        bm.faces.new(rings[1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    me.shade_smooth()
    return ob


def box(name, lo, hi, bevel=0.004, drop=()):
    ob = T.board(name, lo, hi, bevel=bevel, drop=drop)
    ob.data.shade_smooth()
    return ob


# =============================================================================================
# Material (procedural, Cycles) -> baked
# =============================================================================================

class NB:
    def __init__(self, mat):
        self.nt = mat.node_tree
        self.x = -1600

    def n(self, kind, inputs=None, **props):
        node = self.nt.nodes.new(kind)
        node.location = (self.x, 0)
        self.x += 30
        for k, v in props.items():
            setattr(node, k, v)
        for k, v in (inputs or {}).items():
            if isinstance(v, bpy.types.NodeSocket):
                self.nt.links.new(v, node.inputs[k])
            else:
                node.inputs[k].default_value = v
        return node

    def math(self, op, a, b=None, clamp=False):
        node = self.n('ShaderNodeMath', operation=op, use_clamp=clamp)
        for idx, v in ((0, a), (1, b)):
            if v is None:
                continue
            if isinstance(v, bpy.types.NodeSocket):
                self.nt.links.new(v, node.inputs[idx])
            else:
                node.inputs[idx].default_value = v
        return node.outputs[0]

    def mix(self, fac, a, b, blend='MIX'):
        node = self.n('ShaderNodeMix', data_type='RGBA', blend_type=blend)
        for key, v in (('Factor', fac), ('A', a), ('B', b)):
            if isinstance(v, bpy.types.NodeSocket):
                self.nt.links.new(v, node.inputs[key])
            else:
                node.inputs[key].default_value = v if key == 'Factor' else (*v, 1.0)
        return node.outputs['Result']

    def mixf(self, fac, a, b):
        node = self.n('ShaderNodeMix', data_type='FLOAT')
        for key, v in (('Factor', fac), ('A', a), ('B', b)):
            if isinstance(v, bpy.types.NodeSocket):
                self.nt.links.new(v, node.inputs[key])
            else:
                node.inputs[key].default_value = v
        return node.outputs['Result']

    def ramp(self, fac, lo, hi):
        """Linear step lo..hi -> 0..1 (Map Range, clamped)."""
        node = self.n('ShaderNodeMapRange', clamp=True)
        if isinstance(fac, bpy.types.NodeSocket):
            self.nt.links.new(fac, node.inputs['Value'])
        node.inputs['From Min'].default_value = lo
        node.inputs['From Max'].default_value = hi
        return node.outputs['Result']


def radiator_material() -> tuple[bpy.types.Material, dict]:
    mat = bpy.data.materials.new('radiator_src')
    try:
        mat.use_nodes = True
    except Exception:
        pass
    nb = NB(mat)
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tc = nb.n('ShaderNodeTexCoord')
    pos = tc.outputs['Object']
    geo = nb.n('ShaderNodeNewGeometry')
    nz = nb.n('ShaderNodeSeparateXYZ', {'Vector': geo.outputs['Normal']}).outputs['Z']
    pz = nb.n('ShaderNodeSeparateXYZ', {'Vector': pos}).outputs['Z']
    ao_big = nb.n('ShaderNodeAmbientOcclusion', {'Distance': 0.06}, samples=8).outputs['AO']
    ao_small = nb.n('ShaderNodeAmbientOcclusion', {'Distance': 0.015}, samples=4).outputs['AO']
    ao = nb.math('MULTIPLY', ao_big, ao_small)

    def noise(scale, detail=6.0, rough=0.6, distortion=0.0, w=0.0):
        n = nb.n('ShaderNodeTexNoise', {'Vector': pos, 'Scale': scale, 'Detail': detail, 'Roughness': rough,
                                         'Distortion': distortion, 'W': w}, noise_dimensions='4D')
        return n.outputs['Fac']

    # paint loss: big flaking patches, worse low down and in crevices
    flake_n = noise(9.0, 10.0, 0.62, 0.2, 1.3)
    lowness = nb.ramp(pz, 0.45, 0.05)                # 0 at the top, 1 near the floor
    crevice = nb.ramp(ao, 0.75, 0.35)
    thr = nb.math('SUBTRACT', 0.60, nb.math('ADD', nb.math('MULTIPLY', lowness, 0.14), nb.math('MULTIPLY', crevice, 0.10)))
    lost = nb.ramp(nb.math('SUBTRACT', flake_n, thr), 0.0, 0.012)
    near_edge = nb.ramp(nb.math('SUBTRACT', flake_n, thr), -0.035, 0.0)   # just around the flakes
    # rust: varies from dark brown scale to orange bloom
    rust_n = noise(28.0, 8.0, 0.65, 0.0, 4.1)
    # (node colors are LINEAR: sRGB (0.20, 0.11, 0.06) .. (0.42, 0.20, 0.08))
    rust_col = nb.mix(nb.ramp(rust_n, 0.35, 0.7), (0.03, 0.012, 0.006), (0.105, 0.04, 0.014))
    iron_col = (0.018, 0.017, 0.016)
    rust_amt = nb.ramp(noise(5.0, 4.0, 0.5, 0.0, 7.7), 0.3, 0.6)
    bare = nb.mix(nb.math('MAXIMUM', rust_amt, lowness), iron_col, rust_col)
    # silver paint: slightly mottled, darkened and yellowed with age
    paint_n = noise(40.0, 4.0, 0.5, 0.0, 2.2)
    paint = nb.mix(nb.ramp(paint_n, 0.3, 0.7), (0.10, 0.099, 0.092), (0.15, 0.147, 0.136))
    paint = nb.mix(nb.math('MULTIPLY', near_edge, 0.6), paint, (0.11, 0.045, 0.015))   # rust bleeding under paint
    # rust run-off streaks down the columns below the bare patches
    mp = nb.n('ShaderNodeMapping', {'Vector': pos, 'Scale': (26.0, 26.0, 2.2)})
    streak_n = nb.n('ShaderNodeTexNoise', {'Vector': mp.outputs['Vector'], 'Scale': 1.0, 'Detail': 4.0, 'W': 3.3},
                    noise_dimensions='4D').outputs['Fac']
    streak = nb.math('MULTIPLY', nb.ramp(streak_n, 0.55, 0.75), nb.math('ADD', 0.25, lowness))
    paint = nb.mix(nb.math('MULTIPLY', streak, 0.55), paint, (0.08, 0.03, 0.01))
    col = nb.mix(lost, paint, bare)
    # grime in crevices + dust on upward faces
    col = nb.mix(nb.math('MULTIPLY', crevice, 0.8), col, (0.008, 0.007, 0.006))
    dust_m = nb.math('MULTIPLY', nb.ramp(nz, 0.35, 0.85), nb.ramp(noise(14.0, 5.0, 0.6, 0.0, 9.0), 0.3, 0.6))
    col = nb.mix(nb.math('MULTIPLY', dust_m, 0.75), col, (0.15, 0.14, 0.125))
    # roughness / metallic
    rough = nb.mixf(lost, nb.math('ADD', 0.56, nb.math('MULTIPLY', paint_n, 0.15)), 0.88)
    rough = nb.mixf(dust_m, rough, 0.95)
    rough = nb.mixf(crevice, rough, 0.9)
    metal = nb.mixf(lost, 0.22, nb.mixf(rust_amt, 0.35, 0.06))
    metal = nb.mixf(dust_m, metal, 0.0)
    metal = nb.mixf(crevice, metal, 0.2)
    # relief: cast-iron sand texture, paint thickness steps, rust scale
    sand = noise(220.0, 2.0, 0.5, 0.0, 0.5)
    h = nb.math('ADD', nb.math('MULTIPLY', sand, 0.25), nb.math('MULTIPLY', nb.math('SUBTRACT', 1.0, lost), 0.5))
    h = nb.math('ADD', h, nb.math('MULTIPLY', nb.math('MULTIPLY', rust_n, lost), 0.4))
    bump = nb.n('ShaderNodeBump', {'Height': h, 'Distance': 0.0006, 'Strength': 1.0})
    nt.links.new(col, bsdf.inputs['Base Color'])
    nt.links.new(rough, bsdf.inputs['Roughness'])
    nt.links.new(metal, bsdf.inputs['Metallic'])
    nt.links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return mat, {'metal': metal, 'bsdf': bsdf}


def bake_radiator(targets, mat, refs) -> dict:
    """Bake color (metallic zeroed), roughness, metallic (via emission) and tangent normals of the
    procedural material into one 1024 px atlas shared by `targets` (non-overlapping UVs)."""
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    nt = mat.node_tree
    tgt = nt.nodes.new('ShaderNodeTexImage')
    tgt.name = '__bake__'

    def image(kind, non_color):
        im = bpy.data.images.new(f'radiator_{kind}', TEX, TEX, alpha=False)
        if non_color:
            im.colorspace_settings.name = 'Non-Color'
        return im

    def run(kind, im, samples, **kw):
        tgt.image = im
        for n in nt.nodes:
            n.select = False
        tgt.select = True
        nt.nodes.active = tgt
        C.activate(targets[0], targets)
        scene.cycles.samples = samples
        bpy.ops.object.bake(type=kind, margin=6, use_selected_to_active=False, **kw)

    out = {}
    bsdf = refs['bsdf']
    # color: metallic unlinked + 0 (Cycles' diffuse color is black on metals)
    msock = bsdf.inputs['Metallic']
    link = msock.links[0].from_socket if msock.links else None
    for l in list(msock.links):
        nt.links.remove(l)
    msock.default_value = 0.0
    out['color'] = image('color', False)
    run('DIFFUSE', out['color'], 2 if DRAFT else 6, pass_filter={'COLOR'})
    if link:
        nt.links.new(link, msock)
    out['rough'] = image('rough', True)
    run('ROUGHNESS', out['rough'], 4)
    out['normal'] = image('normal', True)
    run('NORMAL', out['normal'], 4, normal_space='TANGENT')
    # metallic -> emission
    em = bsdf.inputs['Emission Color']
    nt.links.new(refs['metal'], em)
    bsdf.inputs['Emission Strength'].default_value = 1.0
    out['metal'] = image('metal', True)
    run('EMIT', out['metal'], 1)
    for l in list(em.links):
        nt.links.remove(l)
    bsdf.inputs['Emission Strength'].default_value = 0.0
    return out


def _px(im):
    a = np.empty(TEX * TEX * 4, np.float32)
    im.pixels.foreach_get(a)
    return a.reshape(TEX, TEX, 4)


# =============================================================================================
# Build
# =============================================================================================

def build_radiator() -> list:
    C.reset()
    base_me = section_mesh('section')
    # --- sections: 3 variants own UV islands, the rest reuse them -------------------------------
    xs = [-WIDTH / 2 + PITCH * (i + 0.5) for i in range(N_SECT)]
    rngv = np.random.default_rng(3)
    variant = [0, 1, 2] + list(rngv.integers(0, 3, N_SECT - 3))
    order = list(range(N_SECT))
    # masters sit in characteristic places: an end, the middle, the other end
    masters = {0: 0, 1: N_SECT // 2, 2: N_SECT - 1}
    variant = [None] * N_SECT
    for v, i in masters.items():
        variant[i] = v
    for i in range(N_SECT):
        if variant[i] is None:
            variant[i] = int(rngv.integers(0, 3))
    sections = []
    for i, x in enumerate(xs):
        me = base_me.copy()
        ob = bpy.data.objects.new(f'sec{i}', me)
        bpy.context.scene.collection.objects.link(ob)
        ob.location = (x, 0, 0)
        sections.append(ob)
    for ob in sections:
        C.apply_transform(ob, location=True)
    # hub bars, feet, valve, pipes
    extras = []
    extras.append(cylinder('hub_top', (xs[0], 0, Z1 - R_O + 0.012), (xs[-1], 0, Z1 - R_O + 0.012), 0.024))
    extras.append(cylinder('hub_bot', (xs[0], 0, Z0 + R_O - 0.012), (xs[-1], 0, Z0 + R_O - 0.012), 0.024))
    for x in (xs[0], xs[-1]):
        for y in (-0.06, 0.06):
            extras.append(box(f'foot_{x}_{y}', (x - 0.019, y - 0.022, 0.0), (x + 0.019, y + 0.022, Z0 + 0.03),
                              bevel=0.0, drop=('+z',)))
    xe = WIDTH / 2 + 0.032
    zs = Z1 - R_O + 0.012
    extras.append(cylinder('supply_stub', (xs[-1] + THICK / 2 - 0.004, 0, zs), (xe - 0.018, 0, zs), 0.014))
    extras.append(box('valve_body', (xe - 0.022, -0.022, zs - 0.035), (xe + 0.022, 0.022, zs + 0.022), bevel=0.008))
    extras.append(cylinder('valve_stem', (xe, 0, zs + 0.022), (xe, 0, zs + 0.05), 0.006, sides=6))
    extras.append(cylinder('valve_wheel', (xe, 0, zs + 0.05), (xe, 0, zs + 0.062), 0.03, sides=8, caps=(True, True)))
    extras.append(cylinder('supply_pipe', (xe, 0, zs - 0.035), (xe, 0, -0.02), 0.014))
    zr = Z0 + R_O - 0.012
    extras.append(cylinder('return_stub', (xs[0] - THICK / 2 + 0.004, 0, zr), (-xe, 0, zr), 0.014))
    extras.append(box('return_elbow', (-xe - 0.02, -0.02, zr - 0.02), (-xe + 0.02, 0.02, zr + 0.02), bevel=0.01))
    extras.append(cylinder('return_pipe', (-xe, 0, zr - 0.02), (-xe, 0, -0.02), 0.014))

    # --- UVs: unwrap one section, pack masters + extras into one atlas ---------------------------
    master_objs = [sections[masters[v]] for v in range(3)]
    bake_set = master_objs + extras
    for ob in bake_set:
        if not ob.data.uv_layers:
            ob.data.uv_layers.new(name='UVMap')
    C.activate(bake_set[0], bake_set)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=0.004)
    bpy.ops.object.mode_set(mode='OBJECT')
    # the section caps face each other across 2 cm gaps (barely visible): give them 1/3 the
    # texel density so the columns' outer faces get the pixels
    for ob in master_objs:
        me = ob.data
        uv = me.uv_layers.active.data
        for side in (-1, 1):
            loops = [li for p in me.polygons if p.normal.x * side > 0.7 for li in p.loop_indices]
            cu = sum(uv[li].uv.x for li in loops) / len(loops)
            cv = sum(uv[li].uv.y for li in loops) / len(loops)
            for li in loops:
                uv[li].uv = (cu + (uv[li].uv.x - cu) * 0.35, cv + (uv[li].uv.y - cv) * 0.35)
    C.activate(bake_set[0], bake_set)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(margin=0.004, rotate=True, scale=True)
    bpy.ops.object.mode_set(mode='OBJECT')

    mat, refs = radiator_material()
    for ob in sections + extras:
        ob.data.materials.clear()
        ob.data.materials.append(mat)
    for ob in sections:
        tube_normals(ob)
    imgs = bake_radiator(bake_set, mat, refs)

    # --- final material: color, ORM-style (G rough, B metal), normal ------------------------------
    col = _px(imgs['color'])
    rough = _px(imgs['rough'])[..., 0]
    metal = _px(imgs['metal'])[..., 0]
    orm = np.stack([np.ones_like(rough), np.clip(rough, 0.05, 1), np.clip(metal, 0, 0.8)], -1)
    tmp = bpy.app.tempdir or '/tmp'
    paths = {}
    from surfaces_lib import save_image
    for k, arr in (('color', col[..., :3]), ('orm', orm), ('normal', _px(imgs['normal'])[..., :3])):
        p = os.path.join(tmp, f'radiator_{k}.webp')
        save_image(p, arr, quality=90)
        paths[k] = p
    fin = T.textured_material('radiator', T.load_image(paths['color'], False), T.load_image(paths['orm'], True),
                              T.load_image(paths['normal'], True), occlusion=False)
    fin.use_backface_culling = True
    for im in bpy.data.images:
        if im.filepath.endswith('.webp'):
            im.pack()
    # copies reuse their variant's UVs (identical topology -> copy loop by loop)
    for i, ob in enumerate(sections):
        m = master_objs[variant[i]]
        if ob is m:
            continue
        src = m.data.uv_layers.active.data
        if not ob.data.uv_layers:
            ob.data.uv_layers.new(name='UVMap')
        dst = ob.data.uv_layers.active.data
        for li in range(len(src)):
            dst[li].uv = src[li].uv
    for ob in sections + extras:
        ob.data.materials.clear()
        ob.data.materials.append(fin)
    rad = C.join(sections + extras, 'radiator')
    return [rad]
