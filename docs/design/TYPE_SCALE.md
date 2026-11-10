# Type scale

One rem-based scale. **Nothing renders below 12px (0.75rem)** — in any density, zoom, text-size setting or language.
Single source of truth: [`scripts/type/type-scale.mjs`](../../scripts/type/type-scale.mjs). It feeds `tailwind.config.js`, the CI guard,
the tests and the live page at **`/dev/design-system`** (dev builds only).

## The scale

| Token | Class | rem / px | Line-height | Tracking | Weight | Use |
|---|---|---|---|---|---|---|
| `eyebrow` | `text-eyebrow` | 0.75 / 12 | 1rem | 0.08em | 600 | Section kicker (≤3 words) |
| `caption` | `text-caption` (= `text-xs`) | 0.75 / 12 | 1rem | 0.01em | – | Metadata, badges, axis labels, helper/error text, table meta. **The floor.** |
| `small` | `text-small` (= `text-sm`) | 0.875 / 14 | 1.25rem | – | – | **Dashboard default**: table cells, controls, card body |
| `body` | `text-body` (= `text-base`) | 1 / 16 | 1.5rem | – | – | Marketing / long-form; mobile inputs |
| `lead` | `text-lead` (= `text-lg`) | 1.125 / 18 | 1.75rem | – | – | Intro paragraph |
| `h4` | `text-h4` (= `text-xl`) | 1.25 / 20 | 1.75rem | -0.005em | 600 | Card / section title |
| `h3` | `text-h3` (= `text-2xl`) | 1.5 / 24 | 2rem | -0.01em | 600 | |
| `h2` | `text-h2` (= `text-3xl`) | 1.875 / 30 | 2.25rem | -0.015em | 600 | |
| `h1` | `text-h1` (= `text-4xl`) | 2.25 / 36 | 2.5rem | -0.02em | 700 | Page title |
| `display` | `text-display` (= `text-5xl`) | 3 / 48 | 1 | -0.03em | 700 | Marketing hero |
| `display-lg` | `text-display-lg` (= `text-6xl`) | 3.75 / 60 | 1 | -0.04em | 700 | Hero, large screens |

The stock `text-xs … text-6xl` are **byte-identical** to Tailwind's defaults (tested), so the ~20,000 existing uses changed nothing. Aliases
carry size + line-height only; weight/tracking come from the semantic names. `text-7xl+` remain Tailwind defaults.

Other utilities: **`type-figure`** (lining + tabular numerals, no tracking — money/counts), **`type-id`** (monospace, tabular, slashed zero,
`direction: ltr; unicode-bidi: isolate` — IDs, phone numbers; stays LTR inside RTL text), **`type-inline`** (`max(0.9em, 0.75rem)` — inline code in prose).

## Decisions (and why)

1. **No 13px step.** 12/14/16 is what the product already used; 13 is 1px from both neighbours and adds no hierarchy.
2. **No px root.** The old `html { font-size: 15px }` at ≤640px ignored the user's browser preference and made `0.75rem` render at 11.25px on phones.
3. **Text scaling happens once, at the root:** `html { font-size: calc(100% * --a11y-font-scale * --native-font-scale) }`. Before, only `body` was
   scaled, so Tailwind's rem utilities ignored both the in-app text size and the OS font scale.
4. **Fixed steps, not fluid `clamp()` headings.**
5. **Compact density changes spacing only** (`data-density="compact"` → `py-row`, `gap-dense`, `min-h-target`; `src/lib/density.ts`). Type never changes;
   targets stay ≥2rem (WCAG 2.5.8 needs 24px).
6. **fa/ar:** `letter-spacing: 0` for `lang=fa|ar` (tracking breaks cursive joining); specificity beats any `tracking-*` utility.
7. `<small>`, `<sub>`, `<sup>` are floored (`max(80%, 0.75rem)`): Tailwind's preflight gives 11.2px inside 14px text.

## Rules (enforced)

`npm run lint:type` — zero tolerance, **wired into `ci.yml`**; also Rule 6 of `scripts/check-design-system.mjs`; ESLint selectors give editor feedback.

| Rule | Bans |
|---|---|
| R1 | arbitrary Tailwind text size (`text-[11px]`, `text-[0.65rem]`, `text-[0.9em]`) |
| R2 | any size below 12px in any form: inline `fontSize`, SVG `fontSize`, CSS `font-size` (incl. `clamp/min/max`), `font:` shorthand, `ctx.font` |
| R3 | px font sizes in CSS / inline styles (use rem) |
| R4 | literal SVG `fontSize` (use `useSvgTextSize()`) |
| R5 | a broken allowlist invariant |

Exceptions live only in `scripts/type/text-size-allowlist.json` (per file, per kind, with a reason and an invariant). **The 12px floor (R2) can never be waived.**
One-off: `// type-ok: <reason>` on the line.

**Fixing a "too big for the layout" report: never shrink the text.** Wrap, shorten the label, truncate with a `title`/tooltip, drop a low-priority
column, put the content in a horizontal scroll container, or disclose progressively.

## SVG charts

SVG text is in *user units*, so a 720-wide `viewBox` squeezed to 320px draws `fontSize=11` at ~4.6px. `useSvgTextSize()` measures the real scale and returns the
unit size that renders ≥12px (following the user's root size), and keeps the chart at ≥0.8 of its viewBox width, scrolling its container instead of
squashing (otherwise labels collide with the plot padding). 17 chart components use it.

## Verify

```bash
npm run lint:type                    # the gate
npm run type:measure                 # audit by file / role / surface (router-derived)
npm run type:browser                 # real Chromium: no text <12px at 320/360/390/720/1280, 200% text, WCAG 1.4.12 spacing, compact density
npx vitest run scripts/type src/hooks/useSvgTextSize.test.tsx src/lib
```
`type:browser` needs Chromium (`npx playwright install chromium`, or `CHROMIUM_PATH`) and generated colour tokens (`npm run tokens:build`).

## Known exceptions / limits

- Allowlisted (see JSON): wallboard TV (`em` system; root `clamp(1.075rem, …)` proven ≥12px by `wallboard-floor.test.ts`), floor-plan editor labels,
  logo-construction specimen, document preview, typed-signature preview, DVIR canvas, trust-badge preview. Several draw text in coordinate systems that
  can render below 12px when zoomed out (sketch, logo specimen); they are drawing content, not UI chrome.
- The embeddable trust badge itself, emails and PDFs are produced outside `src/` and are **not** covered.
- Native Dynamic Type needs `@capacitor/text-zoom` and a `cap sync`; it is not declared in this repository snapshot (see the report).
