#!/usr/bin/env python3
"""Vireek colour system v3 ("Aurora Clay") — applies the HAND EDITS to a repo that already ran the v2 rebrand.
Usage:  python3 apply-v3-edits.py /path/to/vireek      (keep BRAND_COLOR_SYSTEM.md in the same folder as this script)
Each replacement needs its search string to occur EXACTLY ONCE; if the new text is already present it is skipped; anything else is
reported at the end (nothing is ever half-applied). Run on a clean git tree, AFTER copying the new scripts/color/* files
and src/components/brand/* + src/lib/branding.ts, and BEFORE `node scripts/color/rebrand-hex.mjs --write`."""
import os, sys, shutil
R=(sys.argv[1] if len(sys.argv)>1 else '.').rstrip('/')+'/'
FAILED=[]; APPLIED=0; SKIPPED=0
def edit(path,old,new):
    global APPLIED,SKIPPED
    try: t=open(R+path,encoding='utf-8').read()
    except FileNotFoundError: FAILED.append((path,'file not found',old[:60])); return
    n=t.count(old)
    if n==1: open(R+path,'w',encoding='utf-8').write(t.replace(old,new,1)); APPLIED+=1
    elif n==0 and new in t: SKIPPED+=1
    else: FAILED.append((path,f'search string found {n}x',old[:60]))

