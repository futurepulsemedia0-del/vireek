#!/usr/bin/env python3
"""Render Vireek's app-tile icon set from the real logo geometry. Needs ONLY Pillow (pip install pillow).

  python3 scripts/brand/render_tile_icons.py            # writes into the repo
  python3 scripts/brand/render_tile_icons.py --out DIR  # writes into DIR (same relative layout)

Design = docs rule in BrandLogoGuide.tsx / Logo.tsx TILE_FILL: Clay tile #D97757, Slate "V" #141413, Ivory pulse dot #FAF9F5,
identical in light and dark (fixed-colour app asset). Geometry = public/brand/vireek-tile.svg (V path + dot, viewBox 512).
Shortcut glyphs are the Lucide shapes the app UI already uses (Briefcase / Phone / Inbox), drawn as Slate strokes.
Everything is anti-aliased by supersampling, so output is deterministic and needs no external renderer.
"""
import math, os, re, sys
from PIL import Image, ImageDraw

CLAY, SLATE, IVORY = (217, 119, 87), (20, 20, 19), (250, 249, 245)
V_PATH = 'M0 0H147L325 612H359L537 0H684L459 730H225Z'
DOT_PATH = 'M414 155C414 194.8 381.8 227 342 227C302.2 227 270 194.8 270 155C270 115.2 302.2 83 342 83C381.8 83 414 115.2 414 155Z'
SYM_W, SYM_H = 684.0, 730.0  # V path bounding box


# ------------------------------------------------------------------ minimal SVG path flattening (M L H V C A Z, abs + rel)
def _arc(p0, rx, ry, phi, fa, fs, p1, steps=24):
    (x1, y1), (x2, y2) = p0, p1
    if rx == 0 or ry == 0 or p0 == p1: return [p1]
    rx, ry = abs(rx), abs(ry); phi = math.radians(phi); c, s = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p, y1p = c * dx + s * dy, -s * dx + c * dy
    lam = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2
    if lam > 1: k = math.sqrt(lam); rx, ry = rx * k, ry * k
    num = rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2
    den = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2
    co = math.sqrt(max(0, num / den)) * (-1 if fa == fs else 1)
    cxp, cyp = co * rx * y1p / ry, -co * ry * x1p / rx
    cx, cy = c * cxp - s * cyp + (x1 + x2) / 2, s * cxp + c * cyp + (y1 + y2) / 2
    ang = lambda ux, uy, vx, vy: math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not fs and dt > 0: dt -= 2 * math.pi
    if fs and dt < 0: dt += 2 * math.pi
    return [(cx + rx * math.cos(t1 + dt * i / steps) * c - ry * math.sin(t1 + dt * i / steps) * s,
             cy + rx * math.cos(t1 + dt * i / steps) * s + ry * math.sin(t1 + dt * i / steps) * c) for i in range(1, steps + 1)]


def flatten(d):
    """-> list of (points, closed) sub-paths."""
    toks = re.findall(r'[MmLlHhVvCcAaZz]|-?\d*\.?\d+(?:e-?\d+)?', d)
    i, cmd, cur, start, subs, pts = 0, None, (0.0, 0.0), (0.0, 0.0), [], []
    num = lambda: float(toks[next_i()])
    def next_i():
        nonlocal i; i += 1; return i - 1
    while i < len(toks):
        if re.match(r'[A-Za-z]', toks[i]): cmd = toks[next_i()]
        rel = cmd.islower(); C = cmd.upper(); ox, oy = cur if rel else (0.0, 0.0)
        if C == 'Z':
            if pts: subs.append((pts, True))
            pts, cur = [], start; continue
        if C == 'M':
            if pts: subs.append((pts, False))
            cur = (ox + num(), oy + num()); start = cur; pts = [cur]; cmd = 'l' if rel else 'L'
        elif C == 'L': cur = (ox + num(), oy + num()); pts.append(cur)
        elif C == 'H': cur = ((cur[0] if rel else 0) + num(), cur[1]); pts.append(cur)
        elif C == 'V': cur = (cur[0], (cur[1] if rel else 0) + num()); pts.append(cur)
        elif C == 'C':
            p1 = (ox + num(), oy + num()); p2 = (ox + num(), oy + num()); p3 = (ox + num(), oy + num()); p0 = cur
            for k in range(1, 25):
                t = k / 24; u = 1 - t
                pts.append((u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
                            u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]))
            cur = p3
        elif C == 'A':
            rx, ry, phi, fa, fs = num(), num(), num(), int(num()), int(num())
            end = (ox + num(), oy + num()); pts.extend(_arc(cur, rx, ry, phi, fa, fs, end)); cur = end
    if pts: subs.append((pts, False))
    return subs


