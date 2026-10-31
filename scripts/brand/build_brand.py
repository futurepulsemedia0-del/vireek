#!/usr/bin/env python3
"""Generate every Vireek brand asset (SVG, PNG, ICO, TS path data) from geometry.py.

  pip install fonttools skia-pathops cairosvg pillow
  # The logo itself uses NO font (letters.py draws them). A font is only used to outline the
  # tagline inside the raster og-image.png: Sora Medium, SIL OFL 1.1.
  npm i --no-save @fontsource/sora
  VIREEK_SORA_WOFF=node_modules/@fontsource/sora/files/sora-latin-600-normal.woff \
  VIREEK_SORA_WOFF_500=node_modules/@fontsource/sora/files/sora-latin-500-normal.woff \
  python3 scripts/brand/build_brand.py

Writes: public/brand/*.svg, public/*.png|ico|svg (favicons, PWA, OG, avatar),
        assets/*.png (Capacitor sources), chrome-extension/icons/icon.png,
        src/components/brand/logoPaths.generated.ts, supabase/functions/_shared/brand/*.
"""
import io, json, os, struct, sys
sys.path.insert(0, os.path.dirname(__file__))
from geometry import *
from fontTools.ttLib import TTFont
import cairosvg
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
def out(*p):
    path = os.path.join(ROOT, *p); os.makedirs(os.path.dirname(path), exist_ok=True); return path
def write(path, s):
    with open(path, 'w') as f: f.write(s)
    return len(s.encode())

TILE_BLUE = INDIGO         # tiles are fixed-colour brand assets (not theme-switched)
TILE_V = '#FFFFFF'
TILE_DOT = ORANGE_DK       # lighter orange: 3.1:1 on the indigo tile

# ---- shapes ----------------------------------------------------------------------
W_ink, W_dot = wordmark_paths(); W_y0 = bounds(W_ink, W_dot)[1];           (W_ink, W_dot), WW, WH = normalize([W_ink, W_dot])
S_v, S_dot = symbol_paths();                (S_v, S_dot), SW, SH = normalize([S_v, S_dot])
bg, tv, td, tmono = tile_parts(1000)
LH = lockup_horizontal(); LS = lockup_stacked()
def lock_bounds(L):
    return bounds(L['bg'], L['ink'], L['dot'])
def norm_lock(L):
    x0, y0, x1, y1 = lock_bounds(L)
    f = lambda p: xform(p, 1, -x0, -y0)
    return {k: f(v) for k, v in L.items()}, x1 - x0, y1 - y0
LH, LHW, LHH = norm_lock(LH); LS, LSW, LSH = norm_lock(LS)

SHAPES = {
    'wordmark': dict(w=WW, h=WH, layers=[('ink', W_ink), ('acc', W_dot)], mono=[W_ink, W_dot]),
    'symbol':   dict(w=SW, h=SH, layers=[('ink', S_v), ('acc', S_dot)], mono=[S_v, S_dot]),
    'tile':     dict(w=1000, h=1000, layers=[('tile', bg), ('tv', tv), ('td', td)], mono=[tmono]),
    'lockup':   dict(w=LHW, h=LHH, layers=[('tile', LH['bg']), ('tv', LH['tv']), ('td', LH['td']), ('ink', LH['ink']), ('acc', LH['dot'])],
                     mono=[LH['mono'], LH['ink'], LH['dot']]),
    'stacked':  dict(w=LSW, h=LSH, layers=[('tile', LS['bg']), ('tv', LS['tv']), ('td', LS['td']), ('ink', LS['ink']), ('acc', LS['dot'])],
                     mono=[LS['mono'], LS['ink'], LS['dot']]),
}

# ---- colourways -----------------------------------------------------------------
COLORWAYS = {
    'color':   dict(ink=INDIGO, acc=ORANGE),                  # on light backgrounds
    'reverse': dict(ink=INDIGO_DK, acc=ORANGE_DK),            # on dark backgrounds
}
MONO = {'black': INK, 'white': '#FFFFFF'}
ROLE_FIXED = dict(tile=TILE_BLUE, tv=TILE_V, td=TILE_DOT)

