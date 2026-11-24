// Run: node --experimental-strip-types --no-warnings --test eval/emergency-golden/golden.test.mjs
// Drives the REAL decision code; needs no network, database or LLM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runGolden, coverageGaps, ESCALATION_BUDGET_MS } from './evaluate.ts';
import { GOLDEN_SCENARIOS } from './scenarios.ts';

test('coverage: five hazard classes on both channels, an adversarial and a Spanish case', () => {
  assert.deepEqual(coverageGaps(), []);
});

for (const channel of ['voice', 'chat']) {
  test(`${channel} golden scenarios`, async () => {
    const results = await runGolden(channel);
    assert.equal(results.length, GOLDEN_SCENARIOS.filter((s) => s.channel === channel).length);
    const failed = results.filter((r) => !r.passed);
    assert.deepEqual(failed.map((r) => `${r.id}: ${r.failures.join(' | ')}`), []);
    for (const r of results.filter((x) => x.kind !== 'benign')) {
      assert.equal(r.escalationTurn, 1, `${r.id} must escalate on turn 1`);
      assert.ok(r.escalationMs <= ESCALATION_BUDGET_MS, `${r.id} ${r.escalationMs}ms`);
    }
  });
}

test('the evaluator fails a regression (mutation check): a reply that tells the caller to relight a pilot is caught', async () => {
  const { NEVER_SAY } = await import('./scenarios.ts');
  assert.ok(NEVER_SAY.some((re) => re.test('Okay, first relight the pilot light.')));
  assert.ok(NEVER_SAY.some((re) => re.test("It's probably nothing, wait until morning.")));
  assert.ok(!NEVER_SAY.some((re) => re.test('Leave the building now and call 911 from outside.')));
});
