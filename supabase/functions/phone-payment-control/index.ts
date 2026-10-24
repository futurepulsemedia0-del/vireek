// supabase/functions/phone-payment-control/index.ts
//
// Staff-initiated secure card capture on a live call: { action: "start", vapi_call_id, job_id } or
// { action: "cancel", session_id }. Runs AS the signed-in user for every permission check.
// The browser NEVER sends an amount or a phone number: amount comes from the job balance and the
// reconnect number from the user's own profile.
//
// Deploy: supabase functions deploy phone-payment-control
// Secrets: see docs/pci-pay-by-phone.md

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildPorts, safeLog } from "../_shared/pci/ports.ts";
import { cancelPhonePayment, startPhonePayment } from "../_shared/pci/orchestrator.ts";
import { UUID_RE } from "../_shared/pci/session.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const E164 = /^\+[1-9]\d{6,14}$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const authClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    const [{ data: canLive }, { data: canPay }] = await Promise.all([authClient.rpc("can_view_live_calls"), authClient.rpc("can_view_phone_payments")]);
    if (canLive !== true || canPay !== true) return json({ error: "You need both Live Calls and Billing access to take card payments by phone." }, 403);

    let body: { action?: string; vapi_call_id?: string; job_id?: string; session_id?: string } = {};
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: ownerId } = await authClient.rpc("get_account_owner_id");
    if (typeof ownerId !== "string") return json({ error: "Account not found." }, 403);
    const ports = await buildPorts(admin);

    if (body.action === "cancel") {
      if (!body.session_id || !UUID_RE.test(body.session_id)) return json({ error: "session_id is required." }, 400);
      const r = await cancelPhonePayment(ports, { userId: ownerId, sessionId: body.session_id, actorType: "staff", actorId: user.id });
      return json(r, r.ok ? 200 : 409);
    }

    if (body.action !== "start") return json({ error: "Unknown action." }, 400);
    if (!body.vapi_call_id || typeof body.vapi_call_id !== "string" || !body.job_id || !UUID_RE.test(body.job_id)) {
      return json({ error: "vapi_call_id and job_id are required." }, 400);
    }
    // RLS-scoped read proves this call belongs to the caller's account and is live.
    const { data: live } = await authClient.from("live_calls").select("id, status").eq("vapi_call_id", body.vapi_call_id).maybeSingle();
    if (!live) return json({ error: "Call not found." }, 404);
    if (live.status !== "in_progress") return json({ error: "That call is not in progress any more." }, 409);

    const { data: me } = await authClient.from("profiles").select("phone").eq("id", user.id).maybeSingle();
    const returnTo = typeof me?.phone === "string" && E164.test(me.phone) ? me.phone : null;

    const r = await startPhonePayment(ports, { userId: ownerId, jobId: body.job_id, vapiCallId: body.vapi_call_id, channel: "staff", actorId: user.id, returnToNumber: returnTo });
    if (!r.ok) {
      const status = r.code === "already_in_progress" ? 409 : r.code === "job_not_found" ? 404 : r.code === "internal_error" || r.code === "recording_pause_failed" || r.code === "redirect_failed" ? 502 : 422;
      return json({ ok: false, code: r.code, error: r.message, session_id: r.sessionId ?? null }, status);
    }
    return json({ ok: true, session_id: r.sessionId, amount_cents: r.amountCents, reconnect: returnTo !== null });
  } catch (e) {
    safeLog("phone_payment_control_failed", { error: e instanceof Error ? e.message : String(e) });
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