def svg_doc(name, shape, fills=None, mono=None, adaptive=False, title='Vireek'):
    s = SHAPES[shape]; w, h = s['w'], s['h']
    head = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {num(w)} {num(h)}" role="img" aria-label="{title}"><title>{title}</title>'
    body = ''
    if adaptive:
        # <img>/CSS-background safe theme switch via prefers-color-scheme (OS level)
        head += f'<style>.i{{fill:{INDIGO}}}.a{{fill:{ORANGE}}}@media(prefers-color-scheme:dark){{.i{{fill:{INDIGO_DK}}}.a{{fill:{ORANGE_DK}}}}}</style>'
        for role, p in s['layers']:
            if role == 'ink': body += f'<path class="i" d="{D(p)}"/>'
            elif role == 'acc': body += f'<path class="a" d="{D(p)}"/>'
            else: body += f'<path fill="{ROLE_FIXED[role]}" d="{D(p)}"/>'
    elif mono:
        body = ''.join(f'<path fill="{mono}" d="{D(p)}"/>' for p in s['mono'])
        # merge into one path element to save bytes
        body = f'<path fill="{mono}" d="{" ".join(D(p) for p in s["mono"])}"/>'
    else:
        for role, p in s['layers']:
            fill = fills['ink'] if role == 'ink' else fills['acc'] if role == 'acc' else ROLE_FIXED[role]
            body += f'<path fill="{fill}" d="{D(p)}"/>'
    return head + body + '</svg>'

report = []
def emit(fname, svg):
    n = write(out('public', 'brand', fname), svg); report.append((fname, n))
    assert n < 3000, f'{fname} is {n} bytes (>=3 KB)'

NAMES = {'wordmark': 'vireek-wordmark', 'symbol': 'vireek-symbol', 'lockup': 'vireek-lockup-horizontal', 'stacked': 'vireek-lockup-stacked'}
for shape, base in NAMES.items():
    emit(f'{base}.svg', svg_doc(base, shape, adaptive=True))
    for cw, fills in COLORWAYS.items(): emit(f'{base}-{cw}.svg', svg_doc(base, shape, fills=fills))
    for m, col in MONO.items(): emit(f'{base}-{m}.svg', svg_doc(base, shape, mono=col))
emit('vireek-tile.svg', svg_doc('vireek-tile', 'tile', fills=COLORWAYS['color']))
for m, col in MONO.items(): emit(f'vireek-tile-{m}.svg', svg_doc('vireek-tile', 'tile', mono=col))

# ---- favicon.svg (tile, ~0.5 KB) --------------------------------------------------
fav = svg_doc('favicon', 'tile', fills=COLORWAYS['color']).replace(' role="img" aria-label="Vireek"', '').replace('<title>Vireek</title>', '')
n = write(out('public', 'favicon.svg'), fav); report.append(('favicon.svg', n))

# ---- app icon sources (full bleed) ------------------------------------------------
def icon_svg(size, vh, dy=0.0, bgfill=TILE_BLUE, with_bg=True, v=TILE_V, dot=TILE_DOT):
    b, tvv, tdd = fullbleed_icon(size, vh, dy)
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">'
    if with_bg: s += f'<path fill="{bgfill}" d="{D(b)}"/>'
    s += f'<path fill="{v}" d="{D(tvv)}"/><path fill="{dot}" d="{D(tdd)}"/></svg>'
    return s
ICON_FULL = icon_svg(1024, 0.50)            # iOS / store icon, full-bleed
ICON_MASKABLE = icon_svg(1024, 0.42)        # inside 80% Android/PWA safe-zone
ICON_FG = icon_svg(1024, 0.36, with_bg=False)   # adaptive foreground (66% safe zone)
emit('vireek-app-icon.svg', ICON_FULL)
emit('vireek-app-icon-foreground.svg', ICON_FG)

def png(svg, px, path, bg=None):
    cairosvg.svg2png(bytestring=svg.encode(), write_to=path, output_width=px, output_height=int(px * 1) if False else None, background_color=bg)
def png_sq(svg, px, path): cairosvg.svg2png(bytestring=svg.encode(), write_to=path, output_width=px, output_height=px)

