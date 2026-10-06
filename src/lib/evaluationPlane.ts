import { supabase } from '@/lib/supabase';

/**
 * Intelligence Evaluation Plane — client library.
 *
 * Backed by supabase/migrations/20270315000000_intelligence_evaluation_plane.sql.
 * The database returns calibration BINS only; every metric (Brier, skill, ECE,
 * bias, drift, version comparison) is derived here from those sums, so the logic
 * is pure, unit-tested and identical for every model and segment.
 *
 *   prediction -> actual outcome -> error -> calibration -> segment performance
 *   -> drift -> cost / latency / safety -> version comparison -> promote / rollback
 */

export type EvalModelKey = 'first_time_fix' | 'quote_truth' | 'outcome_assurance';
export type EvalStatus = 'good' | 'degrading' | 'poor' | 'insufficient';
export type EvalDim = 'overall' | 'trade' | 'customer_type' | 'state' | 'job_type';
export type EvalDecisionKind = 'promote' | 'rollback' | 'hold' | 'acknowledge';

export const EVAL_MODELS: Record<EvalModelKey, { label: string; event: string }> = {
  first_time_fix: { label: 'First-Time-Fix model', event: 'job fixed on the first visit with no callback' },
  outcome_assurance: { label: 'Outcome Assurance', event: 'job fixed on the first visit with no callback' },
  quote_truth: { label: 'Quote Truth (rejection risk)', event: 'customer declined the quote' },
};

export const DIM_LABELS: Record<EvalDim, string> = {
  overall: 'Overall',
  trade: 'Trade',
  customer_type: 'Customer type',
  state: 'State',
  job_type: 'Job type',
};

export interface EvalPolicy {
  min_sample: number;
  ece_warn: number;
  ece_fail: number;
  skill_warn: number;
  skill_fail: number;
  drift_warn: number;
  drift_fail: number;
}

export const DEFAULT_EVAL_POLICY: EvalPolicy = {
  min_sample: 30,
  ece_warn: 0.08,
  ece_fail: 0.15,
  skill_warn: 0.05,
  skill_fail: 0,
  drift_warn: 0.03,
  drift_fail: 0.08,
};

/** Minimum Brier improvement before one version is called better than another. */
export const VERSION_MARGIN = 0.01;
const BIN_COUNT = 10;

export interface BinRow {
  dim: EvalDim;
  seg: string;
  version: string;
  bin: number;
  n: number;
  sum_p: number;
  sum_y: number;
  sum_sq: number;
}

export interface CalibrationBin {
  bin: number;
  label: string;
  n: number;
  predicted: number;
  actual: number;
}

export interface EvalMetrics {
  n: number;
  meanPred: number | null;
  actualRate: number | null;
  /** meanPred - actualRate: positive = over-confident, negative = under-confident. */
  bias: number | null;
  brier: number | null;
  /** Brier of always predicting the base rate. */
  brierRef: number | null;
  /** 1 - brier / brierRef. <= 0 means no better than the base rate. */
  skill: number | null;
  ece: number | null;
  bins: CalibrationBin[];
}

export interface EvalAssessment {
  status: EvalStatus;
  reasons: string[];
  /** current Brier - baseline Brier (positive = worse). */
  drift: number | null;
}

export interface SegmentEval {
  dim: EvalDim;
  seg: string;
  current: EvalMetrics;
  baseline: EvalMetrics;
  assessment: EvalAssessment;
}

export interface VersionEval {
  version: string;
  current: EvalMetrics;
  assessment: EvalAssessment;
}

export type VersionVerdict = 'single_version' | 'insufficient' | 'latest_better' | 'latest_worse' | 'no_difference';

export interface VersionComparison {
  verdict: VersionVerdict;
  latest: string | null;
  previous: string | null;
  reasons: string[];
}

