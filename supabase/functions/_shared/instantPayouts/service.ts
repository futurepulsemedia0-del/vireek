// Instant-payout orchestration with every dependency injected (store, Stripe, clock),
// so the whole money path is testable with a mocked Stripe and an in-memory store.
// No Deno/Supabase imports on purpose.
import {
  MAX_PAYOUT_CENTS,
  MIN_PAYOUT_CENTS,
  RESUME_WINDOW_MS,
  evaluateEligibility,
  formatMoney,
  friendlyFailureMessage,
  isAmbiguousStripeFailure,
  isPricingInSync,
  mapStripePayoutStatus,
  quoteFee,
  type Eligibility,
  type ExternalAccountSummary,
  type InstantBalance,
  type PayoutStatus,
  type Pricing,
} from "./logic.ts";
import type { InstantPayoutResult } from "./stripeApi.ts";

export interface Actor {
  userId: string;
  email: string;
  ownerId: string;
  canManage: boolean;
}

export interface ConnectRow {
  stripe_account_id: string | null;
  details_submitted: boolean;
  payouts_enabled: boolean;
  created_at: string | null;
}

export interface PayoutRow {
  id: string;
  user_id: string;
  stripe_account_id: string;
  idempotency_key: string;
  amount_cents: number;
  fee_cents: number;
  currency: string;
  destination_id: string | null;
  destination_label: string | null;
  status: PayoutStatus;
  stripe_payout_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  arrival_date: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface Store {
  getConnect(ownerId: string): Promise<ConnectRow | null>;
  hasOpenDispute(ownerId: string): Promise<boolean>;
  reserve(args: {
    ownerId: string;
    actor: Actor;
    stripeAccountId: string;
    idempotencyKey: string;
    amountCents: number;
    feeCents: number;
    destination: ExternalAccountSummary;
  }): Promise<PayoutRow>;
  getPayout(ownerId: string, id: string): Promise<PayoutRow | null>;
  findByKey(ownerId: string, idempotencyKey: string): Promise<PayoutRow | null>;
  markSent(args: { id: string; stripePayoutId: string; status: PayoutStatus; feeCents: number | null; arrival: string | null }): Promise<PayoutRow>;
  markFailed(args: { id: string; code: string; message: string }): Promise<PayoutRow>;
  listRecent(ownerId: string, limit: number): Promise<PayoutRow[]>;
}

export interface Gateway {
  getInstantBalance(accountId: string): Promise<InstantBalance | null>;
  listExternalAccounts(accountId: string): Promise<ExternalAccountSummary[]>;
  createInstantPayout(
    accountId: string,
    input: { amountCents: number; destinationId: string; idempotencyKey: string; payoutRowId: string },
  ): Promise<InstantPayoutResult>;
  createExpressLoginLink(accountId: string): Promise<string>;
}

export interface Deps {
  store: Store;
  stripe: Gateway;
  pricing: Pricing;
  minAccountAgeDays: number;
  now: () => Date;
  log: (event: string, data?: Record<string, unknown>) => void;
}

/** An error whose message is safe to show to the user. */
export class ServiceError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(message: string, status = 400, code = "bad_request", extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const REASON_FORBIDDEN = "Only the account owner or an admin can request instant payouts.";

export interface EligibilityResponse extends Eligibility {
  pricing: { feeBps: number; feeMinCents: number; feeMaxCents: number | null; minPayoutCents: number; maxPayoutCents: number };
  recent: PayoutRow[];
}

function publicPricing(d: Deps, maxPayoutCents: number): EligibilityResponse["pricing"] {
  return {
    feeBps: d.pricing.feeBps,
    feeMinCents: d.pricing.feeMinCents,
    feeMaxCents: d.pricing.feeMaxCents,
    minPayoutCents: MIN_PAYOUT_CENTS,
    maxPayoutCents,
  };
}

/** Everything the UI needs in one call: can this account cash out right now, how much, to where, at what fee. */
export async function getEligibility(d: Deps, actor: Actor): Promise<EligibilityResponse> {
  const recent = actor.canManage ? await d.store.listRecent(actor.ownerId, 10) : [];
  const respond = (e: Eligibility): EligibilityResponse => ({ ...e, pricing: publicPricing(d, e.maxPayoutCents || MAX_PAYOUT_CENTS), recent });

  const base = {
    canManage: actor.canManage,
    stripeAccountId: null as string | null,
    detailsSubmitted: false,
    payoutsEnabled: false,
    hasOpenDispute: false,
    accountAgeDays: 0,
    minAccountAgeDays: d.minAccountAgeDays,
    destinations: [] as ExternalAccountSummary[],
    balance: null as InstantBalance | null,
  };
  if (!actor.canManage) return respond(evaluateEligibility(base));

  const connect = await d.store.getConnect(actor.ownerId);
  const withConnect = {
    ...base,
    stripeAccountId: connect?.stripe_account_id ?? null,
    detailsSubmitted: connect?.details_submitted === true,
    payoutsEnabled: connect?.payouts_enabled === true,
    accountAgeDays: connect?.created_at ? Math.max(0, Math.floor((d.now().getTime() - new Date(connect.created_at).getTime()) / DAY_MS)) : 0,
  };
  // Stop before spending Stripe calls when a cheap local check already says no.
  const early = evaluateEligibility(withConnect);
  if (early.reason && early.reason !== "no_instant_destination") return respond(early);

  const hasOpenDispute = await d.store.hasOpenDispute(actor.ownerId);
  if (hasOpenDispute || withConnect.accountAgeDays < withConnect.minAccountAgeDays) {
    return respond(evaluateEligibility({ ...withConnect, hasOpenDispute }));
  }

  let destinations: ExternalAccountSummary[];
  let balance: InstantBalance | null;
  try {
    [destinations, balance] = await Promise.all([
      d.stripe.listExternalAccounts(withConnect.stripeAccountId!),
      d.stripe.getInstantBalance(withConnect.stripeAccountId!),
    ]);
  } catch (err) {
    d.log("instant_payout_eligibility_stripe_failed", { error: err instanceof Error ? err.message : String(err) });
    throw new ServiceError("We couldn't reach Stripe to check your balance. Please try again in a moment.", 502, "stripe_unavailable");
  }

  const result = evaluateEligibility({ ...withConnect, hasOpenDispute, destinations, balance });
  if (result.destination && balance) {
    const net = balance.netByDestination[result.destination.id] ?? 0;
    if (!isPricingInSync(balance.grossCents, net, d.pricing)) {
      d.log("instant_payout_pricing_mismatch", { gross: balance.grossCents, net, feeBps: d.pricing.feeBps, feeMin: d.pricing.feeMinCents });
    }
  }
  return respond(result);
}

export interface PayoutOutcome {
  payout: PayoutRow;
  warning: "status_unknown" | null;
  message: string | null;
  httpStatus: 200 | 202;
}

/** Sends the (already reserved) payout to Stripe. Safe to call repeatedly for the same row: Stripe replays by idempotency key. */
async function processReserved(d: Deps, row: PayoutRow): Promise<PayoutOutcome> {
  if (row.stripe_payout_id) return { payout: row, warning: null, message: null, httpStatus: 200 };
  if (row.status !== "pending") {
    throw new ServiceError(row.failure_message || "This payout did not go through. Start a new one.", 409, "payout_closed");
  }
  if (!row.destination_id) {
    const failed = await d.store.markFailed({ id: row.id, code: "no_destination", message: "No payout destination was recorded." });
    throw new ServiceError(failed.failure_message || "No payout destination was recorded.", 409, "payout_closed");
  }

  let result: InstantPayoutResult;
  try {
    result = await d.stripe.createInstantPayout(row.stripe_account_id, {
      amountCents: row.amount_cents,
      destinationId: row.destination_id,
      idempotencyKey: `instant_payout_${row.id}`,
      payoutRowId: row.id,
    });
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : "Stripe could not process the payout.";
    if (isAmbiguousStripeFailure(err)) {
      d.log("instant_payout_stripe_ambiguous", { payout_id: row.id, error: rawMessage });
      return {
        payout: row,
        warning: "status_unknown",
        message: "Stripe has not confirmed this payout yet. Check again in a minute — if it stays on Processing, press Check status.",
        httpStatus: 202,
      };
    }
    const code = (err as { code?: string } | null)?.code ?? "stripe_error";
    const message = friendlyFailureMessage(code, rawMessage);
    await d.store.markFailed({ id: row.id, code, message });
    d.log("instant_payout_stripe_rejected", { payout_id: row.id, code });
    throw new ServiceError(message, 422, "stripe_rejected");
  }

  const status = mapStripePayoutStatus(result.status);
  const sent = await d.store.markSent({
    id: row.id,
    stripePayoutId: result.id,
    status,
    feeCents: result.applicationFeeCents,
    arrival: result.arrivalDate,
  });
  if (status === "failed" || status === "canceled") {
    throw new ServiceError(friendlyFailureMessage(result.failureCode, result.failureMessage), 422, "stripe_rejected");
  }
  return { payout: sent, warning: null, message: null, httpStatus: 200 };
}

export async function requestPayout(
  d: Deps,
  actor: Actor,
  input: { amountCents: number; expectedFeeCents: number; idempotencyKey: string },
): Promise<PayoutOutcome> {
  if (!actor.canManage) throw new ServiceError(REASON_FORBIDDEN, 403, "forbidden");

  // A replay of an already-reserved request (lost response, double click) must return THAT payout, not
  // be re-validated against a balance that the first attempt already spent.
  const existing = await d.store.findByKey(actor.ownerId, input.idempotencyKey);
  if (existing) {
    if (existing.amount_cents !== input.amountCents) {
      throw new ServiceError("This request key was already used for a different amount. Start a new payout.", 409, "idempotency_conflict");
    }
    return processReserved(d, existing);
  }

  const eligibility = await getEligibility(d, actor);
  const connect = await d.store.getConnect(actor.ownerId);

  if (!eligibility.eligible || !eligibility.destination || !connect?.stripe_account_id) {
    const reason = eligibility.reason ?? "no_instant_balance";
    const status = reason === "forbidden" ? 403 : 409;
    throw new ServiceError(eligibility.message ?? "Instant payouts aren't available right now.", status, reason);
  }
  if (input.amountCents < MIN_PAYOUT_CENTS) {
    throw new ServiceError(`The minimum instant payout is ${formatMoney(MIN_PAYOUT_CENTS)}.`, 400, "amount_too_small");
  }
  if (input.amountCents > eligibility.maxPayoutCents) {
    throw new ServiceError(
      `You can pay out up to ${formatMoney(eligibility.maxPayoutCents)} right now. Your available balance changed — review and try again.`,
      409,
      "amount_exceeds_balance",
      { max_payout_cents: eligibility.maxPayoutCents },
    );
  }

  const fee = quoteFee(input.amountCents, d.pricing);
  if (fee !== input.expectedFeeCents) {
    throw new ServiceError(
      `The fee is now ${formatMoney(fee)}, not ${formatMoney(input.expectedFeeCents)}. Review the new total before confirming.`,
      409,
      "quote_changed",
      { fee_cents: fee },
    );
  }

  let row: PayoutRow;
  try {
    row = await d.store.reserve({
      ownerId: actor.ownerId,
      actor,
      stripeAccountId: connect.stripe_account_id,
      idempotencyKey: input.idempotencyKey,
      amountCents: input.amountCents,
      feeCents: fee,
      destination: eligibility.destination,
    });
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    d.log("instant_payout_reserve_failed", { error: err instanceof Error ? err.message : String(err) });
    throw new ServiceError("Could not start the payout. Please try again.", 500, "reserve_failed");
  }
  return processReserved(d, row);
}

/** Re-sends a payout that Stripe never confirmed (dropped connection / 5xx). Replays by idempotency key, so it can never pay twice. */
export async function resumePayout(d: Deps, actor: Actor, payoutId: string): Promise<PayoutOutcome> {
  if (!actor.canManage) throw new ServiceError(REASON_FORBIDDEN, 403, "forbidden");
  const row = await d.store.getPayout(actor.ownerId, payoutId);
  if (!row) throw new ServiceError("Payout not found.", 404, "not_found");
  if (row.stripe_payout_id) return { payout: row, warning: null, message: null, httpStatus: 200 };
  if (row.status !== "pending") {
    throw new ServiceError(row.failure_message || "This payout did not go through. Start a new one.", 409, "payout_closed");
  }
  if (d.now().getTime() - new Date(row.created_at).getTime() > RESUME_WINDOW_MS) {
    throw new ServiceError(
      "This payout is too old to retry safely. Open your Stripe dashboard to confirm whether it went through; it will update here automatically.",
      409,
      "resume_expired",
    );
  }
  return processReserved(d, row);
}

export async function getDashboardLink(d: Deps, actor: Actor): Promise<string> {
  if (!actor.canManage) throw new ServiceError(REASON_FORBIDDEN, 403, "forbidden");
  const connect = await d.store.getConnect(actor.ownerId);
  if (!connect?.stripe_account_id) throw new ServiceError("Connect your Stripe account first.", 409, "not_connected");
  try {
    return await d.stripe.createExpressLoginLink(connect.stripe_account_id);
  } catch (err) {
    d.log("instant_payout_login_link_failed", { error: err instanceof Error ? err.message : String(err) });
    throw new ServiceError("Stripe couldn't open your dashboard yet. Finish verification first, then try again.", 409, "login_link_failed");
  }
}
