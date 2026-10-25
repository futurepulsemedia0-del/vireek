// supabase/functions/pay-transfer-request/index.ts
//
// Technician-facing: quote and request an instant payout or an earned-wage advance.
//
// Flow (every step fails closed):
//   auth → product state (kill switch / mode / freeze) → adapter configured → disclosure
//   accepted → payout account → tested engine quotes the exact fee → pay_reserve_transfer
//   (atomic: lock, idempotency, caps) → provider call → pay_finalize_transfer.
// The provider call happens AFTER the reservation commits, so a crash can never lose track of
// money: an unanswered reservation is swept to needs_review (pay_flag_stuck_transfers).
//
// Deploy: normal JWT verification ON (it is called by signed-in users).
//   actions: "quote" | "request" | "ensure_sandbox_account" (sandbox mode only)

import { adminClient, authenticate, corsHeaders, getProductState, json, logPay, unavailable } from "../_shared/pay/http.ts";
import { getPayoutProvider } from "../_shared/pay/registry.ts";
import { computeEwaAvailability, ewaInputsFromRpc, quoteInstantPayout, validateAdvanceRequest, type EwaPolicy } from "../_shared/pay/ewaEngine.ts";
import { ProviderBoundaryError, type PayProduct, type ProductState, type TransferKind } from "../_shared/pay/types.ts";

const KINDS: Record<TransferKind, { product: PayProduct; disclosure: string }> = {
  earned_wage_advance: { product: "earned_wage_access", disclosure: "ewa_terms" },
  instant_payout: { product: "instant_payouts", disclosure: "instant_payout_fees" },
};

