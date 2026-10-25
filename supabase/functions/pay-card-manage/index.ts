// supabase/functions/pay-card-manage/index.ts
//
// Owner/admin: issue a spend card, freeze/unfreeze/cancel it, change limits, and (sandbox only)
// simulate a purchase to exercise the authorization policy.
//   actions: "create" | "set_status" | "update_limits" | "simulate_purchase"
// Deploy: JWT verification ON.

import { adminClient, authenticate, corsHeaders, getProductState, json, logPay, unavailable } from "../_shared/pay/http.ts";
import { getCardIssuer } from "../_shared/pay/registry.ts";
import { validateCardLimits, DECLINE_MESSAGES } from "../_shared/pay/cardPolicy.ts";
import { CARD_COLUMNS, processCardAuthorization, type CardRow } from "../_shared/pay/cardAuth.ts";
import { ProviderBoundaryError } from "../_shared/pay/types.ts";

const parseLimits = (b: Record<string, unknown>) => ({
  perTxnLimitCents: Number(b.per_txn_limit_cents), dailyLimitCents: Number(b.daily_limit_cents), monthlyLimitCents: Number(b.monthly_limit_cents),
  allowedMcc: Array.isArray(b.allowed_mcc) && b.allowed_mcc.length ? (b.allowed_mcc as string[]) : null,
  blockedMcc: Array.isArray(b.blocked_mcc) ? (b.blocked_mcc as string[]) : [],
  receiptRequiredOverCents: b.receipt_required_over_cents === undefined ? 2500 : Number(b.receipt_required_over_cents),
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const db = adminClient();
    const caller = await authenticate(req, db);
    if (caller instanceof Response) return caller;
    if (!caller.canManage) return json({ error: "forbidden" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const state = await getProductState(db, "spend_cards", caller.ownerId);
    if (!state.available) return unavailable(state);
    const issuer = getCardIssuer(state.mode);
    if (!issuer.isConfigured()) return json({ error: "provider_not_configured", mode: state.mode }, 503);
    const sandbox = state.mode === "sandbox";
    const platformMax = state.max_single_cents ?? 0;

    if (action === "create") {
      const acc = (await db.rpc("pay_disclosure_accepted", { p_auth_user: caller.userId, p_key: "spend_card_terms" })).data;
      if (acc === null || acc === undefined) return json({ error: "disclosure_required", disclosure_key: "spend_card_terms" }, 409);

      const limits = parseLimits(body);
      const bad = validateCardLimits(limits, platformMax);
      if (bad) return json({ error: bad }, 422);

      let holderName = String(body.holder_name ?? "").trim().slice(0, 120);
      let teamMemberId: string | null = null;
      if (body.team_member_id) {
        const { data: tm } = await db.from("team_members").select("id, member_name, member_email")
          .eq("id", body.team_member_id).eq("account_owner_id", caller.ownerId).maybeSingle();
        if (!tm) return json({ error: "holder_not_found" }, 404);
        teamMemberId = tm.id;
        holderName = holderName || tm.member_name || tm.member_email;
      }
      if (!holderName) return json({ error: "holder_name_required" }, 422);

      const referenceId = crypto.randomUUID();
      let issued;
      try {
        issued = await issuer.issueCard({ referenceId, holderName, cardType: body.card_type === "physical" ? "physical" : "virtual" });
      } catch (e) {
        if (e instanceof ProviderBoundaryError) return json({ error: e.code }, 503);
        throw e;
      }
      const { data: card, error } = await db.from("spend_cards").insert({
        user_id: caller.ownerId, team_member_id: teamMemberId, holder_name: holderName, provider: issuer.id,
        external_card_id: issued.externalCardId, card_type: body.card_type === "physical" ? "physical" : "virtual",
        brand: issued.brand, last4: issued.last4, status: "active",
        per_txn_limit_cents: limits.perTxnLimitCents, daily_limit_cents: limits.dailyLimitCents, monthly_limit_cents: limits.monthlyLimitCents,
        allowed_mcc: limits.allowedMcc, blocked_mcc: limits.blockedMcc, receipt_required_over_cents: limits.receiptRequiredOverCents,
        sandbox: issued.sandbox, created_by: caller.userId,
      }).select("id, last4, status, sandbox").single();
      if (error) {
        // Card exists at the provider but not in our ledger: freeze it so it cannot be used unseen.
        await issuer.setCardStatus(issued.externalCardId, "frozen").catch(() => {});
        throw error;
      }
      logPay("pay_card_created", { cardId: card.id, sandbox });
      return json({ card });
    }

    // The remaining actions target an existing card of THIS tenant.
    const { data: card } = await db.from("spend_cards").select(`${CARD_COLUMNS}, external_card_id`)
      .eq("id", body.card_id).eq("user_id", caller.ownerId).maybeSingle();
    if (!card) return json({ error: "card_not_found" }, 404);
    if (card.sandbox !== sandbox) return json({ error: "mode_mismatch" }, 409);

    if (action === "set_status") {
      const next = String(body.status ?? "");
      if (!["active", "frozen", "canceled"].includes(next)) return json({ error: "invalid_status" }, 400);
      if (card.status === "canceled") return json({ error: "card_canceled" }, 409);
      await issuer.setCardStatus(card.external_card_id, next as "active" | "frozen" | "canceled");
      await db.from("spend_cards").update({ status: next }).eq("id", card.id);
      logPay("pay_card_status", { cardId: card.id, status: next });
      return json({ ok: true, status: next });
    }

    if (action === "update_limits") {
      const limits = parseLimits(body);
      const bad = validateCardLimits(limits, platformMax);
      if (bad) return json({ error: bad }, 422);
      await db.from("spend_cards").update({
        per_txn_limit_cents: limits.perTxnLimitCents, daily_limit_cents: limits.dailyLimitCents, monthly_limit_cents: limits.monthlyLimitCents,
        allowed_mcc: limits.allowedMcc, blocked_mcc: limits.blockedMcc, receipt_required_over_cents: limits.receiptRequiredOverCents,
      }).eq("id", card.id);
      return json({ ok: true });
    }

    if (action === "simulate_purchase") {
      if (!sandbox) return json({ error: "not_supported_in_mode" }, 400);
      const result = await processCardAuthorization(db, card as CardRow, {
        externalAuthId: `sbx_auth_${crypto.randomUUID()}`, amountCents: Number(body.amount_cents),
        currency: "usd", merchantName: String(body.merchant_name ?? "Sandbox Merchant").slice(0, 200),
        mcc: typeof body.mcc === "string" && /^[0-9]{4}$/.test(body.mcc) ? body.mcc : null,
      }, platformMax);
      return json({
        sandbox: true, approved: result.decision.approved,
        declineCode: result.decision.approved ? null : result.decision.declineCode,
        message: result.decision.approved ? "Approved (sandbox)." : DECLINE_MESSAGES[result.decision.declineCode],
        receiptRequired: result.decision.approved ? result.decision.receiptRequired : false,
      });
    }

    return json({ error: "invalid_action" }, 400);
  } catch (error) {
    console.error(JSON.stringify({ event: "pay_card_manage_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong." }, 500);
  }
});
