// Safe randomization for the Causal Dispatch Loop — PURE (only imports the pure indifference-set helper).
//
// WHY: observational dispatch data cannot separate "this technician is good" from "this technician gets easy
// jobs". Randomizing only among technicians the current scoring already treats as interchangeable gives
// unconfounded data at (almost) no cost. Everything here is deterministic given (seed, inputs): the same job
// re-dispatched with the same state makes the same draw, so retries/replays cannot "re-roll" an assignment.
//
// Hard rule: this module only CHOOSES AMONG already-eligible technicians. Time-off, capacity and credential
// gates stay in assign_technician_to_job(); a randomized pick that the DB refuses falls back to the next
// deterministic candidate (see rulesAssign.ts) and is logged as non-randomized.

import { buildIndifferenceSet, DEFAULT_DELTA, type IndifferenceCandidate } from './indifferenceSet.ts';

export const POLICY_VERSION = 'cdl-1';

export interface ExplorationConfig {
  enabled: boolean;
  /** Per-account switch (dispatch_exploration_settings.kill_switch). */
  killSwitch: boolean;
  /** Set by the guardrail monitor; stays set until an owner re-enables. */
  autoDisabled: boolean;
  /** Max share of jobs that may be randomized, in percent (0–25). Also the enrollment probability. */
  budgetPct: number;
  /** Score points below the top that still count as "interchangeable". */
  delta: number;
  /** Max expected FTF loss versus the top pick, in percentage points. */
  maxRegretPct: number;
  /** Max times a technician may receive a non-top (exploration) pick per rolling week. */
  perTechWeeklyCap: number;
}

export const DEFAULT_EXPLORATION_CONFIG: ExplorationConfig = {
  enabled: false,
  killSwitch: false,
  autoDisabled: false,
  budgetPct: 10,
  delta: DEFAULT_DELTA,
  maxRegretPct: 5,
  perTechWeeklyCap: 3,
};

export type FtfVerdict = 'go' | 'review' | 'hold' | 'none' | 'error';

export interface ExplorationJobFlags {
  isEmergency: boolean;
  isVip: boolean;
  slaCritical: boolean;
  /** Verdict for the TOP candidate. 'none' = no autopilot prediction stored; 'error' = lookup failed (fail closed). */
  topVerdict: FtfVerdict;
  /** Verdicts per technician id for set members (missing = 'none'). */
  memberVerdicts?: Record<string, FtfVerdict>;
}

export interface ExplorationState {
  /** Share (0–100) of recent auto decisions with arm='explore'. */
  exploreSharePct: number;
  /** technician id -> non-top exploration picks in the last 7 days. */
  weeklyExposure: Record<string, number>;
}

export interface ExplorationCandidate {
  id: string;
  name: string;
  score: number;
  eligible: boolean;
  /** Clean-completion rate (0–1) used as the FTF proxy; null = unknown => cannot be shown interchangeable. */
  ftfProb: number | null;
  /** Points contributed by each factor (rule_type -> points). Stored so factors can be validated later. */
  factors?: Record<string, number>;
}

export type ExplorationReason =
  | 'explored'            // randomized pick
  | 'not_enrolled'        // in a valid set, but the enrollment draw said "exploit"
  | 'no_candidates'
  | 'disabled'
  | 'kill_switch'
  | 'auto_disabled'
  | 'emergency'
  | 'vip'
  | 'sla_critical'
  | 'verdict_blocked'
  | 'verdict_unavailable'
  | 'set_too_small'
  | 'budget_exhausted'
  | 'gate_fallback'        // randomized pick refused by a DB gate; the next deterministic candidate got the job
  | 'error';

export interface SetMemberLog {
  id: string;
  score: number;
  ftf: number | null;
  /** Probability this member is chosen under the policy that ran (sums to 1 over members). */
  p: number;
  f?: Record<string, number>;
}

export interface IndifferenceSetLog {
  top_id: string | null;
  reason: ExplorationReason;
  /** Enrollment probability that applied (0 when randomization was not possible). */
  q: number;
  k: number;
  delta: number;
  members: SetMemberLog[];
}

