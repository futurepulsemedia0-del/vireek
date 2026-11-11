#!/usr/bin/env python3
"""Vireek colour rebrand — applies the HAND EDITS (everything the automatic script must not touch) to a repo checkout.
Usage:  python3 apply-rebrand-edits.py /path/to/vireek      (run from the folder that also holds BRAND_COLOR_SYSTEM.md)
Every replacement requires its search string to occur EXACTLY ONCE, otherwise the script aborts with the file + string (no partial silent edits).
Run it on a clean git working tree, BEFORE `node scripts/color/rebrand-hex.mjs --write`."""
import sys,os
import os
R=(sys.argv[1] if len(sys.argv)>1 else '.').rstrip('/')+'/'
def edit(path,old,new):
    t=open(R+path,encoding='utf-8').read()
    n=t.count(old)
    if n!=1: sys.exit(f"ERR {path}: count={n} for {old[:60]!r}")
    open(R+path,'w',encoding='utf-8').write(t.replace(old,new,1))
# index.css syntax colours
edit('src/index.css',"  --tok-comment: 88 94 106;\n  --tok-string: 14 100 56;\n  --tok-number: 150 62 0;\n  --tok-keyword: 112 36 150;\n  --tok-property: 24 52 180;",
"  --tok-comment: 108 106 101;\n  --tok-string: 0 120 43;\n  --tok-number: 127 101 0;\n  --tok-keyword: 89 77 241;\n  --tok-property: 60 107 154;")
edit('src/index.css',"  --tok-comment: 150 156 170;\n  --tok-string: 130 220 160;\n  --tok-number: 255 170 100;\n  --tok-keyword: 200 150 255;\n  --tok-property: 140 170 255;",
"  --tok-comment: 151 150 143;\n  --tok-string: 48 209 88;\n  --tok-number: 255 214 0;\n  --tok-keyword: 146 138 255;\n  --tok-property: 107 157 206;")
# Logo.tsx
edit('src/components/brand/Logo.tsx'," *   tone     auto  → indigo letters + orange accent, follows --accent-* tokens"," *   tone     auto  → Slate/Ivory letters + Clay pulse dot, follows the --text-primary / --accent-graphic tokens")
edit('src/components/brand/Logo.tsx',"const TILE_FILL: Record<string, string> = { tile: '#203AD8', tv: '#FFFFFF', td: '#FF8A5A' };","const TILE_FILL: Record<string, string> = { tile: '#D97757', tv: '#141413', td: '#FAF9F5' }; // Clay tile, Slate V, Ivory dot")
edit('src/components/brand/Logo.tsx',"  if (role === 'ink') return 'rgb(var(--accent-primary, 32 58 216))';\n  if (role === 'acc') return 'rgb(var(--logo-accent, 193 79 38))';","  if (role === 'ink') return 'rgb(var(--text-primary, 20 20 19))';\n  if (role === 'acc') return 'rgb(var(--accent-graphic, 199 103 71))';")
# LogoConstruction
edit('src/components/brand/LogoConstruction.tsx',"stroke: 'rgb(var(--logo-accent, 193 79 38))'","stroke: 'rgb(var(--accent-graphic, 199 103 71))'")
edit('src/components/brand/LogoConstruction.tsx',"fill={role === 'ink' ? 'rgb(var(--accent-primary, 32 58 216))' : 'rgb(var(--logo-accent, 193 79 38))'}","fill={role === 'ink' ? 'rgb(var(--text-primary, 20 20 19))' : 'rgb(var(--accent-graphic, 199 103 71))'}")
edit('src/components/brand/LogoConstruction.tsx',"fill: 'rgb(var(--text-secondary, 103 103 112))'","fill: 'rgb(var(--text-secondary, 93 91 85))'")
# Logo test
edit('src/components/brand/Logo.test.tsx',"    expect(fills[0]).toContain('--accent-primary');\n    expect(fills[1]).toContain('--logo-accent');","    expect(fills[0]).toContain('--text-primary');\n    expect(fills[1]).toContain('--accent-graphic');")
# Guide
t=open(R+'src/components/brand/BrandLogoGuide.tsx',encoding='utf-8').read()
i=t.index("  { name: 'Cobalt (light)'"); j=t.index("];",i)
new="""  { name: 'Slate', hex: '#141413', rgb: '20 20 19', use: 'Letters on light backgrounds (17.5:1 on Ivory #FAF9F5); V on the app tile (5.9:1); one-color black version' },
  { name: 'Ivory', hex: '#FAF9F5', rgb: '250 249 245', use: 'Letters on dark backgrounds (17.5:1 on Slate #141413); pulse dot on the app tile; one-color white version' },
  { name: 'Clay', hex: '#D97757', rgb: '217 119 87', use: 'The pulse dot on dark backgrounds (5.9:1 on Slate) and the app tile fill. On light backgrounds the in-app dot uses the deeper token #C76747 (3.7:1)' },
  { name: 'Clay — logo dot (light, artwork files)', hex: '#D97757', rgb: '217 119 87', use: 'Static SVG artwork on Ivory (3.0:1, graphic). A logo is exempt from WCAG 1.4.11; use the in-app component where 3:1 is required' },
"""
t=t[:i]+new+t[j:]
old="          The app tile is a fixed-color asset (Cobalt #203AD8, white V, Copper #FF8A5A dot) in both themes,\n          like any app icon. The wordmark switches between the light and dark Cobalt/Copper pairs automatically\n          when drawn with the in-app component."
assert t.count(old)==1
t=t.replace(old,"          The app tile is a fixed-color asset (Clay #D97757, Slate V, Ivory dot) in both themes,\n          like any app icon. The wordmark switches between Slate and Ivory letters (with the Clay dot) automatically\n          when drawn with the in-app component.")
open(R+'src/components/brand/BrandLogoGuide.tsx','w',encoding='utf-8').write(t)
# branding presets
t=open(R+'src/lib/branding.ts',encoding='utf-8').read()
i=t.index("  { name: 'Ocean'"); j=t.index("];",i)
t=t[:i]+"""  { name: 'Clay', primary: '#A94C2D', accent: '#6A9BCC' },
  { name: 'Sky', primary: '#3C6B9A', accent: '#D97757' },
  { name: 'Green', primary: '#00782B', accent: '#34C759' },
  { name: 'Blurple', primary: '#594DF1', accent: '#D97757' },
  { name: 'Graphite', primary: '#44423D', accent: '#D97757' },
  { name: 'Red', primary: '#D2001E', accent: '#FFCC00' },
"""+t[j:]
open(R+'src/lib/branding.ts','w',encoding='utf-8').write(t)
print('manual edits applied')

