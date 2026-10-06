"""
Readable notes for MUTE (numpy only): yellowed, creased, stained paper with a handwritten message,
1024 x 1024 so they read in VR at arm's length.

    rgba, normal, spec = note_image('tutorial')

`spec` (NOTES[name]) carries the physical sheet size (m), placement, fold lines and curl, which
decals_lib also uses to bend the paper mesh, so creases in the texture and the geometry agree.
Texture v runs top -> bottom of the page (row 0 = top edge of the sheet).

Helper module only: build() is a no-op.
"""

from __future__ import annotations

import math

import numpy as np

import decals_hand as H
from decals_img import grid, normal_from_height, rgba
from dressing_img import blur, hexa, lerp, smooth, vnoise


def build() -> None:
    print('decals_notes: helper module (built through decals.py)')


TEX = 1024
NORMAL_TEX = 512

# Each note: who wrote it, on what, where it lies. `size` = (width, height) of the sheet in m.
# folds: ('h' | 'v', position 0..1, sign) = crease across the page (h = horizontal line at v).
NOTES = {
    'tutorial': dict(
        text="If you can read this,\ndon't say a word.\nIt can't see you.\nIt *HEARS* you.\nThree fuses.\n"
             "Box by the front door.\nThe camera shows it.\nTalk with your hands.",
        paper='notebook', size=(0.2, 0.26), placement='surface', ink='262a4e', pen=('ballpoint', 5.6),
        hand=dict(slant=0.16, messy=0.45, seed=31), xh=40, rule=(3, 4), left=0.145, right=0.995,
        folds=[('h', 0.5, 1)], curl=0.006, stains=['thumb', 'ring'], seed=11),
    'tom': dict(
        text='It found Tom\nwhen he screamed.',
        paper='scrap', size=(0.17, 0.12), placement='floor', ink='2c2c30', pen=('pencil', 6.5),
        hand=dict(slant=0.1, messy=0.75, tremor=0.9, seed=32), xh=52, top=0.36, line=2.5, left=0.07, right=0.98,
        folds=[('v', 0.5, -1)], curl=0.004, crumple=1.0, stains=['dirt'], seed=12),
    'whisper': dict(
        text='Whisper.\nAlways whisper.\nEven the floor\ncreaks.',
        paper='letter', size=(0.16, 0.21), placement='wall', ink='1c2444', pen=('fountain', 7.5),
        hand=dict(slant=0.24, messy=0.2, seed=33), xh=50, top=0.2, line=2.75, left=0.1, right=0.98,
        folds=[('h', 0.34, 1), ('h', 0.67, -1)], curl=0.008, stains=['water'], seed=13),
    'flash': dict(
        text="The flash doesn't\nhurt it, but you'll\nsee where it is.\n*Count* your film.",
        paper='notepad', size=(0.13, 0.19), placement='surface', ink='18181e', pen=('ballpoint', 5.6),
        hand=dict(slant=0.08, messy=0.35, seed=34), xh=42, rule=(4, 2), left=0.07, right=0.99,
        folds=[], curl=0.01, stains=['ring', 'dirt'], header='OCT 30', seed=14),
    'dad': dict(
        text="Dad hid the fuses\nso we couldnt leave.\nIm sorry.\n- Ellie",
        paper='school', size=(0.22, 0.17), placement='floor', ink='38383e', pen=('pencil', 7.5),
        hand=dict(slant=-0.04, messy=1.0, size_jitter=0.12, rot_jitter=6.0, baseline=0.22, spacing=1.12, seed=35),
        xh=43, rule=(1, 2), left=0.14, right=0.995, folds=[('v', 0.5, 1), ('h', 0.5, -1)], curl=0.005,
        crumple=0.5, stains=['dirt'], seed=15),
    'kitchen': dict(
        text='It keeps coming back\nto the kitchen.\nWe were *loud* there.',
        paper='card', size=(0.15, 0.1), placement='surface', ink='202026', pen=('pencil', 6.0),
        hand=dict(slant=0.14, messy=0.45, seed=36), xh=38, rule=(1, 2), left=0.06, right=0.99,
        folds=[], curl=0.003, stains=['grease', 'ring'], header_print='RECIPE', seed=16),
}

# Ruled papers: (first line v, spacing m)
RULING = {'notebook': (0.1, 0.0071), 'notepad': (0.13, 0.0071), 'card': (0.3, 0.0064), 'school': (0.17, 0.0125)}