export interface ExplorationOutcome {
  /** null only when there were no eligible candidates. */
  chosenId: string | null;
  arm: 'exploit' | 'explore';
  /** True probability of the chosen technician under the running policy. 1 for deterministic picks. */
  propensity: number;
  setSize: number;
  reason: ExplorationReason;
  log: IndifferenceSetLog;
}

/** 53-bit string hash (cyrb53) -> uniform in [0,1). Same result in Deno, browsers and Node. */
export function hashUnit(input: string, salt = 0): number {
  let h1 = 0xdeadbeef ^ salt;
  let h2 = 0x41c6ce57 ^ salt;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)) / 9007199254740992;
}

/** Same words the dispatch plan uses (src/lib/dispatchIntelligence.ts isEmergencyJob) so both agree. */
export function looksLikeEmergency(serviceType: string | null | undefined, tags: string[] | null | undefined): boolean {
  return `${serviceType ?? ''} ${(tags ?? []).join(' ')}`.toLowerCase().includes('emergency');
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function memberLog(c: ExplorationCandidate, p: number): SetMemberLog {
  return { id: c.id, score: c.score, ftf: c.ftfProb, p: round6(p), ...(c.factors ? { f: c.factors } : {}) };
}

function exploit(top: ExplorationCandidate | null, reason: ExplorationReason, cfg: ExplorationConfig, members: ExplorationCandidate[] = []): ExplorationOutcome {
  const k = members.length;
  const logMembers = k > 0 ? members.map((m) => memberLog(m, m.id === top?.id ? 1 : 0)) : top ? [memberLog(top, 1)] : [];
  return {
    chosenId: top?.id ?? null,
    arm: 'exploit',
    propensity: 1,
    setSize: top ? Math.max(1, k) : 0,
    reason,
    log: { top_id: top?.id ?? null, reason, q: 0, k: top ? Math.max(1, k) : 0, delta: cfg.delta, members: logMembers },
  };
}

/**
 * Choose a technician. `ranked` MUST be in the rules engine's own order (best first); the first eligible entry is
 * the deterministic pick and is what "exploit" returns, so switching exploration off changes nothing.
 * Never throws: any internal problem returns the deterministic pick.
 */
export function selectWithExploration(input: {
  /** Stable per decision, e.g. `${accountId}:${jobId}`. */
  seed: string;
  ranked: ExplorationCandidate[];
  job: ExplorationJobFlags;
  config: ExplorationConfig;
  state: ExplorationState;
}): ExplorationOutcome {
  const { seed, ranked, job, config } = input;
  const top = ranked.find((c) => c.eligible) ?? null;
  try {
    if (!top) return exploit(null, 'no_candidates', config);

    // --- hard exclusions: never randomize, regardless of budget ---
    if (config.killSwitch) return exploit(top, 'kill_switch', config);
    if (!config.enabled) return exploit(top, 'disabled', config);
    if (config.autoDisabled) return exploit(top, 'auto_disabled', config);
    if (job.isEmergency) return exploit(top, 'emergency', config);
    if (job.isVip) return exploit(top, 'vip', config);
    if (job.slaCritical) return exploit(top, 'sla_critical', config);
    if (job.topVerdict === 'error') return exploit(top, 'verdict_unavailable', config);
    if (job.topVerdict === 'hold' || job.topVerdict === 'review') return exploit(top, 'verdict_blocked', config);

    const q = clamp(config.budgetPct, 0, 25) / 100;
    if (q <= 0) return exploit(top, 'disabled', config);

    // --- indifference set: score within delta AND FTF no worse than the regret cap (unknown FTF => excluded) ---
    const verdictOk = (id: string) => {
      const v = job.memberVerdicts?.[id] ?? 'none';
      return v === 'go' || v === 'none';
    };
    const pool: IndifferenceCandidate[] = ranked
      .filter((c) => c.eligible && (c.id === top.id || verdictOk(c.id)))
      .map((c) => ({ id: c.id, score: c.score, eligible: true, ftfProb: c.ftfProb }));
    const built = buildIndifferenceSet(pool, { delta: config.delta, ftfEpsilon: clamp(config.maxRegretPct, 0, 100) / 100, topId: top.id });
    const byId = new Map(ranked.map((c) => [c.id, c]));

    // per-technician exposure cap: a technician who already took their share of exploration picks sits out
    const members = built.members
      .map((m) => byId.get(m.id)!)
      .filter((c) => c.id === top.id || (input.state.weeklyExposure[c.id] ?? 0) < config.perTechWeeklyCap);

    if (members.length < 2) return exploit(top, 'set_too_small', config, members);
    if (input.state.exploreSharePct >= config.budgetPct) return exploit(top, 'budget_exhausted', config, members);

    const k = members.length;
    const enrolled = hashUnit(`${seed}|${POLICY_VERSION}|enroll`) < q;
    const pOf = (c: ExplorationCandidate) => q / k + (c.id === top.id ? 1 - q : 0);
    const logMembers = members.map((m) => memberLog(m, pOf(m)));

    let chosen = top;
    if (enrolled) chosen = members[Math.min(k - 1, Math.floor(hashUnit(`${seed}|${POLICY_VERSION}|pick`) * k))];
    const reason: ExplorationReason = enrolled ? 'explored' : 'not_enrolled';
    return {
      chosenId: chosen.id,
      arm: enrolled ? 'explore' : 'exploit',
      propensity: round6(pOf(chosen)),
      setSize: k,
      reason,
      log: { top_id: top.id, reason, q, k, delta: config.delta, members: logMembers },
    };
  } catch {
    return exploit(top, 'error', config);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Guardrail: is exploration hurting first-time-fix?
// ---------------------------------------------------------------------------------------------------------------

export interface GuardrailInput {
  /** FTF outcomes (1 = fixed first time) of MATURE jobs in a valid set that were randomized. */
  explore: number[];
  /** Same, for jobs in a valid set that the enrollment draw left on the deterministic pick. */
  control: number[];
  /** Tolerated FTF drop in percentage points (dispatch_exploration_settings.guardrail_tolerance_pct). */
  tolerancePct: number;
  /** Minimum outcomes per side before any verdict. */
  minPerArm?: number;
}

export interface GuardrailResult {
  status: 'insufficient' | 'ok' | 'watch' | 'breached';
  /** control FTF − explore FTF, percentage points (positive = exploration is worse). */
  dropPp: number | null;
  /** One-sided 95% lower confidence bound of the drop, percentage points. */
  dropLowerPp: number | null;
  nExplore: number;
  nControl: number;
}

/**
 * Comparison is explore vs not-enrolled WITHIN eligible sets: enrollment is a random coin, so the two groups are
 * exchangeable and the difference is causal. 'breached' needs both a drop >= tolerance AND statistical evidence
 * (lower bound > 0) so noise cannot switch a feature off; 'watch' is the early warning.
 */
export function evaluateGuardrail(input: GuardrailInput): GuardrailResult {
  const min = input.minPerArm ?? 30;
  const nE = input.explore.length;
  const nC = input.control.length;
  if (nE < min || nC < min) return { status: 'insufficient', dropPp: null, dropLowerPp: null, nExplore: nE, nControl: nC };
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const varOf = (a: number[], m: number) => a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1);
  const mE = mean(input.explore);
  const mC = mean(input.control);
  const se = Math.sqrt(varOf(input.explore, mE) / nE + varOf(input.control, mC) / nC);
  const drop = (mC - mE) * 100;
  const lower = (mC - mE - 1.6448536269514722 * se) * 100;
  const tol = Math.max(0, input.tolerancePct);
  const status = drop >= tol && lower > 0 ? 'breached' : drop >= tol ? 'watch' : 'ok';
  return { status, dropPp: Math.round(drop * 100) / 100, dropLowerPp: Math.round(lower * 100) / 100, nExplore: nE, nControl: nC };
}
