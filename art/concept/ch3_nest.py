"""Chapter 3: The Nest. Shot A: flooded maintenance tunnel. Shot B: the monster's den in the boiler room."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mlib import *
from mlib import _mat


def water_mat(name='water', murk=(0.55, 0.6, 0.5), density=0.35, rough=0.035):
    m, nt, n, l, p = _mat(name)
    p.inputs['Base Color'].default_value = (1, 1, 1, 1)
    p.inputs['Transmission Weight'].default_value = 1.0
    p.inputs['IOR'].default_value = 1.333
    p.inputs['Roughness'].default_value = rough
    tc = node(n, 'ShaderNodeTexCoord')
    nz = node(n, 'ShaderNodeTexNoise', Scale=6.0, Detail=4.0)
    l.new(tc.outputs['Object'], nz.inputs['Vector'])
    b = node(n, 'ShaderNodeBump', Strength=0.06, Distance=0.02)
    l.new(nz.outputs['Fac'], b.inputs['Height'])
    l.new(b.outputs['Normal'], p.inputs['Normal'])
    v = node(n, 'ShaderNodeVolumePrincipled', Density=density, Anisotropy=0.2)
    v.inputs['Color'].default_value = (*murk, 1)
    v.inputs['Absorption Color'].default_value = (0.12, 0.15, 0.08, 1)
    l.new(v.outputs['Volume'], n['Material Output'].inputs['Volume'])
    return shadow_pass(m)


def water_block(name, x0, x1, y0, y1, z0, z1, mat, res=0.08, disp=None):
    nx, ny = max(2, int((x1 - x0) / res)), max(2, int((y1 - y0) / res))
    # simpler: build top grid only and solidify downward
    bm = bmesh.new()
    grid = []
    for j in range(ny + 1):
        row = []
        for i in range(nx + 1):
            x = x0 + (x1 - x0) * i / nx
            y = y0 + (y1 - y0) * j / ny
            row.append(bm.verts.new((x, y, z1 + (disp(x, y) if disp else 0.0))))
        grid.append(row)
    for j in range(ny):
        for i in range(nx):
            bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    o = mesh_obj(name, bm, mat, smooth=True)
    sd = o.modifiers.new('solid', 'SOLIDIFY')
    sd.thickness = z1 - z0
    sd.offset = -1.0
    sd.use_even_offset = False
    return o


def shot_tunnel():
    random.seed(11)
    reset(exposure=1.6)
    R, WALL, LEN = 2.6, 2.1, 70.0
    con = concrete('tunnel', base=(0.27, 0.27, 0.25), dark=(0.07, 0.075, 0.07), scale=0.5, wet=0.35, bump=0.5)
    rust = metal('pipe', amount=0.7, scale=1.5, rough=0.5)
    rust2 = metal('pipe2', paint=(0.12, 0.16, 0.12), amount=0.6, scale=2.0, rough=0.5)
    # horseshoe profile, extruded along +Y
    prof = [(-R, -1.0), (-R, WALL)]
    for i in range(1, 24):
        a = math.pi - math.pi * i / 24
        prof.append((R * math.cos(a), WALL + R * math.sin(a)))
    prof += [(R, WALL), (R, -1.0)]
    bm = bmesh.new()
    rings = []
    ys = [-6 + k * 1.0 for k in range(int(LEN) + 7)]
    for y in ys:
        rings.append([bm.verts.new((x, y, z)) for (x, z) in prof])
    for a, b in zip(rings, rings[1:]):
        for i in range(len(prof) - 1):
            bm.faces.new((a[i], a[i + 1], b[i + 1], b[i]))
    floor = [bm.verts.new((-R, -6, -1.0)), bm.verts.new((R, -6, -1.0)), bm.verts.new((R, ys[-1], -1.0)), bm.verts.new((-R, ys[-1], -1.0))]
    bm.faces.new(floor)
    t = mesh_obj('tunnel', bm, con, smooth=True)
    # ribs
    for y in range(-4, int(LEN), 4):
        pts = [(x * 0.97, y, z if z > WALL else z) for (x, z) in prof[1:-1]]
        curve_path('rib', [(p[0], p[1], p[2]) for p in pts], 0.16, con, res=4)
    # pipes along both walls, with brackets
    for (x, z, r, m) in ((-R + 0.35, 2.85, 0.22, rust), (-R + 0.3, 2.25, 0.12, rust2), (-R + 0.28, 1.75, 0.08, rust),
                         (R - 0.33, 2.6, 0.18, rust2), (R - 0.27, 1.9, 0.1, rust), (R - 0.6, 3.9, 0.06, rust)):
        curve_path('pipe', [(x, -6, z), (x, LEN, z)], r, m)
        for y in range(-4, int(LEN), 3):
            box('bracket', (0.05, 0.08, 2 * r + 0.08), (x, y + 0.5, z), mat=rust)
    # sagging cables
    cab = plain('cable', (0.02, 0.02, 0.02), 0.5, noise=0)
    for k in range(0, int(LEN), 6):
        curve_path('cable', [(-1.3, k, 4.45), (-1.25, k + 3, 4.05), (-1.2, k + 6, 4.45)], 0.02, cab)
        curve_path('cable', [(-0.9, k + 1, 4.6), (-0.85, k + 4, 4.3), (-0.8, k + 7, 4.6)], 0.015, cab)

    WATER = 1.1
    # the creature under the surface: head toward the camera, ~0.3 m down
    HY = 7.2

    def wake(x, y):
        d = y - HY
        z = 0.0
        if d > -0.6:
            lat = abs(x) - max(0.0, d) * math.tan(math.radians(20)) - 0.35
            amp = 0.045 * math.exp(-max(0.0, d) / 7.0)
            z += amp * math.exp(-(lat / 0.22) ** 2) * math.cos(max(0.0, d) * 3.0)
            z -= 0.025 * math.exp(-((x / 0.5) ** 2) - ((d - 0.6) / 1.0) ** 2)  # trough over the back
        z += 0.03 * math.exp(-(x / 0.6) ** 2 - ((y - HY + 0.55) / 0.35) ** 2)  # bow bulge
        return z

    wm = water_mat()
    water_block('water', -R + 0.01, R - 0.01, -6, LEN, -1.0, WATER, wm, res=0.06, disp=wake)
    mon, arm, body = monster('Run', 10, loc=(0.15, HY + 2.15, 0.9), rot=(math.radians(-84), 0, math.radians(180)))
    # floating junk
    wood = plain('wood', (0.16, 0.11, 0.07), 0.8, noise=0.4)
    for (x, y, yaw, L) in ((-1.4, 3.5, 0.4, 1.4), (1.5, 11.0, -0.9, 1.1), (-0.8, 15.0, 1.3, 0.9), (1.2, 22, 0.2, 1.6)):
        box('plank', (L, 0.2, 0.05), (x, y, WATER + 0.005), (0.02, 0.03, yaw), mat=wood)
    tape = plain('tape', (0.05, 0.05, 0.055), 0.4, noise=0.2)
    box('cassette', (0.1, 0.064, 0.012), (-0.6, 2.2, WATER + 0.003), (0, 0, 0.6), mat=tape)
    # lights: far caged work lamp, red emergency lamp, flashlight
    warm = emissive('worklamp', (1.0, 0.72, 0.4), 80.0)
    for (y, pw) in ((17.0, 160), (34.0, 260), (58.0, 140)):
        sphere('bulb', 0.07, (0.6, y, 4.35), mat=warm, sub=2)
        torus('cage', 0.11, 0.01, (0.6, y, 4.35), (0, 0, 0), mat=rust, seg=16, rseg=4)
        curve_path('cord', [(0.6, y, 4.42), (0.6, y, 4.75)], 0.008, cab)
        point('work', (0.6, y, 4.3), pw, color=(1.0, 0.7, 0.4), radius=0.06)
    sphere('red', 0.06, (R - 0.12, 14.0, 3.2), mat=emissive('redb', (1, 0.08, 0.03), 60), sub=2)
    point('redl', (R - 0.25, 14.0, 3.2), 18, color=(1.0, 0.1, 0.04))
    mist = fog('mist', 0.003, (0.82, 0.86, 0.88), 0.4, 0.6, 0.7, falloff=0.5)
    box('mistbox', (2 * R - 0.05, LEN + 6, 3.4), (0, LEN / 2 - 3, WATER + 1.7), mat=mist)
    cam = camera((0.45, -0.6, 1.62), (0.0, 9.0, 0.95), lens=22, roll_deg=2.0, dof=7.0, fstop=5.6)
    flashlight(cam, (0.1, 7.5, 1.0), power=650, angle=24, blend=0.6)
    render('ch3_nest_tunnel')


def fabric(name, colors, scale=4.0, rough=0.95):
    m, nt, n, l, p = _mat(name)
    tc = node(n, 'ShaderNodeTexCoord')
    nz = node(n, 'ShaderNodeTexNoise', Scale=scale, Detail=3.0)
    l.new(tc.outputs['Object'], nz.inputs['Vector'])
    stops = [(i / max(1, len(colors) - 1), (*c, 1)) for i, c in enumerate(colors)]
    r = ramp(n, stops, 'LINEAR')
    l.new(nz.outputs['Fac'], r.inputs['Fac'])
    fine = node(n, 'ShaderNodeTexNoise', Scale=140.0, Detail=2.0)
    l.new(tc.outputs['Object'], fine.inputs['Vector'])
    dirt = node(n, 'ShaderNodeTexNoise', Scale=1.5, Detail=6.0)
    l.new(tc.outputs['Object'], dirt.inputs['Vector'])
    dr = ramp(n, [(0.4, (1, 1, 1, 1)), (0.75, (0.35, 0.3, 0.22, 1))])
    l.new(dirt.outputs['Fac'], dr.inputs['Fac'])
    mx = node(n, 'ShaderNodeMix', _data_type='RGBA', _blend_type='MULTIPLY', Factor=1.0)
    l.new(r.outputs['Color'], mx.inputs[6])
    l.new(dr.outputs['Color'], mx.inputs[7])
    l.new(mx.outputs[2], p.inputs['Base Color'])
    p.inputs['Roughness'].default_value = rough
    p.inputs['Sheen Weight'].default_value = 0.4
    b = node(n, 'ShaderNodeBump', Strength=0.3, Distance=0.004)
    l.new(fine.outputs['Fac'], b.inputs['Height'])
    l.new(b.outputs['Normal'], p.inputs['Normal'])
    return m


def rag(name, size, loc, rot, mat, seed):
    """A crumpled piece of cloth: subdivided plane + noise displacement + bend."""
    rnd = random.Random(seed)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=14, y_segments=14, size=0.5)
    for v in bm.verts:
        v.co.x *= size[0]
        v.co.y *= size[1]
        v.co.z += 0.06 * math.sin(v.co.x * 9 + seed) * math.cos(v.co.y * 7 + seed * 0.5) + rnd.uniform(-0.01, 0.01)
    o = mesh_obj(name, bm, mat, smooth=True)
    sd = o.modifiers.new('solid', 'SOLIDIFY')
    sd.thickness = 0.008
    bd = o.modifiers.new('bend', 'SIMPLE_DEFORM')
    bd.deform_method = 'BEND'
    bd.angle = rnd.uniform(-1.2, 1.2)
    bd.deform_axis = 'X'
    o.location = loc
    o.rotation_euler = rot
    return o


def shot_den():
    random.seed(23)
    reset(exposure=1.8)
    con = concrete('room', base=(0.28, 0.27, 0.25), dark=(0.07, 0.07, 0.065), scale=0.5, wet=0.3)
    floor_m = concrete('floor', base=(0.22, 0.21, 0.2), dark=(0.06, 0.06, 0.055), scale=0.8, streaks=False, wet=0.5)
    rust = metal('rust', amount=0.75, scale=1.2)
    paint = metal('boiler', paint=(0.14, 0.2, 0.17), amount=0.55, scale=1.0)
    RX, RY, RZ = 8.0, 7.0, 6.5
    box('floor', (2 * RX, 2 * RY + 4, 0.2), (0, 0, -0.1), mat=floor_m)
    box('ceil', (2 * RX, 2 * RY + 4, 0.3), (0, 0, RZ + 0.15), mat=con)
    for (sx, sy, x, y) in ((0.4, 2 * RY + 4, RX, 0), (0.4, 2 * RY + 4, -RX, 0), (2 * RX, 0.4, 0, RY)):
        box('wall', (sx, sy, RZ), (x, y, RZ / 2), mat=con)
    # standing water on the floor
    puddle = _mat('puddle')[0]
    pn = puddle.node_tree.nodes['Principled BSDF']
    pn.inputs['Base Color'].default_value = (0.01, 0.012, 0.01, 1)
    pn.inputs['Roughness'].default_value = 0.04
    box('puddle', (2 * RX - 0.5, 2 * RY + 3, 0.02), (0, 0, 0.03), mat=puddle)
    # two big boilers on plinths along the back wall
    brick = concrete('plinth', base=(0.25, 0.12, 0.08), dark=(0.08, 0.04, 0.03), scale=2.0, streaks=False)
    for x in (-4.2, 3.6):
        box('plinth', (2.6, 5.6, 0.6), (x, RY - 2.4, 0.3), mat=brick)
        cyl('boiler', 1.25, 5.2, (x, RY - 2.4, 1.85), (math.radians(90), 0, 0), mat=paint, seg=40)
        for yy in (-2.0, -0.8, 0.4, 1.6):
            torus('band', 1.27, 0.035, (x, RY - 2.4 + yy, 1.85), (math.radians(90), 0, 0), mat=rust, seg=40, rseg=6)
        curve_path('flue', [(x, RY - 1.2, 3.0), (x, RY - 1.2, 4.6), (x + 0.6, RY - 0.6, RZ)], 0.28, rust)
        cyl('gauge', 0.13, 0.05, (x + 0.7, RY - 5.03, 2.2), (math.radians(90), 0, 0), mat=plain('dial', (0.75, 0.72, 0.6), 0.4, noise=0.2))
        sphere('pilot', 0.04, (x - 0.5, RY - 5.06, 0.95), mat=emissive('pilot', (0.2, 0.45, 1.0), 40), sub=2)
        point('pilotl', (x - 0.5, RY - 5.2, 0.95), 4, color=(0.25, 0.5, 1.0))
    for k in range(6):
        y = -RY + 1 + k * 2.2
        curve_path('cpipe', [(-RX + 0.3, y, RZ - 0.4), (RX - 0.3, y + 0.3, RZ - 0.45)], 0.07 + 0.03 * (k % 2), rust)

    # ---- the nest: a ring mound woven from torn coats, insulation and blankets
    C = Vector((0.2, 0.6, 0.0))
    coat = fabric('coat', [(0.55, 0.53, 0.48), (0.42, 0.4, 0.36), (0.6, 0.58, 0.52)], 3.0)
    insul = fabric('insul', [(0.5, 0.3, 0.26), (0.45, 0.36, 0.2), (0.35, 0.28, 0.22)], 6.0)
    blanket = fabric('blanket', [(0.16, 0.17, 0.2), (0.25, 0.14, 0.1), (0.2, 0.2, 0.17), (0.12, 0.13, 0.11)], 2.0)
    mound_m = fabric('mound', [(0.3, 0.28, 0.25), (0.2, 0.17, 0.14), (0.45, 0.43, 0.38), (0.28, 0.2, 0.17), (0.15, 0.15, 0.16)], 11.0)
    bm = bmesh.new()
    # torus-ish ring with noise
    segs, rsegs = 72, 18
    Rr, rr = 1.75, 0.75
    vs = []
    for i in range(segs):
        a = 2 * math.pi * i / segs
        ring = []
        for j in range(rsegs):
            b = 2 * math.pi * j / rsegs
            rad = rr * (1 + 0.25 * math.sin(a * 5 + 1.3) * math.cos(b * 2) + random.uniform(-0.06, 0.06))
            x = (Rr + rad * math.cos(b)) * math.cos(a) * 1.15
            y = (Rr + rad * math.cos(b)) * math.sin(a)
            z = max(0.02, rad * math.sin(b) * 0.55 + 0.12)
            ring.append(bm.verts.new((x, y, z)))
        vs.append(ring)
    for i in range(segs):
        for j in range(rsegs):
            bm.faces.new((vs[i][j], vs[(i + 1) % segs][j], vs[(i + 1) % segs][(j + 1) % rsegs], vs[i][(j + 1) % rsegs]))
    mound = mesh_obj('mound', bm, mound_m, smooth=True)
    mound.location = C
    tex = bpy.data.textures.new('clouds', 'CLOUDS')
    tex.noise_scale = 0.35
    dm = mound.modifiers.new('disp', 'DISPLACE')
    dm.texture = tex
    dm.strength = 0.25
    sub = mound.modifiers.new('sub', 'SUBSURF')
    sub.levels = 1
    sub.render_levels = 1
    # bedding inside the ring
    cyl('bed', 1.9, 0.25, C + Vector((0, 0, 0.12)), mat=blanket, seg=40)
    mats = [coat, coat, insul, blanket, blanket, coat]
    for k in range(70):
        a = random.uniform(0, 2 * math.pi)
        rr2 = random.uniform(1.8, 2.8)
        p = C + Vector((math.cos(a) * rr2 * 1.15, math.sin(a) * rr2, random.uniform(0.2, 0.7)))
        rag('rag', (random.uniform(0.5, 1.3), random.uniform(0.4, 1.0)), p,
            (random.uniform(-0.9, 0.9), random.uniform(-0.9, 0.9), random.uniform(0, 6.3)), random.choice(mats), k)
    # sleeping monster curled up in the middle
    mon, arm, body = monster('Feed', 30, loc=C + Vector((0.55, -0.1, 0.32)), rot=(0, math.radians(84), math.radians(-60)))
    # recorders and boomboxes around the nest (its bait)
    silver = plain('silver', (0.35, 0.35, 0.36), 0.35, metallic=0.6, noise=0.3)
    blackp = plain('blackp', (0.02, 0.02, 0.022), 0.45, noise=0.3)
    grill = metal('grill2', steel=(0.16, 0.16, 0.16), amount=0.2, scale=8, rough=0.4)
    red_led = emissive('led', (1.0, 0.05, 0.02), 30)
    def recorder(loc, yaw, big=False):
        if big:
            parts = [box('bb', (0.62, 0.17, 0.3), (0, 0, 0.15), mat=blackp, bevel=0.015)]
            for x in (-0.19, 0.19):
                parts.append(cyl('spk', 0.1, 0.02, (x, -0.086, 0.14), (math.radians(90), 0, 0), mat=grill, seg=20))
            parts.append(box('deck', (0.16, 0.01, 0.09), (0, -0.086, 0.16), mat=silver))
            parts.append(tube_between('handle', (-0.24, 0, 0.31), (0.24, 0, 0.31), 0.012, silver))
        else:
            parts = [box('rec', (0.27, 0.16, 0.065), (0, 0, 0.033), mat=silver, bevel=0.008)]
            parts.append(box('win', (0.11, 0.07, 0.004), (0.04, 0.0, 0.067), mat=blackp))
            parts.append(cyl('rspk', 0.04, 0.004, (-0.08, 0.0, 0.067), mat=grill, seg=16))
            for i in range(5):
                box('key', (0.025, 0.02, 0.012), (0.0 + i * 0.03 - 0.06, 0.07, 0.07), mat=blackp)
        led = sphere('led', 0.005, (0.1 if not big else 0.25, -0.08, 0.06 if not big else 0.27), mat=red_led, sub=1)
        for o in parts:
            if o.modifiers:
                apply_mods(o)
        o = join(parts + [led], 'recorder')
        o.location = loc
        o.rotation_euler = (random.uniform(-0.15, 0.15), random.uniform(-0.15, 0.15), yaw)
        return o
    for k in range(34):
        a = random.uniform(0, 2 * math.pi)
        rr2 = random.uniform(2.9, 4.2)
        recorder(C + Vector((math.cos(a) * rr2 * 1.1, math.sin(a) * rr2, 0.04)), random.uniform(0, 6.3), big=(k % 6 == 0))
    for k in range(6):
        a = random.uniform(0, 2 * math.pi)
        recorder(C + Vector((math.cos(a) * 1.9 * 1.1, math.sin(a) * 1.9, 0.95)), random.uniform(0, 6.3))
    # kids' backpacks and toys, faded
    for k, colr in enumerate(((0.4, 0.06, 0.05), (0.06, 0.12, 0.35), (0.42, 0.33, 0.05), (0.2, 0.08, 0.14), (0.1, 0.25, 0.12))):
        a = 0.3 + k * 0.75
        p = C + Vector((math.cos(a) * 3.2 * 1.1, math.sin(a) * 3.2, 0.2))
        bag = fabric(f'bag{k}', [colr, tuple(c * 0.7 for c in colr)], 8.0, rough=0.8)
        b = box('pack', (0.32, 0.18, 0.4), p, (random.uniform(-1.2, 1.2), 0.2, random.uniform(0, 6)), mat=bag, bevel=0.06)
        box('pocket', (0.24, 0.06, 0.18), p + Vector((0, -0.1, -0.06)), b.rotation_euler, mat=bag, bevel=0.03)
    roots, new = import_glb('dressing_toys')
    for o in roots:
        o.location = C + Vector((-2.9, -1.6, 0.03))
        o.rotation_euler = (0, 0, 0.7)
        o.scale = (1.3, 1.3, 1.3)
    # the override keycard on a crate beside its head
    roots, new = import_glb('furniture_crate_small')
    K = C + Vector((2.25, -1.55, 0.0))
    for o in roots:
        o.location = K
        o.rotation_euler = (0, 0, 0.35)
    card_m = plain('card', (0.85, 0.85, 0.8), 0.3, noise=0.1)
    card = box('card', (0.086, 0.054, 0.003), K + Vector((0.02, -0.05, 0.605)), (0, 0, 0.6), mat=card_m)
    box('stripe', (0.086, 0.012, 0.001), K + Vector((0.02, -0.05, 0.6075)), (0, 0, 0.6), mat=emissive('cardglow', (0.2, 0.85, 1.0), 25))
    lan = plain('lanyard', (0.45, 0.05, 0.04), 0.7, noise=0.2)
    curve_path('lanyard', [K + Vector((0.05, -0.08, 0.607)), K + Vector((0.22, -0.2, 0.62)), K + Vector((0.31, -0.32, 0.4)), K + Vector((0.3, -0.36, 0.05))], 0.006, lan)
    point('cardl', K + Vector((0.02, -0.08, 0.66)), 0.6, color=(0.2, 0.8, 1.0), radius=0.02)
    # hanging bulb above the nest
    bulb = emissive('bulb', (1.0, 0.68, 0.38), 30.0)
    B = C + Vector((-0.6, 0.4, 3.9))
    sphere('bulb', 0.06, B, mat=bulb, sub=2)
    curve_path('cord', [B, B + Vector((0.05, 0.0, RZ - B.z))], 0.006, plain('cord', (0.02, 0.02, 0.02), 0.5, noise=0))
    point('bulbl', B - Vector((0, 0, 0.05)), 70, color=(1.0, 0.66, 0.36), radius=0.05)
    sphere('red', 0.06, (-RX + 0.3, -2.0, 3.0), mat=emissive('redb', (1, 0.08, 0.03), 60), sub=2)
    point('redl', (-RX + 0.5, -2.0, 3.0), 25, color=(1.0, 0.1, 0.04))
    box('haze', (2 * RX, 2 * RY + 4, RZ), (0, 0, RZ / 2), mat=fog('haze', 0.012, (0.85, 0.85, 0.85), 0.4, 0.5, 0.5))
    cam = camera((-4.2, -5.6, 2.2), (0.9, 0.4, 0.35), lens=28, dof=7.0, fstop=5.6)
    flashlight(cam, (1.0, 0.2, 0.4), power=260, angle=30, blend=0.6)
    render('ch3_nest_den')


if want('A'):
    shot_tunnel()
if want('B'):
    shot_den()
