/**
 * Negative Knowledge Engine — pure, deterministic, explainable.
 *
 * Vireek learns from failures, not only successes. When an action (an offer,
 * a script, a technician, a time slot) keeps ending badly in a given context,
 * it becomes a rule that warns before the same mistake is repeated.
 *
 * Principles (mirrors outcomeLearning.ts):
 *  - Small samples are shrunk toward the baseline failure rate for that action
 *    kind, so two unlucky jobs never blacklist anything.
 *  - Rules are advisory. The guard returns a warning and a reason; a person
 *    decides. Dismissed rules stay dismissed across refreshes.
 *  - Every rule carries its evidence (samples, failures, baseline).
 *  - Each event is counted under several facets (the action alone, plus the
 *    action with one context dimension), so a rule says exactly where it
 *    applies, e.g. "for price-sensitive customers".
 *
 * No I/O here. negativeKnowledgeApi.ts persists.
 */

import { shrink } from '@/lib/outcomeLearning';

export type NegativeActionKind = 'offer' | 'script' | 'technician' | 'schedule';
export type NegativeOutcome = 'converted' | 'completed' | 'declined' | 'opted_out' | 'callback' | 'cancelled';
export type Daypart = 'morning' | 'afternoon' | 'evening';
export type RuleSeverity = 'caution' | 'avoid';

export interface NegativeContext {
  segment?: string | null;
  region?: string | null;
  asset_model?: string | null;
  daypart?: Daypart | null;
  job_type?: string | null;
}

export interface NegativeEvent {
  action_kind: NegativeActionKind;
  /** Offer id, script id, technician id, or job-type key. */
  subject_key: string;
  outcome: NegativeOutcome;
  context: NegativeContext;
  recorded_at: string;
}

export interface RuleEvidence {
  samples: number;
  failures: number;
  failure_pct: number;
  baseline_pct: number;
  top_outcome: NegativeOutcome | null;
}

export interface DraftRule {
  facet: string;
  action_kind: NegativeActionKind;
  subject_key: string;
  scope: string;
  severity: RuleSeverity;
  title: string;
  rationale: string;
  evidence: RuleEvidence;
}

export interface NegativeRule extends DraftRule {
  id?: string;
  status: 'active' | 'dismissed';
}

export const NEGATIVE_LEARNING = {
  windowDays: 180,
  minSamples: 6,
  minFailures: 3,
  minLift: 0.15,
  avoidLift: 0.3,
  baselinePrior: 0.2,
} as const;

const DAY_MS = 86_400_000;

const FAILURES: ReadonlySet<NegativeOutcome> = new Set(['declined', 'opted_out', 'callback', 'cancelled']);

export const isFailure = (outcome: NegativeOutcome): boolean => FAILURES.has(outcome);

/** A technician's job that needed a follow-up visit counts as a failure. */
export function technicianOutcome(resolution: string): NegativeOutcome {
  return resolution === 'fixed_first_visit' ? 'completed' : 'callback';
}

export function daypartOf(hour: number): Daypart {
  if (hour < 12) return 'morning';
  return hour < 17 ? 'afternoon' : 'evening';
}

const KINDS: readonly NegativeActionKind[] = ['offer', 'script', 'technician', 'schedule'];

const DIMENSIONS = [
  ['segment', 'segment'],
  ['region', 'region'],
  ['asset_model', 'asset model'],
  ['daypart', 'time of day'],
  ['job_type', 'job type'],
] as const;

const KIND_LABEL: Record<NegativeActionKind, string> = {
  offer: 'Offer',
  script: 'Script',
  technician: 'Technician',
  schedule: 'Time slot',
};

const OUTCOME_LABEL: Record<NegativeOutcome, string> = {
  converted: 'converted',
  completed: 'completed',
  declined: 'declined',
  opted_out: 'opted out',
  callback: 'needed a callback',
  cancelled: 'was cancelled',
};

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '_');

export interface Facet {
  key: string;
  scope: string;
}

export function facetsFor(kind: NegativeActionKind, subject: string, ctx: NegativeContext): Facet[] {
  const base = `${kind}:${subject}`;
  const facets: Facet[] = [{ key: base, scope: 'all contexts' }];
  for (const [field, label] of DIMENSIONS) {
    const raw = ctx[field];
    if (raw) {
      const value = normalize(raw);
      facets.push({ key: `${base}|${field}=${value}`, scope: `${label} “${value.replace(/_/g, ' ')}”` });
    }
  }
  return facets;
}

