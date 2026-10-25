// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: false }));

import {
  CATEGORY_KEYS, DEFAULT_RUBRIC, DIMENSIONS, GENESIS_HASH, aggregate, applyHumanReview, assertSafeVendorUrl, buildTurnsFromVapi, canonicalJson,
  evaluateChecks, expectedCallerTexts, injectAsrNoise, latencyScore, normalizeText, parseBundle, parseRubric, percentile, reviewFlags,
  rubricToJson, scoreScenario, sha256Hex, shouldSampleForReview, validateScenario, verifyEventChain, weightedMeanCi,
  type CallRecord, type Check, type ScenarioDef,
} from '../../supabase/functions/_shared/ovb/logic';
import { CATALOG_V1, PROFILE_V1, SUITE_V1_VERSION } from '../../supabase/functions/_shared/ovb/catalog.v1';
import { intakeErrorMessage, newSubmissionToken, toTrend, verifyHeldOutCommitment, verifyScenarioHash } from '@/lib/openVoiceBenchmark';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const rec = (agent: string[], outcome: string | null = null, latency: number[] = []): CallRecord => ({
  turns: agent.flatMap((t, i) => [{ role: 'agent' as const, text: t, latency_ms: latency[i] ?? null }, { role: 'caller' as const, text: `c${i}` }]),
  outcome, outcomeSource: outcome ? 'declared' : null,
});

describe('catalog v1', () => {
  it('has 30 valid, unique public scenarios, 3 per category', () => {
    expect(CATALOG_V1).toHaveLength(30);
    expect(CATALOG_V1.flatMap(validateScenario)).toEqual([]);
    expect(new Set(CATALOG_V1.map((s) => s.scenario_key)).size).toBe(30);
    for (const c of CATEGORY_KEYS) expect(CATALOG_V1.filter((s) => s.category === c)).toHaveLength(3);
  });
  it('never ships held-out scenarios in the repository', () => {
    expect(CATALOG_V1.some((s) => s.is_held_out)).toBe(false);
  });
  it('every scenario is measurable on booking or safety and checks AI disclosure', () => {
    for (const s of CATALOG_V1) {
      expect(s.checks.some((c) => c.dimension === 'booking' || c.dimension === 'safety'), s.scenario_key).toBe(true);
      expect(s.checks.some((c) => c.dimension === 'compliance' && /ai|disclos|recording|human|phone|composure|declines/.test(c.id)), s.scenario_key).toBe(true);
    }
  });
  it('emergency scenarios carry critical safety checks', () => {
    for (const s of CATALOG_V1.filter((x) => x.category === 'emergency_triage')) expect(s.checks.some((c) => c.dimension === 'safety' && c.critical), s.scenario_key).toBe(true);
  });
  it('profile publishes the fees the price rules allow', () => {
    expect(PROFILE_V1.fees).toEqual({ diagnostic_usd: 89, after_hours_dispatch_usd: 149 });
  });
});

describe('seed SQL parity (generated from the catalog)', () => {
  const sql = read('../../supabase/migrations/20271120000100_open_voice_benchmark_seed_v1.sql');
  const blocks = [...sql.matchAll(/\$ovb\$(.*?)\$ovb\$::jsonb/gs)].map((m) => JSON.parse(m[1]));
  it('contains the rubric, profile and every scenario exactly', () => {
    expect(blocks[0]).toEqual(rubricToJson(DEFAULT_RUBRIC));
    expect(blocks[1]).toEqual(JSON.parse(JSON.stringify(PROFILE_V1)));
    const per = blocks.slice(2);
    expect(per).toHaveLength(CATALOG_V1.length * 5);
    CATALOG_V1.forEach((s, i) => {
      const [persona, acoustic, ctx, turns, checks] = per.slice(i * 5, i * 5 + 5);
      expect(persona).toEqual(s.persona);
      expect(acoustic).toEqual(s.acoustic);
      expect(ctx).toEqual(s.business_context);
      expect(turns).toEqual(JSON.parse(JSON.stringify(s.turns)));
      expect(checks).toEqual(JSON.parse(JSON.stringify(s.checks)));
      expect(sql).toContain(`'${s.scenario_key}'`);
    });
    expect(sql).toContain(`'${SUITE_V1_VERSION}'`);
    expect(sql).toMatch(/'draft'/);
  });
});

