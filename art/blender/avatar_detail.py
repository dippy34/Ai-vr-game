"""
Per-texel surface detail for the avatar (see hands_tex for the texel pipeline):
skin around the eyes (brows, lash line, lid crease, tired under-eyes, pores, a scar), the eyes
(sclera / iris / pupil, wet), the bandana (twill weave, faded print, folds, hems, dust), the knit
beanie (stockinette crown, 2x2 rib cuff, heathered yarn) and the body's clothing.
All functions return (height m, linear albedo (n,3), roughness).
"""

from __future__ import annotations

import math

import numpy as np

import avatar_head as ah
from hands_tex import fbm, ridged, smoothstep, srgb_to_lin, vnoise

MM = 0.001


def gauss(d, s):
    return np.exp(-(d / s) ** 2)


SKIN_BACK = srgb_to_lin([0.655, 0.535, 0.478])   # same skin as the hands


def evaluate_head(P: np.ndarray, N: np.ndarray, region: np.ndarray):
    n = len(P)
    H = np.zeros(n)
    C = np.zeros((n, 3))
    R = np.full(n, 0.55)
    eye = region[:, 0] > 0.5
    band = region[:, 1] > 0.5
    skin = ~(eye | band)
    x, y, z = P[:, 0], P[:, 1], P[:, 2]

    # ------------------------------------------------------------------ skin
    si = np.nonzero(skin)[0]
    if si.size:
        p = P[si]
        sx = np.where(p[:, 0] >= 0, 1.0, -1.0)
        e = np.stack([sx * ah.EYE_X, np.zeros_like(sx), np.zeros_like(sx)], axis=1)
        rel = p - e
        de = np.linalg.norm(rel, axis=1) - ah.EYE_R          # height above the eyeball
        lat = sx * rel[:, 0]                                  # lateral (+) / medial (-) from eye centre
        up = rel[:, 2]
        col = np.tile(SKIN_BACK, (si.size, 1))
        h = np.zeros(si.size)
        rough = np.full(si.size, 0.52)
        # mottling + ruddy nose bridge / cheeks, slightly darker tired under-eyes
        col *= (1 + 0.08 * fbm(p / (8 * MM), 3)[:, None] + 0.03 * fbm(p / (2 * MM) + 4.0, 2)[:, None])
        nose = gauss(p[:, 0], 0.010) * smoothstep(0.004, -0.012, p[:, 2])
        cheek = gauss(np.abs(p[:, 0]) - 0.045, 0.012) * gauss(p[:, 2] + 0.020, 0.010)
        red = srgb_to_lin([0.66, 0.46, 0.41])
        w = np.clip(0.45 * nose + 0.35 * cheek, 0, 1)[:, None]
        col = col * (1 - w) + red * w
        under = gauss(up + 0.0085, 0.0045) * gauss(lat - 0.002, 0.014) * smoothstep(0.009, 0.002, de)
        col *= (1 - 0.22 * under)[:, None] * np.array([1.0, 0.97, 1.02])
        # upper lid crease (fold) + lid shading
        crease_d = np.abs(de - 0.0029) * (up > 0.0035)
        cr = gauss(crease_d, 0.0005) * (up > 0.0035) * gauss(lat, 0.016)
        h -= 0.15 * MM * cr
        col *= (1 - 0.25 * cr)[:, None]
        # lash line (upper strong, lower faint) + wet lid margin
        rim = smoothstep(0.0021, 0.0009, de)
        lash_u = rim * (up > -0.001) * smoothstep(0.0, 0.003, up + 0.002)
        lash_l = rim * (up < 0.0) * 0.45
        lash = np.clip(lash_u * (0.8 + 0.2 * smoothstep(-0.01, 0.008, lat)) + lash_l, 0, 1)
        col = col * (1 - 0.85 * lash[:, None]) + srgb_to_lin([0.05, 0.04, 0.035]) * 0.85 * lash[:, None]
        wet = smoothstep(0.0009, 0.0003, de)
        col = col * (1 - wet[:, None]) + srgb_to_lin([0.62, 0.40, 0.38]) * wet[:, None]
        rough = rough - 0.35 * wet - 0.1 * lash
        # caruncle (pink inner corner)
        car = gauss(lat + 0.0135, 0.0025) * gauss(up + 0.0005, 0.002) * smoothstep(0.003, 0.0, de)
        col = col * (1 - car[:, None]) + srgb_to_lin([0.70, 0.42, 0.40]) * car[:, None]
        # eyebrows: arch above each eye, thick medially, hair strokes along the brow
        bx = lat
        bz = 0.0125 + 0.0042 * (1 - ((bx - 0.003) / 0.026) ** 2) - 0.0018 * smoothstep(0.0, 0.026, bx)
        thick = 0.0034 * (1 - 0.55 * smoothstep(-0.02, 0.026, bx))
        inb = smoothstep(0.5, -0.2, np.abs(up - bz) / thick - 1.0) * smoothstep(-0.024, -0.017, bx) * smoothstep(0.031, 0.024, bx)
        strokes = 0.5 + 0.5 * vnoise(np.c_[bx / (2.2 * MM), (up - bz) / (0.45 * MM) + bx / (1.2 * MM), np.zeros_like(bx)])
        hair = np.clip(inb * (0.55 + 0.6 * strokes), 0, 1)
        col = col * (1 - 0.8 * hair[:, None]) + srgb_to_lin([0.10, 0.075, 0.06]) * 0.8 * hair[:, None]
        h += 0.12 * MM * hair * strokes
        rough += 0.1 * hair
        # forehead lines + crow's feet (faint), pores
        fh = smoothstep(0.016, 0.022, p[:, 2])
        for zz in (0.0235, 0.0275, 0.0312):
            h -= 0.06 * MM * gauss(p[:, 2] - zz - 0.002 * np.cos(p[:, 0] / 0.03), 0.0005) * fh * gauss(p[:, 0], 0.03)
        crow = gauss(lat - 0.028, 0.004) * gauss(up, 0.006)
        h -= 0.05 * MM * crow * smoothstep(0.75, 0.95, ridged(p / (1.4 * MM), 2))
        h += 0.008 * MM * fbm(p / (0.35 * MM), 2)
        # old scar through the right eyebrow (character, reads in the flash)
        sc = gauss((p[:, 0] - 0.040) * 0.94 - (p[:, 2] - 0.012) * 0.34, 0.0006) * gauss(p[:, 2] - 0.013, 0.006)
        col = col * (1 - 0.35 * sc[:, None]) + srgb_to_lin([0.78, 0.62, 0.58]) * 0.35 * sc[:, None]
        h += 0.08 * MM * sc
        # grime smudges
        sm = smoothstep(0.45, 0.8, fbm(p / (9 * MM) + 21.0, 3)) * 0.35
        col = col * (1 - sm[:, None] * 0.5) + srgb_to_lin([0.25, 0.21, 0.18]) * (sm[:, None] * 0.5)
        lum = (col @ np.array([0.2126, 0.7152, 0.0722]))[:, None]
        col = lum + (col - lum) * 0.82
        C[si] = col
        H[si] = h
        R[si] = np.clip(rough, 0.15, 0.9)

    # ------------------------------------------------------------------ eyes
    ei = np.nonzero(eye)[0]
    if ei.size:
        p = P[ei]
        sx = np.where(p[:, 0] >= 0, 1.0, -1.0)
        e = np.stack([sx * ah.EYE_X, np.zeros_like(sx), np.zeros_like(sx)], axis=1)
        d = p - e
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        alpha = np.degrees(np.arccos(np.clip(d[:, 1], -1, 1)))
        phi = np.arctan2(d[:, 2], d[:, 0] * sx)
        sclera = srgb_to_lin([0.74, 0.72, 0.68])
        corner = smoothstep(40, 70, alpha) * gauss(np.abs(np.cos(phi)) - 1, 0.6)
        col = np.tile(sclera, (ei.size, 1)) * (1 - 0.15 * corner)[:, None] + srgb_to_lin([0.70, 0.50, 0.48]) * (0.15 * corner)[:, None]
        veins = smoothstep(0.82, 0.96, ridged(np.c_[phi * 6.0, alpha / 9.0, sx * 3.0], 2)) * smoothstep(38, 60, alpha)
        col = col * (1 - 0.25 * veins[:, None]) + srgb_to_lin([0.62, 0.30, 0.28]) * 0.25 * veins[:, None]
        # iris: hazel-brown with radial fibres, darker limbal ring, pupil
        ai, ap = 28.5, 9.5
        iris = smoothstep(ai + 0.8, ai - 0.8, alpha)
        rr = np.clip((alpha - ap) / (ai - ap), 0, 1)
        fib = 0.5 + 0.5 * vnoise(np.c_[np.cos(phi) * 9, np.sin(phi) * 9, rr * 2.5 + sx * 5])
        fib2 = 0.5 + 0.5 * vnoise(np.c_[np.cos(phi) * 30, np.sin(phi) * 30, rr * 1.0])
        ic_in = srgb_to_lin([0.42, 0.30, 0.15])
        ic_out = srgb_to_lin([0.24, 0.20, 0.13])
        ic = ic_in * (1 - rr[:, None]) + ic_out * rr[:, None]
        ic = ic * (0.7 + 0.45 * fib[:, None] * (0.6 + 0.4 * fib2[:, None]))
        limbal = smoothstep(ai - 3.5, ai, alpha) * iris
        ic = ic * (1 - 0.6 * limbal[:, None])
        col = col * (1 - iris[:, None]) + ic * iris[:, None]
        pupil = smoothstep(ap + 0.6, ap - 0.6, alpha)
        col = col * (1 - pupil[:, None]) + srgb_to_lin([0.012, 0.010, 0.010]) * pupil[:, None]
        C[ei] = col
        R[ei] = 0.06
        H[ei] = 0.0

    # ------------------------------------------------------------------ bandana
    bi = np.nonzero(band)[0]
    if bi.size:
        p = P[bi]
        a = np.arctan2(p[:, 0], p[:, 1] - ah.AXIS_Y)
        zt = ah.bandana_top_z(a)
        zb = ah.bandana_bottom_z(a)
        v = np.clip((zt - p[:, 2]) / np.maximum(zt - zb, 1e-4), -0.1, 1.1)   # 0 top .. 1 bottom edge
        s_arc = a * 0.085
        # twill weave (diagonal), 0.9 mm
        tw = 0.5 + 0.5 * np.sin(2 * math.pi * (s_arc + p[:, 2]) / (0.9 * MM))
        warp = 0.5 + 0.5 * np.sin(2 * math.pi * s_arc / (0.45 * MM))
        h = 0.035 * MM * tw + 0.012 * MM * warp
        # folds: compression folds across the nose tent + hanging drape folds
        front = np.clip(np.cos(a), 0, 1)
        fold1 = np.sin(2 * math.pi * (p[:, 2] / 0.013) + 2.4 * a + 4.0 * fbm(p / 0.018, 2)) * gauss(v - 0.22, 0.14) * front
        fold1 *= 0.5 + 0.5 * smoothstep(-0.2, 0.5, fbm(p / 0.025 + 2.0, 2))
        fold2 = np.sin(9.0 * a + 0.7 + 2.0 * np.clip(v - 0.5, 0, 1)) * smoothstep(0.45, 0.95, v) * front
        fold3 = fbm(np.c_[a * 3.0, p[:, 2] / 0.025, np.zeros_like(a)], 3)
        h += 0.30 * MM * fold1 + 0.55 * MM * fold2 + 0.40 * MM * fold3
        # hems: folded edge along top and bottom with a stitch line
        d_top = (zt - p[:, 2])
        d_bot = (p[:, 2] - zb)
        hem = smoothstep(0.0065, 0.004, d_top) + smoothstep(0.0065, 0.004, d_bot)
        h += 0.25 * MM * hem
        stitch = (gauss(d_top - 0.0052, 0.00035) + gauss(d_bot - 0.0052, 0.00035)) * (0.5 + 0.5 * np.sin(2 * math.pi * s_arc / (2.6 * MM)) > 0.25)
        h -= 0.08 * MM * stitch
        # colour: faded charcoal-olive cotton with a worn print (border lines + small teardrops)
        base = srgb_to_lin([0.255, 0.255, 0.230])
        col = np.tile(base, (bi.size, 1)) * (0.92 + 0.12 * tw[:, None])
        border = gauss(d_top - 0.012, 0.0011) + gauss(d_bot - 0.012, 0.0011) + gauss(d_bot - 0.0165, 0.0007)
        gu = (s_arc / 0.014) % 1.0 - 0.5
        gv = (p[:, 2] / 0.014 + 0.5 * (np.floor(s_arc / 0.014) % 2)) % 1.0 - 0.5
        drop = smoothstep(0.24, 0.18, np.hypot(gu * 1.0, (gv + 0.12 * np.sign(gu) * gu) * 1.5))
        drop *= smoothstep(0.016, 0.024, np.minimum(d_top, d_bot))
        printing = np.clip(0.8 * border + 0.55 * drop, 0, 1) * (0.55 + 0.45 * fbm(p / (3 * MM) + 7.0, 2))
        col = col * (1 - 0.45 * printing[:, None]) + srgb_to_lin([0.50, 0.47, 0.40]) * 0.45 * printing[:, None]
        # wear: dust on fold ridges, darker in valleys, stain
        ridge = np.clip(h / (0.6 * MM), -1, 1)
        col *= (1 + 0.10 * ridge)[:, None]
        dust = smoothstep(0.35, 0.8, fbm(p / (12 * MM) + 3.0, 3)) * 0.3
        col = col * (1 - dust[:, None]) + srgb_to_lin([0.42, 0.39, 0.34]) * dust[:, None]
        C[bi] = col
        H[bi] = h
        R[bi] = 0.86 - 0.04 * tw
    return H, C, R