# ---- favicon / PWA / touch icons ---------------------------------------------------
TILE_SVG = svg_doc('t', 'tile', fills=COLORWAYS['color'])
for px in (16, 32, 48, 96): png_sq(TILE_SVG, px, out('public', f'favicon-{px}x{px}.png'))
os.replace(out('public', 'favicon-96x96.png'), out('public', 'favicon-96x96.png'))
# crisp ICO: separate renders for 16/32/48 (PNG-compressed entries)
blobs = []
for px in (16, 32, 48):
    b = io.BytesIO(); Image.open(out('public', f'favicon-{px}x{px}.png')).convert('RGBA').save(b, 'PNG'); blobs.append((px, b.getvalue()))
ico = struct.pack('<HHH', 0, 1, len(blobs)); off = 6 + 16 * len(blobs); data = b''
for px, blob in blobs:
    ico += struct.pack('<BBBBHHII', px, px, 0, 0, 1, 32, len(blob), off + len(data)); data += blob
open(out('public', 'favicon.ico'), 'wb').write(ico + data)
for px in (16, 32, 48): os.remove(out('public', f'favicon-{px}x{px}.png')) if px != 32 else None
png_sq(ICON_FULL, 180, out('public', 'apple-touch-icon.png'))
png_sq(TILE_SVG, 192, out('public', 'web-app-manifest-192x192.png'))
png_sq(TILE_SVG, 512, out('public', 'web-app-manifest-512x512.png'))
png_sq(ICON_MASKABLE, 192, out('public', 'web-app-manifest-maskable-192x192.png'))
png_sq(ICON_MASKABLE, 512, out('public', 'web-app-manifest-maskable-512x512.png'))
png_sq(ICON_FULL, 128, out('chrome-extension', 'icons', 'icon.png'))
# social avatar + 1024 store icon
png_sq(ICON_FULL, 1024, out('public', 'brand', 'vireek-app-icon-1024.png'))
png_sq(TILE_SVG, 800, out('public', 'brand', 'vireek-avatar-800.png'))
# Capacitor sources
png_sq(ICON_FULL, 1024, out('assets', 'icon-only.png'))
png_sq(icon_svg(1024, 0.36, with_bg=False), 1024, out('assets', 'icon-foreground.png'))
cairosvg.svg2png(bytestring=f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="{TILE_BLUE}"/></svg>'.encode(), write_to=out('assets', 'icon-background.png'))
def splash(bgc, px=2732):
    b, tvv, tdd = fullbleed_icon(px, 0.16)
    # use the bare symbol on the splash background (no tile)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {px} {px}"><rect width="{px}" height="{px}" fill="{bgc}"/><path fill="{TILE_V if bgc != PAPER_BG else INDIGO}" d="{D(tvv)}"/><path fill="{ORANGE_DK if bgc != PAPER_BG else ORANGE}" d="{D(tdd)}"/></svg>'
PAPER_BG = '#FDFCFA'
png_sq(splash(PAPER_BG), 2732, out('assets', 'splash.png'))
png_sq(splash('#090A0D'), 2732, out('assets', 'splash-dark.png'))


# ---- press-kit PNGs (transparent) ------------------------------------------------
for shape, base, wpx in (('wordmark', 'vireek-wordmark', 1600), ('symbol', 'vireek-symbol', 800)):
    for cw in ('color',): png(svg_doc(base, shape, fills=COLORWAYS[cw]), wpx, out('public', 'brand', f'{base}-{cw}.png'))
    for m, col in MONO.items(): png(svg_doc(base, shape, mono=col), wpx, out('public', 'brand', f'{base}-{m}.png'))
png(svg_doc('l', 'lockup', fills=COLORWAYS['color']), 1600, out('public', 'brand', 'vireek-lockup-horizontal-color.png'))
png(svg_doc('l', 'stacked', fills=COLORWAYS['color']), 1000, out('public', 'brand', 'vireek-lockup-stacked-color.png'))
png_sq(TILE_SVG, 1024, out('public', 'brand', 'vireek-tile-1024.png'))

# ---- email PNGs (SVG is unsupported by Gmail/Outlook) -----------------------------
EM = svg_doc('e', 'wordmark', fills=COLORWAYS['color'])
png(EM, 480, out('public', 'brand', 'email', 'vireek-wordmark-email.png'))        # shown at 120px wide (4x)

# ---- OG image 1200x630 ---------------------------------------------------------------
f500 = TTFont(os.environ.get('VIREEK_SORA_WOFF_500', FONT.replace('-600-', '-500-'))); g5 = f500.getGlyphSet(); c5 = f500.getBestCmap()
def text_path(txt, size, x, y, track=0):
    p = None; cx = 0
    for ch in txt:
        gl = Path(); g5[c5[ord(ch)]].draw(TransformPen(gl.getPen(), (size / 1000, 0, 0, -size / 1000, x + cx, y)))
        p = gl if p is None else op(p, gl, PathOp.UNION); cx += g5[c5[ord(ch)]].width * size / 1000 + track
    return p
def og_svg():
    s = LH  # horizontal lockup, scaled
    scale = 0.34; w = LHW * scale; h = LHH * scale
    tx = 96; ty = 120
    body = ''
    for role, p in SHAPES['lockup']['layers']:
        fill = INDIGO if role == 'ink' else ORANGE if role == 'acc' else ROLE_FIXED[role]
        body += f'<path fill="{fill}" d="{D(xform(p, scale, tx, ty))}"/>'
    l1 = text_path('Never miss a call.', 84, 96, 400); l2 = text_path('Book more jobs.', 84, 96, 500)
    sub = text_path('AI voice receptionist for home-service trades', 34, 96, 575)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#FDFCFA"/>'
            f'<circle cx="1130" cy="40" r="360" fill="{INDIGO}" fill-opacity=".07"/><circle cx="1180" cy="640" r="260" fill="{ORANGE}" fill-opacity=".08"/>'
            + body + f'<path fill="{INK}" d="{D(l1)}"/><path fill="{INK}" d="{D(l2)}"/><path fill="#676770" d="{D(sub)}"/></svg>')
