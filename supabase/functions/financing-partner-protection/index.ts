// Service-protection offers (item 139).
//   POST { action: "request", quote_id, partner_key? }       account manager (JWT): eligibility -> provider quote
//   POST { action: "accept", offer_token, disclosure_sha256 } customer (public, no JWT; unguessable token)
// Gate (flag + entitlement + counsel-reviewed region rule) is enforced in SQL, not here.
import { getPartner } from "../_shared/financing-partners/registry.ts";
import { isProtectionPartner, validateProviderQuote } from "../_shared/financing-partners/protection.ts";
import { adminClient, authenticate, corsHeaders, isUuid, json, logEvent, readJson, statusForError } from "../_shared/financing-partners/http.ts";

const SHA_RE = /^[0-9a-f]{64}$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await readJson(req);
    if (!body) return json({ error: "Invalid request." }, 400);
    const admin = adminClient();

    // ---------------------------------------------------------------- customer accept
    if (body.action === "accept") {
      if (!isUuid(body.offer_token) || typeof body.disclosure_sha256 !== "string" || !SHA_RE.test(body.disclosure_sha256)) {
        return json({ error: "A valid offer and acknowledgement are required." }, 400);
      }
      const { data: acc, error: accErr } = await admin.rpc("customer_accept_service_protection", {
        p_offer_token: body.offer_token, p_disclosure_sha256: body.disclosure_sha256,
      });
      if (accErr || !acc) throw accErr ?? new Error("accept failed");
      if (!acc.ok) return json({ error: acc.error }, acc.error === "not_found" ? 404 : acc.error === "unavailable" ? 403 : 422);

      // Already fulfilled, or already confirmed with the provider: nothing more to do.
      if (acc.status === "active" || (acc.existing && !acc.needs_review)) return json({ ok: true, status: acc.status });

      const partner = getPartner(String(acc.partner_key));
      if (!isProtectionPartner(partner) || !acc.partner_reference) {
        await admin.rpc("fin_protection_set_review", { p_offer: acc.offer_id, p_value: true });
        logEvent("prot_accept_no_partner", { offer: acc.offer_id });
        return json({ ok: true, status: "accepted", pending_provider: true }, 202);
      }
      try {
        await partner.acceptProtection({ referenceId: acc.offer_id, partnerReference: acc.partner_reference, disclosureSha256: body.disclosure_sha256 });
        await admin.rpc("fin_protection_set_review", { p_offer: acc.offer_id, p_value: false });
        return json({ ok: true, status: "accepted" });
      } catch (e) {
        await admin.rpc("fin_protection_set_review", { p_offer: acc.offer_id, p_value: true });
        logEvent("prot_accept_partner_error", { partner: partner.key, offer: acc.offer_id, message: e instanceof Error ? e.message.slice(0, 120) : "error" });
        return json({ ok: true, status: "accepted", pending_provider: true }, 202);
      }
    }

    // ---------------------------------------------------------------- account: request quote
    if (body.action !== "request") return json({ error: "Unknown action." }, 400);
    const actor = await authenticate(req, admin);
    if (actor instanceof Response) return actor;
    if (!actor.canManage) return json({ error: "You don't have permission to manage service protection." }, 403);
    if (!isUuid(body.quote_id)) return json({ error: "quote_id is required." }, 400);

    const partnerKey = String(body.partner_key ?? Deno.env.get("PROTECTION_PARTNER_DEFAULT") ?? "");
    const partner = getPartner(partnerKey);
    if (!isProtectionPartner(partner)) return json({ error: "No service-protection provider is configured." }, 422);

    const { data: created, error: createErr } = await admin.rpc("fin_create_protection_offer", {
      p_owner: actor.ownerId, p_actor: actor.userId, p_quote: body.quote_id,
      p_partner_key: partner.key, p_partner_name: partner.capabilities.displayName, p_sandbox: partner.sandbox,
      p_currencies: [...partner.protection.currencies],
      p_min_cents: partner.protection.minQuoteCents ?? null, p_max_cents: partner.protection.maxQuoteCents ?? null, p_ttl_days: 14,
    });
    if (createErr || !created) throw createErr ?? new Error("create failed");
    if (!created.ok) return json({ error: created.error, reason: created.reason, min_cents: created.min_cents, max_cents: created.max_cents }, statusForError(created.error));
    if (created.existing && created.status !== "requested") return json({ offer_id: created.offer_id, existing: true, status: created.status });

    const { data: row } = await admin.from("service_protection_offers").select("covered_amount_cents, currency")
      .eq("id", created.offer_id).eq("user_id", actor.ownerId).maybeSingle();
    if (!row) throw new Error("offer vanished");

    let quote;
    try {
      quote = validateProviderQuote(await partner.requestProtectionQuote({
        referenceId: created.offer_id, amountCents: row.covered_amount_cents, currency: row.currency, description: "Home service quote",
      }));
    } catch (e) {
      await admin.rpc("fin_fail_protection_offer", { p_offer: created.offer_id, p_reason: "partner_error" });
      logEvent("prot_quote_partner_error", { partner: partner.key, offer: created.offer_id, message: e instanceof Error ? e.message.slice(0, 120) : "error" });
      return json({ error: "The provider could not quote this offer. Try again later." }, 502);
    }
    if (!quote) {
      await admin.rpc("fin_fail_protection_offer", { p_offer: created.offer_id, p_reason: "invalid_quote" });
      return json({ error: "The provider returned an incomplete quote, so no offer was created." }, 502);
    }
    const { data: applied } = await admin.rpc("fin_apply_protection_quote", {
      p_offer: created.offer_id, p_reference: quote.partnerReference, p_price_cents: quote.priceCents, p_currency: quote.currency,
      p_term_months: quote.termMonths, p_plan_label: quote.planLabel, p_disclosure: quote.disclosureText,
    });
    if (!applied?.ok) {
      await admin.rpc("fin_fail_protection_offer", { p_offer: created.offer_id, p_reason: String(applied?.error ?? "apply_failed") });
      return json({ error: "The provider's quote could not be stored." }, 502);
    }
    return json({ offer_id: created.offer_id, existing: false, status: "quoted" });
  } catch (error) {
    logEvent("prot_failed", { message: error instanceof Error ? error.message.slice(0, 160) : "error" });
    return json({ error: "Something went wrong with the service-protection offer." }, 500);
  }
});
