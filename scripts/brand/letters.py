"""Original Vireek letterforms (i r e k) built from geometric primitives — no font outlines.

Units: 1000/em, y down, baseline y=0, x-height 534, cap/ascender 730.
Stroke: STEM (straight stems) / RING (round strokes, optically a touch lighter).
Every shape is a boolean of circles, rectangles and polygons, so curves stay exact and compact.
"""
import math
from pathops import Path, op, PathOp
from geometry import poly, circle, union, xform

STEM = 142
RING = 134
XH = 534
OVER = 9          # round overshoot above/below x-height and baseline
ASC = 730

def rect(x0, y0, x1, y1): return poly([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])
def diff(a, b): return op(a, b, PathOp.DIFFERENCE)
def inter(a, b): return op(a, b, PathOp.INTERSECTION)
def pol(c, r, deg): return (c[0] + r * math.cos(math.radians(deg)), c[1] - r * math.sin(math.radians(deg)))   # y-down, CCW-positive degrees

def stroke_seg(p0, p1, w, ext=0):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]; L = math.hypot(dx, dy); ux, uy = dx / L, dy / L; nx, ny = -uy, ux
    a = (p0[0] - ux * ext, p0[1] - uy * ext); b = (p1[0] + ux * ext, p1[1] + uy * ext)
    return poly([(a[0] + nx * w / 2, a[1] + ny * w / 2), (b[0] + nx * w / 2, b[1] + ny * w / 2),
                 (b[0] - nx * w / 2, b[1] - ny * w / 2), (a[0] - nx * w / 2, a[1] - ny * w / 2)])

def letter_i():
    return rect(0, -XH, STEM, 0), STEM          # path, advance width of ink

def letter_r():
    Ro = 262; Ri = Ro - RING
    cx = Ro; cy = -XH + Ro                 # arc centre; left leg flush with stem x=0
    ring = diff(circle(cx, cy, Ro), circle(cx, cy, Ri))
    far = 900
    wedge = poly([(cx, cy), pol((cx, cy), far, 180), pol((cx, cy), far, 90), pol((cx, cy), far, 55)])
    return union(rect(0, -XH, STEM, 0), inter(ring, wedge))

def letter_e(parts=False):
    R = (XH + 2 * OVER) / 2; r = R - RING
    cx, cy = R, -XH / 2
    ring = diff(circle(cx, cy, R), circle(cx, cy, r))
    bar_h = 100; bar_y0 = cy - bar_h / 2 + 2
    bar = inter(rect(cx - r - 4, bar_y0, cx + R, bar_y0 + bar_h), circle(cx, cy, R))
    wedge = poly([(cx, bar_y0 + bar_h), (cx + 700, bar_y0 + bar_h), pol((cx, cy), 700, -40)])
    glyph = union(diff(ring, wedge), bar)
    if parts:
        return glyph, inter(bar, circle(cx, cy, r + 1))      # inner crossbar only (concept B accent)
    return glyph

def letter_k():
    stem = rect(0, -ASC, STEM, 0)
    w = 132
    P0 = (STEM - 10, -165); P1 = (STEM + 300, -XH - 20)
    arm = inter(stroke_seg(P0, P1, w, ext=120), rect(STEM * 0.5, -XH, 900, 100))
    t = 0.42; J = (P0[0] + (P1[0] - P0[0]) * t, P0[1] + (P1[1] - P0[1]) * t)
    leg = inter(stroke_seg(J, (STEM + 392, 40), w, ext=0), rect(STEM * 0.5, -XH - 100, 900, 0))
    return union(stem, arm, leg)


# ---- word layout (ink-to-ink gaps tuned by eye, in font units) ------------------------------
from geometry import V, V_PTS, DOT_R
GAPS = dict(i_x=745, ir=78, re=30, ee=54, ek=60)
DOT_Y = -686

def build_word(mode='A', title=True):
    """mode A: orange i-dot | B: orange e-crossbars | C: raised orange V tip. returns (ink, acc|None)."""
    ink, acc = [], []
    if title:
        if mode == 'C':
            ext = 120; idx = (558 - 380) / 612; odx = (705 - 480) / 730
            v = poly([(246, 0), (21, -730), (168, -730), (346, -118), (380, -118), (558 + idx * ext, -730 - ext), (705 + odx * ext, -730 - ext), (480, 0)])
            cut = rect(-100, -2000, 1000, -730)
            ink.append(diff(v, cut)); acc.append(inter(v, cut))
        else: ink.append(V())
        ix = GAPS['i_x']
    else:
        ink.append(xform(V(), XH / 730, -21 * XH / 730, 0)); ix = 21 + (705 - 21) * XH / 730 - 21 * XH / 730 + 40   # small v for the case test
    ink.append(xform(letter_i()[0], 1, ix, 0))
    if mode == 'A': dot = circle(ix + STEM / 2, DOT_Y, DOT_R); acc.append(dot)
    else: ink.append(circle(ix + STEM / 2, DOT_Y, 76))
    x = ix + STEM + GAPS['ir']
    r = letter_r(); rb = r.bounds; ink.append(xform(r, 1, x - rb[0], 0)); x = x - rb[0] + rb[2] + GAPS['re']
    for gap in (0, GAPS['ee']):
        x += gap
        if mode == 'B':
            g, bar = letter_e(parts=True); b = g.bounds
            ink.append(diff(xform(g, 1, x - b[0], 0), xform(bar, 1, x - b[0], 0))); acc.append(xform(bar, 1, x - b[0], 0))
        else:
            g = letter_e(); b = g.bounds; ink.append(xform(g, 1, x - b[0], 0))
        x = x - b[0] + b[2]
    x += GAPS['ek']
    k = letter_k(); kb = k.bounds; ink.append(xform(k, 1, x - kb[0], 0))
    return union(*ink), (union(*acc) if acc else None)
