// supabase/functions/_shared/pay/ewaEngine.ts
//
// Earned-wage-access availability. PURE: the database returns raw inputs
// (pay_get_ewa_inputs), this decides. Only APPROVED hours / commission count — a pending
// timesheet is never "earned". Everything is integer cents and fails closed (bad input → 0).

import { computeFeeCents, isSafeCents, toCents, type FeeSchedule } from "./money.ts";

export interface EwaInputs {
  active: boolean;
  payType: "hourly" | "salary" | "commission_only" | "salary_plus_commission";
  hourlyRateCents: number;
  annualSalaryCents: number;
  overtimeMultiplier: number;
  payScheduleDays: number;
  elapsedDays: number;
  withholdingPct: number;
  approvedRegularHours: number;
  approvedOvertimeHours: number;
  approvedCommissionCents: number;
  outstandingAdvanceCents: number;
  tenantTransferredTodayCents: number;
}

export interface EwaPolicy extends FeeSchedule {
  maxPctOfAccrued: number;
  maxSingleCents: number;
  maxDailyTenantCents: number;
  /** Smallest advance worth the fee (default $20). */
  minAmountCents?: number;
}

export type EwaReason = "inactive_employee" | "invalid_input" | "nothing_accrued" | "at_limit" | "daily_cap_reached" | "below_minimum";

export interface EwaAvailability {
  accruedGrossCents: number;
  accruedNetEstimateCents: number;
  ceilingCents: number;
  outstandingAdvanceCents: number;
  availableCents: number;
  reasons: EwaReason[];
}

const PERIODS_PER_YEAR = (days: number) => (days <= 7 ? 52 : days <= 14 ? 26 : days <= 15 ? 24 : 12);

export function accruedGrossCents(i: EwaInputs): number {
  const hours = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const mult = Number.isFinite(i.overtimeMultiplier) && i.overtimeMultiplier >= 1 ? i.overtimeMultiplier : 1;
  let wages = 0;
  if (i.payType === "hourly") {
    wages = Math.round(i.hourlyRateCents * hours(i.approvedRegularHours)) + Math.round(i.hourlyRateCents * mult * hours(i.approvedOvertimeHours));
  } else if (i.payType === "salary" || i.payType === "salary_plus_commission") {
    const perPeriod = i.annualSalaryCents / PERIODS_PER_YEAR(i.payScheduleDays);
    const fraction = Math.min(1, Math.max(0, i.elapsedDays) / Math.max(1, i.payScheduleDays));
    wages = Math.floor(perPeriod * fraction);
  }
  return wages + toCents(i.approvedCommissionCents);
}

export function computeEwaAvailability(i: EwaInputs, p: EwaPolicy): EwaAvailability {
  const reasons: EwaReason[] = [];
  const zero = (extra: EwaReason): EwaAvailability => ({
    accruedGrossCents: 0, accruedNetEstimateCents: 0, ceilingCents: 0,
    outstandingAdvanceCents: toCents(i.outstandingAdvanceCents), availableCents: 0, reasons: [...reasons, extra],
  });

  if (!i.active) return zero("inactive_employee");
  const numeric = [i.hourlyRateCents, i.annualSalaryCents, i.approvedCommissionCents, i.outstandingAdvanceCents, i.withholdingPct, i.payScheduleDays];
  if (numeric.some((n) => !Number.isFinite(n) || n < 0)) return zero("invalid_input");

  const gross = accruedGrossCents(i);
  if (gross <= 0) return zero("nothing_accrued");

  const withholding = Math.min(100, Math.max(0, i.withholdingPct));
  const net = Math.floor((gross * (100 - withholding)) / 100);
  const pct = Math.min(100, Math.max(0, p.maxPctOfAccrued));
  const ceiling = Math.floor((net * pct) / 100);
  const outstanding = toCents(i.outstandingAdvanceCents);

  const headroom = Math.max(0, ceiling - outstanding);
  const dailyLeft = Math.max(0, toCents(p.maxDailyTenantCents) - toCents(i.tenantTransferredTodayCents));
  let available = Math.min(headroom, toCents(p.maxSingleCents), dailyLeft);

  if (headroom === 0) reasons.push("at_limit");
  if (dailyLeft === 0) reasons.push("daily_cap_reached");
  if (available < (p.minAmountCents ?? 2000)) {
    if (available > 0) reasons.push("below_minimum");
    available = 0;
  }
  return { accruedGrossCents: gross, accruedNetEstimateCents: net, ceilingCents: ceiling, outstandingAdvanceCents: outstanding, availableCents: available, reasons };
}

export type TransferValidation =
  | { ok: true; amountCents: number; feeCents: number; receiveCents: number; repayCents: number }
  | { ok: false; code: "invalid_amount" | "exceeds_available" | "fee_exceeds_amount" | "below_minimum" };

/** Validates a requested EWA amount against availability and quotes the exact fee. */
export function validateAdvanceRequest(amountCents: unknown, availableCents: number, p: EwaPolicy): TransferValidation {
  if (!isSafeCents(amountCents) || amountCents <= 0) return { ok: false, code: "invalid_amount" };
  if (amountCents < (p.minAmountCents ?? 2000)) return { ok: false, code: "below_minimum" };
  if (amountCents > availableCents) return { ok: false, code: "exceeds_available" };
  const fee = computeFeeCents(amountCents, p);
  if (fee >= amountCents) return { ok: false, code: "fee_exceeds_amount" };
  return { ok: true, amountCents, feeCents: fee, receiveCents: amountCents - fee, repayCents: amountCents };
}

/** Instant payout of an approved pay-run item: all-or-nothing, nothing to repay. */
export function quoteInstantPayout(netPayCents: number, p: EwaPolicy): TransferValidation {
  if (!isSafeCents(netPayCents) || netPayCents <= 0) return { ok: false, code: "invalid_amount" };
  if (netPayCents > toCents(p.maxSingleCents)) return { ok: false, code: "exceeds_available" };
  const fee = computeFeeCents(netPayCents, p);
  if (fee >= netPayCents) return { ok: false, code: "fee_exceeds_amount" };
  return { ok: true, amountCents: netPayCents, feeCents: fee, receiveCents: netPayCents - fee, repayCents: 0 };
}

/** Maps the snake_case RPC payload to engine inputs (all coercions in one place). */
export function ewaInputsFromRpc(r: Record<string, unknown>): EwaInputs {
  const num = (k: string) => Number(r[k] ?? 0);
  return {
    active: r.active === true,
    payType: (r.pay_type as EwaInputs["payType"]) ?? "hourly",
    hourlyRateCents: num("hourly_rate_cents"),
    annualSalaryCents: num("annual_salary_cents"),
    overtimeMultiplier: num("overtime_multiplier") || 1.5,
    payScheduleDays: num("period_days") || 14,
    elapsedDays: num("elapsed_days"),
    withholdingPct: num("withholding_pct"),
    approvedRegularHours: num("approved_regular_hours"),
    approvedOvertimeHours: num("approved_overtime_hours"),
    approvedCommissionCents: num("approved_commission_cents"),
    outstandingAdvanceCents: num("outstanding_advance_cents"),
    tenantTransferredTodayCents: num("tenant_transferred_today_cents"),
  };
}
