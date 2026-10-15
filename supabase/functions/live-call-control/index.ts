// supabase/functions/live-call-control/index.ts
//
// "Take over" / "Transfer to team" for a call that is happening right now.
// Runs AS the authenticated user (anon key + their JWT) for every check, and
// only then uses the service role for the audited state change.
//
// The browser sends ONLY { vapi_call_id, mode }. The destination phone
// number is always resolved here on the server — a client can never make
// Vireek dial an arbitrary number.
//   take_over -> the signed-in user's own profile phone
//   transfer  -> business escalation rule "human_request", else the owner's
//                forwarding number
//
// NOT LIVE-VERIFIED (same caveat as vapi-webhook): the Vapi live-call-control
// request shape below (`monitor.controlUrl` + `{ type: "transfer", ... }`)
// follows Vapi's documented "Live Call Control" API. Test once on a real
// call and adjust `transferCall()` if Vapi has changed it.
//
// Required secrets: VAPI_PRIVATE_KEY (already used by outbound-dialer).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isValidE164, maskNumber, type HandoffMode } from "../_shared/live-calls/logic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });

const VAPI_CALL_URL = "https://api.vapi.ai/call";
const HANDOFF_LINE = "One moment please, I'm connecting you with a team member now.";

interface EscalationRule {
  trigger?: string;
  action?: string;
  target?: string;
}

async function transferCall(vapiKey: string, vapiCallId: string, number: string): Promise<void> {
  const callRes = await fetch(`${VAPI_CALL_URL}/${encodeURIComponent(vapiCallId)}`, {
    headers: { Authorization: `Bearer ${vapiKey}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!callRes.ok) throw new Error(`Vapi call lookup failed (${callRes.status})`);
  const call = (await callRes.json()) as { monitor?: { controlUrl?: string } };
  const controlUrl = call.monitor?.controlUrl;
  if (!controlUrl) throw new Error("This call has no live control channel (it may have just ended).");

  // Only ever POST to Vapi's own control host.
  const url = new URL(controlUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".vapi.ai")) {
    throw new Error("Unexpected control URL.");
  }

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "transfer", destination: { type: "number", number }, content: HANDOFF_LINE }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Vapi transfer failed (${res.status})`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const authClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });

    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    const { data: allowed, error: permErr } = await authClient.rpc("can_view_live_calls");
    if (permErr) throw permErr;
    if (allowed !== true) return json({ error: "You don't have permission to manage live calls." }, 403);

    let body: { vapi_call_id?: string; mode?: string } = {};
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body." }, 400);
    }
    const mode = body.mode as HandoffMode;
    if (mode !== "take_over" && mode !== "transfer") return json({ error: "Unknown mode." }, 400);
    if (!body.vapi_call_id || typeof body.vapi_call_id !== "string") return json({ error: "vapi_call_id is required." }, 400);

    // RLS-scoped read: proves this call belongs to the caller's account.
    const { data: live, error: liveErr } = await authClient
      .from("live_calls")
      .select("id, user_id, status, handoff_status")
      .eq("vapi_call_id", body.vapi_call_id)
      .maybeSingle();
    if (liveErr) throw liveErr;
    if (!live) return json({ error: "Call not found." }, 404);
    if (live.status !== "in_progress") return json({ error: "That call is not in progress any more." }, 409);

    // Authorization is proven above (RLS read of this exact call). From here the
    // service role is used only for the owner's settings, which a team member
    // may not be able to read directly, and for the audited state change.
    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });

    // ---- Resolve the destination on the server ----
    let destination: string | null = null;
    if (mode === "take_over") {
      const { data: me } = await authClient.from("profiles").select("phone").eq("id", user.id).maybeSingle();
      destination = me?.phone ?? null;
      if (!isValidE164(destination)) {
        return json({ error: "Add your own mobile number in Account settings (international format, e.g. +15551234567) to take over calls." }, 422);
      }
    } else {
      const [{ data: owner }, { data: bp }] = await Promise.all([
        admin.from("profiles").select("forwarding_number").eq("id", live.user_id).maybeSingle(),
        admin.from("business_profile").select("escalation_rules").eq("user_id", live.user_id).maybeSingle(),
      ]);
      const rules = (bp?.escalation_rules ?? []) as EscalationRule[];
      const rule = rules.find((r) => r.trigger === "human_request" && r.action === "transfer" && isValidE164(r.target));
      destination = rule?.target ?? owner?.forwarding_number ?? null;
      if (!isValidE164(destination)) {
        return json({ error: "No team transfer number is set. Add a forwarding number in your business settings." }, 422);
      }
    }

    const vapiKey = Deno.env.get("VAPI_PRIVATE_KEY");
    if (!vapiKey) return json({ error: "Live call control is not configured on the server." }, 500);

    // Atomic claim: only one person can start a hand-off for this call at a time.
    const now = new Date().toISOString();
    const { data: claimed, error: claimErr } = await admin
      .from("live_calls")
      .update({ handoff_status: "requested", handoff_mode: mode, handoff_by: user.id, handoff_at: now, handoff_error: null, updated_at: now })
      .eq("id", live.id)
      .eq("status", "in_progress")
      .neq("handoff_status", "requested")
      .select("id")
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claimed) return json({ error: "A hand-off is already in progress for this call." }, 409);

    try {
      await transferCall(vapiKey, body.vapi_call_id, destination as string);
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 200) : "Transfer failed.";
      await admin
        .from("live_calls")
        .update({ handoff_status: "failed", handoff_error: message, updated_at: new Date().toISOString() })
        .eq("id", live.id);
      console.error("live_call_transfer_failed", message);
      return json({ error: "Could not transfer the call. It may have just ended — check the call and try again." }, 502);
    }

    await admin.from("audit_log").insert({
      user_id: live.user_id,
      actor_id: user.id,
      actor_email: user.email ?? null,
      action: `live_call.${mode}`,
      target_table: "live_calls",
      target_id: live.id,
    });

    return json({ ok: true, mode, destination_hint: maskNumber(destination as string) });
  } catch (err) {
    console.error("live-call-control failed", err instanceof Error ? err.message : err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
