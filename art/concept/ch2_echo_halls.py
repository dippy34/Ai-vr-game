"""Chapter 2: The Echo Halls. A colossal reverb chamber: pit, catwalks, a forest of hanging speakers."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mlib import *

random.seed(7)
reset(exposure=1.2)

W, TOP, BOT, PIT = 22.0, 28.0, -30.0, 15.0
wall_m = concrete('wall', base=(0.30, 0.30, 0.29), dark=(0.09, 0.09, 0.09), scale=0.35)
ledge_m = concrete('ledge', base=(0.26, 0.25, 0.24), dark=(0.08, 0.08, 0.075), scale=0.6, streaks=False, wet=0.25)
steel = metal('steel', amount=0.55, scale=2.0)
paint = metal('rail', paint=(0.16, 0.13, 0.05), amount=0.5, scale=4.0, rough=0.55)
cab_m = plain('cabinet', (0.025, 0.024, 0.023), rough=0.55, noise=0.4, scale=3.0)
cone_m = plain('cone', (0.012, 0.012, 0.012), rough=0.85, noise=0.3, scale=20.0)
grill_m = metal('grill', steel=(0.12, 0.12, 0.12), amount=0.3, scale=6.0, rough=0.5)
chain_m = metal('chain', steel=(0.18, 0.17, 0.16), amount=0.6, scale=10.0)
red_bulb = emissive('redbulb', (1.0, 0.08, 0.03), 60.0)
door_glow = emissive('doorglow', (1.0, 0.55, 0.25), 6.0)

# --- shell
for sx, sy, sz, lx, ly in ((1, 2 * W + 2, TOP - BOT, W + 0.5, 0), (1, 2 * W + 2, TOP - BOT, -W - 0.5, 0),
                           (2 * W + 2, 1, TOP - BOT, 0, W + 0.5), (2 * W + 2, 1, TOP - BOT, 0, -W - 0.5)):
    box('wall', (sx, sy, sz), (lx, ly, (TOP + BOT) / 2), mat=wall_m)
box('ceiling', (2 * W + 2, 2 * W + 2, 1), (0, 0, TOP + 0.5), mat=wall_m)
# pilasters + ring beams
for i in range(-5, 6):
    t = i * 4.0
    for (x, y, sx, sy) in ((W - 0.3, t, 0.6, 0.9), (-W + 0.3, t, 0.6, 0.9), (t, W - 0.3, 0.9, 0.6), (t, -W + 0.3, 0.9, 0.6)):
        if i == 0 and abs(x) > W - 1:
            continue  # doorways at both ends of the main catwalk
        box('pil', (sx, sy, TOP - BOT), (x, y, (TOP + BOT) / 2), mat=wall_m)
for z in (9.0, 19.0, -12.0):
    for (x, y, sx, sy) in ((W - 0.5, 0, 1.0, 2 * W), (-W + 0.5, 0, 1.0, 2 * W), (0, W - 0.5, 2 * W, 1.0), (0, -W + 0.5, 2 * W, 1.0)):
        box('beam', (sx, sy, 0.8), (x, y, z), mat=wall_m)
# ledge ring around the pit
L = W - PIT
for (x, y, sx, sy) in ((PIT + L / 2, 0, L, 2 * W), (-PIT - L / 2, 0, L, 2 * W), (0, PIT + L / 2, 2 * PIT, L), (0, -PIT - L / 2, 2 * PIT, L)):
    box('ledge', (sx, sy, 3.0), (x, y, -1.5), mat=ledge_m)
# pit edge lip with hazard paint
haz = metal('hazard', paint=(0.35, 0.25, 0.02), amount=0.55, scale=3.0, rough=0.6)
for (x, y, sx, sy) in ((PIT, 0, 0.15, 2 * PIT), (-PIT, 0, 0.15, 2 * PIT), (0, PIT, 2 * PIT, 0.15), (0, -PIT, 2 * PIT, 0.15)):
    box('lip', (sx, sy, 0.12), (x, y, 0.06), mat=haz)

# doorway at the far (-X) end of the main catwalk, warm light spilling out
box('doorhole', (0.2, 1.6, 2.6), (-W + 0.02, 0, 1.5), mat=door_glow)
area('doorlight', (-W + 0.6, 0, 2.6), (-W + 6, 0, 0), 600, 2.0, color=(1.0, 0.6, 0.3))

# --- catwalks
def catwalk(a, b, z, width=1.3, gap=None, droop=None, lamp_power=14):
    a, b = Vector((a[0], a[1], z)), Vector((b[0], b[1], z))
    d = (b - a)
    n = d.normalized()
    side = Vector((-n.y, n.x, 0))
    length = d.length
    yaw = math.atan2(n.y, n.x)
    segs = []
    t = 0.0
    step = 1.6
    pieces = []
    while t < length - 1e-3:
        t2 = min(length, t + step)
        if gap and gap[0] < t2 and t < gap[1]:
            t = t2
            continue
        pieces.append((t, t2))
        t = t2
    for (t0, t1) in pieces:
        mid = a + n * ((t0 + t1) / 2)
        L = t1 - t0
        box('deck', (L, width, 0.04), (mid.x, mid.y, z - 0.02), (0, 0, yaw), mat=grate)
        for s in (-1, 1):
            o = mid + side * s * width / 2
            box('stringer', (L, 0.06, 0.22), (o.x, o.y, z - 0.11), (0, 0, yaw), mat=paint)
            p = a + n * t0 + side * s * width / 2
            tube_between('post', (p.x, p.y, z), (p.x, p.y, z + 1.05), 0.025, paint, 8)
            q0 = a + n * t0 + side * s * width / 2
            q1 = a + n * t1 + side * s * width / 2
            tube_between('rail', (q0.x, q0.y, z + 1.05), (q1.x, q1.y, z + 1.05), 0.022, paint, 8)
            tube_between('mrail', (q0.x, q0.y, z + 0.55), (q1.x, q1.y, z + 0.55), 0.016, paint, 8)
        # hanger cables up to the ceiling every other segment
        if int(t0 / step) % 4 == 0:
            for s in (-1, 1):
                p = a + n * t0 + side * s * width / 2
                tube_between('hanger', (p.x, p.y, z + 1.05), (p.x, p.y, TOP), 0.015, chain_m, 6)
    k = 0
    amber = bpy.data.materials.get('amberbulb') or emissive('amberbulb', (1.0, 0.55, 0.2), 70.0)
    for (t0, t1) in pieces:
        k += 1
        if k % 4 == 1:
            p = a + n * t0 + side * (width / 2 + 0.05)
            sphere('wl', 0.05, (p.x, p.y, z + 1.15), mat=amber, sub=2)
            point('wlamp', (p.x, p.y, z + 1.12), lamp_power, color=(1.0, 0.55, 0.22), radius=0.05)
    if droop:
        # a broken section hinged at the far side of the gap, hanging into the pit
        h = a + n * gap[1]
        ang = math.radians(droop)
        Lb = 2.6
        c = h - n * (Lb / 2) * math.cos(ang)
        cz = z - (Lb / 2) * math.sin(ang)
        o = box('broken', (Lb, width, 0.04), (c.x, c.y, cz), (0, -ang, yaw), mat=grate)
        for s in (-1, 1):
            q = c + side * s * width / 2
            box('bstring', (Lb, 0.06, 0.22), (q.x, q.y, cz), (0, -ang, yaw), mat=paint)
        # snapped rail ends
        g = a + n * gap[0]
        for s in (-1, 1):
            p = g + side * s * width / 2
            tube_between('snap', (p.x, p.y, z + 1.05), (p.x + n.x * 0.6, p.y + n.y * 0.6, z + 0.7), 0.022, paint, 8)


# grating: steel with a square hole pattern (transparent holes)
grate, nt, n, l, p = (lambda m: (m, m.node_tree, m.node_tree.nodes, m.node_tree.links, m.node_tree.nodes['Principled BSDF']))(metal('grate', amount=0.5, scale=3.0))
tc = node(n, 'ShaderNodeTexCoord')
mp = node(n, 'ShaderNodeMapping')
mp.inputs['Scale'].default_value = (28, 28, 28)
l.new(tc.outputs['Object'], mp.inputs['Vector'])
br = node(n, 'ShaderNodeTexBrick', Scale=1.0, **{'Mortar Size': 0.18, 'Mortar Smooth': 0.0, 'Bias': 0.0})
br.offset = 0.0
br.squash = 1.0
br.inputs['Brick Width'].default_value = 1.0
br.inputs['Row Height'].default_value = 1.0
br.inputs['Color1'].default_value = (0, 0, 0, 1)
br.inputs['Color2'].default_value = (0, 0, 0, 1)
br.inputs['Mortar'].default_value = (1, 1, 1, 1)
l.new(mp.outputs['Vector'], br.inputs['Vector'])
out = n['Material Output']
tr = node(n, 'ShaderNodeBsdfTransparent')
mix = node(n, 'ShaderNodeMixShader')
l.new(br.outputs['Fac'], mix.inputs['Fac'])
l.new(tr.outputs['BSDF'], mix.inputs[1])
l.new(p.outputs['BSDF'], mix.inputs[2])
l.new(mix.outputs['Shader'], out.inputs['Surface'])

catwalk((-W, 0), (W, 0), 0.0, gap=(W + 3.0, W + 6.2), droop=58)
catwalk((-5, -W), (-5, W), 7.0)
catwalk((8, -W), (8, W), -7.0)

# --- speakers
def speaker_template():
    parts = [box('cab', (0.75, 0.55, 1.0), (0, 0, 0), mat=cab_m, bevel=0.02)]
    for z, r in ((-0.2, 0.26), (0.28, 0.13)):
        parts.append(cyl('cone', r, 0.06, (0, -0.28, z), (math.radians(90), 0, 0), mat=cone_m, seg=28, r2=r * 0.35))
        parts.append(torus('surround', r, 0.02, (0, -0.28, z), (math.radians(90), 0, 0), mat=grill_m, seg=28, rseg=6))
        parts.append(sphere('cap', r * 0.25, (0, -0.25, z), mat=cone_m, sub=2, scale=(1, 0.4, 1)))
    parts.append(box('eye', (0.09, 0.03, 0.06), (0.25, -0.28, 0.42), mat=grill_m))
    parts.append(box('bracket', (0.08, 0.08, 0.25), (0, 0, 0.62), mat=steel))
    for o in parts:
        if o.modifiers:
            apply_mods(o)
    t = join(parts, 'speaker_src')
    return t


spk = speaker_template()
spk.hide_render = True
spk.location = (0, 0, -100)
chain_src = cyl('chain_src', 0.025, 1.0, (0, 0, -100), mat=chain_m, seg=6)
chain_src.hide_render = True

def clear(x, y, z, r):
    if abs(y) < 2.4 + r and -2.0 < z < 4.0:  # main catwalk
        return False
    if abs(x + 5) < 2.4 + r and 5.0 < z < 11.0:
        return False
    if abs(x - 8) < 2.4 + r and -9.0 < z < -3.0:
        return False
    return True

placed = []
tries = 0
while len(placed) < 150 and tries < 6000:
    tries += 1
    x, y = random.uniform(-PIT + 1, PIT - 1), random.uniform(-PIT + 1, PIT - 1)
    z = random.uniform(-14, 22)
    s = random.choice((0.7, 0.9, 1.0, 1.0, 1.3, 1.6, 2.2))
    r = 0.6 * s
    if not clear(x, y, z, r):
        continue
    if any((Vector((x, y, z)) - q).length < (r + rq + 0.4) for q, rq in placed):
        continue
    placed.append((Vector((x, y, z)), r))
    yaw = random.uniform(0, 2 * math.pi)
    tilt = random.uniform(-0.08, 0.08)
    inst(spk, 'spk', (x, y, z), (tilt, random.uniform(-0.05, 0.05), yaw), (s, s, s))
    top = z + 0.75 * s
    inst(chain_src, 'chain', (x, y, (top + TOP) / 2), (0, 0, 0), (1, 1, TOP - top))

for _ in range(70):
    x = random.uniform(-PIT + 1, PIT - 1)
    y = random.choice((-1, 1)) * random.uniform(2.9, 9.0)
    z = random.uniform(-6, 9)
    sc = random.choice((0.8, 1.0, 1.2, 1.5))
    r = 0.6 * sc
    if not clear(x, y, z, r) or any((Vector((x, y, z)) - q).length < (r + rq + 0.3) for q, rq in placed):
        continue
    placed.append((Vector((x, y, z)), r))
    inst(spk, 'spk', (x, y, z), (random.uniform(-0.08, 0.08), 0, random.uniform(0, 6.3)), (sc, sc, sc))
    top = z + 0.75 * sc
    inst(chain_src, 'chain', (x, y, (top + TOP) / 2), (0, 0, 0), (1, 1, TOP - top))

# --- lights
lamp_cage = metal('cage', steel=(0.1, 0.1, 0.1), amount=0.4, scale=8)
def red_lamp(loc, power=40):
    sphere('bulb', 0.09, loc, mat=red_bulb, sub=2)
    torus('cage', 0.12, 0.008, loc, (math.radians(90), 0, 0), mat=lamp_cage, seg=16, rseg=4)
    point('redlamp', loc, power, color=(1.0, 0.1, 0.04), radius=0.08)

for i in range(-4, 5, 2):
    t = i * 4.0 + 2.0
    for (x, y) in ((W - 0.75, t), (-W + 0.75, t), (t, W - 0.75), (t, -W + 0.75)):
        red_lamp((x, y, 2.6), 35)
        red_lamp((x, y, 14.5), 50)
red_lamp((-W + 1.2, 1.4, 2.2), 20)
# cold shafts from ceiling vents
for (x, y) in ((-9, 6), (4, -7), (10, 9), (-2, -1)):
    box('vent', (1.4, 1.4, 0.2), (x, y, TOP - 0.05), mat=emissive('ventglow', (0.6, 0.75, 1.0), 4.0))
    spot('shaft', (x, y, TOP - 0.3), (x + 0.4, y - 0.3, -20), 300000, 8, 0.3, color=(0.62, 0.78, 1.0), radius=0.3)

# --- fog: chamber haze + thick mist rising from the pit
fbox = box('haze', (2 * W, 2 * W, TOP - BOT), (0, 0, (TOP + BOT) / 2), mat=fog('haze', 0.009, (0.85, 0.85, 0.9), 0.45, 0.08, 0.6))
mist = box('mist', (2 * PIT, 2 * PIT, 30), (0, 0, -15), mat=fog('mist', 0.05, (0.8, 0.82, 0.86), 0.3, 0.2, 0.85, falloff=0.16))

# --- player + monster (shot A)
hero = person('hero', (-0.5, 0.15, 0.0), yaw=math.radians(-90))
beamA = spot('heroflash', (-0.2, -0.1, 1.3), (10.8, 0.0, 1.0), 9000, 14, 0.5, color=(1.0, 0.93, 0.82))
mA, armA, bodyA = monster('Feed', 20, loc=(10.8, 0.0, 0.0), rot=(0, 0, math.radians(90)))

def shotA():
    camera((15.5, -17.5, 8.5), (-1.0, 0.5, -1.5), lens=17)
    render('ch2_echo_halls_wide')

# --- shot B: chase on the catwalk, looking back at it
def shotB():
    hero.hide_render = True
    beamA.hide_render = True
    for o in (mA, armA, bodyA):
        o.hide_render = True
    mB, armB, bodyB = monster('Run', 5, loc=(-12.2, 0.05, 0.0), rot=(0, 0, math.radians(-90)))
    cam = camera((-6.6, 0.25, 1.55), (-12.0, 0.0, 0.9), lens=22, roll_deg=-7, dof=5.6, fstop=4)
    flashlight(cam, (-12.0, 0.0, 0.8), power=700, angle=40)
    render('ch2_echo_halls_chase')

if want('A'):
    shotA()
if want('B'):
    shotB()
