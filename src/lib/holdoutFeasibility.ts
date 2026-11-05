/**
 * Verified Incrementality — Phase 0: feasibility of an always-on randomized holdout.
 *
 * Pure functions only (no I/O, no Supabase) so the same maths can be unit-tested and, in
 * Phase 3, copied to a Deno-shared module. Input rows come from the SQL function
 * `get_holdout_feasibility_inputs()` (tenant) or `holdout_feasibility_core()` (operator).
 *
 * Question answered: "if we withheld h% of eligible actions at random, could an account
 * (or, failing that, a pool of >= K accounts) ever detect a realistic lift?"
 *
 * Outcome modelled: binary "customer books again within 90 days" (same outcome the existing
 * causal ROI layer uses). Its observed variance is p(1-p). Continuous outcomes (revenue)
 * are deliberately deferred to Phase 3.
 */
import { MIN_BINARY_EVENTS, MIN_CELL_N } from '@/lib/opsExperiments';

// alpha = 0.05 two-sided, power = 0.80. opsExperiments keeps these private, so they are
// restated here rather than editing an unrelated module.
export const Z_ALPHA_TWO_SIDED_05 = 1.959963984540054;
export const Z_POWER_80 = 0.8416212335729143;

export const HOLDOUT_RATES = [0.05, 0.1] as const;
export type HoldoutRate = (typeof HOLDOUT_RATES)[number];

/** Minimum contributing accounts before any pooled number may be shown (no tenant leakage). */
export const K_ANONYMITY_MIN_ACCOUNTS = 5;
/** How long a holdout is allowed to accumulate before we judge power. */
export const DEFAULT_HORIZON_MONTHS = 12;
/**
 * "Usable" = can detect a lift of at most 30% of the base rate within the horizon.
 * This is a judgement call, not a statistical law — tune it via FeasibilityOptions.
 */
export const DEFAULT_USABLE_RELATIVE_MDE = 0.3;

/** Provisional allow-list for Phase 0 only; Phase 1 owns the authoritative list. */
export const PHASE0_CANDIDATE_ACTION_TYPES: readonly string[] = ['quote_followup', 'review_request_call'];

export type PopulationSource = 'ai_action_events' | 'outbound_sms';

export interface FeasibilityInputRow {
  accountId: string;
  populationSource: PopulationSource;
  actionType: string;
  /** Actions performed inside the look-back window. */
  nActions: number;
  /** Months the account has been producing this action (>= 1, capped at the window). */
  activeMonths: number;
  /** Actions old enough (>= 90d) and linked to a customer, so the outcome is observable. */
  nMatureResolved: number;
  /** Of those, how many had a repeat booking within 90 days. */
  nMatureRepeat: number;
}

export interface FeasibilityOptions {
  horizonMonths: number;
  usableRelativeMde: number;
  eligibleActionTypes: readonly string[];
  kMinAccounts: number;
}

export const DEFAULT_OPTIONS: FeasibilityOptions = {
  horizonMonths: DEFAULT_HORIZON_MONTHS,
  usableRelativeMde: DEFAULT_USABLE_RELATIVE_MDE,
  eligibleActionTypes: PHASE0_CANDIDATE_ACTION_TYPES,
  kMinAccounts: K_ANONYMITY_MIN_ACCOUNTS,
};

export interface Scenario {
  holdoutRate: HoldoutRate;
  nTreated: number;
  nHoldout: number;
  /** Minimum detectable absolute lift (proportion points, 0.05 = 5pp). Null if not computable. */
  mdeAbs: number | null;
  /** mdeAbs / baseRate. */
  mdeRelative: number | null;
  usable: boolean;
}

export interface RowAssessment {
  accountId: string;
  actionType: string;
  populationSource: PopulationSource;
  eligible: boolean;
  monthlyVolume: number;
  baseRate: number | null;
  /** Share of actions whose outcome could be linked + matured; low = outcome is hard to measure. */
  resolvedShare: number;
  scenarios: Scenario[];
}

const finitePos = (x: number): boolean => Number.isFinite(x) && x > 0;