def evaluate_beanie(P: np.ndarray, N: np.ndarray):
    """Light-neutral heathered knit (the game tints it per player)."""
    a, v, psi = ah.beanie_coords(P)
    n = len(P)
    s_mer = psi * 0.098                       # arc length from the crown (m)
    cuff = v >= ah.BEANIE_CUFF_V
    # crown: stockinette columns converge toward the top (decreases every few rows)
    ncols = np.where(cuff, 150, np.clip(np.round(150 * np.sin(np.clip(psi, 0.05, 3)) / np.sin(1.35) / 6) * 6, 24, 150))
    cx = (a / (2 * math.pi) * ncols) % 1.0 - 0.5
    row_h = 2.6 * MM
    ry = (s_mer / row_h) % 1.0
    vst = np.abs(((np.abs(cx) * 1.4 + ry) % 1.0) - 0.5) * 2         # V-shaped stitch legs
    stitch = 1 - vst
    colgap = gauss(np.abs(cx) - 0.5, 0.12)
    h_crown = 0.32 * MM * stitch ** 1.5 - 0.22 * MM * colgap
    # cuff: 2x2 rib (knit columns raised, purl columns sunk) + stitches on the ribs
    rib_cols = 150
    rc = (a / (2 * math.pi) * rib_cols) % 4.0
    knit = (rc < 2.0)
    ribprof = 0.5 + 0.5 * np.cos(2 * math.pi * (a / (2 * math.pi) * rib_cols / 4.0))
    h_cuff = 0.85 * MM * ribprof ** 0.8 + 0.22 * MM * stitch * knit
    # fold line at the top of the cuff and the rolled bottom
    v_rel = (v - ah.BEANIE_CUFF_V) / (1 - ah.BEANIE_CUFF_V)
    h = np.where(cuff, h_cuff, h_crown)
    h -= 0.5 * MM * gauss(v - ah.BEANIE_CUFF_V, 0.012)
    fuzz = fbm(P / (0.5 * MM), 2)
    h += 0.04 * MM * fuzz
    # heathered light yarn
    base = srgb_to_lin([0.80, 0.79, 0.76])
    speck = smoothstep(0.55, 0.85, vnoise(P / (0.7 * MM) + 3.0))
    speck2 = smoothstep(0.6, 0.9, vnoise(P / (0.9 * MM) + 11.0))
    col = np.tile(base, (n, 1))
    col *= (1 - 0.18 * speck[:, None] + 0.06 * speck2[:, None])
    cav = np.clip(-h / (0.4 * MM), 0, 1)
    shade = np.where(cuff, 0.78 + 0.22 * ribprof ** 0.7, 0.84 + 0.16 * stitch)
    col *= shade[:, None] * (1 - 0.2 * cav)[:, None]
    # grime at the lower edge (forehead contact) and a few pills / dust
    grime = smoothstep(0.92, 1.0, v) * 0.18 + smoothstep(0.55, 0.85, fbm(P / (10 * MM) + 5.0, 3)) * 0.10
    col = col * (1 - grime[:, None]) + srgb_to_lin([0.45, 0.42, 0.37]) * grime[:, None]
    rough = np.full(n, 0.95)
    _ = v_rel
    return h, col, rough