OG = og_svg(); png_sq  # noqa
cairosvg.svg2png(bytestring=OG.encode(), write_to=out('public', 'og-image.png'), output_width=1200, output_height=630)

# ---- TS path data for <Logo/> and PDF/email helpers ----------------------------------
ts = {k: dict(w=round(v['w'], 1), h=round(v['h'], 1), layers=[[r, D(p)] for r, p in v['layers']], mono=' '.join(D(p) for p in v['mono'])) for k, v in SHAPES.items()}
ts['symbolDot'] = dict(cx=round(S_dot.bounds[0] / 2 + S_dot.bounds[2] / 2, 1), cy=round(S_dot.bounds[1] / 2 + S_dot.bounds[3] / 2, 1), r=round((S_dot.bounds[2] - S_dot.bounds[0]) / 2, 1))
ts['wordmarkDot'] = dict(cx=round(W_dot.bounds[0] / 2 + W_dot.bounds[2] / 2, 1), cy=round(W_dot.bounds[1] / 2 + W_dot.bounds[3] / 2, 1), r=round((W_dot.bounds[2] - W_dot.bounds[0]) / 2, 1))
header = '/* AUTO-GENERATED by scripts/brand/build_brand.py — do not edit by hand. */\n'
write(out('src', 'components', 'brand', 'logoPaths.generated.ts'),
      header + 'export type LogoRole = \'ink\' | \'acc\' | \'tile\' | \'tv\' | \'td\';\n'
      'export interface LogoShape { w: number; h: number; layers: [LogoRole, string][]; mono: string }\n'
      'export const LOGO_SHAPES: Record<\'wordmark\' | \'symbol\' | \'tile\' | \'lockup\' | \'stacked\', LogoShape> = ' + json.dumps({k: ts[k] for k in SHAPES}, separators=(',', ':')) + ' as never;\n'
      'export const SYMBOL_DOT = ' + json.dumps(ts['symbolDot']) + ';\n'
      'export const WORDMARK_DOT = ' + json.dumps(ts['wordmarkDot']) + ';\n'
      '/** Wordmark construction metrics in artwork units (y down): baseline, cap-height line, x-height line. */\n'
      'export const WORDMARK_METRICS = ' + json.dumps(dict(baseline=round(-W_y0, 1), cap=round(-W_y0 - 730, 1), xh=round(-W_y0 - 534, 1))) + ';\n')

for fname, n in sorted(report): print(f'{n:5d} B  {fname}')
print('OK')