/** Monthly action volume. Guards against zero / NaN months. */
export function monthlyVolume(nActions: number, activeMonths: number): number {
  if (!Number.isFinite(nActions) || nActions <= 0) return 0;
  return nActions / Math.max(1, Number.isFinite(activeMonths) ? activeMonths : 1);
}

/** Observed outcome base rate on mature, resolvable actions; null when nothing is measurable. */
export function baseRate(nMatureResolved: number, nMatureRepeat: number): number | null {
  if (!finitePos(nMatureResolved)) return null;
  const r = nMatureRepeat / nMatureResolved;
  return Number.isFinite(r) && r >= 0 && r <= 1 ? r : null;
}

/**
 * Minimum detectable absolute difference between two proportions (80% power, alpha 0.05),
 * using the baseline variance p(1-p) for both arms. Null when p is 0/1 (zero variance =>
 * nothing to detect against) or an arm is empty.
 */
export function mdeBinary(p: number, nTreated: number, nHoldout: number): number | null {
  if (!(p > 0 && p < 1) || !finitePos(nTreated) || !finitePos(nHoldout)) return null;
  const se = Math.sqrt(p * (1 - p) * (1 / nTreated + 1 / nHoldout));
  return (Z_ALPHA_TWO_SIDED_05 + Z_POWER_80) * se;
}

/**
 * Closed-form inverse: monthly eligible actions needed so that a holdout of rate h detects a
 * relative lift `relMde` of base rate p within `horizonMonths`. Handy for explaining to an
 * owner "you would need about N actions a month".
 */
export function requiredMonthlyVolume(p: number, h: number, relMde: number, horizonMonths: number): number | null {
  if (!(p > 0 && p < 1) || !(h > 0 && h < 1) || !finitePos(relMde) || !finitePos(horizonMonths)) return null;
  const z = Z_ALPHA_TWO_SIDED_05 + Z_POWER_80;
  const nHoldout = (z * z * (1 - p)) / (relMde * relMde * p * (1 - h));
  return nHoldout / h / horizonMonths;
}

function scenario(p: number | null, monthly: number, h: HoldoutRate, o: FeasibilityOptions): Scenario {
  const total = monthly * o.horizonMonths;
  const nHoldout = total * h;
  const nTreated = total - nHoldout;
  const mdeAbs = p === null ? null : mdeBinary(p, nTreated, nHoldout);
  const mdeRelative = mdeAbs !== null && p !== null && p > 0 ? mdeAbs / p : null;
  // Same sanity floors the existing experiment engine uses before trusting a normal approximation.
  const cellsOk =
    p !== null &&
    nHoldout >= MIN_CELL_N &&
    nHoldout * p >= MIN_BINARY_EVENTS &&
    nHoldout * (1 - p) >= MIN_BINARY_EVENTS;
  const usable = cellsOk && mdeRelative !== null && mdeRelative <= o.usableRelativeMde;
  return { holdoutRate: h, nTreated, nHoldout, mdeAbs, mdeRelative, usable };
}

export function assessRow(row: FeasibilityInputRow, options: Partial<FeasibilityOptions> = {}): RowAssessment {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const monthly = monthlyVolume(row.nActions, row.activeMonths);
  const p = baseRate(row.nMatureResolved, row.nMatureRepeat);
  return {
    accountId: row.accountId,
    actionType: row.actionType,
    populationSource: row.populationSource,
    eligible: o.eligibleActionTypes.includes(row.actionType),
    monthlyVolume: monthly,
    baseRate: p,
    resolvedShare: row.nActions > 0 ? Math.min(1, row.nMatureResolved / row.nActions) : 0,
    scenarios: HOLDOUT_RATES.map((h) => scenario(p, monthly, h, o)),
  };
}

export interface PooledAssessment {
  monthlyVolume: number;
  baseRate: number | null;
  scenarios: Scenario[];
}

export interface ActionTypeReport {
  actionType: string;
  eligible: boolean;
  accountsTotal: number;
  /** Per holdout rate: accounts that reach usable power on their own. */
  accountsUsableAlone: Record<HoldoutRate, number>;
  /** Per holdout rate: accounts NOT usable alone, but the k-anonymous pool is usable. */
  accountsOnlyViaPooling: Record<HoldoutRate, number>;
  /** Null when fewer than kMinAccounts contribute (privacy), so no pooled number is exposed. */
  pooled: PooledAssessment | null;
  poolSuppressedForPrivacy: boolean;
}

