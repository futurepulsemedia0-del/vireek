import { getPartner } from "../_shared/financing-partners/registry.ts";
import { adminClient, authenticate, corsHeaders, json, logEvent, readJson, statusForError } from "../_shared/financing-partners/http.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = adminClient();
    const actor = await authenticate(req, admin);
    if (actor instanceof Response) return actor;
    if (!actor.isOwner) return json({ error: "Only the account owner can share business data." }, 403);

    const body = await readJson(req);
    const partner = getPartner(String(body?.partner_key ?? Deno.env.get("FINANCING_PARTNER_DEFAULT") ?? ""));
    if (!partner || !partner.capabilities.products.includes("working_capital")) return json({ error: "No working-capital partner is configured." }, 422);

    const { data: prepared, error } = await admin.rpc("fin_prepare_wc_share", {
      p_owner: actor.ownerId, p_actor: actor.userId, p_partner_key: partner.key,
    });
    if (error || !prepared) throw error ?? new Error("prepare failed");
    if (!prepared.ok) return json({ error: prepared.error, reason: prepared.reason }, statusForError(prepared.error));

    try {
      const res = await partner.submitWorkingCapitalSignals({ referenceId: prepared.share_id, signals: prepared.signals });
      await admin.rpc("fin_mark_wc_share", { p_share: prepared.share_id, p_status: "sent", p_ref: res.partnerReference });
      return json({ share_id: prepared.share_id, status: "sent" });
    } catch (e) {
      await admin.rpc("fin_mark_wc_share", { p_share: prepared.share_id, p_status: "failed", p_ref: null });
      logEvent("fin_wc_share_partner_error", { partner: partner.key, message: e instanceof Error ? e.message.slice(0, 120) : "error" });
      return json({ error: "The partner could not receive the data. Nothing further was shared." }, 502);
    }
  } catch (error) {
    logEvent("fin_wc_share_failed", { message: error instanceof Error ? error.message.slice(0, 160) : "error" });
    return json({ error: "Something went wrong." }, 500);
  }
});
