import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText, isExempt, findRegressions, mergeShrinkOnly } from './regionalAssumptions.mjs';

test('detects each assumption class', () => {
  assert.deepEqual(scanText('const s = `$${(c/100).toFixed(2)}`;'), { 'usd-dollar-template': 1 });
  assert.deepEqual(scanText("fmt({ currency: 'USD' })"), { 'usd-currency-literal': 1 });
  assert.deepEqual(scanText("new Foo('en-US')"), { 'en-us-locale-literal': 1 });
  assert.deepEqual(scanText('const t = "72°F within 5 miles of 1,200 sq ft";'), { 'imperial-unit-literal': 3 });
  assert.deepEqual(scanText("placeholder='MM/DD/YYYY'"), { 'us-date-format-literal': 1 });
});
test('ignores comments and clean code', () => {
  assert.deepEqual(scanText('// currency: "USD" and 5 miles\n/* en-US */ const x = 1;'), {});
  assert.deepEqual(scanText('formatCentsIn(c, currency)'), {});
});
test('the formatting layer and tests are exempt, features are not', () => {
  for (const p of ['src/lib/regional.ts', 'src/lib/format.ts', 'src/lib/regionConfig/money.ts', 'src/lib/regionalPacks/packTax.ts', 'src/locales/de/x.ts', 'src/lib/a.test.ts', 'src/i18n/index.ts']) assert.equal(isExempt(p), true, p);
  for (const p of ['src/pages/Jobs.tsx', 'src/lib/pricing.ts']) assert.equal(isExempt(p), false, p);
});
test('ratchet: growth and new files fail, equal/shrink pass', () => {
  const base = { 'src/a.ts': { 'usd-currency-literal': 2 } };
  assert.deepEqual(findRegressions({ 'src/a.ts': { 'usd-currency-literal': 2 } }, base), []);
  assert.deepEqual(findRegressions({ 'src/a.ts': { 'usd-currency-literal': 1 } }, base), []);
  assert.equal(findRegressions({ 'src/a.ts': { 'usd-currency-literal': 3 } }, base).length, 1);
  assert.equal(findRegressions({ 'src/b.ts': { 'en-us-locale-literal': 1 } }, base).length, 1);
  assert.equal(findRegressions({ 'src/a.ts': { 'imperial-unit-literal': 1 } }, base).length, 1);
});
test('shrink-only baseline never grows an existing entry', () => {
  const merged = mergeShrinkOnly({ 'src/a.ts': { 'usd-currency-literal': 5 }, 'src/b.ts': { 'usd-currency-literal': 1 } }, { 'src/a.ts': { 'usd-currency-literal': 2 } });
  assert.equal(merged['src/a.ts']['usd-currency-literal'], 2);
});