# =============================================================================================
# Paper
# =============================================================================================

def _rect(xx, yy, x0, y0, x1, y1, soft=0.8):
    return (np.clip((xx - x0) / soft + 0.5, 0, 1) * np.clip((x1 - xx) / soft + 0.5, 0, 1) *
            np.clip((yy - y0) / soft + 0.5, 0, 1) * np.clip((y1 - yy) / soft + 0.5, 0, 1))


def paper_base(kind, aspect, seed):
    """Paper color (HxWx3), outline alpha (torn edges, holes) and a printed-lines layer."""
    n = TEX
    rng = np.random.default_rng(seed)
    xx, yy = grid(n, n)
    U, V = xx / n, yy / n
    base = {'notebook': 'ddd3b8', 'scrap': 'd2c7a6', 'letter': 'e0d6bc', 'notepad': 'd8d1b2', 'school': 'd9d2bc',
            'card': 'e2dcc6'}[kind]
    rgb = lerp(hexa(base), hexa(base) * 0.93, vnoise(n, n, 120, seed, 3))
    fib = vnoise(n, n, 2.0, seed + 1, 2)
    rgb = rgb * (0.97 + 0.05 * fib)[..., None]
    alpha = np.ones((n, n), np.float32)
    edge_n = vnoise(n, n, 6, seed + 2, 3)

    # one pixel of v in "page units": the texture is square but the page isn't
    def hline(v, col, a, width_px=1.4):
        return np.clip(1 - np.abs(yy - v * n) / width_px, 0, 1)

    lines = np.zeros((n, n), np.float32)
    margin = np.zeros((n, n), np.float32)
    blue, red = hexa('7c90b4'), hexa('c27a78')
    if kind in ('notebook', 'notepad', 'card', 'school'):
        # spacing in page meters -> v units
        page_h = 1.0
        first, sp_m = RULING[kind]
        sp = sp_m / aspect[1]
        v = first
        k = 0
        while v < page_h - 0.02:
            lines = np.maximum(lines, hline(v, blue, 0.5) * (0.75 + 0.25 * vnoise(n, n, 30, seed + 3 + k, 1)))
            if kind == 'school':
                dash = (np.sin(xx * 0.12) > -0.2).astype(np.float32)
                lines = np.maximum(lines, hline(v - sp * 0.5, blue, 0.4, 1.0) * dash * 0.6)
            v += sp
            k += 1
        if kind in ('notebook', 'school'):
            margin = np.clip(1 - np.abs(xx - 0.12 * n) / 1.5, 0, 1)
        if kind == 'card':
            lines = np.maximum(lines, np.clip(1 - np.abs(yy - 0.2 * n) / 2.2, 0, 1) * 1.2)  # red header rule
    rgb = lerp(rgb, blue, lines * 0.55)
    if kind == 'card':
        rgb = lerp(rgb, red, np.clip(1 - np.abs(yy - 0.2 * n) / 2.2, 0, 1) * 0.7)
    rgb = lerp(rgb, red, margin * 0.6)

    # outline
    d_l, d_r, d_t, d_b = U, 1 - U, V, 1 - V
    if kind == 'notebook':
        # torn out of a spiral notebook: ragged top with half-torn holes
        tear_y = 0.012 + 0.012 * edge_n + 0.006 * np.sin(U * 90)
        alpha *= smooth(V - tear_y, -0.002, 0.002)
        for k in range(13):
            hx = (k + 0.5) / 13
            hole = np.sqrt(((U - hx) * aspect[0]) ** 2 + ((V - 0.022) * aspect[1]) ** 2) - 0.0032
            alpha *= smooth(hole, -0.0004, 0.0004)
    elif kind == 'notepad':
        # perforated top tear-off strip
        tear_y = 0.008 + 0.004 * edge_n
        alpha *= smooth(V - tear_y, -0.002, 0.002)
        perf = (np.sin(U * 260) > 0.6) * (np.abs(V - 0.016) < 0.003)
        alpha *= 1 - perf.astype(np.float32) * 0.85
    elif kind == 'scrap':
        # torn from a bigger sheet on two sides
        tr = 0.03 + 0.025 * vnoise(n, n, 18, seed + 4, 4)
        alpha *= smooth(d_r - tr, -0.003, 0.003) * smooth(d_b - tr * 0.8, -0.003, 0.003)
    elif kind == 'school':
        tr = 0.02 + 0.02 * vnoise(n, n, 14, seed + 5, 4)
        alpha *= smooth(d_l - tr, -0.003, 0.003)
    # every sheet: slightly soft, chewed edges
    e = np.minimum(np.minimum(d_l, d_r), np.minimum(d_t, d_b))
    alpha *= smooth(e - 0.004 * edge_n, 0.0, 0.004)
    return rgb, alpha