const policyFrom = (s: ProductState): EwaPolicy => ({
  feeBps: s.fee_bps ?? 0, minFeeCents: s.min_fee_cents ?? 0, maxFeeCents: s.max_fee_cents ?? 0,
  maxPctOfAccrued: s.max_pct_of_accrued ?? 0, maxSingleCents: s.max_single_cents ?? 0,
  maxDailyTenantCents: s.max_daily_tenant_cents ?? 0,
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const db = adminClient();
    const caller = await authenticate(req, db);
    if (caller instanceof Response) return caller;
    if (!caller.teamMemberId) return json({ error: "not_a_technician" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const kind = body.kind as TransferKind;
    if (!["quote", "request", "ensure_sandbox_account"].includes(action)) return json({ error: "invalid_action" }, 400);
    if (!(kind in KINDS)) return json({ error: "invalid_kind" }, 400);
    const { product, disclosure } = KINDS[kind];

    const state = await getProductState(db, product, caller.ownerId);
    if (!state.available) return unavailable(state);
    const provider = getPayoutProvider(state.mode);
    if (!provider.isConfigured()) return json({ error: "provider_not_configured", mode: state.mode }, 503);
    const sandbox = state.mode === "sandbox";

    const { data: employee } = await db.from("employees").select("id, full_name")
      .eq("user_id", caller.ownerId).eq("team_member_id", caller.teamMemberId)
      .order("active", { ascending: false }).limit(1).maybeSingle();
    if (!employee) return json({ error: "no_pay_profile" }, 403);

    const { data: account } = await db.from("pay_payout_accounts").select("id, external_account_id, last4, account_type, instant_eligible")
      .eq("team_member_id", caller.teamMemberId).eq("status", "verified").eq("sandbox", sandbox)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();

    if (action === "ensure_sandbox_account") {
      if (!sandbox) return json({ error: "not_supported_in_mode" }, 400);
      if (account) return json({ account });
      const ext = `sbx_acct_${caller.teamMemberId}`;
      const { data: created, error } = await db.from("pay_payout_accounts").upsert({
        user_id: caller.ownerId, team_member_id: caller.teamMemberId, provider: "sandbox", external_account_id: ext,
        account_type: "debit_card", last4: "4242", instant_eligible: true, status: "verified", sandbox: true,
      }, { onConflict: "provider,external_account_id" }).select("id, external_account_id, last4, account_type, instant_eligible").single();
      if (error) throw error;
      return json({ account: created });
    }

    const policy = policyFrom(state);
    const acceptedVersion = (await db.rpc("pay_disclosure_accepted", { p_auth_user: caller.userId, p_key: disclosure })).data as number | null;

    // ---------------------------------------------------------------- quote
    let quote: Record<string, unknown>;
    let ceiling = 0;
    let item: { item_id: string; net_pay_cents: number } | null = null;
    let snapshot: Record<string, unknown> = {};

    if (kind === "earned_wage_advance") {
      const { data: raw } = await db.rpc("pay_get_ewa_inputs", { p_employee_id: employee.id });
      if (!raw) return json({ error: "no_pay_profile" }, 403);
      const avail = computeEwaAvailability(ewaInputsFromRpc(raw as Record<string, unknown>), policy);
      ceiling = avail.ceilingCents;
      snapshot = { availability: avail, policy };
      quote = { kind, ...avail, fee_schedule: { fee_bps: policy.feeBps, min_fee_cents: policy.minFeeCents, max_fee_cents: policy.maxFeeCents } };
    } else {
      const { data: items } = await db.rpc("pay_list_instant_items", { p_employee_id: employee.id });
      const list = ((items ?? []) as { item_id: string; pay_run_id: string; pay_date: string; net_pay_cents: number }[]).map((i) => {
        const q = quoteInstantPayout(Number(i.net_pay_cents), policy);
        return { item_id: i.item_id, pay_date: i.pay_date, net_pay_cents: Number(i.net_pay_cents), quote: q };
      });
      if (action === "request") item = list.find((i) => i.item_id === body.pay_run_item_id) ?? null;
      snapshot = { policy, item };
      quote = { kind, items: list };
    }

    if (action === "quote") {
      return json({ mode: state.mode, sandbox, partner_name: state.partner_name ?? null, ...quote,
        disclosure: { key: disclosure, accepted: acceptedVersion !== null },
        payout_account: account ? { last4: account.last4, account_type: account.account_type } : null });
    }

    // -------------------------------------------------------------- request
    const idem = String(body.idempotency_key ?? "");
    if (idem.length < 8 || idem.length > 100) return json({ error: "invalid_idempotency_key" }, 400);
    if (acceptedVersion === null) return json({ error: "disclosure_required", disclosure_key: disclosure }, 409);
    if (!account) return json({ error: "no_payout_account" }, 409);
    if (kind === "instant_payout" && !account.instant_eligible) return json({ error: "account_not_instant_eligible" }, 409);

    let amountCents: number;
    let feeCents: number;
    if (kind === "earned_wage_advance") {
      const available = (snapshot.availability as { availableCents: number }).availableCents;
      const v = validateAdvanceRequest(body.amount_cents, available, policy);
      if (!v.ok) return json({ error: v.code }, 422);
      amountCents = v.amountCents; feeCents = v.feeCents;
    } else {
      if (!item) return json({ error: "item_not_eligible" }, 422);
      const v = quoteInstantPayout(item.net_pay_cents, policy);
      if (!v.ok) return json({ error: v.code }, 422);
      amountCents = v.amountCents; feeCents = v.feeCents;
    }

    const { data: reserved, error: reserveErr } = await db.rpc("pay_reserve_transfer", {
      p_user_id: caller.ownerId, p_team_member_id: caller.teamMemberId, p_employee_id: employee.id,
      p_holder_name: employee.full_name, p_kind: kind, p_amount_cents: amountCents, p_fee_cents: feeCents,
      p_ceiling_cents: ceiling, p_daily_cap_cents: policy.maxDailyTenantCents, p_idempotency_key: idem,
      p_pay_run_item_id: item?.item_id ?? null, p_provider: provider.id, p_sandbox: sandbox,
      p_payout_account_id: account.id, p_disclosure_key: disclosure, p_disclosure_version: acceptedVersion,
      p_snapshot: snapshot,
    });
    if (reserveErr || !reserved) throw reserveErr ?? new Error("reserve failed");
    if (reserved.status === "refused") return json({ error: reserved.reason }, 422);
    const transfer = reserved.transfer as { id: string; status: string };
    if (reserved.status === "replayed") return json({ replayed: true, transfer });

    // Provider call (after the reservation is committed).
    let finalStatus: "paid" | "processing" | "failed" | "needs_review";
    let externalId: string | null = null;
    let failureCode: string | null = null;
    try {
      const result = await provider.createPayout({
        referenceId: transfer.id, amountCents: amountCents - feeCents, currency: "usd",
        destinationAccountId: account.external_account_id, instant: kind === "instant_payout",
        description: kind === "instant_payout" ? "Vireek instant payout" : "Vireek earned wage advance",
      });
      finalStatus = result.status; externalId = result.externalId; failureCode = result.failureCode ?? null;
    } catch (e) {
      // Boundary errors are raised before anything is sent → safe to fail. Anything else is
      // ambiguous (the partner may have moved money) → needs_review, never an auto-retry.
      if (e instanceof ProviderBoundaryError) { finalStatus = "failed"; failureCode = e.code; }
      else { finalStatus = "needs_review"; failureCode = "provider_error_ambiguous"; }
      logPay("pay_transfer_provider_error", { transferId: transfer.id, ambiguous: finalStatus === "needs_review" });
    }

    const { data: fin } = await db.rpc("pay_finalize_transfer", {
      p_transfer_id: transfer.id, p_status: finalStatus, p_external_id: externalId, p_failure_code: failureCode,
      p_event: { source: "provider_response", sandbox },
    });
    logPay("pay_transfer_requested", { transferId: transfer.id, kind, status: finalStatus, sandbox });
    return json({ transfer: fin?.transfer ?? transfer, sandbox }, finalStatus === "failed" ? 422 : 200);
  } catch (error) {
    console.error(JSON.stringify({ event: "pay_transfer_request_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong. Nothing was sent." }, 500);
  }
});
