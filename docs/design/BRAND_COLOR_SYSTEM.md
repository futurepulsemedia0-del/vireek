# Vireek colour system v4 — "Signal Exact"

Single source of truth: `scripts/color/palette.mjs`. Everything else is generated or gated:

| Command | What it does |
|---|---|
| `npm run tokens:build` | writes `src/styles/tokens.generated.{css,ts}`, `supabase/functions/_shared/brand-colors.ts`, `docs/design/COLOR_TOKENS.md` |
| `npm run tokens:export` | writes `docs/design/tokens.json` (W3C design-token format) |
| `npm run tokens:preview` | writes `docs/design/color-preview.html` |
| `npm run lint:palette` | fails if any colour literal in product code is not a palette value |
| `npm run lint:colors` / `lint:surfaces` | semantic-token usage and per-class contrast (including translucent tints) |

CI runs all of them and then `git diff --exit-code` on the generated files, so a palette change without regenerating fails the build.

**Idea.** Anthropic's warm Ivory / Slate world, with every brand colour used **exactly as the brand publishes it** (nothing pushed,
brightened or recoloured). The solver only ever moves **lightness** — never hue — where a WCAG pair needs it, so each derived tone is the
same hue as its brand seed. All solid fills are the published values.

## 1. Where every colour comes from

| Role | Source | Light | Dark |
|---|---|---|---|
| Page background | Anthropic Ivory / Slate | `#FAF9F5` | `#141413` |
| Cards, panels | white / Slate step | `#FFFFFF` | `#1C1C1A` |
| Wells, table stripes | Anthropic surface | `#F0EEE6` | `#242422` |
| Borders | Anthropic Light Gray | `#E8E6DC` | `#2E2E2C` |
| Secondary text (dark theme) | Anthropic Mid Gray | — | `#B0AEA5` |
| **Brand + primary action** (`accent`) | **Anthropic Clay** | `#D97757` | `#D97757` |
| Live / AI signal (`cta`) | **Stripe Blurple** | `#533AFD` | same hue, lifted (`#6E71FF`) |
| Success | **Apple** green | `#34C759` | `#30D158` |
| Danger | **Apple** red | `#FF383C` | `#FF4245` |
| Warning | **Apple** yellow | `#FFCC00` | `#FFD600` |
| Info, links | **Apple** blue | `#0071E3` | `#0091FF` |
| Hero wash (aurora) | Clay `#D97757`, Stripe orange `#FF911E`, Anthropic Sky `#6A9BCC`, Sage `#788C5D` | | |
| Charts | Clay, Stripe, Anthropic Sky, NVIDIA `#76B900`, SAP `#6C32A9`, Microsoft `#882A8B`, Apple | 8 series | 8 series |
| High-contrast dark | Vercel-style pure black | — | `#000000` |

Why the hero wash has no purple/pink: a violet-pink gradient is the most recognisable "AI template" look. Stripe's identity stays through
Blurple and its orange.

**Button text.** Bright fills carry Slate text (NVIDIA's "bright fill + black text"): Clay 5.9:1, Apple red 5.2:1, green 8.3:1, yellow 12.2:1.
Only the two cool fills (Blurple, Apple blue) carry white (6.2:1 and 4.7:1). Apple red with white text would be 3.6:1 and fail AA, so it is not used.

## 2. Evidence (reproducible)

* Declared contrast pairs: **184** per standard theme (light, dark) and **176** per high-contrast theme — **720** in total, 0 failures (`scripts/color/contrast.test.ts`, 768 tests in all).
* Exactness is tested: Clay fill `#D97757`, Apple status fills, Blurple `#533AFD`, and the Anthropic neutrals must equal the published values.
* Chart categories: minimum pairwise ΔE **0.1006** (light) / **0.0967** (dark) under normal, protan, deutan and tritan vision (gate 0.09); every colour ≥ 3:1 on every surface.
  Eight colours that are *both* exactly brand-published *and* colour-blind-separable do not exist (best exact set: 0.078), so chart hues are the brand hues with lightness/chroma tuned; series 1 stays Clay (dark theme: exactly `#D97757`).
* Static assets: the app tile is Clay `#D97757`, Slate V, Ivory dot (`public/brand/vireek-tile.svg`); all PWA / favicon / Apple / Chrome-extension icons are rendered from that geometry by `python3 scripts/brand/render_tile_icons.py` (Pillow only).
* Status colour must always carry an icon or a label: coloured text is weaker under colour-blindness than coloured fills.

## 3. Rules

1. Semantic tokens only (`bg-accent`, `text-on-accent`, `border-border`). Never hex, `rgb()` or Tailwind palette classes (`text-gray-600`, `bg-red-700`, `bg-warning-500/10`).
2. Text on a solid fill is always `text-on-<family>`. Tinted chips: `bg-<family>-subtle text-<family>-strong`.
3. Footer or any always-dark band: put the `dark` class on the element, not hand-picked colours.
4. Official third-party artwork (e.g. the Microsoft logo in `fieldServiceMarks.tsx`) keeps its own colours and is marked `/* color-ok: … */`.
5. Aurora alphas live in two places that must change together: `AURORA_ALPHA` (+ `AURORA_DARK_SCALE`) in `palette.mjs` and `.bg-gradient-aurora` in `index.css`.
6. After editing `palette.mjs`: `npm run tokens:build && npm run tokens:export && npm run tokens:preview && npm run lint:palette && npm test`.
7. Raster brand art that is not generated from the tile geometry (hero / product screenshots, `og-image.png`) is design work, not part of this system.