def age(rgb, seed, strength=1.0, edge=0.6):
    """Yellowing, browned edges, big soft blotches, sparse foxing, one faint tide line."""
    n = TEX
    xx, yy = grid(n, n)
    U, V = xx / n, yy / n
    rgb = rgb * (1 - 0.16 * strength) + rgb * hexa('d8c090') * 0.15 * strength
    de = np.minimum(np.minimum(U, 1 - U), np.minimum(V, 1 - V))
    rgb = lerp(rgb, hexa('9a7a48'), smooth(de, 0.07, 0.0) * 0.55 * edge * strength)
    yel = vnoise(n, n, 280, seed, 3)
    rgb = lerp(rgb, hexa('b4965e'), smooth(yel, 0.5, 0.85) * 0.32 * strength)
    fox = vnoise(n, n, 6, seed + 1, 2)
    rgb = lerp(rgb, hexa('8a5c30'), smooth(fox, 0.84, 0.89) * 0.4 * strength)
    tide = vnoise(n, n, 420, seed + 2, 3)
    rgb = lerp(rgb, hexa('8a6a40'), np.exp(-((tide - 0.64) / 0.005) ** 2) * 0.3 * strength)
    rgb = lerp(rgb, hexa('b49464'), smooth(tide, 0.64, 0.74) * 0.14 * strength)
    return rgb


def stains(rgb, kind_list, seed, aspect, ink_cov):
    n = TEX
    rng = np.random.default_rng(seed + 77)
    xx, yy = grid(n, n)
    U, V = xx / n, yy / n
    for st in kind_list:
        if st == 'ring':  # coffee cup ring, partly off the page
            cx, cy = rng.uniform(0.55, 0.95), rng.uniform(0.6, 0.95)
            r = 0.04 / aspect[0]
            d = np.sqrt(((U - cx) * aspect[0]) ** 2 + ((V - cy) * aspect[1]) ** 2) / 0.04
            ring = np.exp(-((d - 1) / 0.035) ** 2) * (0.6 + 0.4 * vnoise(n, n, 20, seed, 2))
            fill = smooth(1 - d, 0.0, 0.08) * 0.18
            rgb = lerp(rgb, hexa('8a5a2c'), np.clip(ring * 0.55 + fill, 0, 1))
            del r
        elif st == 'thumb':  # bloody thumbprint in the lower corner, smeared off the page
            cx, cy = 0.85, 0.9
            lx = (U - cx) * aspect[0] * 1000  # mm
            ly = (V - cy) * aspect[1] * 1000
            ang = 0.55
            c, s_ = math.cos(ang), math.sin(ang)
            px, py = lx * c + ly * s_, -lx * s_ + ly * c
            d = np.sqrt((px / 10) ** 2 + (py / 13.5) ** 2)
            warp = (vnoise(n, n, 14, seed + 4, 2) - 0.5) * 2.2
            loops = np.sqrt(px * px + ((py + 5) * 0.75) ** 2) + warp
            ridges = smooth(np.sin(loops * 2 * math.pi / 0.85), -0.2, 0.6)
            contact = smooth(vnoise(n, n, 9, seed + 3, 3), 0.25, 0.6)
            m = smooth(1 - d, 0.0, 0.22) * (0.25 + 0.75 * ridges) * (0.4 + 0.6 * contact)
            rgb = lerp(rgb, hexa('4a0e08'), np.clip(m, 0, 1) * 0.8)
            m2 = smooth(1 - np.sqrt(((px + 16) / 20) ** 2 + (py / 8) ** 2), 0.0, 0.5) * 0.3 * contact
            rgb = lerp(rgb, hexa('5a1a10'), np.clip(m2, 0, 1))
        elif st == 'water':
            f = vnoise(n, n, 160, seed + 5, 4) + 0.35 * smooth(V, 0.5, 1.0)
            tide = np.exp(-((f - 0.78) / 0.012) ** 2)
            rgb = lerp(rgb, hexa('9a8058'), smooth(f, 0.78, 0.8) * 0.25 + tide * 0.4)
        elif st == 'grease':
            for k in range(3):
                cx, cy = rng.uniform(0.1, 0.9), rng.uniform(0.5, 0.95)
                d = np.sqrt(((U - cx) * aspect[0]) ** 2 + ((V - cy) * aspect[1]) ** 2) / rng.uniform(0.008, 0.016)
                rgb = lerp(rgb, hexa('a08a5a'), smooth(1 - d, 0.0, 0.3) * 0.45)
        elif st == 'dirt':
            g = smooth(vnoise(n, n, 50, seed + 7, 4), 0.6, 0.85) * 0.3
            rgb = lerp(rgb, hexa('6a5a44'), g)
            # graphite / grime smudge where a hand dragged across the writing
            sm = blur(ink_cov, 6) * 0.25
            rgb = lerp(rgb, hexa('5a5a5a'), sm)
        elif st == 'tear':
            pass  # handled by the outline
    return rgb


