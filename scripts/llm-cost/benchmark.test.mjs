// node --experimental-strip-types --no-warnings --test scripts/llm-cost/benchmark.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAll, simulateBatch, simulateResponseCache, simulatePromptCache } from './benchmark-lib.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const measured = Object.fromEntries(fixtures.scenarios.filter((s) => s.feature === 'prompt_cache').map((s) => [s.id, { prefixTokens: s.id.includes('static-brief') ? 2451 : 832 }]));
const byId = (rows, id) => rows.find((r) => r.id === id);

test('fixture prices equal the production PRICE_TABLE (drift guard)', () => {
  const src = readFileSync('supabase/functions/_shared/ai-core/costTracking.ts', 'utf8');
  for (const [prov, p] of Object.entries(fixtures.prices)) {
    const block = new RegExp(`${prov}: \\{\\s*default: \\{ inputPer1M: ([0-9.]+), outputPer1M: ([0-9.]+) \\}`).exec(src);
    assert.ok(block, `${prov} default price not found in costTracking.ts`);
    assert.equal(Number(block[1]), p.inputPer1M);
    assert.equal(Number(block[2]), p.outputPer1M);
  }
});

test('the benchmark is deterministic', async () => {
  assert.deepEqual(await runAll(fixtures, measured), await runAll(fixtures, measured));
});

test('prompt cache saves a lot on a long stable prefix and nothing below the provider minimum', async () => {
  const rows = await runAll(fixtures, measured);
  const long = byId(rows, 'prompt-cache-static-brief-chat');
  assert.equal(long.markerSent, true);
  assert.ok(long.savedPct > 50, `expected >50% got ${long.savedPct}`);
  assert.ok(long.afterUsd < long.beforeUsd);
  const short = byId(rows, 'prompt-cache-call-intelligence-as-is');
  assert.equal(short.markerSent, false);
  assert.equal(short.savedPct, 0);
  assert.equal(short.afterUsd, short.beforeUsd);
});

test('a cold cache (traffic slower than the TTL) is never cheaper than no cache: writes cost 1.25x', () => {
  const sc = { ...fixtures.scenarios[0], intervalSec: 1000 };
  const r = simulatePromptCache(sc, fixtures.prices.anthropic, { prefixTokens: 2451 });
  assert.equal(r.cacheReads, 0);
  assert.ok(r.afterUsd > r.beforeUsd, 'cold writes must cost more than uncached calls');
});

test('response cache hits only duplicates and never crosses accounts', async () => {
  const sc = fixtures.scenarios.find((s) => s.feature === 'response_cache');
  const r = await simulateResponseCache(sc, fixtures.prices.gemini);
  assert.equal(r.hits + r.misses, r.requests);
  assert.ok(r.hits > 0 && r.misses > 0);
  // Identical payload text in two accounts must NOT collide: with 1 request each and 100% "duplicates" across accounts, hits stay 0.
  const solo = await simulateResponseCache({ ...sc, accounts: 20, requestsPerAccount: 1, duplicateRate: 1 }, fixtures.prices.gemini);
  assert.equal(solo.hits, 0);
});

test('batch saves 50% only for batch-eligible tasks', () => {
  const sc = fixtures.scenarios.find((s) => s.feature === 'batch');
  assert.equal(simulateBatch(sc, fixtures.prices.anthropic).savedPct, 50);
  const live = simulateBatch({ ...sc, task: 'remote_resolution' }, fixtures.prices.anthropic);
  assert.equal(live.batchEligible, false);
  assert.equal(live.savedPct, 0);
});
