// supabase/functions/_shared/pay/cardAuth.ts
// One code path for a card authorization, used by the issuer webhook AND the sandbox simulator.
// Idempotent on (card_id, external_auth_id, kind): a replayed webhook returns the original decision.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { evaluateCardAuthorization, type AuthorizationDecision, type CardPolicy } from "./cardPolicy.ts";

export interface CardRow {
  id: string; user_id: string; status: CardPolicy["status"];
  per_txn_limit_cents: number; daily_limit_cents: number; monthly_limit_cents: number;
  allowed_mcc: string[] | null; blocked_mcc: string[] | null; receipt_required_over_cents: number; sandbox: boolean;
}

export const CARD_COLUMNS =
  "id, user_id, status, per_txn_limit_cents, daily_limit_cents, monthly_limit_cents, allowed_mcc, blocked_mcc, receipt_required_over_cents, sandbox";

export const policyFromRow = (c: CardRow): CardPolicy => ({
  status: c.status, perTxnLimitCents: Number(c.per_txn_limit_cents), dailyLimitCents: Number(c.daily_limit_cents),
  monthlyLimitCents: Number(c.monthly_limit_cents), allowedMcc: c.allowed_mcc, blockedMcc: c.blocked_mcc ?? [],
  receiptRequiredOverCents: Number(c.receipt_required_over_cents),
});

export interface AuthInput {
  externalAuthId: string; amountCents: number; currency: string; merchantName: string | null; mcc: string | null;
}

export async function processCardAuthorization(
  db: SupabaseClient, card: CardRow, input: AuthInput, platformMaxSingleCents: number,
): Promise<{ decision: AuthorizationDecision; replayed: boolean; transactionId: string | null }> {
  const { data: existing } = await db.from("card_transactions").select("id, status, decline_code")
    .eq("card_id", card.id).eq("external_auth_id", input.externalAuthId).eq("kind", "authorization").maybeSingle();
  if (existing) {
    const decision: AuthorizationDecision = existing.status === "declined"
      ? { approved: false, declineCode: existing.decline_code }
      : { approved: true, receiptRequired: false };
    return { decision, replayed: true, transactionId: existing.id };
  }

  const { data: totals } = await db.rpc("pay_card_spend_totals", { p_card_id: card.id });
  const decision = evaluateCardAuthorization(
    policyFromRow(card),
    { amountCents: input.amountCents, currency: input.currency, mcc: input.mcc },
    { todayCents: Number(totals?.today_cents ?? 0), monthCents: Number(totals?.month_cents ?? 0) },
    platformMaxSingleCents,
  );

  const { data: row, error } = await db.from("card_transactions").insert({
    user_id: card.user_id, card_id: card.id, external_auth_id: input.externalAuthId, kind: "authorization",
    status: decision.approved ? "approved" : "declined", decline_code: decision.approved ? null : decision.declineCode,
    amount_cents: Math.max(0, input.amountCents), merchant_name: input.merchantName?.slice(0, 200) ?? null,
    mcc: input.mcc, sandbox: card.sandbox,
  }).select("id").single();
  if (error) throw error;
  return { decision, replayed: false, transactionId: row.id };
}
