#!/usr/bin/env node
// scripts/color/apply-surface-edits.mjs — RUN ONCE, THEN DELETE.
// Applies every hand-edit of the contrast migration that no tool can derive, as exact-string edits. Two phases:
//   1. validate: every `old` string must occur exactly once (or the edit must already be applied) — otherwise NOTHING is written;
//   2. write.
// Idempotent. Run AFTER `npm run codemod:colors -- --write` and BEFORE `npm run fix:surfaces -- --write`.
//   node scripts/color/apply-surface-edits.mjs [--dry]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const DRY = process.argv.includes('--dry');
const EDITS = [
 {
  "file": "src/lib/ui/interaction.ts",
  "old": "rest: 'bg-accent text-on-accent shadow-sm dark:text-bg-primary',",
  "new": "rest: 'bg-accent text-on-accent shadow-sm',",
  "count": 1
 },
 {
  "file": "src/lib/ui/interaction.ts",
  "old": "rest: 'bg-danger text-bg-primary shadow-sm',",
  "new": "rest: 'bg-danger text-on-danger shadow-sm',",
  "count": 1
 },
 {
  "file": "scripts/color/check-colors.mjs",
  "old": "const HEX = ",
  "new": "// A solid family fill must take ONLY text-on-<family>: any other text colour on it (also behind a dark:/hover: variant, or\n// text-bg-primary / text-text-inverse) silently bypasses the contrast gate (this is how `dark:text-bg-primary` hid a 4.12:1 button).\nconst FILL_OWN_TEXT = /(?<![\\w-])bg-(accent|cta|success|danger|warning|info)(?![-/\\w])/;\nconst FILL_BAD_TEXT = /(?<![\\w-])(?:[a-z0-9-]+:)*text-(?:white|black|bg-primary|bg-secondary|text-inverse|text-primary|static-white|static-black)(?![-/\\w])/;\n// Judged per class-string literal (ternary branches are separate strings), plus per whole template literal for the hard-banned white/black.\nconst fillTextViolation = (line) =>\n  line.split(/[`'\"]/).some((seg) => FILL_OWN_TEXT.test(seg) && FILL_BAD_TEXT.test(seg)) ||\n  (line.match(/`[^`]*`/g) ?? []).some((tpl) => FILL_OWN_TEXT.test(tpl) && /(?<![\\w-])(?:[a-z0-9-]+:)*text-(?:white|black)(?![-/\\w])/.test(tpl));\nconst HEX = ",
  "count": 1
 },
 {
  "file": "scripts/color/check-colors.mjs",
  "old": "      if (ON_FILL.test(line))",
  "new": "      if (fillTextViolation(line) && !ON_FILL.test(line)) violations.push({ rule: 'solid fill with a non-on-<family> text colour (incl. dark: overrides) → text-on-<family> only', rel, line: i + 1, snippet });\n      if (ON_FILL.test(line))",
  "count": 1
 },
 {
  "file": "scripts/color/check-colors.mjs",
  "old": "\\.spec\\.)/;",
  "new": "\\.spec\\.|[\\\\/]lib[\\\\/]readableText\\.ts)/; // readableText.ts is colour MATH on arbitrary tenant colours — hex literals are its subject",
  "count": 1
 },
 {
  "file": "scripts/color/palette.mjs",
  "old": "  // legacy aliases (kept so every existing `rgb(var(--accent-primary))` keeps working)",
  "new": "  // brand gradient (cobalt → copper). ONE on-colour has to clear BOTH ends, and in dark mode the light copper fill\n  // (cta-fill, graphite text) can never share a text colour with cobalt — so the copper END is solved darker until white passes.\n  // sRGB interpolation of two colours that each clear the target is never lighter than the lighter end (luminance is convex).\n  {\n    const [cL, cC, ch] = FAMILIES.cta.fillSeed[mode];\n    tok['brand-from'] = tok['accent-fill'];\n    tok['brand-to'] = oklchToRgb(solveL(cL, cC, ch, [WHITE], tgt.on, -1), cC, ch);\n    tok['on-brand'] = WHITE;\n  }\n\n  // legacy aliases (kept so every existing `rgb(var(--accent-primary))` keeps working)",
  "count": 1
 },
 {
  "file": "scripts/color/palette.mjs",
  "old": "  // translucent / composited surfaces\n",
  "new": "  add('on-brand', 'brand-from', hc ? 7 : 4.5, 'text on brand gradient (start)');\n  add('on-brand', 'brand-to', hc ? 7 : 4.5, 'text on brand gradient (end)');\n  // High-contrast: a white-7:1 fill is necessarily dark, so its edge vs a black page can't also reach 3:1 — the label (7:1) carries identification, as for every other *-fill.\n  if (!hc) for (const s of surfaces) { add('brand-from', s, 3, 'brand gradient start vs page (1.4.11)'); add('brand-to', s, 3, 'brand gradient end vs page (1.4.11)'); }\n  // translucent / composited surfaces\n",
  "count": 1
 },
 {
  "file": "scripts/color/tailwind-colors.mjs",
  "old": "  ai: v('cta-fill'),",
  "new": "  ai: v('cta-fill'),\n  // brand gradient: `bg-gradient-to-br from-brand-from to-brand-to text-on-brand` (contrast-solved in both themes)\n  'brand-from': v('brand-from'),\n  'brand-to': v('brand-to'),\n  'on-brand': v('on-brand'),",
  "count": 1
 },
 {
  "file": "src/pages/TokensPreview.tsx",
  "old": "rounded-lg bg-accent text-white\">",
  "new": "rounded-lg bg-accent text-on-accent\">",
  "count": 1
 },
 {
  "file": "src/pages/TokensPreview.tsx",
  "old": "rounded-full bg-success-500\" />",
  "new": "rounded-full bg-success\" />",
  "count": 1
 },
 {
  "file": "src/pages/TokensPreview.tsx",
  "old": "rounded-full bg-warning-500\" />",
  "new": "rounded-full bg-warning\" />",
  "count": 1
 },
 {
  "file": "src/pages/TokensPreview.tsx",
  "old": "rounded-full bg-danger-500\" />",
  "new": "rounded-full bg-danger\" />",
  "count": 1
 },
 {
  "file": "e2e/accessibility.spec.ts",
  "from": "for (const path of PAGES) {",
  "to": null,
  "new": "for (const theme of ['light', 'dark'] as const) {\n  for (const path of PAGES) {\n    test(`${path} has no WCAG 2.2 AA violations [${theme}]`, async ({ page }) => {\n      await page.addInitScript((t) => { try { localStorage.setItem('vireek-theme', t); } catch { /* ignore */ } }, theme);\n      await page.goto(path);\n      await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);\n      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();\n\n      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);\n    });\n  }\n}\n"
 },
 {
  "file": "src/components/brand/BrandLogoGuide.tsx",
  "old": "rounded-full text-white ${ok ? 'bg-success' : 'bg-danger'}`}",
  "new": "rounded-full ${ok ? 'bg-success text-on-success' : 'bg-danger text-on-danger'}`}",
  "count": 1
 },
 {
  "file": "src/components/technician/VoiceLogPanel.tsx",
  "old": "font-bold text-white ${recording ? 'bg-danger' : 'bg-accent'}`}",
  "new": "font-bold ${recording ? 'bg-danger text-on-danger' : 'bg-accent text-on-accent'}`}",
  "count": 1
 },
 {
  "file": "src/components/video/VideoCallRoom.tsx",
  "old": "rounded-full text-white transition-colors disabled:opacity-40 ${danger ? 'bg-danger hover:brightness-110' : active ? 'bg-bg-secondary text-black' : 'bg-bg-secondary/15 hover:bg-bg-secondary/25'}`}",
  "new": "rounded-full text-static-white transition-colors disabled:opacity-40 ${danger ? 'bg-danger text-on-danger hover:brightness-110' : active ? 'bg-static-white text-static-black' : 'bg-static-white/15 hover:bg-static-white/25'}`}",
  "count": 1
 },
 {
  "file": "src/pages/SurveysPage.tsx",
  "old": "'bg-bg-secondary/25 text-white'",
  "new": "'bg-on-accent text-accent-fill'",
  "count": 1
 },
 {
  "file": "src/components/PaymentFailedBanner.tsx",
  "old": "rounded-2xl text-white ${\n              isSuspended ? 'bg-danger' : 'bg-warning'\n            }`}",
  "new": "rounded-2xl ${\n              isSuspended ? 'bg-danger text-on-danger' : 'bg-warning text-on-warning'\n            }`}",
  "count": 1
 },
 {
  "file": "src/components/PaymentFailedBanner.tsx",
  "old": "text-sm font-semibold text-white shadow-glow-cta",
  "new": "text-sm font-semibold shadow-glow-cta",
  "count": 1
 },
 {
  "file": "src/components/PaymentFailedBanner.tsx",
  "old": "isSuspended ? 'bg-danger' : 'bg-cta'",
  "new": "isSuspended ? 'bg-danger text-on-danger' : 'bg-cta text-on-cta'",
  "count": 1
 },
 {
  "file": "src/components/UsageLimitBanner.tsx",
  "old": "rounded-2xl text-white ${\n              hasOverage ? 'bg-warning' : 'bg-danger'\n            }`}",
  "new": "rounded-2xl ${\n              hasOverage ? 'bg-warning text-on-warning' : 'bg-danger text-on-danger'\n            }`}",
  "count": 1
 },
 {
  "file": "src/components/UsageLimitBanner.tsx",
  "old": "text-sm font-semibold text-white shadow-glow-cta",
  "new": "text-sm font-semibold shadow-glow-cta",
  "count": 1
 },
 {
  "file": "src/components/UsageLimitBanner.tsx",
  "old": "hasOverage ? 'bg-cta' : 'bg-danger'",
  "new": "hasOverage ? 'bg-cta text-on-cta' : 'bg-danger text-on-danger'",
  "count": 1
 },
 {
  "file": "src/pages/JobsPage.tsx",
  "old": "const ALL_STATUSES: { key: JobStatus; label: string; color: string }[] = [",
  "new": "/** A status dot colour → its solid badge pair (text-on-* per docs/design/COLOR_TOKENS.md; never text-white on a fill). */\nconst STATUS_BADGE: Record<string, string> = {\n  'bg-accent': 'bg-accent text-on-accent',\n  'bg-info': 'bg-info text-on-info',\n  'bg-warning': 'bg-warning text-on-warning',\n  'bg-success': 'bg-success text-on-success',\n  'bg-danger': 'bg-danger text-on-danger',\n};\n\nconst ALL_STATUSES: { key: JobStatus; label: string; color: string }[] = [",
  "count": 1
 },
 {
  "file": "src/pages/JobsPage.tsx",
  "old": "${ALL_STATUSES.find((s) => s.key === job.job_status)?.color ?? 'bg-bg-tertiary'} text-white`}",
  "new": "${STATUS_BADGE[ALL_STATUSES.find((s) => s.key === job.job_status)?.color ?? ''] ?? 'bg-bg-tertiary text-text-secondary'}`}",
  "count": 1
 },
 {
  "file": "src/pages/JobsPage.tsx",
  "old": "borderColor: 'border-t-blue-500'",
  "new": "borderColor: 'border-t-info'",
  "count": 1
 },
 {
  "file": "src/pages/JobsPage.tsx",
  "old": "borderColor: 'border-t-warning-500'",
  "new": "borderColor: 'border-t-warning'",
  "count": 1
 },
 {
  "file": "src/pages/JobsPage.tsx",
  "old": "borderColor: 'border-t-success-500'",
  "new": "borderColor: 'border-t-success'",
  "count": 1
 },
 {
  "file": "src/pages/LeadsPage.tsx",
  "old": "const ALL_STATUSES: { key: JobStatus; label: string; color: string }[] = [",
  "new": "/** A status dot colour → its solid badge pair (text-on-* per docs/design/COLOR_TOKENS.md; never text-white on a fill). */\nconst STATUS_BADGE: Record<string, string> = {\n  'bg-accent': 'bg-accent text-on-accent',\n  'bg-info': 'bg-info text-on-info',\n  'bg-warning': 'bg-warning text-on-warning',\n  'bg-success': 'bg-success text-on-success',\n  'bg-danger': 'bg-danger text-on-danger',\n};\n\nconst ALL_STATUSES: { key: JobStatus; label: string; color: string }[] = [",
  "count": 1
 },
 {
  "file": "src/pages/LeadsPage.tsx",
  "old": "${ALL_STATUSES.find((s) => s.key === job.job_status)?.color ?? 'bg-bg-tertiary'} text-white`}",
  "new": "${STATUS_BADGE[ALL_STATUSES.find((s) => s.key === job.job_status)?.color ?? ''] ?? 'bg-bg-tertiary text-text-secondary'}`}",
  "count": 1
 },
 {
  "file": "src/pages/LeadsPage.tsx",
  "old": "borderColor: 'border-t-blue-500'",
  "new": "borderColor: 'border-t-info'",
  "count": 1
 },
 {
  "file": "src/pages/LeadsPage.tsx",
  "old": "borderColor: 'border-t-warning-500'",
  "new": "borderColor: 'border-t-warning'",
  "count": 1
 },
 {
  "file": "src/pages/LeadsPage.tsx",
  "old": "borderColor: 'border-t-success-500'",
  "new": "borderColor: 'border-t-success'",
  "count": 1
 },
 {
  "file": "src/components/canvassing/CanvassMap.tsx",
  "old": "'circle-color': '#2563eb', 'circle-opacity': 0.85, 'circle-stroke-color': '#ffffff'",
  "new": "'circle-color': '#1d4ed8', 'circle-opacity': 0.85, 'circle-stroke-color': '#ffffff'",
  "count": 1
 },
 {
  "file": "src/components/livemap/LiveMapCanvas.tsx",
  "old": "'#2563eb', '#94a3b8'],",
  "new": "'#2563eb', '#64748b'],",
  "count": 1
 },
 {
  "file": "src/pages/dev/StatesPage.tsx",
  "old": "import { Tooltip } from '@/components/ui/Tooltip';\n",
  "new": "import { Tooltip } from '@/components/ui/Tooltip';\nimport { DeltaBadge } from '@/components/DeltaBadge';\nimport type { Delta } from '@/lib/dateRange';\n",
  "count": 1
 },
 {
  "file": "src/pages/dev/StatesPage.tsx",
  "old": "function Section({",
  "new": "/** Literal class strings on purpose: Tailwind's JIT cannot see dynamically built names. Canonical pairs from docs/design/COLOR_TOKENS.md. */\nconst CHIPS: ReadonlyArray<{ label: string; tint: string; solid: string }> = [\n  { label: 'Accent', tint: 'bg-accent-subtle text-accent-strong', solid: 'bg-accent text-on-accent' },\n  { label: 'CTA', tint: 'bg-cta-subtle text-cta-strong', solid: 'bg-cta text-on-cta' },\n  { label: 'Success', tint: 'bg-success-subtle text-success-strong', solid: 'bg-success text-on-success' },\n  { label: 'Danger', tint: 'bg-danger-subtle text-danger-strong', solid: 'bg-danger text-on-danger' },\n  { label: 'Warning', tint: 'bg-warning-subtle text-warning-strong', solid: 'bg-warning text-on-warning' },\n  { label: 'Info', tint: 'bg-info-subtle text-info-strong', solid: 'bg-info text-on-info' },\n];\nconst DELTAS: ReadonlyArray<Delta> = [\n  { kind: 'percent', direction: 'up', value: 12.5, sentiment: 'good', current: 90, previous: 80 },\n  { kind: 'percent', direction: 'down', value: -8, sentiment: 'bad', current: 46, previous: 50 },\n  { kind: 'percent', direction: 'flat', value: 0, sentiment: 'neutral', current: 50, previous: 50 },\n];\n\nfunction Section({",
  "count": 1
 },
 {
  "file": "src/pages/dev/StatesPage.tsx",
  "old": "      <Section title=\"Copy\">",
  "new": "      <Section title=\"Badge / chip\">\n        <div className=\"flex flex-wrap gap-3\">\n          {CHIPS.map((c) => (\n            <span key={`t-${c.label}`} className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${c.tint}`}>{c.label} tint</span>\n          ))}\n        </div>\n        <div className=\"flex flex-wrap gap-3\">\n          {CHIPS.map((c) => (\n            <span key={`s-${c.label}`} className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${c.solid}`}>{c.label} solid</span>\n          ))}\n        </div>\n        <div className=\"flex flex-wrap gap-3\">\n          {DELTAS.map((d) => (\n            <DeltaBadge key={d.direction} delta={d} />\n          ))}\n        </div>\n      </Section>\n\n      <Section title=\"Copy\">",
  "count": 1
 },
 {
  "file": "e2e/states.spec.ts",
  "old": "'Card', 'Copy']",
  "new": "'Badge / chip', 'Card', 'Copy']",
  "count": 1
 },
 {
  "file": "e2e/dashboard-overview.spec.ts",
  "old": "  test('shows no gradients, glass, or large radii on the page'",
  "new": "  test('has no WCAG 2.2 AA violations [dark]', async ({ page }) => {\n    await page.emulateMedia({ colorScheme: 'dark' });\n    await page.addInitScript(() => { try { localStorage.setItem('vireek-theme', 'dark'); } catch { /* ignore */ } document.documentElement.classList.add('dark'); });\n    await page.goto('/dashboard');\n    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();\n    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();\n    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);\n  });\n\n  test('shows no gradients, glass, or large radii on the page'",
  "count": 1
 },
 {
  "file": "package.json",
  "old": "    \"lint:colors\": \"node scripts/color/check-colors.mjs\",\n",
  "new": "    \"lint:colors\": \"node scripts/color/check-colors.mjs\",\n    \"lint:surfaces\": \"node scripts/color/check-surfaces.mjs\",\n    \"fix:surfaces\": \"node scripts/color/fix-surfaces.mjs\",\n",
  "count": 1
 },
 {
  "file": ".github/workflows/ci.yml",
  "old": "          npm run lint:colors\n",
  "new": "          npm run lint:colors\n          npm run lint:surfaces\n",
  "count": 1
 },
 {
  "file": "src/lib/branding.ts",
  "old": "import { supabase } from '@/lib/supabase';\n",
  "new": "import { supabase } from '@/lib/supabase';\nimport { readableTextColor } from '@/lib/readableText';\n",
  "count": 1
 },
 {
  "file": "src/lib/branding.ts",
  "old": "/** Black or white — whichever reads better on `background`. */\nexport function readableTextColor(background: string): '#FFFFFF' | '#0F172A' {\n  return contrastRatio(background, '#FFFFFF') >= contrastRatio(background, '#0F172A') ? '#FFFFFF' : '#0F172A';\n}\n",
  "new": "/** Text colour for `background` with >= 4.5:1 guaranteed — the single implementation lives in readableText.ts. */\nexport { readableTextColor };\n",
  "count": 1
 },
 {
  "file": "src/lib/chatWidget.ts",
  "from": "/** WCAG-based pick of readable text on top of the brand color. */",
  "to": "/* -------------------------------- hours",
  "new": "/** Readable text on top of the brand color (>= 4.5:1 guaranteed) — single implementation in readableText.ts. */\nexport { readableTextColor };\n\n"
 },
 {
  "file": "src/lib/chatWidget.ts",
  "prepend": "import { readableTextColor } from '@/lib/readableText';\n"
 },
 {
  "file": "src/lib/landingPageUtils.ts",
  "from": "/** WCAG relative luminance: pick dark or light text for a given accent background. */",
  "to": "export function emptyDraft()",
  "new": "/** Readable text for a given accent background (>= 4.5:1 guaranteed) — single implementation in readableText.ts. */\nexport { readableTextColor };\n\n"
 },
 {
  "file": "src/lib/landingPageUtils.ts",
  "afterBlank": "import { readableTextColor } from '@/lib/readableText';\n"
 },
 {
  "file": "src/lib/chatWidget.test.ts",
  "old": "expect(readableTextColor('#FFFFFF')).toBe('#111827');",
  "new": "expect(readableTextColor('#FFFFFF')).toBe('#0F172A');",
  "count": 1
 },
 {
  "file": "src/lib/landingPageUtils.test.ts",
  "old": "expect(readableTextColor('#ffffff')).toBe('#0f172a');",
  "new": "expect(readableTextColor('#ffffff')).toBe('#0F172A');",
  "count": 1
 },
 {
  "file": "src/lib/landingPageUtils.test.ts",
  "old": "expect(readableTextColor('#facc15')).toBe('#0f172a');",
  "new": "expect(readableTextColor('#facc15')).toBe('#0F172A');",
  "count": 1
 },
 {
  "file": "src/lib/landingPageUtils.test.ts",
  "old": "expect(readableTextColor('#000000')).toBe('#ffffff');",
  "new": "expect(readableTextColor('#000000')).toBe('#FFFFFF');",
  "count": 1
 },
 {
  "file": "src/lib/landingPageUtils.test.ts",
  "old": "expect(readableTextColor('bad')).toBe('#ffffff');",
  "new": "expect(readableTextColor('nope')).toBe('#FFFFFF');",
  "count": 1
 },
 {
  "file": "public/chat-widget.js",
  "old": "  function textOn(hex) {\n    var m = /^#([0-9a-f]{6})$/i.exec(hex);\n    if (!m) return '#FFFFFF';\n    var ch = [0, 2, 4].map(function (i) { var v = parseInt(m[1].slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });\n    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2] > 0.4 ? '#111827' : '#FFFFFF';\n  }\n",
  "new": "  // <readable-text> — same algorithm as src/lib/readableText.ts (parity-tested): white or ink if one reaches 4.5:1, else black\n  function textOn(hex) {\n    function lm(r, g, b) { var c = [r, g, b].map(function (x) { var v = x / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }\n    var raw = String(hex == null ? '' : hex).trim().replace(/^#/, '');\n    if (/^[0-9a-f]{3}$/i.test(raw)) raw = raw.replace(/./g, function (ch) { return ch + ch; });\n    if (!/^[0-9a-f]{6}$/i.test(raw)) return '#FFFFFF';\n    var L = lm(parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16));\n    var K = lm(15, 23, 42);\n    var w = 1.05 / (L + 0.05);\n    var k = (Math.max(L, K) + 0.05) / (Math.min(L, K) + 0.05);\n    return Math.max(w, k) >= 4.5 ? (w >= k ? '#FFFFFF' : '#0F172A') : '#000000';\n  }\n  // </readable-text>\n",
  "count": 1
 },
 {
  "file": "public/website-widgets.js",
  "old": "  function textOn(hex) {\n    var m = /^#([0-9a-f]{6})$/i.exec(hex);\n    if (!m) return '#FFFFFF';\n    return lum(parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)) > 0.4 ? '#111827' : '#FFFFFF';\n  }\n",
  "new": "  // <readable-text> — same algorithm as src/lib/readableText.ts (parity-tested): white or ink if one reaches 4.5:1, else black\n  function textOn(hex) {\n    function lm(r, g, b) { var c = [r, g, b].map(function (x) { var v = x / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }\n    var raw = String(hex == null ? '' : hex).trim().replace(/^#/, '');\n    if (/^[0-9a-f]{3}$/i.test(raw)) raw = raw.replace(/./g, function (ch) { return ch + ch; });\n    if (!/^[0-9a-f]{6}$/i.test(raw)) return '#FFFFFF';\n    var L = lm(parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16));\n    var K = lm(15, 23, 42);\n    var w = 1.05 / (L + 0.05);\n    var k = (Math.max(L, K) + 0.05) / (Math.min(L, K) + 0.05);\n    return Math.max(w, k) >= 4.5 ? (w >= k ? '#FFFFFF' : '#0F172A') : '#000000';\n  }\n  // </readable-text>\n",
  "count": 1
 },
 {
  "file": "supabase/functions/_shared/direct-mail/engine.ts",
  "old": "export function readableTextColor(hex: string): string {\n  const h = isHexColor(hex) ? hex : \"#0F62FE\";\n  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));\n  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? \"#111111\" : \"#FFFFFF\";\n}\n",
  "new": "// <readable-text> — same algorithm as src/lib/readableText.ts (parity-tested): white or ink if one reaches 4.5:1, else black\nexport function readableTextColor(hex: string): string {\n  const lm = (r: number, g: number, b: number): number => {\n    const c = [r, g, b].map((x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });\n    return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);\n  };\n  let raw = String(hex ?? \"\").trim().replace(/^#/, \"\");\n  if (/^[0-9a-f]{3}$/i.test(raw)) raw = raw.replace(/./g, (ch) => ch + ch);\n  if (!/^[0-9a-f]{6}$/i.test(raw)) return \"#FFFFFF\";\n  const L = lm(parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16));\n  const K = lm(15, 23, 42);\n  const w = 1.05 / (L + 0.05);\n  const k = (Math.max(L, K) + 0.05) / (Math.min(L, K) + 0.05);\n  return Math.max(w, k) >= 4.5 ? (w >= k ? \"#FFFFFF\" : \"#0F172A\") : \"#000000\";\n}\n// </readable-text>\n",
  "count": 1
 }
];
const texts = new Map(); const errors = []; let applied = 0, already = 0;
const get = (f) => { if (!texts.has(f)) texts.set(f, readFileSync(join(ROOT, f), 'utf8')); return texts.get(f); };
for (const e of EDITS) {
  let s; try { s = get(e.file); } catch { errors.push(`${e.file}: file not found`); continue; }
  const count = (str) => s.split(str).length - 1;
  // already applied? (checked FIRST: for inserts `new` contains `old`, for slices `new` contains the start marker)
  if (e.new !== undefined && e.prepend === undefined && e.afterBlank === undefined && s.includes(e.new)) { already++; continue; }
  if (e.prepend !== undefined) { if (s.includes(e.prepend)) already++; else { texts.set(e.file, e.prepend + s); applied++; } continue; }
  if (e.afterBlank !== undefined) { if (s.includes(e.afterBlank)) already++; else { const i = s.indexOf('\n\n') + 2; texts.set(e.file, s.slice(0, i) + e.afterBlank + '\n' + s.slice(i)); applied++; } continue; }
  if (e.from !== undefined) {
    const a = s.indexOf(e.from); if (a < 0) { if (s.includes(e.new)) already++; else errors.push(`${e.file}: start marker not found: ${e.from.slice(0, 50)}`); continue; }
    const b = e.to === null ? s.length : s.indexOf(e.to, a);
    if (b < 0) { errors.push(`${e.file}: end marker not found: ${e.to.slice(0, 50)}`); continue; }
    texts.set(e.file, s.slice(0, a) + e.new + s.slice(b)); applied++; continue;
  }
  const n = count(e.old);
  if (n === 0 && s.includes(e.new)) { already++; continue; }
  if (n !== (e.count ?? 1)) { errors.push(`${e.file}: expected ${e.count ?? 1}× but found ${n}×: ${e.old.slice(0, 70).replace(/\n/g, '⏎')}`); continue; }
  texts.set(e.file, s.split(e.old).join(e.new)); applied++;
}
if (errors.length) { console.error(`✘ ${errors.length} edit(s) cannot be applied — NOTHING was written:\n  ` + errors.join('\n  ')); process.exit(1); }
if (!DRY) for (const [f, s] of texts) writeFileSync(join(ROOT, f), s);
console.log(`${DRY ? 'DRY RUN' : 'WROTE'}: ${applied} applied, ${already} already applied, ${texts.size} files.`);
