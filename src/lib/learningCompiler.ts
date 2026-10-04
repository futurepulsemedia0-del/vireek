/**
 * Vireek Organizational Learning Compiler — pure, deterministic, explainable.
 *
 *   Raw Experience -> Observation -> Pattern -> Rule -> Playbook
 *     -> Agent policy -> Workflow blueprint -> Evaluation
 *
 * Experience   = job_outcomes rows (what really happened on each job)
 * Observation  = one normalised record per job: failed or not, plus the
 *                conditions it happened under (technician, part, root cause,
 *                checklist completeness)
 * Pattern      = a condition whose failure rate differs from the SAME job
 *                type without that condition, kept only if it survives
 *                false-discovery control (Benjamini-Hochberg) AND replicates
 *                in both halves of the timeline
 * Rule         = pattern in plain language (IF condition THEN consequence)
 * Playbook     = deterministic response steps for the rule
 * Policy       = an enforceable guard (advise or require approval) that
 *                dispatch, agents and people consult before acting
 * Workflow     = a blueprint of the human-approval step the policy implies
 * Evaluation   = after a human activates the policy, did the matching jobs
 *                really improve versus similar jobs that were not covered
 *                (difference-in-differences)
 *
 * Design rules (same philosophy as outcomeLearning / negativeKnowledge):
 *  - No I/O here. learningCompilerApi.ts persists.
 *  - Small samples are shrunk toward the job type's own baseline.
 *  - Nothing becomes active without a human decision.
 *  - Rework rows are excluded (they are the fix, not new demand), and a
 *    declined quote is a commercial outcome, not a delivery failure.
 */
import { shrink, type JobOutcome } from '@/lib/outcomeLearning';

// ============================================================
// TYPES
// ============================================================

export type FacetDimension = 'technician' | 'root_cause' | 'part' | 'checklist_incomplete';
export type PolicyKind = 'dispatch_review' | 'dispatch_prefer' | 'parts_precheck' | 'checklist_gate' | 'diagnosis_review';
export type PolicySeverity = 'info' | 'caution' | 'avoid';
export type PolicyStatus = 'proposed' | 'active' | 'rejected' | 'retired' | 'superseded';
export type Enforcement = 'advise' | 'require_approval';
export type PatternDirection = 'harmful' | 'protective';

export type OutcomeRow = Pick<
  JobOutcome,
  | 'job_id'
  | 'job_type_key'
  | 'resolution'
  | 'caused_callback'
  | 'is_rework'
  | 'technician_id'
  | 'root_cause_key'
  | 'parts_used'
  | 'checklist_done'
  | 'checklist_total'
  | 'recorded_at'
>;

export interface Facet {
  dimension: FacetDimension;
  value: string;
}

export interface Observation {
  jobId: string;
  jobTypeKey: string;
  failed: boolean;
  at: number;
  facets: Facet[];
}

export interface PatternEvidence {
  samples: number;
  failures: number;
  rate: number;
  complementSamples: number;
  complementFailures: number;
  complementRate: number;
  /** Shrunk difference between the facet rate and the complement rate (negative = protective). */
  lift: number;
  pValue: number;
  qValue: number;
}

export interface Backtest {
  earlyLift: number | null;
  lateLift: number | null;
  replicated: boolean;
}

export interface Pattern {
  jobTypeKey: string;
  dimension: FacetDimension;
  value: string;
  direction: PatternDirection;
  evidence: PatternEvidence;
  backtest: Backtest;
}

export interface LearnedRule {
  facet: string;
  jobTypeKey: string;
  dimension: FacetDimension;
  value: string;
  direction: PatternDirection;
  severity: PolicySeverity;
  condition: string;
  consequence: string;
  evidence: PatternEvidence;
  backtest: Backtest;
}

export interface WorkflowBlueprintStep {
  step_number: number;
  type: 'human_approval';
  delay_minutes: number;
  on_failure: 'stop';
  config: { reason: string };
}

export interface WorkflowBlueprint {
  name: string;
  trigger_event: 'job.created' | 'job.completed';
  steps: WorkflowBlueprintStep[];
  note: string;
}

