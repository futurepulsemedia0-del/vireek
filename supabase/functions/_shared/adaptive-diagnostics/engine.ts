// supabase/functions/_shared/adaptive-diagnostics/engine.ts
//
// VIREEK Adaptive Diagnostic Network - deterministic core.
//
// Naive-Bayes diagnostic reasoner with expected-information-gain test selection:
//
//   P(cause | evidence) ∝ P(cause) · Π P(answer_i | cause, test_i)
//   next test = argmax  ExpectedInformationGain(test) / effortCost(test)
//
// Probabilities are Dirichlet-smoothed pseudo-counts: expert seed counts plus
// weighted verified field outcomes (this account + anonymous network pool).
//
// Design rules (same philosophy as quote-truth/engine.ts):
//   - Pure & deterministic: no network, no Date.now(), no randomness, no LLM.
//   - Explainable: every question carries its information gain and a preview of what
//     each possible answer would do to the leading diagnosis.
//   - No imports, no Deno/DOM globals: usable from the edge function and from Vitest.

export const ENGINE_VERSION = '1.0.0';
export const SKIP_ANSWER = '__skip__';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnswerDef {
  key: string;
  label: string;
  hazard?: boolean;
}

export interface TestDef {
  key: string;
  label: string;
  question: string;
  toolNeeded: string | null;
  effort: number; // 1 (instant) .. 5 (heavy)
  kind: 'question' | 'inspection' | 'measurement';
  safetyNote: string | null;
  answers: AnswerDef[];
}

export interface CauseDef {
  key: string;
  label: string;
  prior: number; // effective pseudo-count, > 0
  safetyCritical: boolean;
}

/** counts[testKey][causeKey][answerKey] = effective pseudo-count */
export type LikelihoodCounts = Record<string, Record<string, Record<string, number>>>;

export interface Step {
  testKey: string;
  answerKey: string; // SKIP_ANSWER when the technician could not run the test
}

export interface EngineConfig {
  alpha: number; // Dirichlet smoothing per answer
  conclusionThreshold: number; // stop when top cause probability reaches this
  minAnswered: number; // never conclude "confident" before this many real answers
  maxSteps: number; // hard cap on questions (answered + skipped)
  minGainBits: number; // below this a test is not worth asking
  effortPenalty: number; // score = gain / (1 + penalty * (effort - 1))
  safetyAlertThreshold: number; // surface safety-critical causes at/above this probability
}

export const DEFAULT_CONFIG: EngineConfig = {
  alpha: 0.5,
  conclusionThreshold: 0.85,
  minAnswered: 2,
  maxSteps: 10,
  minGainBits: 0.03,
  effortPenalty: 0.18,
  safetyAlertThreshold: 0.08,
};

export interface DifferentialItem {
  causeKey: string;
  label: string;
  probability: number;
  safetyCritical: boolean;
}

export interface AnswerPreview {
  answerKey: string;
  answerLabel: string;
  probability: number; // P(this answer)
  topCauseKey: string;
  topCauseLabel: string;
  topCauseProbability: number; // leading diagnosis if this answer is given
}

export interface NextQuestion {
  test: TestDef;
  informationGainBits: number;
  reason: 'safety_check' | 'highest_information_gain';
  preview: AnswerPreview[];
}

export interface HazardFlag {
  testKey: string;
  answerKey: string;
  answerLabel: string;
}

export type StopReason = 'confident' | 'safety_hazard' | 'no_informative_test' | 'max_steps';
export type ConfidenceLabel = 'high' | 'moderate' | 'low';

export interface Analysis {
  action: 'ask' | 'conclude';
  differential: DifferentialItem[]; // sorted desc
  entropyBits: number;
  answeredCount: number;
  next: NextQuestion | null;
  stopReason: StopReason | null;
  confidence: ConfidenceLabel;
  safetyAlerts: DifferentialItem[];
  hazards: HazardFlag[];
}

