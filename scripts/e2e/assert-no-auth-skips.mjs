#!/usr/bin/env node
// scripts/e2e/assert-no-auth-skips.mjs <playwright-json-report>
// Fails when any test was SKIPPED because an E2E credential env var was not set (skip reason mentions E2E_TEST_*/E2E_MEMBER_*).
// Other skips (browser-specific, visual-only, data-dependent) are reported but tolerated.
// E2E_REQUIRE_AUTH=0 downgrades to a warning (fork PRs).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CRED_RE = /E2E_(TEST|MEMBER)_(EMAIL|PASSWORD)/;

/** Walk a Playwright JSON report and return skipped tests: [{ title, file, reasons[], credential }] */
export function collectSkips(report) {
  const out = [];
  const walk = (suite, trail) => {
    const here = suite.title ? [...trail, suite.title] : trail;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const skipped = t.status === 'skipped' || (t.results ?? []).some((r) => r.status === 'skipped');
        if (!skipped) continue;
        const reasons = (t.annotations ?? []).filter((a) => a.type === 'skip' || a.type === 'fixme').map((a) => a.description ?? '');
        out.push({ title: [...here, spec.title].join(' › '), file: spec.file ?? suite.file ?? '', reasons, credential: reasons.some((r) => CRED_RE.test(r)) });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const s of report.suites ?? []) walk(s, []);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  if (!file) { console.error('usage: assert-no-auth-skips.mjs <playwright-report.json>'); process.exit(2); }
  let report;
  try { report = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error(`::error::cannot read Playwright JSON report ${file}: ${e.message}`); process.exit(2); }
  const skips = collectSkips(report);
  const cred = skips.filter((s) => s.credential);
  console.log(`Playwright skips: ${skips.length} total, ${cred.length} due to missing E2E credentials.`);
  for (const s of cred) console.log(`  ✘ ${s.file}: ${s.title}`);
  if (cred.length === 0) process.exit(0);
  if ((process.env.E2E_REQUIRE_AUTH ?? '1') === '0') { console.log('::warning::Credential-skips tolerated (fork PR).'); process.exit(0); }
  console.error(`::error title=Authenticated E2E specs were skipped::${cred.length} test(s) skipped for missing E2E credentials. Check the secrets and the seeded account (docs/TESTING.md).`);
  process.exit(1);
}