export interface PolicyDraft {
  facet: string;
  job_type_key: string;
  dimension: FacetDimension;
  dimension_value: string;
  kind: PolicyKind;
  severity: PolicySeverity;
  title: string;
  rationale: string;
  playbook: string[];
  workflow_blueprint: WorkflowBlueprint | null;
  evidence: PatternEvidence;
  backtest: Backtest;
}

export type EvaluationVerdict = 'insufficient_data' | 'effective' | 'inconclusive' | 'harmful' | 'not_applicable';

export interface PolicyEvaluation {
  verdict: EvaluationVerdict;
  before: { n: number; rate: number | null };
  after: { n: number; rate: number | null };
  control: { beforeRate: number | null; afterRate: number | null; used: boolean };
  didEffect: number | null;
  evaluatedAt: string;
}

export interface LearnedPolicy extends PolicyDraft {
  id: string;
  status: PolicyStatus;
  enforcement: Enforcement;
  decided_at: string | null;
  decision_note: string | null;
  activated_at: string | null;
  retired_at: string | null;
  evaluation: PolicyEvaluation | null;
  evaluated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompileStages {
  experiences: number;
  observations: number;
  testedPatterns: number;
  significant: number;
  replicated: number;
  rules: number;
  policies: number;
}

export interface CompileResult {
  stages: CompileStages;
  patterns: Pattern[];
  rules: LearnedRule[];
  policies: PolicyDraft[];
  observations: Observation[];
}

export interface CompileOptions {
  now?: number;
  technicianName?: (id: string) => string;
}

export const COMPILER = {
  windowDays: 365,
  minFacetSamples: 8,
  minComplementSamples: 8,
  minFailures: 3,
  minLift: 0.15,
  avoidLift: 0.3,
  priorStrength: 6,
  fdrQ: 0.1,
  minHalfSamples: 3,
  dedupeJaccard: 0.9,
  maxPolicies: 25,
  minEvalSamples: 8,
  minControlSamples: 4,
  effectiveEffect: 0.1,
  harmfulEffect: -0.05,
} as const;

export const WORKFLOW_BLUEPRINT_NOTE =
  'Enforced today through the policy guard (checkLearnedPolicies). Install as a live workflow once job events carry the job-type key, otherwise it would fire on every job.';

const DAY_MS = 86_400_000;
const SEP = '\u0001';

// ============================================================
// HELPERS
// ============================================================

export const normKey = (raw: string | null | undefined): string =>
  (raw ?? '').trim().toLowerCase().replace(/\s+/g, '_');

const humanize = (key: string): string => key.replace(/_/g, ' ');
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const facetKeyOf = (jobTypeKey: string, dimension: FacetDimension, value: string): string =>
  [jobTypeKey, dimension, value].join(':');

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, |error| < 7.5e-8). */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/** Two-sided two-proportion z-test p-value. */
function twoProportionP(f1: number, n1: number, f0: number, n0: number): number {
  if (n1 <= 0 || n0 <= 0) return 1;
  const pooled = (f1 + f0) / (n1 + n0);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n0));
  if (se === 0) return 1;
  const z = (f1 / n1 - f0 / n0) / se;
  return Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
}

/** Benjamini-Hochberg adjusted q-values, returned in the input order. */
export function benjaminiHochberg(pValues: number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const q = new Array<number>(m).fill(1);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const item = order[rank - 1];
    running = Math.min(running, (item.p * m) / rank);
    q[item.i] = Math.min(1, running);
  }
  return q;
}

// ============================================================
// STAGE 1-2: EXPERIENCE -> OBSERVATION
// ============================================================

