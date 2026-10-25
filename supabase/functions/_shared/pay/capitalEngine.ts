// supabase/functions/_shared/pay/capitalEngine.ts
//
// Indicative PRE-SCREEN for working capital. This is NOT underwriting and NEVER produces an
// approval, an amount offered, a rate or a decision: its only output is "is this business
// ready to SEND an application to the lending partner, and which receivables may be put
// forward". Only the partner decides credit. Every "no" carries specific reason codes so the
// applicant can see exactly why (adverse-action friendly).

import type { PartnerOffer } from "./types.ts";

export interface OpenReceivable {
  invoiceId: string;
  customerRef: string;
  amountCents: number;
  dueDate: string | null;
  issuedAt: string;
  alreadyPledged: boolean;
}

export interface RevenueProfile {
  monthsOfHistory: number;
  trailing12mCents: number;
  trailing3mCents: number;
  monthlyCents: number[];
  paidInvoiceCount12m: number;
  avgDaysToPay: number | null;
  onTimeRate: number | null;
  topCustomerSharePct: number;
  lostDisputes12m: number;
  openDisputes: number;
  openReceivables: OpenReceivable[];
}

export interface PrescreenConfig {
  minMonthsOfHistory: number;
  minTrailing12mCents: number;
  minPaidInvoices12m: number;
  maxLostDisputes12m: number;
  maxOpenDisputes: number;
  /** A shrinking business is not referred: trailing 3m must be ≥ this share of the 12m monthly average × 3. */
  minRecentVsAveragePct: number;
  minReceivableCents: number;
  maxReceivableAgeDays: number;
  /** Max share of the pledged total any single customer may represent. */
  maxCustomerSharePct: number;
  minEligibleReceivablesCents: number;
}

export const DEFAULT_PRESCREEN_CONFIG: PrescreenConfig = {
  minMonthsOfHistory: 6,
  minTrailing12mCents: 6_000_000,       // $60,000 of PAID revenue
  minPaidInvoices12m: 20,
  maxLostDisputes12m: 1,
  maxOpenDisputes: 2,
  minRecentVsAveragePct: 50,
  minReceivableCents: 25_000,           // $250
  maxReceivableAgeDays: 90,
  maxCustomerSharePct: 40,
  minEligibleReceivablesCents: 500_000, // $5,000
};

export type ReasonCode =
  | "insufficient_history" | "insufficient_revenue" | "insufficient_paid_invoices"
  | "recent_revenue_decline" | "lost_disputes" | "open_disputes"
  | "no_eligible_receivables" | "eligible_receivables_too_small";

export const REASON_TEXT: Record<ReasonCode, string> = {
  insufficient_history: "Not enough months of paid-invoice history yet.",
  insufficient_revenue: "Paid revenue over the last 12 months is below the minimum to apply.",
  insufficient_paid_invoices: "Too few paid invoices in the last 12 months.",
  recent_revenue_decline: "Revenue over the last 3 months is well below your 12-month average.",
  lost_disputes: "Too many lost card disputes in the last 12 months.",
  open_disputes: "Too many open card disputes right now.",
  no_eligible_receivables: "You have no unpaid invoices that qualify to be put forward.",
  eligible_receivables_too_small: "Your qualifying unpaid invoices total less than the minimum.",
};

export type PrescreenOutcome = "eligible_to_apply" | "not_yet_eligible";

export interface PrescreenResult {
  outcome: PrescreenOutcome;
  reasons: ReasonCode[];
  eligibleReceivables: OpenReceivable[];
  eligibleReceivablesCents: number;
  excluded: { invoiceId: string; why: "pledged" | "too_small" | "too_old" | "customer_concentration" | "invalid" }[];
  /** Plain-language notice every UI must show beside the result. */
  notice: string;
}

export const PRESCREEN_NOTICE =
  "This is an indicative pre-screen, not an offer, approval or credit decision. Only the lending partner decides, and only after you apply.";

const DAY = 86_400_000;

/** Which unpaid invoices may be put forward (deterministic; largest first; concentration-capped). */
export function selectEligibleReceivables(
  receivables: OpenReceivable[], cfg: PrescreenConfig, now: Date,
): { eligible: OpenReceivable[]; excluded: PrescreenResult["excluded"] } {
  const excluded: PrescreenResult["excluded"] = [];
  const pool: OpenReceivable[] = [];
  for (const r of receivables) {
    const issued = Date.parse(r.issuedAt);
    if (!Number.isSafeInteger(r.amountCents) || r.amountCents <= 0 || Number.isNaN(issued)) { excluded.push({ invoiceId: r.invoiceId, why: "invalid" }); continue; }
    if (r.alreadyPledged) { excluded.push({ invoiceId: r.invoiceId, why: "pledged" }); continue; }
    if (r.amountCents < cfg.minReceivableCents) { excluded.push({ invoiceId: r.invoiceId, why: "too_small" }); continue; }
    if ((now.getTime() - issued) / DAY > cfg.maxReceivableAgeDays) { excluded.push({ invoiceId: r.invoiceId, why: "too_old" }); continue; }
    pool.push(r);
  }
  pool.sort((a, b) => b.amountCents - a.amountCents || a.invoiceId.localeCompare(b.invoiceId));

  // Concentration: cap each customer at maxCustomerSharePct of the final total. Iterate to a fixed point.
  let picked = pool;
  for (let guard = 0; guard < 50; guard++) {
    const total = picked.reduce((s, r) => s + r.amountCents, 0);
    const byCustomer = new Map<string, number>();
    picked.forEach((r) => byCustomer.set(r.customerRef, (byCustomer.get(r.customerRef) ?? 0) + r.amountCents));
    const offender = [...byCustomer.entries()].find(([, c]) => (c * 100) / total > cfg.maxCustomerSharePct && byCustomer.size > 1);
    if (!offender) break;
    // drop that customer's smallest invoice and re-check
    const mine = picked.filter((r) => r.customerRef === offender[0]);
    const drop = mine[mine.length - 1];
    excluded.push({ invoiceId: drop.invoiceId, why: "customer_concentration" });
    picked = picked.filter((r) => r.invoiceId !== drop.invoiceId);
  }
  // A single-customer pool can never satisfy a share cap: refuse it rather than pretend.
  if (new Set(picked.map((r) => r.customerRef)).size === 1 && picked.length > 0 && cfg.maxCustomerSharePct < 100) {
    picked.forEach((r) => excluded.push({ invoiceId: r.invoiceId, why: "customer_concentration" }));
    picked = [];
  }
  return { eligible: picked, excluded };
}

