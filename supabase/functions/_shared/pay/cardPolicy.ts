// supabase/functions/_shared/pay/cardPolicy.ts
//
// Real-time card authorization policy. PURE and deterministic: the issuer's webhook has
// ~2 s to answer, so this does no I/O — callers pass in the card, the authorization and the
// already-spent totals. First violated rule wins; every decline has a stable code that the
// UI turns into a human sentence.

export interface CardPolicy {
  status: "pending" | "active" | "frozen" | "canceled";
  perTxnLimitCents: number;
  dailyLimitCents: number;
  monthlyLimitCents: number;
  /** null/empty = every category allowed except blocked ones. */
  allowedMcc: string[] | null;
  blockedMcc: string[];
  receiptRequiredOverCents: number;
}

export interface CardAuthorization {
  amountCents: number;
  currency: string;
  mcc: string | null;
}

export interface SpendTotals {
  todayCents: number;
  monthCents: number;
}

export type DeclineCode =
  | "card_not_active" | "invalid_amount" | "unsupported_currency" | "platform_cap_exceeded"
  | "mcc_blocked" | "mcc_not_allowed" | "mcc_unknown"
  | "per_transaction_limit" | "daily_limit" | "monthly_limit";

export type AuthorizationDecision = { approved: true; receiptRequired: boolean } | { approved: false; declineCode: DeclineCode };

export function evaluateCardAuthorization(
  card: CardPolicy, auth: CardAuthorization, spent: SpendTotals, platformMaxSingleCents: number,
): AuthorizationDecision {
  const no = (declineCode: DeclineCode): AuthorizationDecision => ({ approved: false, declineCode });

  if (card.status !== "active") return no("card_not_active");
  if (!Number.isSafeInteger(auth.amountCents) || auth.amountCents <= 0) return no("invalid_amount");
  if (auth.currency.toLowerCase() !== "usd") return no("unsupported_currency");
  if (auth.amountCents > platformMaxSingleCents) return no("platform_cap_exceeded");

  const hasAllowList = Array.isArray(card.allowedMcc) && card.allowedMcc.length > 0;
  if (auth.mcc === null && hasAllowList) return no("mcc_unknown");
  if (auth.mcc !== null) {
    if (card.blockedMcc.includes(auth.mcc)) return no("mcc_blocked");
    if (hasAllowList && !card.allowedMcc!.includes(auth.mcc)) return no("mcc_not_allowed");
  }

  if (auth.amountCents > card.perTxnLimitCents) return no("per_transaction_limit");
  if (spent.todayCents + auth.amountCents > card.dailyLimitCents) return no("daily_limit");
  if (spent.monthCents + auth.amountCents > card.monthlyLimitCents) return no("monthly_limit");

  return { approved: true, receiptRequired: auth.amountCents > card.receiptRequiredOverCents };
}

export const DECLINE_MESSAGES: Record<DeclineCode, string> = {
  card_not_active: "This card is not active.",
  invalid_amount: "The amount is not valid.",
  unsupported_currency: "Only USD purchases are supported.",
  platform_cap_exceeded: "The amount is above the platform's single-purchase maximum.",
  mcc_blocked: "This merchant category is blocked for this card.",
  mcc_not_allowed: "This merchant category is not on the card's allowed list.",
  mcc_unknown: "The merchant category could not be verified.",
  per_transaction_limit: "The purchase is above this card's per-transaction limit.",
  daily_limit: "The purchase would exceed this card's daily limit.",
  monthly_limit: "The purchase would exceed this card's monthly limit.",
};

export interface CardLimitsInput {
  perTxnLimitCents: number;
  dailyLimitCents: number;
  monthlyLimitCents: number;
  allowedMcc?: string[] | null;
  blockedMcc?: string[];
  receiptRequiredOverCents?: number;
}

const MCC_RE = /^[0-9]{4}$/;

/** Validates limits on create/update. Returns an error code or null. */
export function validateCardLimits(l: CardLimitsInput, platformMaxSingleCents: number): string | null {
  const ints = [l.perTxnLimitCents, l.dailyLimitCents, l.monthlyLimitCents];
  if (ints.some((n) => !Number.isSafeInteger(n) || n <= 0)) return "limits_must_be_positive_integers";
  if (l.perTxnLimitCents > platformMaxSingleCents) return "per_txn_above_platform_cap";
  if (l.dailyLimitCents < l.perTxnLimitCents || l.monthlyLimitCents < l.dailyLimitCents) return "limits_not_ascending";
  for (const list of [l.allowedMcc ?? [], l.blockedMcc ?? []]) {
    if (list.length > 200 || list.some((m) => !MCC_RE.test(m))) return "invalid_mcc";
  }
  if (l.receiptRequiredOverCents !== undefined && (!Number.isSafeInteger(l.receiptRequiredOverCents) || l.receiptRequiredOverCents < 0)) return "invalid_receipt_threshold";
  return null;
}