# ---- brand guidelines page copy
edit('src/pages/brandPalette.ts',"  tok('On-accent', 'Text and icons on the accent fill (7.9:1 light, 4.8:1 dark)', 'on-accent'),","  tok('On-accent', 'Slate text and icons on the Clay fill (5.9:1) — always pair', 'on-accent'),")
edit('src/pages/brandPalette.ts',"  tok('Copper fill', 'Live/urgent solid surfaces (active call, emergency) — never a generic CTA', 'cta-fill'),\n  tok('On-copper', 'Text on the copper fill', 'on-cta'),\n  tok('Copper text', 'Darker copper for text (≥ 4.5:1)', 'cta-text'),\n  tok('Copper graphic', 'Icons, dots and large shapes (≥ 3:1)', 'cta-graphic'),",
"  tok('Blurple fill', 'Live / AI-signal solid surfaces (active call, emergency, assistant) — never a generic CTA', 'cta-fill'),\n  tok('On-blurple', 'Text on the Blurple fill', 'on-cta'),\n  tok('Blurple text', 'Blurple for text (≥ 4.5:1)', 'cta-text'),\n  tok('Blurple graphic', 'Icons, dots and large shapes (≥ 3:1)', 'cta-graphic'),")
edit('src/pages/brandPalette.ts',"  'Reserve copper for live / urgent moments (active call, emergency detection).',","  'Reserve Blurple for live / AI-signal moments (active call, emergency detection, assistant).',")
edit('src/pages/brandPalette.ts',"  'Never use copper as a decorative or generic call-to-action colour.',","  'Never use Blurple as a decorative or generic call-to-action colour (Clay is the brand and action colour).',")
edit('src/pages/BrandGuidelinesPage.tsx','title="Signal Cobalt — Accent"','title="Clay — Brand &amp; primary action"')
edit('src/pages/BrandGuidelinesPage.tsx','title="Signal Copper — Live &amp; urgent moments only"','title="Blurple — Live &amp; AI-signal moments only"')
edit('src/pages/BrandGuidelinesPage.tsx',"              Signal Copper is reserved for active-call and emergency-detection states across the","              Blurple is reserved for active-call, emergency-detection and assistant states across the")
# ---- comments
edit('src/components/LeadSourceBreakdown.tsx',"Copper (bg-cta) is reserved for live/urgent","Blurple (bg-cta) is reserved for live/AI-signal")
edit('src/components/ui/StatusDot.tsx','"live" = copper, reserved for live/urgent states.','"live" = Blurple, reserved for live/urgent states.')
edit('src/hooks/useTabLiveCall.ts','the favicon gets a copper dot.','the favicon gets a Blurple dot.')
edit('src/lib/brand/tabIdentity.ts','(copper = live call, cobalt = unread that arrived while the tab was in the background)','(Blurple = live call, Clay = unread that arrived while the tab was in the background)')
print('page/comment edits applied')


