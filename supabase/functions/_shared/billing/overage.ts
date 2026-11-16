// supabase/functions/_shared/billing/overage.ts
//
// Overage invoicing for renewal invoices.
//
// Flow (verified against Stripe docs): when a subscription renews Stripe sends `invoice.created`
// with billing_reason = "subscription_cycle" and status = "draft"; the invoice stays editable for
// about an hour (longer while our webhook keeps failing). `invoice.period_start/period_end` of a
// subscription invoice look back ONE period, i.e. they describe the period that just closed.
//
// This module holds only pure functions plus an orchestration function whose I/O is injected
// (`OverageDeps`), so Vitest exercises the exact production logic with in-memory fakes.
// No Deno globals, no Stripe/Supabase imports.
//
// Duplicate protection has three independent layers:
//   1. billing_events claim (webhook level, existing)
//   2. usage_periods UNIQUE (user_id, period_key) + period_rollover() idempotency (DB level)
//   3. Stripe idempotency key + a lookup of invoice items already on the invoice (Stripe level,
//      works even after the 24h idempotency-key lifetime)

import { minutesForPlan, overageCentsPerMinute, planRank } from "./planCatalog.ts";

/** Hard ceiling: anything above this is treated as corrupt data and sent to staff review, not charged. */
export const MAX_BILLABLE_OVERAGE_MINUTES = 100_000;
export const OVERAGE_METADATA_KEY = "vireek_overage_key";
const OVERAGE_CURRENCY = "usd";

export type BillingStatus =
  | "pending"
  | "billed"
  | "skipped_zero"
  | "skipped_policy"
  | "skipped_no_rate"
  | "skipped_currency"
  | "needs_review"
  | "failed";

export interface InvoiceLike {
  id: string;
  billing_reason?: string | null;
  status?: string | null;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  currency?: string | null;
  period_start?: number | null;
  period_end?: number | null;
  /** Stripe sends the first lines inline; used only to learn which plan the NEW period runs on. */
  lines?: { data?: { price?: { id?: string | null } | null }[] | null } | null;
}

export interface InvoiceItemLike {
  id: string;
  metadata?: Record<string, string> | null;
}

export interface InvoiceItemParams {
  customer: string;
  invoice: string;
  amount: number;
  currency: string;
  description: string;
  metadata: Record<string, string>;
  period: { start: number; end: number };
}

export interface OverageProfile {
  id: string;
  plan: string | null;
  /** Plan that was in force for the running period (profiles.usage_period_plan). */
  usage_period_plan?: string | null;
}

export interface RolloverArgs {
  p_user: string;
  p_period_key: string;
  p_period_start: string;
  p_period_end: string;
  p_plan_id: string | null;
  p_rate_cents: number | null;
  p_currency: string | null;
  /** Only set when the closing plan differs from profiles.plan (renewal-boundary downgrade race). */
  p_included_override: number | null;
  /** Plan the new period starts on, read from the Stripe invoice lines. */
  p_next_plan: string | null;
}

export interface UsagePeriodRow {
  user_id: string;
  period_key: string;
  billing_status: BillingStatus;
  overage_minutes: number;
  rate_cents: number | null;
  amount_cents: number;
  stripe_invoice_item_id: string | null;
}

export interface SetBillingArgs {
  p_user: string;
  p_period_key: string;
  p_status: "billed" | "needs_review" | "failed";
  p_invoice_id: string | null;
  p_item_id: string | null;
  p_error: string | null;
}

export interface OverageDeps {
  findProfilesByCustomer(customerId: string): Promise<OverageProfile[]>;
  retrieveInvoice(invoiceId: string): Promise<InvoiceLike>;
  listInvoiceItems(invoiceId: string): Promise<InvoiceItemLike[]>;
  createInvoiceItem(params: InvoiceItemParams, idempotencyKey: string): Promise<{ id: string }>;
  /** Maps a Stripe price id to a plan id using the configured secrets. */
  planFromPriceId(priceId: string): string | null;
  /** Records which plan the running period is on (profiles.usage_period_plan). */
  setPeriodPlan(userId: string, plan: string): Promise<void>;
  rollover(args: RolloverArgs): Promise<UsagePeriodRow>;
  setBilling(args: SetBillingArgs): Promise<UsagePeriodRow | null>;
  log(event: string, detail: Record<string, unknown>): void;
}

export type OverageOutcome =
  | { outcome: "ignored"; reason: "not_renewal_draft" | "no_customer" | "no_period" | "no_profile" | "ambiguous_profile" | "no_plan" }
  | { outcome: "snapshot_recorded"; plan: string }
  | { outcome: "skipped"; status: BillingStatus }
  | { outcome: "billed"; itemId: string; amountCents: number; reusedExistingItem: boolean }
  | { outcome: "needs_review"; reason: string };