export interface AnalyzeInput {
  causes: CauseDef[];
  tests: TestDef[];
  counts: LikelihoodCounts;
  steps: Step[];
  mandatoryTestKeys?: string[];
  config?: Partial<EngineConfig>;
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

export function entropyBits(p: readonly number[]): number {
  let h = 0;
  for (const x of p) if (x > 0) h -= x * Math.log2(x);
  return h;
}

function normalize(weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return weights.map(() => 1 / Math.max(weights.length, 1));
  return weights.map((w) => w / sum);
}

/** P(answer | cause, test) with Dirichlet smoothing. Missing counts => uniform. */
export function answerLikelihood(
  counts: LikelihoodCounts,
  test: TestDef,
  causeKey: string,
  answerKey: string,
  alpha: number,
): number {
  const row = counts[test.key]?.[causeKey];
  let total = 0;
  for (const a of test.answers) total += row?.[a.key] ?? 0;
  const k = test.answers.length;
  return ((row?.[answerKey] ?? 0) + alpha) / (total + alpha * k);
}

/** Posterior over causes (same order as `causes`) given the answered (non-skipped) steps. */
export function computePosterior(
  causes: CauseDef[],
  tests: TestDef[],
  counts: LikelihoodCounts,
  steps: Step[],
  alpha = DEFAULT_CONFIG.alpha,
): number[] {
  const byKey = new Map(tests.map((t) => [t.key, t] as const));
  const logp = causes.map((c) => Math.log(Math.max(c.prior, 1e-9)));
  for (const s of steps) {
    if (s.answerKey === SKIP_ANSWER) continue;
    const t = byKey.get(s.testKey);
    if (!t) continue;
    causes.forEach((c, i) => {
      logp[i] += Math.log(answerLikelihood(counts, t, c.key, s.answerKey, alpha));
    });
  }
  const max = Math.max(...logp);
  return normalize(logp.map((l) => Math.exp(l - max)));
}

interface GainDetail {
  gain: number;
  preview: AnswerPreview[];
}

/** Expected information gain (bits) of asking `test` given the current posterior. */
export function informationGain(
  causes: CauseDef[],
  test: TestDef,
  counts: LikelihoodCounts,
  posterior: number[],
  alpha = DEFAULT_CONFIG.alpha,
): GainDetail {
  const h0 = entropyBits(posterior);
  let expected = 0;
  const preview: AnswerPreview[] = [];
  for (const a of test.answers) {
    const joint = causes.map((c, i) => posterior[i] * answerLikelihood(counts, test, c.key, a.key, alpha));
    const pa = joint.reduce((x, y) => x + y, 0);
    if (!(pa > 0)) continue;
    const post = joint.map((j) => j / pa);
    expected += pa * entropyBits(post);
    let top = 0;
    for (let i = 1; i < post.length; i++) if (post[i] > post[top]) top = i;
    preview.push({
      answerKey: a.key,
      answerLabel: a.label,
      probability: pa,
      topCauseKey: causes[top].key,
      topCauseLabel: causes[top].label,
      topCauseProbability: post[top],
    });
  }
  return { gain: Math.max(0, h0 - expected), preview };
}

// ---------------------------------------------------------------------------
// Learning: merge seed + learned counts
// ---------------------------------------------------------------------------

export interface LikelihoodRow {
  test: string;
  cause: string;
  answer: string;
  n: number;
}

export interface LearnedLikelihoodLayer {
  weight: number;
  /** A (test, cause) pair is used only if its summed count reaches this (anonymity + noise guard). */
  minSupport: number;
  rows: LikelihoodRow[];
}

export function mergeLikelihoodCounts(seed: LikelihoodRow[], layers: LearnedLikelihoodLayer[]): LikelihoodCounts {
  const out: LikelihoodCounts = {};
  const add = (r: LikelihoodRow, w: number) => {
    if (!(r.n > 0) || !(w > 0)) return;
    const t = (out[r.test] ??= {});
    const c = (t[r.cause] ??= {});
    c[r.answer] = (c[r.answer] ?? 0) + r.n * w;
  };
  for (const r of seed) add(r, 1);
  for (const layer of layers) {
    const support = new Map<string, number>();
    for (const r of layer.rows) support.set(`${r.test}|${r.cause}`, (support.get(`${r.test}|${r.cause}`) ?? 0) + r.n);
    for (const r of layer.rows) {
      if ((support.get(`${r.test}|${r.cause}`) ?? 0) >= layer.minSupport) add(r, layer.weight);
    }
  }
  return out;
}

export interface PriorRow {
  cause: string;
  n: number;
}

export interface LearnedPriorLayer {
  weight: number;
  minSupport: number;
  rows: PriorRow[];
}

/**
 * Effective prior per cause. Causes absent from the symptom's seed list still get a small
 * `offSymptomPrior` so strong contradicting evidence can surface them (and so a mis-picked
 * symptom does not trap the diagnosis).
 */
export function mergePriors(
  seed: Record<string, number>,
  layers: LearnedPriorLayer[],
  familyCauseKeys: string[],
  offSymptomPrior = 0.4,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of familyCauseKeys) out[k] = seed[k] ?? offSymptomPrior;
  for (const layer of layers) {
    const total = layer.rows.reduce((a, r) => a + r.n, 0);
    if (total < layer.minSupport) continue;
    for (const r of layer.rows) {
      if (r.n > 0 && layer.weight > 0 && k_in(out, r.cause)) out[r.cause] += r.n * layer.weight;
    }
  }
  return out;
}