# ------------------------------------------------------------------ drawing on a supersampled canvas
SS = 8
class Canvas:
    def __init__(self, size, bg=None):
        self.size = size; self.big = Image.new('RGBA', (size * SS, size * SS), bg + (255,) if bg else (0, 0, 0, 0)); self.d = ImageDraw.Draw(self.big)
    def tile(self, color, radius_ratio):
        s = self.size * SS
        if radius_ratio: self.d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius_ratio * s, fill=color + (255,))
        else: self.d.rectangle([0, 0, s, s], fill=color + (255,))
    def fill(self, d_attr, color, tx, ty, k):
        for pts, _ in flatten(d_attr): self.d.polygon([((x * k + tx) * SS, (y * k + ty) * SS) for x, y in pts], fill=color + (255,))
    def stroke(self, d_attr, color, tx, ty, k, width):
        w = max(1, round(width * k * SS)); r = w / 2
        for pts, closed in flatten(d_attr):
            P = [((x * k + tx) * SS, (y * k + ty) * SS) for x, y in pts] + ([((pts[0][0] * k + tx) * SS, (pts[0][1] * k + ty) * SS)] if closed else [])
            self.d.line(P, fill=color + (255,), width=w, joint='curve')
            for x, y in (P[0], P[-1]) if not closed else []: self.d.ellipse([x - r, y - r, x + r, y + r], fill=color + (255,))
            for x, y in P[1:-1]: self.d.ellipse([x - r, y - r, x + r, y + r], fill=color + (255,))
    def done(self): return self.big.resize((self.size, self.size), Image.LANCZOS)


def symbol(cv, ratio, v, dot):
    """Place the V + dot so the symbol is `ratio` of the canvas wide and centred."""
    k = cv.size * ratio / SYM_W; tx = (cv.size - SYM_W * k) / 2; ty = (cv.size - SYM_H * k) / 2
    cv.fill(V_PATH, v, tx, ty, k); cv.fill(DOT_PATH, dot, tx, ty, k)


def tile_icon(size, ratio, radius=0.2187, mono=False):
    cv = Canvas(size, None if mono else CLAY) if not radius or mono else Canvas(size)
    if not mono and radius: cv.tile(CLAY, radius)
    if mono: symbol(cv, ratio, (255, 255, 255), (255, 255, 255))
    else: symbol(cv, ratio, SLATE, IVORY)
    return cv.done()


# Lucide shapes (24x24 viewBox, stroke 2, round caps/joins)
GLYPHS = {
    'jobs': ['M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16', 'M4 6H20a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z'],
    'calls': ['M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z'],
    'inbox': ['M22 12H16L14 15H10L8 12H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
}
def shortcut_icon(name, size=96):
    cv = Canvas(size); cv.tile(CLAY, 21 / 96); k = (size * 0.46) / 24; t = (size - 24 * k) / 2
    for d in GLYPHS[name]: cv.stroke(d, SLATE, t, t, k, 2)
    return cv.done()


def main():
    out = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    if '--out' in sys.argv: out = os.path.abspath(sys.argv[sys.argv.index('--out') + 1])
    def save(rel, im, **kw):
        p = os.path.join(out, rel); os.makedirs(os.path.dirname(p), exist_ok=True); im.save(p, **kw); print('wrote', rel, im.size)
    # "any" icons: rounded tile, symbol ~53% wide (same proportions as public/brand/vireek-tile.svg)
    for s in (192, 512): save(f'public/icons/icon-{s}.png', tile_icon(s, 0.534))
    # maskable: full-bleed + symbol inside the 40% safe-zone circle (half-diagonal <= 0.36 of the icon)
    for s in (192, 512):
        ratio = 0.48; assert 0.5 * ratio * math.hypot(1, SYM_H / SYM_W) <= 0.36, 'symbol leaves the maskable safe zone'
        save(f'public/icons/maskable-{s}.png', tile_icon(s, ratio, radius=0))
    save('public/icons/monochrome-512.png', tile_icon(512, 0.5, mono=True))
    save('public/icons/monochrome-96.png', tile_icon(96, 0.62, mono=True))  # notification badge (sw.js)
    save('public/apple-touch-icon.png', tile_icon(180, 0.56, radius=0).convert('RGB'))  # iOS applies its own corner mask; must be opaque
    save('public/favicon-96x96.png', tile_icon(96, 0.534))
    for s in (192, 512): save(f'public/web-app-manifest-{s}x{s}.png', tile_icon(s, 0.534))
    save('public/mstile-150x150.png', tile_icon(150, 0.5, radius=0))
    ico = tile_icon(256, 0.534); save('public/favicon.ico', ico, format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])
    save('chrome-extension/icons/icon.png', tile_icon(128, 0.534))
    for n in GLYPHS: save(f'public/icons/shortcut-{n}-96.png', shortcut_icon(n))


if __name__ == '__main__':
    main()