# ---------------- v2 additions
edit('scripts/color/contrast.test.ts',"describe('brand anchors stay put (the change must stay near-invisible)', () => {","describe('brand anchors: exact Anthropic / Apple / Stripe values', () => {")
edit('scripts/color/contrast.test.ts',"  it('cobalt', () => { expect(toHex(L['accent-text'])).toBe('#203AD8'); expect(toHex(L['accent-fill'])).toBe('#203AD8'); });\n  it('copper graphic (light) and copper fill (dark)', () => { expect(toHex(L['cta-graphic'])).toBe('#D6582A'); expect(toHex(D['cta-fill'])).toBe('#FF8A5A'); });",
"""  it('Clay + Anthropic neutrals', () => {
    expect(toHex(L['accent-fill'])).toBe('#D97757'); expect(toHex(D['accent-fill'])).toBe('#D97757');
    expect(toHex(L['bg-primary'])).toBe('#FAF9F5'); expect(toHex(D['bg-primary'])).toBe('#141413');
    expect(toHex(L['border-default'])).toBe('#E8E6DC'); expect(toHex(D['text-secondary'])).toBe('#B0AEA5');
  });
  it('Apple status fills + Stripe blurple + Anthropic Sky', () => {
    expect(toHex(L['success-fill'])).toBe('#34C759'); expect(toHex(D['success-fill'])).toBe('#30D158');
    expect(toHex(L['warning-fill'])).toBe('#FFCC00'); expect(toHex(D['warning-fill'])).toBe('#FFD600');
    expect(toHex(D['danger-graphic'])).toBe('#FF4245');
    expect(toHex(L['cta-graphic'])).toBe('#635BFF'); expect(toHex(D['cta-graphic'])).toBe('#7E6BFD');
    expect(toHex(L['info-fill'])).toBe('#6A9BCC');
  });""")
