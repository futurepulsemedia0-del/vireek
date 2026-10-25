// supabase/functions/capital-manage/index.ts
//
// Owner/admin: Vireek Capital. Vireek NEVER decides credit.
//   actions:
//     "prescreen" – reads REAL revenue data, runs the indicative pre-screen, stores the result.
//     "submit"    – (only after a passing pre-screen + both disclosures) pledges the chosen
//                   receivables and sends the data package to the LENDING PARTNER.
//     "accept_offer" / "withdraw" – relayed to the partner.
// Offers are stored exactly as the partner returned them; one missing disclosure field = reject.
// Deploy: JWT verification ON.

import { adminClient, authenticate, corsHeaders, getProductState, json, logPay, unavailable } from "../_shared/pay/http.ts";
import { getLendingPartner } from "../_shared/pay/registry.ts";
import { offerIsDisclosable, prescreenCapital, resolvePrescreenConfig, revenueProfileFromRpc, REASON_TEXT } from "../_shared/pay/capitalEngine.ts";
import { ProviderBoundaryError, type LendingDataPackage } from "../_shared/pay/types.ts";

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
    const state = await getProductState(db, "capital", caller.ownerId);
    if (!state.available) return unavailable(state);
    const partner = getLendingPartner(state.mode);
    if (!partner.isConfigured()) return json({ error: "provider_not_configured", mode: state.mode }, 503);
    const sandbox = state.mode === "sandbox";
    const cfg = resolvePrescreenConfig((state.config as Record<string, unknown> | undefined)?.prescreen);
    const accepted = async (key: string) =>
      ((await db.rpc("pay_disclosure_accepted", { p_auth_user: caller.userId, p_key: key })).data ?? null) as number | null;

    // ------------------------------------------------------------ prescreen
    if (action === "prescreen") {
      const preVersion = await accepted("capital_prescreen");
      if (preVersion === null) return json({ error: "disclosure_required", disclosure_key: "capital_prescreen" }, 409);

      const { data: raw, error } = await db.rpc("capital_get_revenue_profile", { p_user_id: caller.ownerId });
      if (error || !raw) throw error ?? new Error("profile unavailable");
      const profile = revenueProfileFromRpc(raw as Record<string, unknown>);
      const result = prescreenCapital(profile, cfg);

      const { data: app, error: insErr } = await db.from("capital_applications").insert({
        user_id: caller.ownerId, provider: partner.id, sandbox,
        status: result.outcome === "eligible_to_apply" ? "prescreened" : "prescreen_not_eligible",
        prescreen: { result, reasonsText: result.reasons.map((r) => REASON_TEXT[r]), profile: { ...profile, openReceivables: undefined }, config: cfg },
        disclosure_prescreen_version: preVersion,
      }).select("id, status").single();
      if (insErr) throw insErr;
      await db.from("capital_events").insert({ application_id: app.id, user_id: caller.ownerId, event_type: "prescreen", payload: { outcome: result.outcome, reasons: result.reasons } });
      return json({ application: app, sandbox, outcome: result.outcome, reasons: result.reasons.map((r) => ({ code: r, text: REASON_TEXT[r] })),
        eligibleReceivables: result.eligibleReceivables, eligibleReceivablesCents: result.eligibleReceivablesCents,
        profile: { ...profile, openReceivables: undefined }, notice: result.notice });
    }

    // Everything below acts on one of this tenant's applications.
    const { data: app } = await db.from("capital_applications").select("*").eq("id", body.application_id).eq("user_id", caller.ownerId).maybeSingle();
    if (!app) return json({ error: "application_not_found" }, 404);
    if (app.sandbox !== sandbox) return json({ error: "mode_mismatch" }, 409);

    // --------------------------------------------------------------- submit
    if (action === "submit") {
      if (app.status !== "prescreened") return json({ error: "invalid_state", status: app.status }, 409);
      const appVersion = await accepted("capital_application");
      if (appVersion === null) return json({ error: "disclosure_required", disclosure_key: "capital_application" }, 409);

      const requested = Number(body.requested_amount_cents);
      const invoiceIds = Array.isArray(body.invoice_ids) ? (body.invoice_ids as string[]) : [];
      if (!Number.isSafeInteger(requested) || requested <= 0 || requested > (state.max_single_cents ?? 0)) return json({ error: "invalid_amount" }, 422);
      if (invoiceIds.length === 0 || invoiceIds.length > 200) return json({ error: "no_receivables_selected" }, 422);

      // Re-run the pre-screen NOW on fresh data: the stored one may be stale.
      const { data: raw } = await db.rpc("capital_get_revenue_profile", { p_user_id: caller.ownerId });
      const profile = revenueProfileFromRpc(raw as Record<string, unknown>);
      const fresh = prescreenCapital(profile, cfg);
      if (fresh.outcome !== "eligible_to_apply") return json({ error: "not_eligible", reasons: fresh.reasons.map((r) => ({ code: r, text: REASON_TEXT[r] })) }, 409);
      const allowed = new Map(fresh.eligibleReceivables.map((r) => [r.invoiceId, r]));
      const chosen = invoiceIds.map((id) => allowed.get(id));
      if (chosen.some((c) => !c)) return json({ error: "receivable_not_eligible" }, 422);
      const faceTotal = chosen.reduce((s, r) => s + r!.amountCents, 0);
      if (requested > faceTotal) return json({ error: "amount_exceeds_pledged_receivables" }, 422);

      try {
        await db.rpc("capital_pledge_receivables", { p_application_id: app.id, p_user_id: caller.ownerId, p_invoice_ids: invoiceIds }).throwOnError();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
        if (msg.includes("already_pledged")) return json({ error: "receivable_already_pledged" }, 409);
        throw e;
      }

      const pkg: LendingDataPackage = {
        requestedAmountCents: requested,
        business: { trailing12mCents: profile.trailing12mCents, trailing3mCents: profile.trailing3mCents, monthsOfHistory: profile.monthsOfHistory, paidInvoiceCount12m: profile.paidInvoiceCount12m },
        receivables: chosen.map((r) => ({ invoiceId: r!.invoiceId, customerRef: r!.customerRef, amountCents: r!.amountCents, dueDate: r!.dueDate, issuedAt: r!.issuedAt })),
      };
      const pkgHash = await sha256Hex(JSON.stringify(pkg));
      await db.from("capital_applications").update({ status: "submitted", requested_amount_cents: requested, data_package_sha256: pkgHash,
        disclosure_application_version: appVersion, submitted_by: caller.userId, submitted_at: new Date().toISOString() }).eq("id", app.id);

      let result;
      try {
        result = await partner.submitApplication(app.id, pkg);
      } catch (e) {
        const code = e instanceof ProviderBoundaryError ? e.code : "partner_error";
        await db.from("capital_applications").update({ status: "error", failure_code: code }).eq("id", app.id);   // trigger releases pledges
        return json({ error: code }, e instanceof ProviderBoundaryError ? 503 : 502);
      }

      const offers = result.offers.filter((o) => offerIsDisclosable(o));
      if (result.offers.length !== offers.length) logPay("capital_offer_rejected_missing_disclosure", { applicationId: app.id });

      if (result.outcome === "declined") {
        await db.from("capital_applications").update({ status: "declined_by_partner", external_application_id: result.externalApplicationId, decline_reasons: result.declineReasons ?? [] }).eq("id", app.id);
      } else if (offers.length > 0) {
        await db.from("capital_offers").insert(offers.map((o) => ({
          application_id: app.id, user_id: caller.ownerId, provider: partner.id, sandbox: result.sandbox, external_offer_id: o.externalOfferId,
          offered_amount_cents: o.offeredAmountCents, total_repayment_cents: o.totalRepaymentCents, finance_charge_cents: o.financeChargeCents,
          term_days: o.termDays, estimated_apr_bps: o.estimatedAprBps, repayment_description: o.repaymentDescription, terms_url: o.termsUrl, expires_at: o.expiresAt,
        }))).throwOnError();
        await db.from("capital_applications").update({ status: "offered", external_application_id: result.externalApplicationId }).eq("id", app.id);
      } else {
        await db.from("capital_applications").update({ status: result.outcome === "pending" ? "submitted" : "error", external_application_id: result.externalApplicationId,
          failure_code: result.outcome === "pending" ? null : "no_disclosable_offer" }).eq("id", app.id);
      }
      await db.from("capital_events").insert({ application_id: app.id, user_id: caller.ownerId, event_type: "submitted", payload: { outcome: result.outcome, offers: offers.length, sandbox: result.sandbox } });
      logPay("capital_submitted", { applicationId: app.id, outcome: result.outcome, sandbox });
      return json({ outcome: result.outcome, sandbox: result.sandbox, declineReasons: result.declineReasons ?? [] });
    }

    // --------------------------------------------------------- accept / withdraw
    if (action === "accept_offer") {
      if (app.status !== "offered") return json({ error: "invalid_state", status: app.status }, 409);
      const { data: offer } = await db.from("capital_offers").select("*").eq("id", body.offer_id).eq("application_id", app.id).eq("status", "open").maybeSingle();
      if (!offer || Date.parse(offer.expires_at) <= Date.now()) return json({ error: "offer_not_available" }, 409);
      const res = await partner.acceptOffer(app.external_application_id, offer.external_offer_id);
      await db.from("capital_offers").update({ status: "accepted" }).eq("id", offer.id);
      await db.from("capital_applications").update({ status: res.status === "funded" ? "funded" : "accepted" }).eq("id", app.id);
      await db.from("capital_events").insert({ application_id: app.id, user_id: caller.ownerId, event_type: "offer_accepted", payload: { offer_id: offer.id, sandbox: res.sandbox } });
      return json({ ok: true, sandbox: res.sandbox });
    }

    if (action === "withdraw") {
      if (!["prescreened", "submitted", "offered"].includes(app.status)) return json({ error: "invalid_state", status: app.status }, 409);
      if (app.external_application_id) await partner.withdrawApplication(app.external_application_id);
      await db.from("capital_applications").update({ status: "withdrawn" }).eq("id", app.id);   // trigger releases pledges
      await db.from("capital_offers").update({ status: "withdrawn" }).eq("application_id", app.id).eq("status", "open");
      return json({ ok: true });
    }

    return json({ error: "invalid_action" }, 400);
  } catch (error) {
    console.error(JSON.stringify({ event: "capital_manage_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong." }, 500);
  }
});
