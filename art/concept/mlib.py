"""Shared helpers for the map concept renders (Cycles, CPU)."""
import bpy, bmesh, math, random, os, sys
from mathutils import Vector, Euler, Matrix

MODELS = '/home/user/Ai-vr-game/public/models'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'docs', 'concept', 'raw')
os.makedirs(OUT, exist_ok=True)

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
PREVIEW = 'preview' in ARGS
ONLY = [a for a in ARGS if a not in ('preview',)]


def reset(exposure=0.0, samples=128):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    c = s.cycles
    c.device = 'CPU'
    c.samples = 24 if PREVIEW else samples
    c.use_adaptive_sampling = True
    c.adaptive_threshold = 0.02
    c.use_denoising = True
    c.denoiser = 'OPENIMAGEDENOISE'
    c.max_bounces = 6
    c.diffuse_bounces = 2
    c.glossy_bounces = 3
    c.transmission_bounces = 6
    c.volume_bounces = 0
    c.transparent_max_bounces = 8
    c.volume_step_rate = 4.0 if PREVIEW else 2.0
    c.volume_max_steps = 256
    c.caustics_reflective = False
    c.caustics_refractive = False
    c.blur_glossy = 1.0
    s.render.resolution_x = 960 if PREVIEW else 1920
    s.render.resolution_y = 540 if PREVIEW else 1080
    s.render.resolution_percentage = 100
    s.render.film_transparent = False
    s.view_settings.view_transform = 'AgX'
    try:
        s.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
    s.view_settings.exposure = exposure
    w = bpy.data.worlds.new('world')
    s.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.0, 0.0, 0.0, 1)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.0
    return s


# ---------------------------------------------------------------- materials

