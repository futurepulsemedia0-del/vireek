# Layout tokens: z-index, elevation, arbitrary values

Source of truth: `scripts/design/layout-tokens.mjs` (z layers, shadow map, exact tokens) → consumed by `tailwind.config.js`, the codemod and the guard.

## Z-index layers (`z-<name>`)
| Layer | Value | Use |
|---|---|---|
| behind | -10 | decorative backgrounds (`-z-10`) |
| base / raised | 0 / 10 | normal flow / local lift inside one component |
| dropdown | 20 | absolutely-positioned menus inside a component |
| sticky | 30 | header, sidebar, bottom nav, sticky action bars |
| banner | 40 | cookie/consent banner, offline/degraded/update banners, bulk-action bar, floating widgets |
| overlay | 50 | backdrops (`fixed inset-0`, no content), product tour |
| modal | 60 | dialogs, sheets, drawers (panel and flex wrapper) |
| command | 70 | command / global-search palette (opens over dialogs) |
| popover | 80 | portalled popovers/menus that must clear dialogs |
| toast | 90 | toasts, undo bar, route progress |
| tooltip | 100 | tooltips |
| blocking | 110 | app lock, re-auth, forced update gate |
| skip | 120 | skip-to-content link |
| max | 130 | full-screen loading overlay, pull-to-refresh |

Rules: never write `z-50` / `z-[n]` / `zIndex: n`. Same layer = DOM order decides. Backdrop = `overlay`, its panel = `modal`.
The extra layers beyond the nine requested (behind, banner, command, blocking, skip, max) exist because real code needed them.
After migration, move `zIndex` from `theme.extend` to `theme` in tailwind.config.js to remove numeric keys entirely.

## Elevation (`shadow-elevation-1…4`)
Values in `src/styles/elevation.css` (light + `.dark`), built from the card family. 1 = old `shadow-sm`, 2 = card (`shadow-card` stays, ≡ 2), 3 = old `shadow-lg`, 4 = old `shadow-xl/2xl`. Named exact tokens: `ring-*-soft/faint`, `glow-*`, `handle`, `spotlight`, `showcase`.

## Arbitrary values: when allowed
Allowed (no comment needed): `var(--x)`, `env(safe-area-*)`, `calc/clamp/min/max()`, `em`/`%` values. Data-driven values: set a CSS variable with `cssVars({ '--w': \`${n}%\` })` and consume with `w-[var(--w)]`.
Otherwise use a theme token (`min-h-touch` = 44px, `max-w-panel-xl` = 640px, `max-h-sheet` = 92vh …) or add one. One-offs: `// ds-allow: <reason>` on the line or above. Remaining legacy cases live in `layout-guard.baseline.json`, which can only shrink (`node scripts/design/layout-guard.mjs --update-baseline` after fixing some).
Third-party overrides and truly one-off geometry must carry a `ds-allow` reason.

## Workflow
1. `node scripts/design/normalize-layout.mjs` (dry run) → review → `--apply`. 2. `npx tsc -b && npm test && npm run lint:design`. 3. `node scripts/design/layout-guard.mjs --update-baseline`. 4. Run `e2e/layering.spec.ts` and inspect screenshots.