edit('scripts/color/contrast.test.ts',"    expect(html).toMatch(new RegExp(`<meta name=\"theme-color\" content=\"${lightBg}\"`, 'i'));","    expect(html).toMatch(new RegExp(`<meta name=\"theme-color\" media=\"\\\\(prefers-color-scheme: light\\\\)\" content=\"${lightBg}\"`, 'i'));\n    expect(html).toMatch(new RegExp(`<meta name=\"theme-color\" media=\"\\\\(prefers-color-scheme: dark\\\\)\" content=\"${darkBg}\"`, 'i'));")
edit('public/site.webmanifest','"background_color": "#090A0D"','"background_color": "#FAF9F5"')
edit('package.json','    "tokens:build": "node scripts/color/build-tokens.mjs",','    "tokens:build": "node scripts/color/build-tokens.mjs",\n    "tokens:export": "node scripts/color/export-tokens.mjs",\n    "lint:palette": "node scripts/color/rebrand-hex.mjs --verify",')
edit('.github/workflows/ci.yml',"      - name: Typecheck\n        run: npm run typecheck\n","      - name: Palette purity (no colour outside the Vireek palette) + design hand-off artefacts up to date\n        run: |\n          npm run lint:palette\n          npm run tokens:export\n          git diff --exit-code -- docs/design/tokens.json docs/design/color-preview.html\n\n      - name: Typecheck\n        run: npm run typecheck\n")
edit('BRAND_GOVERNANCE.md',"`theme_color` `#4F46E5` vs accent `#203AD8`; ","")
edit('docs/design/dashboard-principles.md','Brand: "Signal" palette — warm graphite neutrals, one cobalt accent, copper (`cta`) only for live/urgent.','Brand: "Claude-first" palette (see BRAND_COLOR_SYSTEM.md) — Anthropic warm neutrals, Clay (`accent`) as the one brand colour, Blurple (`cta`) only for live/AI-signal moments.')
edit('scripts/brand/geometry.py',"INDIGO, INDIGO_DK = '#203AD8', '#6C82FF'     # --accent-primary light / dark","INDIGO, INDIGO_DK = '#141413', '#FAF9F5'     # wordmark letters: Slate (light bg) / Ivory (dark bg)")
edit('scripts/brand/geometry.py',"ORANGE, ORANGE_DK = '#C14F26', '#FF8A5A'     # --logo-accent light (AA, 4.6:1) / dark = --accent-secondary dark","ORANGE, ORANGE_DK = '#D97757', '#D97757'     # Clay pulse dot")
edit('scripts/brand/geometry.py',"INK, PAPER = '#17171A', '#F2F1EE'            # --text-primary light / dark","INK, PAPER = '#141413', '#FAF9F5'            # --text-primary light / dark")
edit('scripts/brand/build_brand.py',"TILE_BLUE = INDIGO         # tiles are fixed-colour brand assets (not theme-switched)","TILE_BLUE = '#D97757'      # Clay tile: fixed-colour brand asset (not theme-switched)")
edit('scripts/brand/build_brand.py',"TILE_V = '#FFFFFF'","TILE_V = '#141413'")
edit('scripts/brand/build_brand.py',"TILE_DOT = ORANGE_DK       # lighter orange: 3.1:1 on the indigo tile","TILE_DOT = '#FAF9F5'       # Ivory dot on the Clay tile")
edit('scripts/brand/build_brand.py',"PAPER_BG = '#FDFCFA'","PAPER_BG = '#FAF9F5'")
edit('scripts/brand/build_brand.py',"splash('#090A0D')","splash('#141413')")

BB='scripts/brand/build_brand.py'
edit(BB,'height="630" fill="#FDFCFA"/>','height="630" fill="#FAF9F5"/>')
edit(BB,'fill="{INDIGO}" fill-opacity=".07"','fill="{TILE_BLUE}" fill-opacity=".07"')
edit(BB,'<path fill="#676770"','<path fill="#73726C"')
import shutil; shutil.copy(os.path.join(os.path.dirname(os.path.abspath(__file__)),'BRAND_COLOR_SYSTEM.md'),R+'docs/design/BRAND_COLOR_SYSTEM.md')
print('v2 edits applied')