// ---------------------------------------------------------------------------------------- pure helpers

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id ?? null;
}

/** True only for the draft invoice a subscription renewal just produced. */
export function isRenewalDraftInvoice(invoice: Pick<InvoiceLike, "billing_reason" | "status">): boolean {
  return invoice.billing_reason === "subscription_cycle" && invoice.status === "draft";
}

/** Stable key of the period that just closed (derived from the invoice, so identical on every retry). */
export function periodFromInvoice(
  invoice: Pick<InvoiceLike, "subscription" | "period_start" | "period_end">,
): { key: string; start: number; end: number; startIso: string; endIso: string } | null {
  const { period_start: start, period_end: end } = invoice;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if ((start as number) <= 0 || (end as number) <= (start as number)) return null;
  const subscriptionId = idOf(invoice.subscription) ?? "nosub";
  return {
    key: `${subscriptionId}:${end}`,
    start: start as number,
    end: end as number,
    startIso: new Date((start as number) * 1000).toISOString(),
    endIso: new Date((end as number) * 1000).toISOString(),
  };
}

/**
 * Plan the CLOSING period must be priced on. Always the higher-ranked of the plan recorded for the
 * running period and the current profile plan: a customer is never billed against a lower allowance or a
 * higher rate than the best plan they were on (covers both the renewal-boundary downgrade race and
 * mid-period upgrades). Unknown plans fall back to the current plan.
 */
export function resolveClosingPlan(snapshot: string | null | undefined, current: string | null | undefined): string | null {
  if (!snapshot) return current ?? null;
  if (!current) return snapshot;
  if (planRank(snapshot) < 0 || planRank(current) < 0) return current;
  return planRank(snapshot) > planRank(current) ? snapshot : current;
}

/** Plan of the subscription line on an invoice (the plan the period that STARTS now runs on). */
export function planFromInvoiceLines(invoice: Pick<InvoiceLike, "lines">, planFromPriceId: (id: string) => string | null): string | null {
  for (const line of invoice.lines?.data ?? []) {
    const priceId = line.price?.id;
    if (!priceId) continue;
    const plan = planFromPriceId(priceId);
    if (plan) return plan;
  }
  return null;
}

export function overageIdempotencyKey(userId: string, periodKey: string): string {
  return `overage:${userId}:${periodKey}`;
}

/** Billable minutes x rate, in cents. Partial minutes round UP; invalid input throws instead of charging. */
export function overageAmountCents(minutes: number, rateCents: number): number {
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError("minutes must be a non-negative finite number");
  if (!Number.isInteger(rateCents) || rateCents < 0) throw new RangeError("rateCents must be a non-negative integer");
  const whole = Math.ceil(minutes);
  if (whole > MAX_BILLABLE_OVERAGE_MINUTES) throw new RangeError("overage minutes exceed the safety ceiling");
  return whole * rateCents;
}

export function formatRateUsd(rateCents: number): string {
  return `$${(rateCents / 100).toFixed(2)}`;
}

export function overageDescription(minutes: number, rateCents: number): string {
  return `Voice overage: ${Math.ceil(minutes)} min x ${formatRateUsd(rateCents)}`;
}

// ------------------------------------------------------------------------------------- orchestration

/**
 * Closes the previous period for the invoice's customer and, when policy and data allow, attaches ONE
 * overage invoice item to the still-draft renewal invoice. Safe to call any number of times for the
 * same invoice. Throws on transient failures (Stripe/DB) so the webhook returns 500 and Stripe retries.
 */