export function observe(outcomes: OutcomeRow[], now: number = Date.now()): Observation[] {
  const cutoff = now - COMPILER.windowDays * DAY_MS;
  const out: Observation[] = [];

  for (const o of outcomes) {
    const at = Date.parse(o.recorded_at);
    if (!Number.isFinite(at) || at < cutoff) continue;
    if (o.is_rework) continue;
    if (o.resolution === 'quote_declined' && !o.caused_callback) continue;
    const jobTypeKey = normKey(o.job_type_key);
    if (!jobTypeKey) continue;

    const failed =
      o.caused_callback ||
      o.resolution === 'fixed_followup' ||
      o.resolution === 'unresolved' ||
      o.resolution === 'parts_pending';

    const facets: Facet[] = [];
    if (o.technician_id) facets.push({ dimension: 'technician', value: o.technician_id });
    const cause = normKey(o.root_cause_key);
    if (cause) facets.push({ dimension: 'root_cause', value: cause });
    for (const part of new Set((o.parts_used ?? []).map(normKey).filter(Boolean))) {
      facets.push({ dimension: 'part', value: part });
    }
    if (o.checklist_total > 0 && (o.checklist_done?.length ?? 0) < o.checklist_total) {
      facets.push({ dimension: 'checklist_incomplete', value: 'true' });
    }

    out.push({ jobId: o.job_id, jobTypeKey, failed, at, facets });
  }
  return out;
}

// ============================================================
// STAGE 3: PATTERN
// ============================================================

interface Candidate {
  jobTypeKey: string;
  dimension: FacetDimension;
  value: string;
  members: number[];
  groupSize: number;
  evidence: PatternEvidence;
  backtest: Backtest;
  direction: PatternDirection;
}

const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);

function halfLift(
  facetIdx: number[],
  late: boolean[],
  failed: boolean[],
  totalByHalf: { n: [number, number]; f: [number, number] },
  half: 0 | 1,
): number | null {
  let n = 0;
  let f = 0;
  for (const i of facetIdx) {
    if ((late[i] ? 1 : 0) !== half) continue;
    n++;
    if (failed[i]) f++;
  }
  const n0 = totalByHalf.n[half] - n;
  const f0 = totalByHalf.f[half] - f;
  if (n < COMPILER.minHalfSamples || n0 < COMPILER.minHalfSamples) return null;
  return f / n - f0 / n0;
}

