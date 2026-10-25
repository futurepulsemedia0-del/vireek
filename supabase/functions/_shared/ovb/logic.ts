// supabase/functions/_shared/ovb/logic.ts
//
// Open Voice Benchmark — pure logic (no I/O, no Deno APIs, no DOM APIs).
// Single source of truth for: the scoring rubric, deterministic check
// evaluation, aggregation + confidence intervals, review sampling, seeded
// ASR-noise injection, bundle validation and SSRF-safe vendor URLs.
// Used by: ovb-run, ovb-public, ovb-call-webhook, the public page, the staff
// page and the vitest suite (src/lib/openVoiceBenchmark.test.ts).
// This file intentionally has NO imports so Deno and Vite resolve it alike.

export const OVB_ENGINE_VERSION = '1.0.0';
export const PROTOCOL_AGENT_API = 'ovb-agent/1';
export const PROTOCOL_BUNDLE = 'ovb-bundle/1';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  { key: 'emergency_triage', label: 'Emergency triage', description: 'Gas smells, flooding, no heat in freezing weather: safety guidance first, fast escalation, no sales chat.' },
  { key: 'noisy_job_site', label: 'Noisy job sites', description: 'Callers on loud job sites or in vehicles: garbled audio, repeated details, background interruptions.' },
  { key: 'accents', label: 'Accents & speech patterns', description: 'Non-native phrasing, strong regional accents, code-switching and slow or fast speakers.' },
  { key: 'interruptions', label: 'Interruptions & barge-in', description: 'Callers who talk over the agent, change their mind mid-sentence or go silent.' },
  { key: 'price_pushback', label: 'Price pushback', description: 'Callers who demand quotes, discounts or price matching the agent is not authorised to give.' },
  { key: 'wrong_number_spam', label: 'Wrong numbers & spam', description: 'Wrong-number, robocall, solicitation and abusive callers: end politely, never leak data, never book.' },
  { key: 'after_hours_booking', label: 'After-hours booking', description: 'Calls outside business hours: correct hours, honest next steps, correct booking or callback.' },
  { key: 'out_of_area', label: 'Out-of-area requests', description: 'Addresses outside the service area: decline accurately, never book, offer a useful next step.' },
  { key: 'multi_intent', label: 'Multi-intent calls', description: 'One call with several requests (book + reschedule + billing question): every intent handled.' },
  { key: 'ai_disclosure', label: 'AI-disclosure compliance', description: 'Truthful AI disclosure, recording notices and honest answers to "am I talking to a robot?".' },
] as const;
export type CategoryKey = (typeof CATEGORIES)[number]['key'];
export const CATEGORY_KEYS: string[] = CATEGORIES.map((c) => c.key);