def fold_height(kind_folds, crumple, seed, n, aspect):
    """Height field (meters-ish, for normals): creases + crumple + fibre."""
    xx, yy = grid(n, n)
    U, V = xx / n, yy / n
    h = np.zeros((n, n), np.float32)
    for (axis, pos, sign) in kind_folds:
        d = (V - pos) * aspect[1] if axis == 'h' else (U - pos) * aspect[0]
        h += sign * 0.0012 * np.exp(-np.abs(d) / 0.004)  # sharp ridge/valley
    if crumple:
        # crumpled ball flattened again: ridged multi-scale creases
        acc = np.zeros((n, n), np.float32)
        amp = 1.0
        for k, cell in enumerate((90, 45, 22, 11)):
            r = vnoise(n, n, cell * n / 1024, seed + 40 + k, 1)
            acc += amp * (1 - np.abs(2 * r - 1)) ** 2
            amp *= 0.55
        h += crumple * 0.0009 * acc
    h += 0.00006 * vnoise(n, n, 2, seed + 9, 2)
    return h


def ink_layer(spec, aspect):
    """Handwriting coverage for a note (TEX x TEX) + any printed header coverage."""
    n = TEX
    hand = H.Hand(**spec['hand'])
    kind, width = spec['pen']
    pen = H.Pen(kind, width=width, density=0.95 if kind != 'pencil' else 0.85)
    # The texture is square, the page is not: write in page-proportional pixels, then squash.
    w_m, h_m = aspect
    ph = int(round(n * h_m / w_m))
    page = np.zeros((ph, n), np.float32)
    printed = np.zeros((ph, n), np.float32)
    xh = spec['xh']
    if 'rule' in spec:
        first, sp_m = RULING[spec['paper']]
        sp = sp_m * n / w_m
        start, per = spec['rule']
        y0 = first * ph + start * sp - 3
        line_h = per * sp
    else:
        y0 = spec['top'] * ph
        line_h = xh * spec['line']
    if spec.get('header'):
        H.write(page, spec['header'], n * spec['left'], y0 - line_h, xh * 0.8,
                H.Hand(slant=0.05, messy=0.3, caps=True, seed=spec['seed'] + 5), pen, max_width=n)
    if spec.get('header_print'):
        from dressing_img import Canvas
        cv = Canvas(n, ph, (0, 0, 0), spec['seed'])
        cv.text(spec['header_print'], n * 0.06, 0.16 * ph, 30, 3.2, (1, 1, 1), 1.0, 0.0, 1.5)
        cv.text('FROM THE KITCHEN OF', n * 0.52, 0.16 * ph, 13, 1.6, (1, 1, 1), 0.9, 0.0, 1.3)
        printed = cv.a[..., 0]
    H.write(page, spec['text'], n * spec['left'], y0, xh, hand, pen,
            max_width=n * (spec['right'] - spec['left']), line_h=line_h)

    def squash(a):
        if ph > n:
            a = blur(a, 0.4 * ph / n)
        src_y = (np.arange(n) + 0.5) / n * ph - 0.5
        i0 = np.clip(np.floor(src_y).astype(int), 0, ph - 1)
        i1 = np.clip(i0 + 1, 0, ph - 1)
        t = (src_y - np.floor(src_y))[:, None]
        return np.clip(a[i0] * (1 - t) + a[i1] * t, 0, 1)

    return squash(page), squash(printed)