def _mat(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    return m, nt, nt.nodes, nt.links, nt.nodes['Principled BSDF']


def node(nodes, kind, **inputs):
    n = nodes.new(kind)
    for k, v in inputs.items():
        if k.startswith('_'):
            setattr(n, k[1:], v)
        else:
            n.inputs[k].default_value = v
    return n


def ramp(nodes, stops, interp='LINEAR'):
    r = nodes.new('ShaderNodeValToRGB')
    r.color_ramp.interpolation = interp
    el = r.color_ramp.elements
    while len(el) > 2:
        el.remove(el[-1])
    for i, (pos, col) in enumerate(stops):
        e = el[i] if i < 2 else el.new(pos)
        e.position = pos
        e.color = col if len(col) == 4 else (*col, 1)
    return r


def concrete(name='concrete', base=(0.32, 0.31, 0.29), dark=(0.12, 0.115, 0.11), scale=1.0,
             streaks=True, rough=0.88, grime=0.6, bump=0.35, wet=0.0):
    """Stained concrete: big blotches, vertical water streaks, AO grime, pitted bump."""
    m, nt, n, l, p = _mat(name)
    tc = node(n, 'ShaderNodeTexCoord')
    mp = node(n, 'ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (scale, scale, scale)
    l.new(tc.outputs['Object'], mp.inputs['Vector'])
    big = node(n, 'ShaderNodeTexNoise', Scale=0.6, Detail=6.0, Roughness=0.6)
    l.new(mp.outputs['Vector'], big.inputs['Vector'])
    fine = node(n, 'ShaderNodeTexNoise', Scale=18.0, Detail=8.0, Roughness=0.7)
    l.new(mp.outputs['Vector'], fine.inputs['Vector'])
    r1 = ramp(n, [(0.35, (*dark, 1)), (0.7, (*base, 1))])
    l.new(big.outputs['Fac'], r1.inputs['Fac'])
    col = r1.outputs['Color']
    if streaks:
        smp = node(n, 'ShaderNodeMapping')
        smp.inputs['Scale'].default_value = (3.0 * scale, 3.0 * scale, 0.12 * scale)
        l.new(tc.outputs['Object'], smp.inputs['Vector'])
        st = node(n, 'ShaderNodeTexNoise', Scale=2.0, Detail=4.0)
        l.new(smp.outputs['Vector'], st.inputs['Vector'])
        sr = ramp(n, [(0.45, (1, 1, 1, 1)), (0.75, (0.45, 0.42, 0.38, 1))])
        l.new(st.outputs['Fac'], sr.inputs['Fac'])
        mx = node(n, 'ShaderNodeMix', _data_type='RGBA', _blend_type='MULTIPLY', Factor=1.0)
        l.new(col, mx.inputs[6])
        l.new(sr.outputs['Color'], mx.inputs[7])
        col = mx.outputs[2]
    # fine speckle
    mx2 = node(n, 'ShaderNodeMix', _data_type='RGBA', _blend_type='OVERLAY', Factor=0.35)
    l.new(col, mx2.inputs[6])
    l.new(fine.outputs['Color'], mx2.inputs[7])
    col = mx2.outputs[2]
    if grime > 0:
        ao = node(n, 'ShaderNodeAmbientOcclusion', Distance=0.6)
        ao.samples = 8
        gr = ramp(n, [(0.0, (0.15, 0.13, 0.11, 1)), (1.0, (1, 1, 1, 1))])
        l.new(ao.outputs['AO'], gr.inputs['Fac'])
        mx3 = node(n, 'ShaderNodeMix', _data_type='RGBA', _blend_type='MULTIPLY', Factor=grime)
        l.new(col, mx3.inputs[6])
        l.new(gr.outputs['Color'], mx3.inputs[7])
        col = mx3.outputs[2]
    l.new(col, p.inputs['Base Color'])
    rr = node(n, 'ShaderNodeMapRange', **{'To Min': rough - 0.15 - wet, 'To Max': rough - wet * 0.5})
    l.new(big.outputs['Fac'], rr.inputs['Value'])
    l.new(rr.outputs['Result'], p.inputs['Roughness'])
    b = node(n, 'ShaderNodeBump', Strength=bump, Distance=0.02)
    l.new(fine.outputs['Fac'], b.inputs['Height'])
    l.new(b.outputs['Normal'], p.inputs['Normal'])
    return m


def metal(name='metal', steel=(0.22, 0.22, 0.23), rust=(0.24, 0.09, 0.035), amount=0.5, scale=3.0,
          rough=0.45, paint=None):
    """Steel (or painted steel) eaten by rust patches."""
    m, nt, n, l, p = _mat(name)
    tc = node(n, 'ShaderNodeTexCoord')
    mp = node(n, 'ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (scale, scale, scale)
    l.new(tc.outputs['Object'], mp.inputs['Vector'])
    nz = node(n, 'ShaderNodeTexNoise', Scale=2.5, Detail=10.0, Roughness=0.65)
    l.new(mp.outputs['Vector'], nz.inputs['Vector'])
    t0 = 1.0 - amount
    fac = ramp(n, [(max(0, t0 - 0.06), (0, 0, 0, 1)), (min(1, t0 + 0.06), (1, 1, 1, 1))])
    l.new(nz.outputs['Fac'], fac.inputs['Fac'])
    rc = ramp(n, [(0.3, (rust[0] * 0.5, rust[1] * 0.5, rust[2] * 0.5, 1)), (0.7, (*rust, 1))])
    l.new(nz.outputs['Color'], rc.inputs['Fac'])
    top = paint or steel
    mx = node(n, 'ShaderNodeMix', _data_type='RGBA')
    l.new(fac.outputs['Color'], mx.inputs['Factor'])
    mx.inputs[6].default_value = (*top, 1)
    l.new(rc.outputs['Color'], mx.inputs[7])
    l.new(mx.outputs[2], p.inputs['Base Color'])
    met = node(n, 'ShaderNodeMath', _operation='SUBTRACT', Value=0.0 if paint else 1.0)
    met.inputs[0].default_value = 0.0 if paint else 1.0
    met.inputs[1].default_value = 0.0
    inv = node(n, 'ShaderNodeMath', _operation='MULTIPLY')
    l.new(fac.outputs['Color'], inv.inputs[0])
    inv.inputs[1].default_value = -1.0
    add = node(n, 'ShaderNodeMath', _operation='ADD')
    l.new(inv.outputs[0], add.inputs[0])
    add.inputs[1].default_value = 1.0
    if not paint:
        l.new(add.outputs[0], p.inputs['Metallic'])
    rr = node(n, 'ShaderNodeMapRange', **{'To Min': rough, 'To Max': 0.95})
    l.new(fac.outputs['Color'], rr.inputs['Value'])
    l.new(rr.outputs['Result'], p.inputs['Roughness'])
    b = node(n, 'ShaderNodeBump', Strength=0.25, Distance=0.01)
    l.new(fac.outputs['Color'], b.inputs['Height'])
    l.new(b.outputs['Normal'], p.inputs['Normal'])
    return m


def plain(name, color, rough=0.7, metallic=0.0, spec=0.5, noise=0.25, scale=8.0, bump=0.1):
    m, nt, n, l, p = _mat(name)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metallic
    p.inputs['Specular IOR Level'].default_value = spec
    if noise > 0:
        tc = node(n, 'ShaderNodeTexCoord')
        nz = node(n, 'ShaderNodeTexNoise', Scale=scale, Detail=6.0)
        l.new(tc.outputs['Object'], nz.inputs['Vector'])
        mx = node(n, 'ShaderNodeMix', _data_type='RGBA', _blend_type='MULTIPLY', Factor=noise)
        mx.inputs[6].default_value = (*color, 1)
        r = ramp(n, [(0.3, (0.45, 0.45, 0.45, 1)), (0.7, (1, 1, 1, 1))])
        l.new(nz.outputs['Fac'], r.inputs['Fac'])
        l.new(r.outputs['Color'], mx.inputs[7])
        l.new(mx.outputs[2], p.inputs['Base Color'])
        if bump:
            b = node(n, 'ShaderNodeBump', Strength=bump, Distance=0.01)
            l.new(nz.outputs['Fac'], b.inputs['Height'])
            l.new(b.outputs['Normal'], p.inputs['Normal'])
    else:
        p.inputs['Base Color'].default_value = (*color, 1)
    return m


def emissive(name, color, strength):
    m, nt, n, l, p = _mat(name)
    p.inputs['Base Color'].default_value = (0, 0, 0, 1)
    p.inputs['Emission Color'].default_value = (*color, 1)
    p.inputs['Emission Strength'].default_value = strength
    return m


def glass(name='glass', rough=0.04, tint=(0.9, 0.95, 0.92), ior=1.5):
    m, nt, n, l, p = _mat(name)
    p.inputs['Base Color'].default_value = (*tint, 1)
    p.inputs['Transmission Weight'].default_value = 1.0
    p.inputs['Roughness'].default_value = rough
    p.inputs['IOR'].default_value = ior
    return m


def fog(name='fog', density=0.02, color=(0.8, 0.82, 0.85), aniso=0.35, noise_scale=0.0, noise_amt=0.0,
        floor_z=None, falloff=0.0):
    """Volume-only material. Optional noise breakup and a height falloff (denser low down)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    n, l = nt.nodes, nt.links
    n.remove(n['Principled BSDF'])
    out = n['Material Output']
    v = node(n, 'ShaderNodeVolumePrincipled', Density=density, Anisotropy=aniso)
    v.inputs['Color'].default_value = (*color, 1)
    dens = None
    if noise_amt > 0 or falloff > 0:
        tc = node(n, 'ShaderNodeTexCoord')
        sep = node(n, 'ShaderNodeSeparateXYZ')
        l.new(tc.outputs['Object'], sep.inputs['Vector'])
        val = node(n, 'ShaderNodeValue')
        val.outputs[0].default_value = density
        dens = val.outputs[0]
        if noise_amt > 0:
            nz = node(n, 'ShaderNodeTexNoise', Scale=noise_scale, Detail=3.0)
            l.new(tc.outputs['Object'], nz.inputs['Vector'])
            mr = node(n, 'ShaderNodeMapRange', **{'From Min': 0.35, 'From Max': 0.7, 'To Min': 1 - noise_amt, 'To Max': 1 + noise_amt})
            l.new(nz.outputs['Fac'], mr.inputs['Value'])
            mul = node(n, 'ShaderNodeMath', _operation='MULTIPLY')
            l.new(dens, mul.inputs[0])
            l.new(mr.outputs['Result'], mul.inputs[1])
            dens = mul.outputs[0]
        if falloff > 0:
            # density *= exp(-falloff * (z - floor)) in object space
            sub = node(n, 'ShaderNodeMath', _operation='MULTIPLY')
            l.new(sep.outputs['Z'], sub.inputs[0])
            sub.inputs[1].default_value = -falloff
            ex = node(n, 'ShaderNodeMath', _operation='EXPONENT')
            l.new(sub.outputs[0], ex.inputs[0])
            mul2 = node(n, 'ShaderNodeMath', _operation='MULTIPLY')
            l.new(dens, mul2.inputs[0])
            l.new(ex.outputs[0], mul2.inputs[1])
            dens = mul2.outputs[0]
        l.new(dens, v.inputs['Density'])
    l.new(v.outputs['Volume'], out.inputs['Volume'])
    return m


# ---------------------------------------------------------------- geometry

COL = None


def link(o):
    bpy.context.scene.collection.objects.link(o)
    return o


def mesh_obj(name, bm, mat=None, smooth=False):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        for poly in me.polygons:
            poly.use_smooth = True
    o = bpy.data.objects.new(name, me)
    if mat:
        me.materials.append(mat)
    return link(o)


def box(name, size, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, bevel=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    o = mesh_obj(name, bm, mat)
    o.location = loc
    o.rotation_euler = rot
    if bevel > 0:
        md = o.modifiers.new('bev', 'BEVEL')
        md.width = bevel
        md.segments = 2
        md.limit_method = 'ANGLE'
    return o


def cyl(name, r, depth, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, seg=24, r2=None, smooth=True, caps=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=seg, radius1=r,
                          radius2=r if r2 is None else r2, depth=depth)
    o = mesh_obj(name, bm, mat, smooth)
    if smooth:
        o.data.shade_smooth()
        try:
            o.modifiers.new('as', 'NODES')
            o.modifiers.remove(o.modifiers['as'])
        except Exception:
            pass
    o.location = loc
    o.rotation_euler = rot
    return o


def sphere(name, r, loc=(0, 0, 0), mat=None, sub=3, scale=(1, 1, 1)):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    o = mesh_obj(name, bm, mat, True)
    o.location = loc
    o.scale = scale
    return o


def torus(name, R, r, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, seg=48, rseg=12):
    bm = bmesh.new()
    verts = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        ring = []
        for j in range(rseg):
            b = 2 * math.pi * j / rseg
            x = (R + r * math.cos(b)) * math.cos(a)
            y = (R + r * math.cos(b)) * math.sin(a)
            z = r * math.sin(b)
            ring.append(bm.verts.new((x, y, z)))
        verts.append(ring)
    for i in range(seg):
        for j in range(rseg):
            bm.faces.new((verts[i][j], verts[(i + 1) % seg][j], verts[(i + 1) % seg][(j + 1) % rseg], verts[i][(j + 1) % rseg]))
    o = mesh_obj(name, bm, mat, True)
    o.location = loc
    o.rotation_euler = rot
    return o


def tube_between(name, a, b, r, mat=None, seg=12):
    a, b = Vector(a), Vector(b)
    d = b - a
    o = cyl(name, r, d.length, loc=(a + b) / 2, mat=mat, seg=seg)
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = d.to_track_quat('Z', 'Y')
    return o


def inst(src, name, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    o = src.copy()
    o.name = name
    o.location = loc
    o.rotation_euler = rot
    o.scale = scale
    o.hide_render = False
    return link(o)


def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    objs[0].name = name
    return objs[0]


def apply_mods(o):
    bpy.context.view_layer.objects.active = o
    for md in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=md.name)


def import_glb(name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=f'{MODELS}/{name}.glb')
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        if o.name.startswith('Icosphere'):
            bpy.data.objects.remove(o)
    new = [o for o in bpy.data.objects if o not in before]
    roots = [o for o in new if o.parent is None]
    return roots, new


def text(name, body, size, loc, rot, mat, extrude=0.0, align='CENTER'):
    cu = bpy.data.curves.new(name, 'FONT')
    cu.body = body
    cu.size = size
    cu.extrude = extrude
    cu.align_x = align
    cu.align_y = 'CENTER'
    o = bpy.data.objects.new(name, cu)
    o.data.materials.append(mat)
    o.location = loc
    o.rotation_euler = rot
    return link(o)


# ---------------------------------------------------------------- lights & camera

def spot(name, loc, target, power, angle_deg, blend=0.4, color=(1, 1, 1), radius=0.03):
    ld = bpy.data.lights.new(name, 'SPOT')
    ld.energy = power
    ld.spot_size = math.radians(angle_deg)
    ld.spot_blend = blend
    ld.color = color
    ld.shadow_soft_size = radius
    o = bpy.data.objects.new(name, ld)
    link(o)
    o.location = loc
    aim(o, target)
    return o


def point(name, loc, power, color=(1, 1, 1), radius=0.05):
    ld = bpy.data.lights.new(name, 'POINT')
    ld.energy = power
    ld.color = color
    ld.shadow_soft_size = radius
    o = bpy.data.objects.new(name, ld)
    o.location = loc
    return link(o)


def area(name, loc, target, power, size=1.0, color=(1, 1, 1), shape='SQUARE', size_y=None):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.energy = power
    ld.size = size
    ld.color = color
    if size_y:
        ld.shape = 'RECTANGLE'
        ld.size_y = size_y
    o = bpy.data.objects.new(name, ld)
    link(o)
    o.location = loc
    aim(o, target)
    return o


def aim(o, target):
    d = Vector(target) - Vector(o.location)
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = d.to_track_quat('-Z', 'Y')


def camera(loc, target, lens=28, roll_deg=0.0, dof=None, fstop=2.8, name='cam'):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.sensor_width = 36
    cd.clip_start = 0.02
    cd.clip_end = 400
    o = bpy.data.objects.new(name, cd)
    link(o)
    o.location = loc
    aim(o, target)
    if roll_deg:
        o.rotation_quaternion = o.rotation_quaternion @ Euler((0, 0, math.radians(roll_deg))).to_quaternion()
    if dof is not None:
        cd.dof.use_dof = True
        cd.dof.focus_distance = dof
        cd.dof.aperture_fstop = fstop
    bpy.context.scene.camera = o
    return o


def flashlight(cam_or_loc, target, power=60, angle=34, blend=0.55, offset=(0.18, -0.12, 0.05)):
    """A hand flashlight just below/right of the camera, warm-white LED-ish beam."""
    if hasattr(cam_or_loc, 'matrix_world'):
        bpy.context.view_layer.update()
        mw = cam_or_loc.matrix_world
        loc = mw @ Vector((offset[0], offset[1], -offset[2]))
    else:
        loc = Vector(cam_or_loc)
    return spot('flashlight', loc, target, power, angle, blend, color=(1.0, 0.93, 0.82), radius=0.02)


# ---------------------------------------------------------------- monster

def monster(action='Idle', frame=10, loc=(0, 0, 0), rot=(0, 0, 0), scale=1.0, wet=0.6, pose=None):
    roots, new = import_glb('monster')
    arm = [o for o in new if o.type == 'ARMATURE'][0]
    body = [o for o in new if o.type == 'MESH'][0]
    # COLOR_0 holds shader masks (R thinness, G wetness, B cavity): unhook it from base colour and
    # use it the way the game shader does.
    for mat in body.data.materials:
        nt = mat.node_tree
        n, l = nt.nodes, nt.links
        p = n['Principled BSDF']
        tex = n['Image Texture']
        vc = n['Color Attribute']
        for lk in list(p.inputs['Base Color'].links) + list(p.inputs['Metallic'].links):
            l.remove(lk)
        p.inputs['Metallic'].default_value = 0.0
        sep = n.new('ShaderNodeSeparateColor')
        l.new(vc.outputs['Color'], sep.inputs['Color'])
        if mat.name.startswith('monster_skin'):
            # cavity darkening
            l.new(tex.outputs['Color'], p.inputs['Base Color'])
            p.inputs['Subsurface Weight'].default_value = 0.25
            p.inputs['Subsurface Radius'].default_value = (0.9, 0.35, 0.25)
            p.inputs['Subsurface Scale'].default_value = 0.03
            # wet sheen as a clear coat driven by the wetness mask
            cw = n.new('ShaderNodeMath')
            cw.operation = 'MULTIPLY'
            l.new(sep.outputs['Green'], cw.inputs[0])
            cw.inputs[1].default_value = wet
            l.new(cw.outputs[0], p.inputs['Coat Weight'])
            p.inputs['Coat Roughness'].default_value = 0.12
        else:
            l.new(tex.outputs['Color'], p.inputs['Base Color'])
    ad = arm.animation_data or arm.animation_data_create()
    if action:
        act = bpy.data.actions[action]
        ad.action = act
        try:
            if ad.action_slot is None and len(act.slots):
                ad.action_slot = act.slots[0]
        except AttributeError:
            pass
    root = roots[0]
    root.location = loc
    root.rotation_mode = 'XYZ'  # glTF import leaves quaternion mode on (rotation_euler would be ignored)
    root.rotation_euler = rot
    root.scale = (scale, scale, scale)
    bpy.context.scene.frame_set(frame)
    bake = True
    if bake:
        # bake the action pose into the pose bones, then add manual tweaks on top
        bpy.context.view_layer.update()
        mats = {pb.name: pb.matrix_basis.copy() for pb in arm.pose.bones}
        ad.action = None
        for pb in arm.pose.bones:
            pb.matrix_basis = mats[pb.name]
        for bone, eul in (pose or {}).items():
            pb = arm.pose.bones[bone]
            pb.rotation_mode = 'XYZ' if pb.rotation_mode == 'QUATERNION' else pb.rotation_mode
            q = pb.matrix_basis.to_quaternion() @ Euler([math.radians(a) for a in eul]).to_quaternion()
            pb.rotation_mode = 'QUATERNION'
            pb.rotation_quaternion = q
    return root, arm, body


def person(name, loc, yaw=0.0, mat=None, skin=None, scale=1.0, arm_fwd=True):
    """Simple human silhouette (for distant players)."""
    mat = mat or plain(name + '_jacket', (0.05, 0.055, 0.06), 0.8)
    skin = skin or plain(name + '_skin', (0.5, 0.36, 0.3), 0.6, noise=0)
    parts = []
    parts.append(cyl(name + 'legL', 0.075, 0.85, (-0.1, 0, 0.43), mat=mat, seg=10))
    parts.append(cyl(name + 'legR', 0.075, 0.85, (0.1, 0, 0.43), mat=mat, seg=10))
    parts.append(cyl(name + 'torso', 0.19, 0.62, (0, 0, 1.15), mat=mat, seg=14, r2=0.21))
    parts.append(sphere(name + 'head', 0.11, (0, 0, 1.6), mat=skin, sub=2, scale=(0.9, 1, 1.1)))
    parts.append(sphere(name + 'hood', 0.125, (0, 0.02, 1.62), mat=mat, sub=2))
    if arm_fwd:
        parts.append(tube_between(name + 'armR', (0.24, 0, 1.4), (0.22, -0.45, 1.25), 0.055, mat))
    else:
        parts.append(tube_between(name + 'armR', (0.24, 0, 1.4), (0.27, 0, 0.85), 0.055, mat))
    parts.append(tube_between(name + 'armL', (-0.24, 0, 1.4), (-0.27, -0.05, 0.85), 0.055, mat))
    for o in parts:
        apply_mods(o) if o.modifiers else None
    o = join(parts, name)
    o.data.shade_smooth()
    o.location = loc
    o.rotation_euler = (0, 0, yaw)
    o.scale = (scale,) * 3
    return o


def render(name):
    s = bpy.context.scene
    path = os.path.join(OUT, f"{name}{'_prev' if PREVIEW else ''}.png")
    s.render.filepath = path
    s.render.image_settings.file_format = 'PNG'
    import time
    t = time.time()
    bpy.ops.render.render(write_still=True)
    print(f'RENDERED {path} in {time.time() - t:.0f}s', flush=True)


def want(shot):
    return not ONLY or shot in ONLY


def curve_path(name, pts, r, mat, res=12, closed=False):
    """A tube along a poly path (pipes, cables, cords). pts: list of (x, y, z)."""
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = r
    cu.bevel_resolution = 3
    cu.resolution_u = res
    sp = cu.splines.new('NURBS' if len(pts) > 2 else 'POLY')
    sp.points.add(len(pts) - 1)
    for p, q in zip(sp.points, pts):
        p.co = (*q, 1.0)
    if len(pts) > 2:
        sp.use_endpoint_u = True
        sp.order_u = 3
    sp.use_cyclic_u = closed
    cu.use_fill_caps = True
    o = bpy.data.objects.new(name, cu)
    o.data.materials.append(mat)
    return link(o)


def speaker_template(cab_m, cone_m, grill_m, steel_m, name='speaker_src', w=0.75, d=0.55, h=1.0, bracket=True):
    parts = [box('cab', (w, d, h), (0, 0, 0), mat=cab_m, bevel=0.02)]
    for z, r in ((-0.2 * h, 0.35 * w), (0.28 * h, 0.17 * w)):
        parts.append(cyl('cone', r, 0.06, (0, -d / 2, z), (math.radians(90), 0, 0), mat=cone_m, seg=28, r2=r * 0.35))
        parts.append(torus('surround', r, 0.02, (0, -d / 2, z), (math.radians(90), 0, 0), mat=grill_m, seg=28, rseg=6))
        parts.append(sphere('cap', r * 0.25, (0, -d / 2 + 0.03, z), mat=cone_m, sub=2, scale=(1, 0.4, 1)))
    parts.append(box('eye', (0.09, 0.03, 0.06), (0.33 * w, -d / 2, 0.42 * h), mat=grill_m))
    if bracket:
        parts.append(box('bracket', (0.08, 0.08, 0.25), (0, 0, h / 2 + 0.12), mat=steel_m))
    for o in parts:
        if o.modifiers:
            apply_mods(o)
    t = join(parts, name)
    t.hide_render = True
    t.location = (0, 0, -500)
    return t


def shadow_pass(mat):
    """Let lights through a transmissive surface for shadow rays (fake refraction caustics)."""
    nt = mat.node_tree
    n, l = nt.nodes, nt.links
    out = n['Material Output']
    surf = out.inputs['Surface'].links[0].from_socket
    lp = n.new('ShaderNodeLightPath')
    tr = n.new('ShaderNodeBsdfTransparent')
    mx = n.new('ShaderNodeMixShader')
    l.new(lp.outputs['Is Shadow Ray'], mx.inputs['Fac'])
    l.new(surf, mx.inputs[1])
    l.new(tr.outputs['BSDF'], mx.inputs[2])
    l.new(mx.outputs['Shader'], out.inputs['Surface'])
    return mat


def scatter_dust(name, center, size, count, mat, r=0.006, seed=1):
    """Floating dust specks (tiny spheres) for the flashlight to catch."""
    rnd = random.Random(seed)
    bm = bmesh.new()
    for _ in range(count):
        c = Vector((center[0] + rnd.uniform(-size[0], size[0]) / 2, center[1] + rnd.uniform(-size[1], size[1]) / 2,
                    center[2] + rnd.uniform(-size[2], size[2]) / 2))
        g = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=r * rnd.uniform(0.5, 1.5))
        bmesh.ops.translate(bm, vec=c, verts=g['verts'])
    return mesh_obj(name, bm, mat)