export function detectPatterns(observations: Observation[]): {
  tested: number;
  significant: Pattern[];
  replicated: Pattern[];
} {
  const byType = new Map<string, Observation[]>();
  for (const o of observations) {
    const arr = byType.get(o.jobTypeKey);
    if (arr) arr.push(o);
    else byType.set(o.jobTypeKey, [o]);
  }

  interface Tested {
    c: Candidate;
    p: number;
  }
  const tested: Tested[] = [];

  for (const [jobTypeKey, raw] of byType) {
    const group = [...raw].sort((a, b) => a.at - b.at);
    const N = group.length;
    if (N < COMPILER.minFacetSamples + COMPILER.minComplementSamples) continue;

    const failed = group.map((o) => o.failed);
    const mid = Math.floor(N / 2);
    const late = group.map((_, i) => i >= mid);
    const totalByHalf = { n: [0, 0] as [number, number], f: [0, 0] as [number, number] };
    group.forEach((o, i) => {
      const h = late[i] ? 1 : 0;
      totalByHalf.n[h]++;
      if (o.failed) totalByHalf.f[h]++;
    });
    const totalFailures = failed.filter(Boolean).length;

    const index = new Map<string, { dimension: FacetDimension; value: string; members: number[] }>();
    group.forEach((o, i) => {
      for (const f of o.facets) {
        const key = f.dimension + SEP + f.value;
        const entry = index.get(key);
        if (entry) entry.members.push(i);
        else index.set(key, { dimension: f.dimension, value: f.value, members: [i] });
      }
    });

    for (const { dimension, value, members } of index.values()) {
      const n = members.length;
      const n0 = N - n;
      if (n < COMPILER.minFacetSamples || n0 < COMPILER.minComplementSamples) continue;

      const f = members.filter((i) => failed[i]).length;
      const f0 = totalFailures - f;
      const rate = f / n;
      const rate0 = f0 / n0;
      const lift = shrink(rate, n, rate0, COMPILER.priorStrength) - rate0;
      const direction: PatternDirection = lift >= 0 ? 'harmful' : 'protective';

      const early = halfLift(members, late, failed, totalByHalf, 0);
      const lateLift = halfLift(members, late, failed, totalByHalf, 1);
      const dir = direction === 'harmful' ? 1 : -1;
      const replicated =
        early !== null &&
        lateLift !== null &&
        sign(early) === dir &&
        sign(lateLift) === dir &&
        Math.abs(lateLift) >= COMPILER.minLift / 2;

      tested.push({
        p: twoProportionP(f, n, f0, n0),
        c: {
          jobTypeKey,
          dimension,
          value,
          members,
          groupSize: N,
          direction,
          evidence: {
            samples: n,
            failures: f,
            rate,
            complementSamples: n0,
            complementFailures: f0,
            complementRate: rate0,
            lift,
            pValue: 0,
            qValue: 1,
          },
          backtest: { earlyLift: early, lateLift, replicated },
        },
      });
    }
  }

  const qs = benjaminiHochberg(tested.map((t) => t.p));
  const accepted: Candidate[] = [];
  tested.forEach((t, i) => {
    t.c.evidence.pValue = t.p;
    t.c.evidence.qValue = qs[i];
    const e = t.c.evidence;
    if (qs[i] > COMPILER.fdrQ) return;
    if (Math.abs(e.lift) < COMPILER.minLift) return;
    const supportingFailures = t.c.direction === 'harmful' ? e.failures : e.complementFailures;
    if (supportingFailures < COMPILER.minFailures) return;
    accepted.push(t.c);
  });

  // Redundant evidence is dropped, strongest first:
  //  - same direction and near-identical condition sets (e.g. a part always
  //    used by one technician);
  //  - a protective pattern that is just the mirror image of a harmful one
  //    (with two technicians, "A is worse" already says "B is better").
  accepted.sort((a, b) => Math.abs(b.evidence.lift) * Math.sqrt(b.evidence.samples) - Math.abs(a.evidence.lift) * Math.sqrt(a.evidence.samples));
  const kept: Candidate[] = [];
  for (const c of accepted) {
    const mine = new Set(c.members);
    const duplicate = kept.some((k) => {
      if (k.jobTypeKey !== c.jobTypeKey) return false;
      let inter = 0;
      for (const m of k.members) if (mine.has(m)) inter++;
      const sameSide = k.direction === c.direction;
      const overlap = sameSide ? inter : mine.size - inter;
      const otherSize = sameSide ? k.members.length : c.groupSize - k.members.length;
      const union = mine.size + otherSize - overlap;
      return union > 0 && overlap / union >= COMPILER.dedupeJaccard;
    });
    if (!duplicate) kept.push(c);
  }

  const significant: Pattern[] = kept.map((c) => ({
    jobTypeKey: c.jobTypeKey,
    dimension: c.dimension,
    value: c.value,
    direction: c.direction,
    evidence: c.evidence,
    backtest: c.backtest,
  }));
  return { tested: tested.length, significant, replicated: significant.filter((p) => p.backtest.replicated) };
}

// ============================================================
// STAGE 4-7: RULE -> PLAYBOOK -> POLICY -> WORKFLOW BLUEPRINT
// ============================================================

const severityOf = (p: Pattern): PolicySeverity =>
  p.direction === 'protective' ? 'info' : p.evidence.lift >= COMPILER.avoidLift ? 'avoid' : 'caution';

function labelOf(p: Pattern, techName: (id: string) => string): string {
  if (p.dimension === 'technician') return techName(p.value);
  if (p.dimension === 'checklist_incomplete') return 'an incomplete checklist';
  if (p.dimension === 'part') return `part "${humanize(p.value)}"`;
  return `root cause "${humanize(p.value)}"`;
}