export interface Evaluation {
  overall: SegmentEval;
  segments: SegmentEval[];
  versions: VersionEval[];
  comparison: VersionComparison;
  policy: EvalPolicy;
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

// ------------------------------------------------------------------
// Metrics (pure)
// ------------------------------------------------------------------

export function computeMetrics(rows: BinRow[]): EvalMetrics {
  const byBin = new Map<number, { n: number; p: number; y: number }>();
  let n = 0;
  let sp = 0;
  let sy = 0;
  let sq = 0;
  for (const r of rows) {
    n += r.n;
    sp += r.sum_p;
    sy += r.sum_y;
    sq += r.sum_sq;
    const cur = byBin.get(r.bin) ?? { n: 0, p: 0, y: 0 };
    cur.n += r.n;
    cur.p += r.sum_p;
    cur.y += r.sum_y;
    byBin.set(r.bin, cur);
  }
  if (n === 0) {
    return { n: 0, meanPred: null, actualRate: null, bias: null, brier: null, brierRef: null, skill: null, ece: null, bins: [] };
  }
  const meanPred = sp / n;
  const actualRate = sy / n;
  const brier = sq / n;
  const brierRef = actualRate * (1 - actualRate);
  const skill = brierRef > 1e-9 ? 1 - brier / brierRef : null;

  const bins: CalibrationBin[] = [];
  let ece = 0;
  for (let b = 0; b < BIN_COUNT; b++) {
    const x = byBin.get(b);
    if (!x || x.n === 0) continue;
    const predicted = x.p / x.n;
    const actual = x.y / x.n;
    ece += (x.n / n) * Math.abs(predicted - actual);
    bins.push({ bin: b, label: `${b * 10}-${b * 10 + 10}%`, n: x.n, predicted: r4(predicted), actual: r4(actual) });
  }
  return {
    n,
    meanPred: r4(meanPred),
    actualRate: r4(actualRate),
    bias: r4(meanPred - actualRate),
    brier: r4(brier),
    brierRef: r4(brierRef),
    skill: skill === null ? null : r4(skill),
    ece: r4(ece),
    bins,
  };
}

export function assess(current: EvalMetrics, baseline: EvalMetrics | null, policy: EvalPolicy): EvalAssessment {
  if (current.n < policy.min_sample || current.brier === null) {
    return { status: 'insufficient', reasons: [`${current.n} of ${policy.min_sample} labeled outcomes needed`], drift: null };
  }
  const drift =
    baseline && baseline.n >= policy.min_sample && baseline.brier !== null ? r4(current.brier - baseline.brier) : null;

  const reasons: string[] = [];
  let poor = false;
  let degrading = false;

  if (current.skill !== null) {
    if (current.skill < policy.skill_fail) {
      poor = true;
      reasons.push(`No better than the base rate (skill ${pct(current.skill)})`);
    } else if (current.skill < policy.skill_warn) {
      degrading = true;
      reasons.push(`Low skill over base rate (${pct(current.skill)})`);
    }
  }
  if (current.ece !== null) {
    if (current.ece > policy.ece_fail) {
      poor = true;
      reasons.push(`Poorly calibrated (ECE ${pct(current.ece)})`);
    } else if (current.ece > policy.ece_warn) {
      degrading = true;
      reasons.push(`Calibration slipping (ECE ${pct(current.ece)})`);
    }
  }
  if (drift !== null) {
    if (drift >= policy.drift_fail) {
      poor = true;
      reasons.push(`Error up ${drift.toFixed(3)} vs the previous window`);
    } else if (drift >= policy.drift_warn) {
      degrading = true;
      reasons.push(`Error up ${drift.toFixed(3)} vs the previous window`);
    }
  }
  return { status: poor ? 'poor' : degrading ? 'degrading' : 'good', reasons, drift };
}

// ------------------------------------------------------------------
// Evaluation assembly (pure)
// ------------------------------------------------------------------

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = out.get(k);
    if (arr) arr.push(r);
    else out.set(k, [r]);
  }
  return out;
}

