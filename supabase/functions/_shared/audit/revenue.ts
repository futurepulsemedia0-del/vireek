// supabase/functions/_shared/audit/revenue.ts
//
// Transparent "revenue at risk" estimate. Every input is shown and editable. Defaults mirror the /calculator page
// (50 calls/week, $350 job, 30% close rate) and are flagged as placeholders until the owner changes them.
// With 1-3 test calls the miss rate is a SAMPLE, so the result is a range (80% Wilson interval), never one number.
//
//   missRate   = (1 - afterHoursShare) * openHoursMiss + afterHoursShare * afterHoursMiss
//   recovered  = (share of misses that reached voicemail) * voicemailRecoveryRate
//   lost jobs  = monthlyCalls * newCustomerShare * missRate * (1 - recovered) * jobConversionRate
//   at risk    = lost jobs * avgJobValue

import type { AnswerKind, Assumptions, AssumptionRow, RevenueAtRisk, Range, ScoredCall } from "./types.ts";
import { isConclusive } from "./scoring.ts";

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  monthlyInboundCalls: 217, // 50 calls/week * 52 / 12, same as /calculator
  newCustomerShare: 0.5,
  afterHoursShare: 0.25,
  jobConversionRate: 0.3,
  avgJobValue: 350,
  voicemailRecoveryRate: 0.2,
};

const LIMITS: Record<keyof Assumptions, [number, number]> = {
  monthlyInboundCalls: [0, 20000],
  newCustomerShare: [0, 1],
  afterHoursShare: [0, 1],
  jobConversionRate: [0, 1],
  avgJobValue: [0, 200000],
  voicemailRecoveryRate: [0, 1],
};
const LABELS: Record<keyof Assumptions, [string, AssumptionRow["unit"]]> = {
  monthlyInboundCalls: ["Inbound calls per month", "calls"],
  newCustomerShare: ["Share of calls that are new-job enquiries", "percent"],
  afterHoursShare: ["Share of calls that arrive after hours", "percent"],
  jobConversionRate: ["Share of answered new-job calls that become booked jobs", "percent"],
  avgJobValue: ["Average job value", "usd"],
  voicemailRecoveryRate: ["Share of voicemail callers you win back by calling back", "percent"],
};

/** Accepts untrusted JSON; unknown keys are dropped and values clamped. Returns only the keys the owner actually set. */
export function sanitizeAssumptions(raw: unknown): Partial<Assumptions> {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out: Partial<Assumptions> = {};
  for (const key of Object.keys(LIMITS) as (keyof Assumptions)[]) {
    const v = o[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const [lo, hi] = LIMITS[key];
    out[key] = Math.min(hi, Math.max(lo, key === "monthlyInboundCalls" ? Math.round(v) : v));
  }
  return out;
}

/** 80% two-sided Wilson interval for a (possibly fractional) success count. */
export function wilson(successes: number, n: number, z = 1.2816): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = Math.min(1, Math.max(0, successes / n));
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (c - m) / d), high: Math.min(1, (c + m) / d) };
}

const credit = (k: AnswerKind) => (k === "live_person" || k === "live_ai" ? 1 : k === "ivr" ? 0.5 : 0);
const to10 = (n: number) => Math.round(n / 10) * 10;

export function estimateRevenueAtRisk(calls: ScoredCall[], owner: Partial<Assumptions> = {}): RevenueAtRisk {
  const a: Assumptions = { ...DEFAULT_ASSUMPTIONS, ...sanitizeAssumptions(owner) };
  const good = calls.filter(isConclusive);
  const open = good.filter((c) => c.condition !== "after_hours");
  const ah = good.filter((c) => c.condition === "after_hours");
  const miss = (cs: ScoredCall[]) => cs.reduce((s, c) => s + 1 - credit(c.answer_kind as AnswerKind), 0);

  // When a segment was not tested, borrow the other segment's rate rather than assume 0% or 100%.
  const segOpen = open.length ? open : ah;
  const segAh = ah.length ? ah : open;
  const notes: string[] = [];
  if (good.length === 0) notes.push("No conclusive test call, so no estimate can be made.");
  if (!ah.length && good.length) notes.push("After-hours was not tested, so the open-hours miss rate is used for after-hours calls too.");
  if (good.length && good.length < 3) notes.push(`Based on ${good.length} conclusive call${good.length === 1 ? "" : "s"}. The range is wide on purpose.`);

  const wo = segOpen.length ? { p: miss(segOpen) / segOpen.length, ...wilson(miss(segOpen), segOpen.length) } : { p: 0, low: 0, high: 0 };
  const wa = segAh.length ? { p: miss(segAh) / segAh.length, ...wilson(miss(segAh), segAh.length) } : { p: 0, low: 0, high: 0 };
  const mix = (o: number, h: number) => (1 - a.afterHoursShare) * o + a.afterHoursShare * h;

  const missed = good.filter((c) => credit(c.answer_kind as AnswerKind) < 1);
  const vmShare = missed.length ? missed.filter((c) => c.answer_kind === "voicemail").length / missed.length : 0;
  const recovered = vmShare * a.voicemailRecoveryRate;
  const dollars = (missRate: number) =>
    good.length === 0 ? 0 : a.monthlyInboundCalls * a.newCustomerShare * missRate * (1 - recovered) * a.jobConversionRate * a.avgJobValue;

  const missRate: Range = { low: mix(wo.low, wa.low), point: mix(wo.p, wa.p), high: mix(wo.high, wa.high) };
  const monthly: Range = { low: to10(dollars(missRate.low)), point: to10(dollars(missRate.point)), high: to10(dollars(missRate.high)) };
  const annual: Range = { low: monthly.low * 12, point: monthly.point * 12, high: monthly.high * 12 };

  const ownerKeys = new Set(Object.keys(sanitizeAssumptions(owner)));
  const rows: AssumptionRow[] = (Object.keys(LIMITS) as (keyof Assumptions)[]).map((key) => ({
    key, label: LABELS[key][0], unit: LABELS[key][1], value: a[key], source: ownerKeys.has(key) ? "owner" : "default",
  }));
  return {
    monthly, annual, miss_rate: missRate, sample_size: good.length,
    is_placeholder: rows.some((r) => r.source === "default"), assumptions: rows,
    notes: [...notes, "Estimates are illustrative, not a forecast. Change any number above to match your business."],
  };
}
