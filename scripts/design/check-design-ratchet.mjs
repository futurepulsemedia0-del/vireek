#!/usr/bin/env node
// scripts/design/check-design-ratchet.mjs
//
// CI gate for the design-system rules. `npm run lint:design` reports ALL existing debt and exits 1, so it cannot gate CI
// directly. This wrapper freezes today's debt in scripts/design/design-baseline.json and fails only on REGRESSIONS:
// a (rule, file) pair may never have more violations than recorded; files/rules not in the baseline allow zero.
//
//   node scripts/design/check-design-ratchet.mjs            check (CI)
//   node scripts/design/check-design-ratchet.mjs --ratchet  lower baseline entries that improved (never raises)
//   node scripts/design/check-design-ratchet.mjs --init     (re)create the baseline from the current tree
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countViolations, ratcheted, regressions } from './lib/ratchet.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const BASELINE = new URL('./design-baseline.json', import.meta.url).pathname;
const args = process.argv.slice(2);

const tmp = mkdtempSync(join(tmpdir(), 'design-'));
const out = join(tmp, 'violations.json');
const run = spawnSync(process.execPath, [join(ROOT, 'scripts/check-design-system.mjs'), `--json-out=${out}`], { cwd: ROOT, encoding: 'utf8' });
let violations;
try {
  if (run.status !== 0 || !existsSync(out)) throw new Error(`check-design-system failed to run (exit ${run.status}): ${(run.stderr || '').slice(0, 500)}`);
  violations = JSON.parse(readFileSync(out, 'utf8'));
} catch (e) {
  console.error(`✘ ${e.message}`);
  process.exit(2);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const current = countViolations(violations);
const total = violations.length;
const write = (counts, note) => writeFileSync(BASELINE, `${JSON.stringify({ _comment: 'Ratchet: counts may only go down. Regenerate with --ratchet after cleaning up.', counts }, null, 2)}\n`) || console.log(note);

if (args.includes('--init')) {
  write(current, `baseline written: ${Object.keys(current).length} (rule,file) entries, ${total} violations`);
  process.exit(0);
}
if (!existsSync(BASELINE)) {
  console.error('✘ scripts/design/design-baseline.json is missing. Run: node scripts/design/check-design-ratchet.mjs --init');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).counts ?? {};

if (args.includes('--ratchet')) {
  const next = ratcheted(current, baseline);
  write(next, `baseline lowered: ${Object.keys(baseline).length} -> ${Object.keys(next).length} entries`);
  process.exit(0);
}

const bad = regressions(current, baseline);
const frozen = Object.values(baseline).reduce((a, b) => a + b, 0);
if (bad.length === 0) {
  console.log(`✔ Design-system ratchet passed — no new violations (${total} existing, ${frozen} frozen in baseline).`);
  process.exit(0);
}
console.error(`✘ Design-system regressions in ${bad.length} (rule, file) pair(s):\n`);
for (const b of bad) {
  const [rule, file] = b.key.split('|');
  console.error(`  ${file}\n    ${rule}: ${b.actual} (baseline allows ${b.allowed})`);
  for (const v of violations.filter((x) => x.rule === rule && x.file === file).slice(0, 5)) console.error(`      line ${v.line}: ${String(v.snippet).slice(0, 120)}`);
}
console.error('\nFix the new violations (see `npm run lint:design` for the rule text). Do NOT raise the baseline.');
process.exit(1);