function topOutcome(list: NegativeOutcome[]): NegativeOutcome | null {
  const counts = new Map<NegativeOutcome, number>();
  for (const o of list) counts.set(o, (counts.get(o) ?? 0) + 1);
  let best: NegativeOutcome | null = null;
  let bestCount = 0;
  for (const [outcome, count] of counts) {
    if (count > bestCount) {
      best = outcome;
      bestCount = count;
    }
  }
  return best;
}

interface Group {
  facet: string;
  kind: NegativeActionKind;
  subject: string;
  scope: string;
  rows: NegativeEvent[];
}

/** Derives explainable rules from raw events. Pure: pass `now` in tests. */
export function deriveRules(events: NegativeEvent[], now: number = Date.now()): DraftRule[] {
  const cutoff = now - NEGATIVE_LEARNING.windowDays * DAY_MS;
  const recent = events.filter((e) => Date.parse(e.recorded_at) >= cutoff);

  const baseline = new Map<NegativeActionKind, number>();
  for (const kind of KINDS) {
    const rows = recent.filter((e) => e.action_kind === kind);
    const failures = rows.filter((e) => isFailure(e.outcome)).length;
    baseline.set(kind, shrink(rows.length > 0 ? failures / rows.length : 0, rows.length, NEGATIVE_LEARNING.baselinePrior));
  }

  const groups = new Map<string, Group>();
  for (const e of recent) {
    for (const f of facetsFor(e.action_kind, e.subject_key, e.context)) {
      const g = groups.get(f.key) ?? { facet: f.key, kind: e.action_kind, subject: e.subject_key, scope: f.scope, rows: [] };
      g.rows.push(e);
      groups.set(f.key, g);
    }
  }

  const rules: DraftRule[] = [];
  for (const g of groups.values()) {
    const failures = g.rows.filter((e) => isFailure(e.outcome));
    if (g.rows.length < NEGATIVE_LEARNING.minSamples || failures.length < NEGATIVE_LEARNING.minFailures) continue;

    const base = baseline.get(g.kind) ?? NEGATIVE_LEARNING.baselinePrior;
    const lift = shrink(failures.length / g.rows.length, g.rows.length, base) - base;
    if (lift < NEGATIVE_LEARNING.minLift) continue;

    const top = topOutcome(failures.map((e) => e.outcome));
    const topLabel = top ? OUTCOME_LABEL[top] : 'failed';
    const baselinePct = Math.round(base * 100);

    rules.push({
      facet: g.facet,
      action_kind: g.kind,
      subject_key: g.subject,
      scope: g.scope,
      severity: lift >= NEGATIVE_LEARNING.avoidLift ? 'avoid' : 'caution',
      title: `${KIND_LABEL[g.kind]} “${g.subject}” fails ${g.scope === 'all contexts' ? 'in every context' : `for ${g.scope}`}`,
      rationale: `${failures.length} of ${g.rows.length} recent ${KIND_LABEL[g.kind].toLowerCase()} events ${topLabel}, against a ${baselinePct}% failure baseline for this kind of action. Warn before repeating it.`,
      evidence: {
        samples: g.rows.length,
        failures: failures.length,
        failure_pct: Math.round((failures.length / g.rows.length) * 100),
        baseline_pct: baselinePct,
        top_outcome: top,
      },
    });
  }

  return rules.sort(
    (a, b) => Number(b.severity === 'avoid') - Number(a.severity === 'avoid') || b.evidence.failure_pct - a.evidence.failure_pct,
  );
}

export interface GuardProposal {
  action_kind: NegativeActionKind;
  subject_key: string;
  context: NegativeContext;
}

export interface GuardWarning {
  facet: string;
  severity: RuleSeverity;
  title: string;
  rationale: string;
}

export interface GuardResult {
  decision: 'allow' | RuleSeverity;
  warnings: GuardWarning[];
}

/** Checks a proposed action against active rules. Dismissed rules never fire. */
export function evaluateGuard(proposal: GuardProposal, rules: NegativeRule[]): GuardResult {
  const keys = new Set(facetsFor(proposal.action_kind, proposal.subject_key, proposal.context).map((f) => f.key));
  const warnings: GuardWarning[] = rules
    .filter((r) => r.status === 'active' && keys.has(r.facet))
    .sort((a, b) => Number(b.severity === 'avoid') - Number(a.severity === 'avoid'))
    .map(({ facet, severity, title, rationale }) => ({ facet, severity, title, rationale }));

  const decision: GuardResult['decision'] = warnings.some((w) => w.severity === 'avoid')
    ? 'avoid'
    : warnings.length > 0
      ? 'caution'
      : 'allow';

  return { decision, warnings };
}