# ---- 1. Tailwind: gloss (glossy buttons)
edit('tailwind.config.js',"      boxShadow: {\n        sm: '0 1px 2px rgba(20,20,19,0.04)',\n",
"""      backgroundImage: {
        // glossy highlight laid over a solid brand fill (NVIDIA / Apple style); lightening a fill can only RAISE its contrast with ink text
        gloss: 'linear-gradient(180deg, rgb(255 255 255 / 0.30) 0%, rgb(255 255 255 / 0) 52%, rgb(0 0 0 / 0.07) 100%)',
      },
      boxShadow: {
        sm: '0 1px 2px rgba(20,20,19,0.04)',
        gloss: 'inset 0 1px 0 rgb(255 255 255 / 0.45), inset 0 -1px 0 rgb(0 0 0 / 0.10), 0 1px 2px rgb(20 20 19 / 0.20), 0 10px 22px -10px rgb(var(--accent-graphic) / 0.60)',
        'gloss-hover': 'inset 0 1px 0 rgb(255 255 255 / 0.55), inset 0 -1px 0 rgb(0 0 0 / 0.10), 0 1px 2px rgb(20 20 19 / 0.22), 0 14px 28px -10px rgb(var(--accent-graphic) / 0.75)',
""")
# ---- 2. Button recipes (src/lib/ui/interaction.ts) + pill buttons
edit('src/lib/ui/interaction.ts',"    rest: 'bg-accent text-on-accent shadow-sm dark:text-bg-primary',\n    hover: 'hover:brightness-110 hover:shadow-glow-accent',",
"    rest: 'bg-accent bg-gloss text-on-accent shadow-gloss',\n    hover: 'hover:brightness-105 hover:shadow-gloss-hover',")
edit('src/lib/ui/interaction.ts',"    rest: 'bg-danger text-bg-primary shadow-sm',","    rest: 'bg-danger text-on-danger shadow-sm',")
edit('src/components/ui/Button.tsx',"relative inline-flex items-center justify-center gap-2 rounded-xl font-semibold","relative inline-flex items-center justify-center gap-2 rounded-full font-semibold")
# ---- 3. Header CTA / login pills
edit('src/components/Header.tsx',"overflow-hidden rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent shadow-sm transition-all duration-200 hover:shadow-glow-accent","overflow-hidden rounded-full bg-accent bg-gloss px-5 text-sm font-semibold text-on-accent shadow-gloss transition-all duration-200 hover:shadow-gloss-hover")
edit('src/components/Header.tsx',"hidden items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-text-secondary","hidden items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold text-text-secondary")
# ---- 4. Footer: always-dark Slate footer (class `dark` flips every token inside it, like Anthropic / Vercel)
edit('src/components/Footer.tsx','<footer className="border-t border-border bg-bg-tertiary">','<footer className="dark border-t border-border bg-bg-primary text-text-primary">')
# ---- 5. Aurora hero / auth backdrop
edit('src/components/sections/Hero.tsx','className="relative overflow-hidden bg-noise bg-gradient-mesh"','className="relative overflow-hidden bg-noise bg-gradient-aurora"')
edit('src/components/auth/AuthParts.tsx','className="relative h-full overflow-hidden bg-gradient-mesh bg-noise"','className="relative h-full overflow-hidden bg-gradient-aurora bg-noise"')
edit('src/index.css',"      radial-gradient(ellipse 60% 45% at 50% 115%, rgb(var(--accent-primary) / 0.10), transparent 62%);\n  }\n",
"""      radial-gradient(ellipse 60% 45% at 50% 115%, rgb(var(--accent-primary) / 0.10), transparent 62%);
  }

  /*
   * Aurora wash (Stripe / SAP-style hero backdrop): vivid clay + coral pink + lilac + blurple. The four alphas are the PEAK values
   * that scripts/color/palette.mjs (AURORA_ALPHA) solves secondary text against — change them together.
   */
  .bg-gradient-aurora {
    background-image:
      radial-gradient(ellipse 55% 60% at 100% 0%, rgb(var(--aurora-1) / 0.22), transparent 62%),
      radial-gradient(ellipse 50% 55% at 82% 38%, rgb(var(--aurora-2) / 0.16), transparent 60%),
      radial-gradient(ellipse 55% 60% at 8% 0%, rgb(var(--aurora-3) / 0.24), transparent 62%),
      radial-gradient(ellipse 60% 50% at 50% 115%, rgb(var(--aurora-4) / 0.10), transparent 62%);
  }
  /* dark themes: alphas x AURORA_DARK_SCALE (0.4) so the wash never lifts the surface (keeps text-secondary = Mid Gray) */
  .dark .bg-gradient-aurora,
  .a11y-dark-contrast .bg-gradient-aurora {
    background-image:
      radial-gradient(ellipse 55% 60% at 100% 0%, rgb(var(--aurora-1) / 0.088), transparent 62%),
      radial-gradient(ellipse 50% 55% at 82% 38%, rgb(var(--aurora-2) / 0.064), transparent 60%),
      radial-gradient(ellipse 55% 60% at 8% 0%, rgb(var(--aurora-3) / 0.096), transparent 62%),
      radial-gradient(ellipse 60% 50% at 50% 115%, rgb(var(--aurora-4) / 0.04), transparent 62%);
  }
""")
# ---- 6. syntax colours (v2 -> v3 values)
edit('src/index.css',"  --tok-keyword: 79 61 226;\n  --tok-property: 52 99 145;","  --tok-keyword: 76 43 242;\n  --tok-property: 0 88 179;")
edit('src/index.css',"  --tok-property: 129 179 229;","  --tok-property: 100 174 255;")
# ---- 7. tests: anchors (v2 -> v3)
edit('scripts/color/contrast.test.ts',"expect(toHex(L['accent-fill'])).toBe('#D97757'); expect(toHex(D['accent-fill'])).toBe('#D97757');","expect(toHex(L['accent-fill'])).toBe('#F9774C'); expect(toHex(D['accent-fill'])).toBe('#F9774C');")
edit('scripts/color/contrast.test.ts',"expect(toHex(L['cta-graphic'])).toBe('#635BFF'); expect(toHex(D['cta-graphic'])).toBe('#7E6BFD');","expect(toHex(L['cta-graphic'])).toBe('#533AFD'); expect(toHex(D['cta-graphic'])).toBe('#7E6BFD');")
edit('scripts/color/contrast.test.ts',"    expect(toHex(L['info-fill'])).toBe('#6A9BCC');","    expect(toHex(L['info-fill'])).toBe('#006FE1'); expect(toHex(D['info-fill'])).toBe('#1F92FF');")
edit('scripts/color/contrast.test.ts',"it('Apple status fills + Stripe blurple + Anthropic Sky'","it('Apple status fills + Apple blue + Stripe blurple'")
# ---- 8. brand asset generator constants
edit('scripts/brand/geometry.py',"ORANGE, ORANGE_DK = '#D97757', '#D97757'     # Clay pulse dot","ORANGE, ORANGE_DK = '#D95A2E', '#F9774C'     # pulse dot: light / dark")
edit('scripts/brand/build_brand.py',"TILE_BLUE = '#D97757'      # Clay tile: fixed-colour brand asset (not theme-switched)","TILE_BLUE = '#F9774C'      # Vivid Clay tile: fixed-colour brand asset (not theme-switched)")
# ---- 9. docs
try: shutil.copy(os.path.join(os.path.dirname(os.path.abspath(__file__)),'BRAND_COLOR_SYSTEM.md'),R+'docs/design/BRAND_COLOR_SYSTEM.md')
except Exception as e: FAILED.append(('docs/design/BRAND_COLOR_SYSTEM.md',str(e),''))
print(f"applied {APPLIED}, already-applied (skipped) {SKIPPED}, FAILED {len(FAILED)}")
for p,why,old in FAILED: print(f"  ✘ {p}: {why} — {old!r}")
sys.exit(1 if FAILED else 0)
