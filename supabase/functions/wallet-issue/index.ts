// supabase/functions/wallet-issue/index.ts
//
// Issues (or re-uses) a wallet pass and optionally texts the customer the "Add to Wallet" link.
//
//   Staff   (Authorization: user JWT)   { action: "issue", kind, subject_id, timezone?, send_sms?, phone? }
//   Portal  (anon key + portal token)   { action: "portal", portal_token, kind, subject_id, timezone? }
//   -> { id, share_token, url, sms?: { ok, message } }
//
// Authorization for staff is enforced INSIDE the wallet_issue_pass RPC (account scoping, billing for gift cards,
// own-badge-only for non-managers). SMS goes through sendCompliantSms (A2P + STOP/DNC + quiet hours).
// DEPLOY: supabase functions deploy wallet-issue      (JWT verification ON; the portal sends the anon key)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { normalizePhone } from "../_shared/compliance/dncCheck.ts";
import { readWalletEnv } from "../_shared/wallet/config.ts";
import { isValidTimezone, isWalletKind, type WalletKind } from "../_shared/wallet/passModel.ts";
import { landingUrl } from "../_shared/wallet/service.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PORTAL_KINDS: WalletKind[] = ["appointment", "membership", "protection"];
const NOUN: Record<WalletKind, string> = {
  appointment: "appointment pass", membership: "membership card", protection: "service protection card", gift_card: "gift card", tech_badge: "technician ID",
};

const SMS_ERRORS: Record<string, string> = {
  A2P_NOT_APPROVED: "SMS isn't approved for this account yet (A2P registration).",
  OPTED_OUT: "This customer opted out of texts.",
  NOT_CONFIGURED: "SMS isn't configured.",
  QUIET_HOURS: "It's quiet hours — the text wasn't sent.",
  TWILIO_ERROR: "The SMS provider rejected the message.",
  QUEUE_ERROR: "Could not queue the text.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: "Server misconfigured" }, 500);

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: "Invalid JSON" }, 400);

  const kind = body.kind;
  const subjectId = body.subject_id;
  if (!isWalletKind(kind) || typeof subjectId !== "string" || !UUID.test(subjectId)) return json({ error: "kind and subject_id are required" }, 400);
  const timezone = isValidTimezone(body.timezone) ? body.timezone : "UTC";

  const env = readWalletEnv();
  if (!env.apple && !env.google) return json({ error: "Wallet passes aren't configured yet. Add the Apple and/or Google Wallet secrets." }, 503);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  try {
    // ---------- customer portal ----------
    if (body.action === "portal") {
      const token = body.portal_token;
      if (typeof token !== "string" || !UUID.test(token) || !PORTAL_KINDS.includes(kind)) return json({ error: "Not available" }, 404);
      const { data, error } = await admin.rpc("wallet_issue_pass_portal", { p_portal_token: token, p_kind: kind, p_subject_id: subjectId, p_timezone: timezone });
      if (error) throw error;
      if (!data) return json({ error: "Not available" }, 404);
      const r = data as { id: string; share_token: string };
      return json({ id: r.id, share_token: r.share_token, url: landingUrl(env, r.share_token) });
    }

    // ---------- staff ----------
    if (body.action !== "issue") return json({ error: "Unknown action" }, 400);
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: "Unauthorized" }, 401);

    const { data, error } = await userClient.rpc("wallet_issue_pass", { p_kind: kind, p_subject_id: subjectId, p_timezone: timezone, p_via: body.send_sms ? "sms" : "dashboard" });
    if (error) return json({ error: error.code === "42501" ? "You don't have access to issue this pass." : error.message }, error.code === "42501" ? 403 : 400);
    const issued = data as { id: string; share_token: string };
    const url = landingUrl(env, issued.share_token);
    const out: Record<string, unknown> = { id: issued.id, share_token: issued.share_token, url };

    if (body.send_sms === true) {
      const phone = typeof body.phone === "string" ? body.phone.trim() : "";
      const normalized = phone ? normalizePhone(phone) : "";
      if (!/^\+\d{10,15}$/.test(normalized)) {
        out.sms = { ok: false, message: "Enter a valid mobile number." };
        return json(out);
      }
      const { data: row } = await admin.from("wallet_passes").select("user_id, customer_id").eq("id", issued.id).single();
      const { data: pl } = await admin.rpc("wallet_pass_payload", { p_pass_id: issued.id });
      const org = String((pl as { org?: { name?: string } } | null)?.org?.name ?? "Your service team");
      const message = `${org}: add your ${NOUN[kind]} to your phone's wallet: ${url} Reply STOP to opt out.`;
      const sms = await sendCompliantSms(admin, String(row?.user_id), normalized, message, {
        purpose: "service", customerId: (row?.customer_id as string | null) ?? null, source: "wallet", dedupeKey: `wallet:${issued.id}`,
      });
      out.sms = sms.ok
        ? { ok: true, message: sms.deferred ? "Queued — it will send when quiet hours end." : "Text sent." }
        : { ok: false, message: SMS_ERRORS[sms.reason] ?? "The text could not be sent." };
    }
    return json(out);
  } catch (e) {
    console.error("wallet-issue error:", e instanceof Error ? e.message : e);
    return json({ error: "Something went wrong" }, 500);
  }
});
