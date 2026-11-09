import { getPartner } from "../_shared/financing-partners/registry.ts";
import { adminClient, authenticate, corsHeaders, isUuid, json, logEvent, readJson, statusForError } from "../_shared/financing-partners/http.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = adminClient();
    const actor = await authenticate(req, admin);
    if (actor instanceof Response) return actor;
    if (!actor.canManage) return json({ error: "You don't have permission to manage financing." }, 403);

    const body = await readJson(req);
    if (!body || !isUuid(body.quote_id)) return json({ error: "quote_id is required." }, 400);
    const partnerKey = String(body.partner_key ?? Deno.env.get("FINANCING_PARTNER_DEFAULT") ?? "");
    const partner = getPartner(partnerKey);
    if (!partner || !partner.capabilities.products.includes("consumer_financing")) {
      return json({ error: "No financing partner is configured." }, 422);
    }

    const { data: created, error: createErr } = await admin.rpc("fin_create_quote_offer", {
      p_owner: actor.ownerId,
      p_actor: actor.userId,
      p_quote: body.quote_id,
      p_partner_key: partner.key,
      p_partner_name: partner.capabilities.displayName,
      p_min_cents: partner.capabilities.minAmountCents ?? null,
      p_max_cents: partner.capabilities.maxAmountCents ?? null,
      p_ttl_days: 14,
    });
    if (createErr || !created) throw createErr ?? new Error("create failed");
    if (!created.ok) return json({ error: created.error, reason: created.reason, min_cents: created.min_cents, max_cents: created.max_cents }, statusForError(created.error));
    if (created.existing && created.has_reference) return json({ offer_id: created.offer_id, existing: true });

    const { data: quote } = await admin.from("quotes").select("quote_token").eq("id", body.quote_id).eq("user_id", actor.ownerId).maybeSingle();
    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

    let application;
    try {
      application = await partner.createApplication({
        referenceId: created.offer_id,
        amountCents: created.amount_cents,
        currency: created.currency ?? "USD",
        description: "Home service quote",
        returnUrl: quote?.quote_token ? `${siteUrl}/quote/${quote.quote_token}` : siteUrl,
      });
    } catch (e) {
      await admin.rpc("fin_fail_offer", { p_offer: created.offer_id, p_reason: "partner_error" });
      logEvent("fin_offer_partner_error", { partner: partner.key, offer: created.offer_id, message: e instanceof Error ? e.message.slice(0, 120) : "error" });
      return json({ error: "The financing partner could not create the offer. Try again later." }, 502);
    }

    const { data: attached } = await admin.rpc("fin_attach_offer_partner_ref", {
      p_offer: created.offer_id, p_ref: application.partnerReference, p_url: application.applicationUrl,
    });
    if (attached !== true) {
      await admin.rpc("fin_fail_offer", { p_offer: created.offer_id, p_reason: "attach_failed" });
      return json({ error: "The partner returned an invalid application link." }, 502);
    }
    return json({ offer_id: created.offer_id, existing: false });
  } catch (error) {
    logEvent("fin_offer_failed", { message: error instanceof Error ? error.message.slice(0, 160) : "error" });
    return json({ error: "Something went wrong creating the financing offer." }, 500);
  }
});
