"""Vireek logo geometry. Single source of truth for every brand SVG/PNG.

Letterforms: ORIGINAL — V, i, r, e, k are constructed in letters.py from circles,\nrectangles and polygons (no font outlines, nothing derived from a typeface).\nOutput is paths only.\n\nRequires: fonttools (path pens), skia-pathops.
"""
import os
from fontTools.ttLib import TTFont
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.svgPathPen import SVGPathPen
from pathops import Path, op, PathOp

FONT = os.environ.get('VIREEK_SORA_WOFF')   # only needed for the OG-image tagline (raster); the logo itself uses no font

# ---- palette (matches src/index.css tokens) ---------------------------------
INDIGO, INDIGO_DK = '#203AD8', '#6C82FF'     # --accent-primary light / dark
ORANGE, ORANGE_DK = '#C14F26', '#FF8A5A'     # --logo-accent light (AA, 4.6:1) / dark = --accent-secondary dark
INK, PAPER = '#17171A', '#F2F1EE'            # --text-primary light / dark

# ---- helpers ------------------------------------------------------------------
def poly(pts):
    p = Path(); pen = p.getPen(); pen.moveTo(pts[0])
    for q in pts[1:]: pen.lineTo(q)
    pen.closePath(); return p
def circle(cx, cy, r):
    k = 0.5522847498 * r; p = Path(); pen = p.getPen()
    pen.moveTo((cx + r, cy)); pen.curveTo((cx + r, cy + k), (cx + k, cy + r), (cx, cy + r))
    pen.curveTo((cx - k, cy + r), (cx - r, cy + k), (cx - r, cy)); pen.curveTo((cx - r, cy - k), (cx - k, cy - r), (cx, cy - r))
    pen.curveTo((cx + k, cy - r), (cx + r, cy - k), (cx + r, cy)); pen.closePath(); return p
def rrect(x, y, w, h, r):
    k = 0.5522847498 * r; p = Path(); pen = p.getPen()
    pen.moveTo((x + r, y)); pen.lineTo((x + w - r, y)); pen.curveTo((x + w - r + k, y), (x + w, y + r - k), (x + w, y + r))
    pen.lineTo((x + w, y + h - r)); pen.curveTo((x + w, y + h - r + k), (x + w - r + k, y + h), (x + w - r, y + h))
    pen.lineTo((x + r, y + h)); pen.curveTo((x + r - k, y + h), (x, y + h - r + k), (x, y + h - r))
    pen.lineTo((x, y + r)); pen.curveTo((x, y + r - k), (x + r - k, y), (x + r, y)); pen.closePath(); return p
def union(*ps):
    r = None
    for p in ps: r = p if r is None else op(r, p, PathOp.UNION)
    return r
def xform(p, s=1, tx=0, ty=0):
    out = Path(); p.draw(TransformPen(out.getPen(), (s, 0, 0, s, tx, ty))); return out
def num(v):
    v = round(v, 1)
    return str(int(v)) if v == int(v) else ('%.1f' % v).lstrip('0') if 0 < v < 1 else ('%.1f' % v).replace('-0.', '-.')
def D(p):
    pen = SVGPathPen(None, ntos=num); p.draw(pen); return pen.getCommands()

# ---- the V (symmetric, redrawn) ----------------------------------------------
VCX = 363
V_PTS = [(21, -730), (168, -730), (346, -118), (380, -118), (558, -730), (705, -730), (480, 0), (246, 0)]
def V(x=0, dy=0): return poly([(px + x, py + dy) for px, py in V_PTS])

# ---- wordmark -------------------------------------------------------------------
DOT_R = 80
def wordmark_paths():
    """returns (ink Path, dot Path); original letterforms, baseline y=0."""
    from letters import build_word
    ink, dot = build_word('A', True)
    # separate the accent circle from the ink for two-colour output
    return ink, dot

# ---- symbol: V with the pulse dot in its opening -----------------------------
SYM_DOT = (VCX, -575, 72)
def symbol_paths(): return V(), circle(*SYM_DOT)

def bounds(*ps):
    bs = [p.bounds for p in ps]; return (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))
def normalize(parts):
    """translate list of Paths so combined bbox starts at (0,0); returns (parts, w, h)"""
    x0, y0, x1, y1 = bounds(*parts)
    return [xform(p, 1, -x0, -y0) for p in parts], x1 - x0, y1 - y0

# ---- tile (app-icon style rounded square holding the symbol) -----------------
def tile_parts(S=1000, radius=0.225, vh=0.55, dy=0.0):
    """returns tile bg, V, dot (Paths) in a SxS box, plus mono knock-out path"""
    v, dot = symbol_paths()
    x0, y0, x1, y1 = bounds(v)                       # V bbox
    s = vh * S / (y1 - y0)
    cx, cy = S / 2, S / 2 + dy * S
    tx = cx - s * (x0 + x1) / 2; ty = cy - s * (y0 + y1) / 2
    bg = rrect(0, 0, S, S, radius * S)
    tv, td = xform(v, s, tx, ty), xform(dot, s, tx, ty)
    mono = op(op(bg, tv, PathOp.DIFFERENCE), td, PathOp.DIFFERENCE)
    return bg, tv, td, mono

def fullbleed_icon(S=1024, vh=0.50, dy=0.0):
    bg = Path(); bg = poly([(0, 0), (S, 0), (S, S), (0, S)])
    _, tv, td, _ = tile_parts(S, 0.2, vh, dy)
    return bg, tv, td

# ---- lockups -------------------------------------------------------------------
def lockup_horizontal():
    T = 1000
    bg, tv, td, mono = tile_parts(T)
    ink, dot = wordmark_paths()
    wx0, wy0, wx1, wy1 = bounds(ink, dot)
    s = 0.86                       # wordmark scale: cap height = 0.86*730 ≈ 628 (tile 1000)
    gap = 300
    # vertically centre the cap-height band (-730..0) on the tile centre
    tx = T + gap - s * 21; ty = T / 2 + s * 365
    return dict(bg=bg, tv=tv, td=td, mono=mono, ink=xform(ink, s, tx, ty), dot=xform(dot, s, tx, ty))
def lockup_stacked():
    T = 1000
    bg, tv, td, mono = tile_parts(T)
    ink, dot = wordmark_paths()
    s = 0.62
    wx0, wy0, wx1, wy1 = bounds(ink, dot)
    ww = (wx1 - wx0) * s
    tx = T / 2 - ww / 2 - s * wx0
    ty = T + 330 + s * 730       # baseline below tile
    return dict(bg=bg, tv=tv, td=td, mono=mono, ink=xform(ink, s, tx, ty), dot=xform(dot, s, tx, ty))
