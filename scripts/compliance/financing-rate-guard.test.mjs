import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText, applyAllowlist, scanRepo, ALLOWLIST } from './financing-rate-guard.mjs';

const rules = (rel, text) => scanText(rel, text).map((f) => f.rule);

test('R1 flags numeric APR defaults and bps literals', () => {
  assert.deepEqual(rules('src/lib/x.ts', 'export function pay(t: number, annualRatePercent = 9.99) {}'), ['R1']);
  assert.deepEqual(rules('src/lib/x.ts', "const T = { term_months: 60, apr_bps: 999 };"), ['R1']);
  assert.deepEqual(rules('src/lib/x.ts', 'const t = { loan: 0.1199 };'), ['R1']);
});
test('R1 ignores zero, provider-bound and comment lines', () => {
  assert.deepEqual(rules('src/lib/x.ts', 'let apr_bps = 0;'), []);
  assert.deepEqual(rules('src/lib/x.ts', 'const apr = offer.apr_bps;'), []);
  assert.deepEqual(rules('src/lib/x.ts', '// e.g. apr_bps: 999 in docs'), []);
});
test('R2 flags rate claims in copy', () => {
  for (const s of ['<p>0% APR for 12 months</p>', "'9.99% APR'", 'No interest if paid in 12', 'interest-free', 'as low as $99', 'low monthly payments']) {
    assert.ok(rules('src/components/a.tsx', s).includes('R2'), s);
  }
});
test('R2 allows provider-formatted rates and neutral copy', () => {
  assert.deepEqual(rules('src/components/a.tsx', '`${(bps / 100).toFixed(2)}% APR`'), []);
  assert.deepEqual(rules('src/components/a.tsx', 'Financing is optional. Terms are set by the lender.'), []);
});
test('payment estimates are flagged only in customer-facing files and financing locale keys', () => {
  const line = 'Roughly ${x}/month over 24 months';
  assert.ok(rules('src/components/quotes/Foo.tsx', line).includes('R2'));
  assert.deepEqual(rules('src/pages/BillingPlansPage.tsx', line), []);
  assert.ok(rules('src/locales/en/a.json', '"financingMonthly": "About {{amount}} per month"').includes('R2'));
  assert.deepEqual(rules('src/locales/en/a.json', '"usage": "About {{n}} per month"'), []);
});
test('R3 flags PLANNING_APR in customer-facing imports only', () => {
  const imp = "import { PLANNING_APR } from '@/lib/serviceFinance';";
  assert.ok(rules('src/components/sales/LadderView.tsx', imp).includes('R3'));
  assert.ok(!rules('src/lib/repairReplaceAdvisor.ts', imp).includes('R3'));
});
test('stale allowlist entries are reported', () => {
  const { stale } = applyAllowlist([], [{ path: 'a', rule: 'R1', match: 'x', reason: 'r' }]);
  assert.equal(stale.length, 1);
});
test('every allowlist entry carries a reason', () => {
  for (const a of ALLOWLIST) assert.ok(a.reason && a.reason.length > 10, a.match);
});
test('repository is clean (fails if a hardcoded rate is introduced)', () => {
  const { kept, stale } = applyAllowlist(scanRepo());
  assert.deepEqual(kept, [], JSON.stringify(kept, null, 2));
  assert.deepEqual(stale, []);
});
