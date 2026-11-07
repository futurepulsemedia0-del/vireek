// Results Plan — charge pricing, caps and guarantee (pure, no I/O).
// There are NO built-in prices: every amount comes from an owner-approved terms row. Tests use fake numbers.

export type PricingModel = 'hybrid' | 'per_job';

export interface PricingTerms {
  model: PricingModel;
  /** Monthly platform fee in cents (hybrid). Billed by the subscription, not by this module. */
  baseFeeCents: number;
  /** Default price per verified job, cents. */
  perJobCents: number;
  /** Optional per job-type price overrides (service call vs install...). Keys are lowercase. */
  tierPriceCents: Record<string, number>;
  /** per_job only: minimum monthly charge, cents (0 = none). */
  monthlyFloorCents: number;
  /** Hard monthly cap on per-job charges, cents (null = none). */
  monthlyCapCents: number | null;
  /** Never let (base fee + job charges) exceed this account's Flat plan price (null = off). */
  neverExceedFlatCents: number | null;
  /** First-30-day guarantee: during the window only per-job charges apply, capped by guaranteeCapCents. */
  guaranteeDays: number;
  guaranteeCapCents: number | null;
}

export interface MonthState {
  /** Per-job charges already priced this calendar month, cents. */
  chargedCents: number;
  /** Account start (opt-in) time, ISO. */
  startedAt: string;
}

export interface ChargeDecision {
  amountCents: number;
  listPriceCents: number;
  /** Cents waived because a cap bound the charge. */
  waivedCents: number;
  boundBy: 'none' | 'monthly_cap' | 'flat_plan_cap' | 'guarantee_cap';
}

const DAY_MS = 86_400_000;

export function validateTerms(t: PricingTerms): string[] {
  const e: string[] = [];
  const nonNeg = (n: number) => Number.isInteger(n) && n >= 0 && n <= 100_000_000;
  if (!nonNeg(t.baseFeeCents)) e.push('baseFeeCents');
  if (!nonNeg(t.perJobCents) || t.perJobCents === 0) e.push('perJobCents');
  if (!nonNeg(t.monthlyFloorCents)) e.push('monthlyFloorCents');
  for (const [k, v] of Object.entries(t.tierPriceCents)) if (!nonNeg(v) || v === 0 || k !== k.toLowerCase()) e.push(`tier:${k}`);
  if (t.monthlyCapCents !== null && (!nonNeg(t.monthlyCapCents) || t.monthlyCapCents === 0)) e.push('monthlyCapCents');
  if (t.neverExceedFlatCents !== null && (!nonNeg(t.neverExceedFlatCents) || t.neverExceedFlatCents === 0)) e.push('neverExceedFlatCents');
  if (!Number.isInteger(t.guaranteeDays) || t.guaranteeDays < 0 || t.guaranteeDays > 90) e.push('guaranteeDays');
  if (t.guaranteeCapCents !== null && (!nonNeg(t.guaranteeCapCents) || t.guaranteeCapCents === 0)) e.push('guaranteeCapCents');
  if (t.model === 'per_job' && t.baseFeeCents !== 0) e.push('per_job_has_base_fee');
  if (t.model === 'hybrid' && t.monthlyFloorCents !== 0) e.push('hybrid_has_floor');
  if (t.monthlyCapCents !== null && t.monthlyFloorCents > t.monthlyCapCents) e.push('floor_above_cap');
  return e;
}

/** Stricter check used when STAFF APPROVE terms: a hard monthly cap is mandatory (accounts without a flat plan would otherwise be uncapped). */
export function validateForApproval(t: PricingTerms): string[] {
  const e = validateTerms(t);
  if (t.monthlyCapCents === null) e.push('cap_required');
  if (t.guaranteeDays > 0 && t.guaranteeCapCents === null) e.push('guarantee_cap_required');
  return e;
}