export function compareVersions(versions: VersionEval[], policy: EvalPolicy): VersionComparison {
  const sorted = [...versions].sort((a, b) => naturalCompare(a.version, b.version));
  if (sorted.length < 2) {
    return { verdict: 'single_version', latest: sorted[0]?.version ?? null, previous: null, reasons: ['Only one version has outcomes in this window'] };
  }
  const latest = sorted[sorted.length - 1];
  const previous = sorted[sorted.length - 2];
  const base = { latest: latest.version, previous: previous.version };
  const l = latest.current;
  const p = previous.current;

  if (l.n < policy.min_sample || p.n < policy.min_sample || l.brier === null || p.brier === null) {
    return { ...base, verdict: 'insufficient', reasons: [`Both versions need ${policy.min_sample}+ labeled outcomes (${latest.version}: ${l.n}, ${previous.version}: ${p.n})`] };
  }
  const delta = r4(l.brier - p.brier);
  const eceDelta = (l.ece ?? 0) - (p.ece ?? 0);
  const reasons = [`Brier ${previous.version} ${p.brier.toFixed(3)} → ${latest.version} ${l.brier.toFixed(3)}`, `ECE ${pct(p.ece ?? 0)} → ${pct(l.ece ?? 0)}`];

  if (latest.assessment.status === 'poor' || delta >= VERSION_MARGIN) {
    return { ...base, verdict: 'latest_worse', reasons };
  }
  if (delta <= -VERSION_MARGIN && eceDelta <= 0.01) {
    return { ...base, verdict: 'latest_better', reasons };
  }
  return { ...base, verdict: 'no_difference', reasons };
}

export function buildEvaluation(current: BinRow[], baseline: BinRow[], policy: EvalPolicy = DEFAULT_EVAL_POLICY): Evaluation {
  const segKey = (r: BinRow) => `${r.dim}\u0000${r.seg}`;
  const curGroups = groupBy(current, segKey);
  const baseGroups = groupBy(baseline, segKey);

  const segments: SegmentEval[] = [];
  let overall: SegmentEval | null = null;

  for (const [key, rows] of curGroups) {
    const [dim, seg] = key.split('\u0000') as [EvalDim, string];
    const cur = computeMetrics(rows);
    const base = computeMetrics(baseGroups.get(key) ?? []);
    const item: SegmentEval = { dim, seg, current: cur, baseline: base, assessment: assess(cur, base, policy) };
    if (dim === 'overall') overall = item;
    else segments.push(item);
  }

  if (!overall) {
    const empty = computeMetrics([]);
    overall = { dim: 'overall', seg: 'all', current: empty, baseline: computeMetrics([]), assessment: assess(empty, null, policy) };
  }

  // A dimension whose only value is 'unknown' carries no information — hide it.
  const informative = new Set<EvalDim>();
  for (const s of segments) if (s.seg !== 'unknown') informative.add(s.dim);
  const visible = segments.filter((s) => informative.has(s.dim));

  const rank: Record<EvalStatus, number> = { poor: 0, degrading: 1, good: 2, insufficient: 3 };
  visible.sort((a, b) => rank[a.assessment.status] - rank[b.assessment.status] || b.current.n - a.current.n);

  const overallRows = current.filter((r) => r.dim === 'overall');
  const versions: VersionEval[] = [...groupBy(overallRows, (r) => r.version)].map(([version, rows]) => {
    const cur = computeMetrics(rows);
    const baseRows = baseline.filter((r) => r.dim === 'overall' && r.version === version);
    return { version, current: cur, assessment: assess(cur, computeMetrics(baseRows), policy) };
  });
  versions.sort((a, b) => naturalCompare(a.version, b.version));

  return { overall, segments: visible, versions, comparison: compareVersions(versions, policy), policy };
}

// ------------------------------------------------------------------
// Data layer
// ------------------------------------------------------------------

export interface AiOpsTask {
  task: string;
  calls: number;
  ok_rate: number;
  fallback_rate: number;
  total_cost_usd: number;
  avg_cost_usd: number;
  p50_ms: number;
  p95_ms: number;
}

export interface AiOpsSummary {
  tasks: AiOpsTask[];
  eval: { runs: number; cases: number; passes: number; fails: number; hallucinations: number };
}

export interface EvalDecision {
  id: string;
  model_key: EvalModelKey;
  version: string;
  decision: EvalDecisionKind;
  reason: string;
  metrics: Record<string, unknown>;
  actor_id: string;
  created_at: string;
}

const DAY_MS = 86_400_000;