export async function processOverageInvoice(invoice: InvoiceLike, deps: OverageDeps): Promise<OverageOutcome> {
  // A brand-new subscription: remember the plan its first period runs on (no overage can exist yet).
  if (invoice.billing_reason === "subscription_create") return await recordNewSubscriptionPlan(invoice, deps);

  if (!isRenewalDraftInvoice(invoice)) return { outcome: "ignored", reason: "not_renewal_draft" };

  const customerId = idOf(invoice.customer);
  if (!customerId) return { outcome: "ignored", reason: "no_customer" };

  const period = periodFromInvoice(invoice);
  if (!period) return { outcome: "ignored", reason: "no_period" };

  const profiles = await deps.findProfilesByCustomer(customerId);
  if (profiles.length === 0) {
    deps.log("overage_no_profile", { invoice: invoice.id });
    return { outcome: "ignored", reason: "no_profile" };
  }
  if (profiles.length > 1) {
    deps.log("overage_ambiguous_profile", { invoice: invoice.id, matches: profiles.length });
    return { outcome: "ignored", reason: "ambiguous_profile" };
  }
  const profile = profiles[0];

  const currency = (invoice.currency ?? "").toLowerCase();
  const closingPlan = resolveClosingPlan(profile.usage_period_plan, profile.plan);
  // Custom allowances (results plan, enterprise) live in profiles.minutes_included: only override it
  // when the closing plan really differs from the current one.
  const includedOverride = closingPlan !== null && closingPlan !== profile.plan ? minutesForPlan(closingPlan) : null;
  const row = await deps.rollover({
    p_user: profile.id,
    p_period_key: period.key,
    p_period_start: period.startIso,
    p_period_end: period.endIso,
    p_plan_id: closingPlan,
    p_rate_cents: overageCentsPerMinute(closingPlan),
    p_currency: currency || null,
    p_included_override: includedOverride,
    p_next_plan: planFromInvoiceLines(invoice, (id) => deps.planFromPriceId(id)),
  });

  if (row.billing_status === "billed") {
    return { outcome: "billed", itemId: row.stripe_invoice_item_id ?? "", amountCents: Number(row.amount_cents), reusedExistingItem: true };
  }
  if (row.billing_status !== "pending" && row.billing_status !== "failed") {
    return row.billing_status === "needs_review"
      ? { outcome: "needs_review", reason: "previously_flagged" }
      : { outcome: "skipped", status: row.billing_status };
  }

  const markReview = async (reason: string): Promise<OverageOutcome> => {
    await deps.setBilling({
      p_user: profile.id,
      p_period_key: period.key,
      p_status: "needs_review",
      p_invoice_id: invoice.id,
      p_item_id: null,
      p_error: reason,
    });
    deps.log("overage_needs_review", { invoice: invoice.id, reason });
    return { outcome: "needs_review", reason };
  };

  // Re-compute independently and compare with the ledger: any disagreement is never charged.
  let amount: number;
  try {
    if (row.rate_cents === null || row.rate_cents === undefined) return await markReview("rate_missing_on_ledger");
    amount = overageAmountCents(row.overage_minutes, row.rate_cents);
  } catch (err) {
    return await markReview(`amount_invalid:${err instanceof Error ? err.message : "unknown"}`);
  }
  if (amount !== Number(row.amount_cents)) return await markReview("amount_mismatch_with_ledger");
  if (amount <= 0) return { outcome: "skipped", status: "skipped_zero" };

  // The invoice must STILL be a draft. Once finalized nothing can be attached; a pending invoice item
  // would silently land on the NEXT invoice, so we flag it for staff instead.
  const fresh = await deps.retrieveInvoice(invoice.id);
  if (fresh.status !== "draft") return await markReview(`invoice_not_draft:${fresh.status ?? "unknown"}`);

  const key = overageIdempotencyKey(profile.id, period.key);

  try {
    const existing = (await deps.listInvoiceItems(invoice.id)).find((i) => i.metadata?.[OVERAGE_METADATA_KEY] === key);
    let itemId: string;
    let reused = false;
    if (existing) {
      itemId = existing.id;
      reused = true;
    } else {
      const created = await deps.createInvoiceItem(
        {
          customer: customerId,
          invoice: invoice.id,
          amount,
          currency: OVERAGE_CURRENCY,
          description: overageDescription(row.overage_minutes, row.rate_cents),
          metadata: {
            [OVERAGE_METADATA_KEY]: key,
            user_id: profile.id,
            period_key: period.key,
            overage_minutes: String(row.overage_minutes),
            rate_cents: String(row.rate_cents),
          },
          period: { start: period.start, end: period.end },
        },
        key,
      );
      itemId = created.id;
    }
    await deps.setBilling({
      p_user: profile.id,
      p_period_key: period.key,
      p_status: "billed",
      p_invoice_id: invoice.id,
      p_item_id: itemId,
      p_error: null,
    });
    return { outcome: "billed", itemId, amountCents: amount, reusedExistingItem: reused };
  } catch (err) {
    // Best effort: leave a trace on the ledger, then rethrow so the webhook retries.
    try {
      await deps.setBilling({
        p_user: profile.id,
        p_period_key: period.key,
        p_status: "failed",
        p_invoice_id: invoice.id,
        p_item_id: null,
        p_error: err instanceof Error ? err.message : "unknown error",
      });
    } catch { /* ledger trace is best effort */ }
    throw err;
  }
}

async function recordNewSubscriptionPlan(invoice: InvoiceLike, deps: OverageDeps): Promise<OverageOutcome> {
  const customerId = idOf(invoice.customer);
  if (!customerId) return { outcome: "ignored", reason: "no_customer" };
  const plan = planFromInvoiceLines(invoice, (id) => deps.planFromPriceId(id));
  if (!plan) return { outcome: "ignored", reason: "no_plan" };
  const profiles = await deps.findProfilesByCustomer(customerId);
  if (profiles.length === 0) return { outcome: "ignored", reason: "no_profile" };
  if (profiles.length > 1) return { outcome: "ignored", reason: "ambiguous_profile" };
  await deps.setPeriodPlan(profiles[0].id, plan);
  return { outcome: "snapshot_recorded", plan };
}