/** Fair-use minutes: 0 below 80%, 80 from 80%, 100 from 100% of the allowance. */
export function fairUseLevel(usedMinutes: number, limit: number | null): 0 | 80 | 100 {
  if (limit === null || limit <= 0 || !Number.isFinite(usedMinutes) || usedMinutes < 0) return 0;
  const pct = (usedMinutes / limit) * 100;
  return pct >= 100 ? 100 : pct >= 80 ? 80 : 0;
}

export function listPriceCents(t: PricingTerms, jobType: string | null): number {
  const key = (jobType ?? '').trim().toLowerCase();
  return (key && t.tierPriceCents[key]) || t.perJobCents;
}

export function inGuarantee(t: PricingTerms, state: MonthState, at: string): boolean {
  if (t.guaranteeDays <= 0) return false;
  const start = Date.parse(state.startedAt);
  const now = Date.parse(at);
  if (Number.isNaN(start) || Number.isNaN(now)) return false;
  return now >= start && now - start < t.guaranteeDays * DAY_MS;
}

/** Price the NEXT verified job, applying every cap. Deterministic; call jobs in chronological order. */
export function priceNextJob(t: PricingTerms, state: MonthState, jobType: string | null, at: string): ChargeDecision {
  const list = listPriceCents(t, jobType);
  let allowed = list;
  let boundBy: ChargeDecision['boundBy'] = 'none';
  const bind = (room: number, by: ChargeDecision['boundBy']) => {
    const r = Math.max(0, room);
    if (r < allowed) {
      allowed = r;
      boundBy = by;
    }
  };
  if (t.monthlyCapCents !== null) bind(t.monthlyCapCents - state.chargedCents, 'monthly_cap');
  if (t.neverExceedFlatCents !== null) bind(t.neverExceedFlatCents - t.baseFeeCents - state.chargedCents, 'flat_plan_cap');
  if (t.guaranteeCapCents !== null && inGuarantee(t, state, at)) bind(t.guaranteeCapCents - state.chargedCents, 'guarantee_cap');
  return { amountCents: allowed, listPriceCents: list, waivedCents: list - allowed, boundBy };
}

/** Monthly total the owner pays: base fee + per-job charges (+ floor top-up for per_job). */
export function monthlyTotalCents(t: PricingTerms, jobChargesCents: number): number {
  const jobs = Math.max(jobChargesCents, t.model === 'per_job' ? t.monthlyFloorCents : 0);
  return t.baseFeeCents + jobs;
}

/** Cap alert thresholds crossed (50/80/100) given spend vs the effective monthly ceiling. */
export function capAlertPct(spentCents: number, ceilingCents: number | null): 0 | 50 | 80 | 100 {
  if (ceilingCents === null || ceilingCents <= 0) return 0;
  const pct = (spentCents / ceilingCents) * 100;
  return pct >= 100 ? 100 : pct >= 80 ? 80 : pct >= 50 ? 50 : 0;
}

export function effectiveCeilingCents(t: PricingTerms): number | null {
  const cands: number[] = [];
  if (t.monthlyCapCents !== null) cands.push(t.monthlyCapCents);
  if (t.neverExceedFlatCents !== null) cands.push(Math.max(0, t.neverExceedFlatCents - t.baseFeeCents));
  return cands.length ? Math.min(...cands) : null;
}

export interface FlatComparison {
  resultsCents: number;
  flatCents: number;
  savingsCents: number;
  cheaper: 'results' | 'flat' | 'equal';
}

/** Cost-vs-flat calculator over the owner's REAL history: one entry per past month. */
export function compareWithFlat(t: PricingTerms, flatMonthlyCents: number, monthlyJobs: Array<{ jobTypes: Array<string | null> }>, startedAt: string): FlatComparison[] {
  return monthlyJobs.map((m) => {
    let charged = 0;
    for (const jt of m.jobTypes) charged += priceNextJob(t, { chargedCents: charged, startedAt }, jt, startedAt).amountCents;
    const results = monthlyTotalCents(t, charged);
    return { resultsCents: results, flatCents: flatMonthlyCents, savingsCents: flatMonthlyCents - results, cheaper: results < flatMonthlyCents ? 'results' : results > flatMonthlyCents ? 'flat' : 'equal' };
  });
}
