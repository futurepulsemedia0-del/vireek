/**
 * Causal Dispatch Loop — estimation library (pure, no I/O, no side effects on production weights).
 *
 * Input: dispatch decisions where the policy randomized (or deliberately did not randomize, with a known
 * probability) among near-equal technicians. Each row carries the set that was drawn from and the true
 * probability of every member (supabase/migrations/20281102000100_causal_dispatch_loop.sql).
 *
 * Output:
 *  1. technician x job-type effects on first-time-fix, 14- and 30-day callbacks and duration residual,
 *     via a doubly-robust (IPW + outcome model) estimator, with hierarchical shrinkage for thin cells,
 *     confidence intervals and an evidence grade (same A/B/C scale as opsExperiments);
 *  2. causal provenance per explainable factor: validated_by_randomization | observational_only | contradicted;
 *  3. weight SUGGESTIONS. Nothing here changes a rule: an owner must approve and apply every suggestion.
 *
 * Maturity: outcomes are read with opsExperiments.observe(), so immature jobs are never counted as successes.
 */

import { MIN_CELL_N, observe, summarize, twoSidedP, type EvidenceGrade, type ExpJob } from './opsExperiments';

// ============================================================
// TYPES
// ============================================================

export type OutcomeKey = 'ftf' | 'callback14' | 'callback30' | 'durationResidual';
export const OUTCOME_KEYS: OutcomeKey[] = ['ftf', 'callback14', 'callback30', 'durationResidual'];

export const OUTCOME_META: Record<OutcomeKey, { label: string; unit: 'proportion' | 'minutes'; higherIsBetter: boolean; windowDays: number | null }> = {
  ftf: { label: 'First-time fix (14 days)', unit: 'proportion', higherIsBetter: true, windowDays: 14 },
  callback14: { label: 'Callback within 14 days', unit: 'proportion', higherIsBetter: false, windowDays: 14 },
  callback30: { label: 'Callback within 30 days', unit: 'proportion', higherIsBetter: false, windowDays: 30 },
  durationResidual: { label: 'Duration vs prediction (min)', unit: 'minutes', higherIsBetter: false, windowDays: null },
};

export interface SetMember {
  id: string;
  /** Probability this technician was chosen under the policy that ran (members sum to 1). */
  p: number;
  score: number;
  /** Points of each explainable factor for this technician on this job. */
  f: Record<string, number>;
}

export interface CausalRow {
  decisionId: string;
  jobId: string;
  jobType: string;
  chosenId: string;
  members: SetMember[];
  outcomes: Record<OutcomeKey, number | null>;
}

export interface RawDecision {
  id: string;
  job_id: string;
  technician_id: string | null;
  arm: string | null;
  set_size: number | null;
  indifference_set: unknown;
}

export interface RawOutcomeJob extends ExpJob {
  /** Technician who actually holds / did the job now. */
  assigned_technician_id: string | null;
}

export type FactorProvenanceKind = 'validated_by_randomization' | 'observational_only' | 'contradicted';

export interface CellEffect {
  technicianId: string;
  jobType: string;
  outcome: OutcomeKey;
  /** Mature, randomized decisions in this cell. */
  n: number;
  /** Raw doubly-robust estimate and its standard error (null when n < 2). */
  raw: number;
  rawSe: number | null;
  /** Shrunk (empirical-Bayes) estimate, vs the equal-weighted average of the technicians it competed with. */
  est: number;
  se: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  p: number | null;
  grade: EvidenceGrade;
}

export interface FactorProvenance {
  factor: string;
  provenance: FactorProvenanceKind;
  /** Change in P(first-time fix, 14d) per point of this factor, within the set. Null when not estimable. */
  beta: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  /** Randomized decisions in which this factor actually differed between set members. */
  nInformative: number;
  grade: EvidenceGrade;
  note: string;
}

export interface WeightSuggestion {
  ruleType: string;
  currentWeight: number;
  suggestedWeight: number;
  direction: 'decrease' | 'increase';
  reason: string;
  evidence: FactorProvenance;
}

