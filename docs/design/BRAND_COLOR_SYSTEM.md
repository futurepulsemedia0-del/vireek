# Vireek colour system v3 — "Aurora Clay"

Single source of truth: `scripts/color/palette.mjs`. Everything else is generated (`npm run tokens:build`, `npm run tokens:export`) or migrated by
`scripts/color/rebrand-hex.mjs` (`npm run lint:palette` forbids any colour outside the palette).

**Idea:** Anthropic's warm ivory / slate world, but brighter and glossier — the Clay hue pushed to a vivid coral-orange — with Apple's
blue and status colours, Stripe's blurple and orange-pink-lilac aurora, and NVIDIA's "bright fill + black text" button logic.

## 1. Where every element comes from

| Element | Inspired by | What Vireek does |
|---|---|---|
| Page, cards, borders | **Anthropic** | Ivory `#FAF9F5`, white cards, surface `#F0EEE6`, border Light Gray `#E8E6DC`; dark: Slate `#141413` |
| **Primary button** | **NVIDIA** (bright fill + black text) + **Apple / Anthropic / Vercel** (pill) | Vivid Clay `#F9774C`, Slate text (6.8:1), full pill, glossy highlight + coloured glow |
| Secondary "dark" button | **Vercel / Anthropic** | Slate pill with Ivory text (inverted in dark theme: Ivory pill) |
| Outline button | **Anthropic / Apple / Vercel** | pill with a 1 px `border-strong`, transparent fill |
| Info / links / "Learn more" | **Apple** | Apple blue `#0071E3` family (`info`) |
| Live / AI signal (`cta`) | **Stripe** | Blurple `#533AFD` (Lilac `#7E6BFD` in dark) |
| Status | **Apple** | Green `#34C759`, Red `#FF383C`, Yellow `#FFCC00` (dark variants `#30D158`, `#FF4245`, `#FFD600`) |
| Danger *text* | **Apple** | Apple Pink hue `#FF2D55` / `#FF375F` so it stays distinguishable from Clay |
| Header | **Anthropic / Apple** | translucent `bg-secondary/80` bar, hairline border, pill login + glossy pill CTA |
| Hero backdrop | **Stripe / SAP** | `bg-gradient-aurora`: vivid clay, coral pink, lilac, blurple washes (dark theme: ×0.4) |
| Footer | **Anthropic / Vercel** | always-dark Slate footer (`<footer class="dark …">` flips every token inside it) |
| Corners | **Apple / Anthropic / Vercel** | buttons and header CTAs: full pill (implemented in `Button.tsx` + `Header.tsx`). Cards, inputs and panels keep the project's existing radius tokens (`scripts/design/radius-tokens.mjs`) |
| Charts | all seven | 8 hues: Vivid Clay, Blurple, SAP blue + violet, Stripe pink / orange, Microsoft magenta, NVIDIA lime, Anthropic Fig / Sage / Sky |

## 2. Evidence (reproducible)

* 4 themes × 180 declared pairs = **720**, 0 failures (`contrast.test.ts`).
* Chart categories: minimum ΔE **0.098** (light) / **0.096** (dark) under normal, protan, deutan and tritan vision; every colour ≥ 3:1 on every surface.
* Anchors checked exactly: Ivory / Slate / Light Gray / Mid Gray, Vivid Clay fill `#F9774C`, Apple green / yellow fills, Stripe blurple `#533AFD` / Lilac `#7E6BFD`.
* Translucent tints (`bg-accent/5…/20`) are part of the solver (they were the main regression source): `lint:surfaces` 2647 → **1614** failing class strings (all remaining ones existed before the rebrand: raw `*-500` scale classes).
* Colour-blind separation between the six semantic families (smallest ΔE of any pair): fills light 0.117 / 0.062 / 0.024 / 0.067 (normal / protan / deutan / tritan), dark 0.115 / 0.075 / 0.031 / 0.084. Coloured **text** is weaker (0.065–0.073 normal vision, ≤ 0.03 under colour-blindness) — **status must always carry an icon or a label.**

## 3. Rules

1. Semantic tokens only (`bg-accent`, `text-on-accent`, `bg-gloss`, `shadow-gloss`, `border-border`). Never hex / `rgb()` / Tailwind palette classes.
2. Text on a solid fill is always `text-on-<family>`.
3. Footer / any always-dark band: put the `dark` class on the element, not hand-picked colours.
4. Aurora alphas live in two places that must change together: `AURORA_ALPHA` (+ `AURORA_DARK_SCALE`) in `palette.mjs` and `.bg-gradient-aurora` in `index.css`.
5. After editing `palette.mjs`: `npm run tokens:build && npm run tokens:export && npm test`.