export type Verdict = 'viable' | 'viable_pooled_only' | 'not_viable' | 'no_data';

export interface FeasibilityReport {
  options: FeasibilityOptions;
  perAccount: RowAssessment[];
  byActionType: ActionTypeReport[];
  verdict: Verdict;
  /** Plain-language reasons, safe to show to the operator. */
  reasons: string[];
}

function pool(rows: FeasibilityInputRow[], o: FeasibilityOptions): PooledAssessment {
  // Pooled monthly volume = sum of per-account monthly volumes (accounts accumulate in parallel).
  const monthly = rows.reduce((s, r) => s + monthlyVolume(r.nActions, r.activeMonths), 0);
  const resolved = rows.reduce((s, r) => s + r.nMatureResolved, 0);
  const repeat = rows.reduce((s, r) => s + r.nMatureRepeat, 0);
  const p = baseRate(resolved, repeat);
  return { monthlyVolume: monthly, baseRate: p, scenarios: HOLDOUT_RATES.map((h) => scenario(p, monthly, h, o)) };
}

export function buildFeasibilityReport(
  rows: FeasibilityInputRow[],
  options: Partial<FeasibilityOptions> = {},
): FeasibilityReport {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const perAccount = rows.map((r) => assessRow(r, o));
  const types = [...new Set(rows.map((r) => r.actionType))].sort();

  const byActionType: ActionTypeReport[] = types.map((actionType) => {
    const typeRows = rows.filter((r) => r.actionType === actionType);
    const assessed = perAccount.filter((a) => a.actionType === actionType);
    const accounts = new Set(typeRows.map((r) => r.accountId));
    const kOk = accounts.size >= o.kMinAccounts;
    const pooled = kOk ? pool(typeRows, o) : null;

    const alone = { 0.05: 0, 0.1: 0 } as Record<HoldoutRate, number>;
    const viaPool = { 0.05: 0, 0.1: 0 } as Record<HoldoutRate, number>;
    HOLDOUT_RATES.forEach((h, i) => {
      const poolUsable = pooled?.scenarios[i].usable === true;
      for (const a of assessed) {
        if (a.scenarios[i].usable) alone[h] += 1;
        else if (poolUsable) viaPool[h] += 1;
      }
    });

    return {
      actionType,
      eligible: o.eligibleActionTypes.includes(actionType),
      accountsTotal: accounts.size,
      accountsUsableAlone: alone,
      accountsOnlyViaPooling: viaPool,
      pooled,
      poolSuppressedForPrivacy: !kOk,
    };
  });

  const eligible = byActionType.filter((t) => t.eligible);
  const reasons: string[] = [];
  let verdict: Verdict;

  if (eligible.length === 0) {
    verdict = 'no_data';
    reasons.push('No rows for any eligible action type; nothing to assess.');
  } else {
    const anyAlone = eligible.some((t) => t.accountsUsableAlone[0.1] > 0);
    const anyPooled = eligible.some((t) => t.pooled?.scenarios.some((s) => s.usable));
    if (anyAlone) {
      verdict = 'viable';
      reasons.push('At least one account reaches usable power on its own at a 10% holdout.');
    } else if (anyPooled) {
      verdict = 'viable_pooled_only';
      reasons.push('No single account has enough volume; only the k-anonymous pool reaches usable power.');
    } else {
      verdict = 'not_viable';
      reasons.push('No eligible action type reaches usable power, alone or pooled, at 5% or 10% holdout.');
    }
    const lowResolved = perAccount.filter((a) => a.eligible && a.resolvedShare < 0.5).length;
    if (lowResolved > 0) {
      reasons.push(
        `${lowResolved} account/action rows have <50% of actions linked to a measurable, mature outcome; base rates there are unreliable.`,
      );
    }
  }

  return { options: o, perAccount, byActionType, verdict, reasons };
}
