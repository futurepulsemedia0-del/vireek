"""Three explored wordmark concepts (A is shipped). Used only by build_preview.py."""
from geometry import *
from letters import build_word, rect, diff, inter

def rpill(x0, y0, x1, y1):
    r = (x1 - x0) / 2; k = 0.5522847498 * r; p = Path(); pen = p.getPen()
    pen.moveTo((x0, y0 + r)); pen.curveTo((x0, y0 + r - k), (x0 + r - k, y0), (x0 + r, y0)); pen.curveTo((x0 + r + k, y0), (x1, y0 + r - k), (x1, y0 + r))
    pen.lineTo((x1, y1 - r)); pen.curveTo((x1, y1 - r + k), (x0 + r + k, y1), (x0 + r, y1)); pen.curveTo((x0 + r - k, y1), (x0, y1 - r + k), (x0, y1 - r)); pen.closePath(); return p

def concept(key):
    """returns dict(word=(ink,acc), sym=(ink,acc), lower=(ink,acc))"""
    if key == 'A':
        return dict(word=build_word('A', True), sym=symbol_paths(), lower=build_word('A', False))
    if key == 'B':
        bars = union(rpill(363 - 70, -640, 363 - 26, -450), rpill(363 + 26, -690, 363 + 70, -430))
        return dict(word=build_word('B', True), sym=(V(), bars))
    ext = 120; idx = (558 - 380) / 612; odx = (705 - 480) / 730
    v = poly([(246, 0), (21, -730), (168, -730), (346, -118), (380, -118), (558 + idx * ext, -730 - ext), (705 + odx * ext, -730 - ext), (480, 0)])
    cut = rect(-100, -2000, 1000, -730)
    return dict(word=build_word('C', True), sym=(diff(v, cut), inter(v, cut)))
