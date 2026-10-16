// supabase/functions/csr-call-transfer/index.ts
//
// Live-transfers an in-progress Vapi call to a human from the CSR desk
// (/dashboard/csr-desk). Flow:
//   1. Authenticate the dashboard user (JWT) and resolve the account owner.
//   2. Load the call through the USER's RLS context — a CSR can only transfer
//      calls that belong to their own account.
//   3. Resolve the destination server-side (team member phone or the account's
//      forwarding number). The client only sends an id, never a raw number, so
//      this endpoint can't be used to dial arbitrary numbers.
//   4. Look up the call's control URL at Vapi and issue a `transfer` command.
//   5. Record the escalation on the call row and in csr_call_actions (audit).
//
// Required secrets (already used elsewhere in this project):
//   VAPI_PRIVATE_KEY            Vapi private API key
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY   (auto-provided)
//
// Deploy:  supabase functions deploy csr-call-transfer

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const VAPI_CALL_URL = "https://api.vapi.ai/call";
const E164 = /^\+[1-9]\d{7,14}$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (E164.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

interface Body {
  call_id?: string;
  target?: { type: "forwarding" } | { type: "team_member"; id: string };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ success: false, error: "Unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ success: false, error: "Unauthorized" }, 401);
  const actorId = userData.user.id;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "Invalid JSON" }, 400);
  }
  if (!body.call_id || !body.target) return json({ success: false, error: "call_id and target are required" }, 400);

  // RLS-scoped read: returns nothing for another account's call.
  const { data: call, error: callErr } = await userClient
    .from("calls")
    .select("id, user_id, vapi_call_id, duration_seconds")
    .eq("id", body.call_id)
    .maybeSingle();
  if (callErr || !call) return json({ success: false, error: "Call not found" }, 404);
  if (call.duration_seconds != null) return json({ success: false, error: "This call has already ended" }, 409);
  if (!call.vapi_call_id) return json({ success: false, error: "Call is not connected to the voice provider" }, 409);

  const ownerId = call.user_id as string;

  // ---- resolve destination server-side
  let destination: string | null = null;
  let destinationLabel = "Main line";
  if (body.target.type === "team_member") {
    const { data: member } = await admin
      .from("team_members")
      .select("member_name, member_phone")
      .eq("id", body.target.id)
      .eq("account_owner_id", ownerId)
      .maybeSingle();
    destination = toE164(member?.member_phone);
    destinationLabel = member?.member_name || "Team member";
  } else {
    const { data: owner } = await admin.from("profiles").select("forwarding_number").eq("id", ownerId).maybeSingle();
    destination = toE164(owner?.forwarding_number);
  }
  if (!destination) {
    return json({ success: false, error: "No valid phone number is configured for that destination" }, 422);
  }

  const vapiKey = Deno.env.get("VAPI_PRIVATE_KEY");
  if (!vapiKey) return json({ success: false, error: "Voice provider is not configured" }, 500);

  const audit = (status: "success" | "failed", detail: Record<string, unknown>) =>
    admin.from("csr_call_actions").insert({
      user_id: ownerId,
      actor_id: actorId,
      call_id: call.id,
      action: "transfer",
      status,
      detail: { destination_label: destinationLabel, ...detail },
    });

  try {
    const callRes = await fetch(`${VAPI_CALL_URL}/${encodeURIComponent(call.vapi_call_id)}`, {
      headers: { Authorization: `Bearer ${vapiKey}` },
    });
    if (!callRes.ok) throw new Error(`Vapi call lookup failed (${callRes.status})`);
    const vapiCall = await callRes.json();
    const controlUrl: string | undefined = vapiCall?.monitor?.controlUrl;
    if (!controlUrl) throw new Error("This call cannot be controlled (it may have just ended)");

    const ctrlRes = await fetch(controlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "transfer",
        destination: { type: "number", number: destination },
        content: "One moment, I'm connecting you with a member of our team.",
      }),
    });
    if (!ctrlRes.ok) throw new Error(`Vapi transfer failed (${ctrlRes.status})`);

    await admin
      .from("calls")
      .update({ escalated_to: destinationLabel, escalated_at: new Date().toISOString() })
      .eq("id", call.id);
    await audit("success", {});
    return json({ success: true, destination_label: destinationLabel });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transfer failed";
    await audit("failed", { error: message });
    return json({ success: false, error: message }, 502);
  }
});
