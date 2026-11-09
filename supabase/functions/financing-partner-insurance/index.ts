import { getPartner } from "../_shared/financing-partners/registry.ts";
import { INSURANCE_LINES, type InsuranceLine } from "../_shared/financing-partners/types.ts";
import { adminClient, authenticate, corsHeaders, json, logEvent, readJson, statusForError } from "../_shared/financing-partners/http.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = adminClient();
    const actor = await authenticate(req, admin);
    if (actor instanceof Response) return actor;
    if (!actor.canManage) return json({ error: "You don't have permission to manage insurance referrals." }, 403);

    const body = await readJson(req);
    if (!body) return json({ error: "Invalid request." }, 400);
    const line = body.line as InsuranceLine;
    if (!INSURANCE_LINES.includes(line)) return json({ error: "Unsupported insurance line." }, 400);
    const partner = getPartner(String(body.partner_key ?? Deno.env.get("FINANCING_PARTNER_DEFAULT") ?? ""));
    if (!partner || !partner.capabilities.products.includes("insurance_referral")) return json({ error: "No insurance partner is configured." }, 422);

    const { data: ref, error } = await admin.rpc("fin_create_insurance_referral", {
      p_owner: actor.ownerId, p_actor: actor.userId, p_partner_key: partner.key, p_line: line,
      p_acknowledged: body.acknowledged === true,
      p_disclosure_version: typeof body.disclosure_version === "string" ? body.disclosure_version : "",
      p_share_email: body.share_email === true,
    });
    if (error || !ref) throw error ?? new Error("create failed");
    if (!ref.ok) return json({ error: ref.error, reason: ref.reason }, statusForError(ref.error));

    try {
      const res = await partner.createInsuranceReferral({
        referenceId: ref.referral_id, line, businessName: ref.business_name, contactEmail: ref.contact_email ?? null,
      });
      await admin.rpc("fin_attach_insurance_ref", { p_id: ref.referral_id, p_ref: res.partnerReference });
      return json({ referral_id: ref.referral_id });
    } catch (e) {
      await admin.rpc("fin_fail_insurance", { p_id: ref.referral_id, p_reason: "partner_error" });
      logEvent("fin_insurance_partner_error", { partner: partner.key, message: e instanceof Error ? e.message.slice(0, 120) : "error" });
      return json({ error: "The partner could not receive the referral. Try again later." }, 502);
    }
  } catch (error) {
    logEvent("fin_insurance_failed", { message: error instanceof Error ? error.message.slice(0, 160) : "error" });
    return json({ error: "Something went wrong." }, 500);
  }
});