function k_in(o: Record<string, number>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** Layer weights: specific context counts extra; account-specific beats network pool. */
export const LAYER_WEIGHTS = {
  accountFamily: 1.5,
  accountMake: 2.0,
  networkFamily: 1.0,
  networkMake: 1.0,
  networkMinSupport: 5,
} as const;

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Answers the technician gave that are flagged as safety hazards (gas odor, CO, active leak...). */
export function findHazards(tests: TestDef[], steps: Step[]): HazardFlag[] {
  const byKey = new Map(tests.map((t) => [t.key, t] as const));
  const out: HazardFlag[] = [];
  for (const s of steps) {
    if (s.answerKey === SKIP_ANSWER) continue;
    const a = byKey.get(s.testKey)?.answers.find((x) => x.key === s.answerKey);
    if (a?.hazard) out.push({ testKey: s.testKey, answerKey: s.answerKey, answerLabel: a.label });
  }
  return out;
}

export function confidenceLabel(topProbability: number): ConfidenceLabel {
  if (topProbability >= 0.85) return 'high';
  if (topProbability >= 0.6) return 'moderate';
  return 'low';
}

export function analyze(input: AnalyzeInput): Analysis {
  const cfg: EngineConfig = { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
  const { causes, tests, counts, steps } = input;
  const testByKey = new Map(tests.map((t) => [t.key, t] as const));

  const posterior = computePosterior(causes, tests, counts, steps, cfg.alpha);
  const differential: DifferentialItem[] = causes
    .map((c, i) => ({ causeKey: c.key, label: c.label, probability: posterior[i], safetyCritical: c.safetyCritical }))
    .sort((a, b) => b.probability - a.probability || (a.causeKey < b.causeKey ? -1 : 1));
  const entropy = entropyBits(posterior);
  const answered = steps.filter((s) => s.answerKey !== SKIP_ANSWER);
  const done = new Set(steps.map((s) => s.testKey));
  const top = differential[0];

  const hazards = findHazards(tests, steps);
  const safetyAlerts = differential.filter((d) => d.safetyCritical && d.probability >= cfg.safetyAlertThreshold);

  const base = {
    differential,
    entropyBits: entropy,
    answeredCount: answered.length,
    confidence: confidenceLabel(top?.probability ?? 0),
    safetyAlerts,
    hazards,
  };

  if (hazards.length > 0) {
    return { ...base, action: 'conclude', next: null, stopReason: 'safety_hazard' };
  }

  // Mandatory (safety) checks first, in the order defined by the symptom.
  const pendingMandatory = (input.mandatoryTestKeys ?? []).find((k) => !done.has(k) && testByKey.has(k));
  if (pendingMandatory) {
    const t = testByKey.get(pendingMandatory)!;
    const g = informationGain(causes, t, counts, posterior, cfg.alpha);
    return {
      ...base,
      action: 'ask',
      next: { test: t, informationGainBits: g.gain, reason: 'safety_check', preview: g.preview },
      stopReason: null,
    };
  }

  if (steps.length >= cfg.maxSteps) {
    return { ...base, action: 'conclude', next: null, stopReason: 'max_steps' };
  }
  if (top && top.probability >= cfg.conclusionThreshold && answered.length >= cfg.minAnswered) {
    return { ...base, action: 'conclude', next: null, stopReason: 'confident' };
  }

  let best: { test: TestDef; gain: number; score: number; preview: AnswerPreview[] } | null = null;
  for (const t of tests) {
    if (done.has(t.key)) continue;
    const g = informationGain(causes, t, counts, posterior, cfg.alpha);
    if (g.gain < cfg.minGainBits) continue;
    const score = g.gain / (1 + cfg.effortPenalty * (t.effort - 1));
    if (
      !best ||
      score > best.score + 1e-12 ||
      (Math.abs(score - best.score) <= 1e-12 && (t.effort < best.test.effort || (t.effort === best.test.effort && t.key < best.test.key)))
    ) {
      best = { test: t, gain: g.gain, score, preview: g.preview };
    }
  }

  if (!best) return { ...base, action: 'conclude', next: null, stopReason: 'no_informative_test' };
  return {
    ...base,
    action: 'ask',
    next: { test: best.test, informationGainBits: best.gain, reason: 'highest_information_gain', preview: best.preview },
    stopReason: null,
  };
}

/** Gain a test would have given at a point in the session (used to log what the system expected). */
export function gainForTest(
  input: Pick<AnalyzeInput, 'causes' | 'tests' | 'counts' | 'steps'> & { config?: Partial<EngineConfig> },
  testKey: string,
): number {
  const cfg = { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
  const t = input.tests.find((x) => x.key === testKey);
  if (!t) return 0;
  const posterior = computePosterior(input.causes, input.tests, input.counts, input.steps, cfg.alpha);
  return informationGain(input.causes, t, input.counts, posterior, cfg.alpha).gain;
}