def note_image(name):
    spec = NOTES[name]
    seed = spec['seed']
    aspect = spec['size']
    rgb, alpha = paper_base(spec['paper'], aspect, seed)
    cov, printed = ink_layer(spec, aspect)
    rgb = lerp(rgb, hexa('9a3a34'), printed * 0.8)
    # aging under the ink (paper yellows; ink sits on top), then the ink, then grime over all
    rgb = age(rgb, seed, 1.0, edge=0.7)
    ink = hexa(spec['ink'])
    kind = spec['pen'][0]
    if kind == 'pencil':
        tooth = vnoise(TEX, TEX, 1.3, seed + 3, 1)
        cov = cov * (0.6 + 0.4 * smooth(tooth, 0.2, 0.7))
        rgb = lerp(rgb, ink, np.clip(cov * 0.95, 0, 1))
    elif kind == 'fountain':
        bleed = blur(cov, 1.2) * 0.25
        rgb = lerp(rgb, ink * 1.3, np.clip(bleed, 0, 1))
        rgb = lerp(rgb, ink, np.clip(cov * 1.05, 0, 1))
    else:
        rgb = lerp(rgb, ink, np.clip(cov * 1.08, 0, 1))
    rgb = stains(rgb, spec.get('stains', []), seed, aspect, cov)
    # creases: dirt collects in the folds (a darker line + a light catch beside it)
    xx, yy = grid(TEX, TEX)
    U, V = xx / TEX, yy / TEX
    for (axis, pos, sign) in spec.get('folds', []):
        d = (V - pos) if axis == 'h' else (U - pos)
        rgb = lerp(rgb, hexa('7a6a4c'), np.exp(-(d / 0.0018) ** 2) * 0.45)
        rgb = lerp(rgb, hexa('f2ead6'), np.exp(-((d - 0.004 * sign) / 0.002) ** 2) * 0.15)
    hgt = fold_height(spec.get('folds', []), spec.get('crumple', 0.0), seed, NORMAL_TEX, aspect)
    # height in texels: meters -> px of the normal map (along u)
    px_per_m = NORMAL_TEX / aspect[0]
    nrm = normal_from_height(hgt * px_per_m, 1.0)
    if spec.get('crumple'):
        sh = blur(_shade(hgt, aspect), 1.0)
        idx = np.clip(np.arange(TEX) * NORMAL_TEX // TEX, 0, NORMAL_TEX - 1)
        rgb = rgb * (0.95 + 0.07 * sh[idx][:, idx])[..., None]
    return rgba(np.clip(rgb, 0, 1), alpha), nrm, spec


def _shade(hgt, aspect):
    """Baked-in soft shading of crumple creases (so they read even without a raking light)."""
    g = np.zeros_like(hgt)
    g[1:-1, 1:-1] = (hgt[2:, 1:-1] - hgt[:-2, 1:-1]) + (hgt[1:-1, 2:] - hgt[1:-1, :-2])
    g = g / (np.abs(g).max() + 1e-9)
    return g


def surface_z(spec, u, v):
    """Paper displacement (m) at page coords u, v in 0..1 (v = 0 top edge): folds, curl, crumple."""
    w, h = spec['size']
    z = 0.0
    for (axis, pos, sign) in spec.get('folds', []):
        d = (v - pos) * h if axis == 'h' else (u - pos) * w
        z += sign * 0.0035 * max(0.0, 1 - abs(d) / 0.05) ** 2 + sign * 0.0012 * (1 - min(1.0, abs(d) / 0.12))
    c = spec.get('curl', 0.0)
    # corners lift (paper that dried after getting damp)
    for (cu, cv) in ((0, 0), (1, 0), (0, 1), (1, 1)):
        d = math.hypot((u - cu) * w, (v - cv) * h)
        z += c * max(0.0, 1 - d / 0.07) ** 2
    if spec.get('crumple'):
        z += spec['crumple'] * 0.0025 * (math.sin(u * 7.1 + 1.2) * math.sin(v * 5.3 + 0.4) +
                                         0.5 * math.sin(u * 13.0 + v * 9.0))
    return z