export interface ExtractDiagnostics {
  considered: number;
  used: number;
  droppedNotRandomized: number;
  droppedMalformed: number;
  droppedReassigned: number;
}

// ============================================================
// BUILDING ROWS FROM THE DECISION LOG
// ============================================================

const DAY = 86_400_000;
const P_TOL = 1e-3;
/** `reason` values for which the logged probabilities are the true assignment probabilities. */
const KNOWN_PROPENSITY_REASONS = new Set(['explored', 'not_enrolled']);

export const normalizeJobType = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase() || 'unknown';

/** Parse indifference_set.members defensively; null when the row cannot be used for causal estimation. */
export function parseSet(raw: unknown, chosenId: string | null): SetMember[] | null {
  const o = raw as { reason?: unknown; members?: unknown } | null;
  if (!o || typeof o !== 'object' || typeof o.reason !== 'string' || !KNOWN_PROPENSITY_REASONS.has(o.reason) || !Array.isArray(o.members)) return null;
  const members: SetMember[] = [];
  for (const m of o.members as Record<string, unknown>[]) {
    if (!m || typeof m.id !== 'string' || typeof m.p !== 'number' || !(m.p > 0) || m.p > 1 || typeof m.score !== 'number') return null;
    const f: Record<string, number> = {};
    if (m.f && typeof m.f === 'object') for (const [k, v] of Object.entries(m.f as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) f[k] = v;
    members.push({ id: m.id, p: m.p, score: m.score, f });
  }
  if (members.length < 2 || new Set(members.map((m) => m.id)).size !== members.length) return null;
  if (Math.abs(members.reduce((s, m) => s + m.p, 0) - 1) > P_TOL) return null;
  if (!chosenId || !members.some((m) => m.id === chosenId)) return null;
  return members;
}

export interface BuildInput {
  decisions: RawDecision[];
  jobs: RawOutcomeJob[];
  /** created_at of every rework job keyed by the job it reworks. */
  reworks: { rework_of_job_id: string | null; created_at: string }[];
  /** job id -> (actual − p50) in minutes, from the conformal duration predictions. */
  durationResidual?: Record<string, number>;
  now: Date;
}

/** Callback set for ONE window: original job ids that had a rework opened within `windowDays` of completion. */
export function reworkedWithin(jobs: RawOutcomeJob[], reworks: BuildInput['reworks'], windowDays: number): Set<string> {
  const completed = new Map(jobs.map((j) => [j.id, j.completed_at ? Date.parse(j.completed_at) : NaN]));
  const out = new Set<string>();
  for (const r of reworks) {
    if (!r.rework_of_job_id) continue;
    const c = completed.get(r.rework_of_job_id);
    const t = Date.parse(r.created_at);
    if (c !== undefined && Number.isFinite(c) && Number.isFinite(t) && t >= c && t - c <= windowDays * DAY) out.add(r.rework_of_job_id);
  }
  return out;
}

export function buildCausalRows(input: BuildInput): { rows: CausalRow[]; diagnostics: ExtractDiagnostics } {
  const { decisions, jobs, now } = input;
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const set14 = reworkedWithin(jobs, input.reworks, 14);
  const set30 = reworkedWithin(jobs, input.reworks, 30);
  const diag: ExtractDiagnostics = { considered: decisions.length, used: 0, droppedNotRandomized: 0, droppedMalformed: 0, droppedReassigned: 0 };
  const rows: CausalRow[] = [];
  const seenJobs = new Set<string>();

  // Newest first in the log; keep one row per job (a job can be re-dispatched) — the most recent decision.
  for (const d of decisions) {
    if (d.arm !== 'explore' && d.arm !== 'exploit') { diag.droppedNotRandomized++; continue; }
    const members = parseSet(d.indifference_set, d.technician_id);
    if (!members) {
      const reason = (d.indifference_set as { reason?: unknown } | null)?.reason;
      if (typeof reason === 'string' && !KNOWN_PROPENSITY_REASONS.has(reason)) diag.droppedNotRandomized++; else diag.droppedMalformed++;
      continue;
    }
    if (seenJobs.has(d.job_id)) { diag.droppedReassigned++; continue; }
    const job = jobById.get(d.job_id);
    if (!job) { diag.droppedMalformed++; continue; }
    seenJobs.add(d.job_id);
    // The causal claim is about the technician who was drawn. If the job was moved to someone else, the outcome
    // belongs to a different treatment, so it cannot be attributed to this draw.
    if (job.assigned_technician_id !== d.technician_id) { diag.droppedReassigned++; continue; }

    const ftf = observe('ftf_rate', job, { reworked: set14, now, maturityDays: 14 });
    const cb14 = observe('callback_rate', job, { reworked: set14, now, maturityDays: 14 });
    const cb30 = observe('callback_rate', job, { reworked: set30, now, maturityDays: 30 });
    const dur = input.durationResidual?.[d.job_id];
    rows.push({
      decisionId: d.id,
      jobId: d.job_id,
      jobType: normalizeJobType(job.service_type),
      chosenId: d.technician_id as string,
      members,
      outcomes: { ftf, callback14: cb14, callback30: cb30, durationResidual: typeof dur === 'number' && Number.isFinite(dur) && job.job_status === 'completed' ? dur : null },
    });
    diag.used++;
  }
  return { rows, diagnostics: diag };
}

// ============================================================
// DOUBLY-ROBUST TECHNICIAN x JOB-TYPE EFFECTS
// ============================================================

const Z95 = 1.959963984540054;
/** Cell key separator: service types are free text, so a printable separator could collide. */
const SEP = '\u0001';
/** Pseudo-observations pulling a thin cell's outcome model towards the technician's overall mean. */
const PRIOR_STRENGTH = 5;

interface Sums { n: number; sum: number }
const add = (m: Map<string, Sums>, k: string, y: number, sign = 1) => {
  const s = m.get(k) ?? { n: 0, sum: 0 };
  s.n += sign;
  s.sum += sign * y;
  m.set(k, s);
};

export function gradeEvidence(outcome: OutcomeKey, n: number, rawSe: number | null): EvidenceGrade {
  const half = rawSe === null ? Infinity : Z95 * rawSe;
  const precise = OUTCOME_META[outcome].unit === 'proportion' ? half <= 0.15 : half <= 15;
  if (n >= 2 * MIN_CELL_N && precise) return 'A';
  if (n >= MIN_CELL_N) return 'B';
  return 'C';
}

/**
 * Effect of technician t on `outcome` for job type τ, relative to the equal-weighted average of the technicians in
 * the same indifference sets: E[ψ_t − mean_j ψ_j], with the doubly-robust score
 *   ψ_j = m_j(τ) + 1{A = j} (Y − m_j(τ)) / p_j .
 * p_j are the LOGGED assignment probabilities (so confounded "exploit" rows are correctly down-weighted), and m_j is a
 * leave-one-out shrunk cell mean (so a row never predicts itself). Consistent if either p or m is right.
 */
export function estimateCellEffects(rows: CausalRow[], outcome: OutcomeKey): CellEffect[] {
  const usable = rows.filter((r) => r.outcomes[outcome] !== null && Number.isFinite(r.outcomes[outcome] as number));
  if (usable.length === 0) return [];

  const tj = new Map<string, Sums>();
  const t = new Map<string, Sums>();
  const g: Sums = { n: 0, sum: 0 };
  for (const r of usable) {
    const y = r.outcomes[outcome] as number;
    add(tj, `${r.chosenId}${SEP}${r.jobType}`, y);
    add(t, r.chosenId, y);
    g.n += 1; g.sum += y;
  }

  const phis = new Map<string, number[]>();
  for (const r of usable) {
    const y = r.outcomes[outcome] as number;
    const gMean = g.n > 1 ? (g.sum - y) / (g.n - 1) : 0;
    const psi: number[] = r.members.map((m) => {
      const own = m.id === r.chosenId;
      const cj = tj.get(`${m.id}${SEP}${r.jobType}`) ?? { n: 0, sum: 0 };
      const ct = t.get(m.id) ?? { n: 0, sum: 0 };
      const nj = cj.n - (own ? 1 : 0);
      const sj = cj.sum - (own ? y : 0);
      const nt = ct.n - (own ? 1 : 0);
      const st = ct.sum - (own ? y : 0);
      const priorT = (st + PRIOR_STRENGTH * gMean) / (nt + PRIOR_STRENGTH);
      const mHat = (sj + PRIOR_STRENGTH * priorT) / (nj + PRIOR_STRENGTH);
      return own ? mHat + (y - mHat) / m.p : mHat;
    });
    const mean = psi.reduce((s, v) => s + v, 0) / psi.length;
    r.members.forEach((m, i) => {
      const key = `${m.id}${SEP}${r.jobType}`;
      const list = phis.get(key) ?? [];
      list.push(psi[i] - mean);
      phis.set(key, list);
    });
  }

  // Variance stabilisation: a cell whose few observations happen to be identical must not claim zero uncertainty,
  // so each cell variance is blended with the pooled variance (prior weight = 2 degrees of freedom).
  const stats = [...phis.entries()].map(([key, vals]) => ({ key, s: summarize(vals) }));
  let pooledNum = 0;
  let pooledDen = 0;
  for (const { s } of stats) if (s.n >= 2) { pooledNum += (s.n - 1) * s.variance; pooledDen += s.n - 1; }
  const pooledVar = pooledDen > 0 ? pooledNum / pooledDen : 0;
  const cells = stats.map(({ key, s }) => {
    const cut = key.indexOf(SEP);
    const technicianId = key.slice(0, cut);
    const jobType = key.slice(cut + 1);
    const df = s.n - 1;
    const v = s.n >= 2 ? (df * s.variance + 2 * pooledVar) / (df + 2) : 0;
    const rawSe = s.n >= 2 && v > 0 ? Math.sqrt(v / s.n) : null;
    return { technicianId, jobType, n: s.n, raw: s.mean, rawSe };
  });
  return shrink(cells, outcome);
}

interface RawCell { technicianId: string; jobType: string; n: number; raw: number; rawSe: number | null }

/**
 * Two-level normal-normal shrinkage: cell -> technician mean -> 0 (a technician's effects average to ~0 against the
 * peers they competed with). Variances come from method of moments, so thin cells lean on their technician's other
 * job types instead of reporting noise.
 */
function shrink(cells: RawCell[], outcome: OutcomeKey): CellEffect[] {
  const se2 = (c: RawCell) => (c.rawSe === null ? Infinity : c.rawSe ** 2);

  // between-cell variance (within technician), pooled
  const byTech = new Map<string, RawCell[]>();
  for (const c of cells) byTech.set(c.technicianId, [...(byTech.get(c.technicianId) ?? []), c]);
  let num = 0;
  let den = 0;
  for (const list of byTech.values()) {
    const inf = list.filter((c) => c.rawSe !== null);
    if (inf.length < 2) continue;
    const w = inf.map((c) => 1 / se2(c));
    const mean = inf.reduce((s, c, i) => s + w[i] * c.raw, 0) / w.reduce((s, v) => s + v, 0);
    const q = inf.reduce((s, c, i) => s + w[i] * (c.raw - mean) ** 2, 0);
    const sw = w.reduce((s, v) => s + v, 0);
    const c0 = sw - w.reduce((s, v) => s + v * v, 0) / sw;
    num += Math.max(0, q - (inf.length - 1));
    den += c0;
  }
  const tau2Cell = den > 0 ? num / den : 0;

  // technician-level means
  const tech = [...byTech.entries()].map(([id, list]) => {
    const inf = list.filter((c) => c.rawSe !== null);
    const w = inf.map((c) => 1 / (se2(c) + tau2Cell));
    const sw = w.reduce((s, v) => s + v, 0);
    return sw > 0
      ? { id, mean: inf.reduce((s, c, i) => s + w[i] * c.raw, 0) / sw, v: 1 / sw }
      : { id, mean: 0, v: Infinity };
  });
  const finiteTech = tech.filter((x) => Number.isFinite(x.v));
  const tm = finiteTech.length ? finiteTech.reduce((s, x) => s + x.mean, 0) / finiteTech.length : 0;
  const varAcross = finiteTech.length > 1 ? finiteTech.reduce((s, x) => s + (x.mean - tm) ** 2, 0) / (finiteTech.length - 1) : 0;
  const meanV = finiteTech.length ? finiteTech.reduce((s, x) => s + x.v, 0) / finiteTech.length : 0;
  const tau2Tech = Math.max(0, varAcross - meanV);
  const techPost = new Map(tech.map((x) => {
    if (!Number.isFinite(x.v)) return [x.id, { mean: 0, v: tau2Tech }] as const;
    const b = tau2Tech + x.v > 0 ? tau2Tech / (tau2Tech + x.v) : 0;
    return [x.id, { mean: b * x.mean, v: b * x.v }] as const;
  }));

  return cells.map((c) => {
    const tp = techPost.get(c.technicianId) ?? { mean: 0, v: tau2Tech };
    let est: number;
    let se: number | null;
    if (c.rawSe === null) {
      est = tp.mean;
      se = Number.isFinite(tp.v + tau2Cell) ? Math.sqrt(tp.v + tau2Cell) : null;
    } else {
      const s2 = c.rawSe ** 2;
      const b = tau2Cell + s2 > 0 ? tau2Cell / (tau2Cell + s2) : 0;
      est = b * c.raw + (1 - b) * tp.mean;
      se = Math.sqrt(b * s2 + (1 - b) ** 2 * tp.v);
    }
    const ok = se !== null && se > 0 && Number.isFinite(se);
    return {
      technicianId: c.technicianId,
      jobType: c.jobType,
      outcome,
      n: c.n,
      raw: c.raw,
      rawSe: c.rawSe,
      est,
      se: ok ? se : null,
      ciLow: ok ? est - Z95 * (se as number) : null,
      ciHigh: ok ? est + Z95 * (se as number) : null,
      p: ok ? twoSidedP(est / (se as number)) : null,
      grade: gradeEvidence(outcome, c.n, c.rawSe),
    };
  });
}

// ============================================================
// CAUSAL PROVENANCE OF EXPLAINABLE FACTORS
// ============================================================

/** Randomized decisions in which the factor differs between members, needed before any verdict. */
export const MIN_FACTOR_N = 30;

/**
 * Does more of this factor actually improve first-time fix, when who-gets-the-job is random within a set?
 * Within a set, the logged probabilities make  x_i = f_chosen − mean_j f_j  mean-zero after weighting by 1/p, so
 *   β̂ = Σ_i x_i (Y_i − Ȳ) / p_i  /  Σ_i Σ_j (f_j − f̄_i)²
 * is an unbiased slope of outcome on factor points (job difficulty cancels because it is shared by the whole set).
 */
export function factorProvenance(rows: CausalRow[], factor: string, outcome: OutcomeKey = 'ftf'): FactorProvenance {
  const usable = rows.filter((r) => r.outcomes[outcome] !== null);
  const ybar = usable.length ? usable.reduce((s, r) => s + (r.outcomes[outcome] as number), 0) / usable.length : 0;
  let D = 0;
  const terms: { num: number; d: number }[] = [];
  for (const r of usable) {
    const fs = r.members.map((m) => m.f[factor] ?? 0);
    const fbar = fs.reduce((s, v) => s + v, 0) / fs.length;
    const d = fs.reduce((s, v) => s + (v - fbar) ** 2, 0);
    if (d < 1e-9) continue;
    const idx = r.members.findIndex((m) => m.id === r.chosenId);
    const x = fs[idx] - fbar;
    terms.push({ num: (x * ((r.outcomes[outcome] as number) - ybar)) / r.members[idx].p, d });
    D += d;
  }
  const nInformative = terms.length;
  const base = { factor, nInformative };
  if (nInformative < MIN_FACTOR_N || D < 1e-9) {
    return { ...base, provenance: 'observational_only', beta: null, ciLow: null, ciHigh: null, grade: 'C', note: `Only ${nInformative} randomized decisions where this factor differed between near-equal technicians (need ${MIN_FACTOR_N}).` };
  }
  const beta = terms.reduce((s, t) => s + t.num, 0) / D;
  const se = Math.sqrt(terms.reduce((s, t) => s + (t.num - beta * t.d) ** 2, 0)) / D;
  const lo = beta - Z95 * se;
  const hi = beta + Z95 * se;
  const grade: EvidenceGrade = nInformative >= 2 * MIN_CELL_N && hi - lo <= 0.1 ? 'A' : nInformative >= MIN_CELL_N ? 'B' : 'C';
  const pp = (v: number) => `${(v * 100).toFixed(2)} pp`;
  if (lo > 0) return { ...base, provenance: 'validated_by_randomization', beta, ciLow: lo, ciHigh: hi, grade, note: `Randomized: +${pp(beta)} first-time-fix per point (95% CI ${pp(lo)} to ${pp(hi)}).` };
  if (hi < 0) return { ...base, provenance: 'contradicted', beta, ciLow: lo, ciHigh: hi, grade, note: `Randomized: ${pp(beta)} first-time-fix per point (95% CI ${pp(lo)} to ${pp(hi)}) — more of this factor is associated with WORSE outcomes.` };
  return { ...base, provenance: 'observational_only', beta, ciLow: lo, ciHigh: hi, grade, note: `Randomized data is inconclusive: ${pp(beta)} per point (95% CI ${pp(lo)} to ${pp(hi)}).` };
}

export function allFactorProvenance(rows: CausalRow[], outcome: OutcomeKey = 'ftf'): Record<string, FactorProvenance> {
  const keys = new Set<string>();
  for (const r of rows) for (const m of r.members) for (const k of Object.keys(m.f)) keys.add(k);
  return Object.fromEntries([...keys].sort().map((k) => [k, factorProvenance(rows, k, outcome)]));
}

// ============================================================
// SUGGESTIONS (never applied automatically)
// ============================================================

export interface RuleLike { rule_type: string; weight: number; mode: 'require' | 'score'; enabled: boolean }

export function suggestWeightChanges(provenance: Record<string, FactorProvenance>, rules: RuleLike[]): WeightSuggestion[] {
  const out: WeightSuggestion[] = [];
  for (const rule of rules) {
    const ev = provenance[rule.rule_type];
    // require-mode rules are hard filters, not weights; disabled rules have nothing to tune
    if (!ev || rule.mode !== 'score' || !rule.enabled) continue;
    if (ev.provenance === 'contradicted' && rule.weight > 0) {
      out.push({ ruleType: rule.rule_type, currentWeight: rule.weight, suggestedWeight: Math.floor(rule.weight / 2), direction: 'decrease', evidence: ev, reason: `Randomized evidence contradicts this rule. ${ev.note} Halving its weight is suggested.` });
    } else if (ev.provenance === 'validated_by_randomization' && ev.grade === 'A' && rule.weight < 100) {
      out.push({ ruleType: rule.rule_type, currentWeight: rule.weight, suggestedWeight: Math.min(100, Math.round(rule.weight * 1.2)), direction: 'increase', evidence: ev, reason: `Strong randomized evidence supports this rule. ${ev.note} A modest +20% weight is suggested.` });
    }
  }
  return out;
}

// ============================================================
// ONE-CALL ANALYSIS
// ============================================================

export interface CausalAnalysis {
  diagnostics: ExtractDiagnostics;
  effects: Record<OutcomeKey, CellEffect[]>;
  factors: Record<string, FactorProvenance>;
}

export function analyzeCausalDispatch(input: BuildInput): CausalAnalysis {
  const { rows, diagnostics } = buildCausalRows(input);
  return {
    diagnostics,
    effects: Object.fromEntries(OUTCOME_KEYS.map((k) => [k, estimateCellEffects(rows, k)])) as Record<OutcomeKey, CellEffect[]>,
    factors: allFactorProvenance(rows, 'ftf'),
  };
}
