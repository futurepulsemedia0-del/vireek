// Indifference set — PURE (no I/O, no imports), same convention as rulesEngine.ts so the edge function,
// the browser and tests share one definition.
//
// WHY: randomizing dispatch is only ethical and cheap where it does not matter. The "indifference set" is
// the group of already-eligible technicians that the current scoring cannot meaningfully tell apart from the
// top pick. Phase 0 only MEASURES how often such a set exists; nothing here changes who gets a job.

export interface IndifferenceCandidate {
  id: string;
  /** Rules-engine score (rankTechnicians). Higher is better. */
  score: number;
  /** True only if every `require` rule passed (RankedTechnician.eligible). Ineligible techs never enter a set. */
  eligible: boolean;
  /** Predicted first-time-fix probability, 0–1. Optional: only needed when ftfEpsilon is set. */
  ftfProb?: number | null;
  /** Upper bound (e.g. conformal p90) of predicted duration in minutes. Optional: only needed when durationEpsilonMinutes is set. */
  durationUpper?: number | null;
}

export interface IndifferenceOptions {
  /** Max score points below the top pick. Default 3. */
  delta?: number;
  /** Max FTF-probability shortfall vs the top pick (0–1 scale). Undefined = FTF check off. */
  ftfEpsilon?: number;
  /** Max extra minutes of duration upper bound vs the top pick. Undefined = duration check off. */
  durationEpsilonMinutes?: number;
  /**
   * Force this eligible candidate to be the anchor ("top"). Used so the set is anchored on the engine's own
   * deterministic pick (which breaks score ties by load) and exploitation stays identical to today's behaviour.
   */
  topId?: string;
}

export const DEFAULT_DELTA = 3;
/** Share of decisions with set size >= 2 below which the randomization idea is not worth pursuing. */
export const VIABILITY_THRESHOLD = 0.1;

// Scores are rounded to 0.1, so a tiny tolerance keeps "exactly delta below" inside the set despite float noise.
const EPS = 1e-9;

export interface IndifferenceSet {
  /** Best eligible candidate (highest score, ties by id for determinism); null when nobody is eligible. */
  top: IndifferenceCandidate | null;
  /** Top first, then the rest sorted by score desc / id asc. Empty when nobody is eligible. */
  members: IndifferenceCandidate[];
  size: number;
}

function validate(opts: IndifferenceOptions): { delta: number; ftfEps: number | null; durEps: number | null } {
  const delta = opts.delta ?? DEFAULT_DELTA;
  if (!Number.isFinite(delta) || delta < 0) throw new RangeError('delta must be a finite number >= 0');
  const check = (v: number | undefined, name: string) => {
    if (v === undefined) return null;
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`${name} must be a finite number >= 0`);
    return v;
  };
  return { delta, ftfEps: check(opts.ftfEpsilon, 'ftfEpsilon'), durEps: check(opts.durationEpsilonMinutes, 'durationEpsilonMinutes') };
}

const byScoreThenId = (a: IndifferenceCandidate, b: IndifferenceCandidate) => b.score - a.score || a.id.localeCompare(b.id);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Eligible candidates within `delta` points of the top AND not worse than the top on FTF / duration by more than
 * epsilon. If a check is enabled but a candidate's (or the top's) value is missing, the candidate is NOT admitted:
 * we only treat people as interchangeable when we can show it.
 */
export function buildIndifferenceSet(candidates: IndifferenceCandidate[], opts: IndifferenceOptions = {}): IndifferenceSet {
  const { delta, ftfEps, durEps } = validate(opts);
  const eligible = candidates.filter((c) => c.eligible && isNum(c.score)).sort(byScoreThenId);
  const forced = opts.topId !== undefined ? eligible.find((c) => c.id === opts.topId) : undefined;
  const top = forced ?? eligible[0] ?? null;
  if (!top) return { top: null, members: [], size: 0 };

  const rest = eligible.filter((c) => c !== top).filter((c) => {
    if (top.score - c.score > delta + EPS) return false;
    if (ftfEps !== null) {
      if (!isNum(c.ftfProb) || !isNum(top.ftfProb)) return false;
      if (top.ftfProb - c.ftfProb > ftfEps + EPS) return false;
    }
    if (durEps !== null) {
      if (!isNum(c.durationUpper) || !isNum(top.durationUpper)) return false;
      if (c.durationUpper - top.durationUpper > durEps + EPS) return false;
    }
    return true;
  });
  const members = [top, ...rest];
  return { top, members, size: members.length };
}

export interface FeasibilityReport {
  /** Decisions passed in. */
  decisions: number;
  /** Decisions with at least one eligible technician (the denominator for the percentages). */
  withEligible: number;
  /** Set size -> number of decisions. Sizes are exact; 0 = nobody eligible. */
  sizeDistribution: Record<number, number>;
  /** Decisions with set size >= 2. */
  qualifying: number;
  /** qualifying / withEligible, 0–1; null when withEligible = 0. */
  qualifyingShare: number | null;
  /** null when there is no data; otherwise qualifyingShare >= VIABILITY_THRESHOLD. */
  viable: boolean | null;
  delta: number;
}

export function summarizeFeasibility(decisions: IndifferenceCandidate[][], opts: IndifferenceOptions = {}): FeasibilityReport {
  const { delta } = validate(opts);
  const sizeDistribution: Record<number, number> = {};
  let withEligible = 0;
  let qualifying = 0;
  for (const cands of decisions) {
    const { size } = buildIndifferenceSet(cands, opts);
    sizeDistribution[size] = (sizeDistribution[size] ?? 0) + 1;
    if (size >= 1) withEligible += 1;
    if (size >= 2) qualifying += 1;
  }
  const qualifyingShare = withEligible > 0 ? qualifying / withEligible : null;
  return {
    decisions: decisions.length,
    withEligible,
    sizeDistribution,
    qualifying,
    qualifyingShare,
    viable: qualifyingShare === null ? null : qualifyingShare >= VIABILITY_THRESHOLD,
    delta,
  };
}

/** Read the candidate list that snapshotForAudit() stores in dispatch_decisions.explanation.candidates. */
export function candidatesFromExplanation(explanation: unknown): IndifferenceCandidate[] {
  const list = (explanation as { candidates?: unknown } | null | undefined)?.candidates;
  if (!Array.isArray(list)) return [];
  return list.flatMap((c: Record<string, unknown>) =>
    c && typeof c.technician_id === 'string' && typeof c.score === 'number'
      ? [{ id: c.technician_id, score: c.score, eligible: c.eligible === true }]
      : [],
  );
}