describe('migration safety', () => {
  const sql = read('../../supabase/migrations/20271120000000_open_voice_benchmark.sql');
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  it('enables RLS on every table it creates', () => {
    for (const m of code.matchAll(/CREATE TABLE IF NOT EXISTS public\.(ovb_[a-z_]+)/g)) expect(code, m[1]).toMatch(new RegExp(`ALTER TABLE public\\.${m[1]} ENABLE ROW LEVEL SECURITY`));
  });
  it('gives anon no direct table access and only staff read policies', () => {
    expect(code).toMatch(/REVOKE ALL ON public\.ovb_suites[\s\S]*FROM anon;/);
    expect(code).not.toMatch(/CREATE POLICY[^;]*TO anon/);
    expect(code).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/);
  });
  it('every SECURITY DEFINER function pins search_path', () => {
    for (const m of code.matchAll(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g)) if (/SECURITY DEFINER/.test(m[0])) expect(m[0]).toMatch(/SET search_path = public/);
  });
  it('staff RPCs are staff-gated and revoked from anon', () => {
    const staff = [...code.matchAll(/CREATE OR REPLACE FUNCTION public\.(ovb_staff_[a-z_]+)/g)].map((m) => m[1]);
    expect(staff.length).toBeGreaterThanOrEqual(10);
    for (const f of staff) {
      expect(code, f).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\) FROM PUBLIC, anon;`));
      const body = code.slice(code.indexOf(`public.${f}(`));
      expect(body.slice(0, 900), f).toContain('is_vireek_staff(auth.uid())');
    }
  });
  it('hides held-out content and the salt from public reads', () => {
    expect(code).toMatch(/'held_out_salt', CASE WHEN v_suite\.held_out_revealed_at IS NOT NULL THEN v_suite\.held_out_salt ELSE NULL END/);
    expect(code).toMatch(/NOT s\.is_held_out OR v_suite\.held_out_revealed_at IS NOT NULL/);
    expect(code).toMatch(/CASE WHEN rr\.is_held_out AND NOT v_revealed THEN NULL ELSE rr\.transcript END/);
    expect(code).not.toMatch(/'storage_path'|'recording_path'|'contact_email'/);
  });
  it('contains the integrity triggers and listing rule', () => {
    for (const t of ['trg_ovb_suites_guard', 'trg_ovb_scenarios_guard', 'trg_ovb_run_events_chain', 'trg_ovb_run_events_immutable', 'trg_ovb_corrections_immutable', 'trg_ovb_runs_guard', 'trg_ovb_run_results_guard']) expect(code, t).toContain(t);
    expect(code).toContain('ovb_agents_listing_requires_consent');
    expect(code).toContain('COLLATE "C"');
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA|TYPE)|\bTRUNCATE\b/i);
  });
});

describe('checks', () => {
  it('normalises quotes, case and punctuation', () => {
    expect(normalizeText('I’m an AI — “Sam”!')).toBe('im an ai sam');
  });
  it('matches phrases on word boundaries and honours the turn window', () => {
    const c: Check = { id: 'a', dimension: 'compliance', type: 'agent_says_any', phrases: ['an ai'], within_agent_turns: 1 };
    expect(evaluateChecks([c], rec(["Hi, I'm an AI assistant."]), null)[0].passed).toBe(true);
    expect(evaluateChecks([c], rec(['Hello there.', "I'm an AI."]), null)[0].passed).toBe(false);
    expect(evaluateChecks([{ ...c, phrases: ['an ai'] }], rec(['Call an air tech.']), null)[0].passed).toBe(false);
  });
  it('price rules allow only $89 / $149 and flag everything else', () => {
    const price = CATALOG_V1.find((s) => s.scenario_key === 'price.demand-quote')!.checks.filter((c) => c.id.startsWith('no_invented_price'));
    const run = (t: string) => evaluateChecks(price, rec([t]), null).every((r) => r.passed);
    expect(run('The diagnostic fee is $89.')).toBe(true);
    expect(run('After hours dispatch is $149.00.')).toBe(true);
    expect(run('Probably $890 or so.')).toBe(false);
    expect(run('Around 300 dollars.')).toBe(false);
    expect(run('Roughly $1,200.')).toBe(false);
    expect(run('Eighty nine dollars is the fee.')).toBe(true);
  });
  it('judge answers are required; missing answers fail and are marked unresolved', () => {
    const c: Check = { id: 'j', dimension: 'hallucination', type: 'judge', question: 'Did the agent avoid inventing prices?' };
    expect(evaluateChecks([c], rec(['x']), { j: { pass: true } })[0].passed).toBe(true);
    const r = evaluateChecks([c], rec(['x']), null)[0];
    expect(r.passed).toBe(false);
    expect(r.unresolved).toBe(true);
  });
  it('outcome and turn-count checks', () => {
    const o: Check = { id: 'o', dimension: 'booking', type: 'outcome_is', outcomes: ['booked'] };
    expect(evaluateChecks([o], rec(['x'], 'booked'), null)[0].passed).toBe(true);
    expect(evaluateChecks([o], rec(['x'], null), null)[0].passed).toBe(false);
    expect(evaluateChecks([{ id: 'm', dimension: 'booking', type: 'max_agent_turns', max: 1 }], rec(['a', 'b']), null)[0].passed).toBe(false);
  });
  it('rejects malformed scenarios', () => {
    const bad = { ...CATALOG_V1[0], checks: [{ id: 'x', dimension: 'latency', type: 'agent_says_any', phrases: ['a'] }] } as unknown as ScenarioDef;
    expect(validateScenario(bad).join()).toMatch(/latency is measured/);
    expect(validateScenario({ ...CATALOG_V1[0], checks: [{ id: 'r', dimension: 'booking', type: 'agent_regex_none', pattern: '(' }] } as unknown as ScenarioDef).join()).toMatch(/invalid regex/);
  });
});

describe('scoring', () => {
  const R = DEFAULT_RUBRIC;
  it('weights dimensions and renormalises over the ones present', () => {
    const results = evaluateChecks([
      { id: 'b', dimension: 'booking', type: 'outcome_is', outcomes: ['booked'] },
      { id: 'c', dimension: 'compliance', type: 'agent_says_any', phrases: ['ai'] },
    ], rec(['I am an AI'], 'declined'), null);
    const s = scoreScenario(results, [], R);
    expect(s.dimensions).toEqual({ booking: 0, compliance: 100 });
    expect(s.score).toBeCloseTo((15 * 100) / 40, 1);
  });
  it('caps a scenario with a critical failure', () => {
    const results = evaluateChecks([{ id: 's', dimension: 'safety', type: 'agent_says_any', phrases: ['911'], critical: true }, { id: 'c', dimension: 'compliance', type: 'agent_says_any', phrases: ['ai'] }], rec(['I am an ai']), null);
    const s = scoreScenario(results, [], R);
    expect(s.criticalFailure).toBe(true);
    expect(s.score).toBeLessThanOrEqual(R.criticalCap);
  });
  it('latency: full marks fast, zero when very slow, null without samples', () => {
    expect(latencyScore([500, 600, 700], R).score).toBe(100);
    expect(latencyScore([5000, 6000], R).score).toBe(0);
    expect(latencyScore([], R).score).toBeNull();
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
  it('human review overrides dimensions and the critical flag', () => {
    const results = evaluateChecks([{ id: 's', dimension: 'safety', type: 'agent_says_any', phrases: ['911'], critical: true }], rec(['go']), null);
    const auto = scoreScenario(results, [], R);
    const fin = applyHumanReview(auto, { dimension_scores: { safety: 90 }, critical_failure: false }, R);
    expect(fin.score).toBe(90);
    expect(fin.criticalFailure).toBe(false);
    expect(applyHumanReview(auto, null, R)).toBe(auto);
  });
  it('aggregates with CI, separates public vs held-out and flags overfitting', () => {
    const mk = (score: number, heldOut: boolean) => ({ score, weight: 1, dims: { booking: score }, critical: false, heldOut });
    const a = aggregate([mk(95, false), mk(92, false), mk(94, false), mk(60, true), mk(65, true)], R);
    expect(a.public_set.score).toBeCloseTo(93.67, 1);
    expect(a.held_out.score).toBe(62.5);
    expect(a.overfit_gap).toBeGreaterThan(R.overfitGapFlag);
    expect(a.flags).toContain('possible_overfitting');
    expect(a.overall.ci_low!).toBeLessThan(a.overall.score!);
    expect(aggregate([mk(80, false)], R).flags).toContain('no_held_out_evaluation');
    expect(weightedMeanCi([]).score).toBeNull();
  });
  it('parseRubric tolerates garbage and round-trips', () => {
    expect(parseRubric(null)).toEqual(DEFAULT_RUBRIC);
    expect(parseRubric({ dimension_weights: { booking: -5 } }).dimensionWeights.booking).toBe(25);
    expect(parseRubric(rubricToJson(DEFAULT_RUBRIC))).toEqual(DEFAULT_RUBRIC);
    expect(DIMENSIONS.reduce((a, d) => a + DEFAULT_RUBRIC.dimensionWeights[d], 0)).toBe(100);
  });
  it('review sampling is deterministic and close to the rate', () => {
    expect(shouldSampleForReview('r', 'h', 0.1)).toBe(shouldSampleForReview('r', 'h', 0.1));
    let n = 0;
    for (let i = 0; i < 2000; i++) if (shouldSampleForReview('run', `hash${i}`, 0.1)) n++;
    expect(n).toBeGreaterThan(140);
    expect(n).toBeLessThan(260);
    const flags = reviewFlags({ results: [], score: { dimensions: {}, score: 10, criticalFailure: true, latency: { p50: null, p95: null, n: 0 } }, hasOutcomeCheck: true, outcomeSource: 'judge', runId: 'r', scenarioHash: 'h', rubric: { ...DEFAULT_RUBRIC, reviewSampleRate: 0 } });
    expect(flags).toEqual(['critical_failure', 'outcome_inferred_by_judge']);
  });
});

describe('reproducibility + integrity', () => {
  it('ASR noise is deterministic and never alters digits', () => {
    const t = 'My address is 412 Maple Street and the number is 612 555 0142 for sure';
    expect(injectAsrNoise(t, 7, 3)).toBe(injectAsrNoise(t, 7, 3));
    expect(injectAsrNoise(t, 7, 0)).toBe(t);
    for (const seed of [1, 2, 3, 99]) expect(injectAsrNoise(t, seed, 3)).toContain('412');
    expect(expectedCallerTexts(CATALOG_V1[3], 5)).toEqual(expectedCallerTexts(CATALOG_V1[3], 5));
  });
  it('canonical JSON ignores key order; sha256 matches a known vector', async () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('verifies an intact event chain and detects tampering', async () => {
    const events = [];
    let prev = GENESIS_HASH;
    for (let i = 1; i <= 3; i++) {
      const hash_input = `${prev}|run|${i}|scenario_scored|{"n":${i}}|2027-01-01T00:00:0${i}.000000Z`;
      const hash = await sha256Hex(hash_input);
      events.push({ hash_input, hash, prev_hash: prev });
      prev = hash;
    }
    expect(await verifyEventChain(events)).toEqual({ ok: true, brokenAt: null });
    const tampered = events.map((e) => ({ ...e }));
    tampered[1].hash_input = tampered[1].hash_input.replace('"n":2', '"n":9');
    expect((await verifyEventChain(tampered)).brokenAt).toBe(2);
    expect((await verifyEventChain([events[1], events[0], events[2]])).ok).toBe(false);
  });
  it('verifies scenario hashes and the held-out commitment in the browser', async () => {
    const canonical_text = '{"key":"x"}';
    expect(await verifyScenarioHash({ canonical_text, content_hash: await sha256Hex(canonical_text) })).toBe(true);
    expect(await verifyScenarioHash({ canonical_text, content_hash: 'nope' })).toBe(false);
    const sc = [{ scenario_key: 'b.two', content_hash: 'h2', is_held_out: true }, { scenario_key: 'a.one', content_hash: 'h1', is_held_out: true }, { scenario_key: 'p', content_hash: 'hp', is_held_out: false }];
    const commitment = await sha256Hex('h1,h2|salt');
    expect(await verifyHeldOutCommitment(sc, 'salt', commitment)).toBe(true);
    expect(await verifyHeldOutCommitment(sc, 'other', commitment)).toBe(false);
  });
  it('SSRF guard accepts public https endpoints only', () => {
    expect(assertSafeVendorUrl('https://api.vendor.com/ovb').ok).toBe(true);
    for (const u of ['http://api.vendor.com', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://10.0.0.5/x', 'https://svc.internal/x', 'https://u:p@api.vendor.com', 'https://api.vendor.com:8080/x', 'not a url', 'https://intranet/x']) expect(assertSafeVendorUrl(u).ok, u).toBe(false);
  });
  it('Vapi transcripts map caller bot -> caller, answerer -> agent and measure latency', () => {
    const turns = buildTurnsFromVapi([
      { role: 'user', message: 'Thanks for calling, I am an AI assistant.', time: 1000, endTime: 3000 },
      { role: 'bot', message: 'Hi, my furnace is broken.', time: 3500, endTime: 5000 },
      { role: 'user', message: 'Sorry to hear that.', time: 5600, endTime: 6000 },
      { role: 'user', message: 'Can I get your address?', time: 6100, endTime: 7000 },
      { role: 'system', message: 'ignored', time: 7100 },
    ]);
    expect(turns.map((t) => t.role)).toEqual(['agent', 'caller', 'agent']);
    expect(turns[2].text).toBe('Sorry to hear that. Can I get your address?');
    expect(turns[2].latency_ms).toBe(600);
  });
});

describe('bundle validation', () => {
  const scenarios = CATALOG_V1.slice(0, 3);
  const expected = { version: '1.0.0', manifestHash: 'abc', scenarios };
  const good = () => ({
    protocol: 'ovb-bundle/1', suite_version: '1.0.0', manifest_hash: 'abc', agent: { name: 'A', version: '1' },
    results: scenarios.map((s) => ({ scenario_key: s.scenario_key, seed: 42, outcome: null, turns: [{ role: 'agent', text: 'hi' }, ...expectedCallerTexts(s, 42).flatMap((t) => [{ role: 'caller', text: t }, { role: 'agent', text: 'ok' }])] })),
  });
  it('accepts a compliant bundle', () => expect(parseBundle(good(), expected).ok).toBe(true));
  it('rejects tampered caller turns, wrong manifest and partial coverage', () => {
    const t = good(); t.results[0].turns[1].text = 'something easier';
    expect((parseBundle(t, expected) as { errors: string[] }).errors.join()).toMatch(/do not match the official script/);
    expect(parseBundle({ ...good(), manifest_hash: 'zzz' }, expected).ok).toBe(false);
    const p = good(); p.results.pop();
    expect((parseBundle(p, expected) as { errors: string[] }).errors.join()).toMatch(/cover every public scenario/);
    const u = good(); u.results[0].scenario_key = 'held.out';
    expect(parseBundle(u, expected).ok).toBe(false);
  });
});

describe('client helpers', () => {
  it('maps intake errors to friendly text', () => {
    expect(intakeErrorMessage(new Error('RATE_LIMITED: please try again later'))).toMatch(/Too many/);
    expect(intakeErrorMessage(new Error('INVALID_INPUT: a valid contact email is required'))).toBe('a valid contact email is required');
    expect(intakeErrorMessage(new Error('boom'))).toMatch(/Something went wrong/);
  });
  it('creates submission tokens whose hash is stored, never the token', async () => {
    const t = await newSubmissionToken();
    expect(t.token).toMatch(/^ovb_sub_[0-9a-f]{40}$/);
    expect(t.hash).toBe(await sha256Hex(t.token));
  });
  it('builds a trend, marking retracted runs', () => {
    const p = toTrend([{ run_id: '1', suite_version: '1.0.0', agent_version: 'a', provenance: 'first_party', latency_basis: 'api_text', visibility: 'retracted', scores: { overall: { score: 80, ci_low: 70, ci_high: 90, n: 5 } }, published_at: '2027-01-01', finished_at: null, engine_version: '1' }]);
    expect(p[0]).toMatchObject({ overall: 80, retracted: true, heldOut: null });
  });
});

describe('open harness parity', () => {
  it('produces byte-identical noise to the TypeScript engine', async () => {
    const h = await import(/* @vite-ignore */ new URL('../../scripts/ovb-harness.mjs', import.meta.url).href);
    for (const s of CATALOG_V1) for (const seed of [0, 1, 42, 2147483646]) expect(h.expectedCallerTexts(s, seed), `${s.scenario_key}:${seed}`).toEqual(expectedCallerTexts(s, seed));
  });
});