export function toRule(p: Pattern, techName: (id: string) => string): LearnedRule {
  const job = humanize(p.jobTypeKey);
  const who = labelOf(p, techName);
  const e = p.evidence;
  const condition =
    p.dimension === 'technician'
      ? `${job} jobs handled by ${who}`
      : p.dimension === 'checklist_incomplete'
        ? `${job} jobs closed with ${who}`
        : `${job} jobs involving ${who}`;
  const consequence =
    p.direction === 'harmful'
      ? `fail the first visit ${pct(e.rate)} of the time (${e.failures}/${e.samples}) versus ${pct(e.complementRate)} otherwise`
      : `fail only ${pct(e.rate)} of the time (${e.failures}/${e.samples}) versus ${pct(e.complementRate)} otherwise`;
  return {
    facet: facetKeyOf(p.jobTypeKey, p.dimension, p.value),
    jobTypeKey: p.jobTypeKey,
    dimension: p.dimension,
    value: p.value,
    direction: p.direction,
    severity: severityOf(p),
    condition,
    consequence,
    evidence: p.evidence,
    backtest: p.backtest,
  };
}

function kindOf(rule: LearnedRule): PolicyKind | null {
  if (rule.direction === 'protective') return rule.dimension === 'technician' ? 'dispatch_prefer' : null;
  switch (rule.dimension) {
    case 'technician':
      return 'dispatch_review';
    case 'part':
      return 'parts_precheck';
    case 'checklist_incomplete':
      return 'checklist_gate';
    case 'root_cause':
      return 'diagnosis_review';
  }
}

function playbookFor(kind: PolicyKind, rule: LearnedRule, who: string): string[] {
  const job = humanize(rule.jobTypeKey);
  switch (kind) {
    case 'dispatch_review':
      return [
        `Before assigning ${who} to ${job}, check Passport fit for this job type.`,
        `Prefer a technician with a proven first-time-fix record on ${job}.`,
        `If ${who} must take it, attach a pre-job brief or request remote expert assist.`,
      ];
    case 'dispatch_prefer':
      return [`Prefer ${who} when staffing ${job}.`, `Use their approach as the reference when coaching others on ${job}.`];
    case 'parts_precheck':
      return [
        `Before the visit, verify ${humanize(rule.value)} is the right fit and in good condition for ${job}.`,
        'Confirm stock and carry a backup on the truck.',
        'Record the outcome so this rule keeps being tested.',
      ];
    case 'checklist_gate':
      return [
        `Require the full checklist before closing a ${job} job.`,
        'Route incomplete checklists to a quick supervisor review.',
      ];
    case 'diagnosis_review':
      return [
        `When the diagnosis is "${humanize(rule.value)}" on ${job}, get a second opinion before committing.`,
        'Add a verification step before quoting or ordering parts.',
      ];
  }
}

function blueprintFor(kind: PolicyKind, rule: LearnedRule, who: string): WorkflowBlueprint | null {
  if (kind === 'dispatch_prefer') return null;
  const job = humanize(rule.jobTypeKey);
  const reason =
    kind === 'dispatch_review'
      ? `Learned rule: ${who} has a higher first-visit failure rate on ${job}. Approve this assignment or pick someone else.`
      : kind === 'parts_precheck'
        ? `Learned rule: ${humanize(rule.value)} is linked to more failures on ${job}. Confirm the part before dispatch.`
        : kind === 'checklist_gate'
          ? `Learned rule: ${job} jobs closed with an incomplete checklist fail more often. Approve closing without it?`
          : `Learned rule: the "${humanize(rule.value)}" diagnosis on ${job} is often wrong or incomplete. Get a second opinion first.`;
  return {
    name: `Learned: ${job} — ${kind.replace(/_/g, ' ')}`,
    trigger_event: kind === 'checklist_gate' ? 'job.completed' : 'job.created',
    steps: [{ step_number: 1, type: 'human_approval', delay_minutes: 0, on_failure: 'stop', config: { reason } }],
    note: WORKFLOW_BLUEPRINT_NOTE,
  };
}