export function prescreenCapital(profile: RevenueProfile, cfg: PrescreenConfig = DEFAULT_PRESCREEN_CONFIG, now: Date = new Date()): PrescreenResult {
  const reasons: ReasonCode[] = [];
  if (profile.monthsOfHistory < cfg.minMonthsOfHistory) reasons.push("insufficient_history");
  if (profile.trailing12mCents < cfg.minTrailing12mCents) reasons.push("insufficient_revenue");
  if (profile.paidInvoiceCount12m < cfg.minPaidInvoices12m) reasons.push("insufficient_paid_invoices");

  // Only judge a decline when there is enough history for a 12-month average to mean something.
  if (profile.monthsOfHistory >= 6 && profile.trailing12mCents > 0) {
    const avg3 = (Math.min(12, profile.monthsOfHistory) > 0 ? profile.trailing12mCents / Math.min(12, profile.monthsOfHistory) : 0) * 3;
    if (profile.trailing3mCents * 100 < avg3 * cfg.minRecentVsAveragePct) reasons.push("recent_revenue_decline");
  }
  if (profile.lostDisputes12m > cfg.maxLostDisputes12m) reasons.push("lost_disputes");
  if (profile.openDisputes > cfg.maxOpenDisputes) reasons.push("open_disputes");

  const { eligible, excluded } = selectEligibleReceivables(profile.openReceivables, cfg, now);
  const eligibleCents = eligible.reduce((s, r) => s + r.amountCents, 0);
  if (eligible.length === 0) reasons.push("no_eligible_receivables");
  else if (eligibleCents < cfg.minEligibleReceivablesCents) reasons.push("eligible_receivables_too_small");

  return {
    outcome: reasons.length === 0 ? "eligible_to_apply" : "not_yet_eligible",
    reasons,
    eligibleReceivables: eligible,
    eligibleReceivablesCents: eligibleCents,
    excluded,
    notice: PRESCREEN_NOTICE,
  };
}

/** Merges staff-set overrides (pay_platform_controls.config.prescreen) over defaults; ignores junk. */
export function resolvePrescreenConfig(raw: unknown): PrescreenConfig {
  const out = { ...DEFAULT_PRESCREEN_CONFIG };
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const key of Object.keys(out) as (keyof PrescreenConfig)[]) {
    const v = src[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = v;
  }
  return out;
}

/** Maps capital_get_revenue_profile() JSON to the engine's shape. */
export function revenueProfileFromRpc(r: Record<string, any>): RevenueProfile {
  const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
  return {
    monthsOfHistory: n(r.months_of_history),
    trailing12mCents: n(r.trailing_12m_cents),
    trailing3mCents: n(r.trailing_3m_cents),
    monthlyCents: Array.isArray(r.monthly_cents) ? r.monthly_cents.map(n) : [],
    paidInvoiceCount12m: n(r.paid_invoice_count_12m),
    avgDaysToPay: r.avg_days_to_pay === null || r.avg_days_to_pay === undefined ? null : n(r.avg_days_to_pay),
    onTimeRate: r.on_time_rate === null || r.on_time_rate === undefined ? null : n(r.on_time_rate),
    topCustomerSharePct: n(r.top_customer_share_pct),
    lostDisputes12m: n(r.lost_disputes_12m),
    openDisputes: n(r.open_disputes),
    openReceivables: (Array.isArray(r.open_receivables) ? r.open_receivables : []).map((x: any) => ({
      invoiceId: String(x.invoice_id), customerRef: String(x.customer_ref), amountCents: n(x.amount_cents),
      dueDate: x.due_date ?? null, issuedAt: String(x.issued_at), alreadyPledged: x.already_pledged === true,
    })),
  };
}

/** An offer may be shown only if every disclosure field is present, consistent and unexpired. */
export function offerIsDisclosable(o: PartnerOffer, now = Date.now()): boolean {
  const ints = [o.offeredAmountCents, o.totalRepaymentCents, o.financeChargeCents, o.termDays, o.estimatedAprBps];
  return ints.every((n) => Number.isSafeInteger(n) && n >= 0) && o.offeredAmountCents > 0 && o.termDays > 0
    && o.totalRepaymentCents - o.offeredAmountCents === o.financeChargeCents
    && typeof o.repaymentDescription === "string" && o.repaymentDescription.trim().length >= 10
    && Date.parse(o.expiresAt) > now && typeof o.externalOfferId === "string" && o.externalOfferId.length > 0;
}
