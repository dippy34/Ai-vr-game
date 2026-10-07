"""Chapter 4: The Quiet Room. Shot A: the vault door seen from the control room. Shot B: the Feedback boss fight."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mlib import *
from mlib import _mat


def stripes(name, a=(0.42, 0.3, 0.02), b=(0.02, 0.02, 0.02), scale=1.6):
    m, nt, n, l, p = _mat(name)
    tc = node(n, 'ShaderNodeTexCoord')
    wv = node(n, 'ShaderNodeTexWave', Scale=scale, Distortion=0.0)
    wv.wave_profile = 'SAW'
    wv.bands_direction = 'DIAGONAL'
    l.new(tc.outputs['Object'], wv.inputs['Vector'])
    r = ramp(n, [(0.49, (*a, 1)), (0.51, (*b, 1))], 'CONSTANT')
    l.new(wv.outputs['Fac'], r.inputs['Fac'])
    nz = node(n, 'ShaderNodeTexNoise', Scale=6.0, Detail=8.0)
    l.new(tc.outputs['Object'], nz.inputs['Vector'])
    wr = ramp(n, [(0.55, (1, 1, 1, 1)), (0.7, (0.25, 0.2, 0.18, 1))])
    l.new(nz.outputs['Fac'], wr.inputs['Fac'])
    mx = node(n, 'ShaderNodeMix', _data_type='RGBA', _blend_type='MULTIPLY', Factor=1.0)
    l.new(r.outputs['Color'], mx.inputs[6])
    l.new(wr.outputs['Color'], mx.inputs[7])
    l.new(mx.outputs[2], p.inputs['Base Color'])
    p.inputs['Roughness'].default_value = 0.6
    return m


def crt_screen(name, color=(0.25, 1.0, 0.45), strength=3.0, seed=0.0):
    """Green phosphor: scanlines + a jittery waveform trace."""
    m, nt, n, l, p = _mat(name)
    p.inputs['Base Color'].default_value = (0.01, 0.02, 0.01, 1)
    p.inputs['Roughness'].default_value = 0.15
    tc = node(n, 'ShaderNodeTexCoord')
    sep = node(n, 'ShaderNodeSeparateXYZ')
    l.new(tc.outputs['UV'], sep.inputs['Vector'])
    scan = node(n, 'ShaderNodeTexWave', Scale=60.0, Distortion=0.0)
    scan.bands_direction = 'Y'
    l.new(tc.outputs['UV'], scan.inputs['Vector'])
    # waveform: |y - 0.5 - 0.25*noise(x)| small -> bright
    nz = node(n, 'ShaderNodeTexNoise', Scale=7.0, Detail=1.0)
    cxyz = node(n, 'ShaderNodeCombineXYZ', Y=seed)
    l.new(sep.outputs['X'], cxyz.inputs['X'])
    l.new(cxyz.outputs['Vector'], nz.inputs['Vector'])
    off = node(n, 'ShaderNodeMath', _operation='MULTIPLY_ADD')
    l.new(nz.outputs['Fac'], off.inputs[0])
    off.inputs[1].default_value = 0.9
    off.inputs[2].default_value = 0.05
    d = node(n, 'ShaderNodeMath', _operation='SUBTRACT')
    l.new(sep.outputs['Y'], d.inputs[0])
    l.new(off.outputs[0], d.inputs[1])
    ab = node(n, 'ShaderNodeMath', _operation='ABSOLUTE')
    l.new(d.outputs[0], ab.inputs[0])
    tr = node(n, 'ShaderNodeMapRange', **{'From Min': 0.0, 'From Max': 0.03, 'To Min': 1.0, 'To Max': 0.12})
    l.new(ab.outputs[0], tr.inputs['Value'])
    sc = node(n, 'ShaderNodeMapRange', **{'To Min': 0.6, 'To Max': 1.0})
    l.new(scan.outputs['Fac'], sc.inputs['Value'])
    mul = node(n, 'ShaderNodeMath', _operation='MULTIPLY')
    l.new(tr.outputs['Result'], mul.inputs[0])
    l.new(sc.outputs['Result'], mul.inputs[1])
    s = node(n, 'ShaderNodeMath', _operation='MULTIPLY')
    l.new(mul.outputs[0], s.inputs[0])
    s.inputs[1].default_value = strength
    p.inputs['Emission Color'].default_value = (*color, 1)
    l.new(s.outputs[0], p.inputs['Emission Strength'])
    return m


def uv_plane(name, w, h, loc, rot, mat):
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new()
    vs = [bm.verts.new((x * w / 2, 0, z * h / 2)) for (x, z) in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    f = bm.faces.new(vs)
    for lp, (u, v) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        lp[uv].uv = (u, v)
    o = mesh_obj(name, bm, mat)
    o.location = loc
    o.rotation_euler = rot
    return o


def shot_vault():
    random.seed(5)
    reset(exposure=1.4)
    con = concrete('hall', base=(0.3, 0.3, 0.29), dark=(0.08, 0.08, 0.08), scale=0.3)
    floor_m = concrete('hfloor', base=(0.24, 0.24, 0.23), dark=(0.07, 0.07, 0.07), scale=0.5, streaks=False, wet=0.3)
    steel = metal('door', steel=(0.26, 0.26, 0.27), amount=0.28, scale=0.5, rough=0.4)
    dark_steel = metal('dsteel', steel=(0.12, 0.12, 0.13), amount=0.35, scale=1.0, rough=0.45)
    bare = plain('scratch', (0.75, 0.74, 0.72), 0.22, metallic=1.0, noise=0.2)
    gouge = plain('gouge', (0.02, 0.02, 0.02), 0.9, noise=0)
    yellow = plain('stencil', (0.6, 0.42, 0.03), 0.6, noise=0.5, scale=30)
    HX, HY, HZ = 16.0, 30.0, 22.0
    box('floor', (2 * HX, HY + 6, 0.2), (0, HY / 2 - 3, -0.1), mat=floor_m)
    box('back', (2 * HX, 0.6, HZ), (0, HY + 0.3, HZ / 2), mat=con)
    box('ceil', (2 * HX, HY + 6, 0.5), (0, HY / 2 - 3, HZ), mat=con)
    for x in (-HX, HX):
        box('side', (0.6, HY + 6, HZ), (x, HY / 2 - 3, HZ / 2), mat=con)
    for x in range(-14, 15, 4):
        box('rib', (0.7, 0.5, HZ), (x, HY - 0.2, HZ / 2), mat=con) if abs(x) > 8 else None
    # painted floor lines
    for x in (-6.5, 6.5):
        box('line', (0.18, HY - 4, 0.005), (x, HY / 2 + 1, 0.003), mat=yellow)
    # --- vault door
    DC = Vector((0, HY - 0.05, 8.2))
    DR = 7.0
    ring = stripes('hazard')
    torus('frame', DR + 0.45, 0.42, DC, (math.radians(90), 0, 0), mat=ring, seg=96, rseg=16)
    cyl('door', DR, 1.0, DC + Vector((0, -0.5, 0)), (math.radians(90), 0, 0), mat=steel, seg=96)
    for rr in (6.2, 4.6, 2.6):
        torus('dring', rr, 0.09, DC + Vector((0, -1.02, 0)), (math.radians(90), 0, 0), mat=dark_steel, seg=96, rseg=8)
    for k in range(32):
        a = 2 * math.pi * k / 32
        cyl('bolt', 0.17, 0.25, DC + Vector((math.cos(a) * 6.6, -1.05, math.sin(a) * 6.6)), (math.radians(90), 0, 0), mat=dark_steel, seg=12)
    cyl('hub', 1.5, 0.5, DC + Vector((0, -1.25, 0)), (math.radians(90), 0, 0), mat=dark_steel, seg=48)
    torus('wheel', 1.15, 0.08, DC + Vector((0, -1.7, 0)), (math.radians(90), 0, 0), mat=steel, seg=48, rseg=10)
    for k in range(6):
        a = 2 * math.pi * k / 6
        tube_between('spoke', DC + Vector((0, -1.7, 0)), DC + Vector((math.cos(a) * 1.15, -1.7, math.sin(a) * 1.15)), 0.06, steel)
    for side in (-1, 1):
        box('hinge', (1.0, 1.2, 2.2), DC + Vector((side * 7.4, -0.8, 3.2 * side * 0)), mat=dark_steel)
    text('stencil', 'QUIET ROOM', 1.25, DC + Vector((0, -1.04, 3.3)), (math.radians(90), 0, 0), yellow, extrude=0.004)
    text('stencil2', 'H-7  ANECHOIC CONTAINMENT', 0.38, DC + Vector((0, -1.04, -3.1)), (math.radians(90), 0, 0), yellow, extrude=0.003)
    # claw scratches: groups of four gouges with bright bare metal edges
    for (cx, cz, ang, L) in ((-2.6, 1.3, -0.6, 3.4), (3.4, -1.6, -1.0, 2.6), (-4.1, -2.2, 0.35, 2.8), (1.5, 4.6, -0.2, 2.2), (4.6, 2.8, -1.3, 2.4), (-1.5, -4.3, 0.9, 2.0)):
        for i in range(4):
            off = (i - 1.5) * 0.17
            dx, dz = -math.sin(ang) * off, math.cos(ang) * off
            p = DC + Vector((cx + dx, -1.035, cz + dz))
            box('gouge', (L * (0.85 + 0.15 * random.random()), 0.01, 0.035), p, (0, -ang, 0), mat=gouge)
            box('edge', (L * 0.9, 0.006, 0.06), p + Vector((0, 0.003, 0.0)), (0, -ang, 0), mat=bare)
    # door floodlights + red beacons
    for side in (-1, 1):
        box('floodbox', (0.5, 0.4, 0.35), (side * 9.5, HY - 9, 0.4), mat=dark_steel)
        spot('flood', (side * 9.5, HY - 9.2, 0.7), DC + Vector((side * -1.5, 0, 1.0)), 6000, 42, 0.5, color=(0.85, 0.9, 1.0), radius=0.15)
        sphere('beacon', 0.22, (side * 9.0, HY - 0.7, 16.5), mat=emissive('beaconm', (1, 0.08, 0.02), 40), sub=2, scale=(1, 1, 0.8))
        spot('beaconl', (side * 9.0, HY - 1.0, 16.4), (side * 3.0, HY - 9, 0), 9000, 30, 0.4, color=(1.0, 0.08, 0.02), radius=0.1)
    box('haze', (2 * HX, HY + 6, HZ), (0, HY / 2 - 3, HZ / 2), mat=fog('haze', 0.012, (0.85, 0.85, 0.88), 0.4, 0.2, 0.6))

    # --- control room (camera is in here, looking out through thick glass)
    cr = concrete('croom', base=(0.25, 0.25, 0.24), dark=(0.08, 0.08, 0.08), scale=1.0, streaks=False)
    beige = plain('beige', (0.42, 0.38, 0.3), 0.5, noise=0.3)
    console = plain('console', (0.08, 0.085, 0.09), 0.5, noise=0.3)
    # window wall at y=0 with a long opening
    box('cr_low', (12, 0.5, 1.0), (0, -0.25, 0.5), mat=cr)
    box('cr_high', (12, 0.5, 2.0), (0, -0.25, 4.2), mat=cr)
    box('cr_floor', (12, 6, 0.2), (0, -3.25, -0.1), mat=cr)
    box('cr_ceil', (12, 6, 0.2), (0, -3.25, 5.2), mat=cr)
    box('cr_back', (12, 0.3, 5.2), (0, -6.2, 2.6), mat=cr)
    for x in (-6, 6):
        box('cr_side', (0.3, 6, 5.2), (x, -3.25, 2.6), mat=cr)
    for x in (-4.5, -1.5, 1.5, 4.5):
        box('mullion', (0.16, 0.5, 2.2), (x, -0.25, 2.1), mat=dark_steel)
    gl = glass('thick', rough=0.015, ior=2.2, tint=(0.82, 0.9, 0.86))
    box('glass', (12, 0.05, 2.2), (0, -0.2, 2.1), mat=gl)
    # desk + CRTs + lever + mic
    box('desk', (7.0, 1.0, 0.08), (0, -0.95, 0.92), mat=console)
    box('deskfront', (7.0, 0.05, 0.9), (0, -1.43, 0.45), mat=console)
    for i, x in enumerate((-2.6, -1.4, 1.2, 2.5)):
        box('crt', (0.5, 0.48, 0.46), (x, -0.85, 1.2), (0, 0, 0.08 * (1 if x < 0 else -1)), mat=beige, bevel=0.03)
        uv_plane('screen', 0.4, 0.32, (x + 0.0, -1.1, 1.22), (0, 0, 0.08 * (1 if x < 0 else -1)), crt_screen(f'scr{i}', seed=i * 3.1))
        point('crtglow', (x, -1.6, 1.25), 6, color=(0.3, 1.0, 0.5), radius=0.2)
    box('leverbase', (0.4, 0.3, 0.18), (0.1, -0.9, 1.05), mat=dark_steel)
    tube_between('lever', (0.1, -0.9, 1.1), (0.1, -1.25, 1.55), 0.03, steel)
    sphere('knob', 0.075, (0.1, -1.27, 1.58), mat=plain('red', (0.5, 0.02, 0.01), 0.3, noise=0.1))
    box('micbase', (0.14, 0.14, 0.03), (-0.45, -1.1, 0.975), mat=dark_steel)
    curve_path('goose', [(-0.45, -1.1, 0.98), (-0.45, -1.15, 1.2), (-0.42, -1.3, 1.32)], 0.008, dark_steel)
    cyl('mic', 0.025, 0.09, (-0.42, -1.33, 1.34), (math.radians(60), 0, 0), mat=dark_steel, seg=12)
    pap = plain('paper', (0.6, 0.58, 0.52), 0.8, noise=0.2)
    for k in range(6):
        box('paper', (0.21, 0.297, 0.001), (random.uniform(-3.2, 3.2), random.uniform(-1.3, -0.6), 0.962), (0, 0, random.uniform(-0.6, 0.6)), mat=pap)
    # the creature standing right behind the camera: only its reflection shows in the glass
    mon, arm, body = monster('Listen', 40, loc=(0.9, -4.3, 0.0), rot=(0, 0, 0))
    point('behind', (0.7, -2.9, 1.6), 6, color=(0.3, 1.0, 0.5), radius=0.4)
    cam = camera((-0.35, -2.4, 1.62), (0.0, HY, 7.6), lens=24, dof=None)
    render('ch4_quiet_room_vault')


def shot_boss():
    random.seed(9)
    reset(exposure=1.0)
    con = concrete('arena', base=(0.28, 0.28, 0.27), dark=(0.08, 0.08, 0.08), scale=0.4)
    floor_m = concrete('afloor', base=(0.22, 0.22, 0.21), dark=(0.06, 0.06, 0.06), scale=0.6, streaks=False, wet=0.4)
    steel = metal('steel', amount=0.4, scale=2.0)
    cab = plain('cab', (0.03, 0.03, 0.03), 0.55, noise=0.4, scale=3.0)
    cone = plain('cone', (0.015, 0.015, 0.015), 0.85, noise=0.3, scale=20.0)
    grill = metal('grill', steel=(0.14, 0.14, 0.14), amount=0.3, scale=6.0)
    spk = speaker_template(cab, cone, grill, steel, w=1.3, d=0.9, h=1.7, bracket=False)
    C = Vector((0, 12.0, 0))
    R = 15.0
    box('floor', (60, 60, 0.2), (0, 10, -0.1), mat=floor_m)
    # curved wall of stacked speaker cabinets around the arena
    rows, cols = 8, 34
    for r in range(rows):
        for c in range(cols):
            a = math.radians(-115 + 230 * c / (cols - 1))
            rr = R + 0.35 * (r % 2)
            x, y = C.x + math.sin(a) * rr, C.y + math.cos(a) * rr
            inst(spk, 'spk', (x, y, 0.85 + r * 1.75), (random.uniform(-0.03, 0.03), 0, math.pi - a + random.uniform(-0.05, 0.05)), (1, 1, 1))
    cyl('backwall', R + 1.4, 18, (C.x, C.y, 9), mat=con, seg=96, caps=False)
    # raised round platform
    cyl('platform', 3.4, 0.9, C + Vector((0, 0, 0.45)), mat=con, seg=64)
    torus('platrim', 3.4, 0.06, C + Vector((0, 0, 0.9)), mat=stripes('haz2', scale=3.0), seg=64, rseg=8)
    # the monster, rearing up and screaming
    mon, arm, body = monster('Attack', 8, loc=C + Vector((0, 0.6, 0.9)), rot=(math.radians(-8), 0, math.radians(180)), scale=1.35,
                             pose={'jaw': (38, 0, 0), 'head': (-25, 0, 0), 'neck': (-12, 0, 0)})
    # sound shockwaves: thin glowing rings rippling out from it and from the speaker wall
    wave = emissive('wave', (0.75, 0.85, 1.0), 6.0)
    for k, rr in enumerate((2.2, 3.4, 4.9, 6.8, 9.0)):
        torus('shock', rr, 0.012 + 0.006 * k, C + Vector((0, 0, 2.6 + 0.15 * k)), (math.radians(90 - 6), 0, 0), mat=wave, seg=96, rseg=6)
    for k in range(10):
        a = math.radians(random.uniform(-100, 100))
        x, y = C.x + math.sin(a) * (R - 1.0), C.y + math.cos(a) * (R - 1.0)
        z = random.uniform(2, 11)
        for j, rr in enumerate((0.8, 1.4, 2.1)):
            o = torus('spkwave', rr, 0.012, (x, y, z), (math.radians(90), 0, math.pi - a), mat=wave, seg=48, rseg=5)
    # the Echo blast from the players: a cone of rings toward the monster
    E = Vector((0.55, -2.0, 1.3))
    d = (C + Vector((0, 0, 2.6)) - E)
    for k in range(9):
        t = (k + 1) / 10
        p = E + d * t
        o = torus('blast', 0.15 + 1.1 * t, 0.01 + 0.012 * t, p, (0, 0, 0), mat=emissive('blastm', (1.0, 0.75, 0.35), 8.0 - 5 * t), seg=48, rseg=5)
        o.rotation_mode = 'QUATERNION'
        o.rotation_quaternion = d.to_track_quat('Z', 'Y')
    # players (seen from behind) with flashlights + the Echo
    p1 = person('p1', (-1.6, -3.2, 0), yaw=math.radians(170))
    p2 = person('p2', (0.6, -2.4, 0), yaw=math.radians(185))
    p3 = person('p3', (2.6, -3.5, 0), yaw=math.radians(195))
    echo_body = plain('echo', (0.12, 0.13, 0.12), 0.4, metallic=0.5, noise=0.3)
    box('echo', (0.16, 0.36, 0.14), E + Vector((0, -0.2, 0)), mat=echo_body, bevel=0.02)
    cyl('dish', 0.17, 0.12, E + Vector((0, 0.02, 0)), (math.radians(-90), 0, 0), mat=steel, seg=28, r2=0.05)
    box('dial', (0.06, 0.08, 0.005), E + Vector((0.0, -0.25, 0.072)), mat=emissive('amber', (1, 0.6, 0.15), 15))
    point('echoglow', E + Vector((0, 0.2, 0)), 30, color=(1.0, 0.7, 0.35), radius=0.1)
    for (x, y) in ((-1.4, -3.0), (2.8, -3.3)):
        spot('pflash', (x, y + 0.3, 1.35), C + Vector((x * 0.2, 0, 2.2)), 1500, 20, 0.5, color=(1.0, 0.93, 0.82))
    # strobes and red alarm
    for (x, y, z, col, pw) in ((-7, 4, 16, (1, 1, 1), 60000), (8, 6, 15, (1.0, 0.1, 0.03), 60000), (0, 20, 17, (0.7, 0.8, 1.0), 40000)):
        spot('strobe', (x, y, z), C + Vector((0, 0, 2.0)), pw, 26, 0.3, color=col, radius=0.2)
    point('core', C + Vector((0, -1.5, 3.2)), 120, color=(0.7, 0.8, 1.0), radius=0.5)
    # sparks from a blown speaker
    spark = emissive('spark', (1.0, 0.55, 0.15), 40)
    for k in range(60):
        o = box('spark', (0.006, 0.006, random.uniform(0.05, 0.18)), (random.uniform(-9, -6.5), random.uniform(8, 10), random.uniform(3, 6)),
                (random.uniform(-1, 1), random.uniform(-1, 1), 0), mat=spark)
    point('sparkl', (-8, 9, 5), 300, color=(1.0, 0.55, 0.2), radius=0.3)
    box('haze', (40, 40, 20), (0, 10, 10), mat=fog('haze', 0.012, (0.85, 0.85, 0.9), 0.4, 0.15, 0.6))
    scatter_dust('dust', (0, 6, 4), (20, 14, 7), 2500, emissive('dustm', (0.9, 0.88, 0.85), 1.0), r=0.008)
    cam = camera((0.9, -6.4, 1.35), (0.0, 12.0, 3.6), lens=20, roll_deg=-4)
    render('ch4_quiet_room_boss')


if want('A'):
    shot_vault()
if want('B'):
    shot_boss()