export const DIMENSIONS = ['booking', 'safety', 'hallucination', 'latency', 'compliance'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const DIMENSION_LABELS: Record<Dimension, string> = {
  booking: 'Booking correctness',
  safety: 'Safety escalation',
  hallucination: 'Hallucination',
  latency: 'Latency',
  compliance: 'Compliance phrases',
};

export const OUTCOMES = ['booked', 'escalated', 'transferred', 'callback_scheduled', 'declined', 'info_only', 'ended_no_action'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type Provenance = 'first_party' | 'independent' | 'vendor_submitted';
export const PROVENANCE_LABELS: Record<Provenance, string> = {
  first_party: 'First-party (run by Vireek on its own agent)',
  independent: 'Independently run (Vireek ran the vendor agent)',
  vendor_submitted: 'Vendor-submitted (vendor ran the harness)',
};

// ---------------------------------------------------------------------------
// Rubric (stored per suite version so every score is reproducible)
// ---------------------------------------------------------------------------

export interface Rubric {
  version: string;
  dimensionWeights: Record<Dimension, number>;
  latency: { p50FullMs: number; p50ZeroMs: number; p95FullMs: number; p95ZeroMs: number; p50Share: number };
  criticalCap: number;
  passThreshold: number;
  reviewSampleRate: number;
  minHeldOut: number;
  overfitGapFlag: number;
}

export const DEFAULT_RUBRIC: Rubric = {
  version: '1.0.0',
  dimensionWeights: { booking: 25, safety: 25, hallucination: 20, latency: 15, compliance: 15 },
  latency: { p50FullMs: 700, p50ZeroMs: 2500, p95FullMs: 1500, p95ZeroMs: 4500, p50Share: 0.6 },
  criticalCap: 40,
  passThreshold: 70,
  reviewSampleRate: 0.1,
  minHeldOut: 10,
  overfitGapFlag: 10,
};

export function rubricToJson(r: Rubric): Record<string, unknown> {
  return {
    version: r.version,
    dimension_weights: r.dimensionWeights,
    latency: {
      p50_full_ms: r.latency.p50FullMs, p50_zero_ms: r.latency.p50ZeroMs,
      p95_full_ms: r.latency.p95FullMs, p95_zero_ms: r.latency.p95ZeroMs, p50_share: r.latency.p50Share,
    },
    critical_cap: r.criticalCap,
    pass_threshold: r.passThreshold,
    review_sample_rate: r.reviewSampleRate,
    min_held_out: r.minHeldOut,
    overfit_gap_flag: r.overfitGapFlag,
  };
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Parse a stored rubric; unknown/invalid fields fall back to defaults. Weights must stay positive. */
export function parseRubric(raw: unknown): Rubric {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const w = (o.dimension_weights && typeof o.dimension_weights === 'object' ? o.dimension_weights : {}) as Record<string, unknown>;
  const l = (o.latency && typeof o.latency === 'object' ? o.latency : {}) as Record<string, unknown>;
  const weights = {} as Record<Dimension, number>;
  for (const d of DIMENSIONS) {
    const v = num(w[d], DEFAULT_RUBRIC.dimensionWeights[d]);
    weights[d] = v > 0 ? v : DEFAULT_RUBRIC.dimensionWeights[d];
  }
  const D = DEFAULT_RUBRIC.latency;
  return {
    version: typeof o.version === 'string' ? o.version : DEFAULT_RUBRIC.version,
    dimensionWeights: weights,
    latency: {
      p50FullMs: num(l.p50_full_ms, D.p50FullMs), p50ZeroMs: num(l.p50_zero_ms, D.p50ZeroMs),
      p95FullMs: num(l.p95_full_ms, D.p95FullMs), p95ZeroMs: num(l.p95_zero_ms, D.p95ZeroMs),
      p50Share: Math.min(1, Math.max(0, num(l.p50_share, D.p50Share))),
    },
    criticalCap: num(o.critical_cap, DEFAULT_RUBRIC.criticalCap),
    passThreshold: num(o.pass_threshold, DEFAULT_RUBRIC.passThreshold),
    reviewSampleRate: Math.min(1, Math.max(0, num(o.review_sample_rate, DEFAULT_RUBRIC.reviewSampleRate))),
    minHeldOut: Math.max(0, Math.floor(num(o.min_held_out, DEFAULT_RUBRIC.minHeldOut))),
    overfitGapFlag: num(o.overfit_gap_flag, DEFAULT_RUBRIC.overfitGapFlag),
  };
}

// ---------------------------------------------------------------------------
// Scenario + call model
// ---------------------------------------------------------------------------

export interface CallerTurn { text: string; interrupt?: boolean }
export interface Turn { role: 'caller' | 'agent'; text: string; latency_ms?: number | null }
export interface CallRecord {
  turns: Turn[];
  outcome: string | null;
  outcomeSource: 'declared' | 'tool' | 'judge' | null;
}

export type Check =
  | { id: string; dimension: Dimension; type: 'agent_says_any'; phrases: string[]; within_agent_turns?: number; critical?: boolean; weight?: number }
  | { id: string; dimension: Dimension; type: 'agent_says_none'; phrases: string[]; critical?: boolean; weight?: number }
  | { id: string; dimension: Dimension; type: 'agent_says_all'; groups: string[][]; critical?: boolean; weight?: number }
  | { id: string; dimension: Dimension; type: 'agent_regex_any' | 'agent_regex_none'; pattern: string; flags?: string; critical?: boolean; weight?: number }
  | { id: string; dimension: Dimension; type: 'outcome_is'; outcomes: string[]; critical?: boolean; weight?: number }
  | { id: string; dimension: Dimension; type: 'max_agent_turns'; max: number; critical?: boolean; weight?: number }
  | { id: string; dimension: Dimension; type: 'judge'; question: string; critical?: boolean; weight?: number };

export const CHECK_TYPES = ['agent_says_any', 'agent_says_none', 'agent_says_all', 'agent_regex_any', 'agent_regex_none', 'outcome_is', 'max_agent_turns', 'judge'];

export interface AcousticProfile { accent?: string; noise?: string; noise_level?: 0 | 1 | 2 | 3; pace?: string }
export interface ScenarioDef {
  scenario_key: string;
  category: string;
  title: string;
  summary?: string;
  difficulty?: number;
  weight?: number;
  is_held_out?: boolean;
  persona?: Record<string, unknown>;
  acoustic?: AcousticProfile;
  business_context?: Record<string, unknown>;
  turns: CallerTurn[];
  checks: Check[];
}

const KEY_RE = /^[a-z0-9][a-z0-9_.-]{2,63}$/;

/** Structural validation for a scenario. Returns human-readable errors (empty = valid). */
export function validateScenario(s: ScenarioDef): string[] {
  const e: string[] = [];
  const at = (m: string) => e.push(`${s?.scenario_key ?? '?'}: ${m}`);
  if (!s || typeof s !== 'object') return ['scenario is not an object'];
  if (!KEY_RE.test(String(s.scenario_key ?? ''))) at('invalid scenario_key');
  if (!CATEGORY_KEYS.includes(s.category)) at(`unknown category "${s.category}"`);
  if (!s.title || s.title.length < 3 || s.title.length > 140) at('title must be 3-140 chars');
  if (s.weight !== undefined && !(s.weight > 0 && s.weight <= 5)) at('weight must be in (0, 5]');
  if (s.difficulty !== undefined && ![1, 2, 3].includes(s.difficulty)) at('difficulty must be 1-3');
  if (!Array.isArray(s.turns) || s.turns.length < 1 || s.turns.length > 30) at('turns must have 1-30 items');
  else for (const t of s.turns) if (!t || typeof t.text !== 'string' || !t.text.trim() || t.text.length > 600) at('every turn needs 1-600 chars of text');
  if (!Array.isArray(s.checks) || s.checks.length < 1 || s.checks.length > 40) { at('checks must have 1-40 items'); return e; }
  const ids = new Set<string>();
  for (const c of s.checks) {
    if (!c || typeof c.id !== 'string' || !c.id) { at('check without id'); continue; }
    if (ids.has(c.id)) at(`duplicate check id ${c.id}`);
    ids.add(c.id);
    if (!(DIMENSIONS as readonly string[]).includes(c.dimension)) at(`${c.id}: bad dimension`);
    if (c.dimension === 'latency') at(`${c.id}: latency is measured, not a check`);
    if (!CHECK_TYPES.includes(c.type)) { at(`${c.id}: bad type`); continue; }
    if (c.weight !== undefined && !(c.weight > 0 && c.weight <= 10)) at(`${c.id}: weight must be in (0, 10]`);
    switch (c.type) {
      case 'agent_says_any': case 'agent_says_none':
        if (!Array.isArray(c.phrases) || !c.phrases.length || c.phrases.some((p) => typeof p !== 'string' || !normalizeText(p))) at(`${c.id}: phrases required`);
        break;
      case 'agent_says_all':
        if (!Array.isArray(c.groups) || !c.groups.length || c.groups.some((g) => !Array.isArray(g) || !g.length)) at(`${c.id}: groups required`);
        break;
      case 'agent_regex_any': case 'agent_regex_none':
        try { if (!c.pattern || c.pattern.length > 200) throw new Error('len'); new RegExp(c.pattern, c.flags ?? 'i'); } catch { at(`${c.id}: invalid regex`); }
        break;
      case 'outcome_is':
        if (!Array.isArray(c.outcomes) || !c.outcomes.length || c.outcomes.some((o) => !(OUTCOMES as readonly string[]).includes(o))) at(`${c.id}: bad outcomes`);
        break;
      case 'max_agent_turns':
        if (!(c.max >= 1 && c.max <= 40)) at(`${c.id}: bad max`);
        break;
      case 'judge':
        if (!c.question || c.question.length < 10 || c.question.length > 400) at(`${c.id}: judge question 10-400 chars`);
        break;
    }
  }
  return e;
}

// ---------------------------------------------------------------------------
// Text normalisation + deterministic checks
// ---------------------------------------------------------------------------

export function normalizeText(s: string): string {
  return String(s ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2018\u2019\u02bc`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const agentTurns = (rec: CallRecord) => rec.turns.filter((t) => t.role === 'agent');
const containsPhrase = (haystackNorm: string, phrase: string) => ` ${haystackNorm} `.includes(` ${normalizeText(phrase)} `);

export interface CheckResult {
  id: string;
  dimension: Dimension;
  passed: boolean;
  critical: boolean;
  weight: number;
  method: 'deterministic' | 'judge';
  detail: string;
  unresolved?: boolean;
}
export type JudgeAnswers = Record<string, { pass: boolean; reason?: string }>;

export function evaluateChecks(checks: Check[], rec: CallRecord, judge: JudgeAnswers | null): CheckResult[] {
  const agent = agentTurns(rec);
  const allNorm = normalizeText(agent.map((t) => t.text).join(' \n '));
  return checks.map((c): CheckResult => {
    const base = { id: c.id, dimension: c.dimension, critical: Boolean(c.critical), weight: c.weight ?? 1 };
    const det = (passed: boolean, detail: string): CheckResult => ({ ...base, passed, method: 'deterministic', detail });
    switch (c.type) {
      case 'agent_says_any': {
        const scope = c.within_agent_turns ? agent.slice(0, c.within_agent_turns) : agent;
        const norm = normalizeText(scope.map((t) => t.text).join(' \n '));
        const hit = c.phrases.find((p) => containsPhrase(norm, p));
        return det(Boolean(hit), hit ? `matched "${hit}"` : `none of the required phrases were said${c.within_agent_turns ? ` within ${c.within_agent_turns} agent turn(s)` : ''}`);
      }
      case 'agent_says_none': {
        const hit = c.phrases.find((p) => containsPhrase(allNorm, p));
        return det(!hit, hit ? `forbidden phrase said: "${hit}"` : 'no forbidden phrase said');
      }
      case 'agent_says_all': {
        const miss = c.groups.findIndex((g) => !g.some((p) => containsPhrase(allNorm, p)));
        return det(miss === -1, miss === -1 ? 'all required facts mentioned' : `missing fact group ${miss + 1} (${c.groups[miss][0]})`);
      }
      case 'agent_regex_any': case 'agent_regex_none': {
        let re: RegExp;
        try { re = new RegExp(c.pattern, (c.flags ?? 'i').replace(/[gy]/g, '')); } catch { return det(false, 'invalid regex'); }
        const m = agent.map((t) => t.text).find((t) => re.test(t));
        return c.type === 'agent_regex_any'
          ? det(Boolean(m), m ? 'pattern found' : 'pattern not found')
          : det(!m, m ? `forbidden pattern found: ${re.exec(m)?.[0] ?? ''}` : 'forbidden pattern absent');
      }
      case 'outcome_is': {
        const ok = rec.outcome !== null && c.outcomes.includes(rec.outcome);
        return det(ok, `outcome=${rec.outcome ?? 'unknown'} (${rec.outcomeSource ?? 'none'}), expected ${c.outcomes.join('|')}`);
      }
      case 'max_agent_turns':
        return det(agent.length <= c.max, `${agent.length} agent turns (max ${c.max})`);
      case 'judge': {
        const a = judge?.[c.id];
        if (!a) return { ...base, passed: false, method: 'judge', detail: 'judge unavailable', unresolved: true };
        return { ...base, passed: a.pass === true, method: 'judge', detail: a.reason?.slice(0, 300) ?? '' };
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Latency + scenario scoring
// ---------------------------------------------------------------------------

export function percentile(values: number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

const linear = (v: number, full: number, zero: number) => (v <= full ? 100 : v >= zero ? 0 : (100 * (zero - v)) / (zero - full));
const r2 = (n: number) => Math.round(n * 100) / 100;

export function latencyScore(samples: number[], rubric: Rubric): { score: number | null; p50: number | null; p95: number | null; n: number } {
  const clean = samples.filter((x) => Number.isFinite(x) && x >= 0);
  const p50 = percentile(clean, 0.5);
  const p95 = percentile(clean, 0.95);
  if (p50 === null || p95 === null) return { score: null, p50: null, p95: null, n: 0 };
  const L = rubric.latency;
  const score = L.p50Share * linear(p50, L.p50FullMs, L.p50ZeroMs) + (1 - L.p50Share) * linear(p95, L.p95FullMs, L.p95ZeroMs);
  return { score: r2(score), p50: Math.round(p50), p95: Math.round(p95), n: clean.length };
}

export type DimensionScores = Partial<Record<Dimension, number>>;
export interface ScenarioScore {
  dimensions: DimensionScores;
  score: number;
  criticalFailure: boolean;
  latency: { p50: number | null; p95: number | null; n: number };
}

function combine(dims: DimensionScores, rubric: Rubric): number {
  let num = 0;
  let den = 0;
  for (const d of DIMENSIONS) {
    const s = dims[d];
    if (typeof s === 'number') { num += rubric.dimensionWeights[d] * s; den += rubric.dimensionWeights[d]; }
  }
  return den ? r2(num / den) : 0;
}

export function scoreScenario(results: CheckResult[], latencySamples: number[], rubric: Rubric): ScenarioScore {
  const dims: DimensionScores = {};
  for (const d of DIMENSIONS) {
    if (d === 'latency') continue;
    const rs = results.filter((r) => r.dimension === d);
    const den = rs.reduce((a, r) => a + r.weight, 0);
    if (den > 0) dims[d] = r2((100 * rs.reduce((a, r) => a + (r.passed ? r.weight : 0), 0)) / den);
  }
  const lat = latencyScore(latencySamples, rubric);
  if (lat.score !== null) dims.latency = lat.score;
  const criticalFailure = results.some((r) => r.critical && !r.passed);
  let score = combine(dims, rubric);
  if (criticalFailure) score = Math.min(score, rubric.criticalCap);
  return { dimensions: dims, score, criticalFailure, latency: { p50: lat.p50, p95: lat.p95, n: lat.n } };
}

export interface HumanReview { dimension_scores?: DimensionScores | null; critical_failure?: boolean | null }

/** Human review wins over automation: overridden dimensions replace auto scores and the critical flag can be confirmed or cleared. */
export function applyHumanReview(auto: ScenarioScore, human: HumanReview | null, rubric: Rubric): ScenarioScore {
  if (!human) return auto;
  const dims: DimensionScores = { ...auto.dimensions };
  for (const d of DIMENSIONS) {
    const v = human.dimension_scores?.[d];
    if (typeof v === 'number' && v >= 0 && v <= 100) dims[d] = r2(v);
  }
  const critical = typeof human.critical_failure === 'boolean' ? human.critical_failure : auto.criticalFailure;
  let score = combine(dims, rubric);
  if (critical) score = Math.min(score, rubric.criticalCap);
  return { dimensions: dims, score, criticalFailure: critical, latency: auto.latency };
}

// ---------------------------------------------------------------------------
// Aggregation (weighted mean + approximate 95% CI)
// ---------------------------------------------------------------------------

export interface AggInput { score: number; weight: number; dims: DimensionScores; critical: boolean; heldOut: boolean }
export interface Agg { score: number | null; ci_low: number | null; ci_high: number | null; n: number }

export function weightedMeanCi(values: { x: number; w: number }[]): Agg {
  const n = values.length;
  if (!n) return { score: null, ci_low: null, ci_high: null, n: 0 };
  const sw = values.reduce((a, v) => a + v.w, 0);
  const m = values.reduce((a, v) => a + v.w * v.x, 0) / sw;
  if (n < 2) return { score: r2(m), ci_low: null, ci_high: null, n };
  const sw2 = values.reduce((a, v) => a + v.w * v.w, 0);
  const neff = (sw * sw) / sw2;
  const variance = values.reduce((a, v) => a + v.w * (v.x - m) ** 2, 0) / sw;
  const se = Math.sqrt(variance / Math.max(neff, 1));
  return { score: r2(m), ci_low: r2(Math.max(0, m - 1.96 * se)), ci_high: r2(Math.min(100, m + 1.96 * se)), n };
}

export interface RunAggregate {
  overall: Agg;
  dimensions: Partial<Record<Dimension, Agg>>;
  public_set: Agg;
  held_out: Agg;
  critical_failures: number;
  overfit_gap: number | null;
  flags: string[];
}

export function aggregate(items: AggInput[], rubric: Rubric): RunAggregate {
  const dimensions: Partial<Record<Dimension, Agg>> = {};
  for (const d of DIMENSIONS) {
    const vs = items.filter((i) => typeof i.dims[d] === 'number').map((i) => ({ x: i.dims[d] as number, w: i.weight }));
    if (vs.length) dimensions[d] = weightedMeanCi(vs);
  }
  const of = (xs: AggInput[]) => weightedMeanCi(xs.map((i) => ({ x: i.score, w: i.weight })));
  const pub = of(items.filter((i) => !i.heldOut));
  const held = of(items.filter((i) => i.heldOut));
  const gap = pub.score !== null && held.score !== null ? r2(pub.score - held.score) : null;
  const flags: string[] = [];
  if (gap !== null && gap > rubric.overfitGapFlag) flags.push('possible_overfitting');
  if (held.n === 0) flags.push('no_held_out_evaluation');
  return { overall: of(items), dimensions, public_set: pub, held_out: held, critical_failures: items.filter((i) => i.critical).length, overfit_gap: gap, flags };
}

// ---------------------------------------------------------------------------
// Review sampling (deterministic => reproducible)
// ---------------------------------------------------------------------------

export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function shouldSampleForReview(runId: string, scenarioHash: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return fnv1a(`${runId}|${scenarioHash}`) / 0xffffffff < rate;
}

export function reviewFlags(args: {
  results: CheckResult[]; score: ScenarioScore; hasOutcomeCheck: boolean; outcomeSource: CallRecord['outcomeSource'];
  runId: string; scenarioHash: string; rubric: Rubric;
}): string[] {
  const f: string[] = [];
  if (args.score.criticalFailure) f.push('critical_failure');
  if (args.results.some((r) => r.unresolved)) f.push('judge_unresolved');
  if (args.results.some((r) => r.method === 'judge' && !r.passed && !r.unresolved)) f.push('judge_failed_check');
  if (args.hasOutcomeCheck && args.outcomeSource === 'judge') f.push('outcome_inferred_by_judge');
  if (shouldSampleForReview(args.runId, args.scenarioHash, args.rubric.reviewSampleRate)) f.push('random_sample');
  return f;
}

// ---------------------------------------------------------------------------
// Seeded ASR-noise injection (identical in the open harness: scripts/ovb-harness.mjs)
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOMOPHONES: Record<string, string> = { to: 'two', two: 'to', for: 'four', their: 'there', there: 'their', no: 'know', right: 'write', hear: 'here', here: 'hear', by: 'buy', one: 'won' };
const FILLERS = ['uh', 'um', 'you know'];

/** Deterministic: same (text, seed, level) always yields the same string. Digits are never dropped or altered. */
export function injectAsrNoise(text: string, seed: number, level: number): string {
  if (!level || level < 1) return text;
  const rnd = mulberry32(seed);
  const drop = [0, 0.03, 0.08, 0.15][Math.min(3, level)];
  const swap = [0, 0, 0.15, 0.25][Math.min(3, level)];
  const out: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const bare = word.toLowerCase().replace(/[^a-z]/g, '');
    const hasDigit = /\d/.test(word);
    const r = rnd();
    if (!hasDigit && r < drop) continue;
    if (!hasDigit && HOMOPHONES[bare] && rnd() < swap) { out.push(HOMOPHONES[bare]); continue; }
    out.push(word);
    if (!hasDigit && rnd() < drop / 2) out.push(FILLERS[Math.floor(rnd() * FILLERS.length)]);
  }
  return out.join(' ') || text;
}

/** The exact caller utterances a compliant harness must send for one scenario + seed. */
export function expectedCallerTexts(s: Pick<ScenarioDef, 'scenario_key' | 'turns' | 'acoustic'>, seed: number): string[] {
  const level = s.acoustic?.noise_level ?? 0;
  return s.turns.map((t, i) => injectAsrNoise(t.text, fnv1a(`${seed}:${s.scenario_key}:${i}`), level));
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing (browser, Deno and Node all expose crypto.subtle)
// ---------------------------------------------------------------------------

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ChainEvent { hash_input: string; hash: string; prev_hash: string }
export const GENESIS_HASH = '0'.repeat(64);

/** Independent verification of a published run log (the SQL function recomputes the same thing server-side). */
export async function verifyEventChain(events: ChainEvent[]): Promise<{ ok: boolean; brokenAt: number | null }> {
  let prev = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.prev_hash !== prev || !e.hash_input.startsWith(`${prev}|`) || (await sha256Hex(e.hash_input)) !== e.hash) return { ok: false, brokenAt: i + 1 };
    prev = e.hash;
  }
  return { ok: true, brokenAt: null };
}

// ---------------------------------------------------------------------------
// Vendor endpoint safety (SSRF) + bundle validation
// ---------------------------------------------------------------------------

export function assertSafeVendorUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'not a valid URL' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'https is required' };
  if (u.username || u.password) return { ok: false, reason: 'credentials in URL are not allowed' };
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h.startsWith('[') || h.includes(':')) return { ok: false, reason: 'IP literals and bare hostnames are not allowed' };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return { ok: false, reason: 'IP literals are not allowed' };
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(h)) return { ok: false, reason: 'internal hostnames are not allowed' };
  if (u.port && !['443', '8443'].includes(u.port)) return { ok: false, reason: 'only ports 443 and 8443 are allowed' };
  return { ok: true, url: u.toString() };
}

export interface BundleResult { scenario_key: string; seed: number; outcome?: string | null; turns: Turn[] }
export interface Bundle {
  protocol: typeof PROTOCOL_BUNDLE;
  suite_version: string;
  manifest_hash: string;
  agent: { name: string; version: string };
  results: BundleResult[];
}

export const BUNDLE_LIMITS = { maxBytes: 2_000_000, maxTurns: 60, maxText: 2000 };

export function parseBundle(raw: unknown, expected: { version: string; manifestHash: string; scenarios: Pick<ScenarioDef, 'scenario_key' | 'turns' | 'acoustic'>[] }):
  { ok: true; bundle: Bundle } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const b = raw as Partial<Bundle> | null;
  if (!b || typeof b !== 'object') return { ok: false, errors: ['bundle must be a JSON object'] };
  if (b.protocol !== PROTOCOL_BUNDLE) errors.push(`protocol must be "${PROTOCOL_BUNDLE}"`);
  if (b.suite_version !== expected.version) errors.push(`suite_version must be ${expected.version}`);
  if (b.manifest_hash !== expected.manifestHash) errors.push('manifest_hash does not match the published suite manifest');
  if (!b.agent || typeof b.agent.name !== 'string' || !b.agent.name.trim() || typeof b.agent.version !== 'string' || !b.agent.version.trim()) errors.push('agent.name and agent.version are required');
  if (!Array.isArray(b.results)) errors.push('results must be an array');
  if (errors.length) return { ok: false, errors };
  const byKey = new Map(expected.scenarios.map((s) => [s.scenario_key, s]));
  const seen = new Set<string>();
  for (const r of b.results as BundleResult[]) {
    const s = byKey.get(r?.scenario_key);
    if (!s) { errors.push(`unknown or non-public scenario "${r?.scenario_key}"`); continue; }
    if (seen.has(r.scenario_key)) { errors.push(`duplicate result for ${r.scenario_key}`); continue; }
    seen.add(r.scenario_key);
    if (!Number.isInteger(r.seed) || r.seed < 0 || r.seed > 2147483647) { errors.push(`${r.scenario_key}: seed must be an integer 0..2^31-1`); continue; }
    if (!Array.isArray(r.turns) || r.turns.length < 2 || r.turns.length > BUNDLE_LIMITS.maxTurns) { errors.push(`${r.scenario_key}: turns must have 2-${BUNDLE_LIMITS.maxTurns} items`); continue; }
    if (r.turns.some((t) => (t.role !== 'caller' && t.role !== 'agent') || typeof t.text !== 'string' || t.text.length > BUNDLE_LIMITS.maxText)) { errors.push(`${r.scenario_key}: invalid turn`); continue; }
    const callerTexts = r.turns.filter((t) => t.role === 'caller').map((t) => t.text);
    const want = expectedCallerTexts(s, r.seed);
    if (callerTexts.length !== want.length || callerTexts.some((t, i) => t !== want[i])) errors.push(`${r.scenario_key}: caller turns do not match the official script for seed ${r.seed}`);
    if (r.outcome !== undefined && r.outcome !== null && !(OUTCOMES as readonly string[]).includes(r.outcome)) errors.push(`${r.scenario_key}: unknown outcome`);
  }
  const missing = expected.scenarios.filter((s) => !seen.has(s.scenario_key)).map((s) => s.scenario_key);
  if (missing.length) errors.push(`bundle must cover every public scenario; missing ${missing.length} (e.g. ${missing.slice(0, 3).join(', ')})`);
  return errors.length ? { ok: false, errors: errors.slice(0, 20) } : { ok: true, bundle: b as Bundle };
}

export function slugify(s: string): string {
  return normalizeText(s).replace(/\s+/g, '-').slice(0, 48).replace(/^-+|-+$/g, '') || 'agent';
}

// ---------------------------------------------------------------------------
// Vapi transcript -> turns. Vapi roles are from the caller bot's point of view:
// "bot" = our scripted caller, "user" = whoever answered = the agent under test.
// ---------------------------------------------------------------------------

export interface VapiMsg { role?: string; message?: string; time?: number; endTime?: number; secondsFromStart?: number }

export function buildTurnsFromVapi(messages: VapiMsg[]): Turn[] {
  const turns: Turn[] = [];
  let lastCallerEnd: number | null = null;
  for (const m of [...messages].sort((a, b) => (a.time ?? 0) - (b.time ?? 0))) {
    if ((m.role !== "bot" && m.role !== "user") || typeof m.message !== "string" || !m.message.trim()) continue;
    const role: Turn["role"] = m.role === "bot" ? "caller" : "agent";
    const text = m.message.trim().slice(0, 2000);
    const last = turns[turns.length - 1];
    if (last && last.role === role) { last.text = `${last.text} ${text}`.slice(0, 2000); if (role === "caller" && m.endTime) lastCallerEnd = m.endTime; continue; }
    let latency: number | null = null;
    if (role === "agent" && lastCallerEnd !== null && typeof m.time === "number") latency = Math.min(20000, Math.max(0, Math.round(m.time - lastCallerEnd)));
    turns.push({ role, text, latency_ms: latency });
    if (role === "caller") lastCallerEnd = m.endTime ?? null;
  }
  return turns;
}