export function toPolicy(rule: LearnedRule, techName: (id: string) => string): PolicyDraft | null {
  const kind = kindOf(rule);
  if (!kind) return null;
  const who = rule.dimension === 'technician' ? techName(rule.value) : humanize(rule.value);
  const title =
    kind === 'dispatch_review'
      ? `Review ${who} assignments on ${humanize(rule.jobTypeKey)}`
      : kind === 'dispatch_prefer'
        ? `Prefer ${who} on ${humanize(rule.jobTypeKey)}`
        : kind === 'parts_precheck'
          ? `Pre-check ${who} on ${humanize(rule.jobTypeKey)}`
          : kind === 'checklist_gate'
            ? `Require a complete checklist on ${humanize(rule.jobTypeKey)}`
            : `Second opinion for "${who}" on ${humanize(rule.jobTypeKey)}`;
  const b = rule.backtest;
  const replication =
    b.earlyLift !== null && b.lateLift !== null
      ? ` Replicated in both halves of the timeline (${signedPct(b.earlyLift)} earlier, ${signedPct(b.lateLift)} later).`
      : '';
  return {
    facet: rule.facet,
    job_type_key: rule.jobTypeKey,
    dimension: rule.dimension,
    dimension_value: rule.value,
    kind,
    severity: rule.severity,
    title,
    rationale: `${capitalize(rule.condition)} ${rule.consequence}.${replication}`,
    playbook: playbookFor(kind, rule, who),
    workflow_blueprint: blueprintFor(kind, rule, who),
    evidence: rule.evidence,
    backtest: rule.backtest,
  };
}

const capitalize = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const signedPct = (x: number): string => `${x >= 0 ? '+' : ''}${Math.round(x * 100)} pts`;

// ============================================================
// FULL COMPILE
// ============================================================

export function compileLearning(outcomes: OutcomeRow[], opts: CompileOptions = {}): CompileResult {
  const now = opts.now ?? Date.now();
  const techName = opts.technicianName ?? (() => 'this technician');

  const observations = observe(outcomes, now);
  const { tested, significant, replicated } = detectPatterns(observations);
  const rules = replicated.map((p) => toRule(p, techName));
  const policies = rules
    .map((r) => toPolicy(r, techName))
    .filter((p): p is PolicyDraft => p !== null)
    .sort((a, b) => Math.abs(b.evidence.lift) * Math.sqrt(b.evidence.samples) - Math.abs(a.evidence.lift) * Math.sqrt(a.evidence.samples))
    .slice(0, COMPILER.maxPolicies);

  return {
    stages: {
      experiences: outcomes.length,
      observations: observations.length,
      testedPatterns: tested,
      significant: significant.length,
      replicated: replicated.length,
      rules: rules.length,
      policies: policies.length,
    },
    patterns: significant,
    rules,
    policies,
    observations,
  };
}

// ============================================================
// STAGE 8: EVALUATION (difference-in-differences)
// ============================================================

type PolicyScope = Pick<LearnedPolicy, 'job_type_key' | 'dimension' | 'dimension_value' | 'kind' | 'activated_at'>;

const matchesScope = (o: Observation, p: Pick<PolicyScope, 'job_type_key' | 'dimension' | 'dimension_value'>): boolean =>
  o.jobTypeKey === p.job_type_key && o.facets.some((f) => f.dimension === p.dimension && f.value === p.dimension_value);

function rateOf(list: Observation[]): number | null {
  if (list.length === 0) return null;
  return list.filter((o) => o.failed).length / list.length;
}

