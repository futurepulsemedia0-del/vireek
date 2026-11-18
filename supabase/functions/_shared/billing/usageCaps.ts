// supabase/functions/_shared/billing/usageCaps.ts
//
// Plan-minute thresholds. Pure. Customer-facing contract (pricing page): minutes past the allowance are billed as overage -
// a call is NEVER dropped for crossing the allowance, and emergencies are never limited for any reason here.
// Levels: ok < 80 <= warn_80 < 100 <= over_100 (overage is accruing). `hard_stop` exists only when an explicit hard ceiling
// (multiple of the allowance) is configured by staff; it restricts NON-emergency calls only.

export type CapLevel = "ok" | "warn_80" | "over_100" | "hard_stop";
export interface CapInput { usedMinutes: number; includedMinutes: number; hardCeilingMultiple?: number | null; isEmergency: boolean }
export interface CapDecision { level: CapLevel; pct: number | null; allowCall: boolean; overageMinutes: number; reason: string }

export function evaluateMinuteCap(i: CapInput): CapDecision {
  const used = Number.isFinite(i.usedMinutes) && i.usedMinutes > 0 ? i.usedMinutes : 0;
  const inc = Number.isFinite(i.includedMinutes) && i.includedMinutes > 0 ? i.includedMinutes : 0;
  if (inc === 0) return { level: "ok", pct: null, allowCall: true, overageMinutes: 0, reason: "no_allowance_configured" };
  const pct = (used / inc) * 100;
  const overageMinutes = Math.max(0, Math.ceil(used - inc));
  let level: CapLevel = pct >= 100 ? "over_100" : pct >= 80 ? "warn_80" : "ok";
  const ceiling = i.hardCeilingMultiple && i.hardCeilingMultiple > 1 ? i.hardCeilingMultiple : null;
  if (ceiling && pct >= ceiling * 100) level = "hard_stop";
  if (i.isEmergency) return { level, pct, allowCall: true, overageMinutes, reason: "emergency_never_restricted" };
  return { level, pct, allowCall: level !== "hard_stop", overageMinutes, reason: level };
}

/** One notification per account, per threshold, per billing month (idempotent; the old alert fired once ever). */
export const usageAlertKey = (accountId: string, level: "warn_80" | "over_100", monthIso: string) => `usage:${level}:${accountId}:${monthIso.slice(0, 7)}`;
export const alertLevelFor = (d: CapDecision): "warn_80" | "over_100" | null => (d.level === "warn_80" ? "warn_80" : d.level === "over_100" || d.level === "hard_stop" ? "over_100" : null);

/** Overage the customer will be billed for: whole minutes past the allowance x the plan's per-minute rate (cents). */
export function overageChargeCents(usedMinutes: number, includedMinutes: number, centsPerMin: number): number {
  if (!(centsPerMin > 0) || !(includedMinutes > 0)) return 0;
  return Math.max(0, Math.ceil(usedMinutes - includedMinutes)) * Math.round(centsPerMin);
}
