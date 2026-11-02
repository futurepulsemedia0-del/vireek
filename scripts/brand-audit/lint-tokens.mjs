#!/usr/bin/env node
// npm run lint:tokens — fail the build if raw color/size usage GROWS vs scripts/brand-audit/baselines/tokens.json.
//   node scripts/brand-audit/lint-tokens.mjs                     check (CI)
//   node scripts/brand-audit/lint-tokens.mjs --write-baseline    create / shrink the baseline (never raises counts)
//   node scripts/brand-audit/lint-tokens.mjs --write-baseline --force   reset to current counts (needs reviewer sign-off)
//   node scripts/brand-audit/lint-tokens.mjs --list              per-rule totals + worst files
import { scan, ratchet, loadBaseline, writeBaseline, RULES } from './checks/tokens.mjs';

const args = new Set(process.argv.slice(2));
const { perFile, files, exemptFiles } = scan();

if (args.has('--write-baseline')) {
  const n = writeBaseline(perFile, { force: args.has('--force') });
  console.log(`✔ token baseline written for ${n} file(s) (${files} scanned, ${exemptFiles} exempt).`);
  process.exit(0);
}
if (args.has('--list')) {
  for (const rule of Object.keys(RULES)) {
    const rows = Object.entries(perFile).map(([f, r]) => [f, r[rule] ?? 0]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
    console.log(`\n${rule}: ${rows.reduce((a, [, n]) => a + n, 0)} in ${rows.length} files`);
    rows.slice(0, 8).forEach(([f, n]) => console.log(`  ${String(n).padStart(4)}  ${f}`));
  }
  process.exit(0);
}
const baseline = loadBaseline();
if (!baseline) {
  console.error('Missing scripts/brand-audit/baselines/tokens.json — run: node scripts/brand-audit/lint-tokens.mjs --write-baseline');
  process.exit(1);
}
const grown = ratchet(perFile, baseline);
if (!grown.length) { console.log(`✔ Token ratchet OK — no new raw colors/sizes (${files} files scanned).`); process.exit(0); }
console.error(`✘ ${grown.length} file/rule pair(s) added raw tokens (see BRAND_GOVERNANCE.md → "Adding colors"):\n`);
for (const g of grown) console.error(`  ${g.file}  [${g.rule}]  ${g.allowed} → ${g.count}  — ${RULES[g.rule].fix}`);
process.exit(1);