def build() -> None:
    """Helper module (imported by avatar.py): nothing to build on its own."""


# ---------------------------------------------------------------------------------------------
# Body
# ---------------------------------------------------------------------------------------------

def _line(d, w):
    return gauss(d, w)


def evaluate_body(P: np.ndarray, N: np.ndarray, region: np.ndarray):
    import avatar_body as ab
    n = len(P)
    part = np.round(region[:, 0] * 10).astype(int)
    H = np.zeros(n)
    C = np.zeros((n, 3))
    R = np.full(n, 0.85)
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    weave = 0.5 + 0.5 * np.sin(2 * math.pi * (x + y + z) / (0.8 * MM)) * np.sin(2 * math.pi * (x - y + 0.5 * z) / (0.8 * MM))

    # ---------------- jacket (torso, collar, sleeves): olive canvas
    jk = np.isin(part, (ab.PART_JACKET, ab.PART_COLLAR, ab.PART_SLEEVE))
    ji = np.nonzero(jk)[0]
    if ji.size:
        p = P[ji]
        pj = part[ji]
        h = 0.02 * MM * weave[ji]
        phi = np.arctan2(p[:, 0], p[:, 1])          # 0 = front centre
        sleeve = pj == ab.PART_SLEEVE
        # sleeve coordinate along the stub (0 shoulder .. 1 end)
        sx = np.where(p[:, 0] >= 0, 1.0, -1.0)
        top = np.stack([ab.ARM_TOP[0] * sx, np.full_like(sx, ab.ARM_TOP[1]), np.full_like(sx, ab.ARM_TOP[2])], 1)
        dirs = np.stack([ab.ARM_DIR[0] * sx, np.full_like(sx, ab.ARM_DIR[1]), np.full_like(sx, ab.ARM_DIR[2])], 1)
        st = np.sum((p - top) * dirs, 1) / ab.ARM_LEN
        # seams: shoulder line, side seams, armhole seam on the sleeve, sleeve hem, jacket hem
        seam = np.zeros(ji.size)
        on_t = ~sleeve
        seam += on_t * _line(p[:, 1] + 0.006, 0.0012) * (p[:, 2] > -0.07)                      # shoulder seam
        seam += on_t * _line(np.abs(phi) - math.pi / 2, 0.012) * (p[:, 2] < -0.13)             # side seams
        seam += sleeve * _line(st - 0.20, 0.010)                                               # armhole
        seam += sleeve * _line(st - 0.86, 0.008)                                               # cuff seam
        seam += on_t * _line(p[:, 2] + 0.505, 0.0015)                                          # hem band
        # zipper + placket down the front
        zfront = on_t * (np.abs(p[:, 0]) < 0.006) * (p[:, 1] > 0)
        teeth = 0.5 + 0.5 * np.sin(2 * math.pi * p[:, 2] / (2.2 * MM))
        h += zfront * (0.35 * MM + 0.12 * MM * teeth)
        plack = on_t * (p[:, 1] > 0) * (_line(np.abs(p[:, 0]) - 0.016, 0.0009) + _line(np.abs(p[:, 0]) - 0.0065, 0.0008))
        # chest pockets with flaps
        px = np.abs(p[:, 0]) - 0.072
        pz = p[:, 2] + 0.135
        pocket = on_t * (p[:, 1] > 0.05) * smoothstep(0.003, 0.0, np.maximum(np.abs(px) - 0.033, np.abs(pz) - 0.040))
        flap = on_t * (p[:, 1] > 0.05) * smoothstep(0.002, 0.0, np.maximum(np.abs(px) - 0.035, np.abs(pz - 0.030) - 0.013))
        h += 0.5 * MM * pocket + 0.6 * MM * flap
        pocket_edge = on_t * (p[:, 1] > 0.05) * (gauss(np.maximum(np.abs(px) - 0.033, np.abs(pz) - 0.040), 0.0012) + gauss(np.maximum(np.abs(px) - 0.035, np.abs(pz - 0.030) - 0.013), 0.001))
        seam += pocket_edge * 0.8
        # folds: waist bunching, diagonal drape, sleeve wrinkles, compression next to the straps
        f1 = np.sin(p[:, 2] / 0.022 * 2 * math.pi + 1.6 * phi + 6 * fbm(p / 0.045, 3)) * smoothstep(-0.25, -0.33, p[:, 2]) * smoothstep(-0.52, -0.46, p[:, 2])
        f1 *= (0.25 + 0.75 * np.abs(np.sin(phi))) * smoothstep(-0.3, 0.4, fbm(p / 0.06 + 5.0, 2))
        f2 = np.sin((p[:, 2] - 0.6 * np.abs(p[:, 0])) / 0.03 * 2 * math.pi + 2 * fbm(p / 0.04 + 1, 2)) * smoothstep(-0.02, -0.08, p[:, 2]) * smoothstep(-0.26, -0.16, p[:, 2]) * (p[:, 1] > 0)
        f3 = np.sin(st / 0.11 * 2 * math.pi + 2.5 * fbm(p / 0.03, 2)) * smoothstep(0.35, 0.6, st) * sleeve
        f4 = fbm(p / 0.035, 3)
        h += 0.8 * MM * f1 + 0.6 * MM * f2 + 0.9 * MM * f3 + 0.9 * MM * f4
        h -= 0.18 * MM * seam
        # colour
        base = srgb_to_lin([0.315, 0.305, 0.238])
        col = np.tile(base, (ji.size, 1)) * (0.9 + 0.14 * weave[ji][:, None])
        col *= (1 + 0.10 * fbm(p / 0.03 + 4.0, 3))[:, None]
        thread = srgb_to_lin([0.42, 0.40, 0.31])
        col = col * (1 - 0.45 * np.clip(seam, 0, 1)[:, None]) + thread * 0.45 * np.clip(seam, 0, 1)[:, None]
        col = col * (1 - 0.35 * np.clip(plack, 0, 1)[:, None]) + thread * 0.35 * np.clip(plack, 0, 1)[:, None]
        ridge = np.clip(h / (0.8 * MM), -1, 1)
        col *= (1 + 0.12 * ridge)[:, None]                         # abrasion on fold ridges, darker valleys
        zipcol = srgb_to_lin([0.16, 0.15, 0.13]) * (0.7 + 0.5 * teeth)[:, None]
        col = col * (1 - zfront[:, None]) + zipcol * zfront[:, None]
        # patch repair on the left sleeve
        patch = sleeve * (sx < 0) * smoothstep(0.004, 0.0, np.maximum(np.abs(st - 0.48) * ab.ARM_LEN - 0.028, np.abs(phi + 1.2) * 0.06 - 0.022))
        col = col * (1 - 0.8 * patch[:, None]) + srgb_to_lin([0.24, 0.22, 0.18]) * 0.8 * patch[:, None]
        h += 0.35 * MM * patch
        # mud / dirt and the fade into shadow (sleeve ends, jacket bottom): the arms and legs
        # "continue into the dark" instead of ending in a visible cut
        mud = smoothstep(0.55, 0.85, fbm(p / 0.012 + 8.0, 3)) * (0.3 + 0.7 * smoothstep(-0.30, -0.52, p[:, 2]))
        col = col * (1 - 0.45 * mud[:, None]) + srgb_to_lin([0.20, 0.17, 0.12]) * 0.45 * mud[:, None]
        fade = np.where(sleeve, smoothstep(0.50, 0.97, st), smoothstep(-0.30, -0.55, p[:, 2]) * on_t)
        col *= (1 - 0.86 * fade ** 0.8)[:, None]
        C[ji] = col
        H[ji] = h
        R[ji] = 0.86 - 0.35 * zfront + 0.05 * mud

    # ---------------- hood: heather-gray cotton jersey, soft lumps
    hi = np.nonzero(part == ab.PART_HOOD)[0]
    if hi.size:
        p = P[hi]
        jers = 0.5 + 0.5 * np.sin(2 * math.pi * p[:, 0] / (0.7 * MM)) * np.sin(2 * math.pi * p[:, 2] / (0.5 * MM))
        h = 0.02 * MM * jers + 1.2 * MM * fbm(p / 0.02, 3) + 0.5 * MM * fbm(p / 0.008 + 3.0, 2)
        cseam = gauss(p[:, 0], 0.0015) * (p[:, 1] < -0.05)
        h -= 0.3 * MM * cseam
        base = srgb_to_lin([0.40, 0.405, 0.415])
        heather = 1 + 0.12 * vnoise(p / (0.6 * MM)) + 0.08 * fbm(p / 0.02, 2)
        col = np.tile(base, (hi.size, 1)) * heather[:, None]
        col *= (1 + 0.15 * np.clip(h / (1.2 * MM), -1, 1))[:, None]
        C[hi] = col
        H[hi] = h
        R[hi] = 0.92

    # ---------------- straps / sternum strap: black nylon webbing
    si = np.nonzero(part == ab.PART_STRAP)[0]
    if si.size:
        p = P[si]
        rib = 0.5 + 0.5 * np.sin(2 * math.pi * (p[:, 0] * 0.3 + p[:, 2]) / (1.1 * MM))
        h = 0.05 * MM * rib + 0.15 * MM * fbm(p / 0.01, 2)
        col = np.tile(srgb_to_lin([0.075, 0.075, 0.08]), (si.size, 1)) * (0.85 + 0.3 * rib[:, None])
        wear = smoothstep(0.5, 0.85, fbm(p / 0.015 + 2.0, 3)) * 0.4
        col = col * (1 - wear[:, None]) + srgb_to_lin([0.16, 0.155, 0.15]) * wear[:, None]
        C[si] = col
        H[si] = h
        R[si] = 0.62
    bk = np.nonzero(part == ab.PART_BUCKLE)[0]
    if bk.size:
        C[bk] = srgb_to_lin([0.05, 0.05, 0.05])
        R[bk] = 0.35

    # ---------------- backpack: faded slate canvas, piping seams, pocket zipper, dirty bottom
    bi = np.nonzero(part == ab.PART_PACK)[0]
    if bi.size:
        p = P[bi]
        nn = np.abs(N[bi])
        mx = nn.max(axis=1)
        pipe = gauss(mx - 0.72, 0.06)
        h = 0.025 * MM * weave[bi] + 0.6 * MM * pipe + 0.6 * MM * fbm(p / 0.04, 3) + 0.25 * MM * fbm(p / 0.01, 2)
        zipper = gauss(np.hypot(np.maximum(np.abs(p[:, 0]) - 0.085, 0), np.maximum(np.abs(p[:, 2] + 0.335) - 0.075, 0)) - 0.016, 0.0018) * (p[:, 1] < -0.27)
        h += 0.3 * MM * zipper
        base = srgb_to_lin([0.205, 0.225, 0.255])
        col = np.tile(base, (bi.size, 1)) * (0.9 + 0.15 * weave[bi][:, None]) * (1 + 0.12 * fbm(p / 0.03 + 6.0, 3))[:, None]
        col = col * (1 + 0.25 * pipe)[:, None]
        col = col * (1 - 0.6 * zipper[:, None]) + srgb_to_lin([0.05, 0.05, 0.05]) * 0.6 * zipper[:, None]
        dirt = smoothstep(-0.40, -0.48, p[:, 2]) * 0.5 + smoothstep(0.6, 0.9, fbm(p / 0.015 + 9.0, 3)) * 0.3
        col = col * (1 - dirt[:, None]) + srgb_to_lin([0.23, 0.20, 0.16]) * dirt[:, None]
        C[bi] = col
        H[bi] = h
        R[bi] = 0.82

    ii = np.nonzero(part == ab.PART_INNER)[0]
    if ii.size:
        C[ii] = srgb_to_lin([0.025, 0.025, 0.025])
        R[ii] = 0.95
    return H, C, R


def evaluate_tint_tape(P: np.ndarray, N: np.ndarray):
    """Reflective tape (light neutral, tinted per player): micro-prism grid, stitched edges, wear."""
    n = len(P)
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    g1 = 0.5 + 0.5 * np.cos(2 * math.pi * (x + z) / (0.9 * MM))
    g2 = 0.5 + 0.5 * np.cos(2 * math.pi * (x - z + y) / (0.9 * MM))
    prism = g1 * g2
    h = 0.03 * MM * prism + 0.15 * MM * fbm(P / 0.02, 2)
    col = np.tile(srgb_to_lin([0.80, 0.80, 0.78]), (n, 1)) * (0.9 + 0.12 * prism[:, None])
    wear = smoothstep(0.45, 0.85, fbm(P / 0.01 + 4.0, 3)) * 0.45
    col = col * (1 - wear[:, None]) + srgb_to_lin([0.45, 0.43, 0.38]) * wear[:, None]
    return h, col, np.full(n, 0.38) + 0.3 * wear
