// Fixture benchmark for the LLM cost features. Runs the PRODUCTION modules (cost arithmetic, prompt-cache
// block builder, response-cache key + eligibility) over deterministic synthetic workloads and reports
// before/after cost. It does NOT call any provider and does NOT read production logs: the numbers are
// only as good as the fixture assumptions, and the report says so.
import { computeCost, DEFAULT_MULTIPLIERS } from '../../supabase/functions/_shared/ai-core/llmCost.ts';
import { buildAnthropicSystem, minCacheableTokens } from '../../supabase/functions/_shared/ai-core/promptCache.ts';
import { buildCacheKey, cacheEligibility } from '../../supabase/functions/_shared/ai-core/responseCache.ts';
import { validateBatchRequest } from '../../supabase/functions/_shared/ai-core/batch.ts';

const CACHE_TTL_SEC = 300; // Anthropic default (5 min), refreshed on every read

// mulberry32: deterministic PRNG so the report is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const usd = (n) => Math.round(n * 1e6) / 1e6;
const pct = (before, after) => (before === 0 ? 0 : Math.round(((before - after) / before) * 10000) / 100);

export function simulatePromptCache(sc, price, measured) {
  const m = DEFAULT_MULTIPLIERS[sc.provider];
  const prefixTokens = measured.prefixTokens;
  // Build a synthetic system string of the measured size and ask the PRODUCTION builder whether it would mark it.
  const system = 'x'.repeat(prefixTokens * 4) + ' dynamic';
  const built = buildAnthropicSystem({ system, stablePrefixChars: prefixTokens * 4, enabled: true, model: sc.model });
  const marked = Array.isArray(built);

  let before = 0, after = 0, reads = 0, writes = 0, lastTouch = -Infinity;
  for (let i = 0; i < sc.calls; i++) {
    const t = i * sc.intervalSec;
    const total = prefixTokens + sc.variableInputTokens;
    before += computeCost(price, { inputTokens: total, outputTokens: sc.outputTokens }, m).costUsd;
    if (!marked) {
      after += computeCost(price, { inputTokens: total, outputTokens: sc.outputTokens }, m).costUsd;
      continue;
    }
    const warm = t - lastTouch <= CACHE_TTL_SEC;
    lastTouch = t;
    if (warm) {
      reads++;
      after += computeCost(price, { inputTokens: sc.variableInputTokens, outputTokens: sc.outputTokens, cacheReadTokens: prefixTokens }, m).costUsd;
    } else {
      writes++;
      after += computeCost(price, { inputTokens: sc.variableInputTokens, outputTokens: sc.outputTokens, cacheWriteTokens: prefixTokens }, m).costUsd;
    }
  }
  return {
    prefixTokens, minCacheableTokens: minCacheableTokens(sc.model), markerSent: marked,
    calls: sc.calls, cacheWrites: writes, cacheReads: reads,
    beforeUsd: usd(before), afterUsd: usd(after), savedPct: pct(before, after),
  };
}

export async function simulateResponseCache(sc, price) {
  const m = DEFAULT_MULTIPLIERS[sc.provider];
  const rand = rng(sc.seed);
  const store = new Map();
  const route = [{ provider: sc.provider, model: sc.model }];
  const per = computeCost(price, { inputTokens: sc.systemTokens + sc.variableInputTokens, outputTokens: sc.outputTokens }, m).costUsd;
  let before = 0, after = 0, hits = 0, misses = 0, rejected = 0;
  for (let a = 0; a < sc.accounts; a++) {
    const seen = [];
    for (let r = 0; r < sc.requestsPerAccount; r++) {
      const dup = seen.length > 0 && rand() < sc.duplicateRate;
      const payload = dup ? seen[Math.floor(rand() * seen.length)] : `acct${a}-batch${r}`;
      if (!dup) seen.push(payload);
      before += per;
      const elig = cacheEligibility({ flagOn: true, cache: { ttlSeconds: sc.ttlSeconds }, accountId: `acct-${a}`, temperature: 0, hasSecurityContext: false, streaming: false });
      if (!elig.ok) { rejected++; after += per; continue; }
      const key = await buildCacheKey({
        accountId: `acct-${a}`, task: sc.task, system: 'S', messages: [{ role: 'user', content: payload }],
        maxTokens: 800, temperature: 0, jsonMode: true, route,
      });
      if (store.has(key)) { hits++; } else { misses++; store.set(key, 1); after += per; }
    }
  }
  return { requests: sc.accounts * sc.requestsPerAccount, hits, misses, rejected, beforeUsd: usd(before), afterUsd: usd(after), savedPct: pct(before, after) };
}

export function simulateBatch(sc, price) {
  const m = DEFAULT_MULTIPLIERS[sc.provider];
  const eligible = validateBatchRequest(sc.task, { system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: sc.outputTokens }).ok;
  const t = { inputTokens: sc.systemTokens + sc.variableInputTokens, outputTokens: sc.outputTokens };
  const before = sc.jobs * computeCost(price, t, m, false).costUsd;
  const after = eligible ? sc.jobs * computeCost(price, t, m, true).costUsd : before;
  return { jobs: sc.jobs, batchEligible: eligible, beforeUsd: usd(before), afterUsd: usd(after), savedPct: pct(before, after) };
}

export async function runAll(fixtures, measured) {
  const rows = [];
  for (const sc of fixtures.scenarios) {
    const price = fixtures.prices[sc.provider];
    let r;
    if (sc.feature === 'prompt_cache') r = simulatePromptCache(sc, price, measured[sc.id]);
    else if (sc.feature === 'response_cache') r = await simulateResponseCache(sc, price);
    else if (sc.feature === 'batch') r = simulateBatch(sc, price);
    else throw new Error(`unknown feature ${sc.feature}`);
    rows.push({ id: sc.id, feature: sc.feature, provider: sc.provider, model: sc.model, ...r });
  }
  return rows;
}