async function fetchBins(model: EvalModelKey, from: Date, to: Date): Promise<BinRow[]> {
  const { data, error } = await supabase.rpc('eval_plane_bins', {
    p_model: model,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    dim: r.dim as EvalDim,
    seg: String(r.seg),
    version: String(r.version),
    bin: Number(r.bin),
    n: Number(r.n),
    sum_p: Number(r.sum_p),
    sum_y: Number(r.sum_y),
    sum_sq: Number(r.sum_sq),
  }));
}

export async function fetchEvalPolicy(model: EvalModelKey): Promise<EvalPolicy> {
  const { data, error } = await supabase
    .from('eval_plane_policies')
    .select('min_sample, ece_warn, ece_fail, skill_warn, skill_fail, drift_warn, drift_fail')
    .eq('model_key', model)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return DEFAULT_EVAL_POLICY;
  const d = data as Record<string, unknown>;
  return {
    min_sample: Number(d.min_sample),
    ece_warn: Number(d.ece_warn),
    ece_fail: Number(d.ece_fail),
    skill_warn: Number(d.skill_warn),
    skill_fail: Number(d.skill_fail),
    drift_warn: Number(d.drift_warn),
    drift_fail: Number(d.drift_fail),
  };
}

/** Current window = last `days`; baseline = the equal window before it (drift reference). */
export async function fetchEvaluation(model: EvalModelKey, days: number): Promise<Evaluation> {
  const now = new Date();
  const mid = new Date(now.getTime() - days * DAY_MS);
  const start = new Date(now.getTime() - 2 * days * DAY_MS);
  const [policy, current, baseline] = await Promise.all([
    fetchEvalPolicy(model),
    fetchBins(model, mid, new Date(now.getTime() + 60_000)),
    fetchBins(model, start, mid),
  ]);
  return buildEvaluation(current, baseline, policy);
}

export async function fetchAiOps(days: number): Promise<AiOpsSummary> {
  const now = new Date();
  const { data, error } = await supabase.rpc('eval_plane_ai_ops', {
    p_from: new Date(now.getTime() - days * DAY_MS).toISOString(),
    p_to: new Date(now.getTime() + 60_000).toISOString(),
  });
  if (error) throw new Error(error.message);
  const d = (data ?? {}) as Partial<AiOpsSummary>;
  return {
    tasks: (d.tasks ?? []).map((t) => ({
      task: String(t.task),
      calls: Number(t.calls),
      ok_rate: Number(t.ok_rate),
      fallback_rate: Number(t.fallback_rate),
      total_cost_usd: Number(t.total_cost_usd),
      avg_cost_usd: Number(t.avg_cost_usd),
      p50_ms: Number(t.p50_ms),
      p95_ms: Number(t.p95_ms),
    })),
    eval: {
      runs: Number(d.eval?.runs ?? 0),
      cases: Number(d.eval?.cases ?? 0),
      passes: Number(d.eval?.passes ?? 0),
      fails: Number(d.eval?.fails ?? 0),
      hallucinations: Number(d.eval?.hallucinations ?? 0),
    },
  };
}

export async function fetchEvalDecisions(model: EvalModelKey, limit = 20): Promise<EvalDecision[]> {
  const { data, error } = await supabase
    .from('eval_plane_decisions')
    .select('id, model_key, version, decision, reason, metrics, actor_id, created_at')
    .eq('model_key', model)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as EvalDecision[];
}

export async function saveEvalPolicy(model: EvalModelKey, policy: EvalPolicy): Promise<void> {
  const { error } = await supabase.rpc('save_eval_plane_policy', {
    p_model_key: model,
    p_min_sample: policy.min_sample,
    p_ece_warn: policy.ece_warn,
    p_ece_fail: policy.ece_fail,
    p_skill_warn: policy.skill_warn,
    p_skill_fail: policy.skill_fail,
    p_drift_warn: policy.drift_warn,
    p_drift_fail: policy.drift_fail,
  });
  if (error) throw new Error(error.message);
}

export async function recordEvalDecision(
  model: EvalModelKey,
  version: string,
  decision: EvalDecisionKind,
  reason: string,
  metrics: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.rpc('record_eval_plane_decision', {
    p_model_key: model,
    p_version: version,
    p_decision: decision,
    p_reason: reason,
    p_metrics: metrics,
  });
  if (error) throw new Error(error.message);
}
