// supabase/functions/backfill-claim/index.ts
//
// Public (token-gated) endpoint behind the SMS claim link  <SITE_URL>/claim/<token>.
//   POST { action: "preview", token }  -> read-only: slot time + whether it is still claimable (SAFE for link scanners)
//   POST { action: "claim",   token }  -> first valid claim wins (claim_backfill_offer: row-locked, idempotent)
// The claim is POST-only and requires a click on the page, so SMS link previews / carrier scanners can never claim a slot.
// Deploy: supabase functions deploy backfill-claim --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { hashToken } from "../_shared/capacity-guard/engine.ts";
import { formatSlotLocal } from "../_shared/booking/capacityEngine.ts";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...cors, "Content-Type": "application/json" } });
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

const hits = new Map<string, { n: number; reset: number }>();
function limited(ip: string, max = 30): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) { hits.set(ip, { n: 1, reset: now + 60_000 }); if (hits.size > 5000) hits.clear(); return false; }
  h.n += 1;
  return h.n > max;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (limited((req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim())) return json({ error: "Too many requests" }, 429);

  let body: { action?: string; token?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (typeof body.token !== "string" || !TOKEN_RE.test(body.token)) return json({ status: "invalid" });
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const hash = await hashToken(body.token);

  try {
    const { data: offer } = await admin.from("backfill_offers").select("id, gap_id, user_id, status, expires_at, customer_name, phone_norm").eq("token_hash", hash).maybeSingle();
    if (!offer) return json({ status: "invalid" });
    const { data: gap } = await admin.from("backfill_gaps").select("id, status, slot_start, service_type, technician_id").eq("id", offer.gap_id).maybeSingle();
    const { data: bp } = await admin.from("business_profile").select("timezone").eq("user_id", offer.user_id).maybeSingle();
    const tz = (bp as { timezone?: string } | null)?.timezone || "UTC";
    if (!gap) return json({ status: "invalid" });

    if (body.action === "preview") {
      const claimable = offer.status === "sent" && ["open", "offered"].includes(gap.status as string) && Date.parse(offer.expires_at as string) > Date.now() && Date.parse(gap.slot_start as string) > Date.now();
      return json({ status: offer.status === "claimed" ? "claimed" : claimable ? "available" : gap.status === "filled" ? "already_filled" : "expired",
        slot_label: formatSlotLocal(Date.parse(gap.slot_start as string), tz), service_type: gap.service_type ?? null, expires_at: offer.expires_at });
    }
    if (body.action !== "claim") return json({ error: "Unknown action" }, 400);

    const { data, error } = await admin.rpc("claim_backfill_offer", { p_token_hash: hash });
    if (error) { console.error(JSON.stringify({ event: "backfill_claim_rpc_failed", error: error.message })); return json({ status: "error" }, 500); }
    const res = (data ?? {}) as { status: string; job_id?: string; idempotent?: boolean; technician_id?: string };
    if (res.status !== "claimed") return json({ status: res.status });
    const slotLabel = formatSlotLocal(Date.parse(gap.slot_start as string), tz);
    if (!res.idempotent) {
      // Notify exactly once: only the request that actually won sends confirmations.
      const { data: tech } = await admin.from("team_members").select("member_phone").eq("id", gap.technician_id).eq("account_owner_id", offer.user_id).maybeSingle();
      const techPhone = (tech as { member_phone?: string } | null)?.member_phone;
      if (techPhone) await sendCompliantSms(admin, offer.user_id as string, techPhone, `New job added to your schedule: ${slotLabel}${gap.service_type ? " - " + gap.service_type : ""} (filled from a cancellation).`, { purpose: "service", source: "backfill-claim-tech", dedupeKey: `bf-tech:${res.job_id}` });
      await sendCompliantSms(admin, offer.user_id as string, offer.phone_norm as string, `You're booked for ${slotLabel}. We'll text you before we arrive.`, { purpose: "service", source: "backfill-claim-confirm", dedupeKey: `bf-confirm:${res.job_id}` });
    }
    return json({ status: "claimed", slot_label: slotLabel });
  } catch (e) {
    console.error(JSON.stringify({ event: "backfill_claim_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ status: "error" }, 500);
  }
});
