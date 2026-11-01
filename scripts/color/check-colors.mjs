#!/usr/bin/env node
// scripts/color/check-colors.mjs — `npm run lint:colors` (CI gate). Enforces colour tokens in src/**/*.{ts,tsx,css}.
//   ZERO tolerance: raw Tailwind palette classes, palette-scale classes on UI utilities, white/black text on a solid
//   status fill (use text-on-<family>).
//   RATCHET: hex / rgb() / hsl() literals — existing debt (canvas, PDF, email HTML, tenant brand data) is frozen in
//   scripts/color/color-baseline.json; a file may never gain MORE literal lines than its baseline.
//   Deliberate exception: put `// color-ok: <reason>` on the line.
//   After REDUCING debt:  node scripts/color/check-colors.mjs --update-baseline
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src');
const BASELINE_PATH = join(ROOT, 'scripts', 'color', 'color-baseline.json');
const UPDATE = process.argv.includes('--update-baseline');

const PALETTES = '(?:slate|gray|zinc|neutral|stone|red|rose|orange|amber|yellow|green|emerald|lime|teal|blue|sky|cyan|indigo|violet|purple|fuchsia|pink)';
const RAW_PALETTE = new RegExp(`(?<![\\w-])(?:[a-z0-9-]+:)*!?(?:bg|text|border|ring|outline|divide|from|via|to|fill|stroke|placeholder|decoration|caret|shadow|accent)-${PALETTES}-\\d{2,3}`);
const SCALE_UI = /(?<![\w-])(?:[a-z0-9-]+:)*!?(?:bg|text|border|ring|outline|divide|fill|stroke)-(?:accent|cta|success|danger|warning|info)-\d{2,3}\b/;
const ON_FILL = /\bbg-(?:accent|cta|success|danger|warning|info)(?:-hover|-active)?\b(?!-)[^"'`]*\btext-(?:white|black)\b|\btext-(?:white|black)\b[^"'`]*\bbg-(?:accent|cta|success|danger|warning|info)(?:-hover|-active)?\b(?!-)/;
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/;
const COLOR_FN = /\b(?:rgba?|hsla?|hwb)\(\s*(?!var\()[\d.]/;
const EXEMPT = /(tokens\.generated|[\\/]test[\\/]|\.test\.|\.spec\.)/;

const violations = [];
const literalCounts = {};
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { if (entry !== 'node_modules') walk(full); continue; }
    if (!['.ts', '.tsx', '.css'].includes(extname(entry)) || EXEMPT.test(full)) continue;
    const rel = relative(ROOT, full).split(sep).join('/');
    readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || /color-ok:/.test(line)) return;
      const snippet = t.slice(0, 110);
      if (RAW_PALETTE.test(line)) violations.push({ rule: 'raw Tailwind palette class → use a semantic token (text-text-secondary, bg-success-subtle, border-border-strong …)', rel, line: i + 1, snippet });
      if (SCALE_UI.test(line)) violations.push({ rule: 'palette-scale class on a UI utility → bg-accent / text-accent / bg-accent-subtle … (scales are for gradients only)', rel, line: i + 1, snippet });
      if (ON_FILL.test(line)) violations.push({ rule: 'text on a solid status fill must be text-on-<family>, not text-white/black', rel, line: i + 1, snippet });
      if (HEX.test(line) || COLOR_FN.test(line)) literalCounts[rel] = (literalCounts[rel] ?? 0) + 1;
    });
  }
})(SRC);

if (UPDATE) {
  writeFileSync(BASELINE_PATH, JSON.stringify(Object.fromEntries(Object.entries(literalCounts).sort()), null, 2) + '\n');
  console.log(`Baseline rewritten: ${Object.keys(literalCounts).length} files, ${Object.values(literalCounts).reduce((a, b) => a + b, 0)} literal lines.`);
  process.exit(0);
}
const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};
for (const [rel, n] of Object.entries(literalCounts)) {
  if (n > (baseline[rel] ?? 0)) violations.push({ rule: 'new hex/rgb()/hsl() literal outside the baseline → use rgb(var(--token)) or a semantic class (or `// color-ok: reason`)', rel, line: 0, snippet: `${n} literal line(s), baseline allows ${baseline[rel] ?? 0}` });
}
const debt = Object.values(literalCounts).reduce((a, b) => a + b, 0);
if (debt) console.log(`ℹ colour-literal debt (frozen by baseline): ${debt} line(s) in ${Object.keys(literalCounts).length} file(s)`);
if (!violations.length) { console.log('✔ Colour-token check passed.'); process.exit(0); }
console.error(`✘ ${violations.length} colour violation(s):`);
for (const v of violations) console.error(`  ${v.rel}:${v.line}  [${v.rule.split(' → ')[0]}]  ${v.snippet}`);
console.error('\nSee docs/design/COLOR_TOKENS.md. Fix the lines above, then re-run: npm run lint:colors');
process.exit(1);