export function evaluatePolicy(policy: PolicyScope, observations: Observation[], now: number = Date.now()): PolicyEvaluation {
  const evaluatedAt = new Date(now).toISOString();
  const empty = { n: 0, rate: null as number | null };
  const base: PolicyEvaluation = {
    verdict: 'insufficient_data',
    before: empty,
    after: empty,
    control: { beforeRate: null, afterRate: null, used: false },
    didEffect: null,
    evaluatedAt,
  };

  if (policy.kind === 'dispatch_prefer') return { ...base, verdict: 'not_applicable' };
  const activated = policy.activated_at ? Date.parse(policy.activated_at) : NaN;
  if (!Number.isFinite(activated)) return base;

  const sameType = observations.filter((o) => o.jobTypeKey === policy.job_type_key);
  const matched = sameType.filter((o) => matchesScope(o, policy));
  const others = sameType.filter((o) => !matchesScope(o, policy));
  const before = matched.filter((o) => o.at < activated);
  const after = matched.filter((o) => o.at >= activated);

  const result: PolicyEvaluation = {
    ...base,
    before: { n: before.length, rate: rateOf(before) },
    after: { n: after.length, rate: rateOf(after) },
  };
  const rb = result.before.rate;
  const ra = result.after.rate;
  if (before.length < COMPILER.minEvalSamples || after.length < COMPILER.minEvalSamples || rb === null || ra === null) {
    return result;
  }

  const ctlBefore = others.filter((o) => o.at < activated);
  const ctlAfter = others.filter((o) => o.at >= activated);
  const controlUsed = ctlBefore.length >= COMPILER.minControlSamples && ctlAfter.length >= COMPILER.minControlSamples;
  const cb = controlUsed ? rateOf(ctlBefore) : null;
  const ca = controlUsed ? rateOf(ctlAfter) : null;
  const did = rb - ra - (cb !== null && ca !== null ? cb - ca : 0);

  const verdict: EvaluationVerdict =
    did >= COMPILER.effectiveEffect ? 'effective' : did <= COMPILER.harmfulEffect ? 'harmful' : 'inconclusive';
  return { ...result, verdict, didEffect: did, control: { beforeRate: cb, afterRate: ca, used: controlUsed } };
}

// ============================================================
// RUNTIME GUARD — what dispatch, agents and people call before acting
// ============================================================

export interface PolicyCheckContext {
  /** Same job_type_key that job_outcomes uses. */
  jobTypeKey: string;
  technicianId?: string | null;
  partKeys?: string[];
  rootCauseKey?: string | null;
  checklistIncomplete?: boolean;
}

export type GuardPolicy = Pick<
  LearnedPolicy,
  'id' | 'job_type_key' | 'dimension' | 'dimension_value' | 'kind' | 'severity' | 'enforcement' | 'title' | 'rationale'
>;

export interface PolicyMatch {
  policyId: string;
  kind: PolicyKind;
  severity: PolicySeverity;
  requiresApproval: boolean;
  title: string;
  message: string;
}

const SEVERITY_RANK: Record<PolicySeverity, number> = { avoid: 0, caution: 1, info: 2 };

export function checkPolicies(ctx: PolicyCheckContext, policies: GuardPolicy[]): PolicyMatch[] {
  const jobType = normKey(ctx.jobTypeKey);
  const parts = new Set((ctx.partKeys ?? []).map(normKey));
  const cause = normKey(ctx.rootCauseKey);
  const out: PolicyMatch[] = [];

  for (const p of policies) {
    if (normKey(p.job_type_key) !== jobType) continue;
    const hit =
      (p.dimension === 'technician' && !!ctx.technicianId && ctx.technicianId === p.dimension_value) ||
      (p.dimension === 'part' && parts.has(p.dimension_value)) ||
      (p.dimension === 'root_cause' && cause !== '' && cause === p.dimension_value) ||
      (p.dimension === 'checklist_incomplete' && ctx.checklistIncomplete === true);
    if (!hit) continue;
    out.push({
      policyId: p.id,
      kind: p.kind,
      severity: p.severity,
      requiresApproval: p.enforcement === 'require_approval' && p.kind !== 'dispatch_prefer',
      title: p.title,
      message: p.rationale,
    });
  }
  return out.sort((a, b) => Number(b.requiresApproval) - Number(a.requiresApproval) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// ============================================================
// LABELS
// ============================================================

export const KIND_LABELS: Record<PolicyKind, string> = {
  dispatch_review: 'Dispatch review',
  dispatch_prefer: 'Dispatch preference',
  parts_precheck: 'Parts pre-check',
  checklist_gate: 'Checklist gate',
  diagnosis_review: 'Diagnosis review',
};

export const VERDICT_LABELS: Record<EvaluationVerdict, string> = {
  insufficient_data: 'Collecting evidence',
  effective: 'Working',
  inconclusive: 'No clear effect yet',
  harmful: 'Making it worse',
  not_applicable: 'Not measured',
};
