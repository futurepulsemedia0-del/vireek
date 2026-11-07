// scripts/lib/text-alpha-rule.mjs — Rule 6 of scripts/check-design-system.mjs: NO alpha on text colour.
//   text-<color>/<alpha> and opacity-N on an element that carries a text colour are forbidden.
//   RATCHET (same model as scripts/color/check-colors.mjs): existing debt is frozen per file in scripts/color/text-alpha-baseline.json;
//   a file may never gain MORE violations. Exempt a line deliberately with `// contrast-ok: <reason>` (same or previous line).
//   Create / shrink the baseline:  node scripts/check-design-system.mjs --update-baseline
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { guardViolations, listSourceFiles, relPath, scanFile } from './text-contrast-core.mjs';

export function applyTextAlphaRule(ROOT, violations, argv = process.argv) {
  const found = {};
  for (const f of listSourceFiles(ROOT)) {
    const src = readFileSync(f, 'utf8');
    if (!/text-[a-z][a-z0-9-]*\/|opacity-\d/.test(src)) continue;
    const rel = relPath(ROOT, f), v = guardViolations(scanFile(src, rel).records);
    if (v.length) found[rel] = v;
  }
  const basePath = join(ROOT, 'scripts', 'color', 'text-alpha-baseline.json');
  const counts = Object.fromEntries(Object.entries(found).sort().map(([k, v]) => [k, v.length]));
  if (argv.includes('--update-baseline')) {
    writeFileSync(basePath, JSON.stringify(counts, null, 2) + '\n');
    console.log(`Text-alpha baseline rewritten: ${Object.keys(counts).length} files, ${Object.values(counts).reduce((a, b) => a + b, 0)} violation(s).`);
    process.exit(0);
  }
  const baseline = existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')) : {};
  for (const [rel, v] of Object.entries(found)) {
    const allowed = baseline[rel] ?? 0;
    if (v.length > allowed) for (const r of v) violations.push({ rule: 'no-alpha-text', file: rel, line: r.line, snippet: `${r.raw}  (${v.length} in file, baseline allows ${allowed})` });
  }
  const debt = Object.values(counts).reduce((a, b) => a + b, 0);
  const shrunk = Object.keys(baseline).filter((k) => (counts[k] ?? 0) < baseline[k]).length;
  if (debt) console.log(`ℹ alpha-text debt (frozen by baseline): ${debt} violation(s) in ${Object.keys(counts).length} file(s)${shrunk ? ` — ${shrunk} file(s) improved, run --update-baseline to lock it in` : ''}`);
}
