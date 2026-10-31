# Vireek logo system — changes

Apply order: 1) new files (copy from your tree after running the generator, or from the patch), 2) `git apply vireek-logo.patch` (text changes to existing files; run `git apply --check` first), 3) regenerate/commit binaries.

**v2:** letterforms are now fully original (`scripts/brand/letters.py`, no font); logo dot uses new `--logo-accent` token (4.6:1); 404 page keeps its original icon (header already shows the logo). Add to `src/index.css` :root `--logo-accent: 193 79 38;` and .dark `--logo-accent: 255 138 90;` (already in the patch).

## Regenerate every asset (SVG, PNG, ICO, TS path data)
```
pip install fonttools skia-pathops cairosvg pillow
npm i --no-save @fontsource/sora   # only for the OG-image tagline
export VIREEK_SORA_WOFF=node_modules/@fontsource/sora/files/sora-latin-600-normal.woff
export VIREEK_SORA_WOFF_500=node_modules/@fontsource/sora/files/sora-latin-500-normal.woff
python3 scripts/brand/build_brand.py && python3 scripts/brand/build_preview.py
npm i -D axe-core && npx vitest run src/components/brand src/lib/brandAssets.test.ts
npx playwright test e2e/logo.spec.ts --update-snapshots   # first run creates baselines
```
Delete: `public/assets/logos/logo-dark.png`, `logo-light.png`.

## Existing files edited (search string → change)
| File | Ctrl+F | Change |
|---|---|---|
| src/components/Header.tsx | `/*  Logo ` block (function Logo) | delete function + `useTheme` import; add `import { Logo } from '@/components/brand/Logo';` |
| same | `<Logo />` + `<span ...>Vireek</span>` | `<Logo variant="wordmark" size={26} decorative className="hidden sm:block" />` + `<Logo variant="symbol" size={28} decorative className="sm:hidden" />` |
| same | `<Logo size="h-8 w-8" />` | `<Logo variant="wordmark" size={24} decorative />` (drop the text span) |
| src/components/auth/AuthParts.tsx | `export function AuthLogo` | body → `<Logo variant="lockup" size={size} />`; call site `<AuthLogo size={40} />`, drop text span |
| src/components/Footer.tsx | `text-xl font-bold tracking-tight text-accent">Vireek` | `<Link to="/" aria-label="Vireek home"…><Logo variant="wordmark" tone="mono" size={28} decorative /></Link>` |
| src/components/DashboardNav.tsx | `bg-gradient-to-br from-accent to-cta text-white shadow-glow-accent` (2×) | desktop sidebar → `<Logo variant="wordmark" size={26} />`; mobile header → `<Logo variant="symbol" size={30} />` |
| src/components/RouteLoader.tsx | whole component | `<Logo variant="symbol" size={56} animated decorative />` inside the same `role="status"` wrapper |
| src/components/CookieConsent.tsx | `<ShieldCheck size={21} />` | `<Logo variant="tile" size={44} decorative />` |
| src/components/chat/ChatVisuals.tsx | `<Sparkles size={14} strokeWidth={2.25} />` (first, in ChatAvatar) | `<Logo variant="tile" size={32} decorative />` in a `h-8 w-8 rounded-full overflow-hidden` span |
| src/pages/BrandGuidelinesPage.tsx | `Two versions cover every surface` … down to `{/* Colors */}` | `<BrandLogoGuide />`; downloads use `BRAND_DOWNLOADS` (SVG + PNG buttons) |
| src/pages/PressPage.tsx | `const BRAND_ASSETS` | map from `BRAND_DOWNLOADS`; card shows SVG/PNG buttons |
| src/lib/pdf.ts | `doc.text(brand.wordmark, MARGIN, y)` | add `else if (brand.isVireek) drawVireekWordmark(doc, MARGIN, y - 16, 20, brand.primary, brand.accent)` before it |
| src/index.css | end of file | animated-logo keyframes (`vrk-logo-*`), reduced-motion safe |
| index.html | `favicon-96x96`, `theme-color`, JSON-LD `logo` | add 32px icon, theme-color `#203AD8`, JSON-LD logo → 512px icon |
| public/site.webmanifest | icons | separate maskable icons (`?v=2`), theme_color `#203AD8` |
| scripts/make-native-assets.mjs | whole file | builds from `public/brand/vireek-app-icon*.svg` |
| supabase/functions/_shared/reports/email.ts, value-scoreboard/render.ts, send-comment-email/index.ts | header `<p>`/`<h1>` | hosted PNG wordmark via `_shared/brand/emailLogo.ts` |
| package.json | devDependencies | `"axe-core": "^4.10.2"` |
