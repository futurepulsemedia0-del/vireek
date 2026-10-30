// supabase/functions/intacct-connect/index.ts
//
// Connects a Sage Intacct company (NOT LIVE-VERIFIED). Intacct web services use a sender id (Vireek's own
// partner credentials) plus per-company user credentials, not OAuth, so the browser posts them here once.
// They are verified with a real getAPISession call, then stored AES-256-GCM encrypted. The browser can
// never read them back.
//
// POST JSON (user JWT):  { company_id, user_id, password, entity_id? }  ->  { ok, connection_id }
//
// REQUIRED SECRETS (supabase secrets set NAME=value):
//   INTACCT_SENDER_ID, INTACCT_SENDER_PASSWORD   Web Services sender credentials issued to Vireek by Sage
//   INTACCT_ENCRYPTION_KEY                       $(openssl rand -base64 32)   AES-256 key for credentials
//   CRON_SECRET                                  $(openssl rand -hex 32)      lets pg_cron call intacct-sync-run
// In Sage Intacct, the customer creates a dedicated Web Services user and authorises Vireek's sender id
// under Company > Setup > Company > Security > Web Services authorizations.
//
// Deploy: supabase functions deploy intacct-connect

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { IaAuthError, IaThrottleError, IaTransportError, IntacctClient } from "../_shared/intacct/client.ts";
import { encryptSecret, isValidCompanyId, isValidEntityId, isValidPassword, isValidUserId } from "../_shared/intacct/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "Missing Authorization header." }, 401);
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: userData, error: userErr } = await caller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Invalid or expired session." }, 401);
    const { data: ownerId } = await caller.rpc("get_account_owner_id");
    if (!ownerId) return json({ error: "Could not resolve your account." }, 401);
    const { data: allowed } = await caller.rpc("can_manage_intacct");
    if (allowed !== true) return json({ error: "You don't have permission to connect Sage Intacct." }, 403);

    const senderId = Deno.env.get("INTACCT_SENDER_ID") ?? "";
    const senderPassword = Deno.env.get("INTACCT_SENDER_PASSWORD") ?? "";
    const encKey = Deno.env.get("INTACCT_ENCRYPTION_KEY") ?? "";
    if (!senderId || !senderPassword || !encKey) return json({ error: "Sage Intacct isn't configured on the server yet. Ask your administrator to set the Sage Intacct secrets." }, 500);

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    const companyId = typeof body.company_id === "string" ? body.company_id.trim() : "";
    const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const entityId = typeof body.entity_id === "string" && body.entity_id.trim() ? body.entity_id.trim() : null;
    if (!isValidCompanyId(companyId)) return json({ error: "Enter a valid Sage Intacct company ID." }, 400);
    if (!isValidUserId(userId)) return json({ error: "Enter a valid web services user ID." }, 400);
    if (!isValidPassword(password)) return json({ error: "Enter the web services user's password." }, 400);
    if (entityId !== null && !isValidEntityId(entityId)) return json({ error: "Enter a valid entity ID, or leave it empty for the top level." }, 400);

    // Prove the credentials with a real session request before storing anything.
    const client = new IntacctClient({ senderId, senderPassword, credentials: { companyId, userId, password, entityId }, maxAttempts: 2 });
    let session;
    try {
      session = await client.ensureSession();
    } catch (e) {
      if (e instanceof IaAuthError) return json({ error: `Sage Intacct rejected the sign-in: ${e.message}` }, 400);
      if (e instanceof IaThrottleError) return json({ error: "Sage Intacct is busy. Please try again in a minute." }, 503);
      if (e instanceof IaTransportError) return json({ error: "Could not reach Sage Intacct. Please try again." }, 502);
      throw e;
    }

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const owner = ownerId as string;

    // The same Intacct company (+ entity) cannot serve two Vireek accounts.
    const { data: others } = await admin.from("intacct_connections").select("entity_id").eq("company_id", companyId).neq("status", "disconnected").neq("user_id", owner);
    if (((others ?? []) as { entity_id: string | null }[]).some((o) => (o.entity_id ?? null) === entityId)) {
      return json({ error: "That Sage Intacct company is already connected to another Vireek account." }, 409);
    }

    const credentialsEnc = await encryptSecret(JSON.stringify({ userId, password }), encKey);
    const sessionEnc = await encryptSecret(session.id, encKey);

    const { data: existing } = await admin.from("intacct_connections").select("id").eq("user_id", owner).maybeSingle();
    let connectionId = (existing as { id: string } | null)?.id ?? null;
    const row = { company_id: companyId, entity_id: entityId, status: "connected", last_error: null, sync_locked_until: null, cursors: {}, connected_by: userData.user.id };
    if (connectionId) {
      const { error } = await admin.from("intacct_connections").update(row).eq("id", connectionId);
      if (error) return json({ error: "Could not save the connection." }, 500);
    } else {
      const { data, error } = await admin.from("intacct_connections").insert({ ...row, user_id: owner }).select("id").single();
      if (error || !data) {
        console.error(JSON.stringify({ event: "intacct_connect_insert_failed", error: error?.message }));
        return json({ error: /unique|duplicate/i.test(error?.message ?? "") ? "That Sage Intacct company is already connected to another Vireek account." : "Could not save the connection." }, /unique|duplicate/i.test(error?.message ?? "") ? 409 : 500);
      }
      connectionId = (data as { id: string }).id;
    }
    const { error: secErr } = await admin.from("intacct_connection_secrets").upsert({
      connection_id: connectionId, user_id: owner, credentials_enc: credentialsEnc, session_enc: sessionEnc,
      session_endpoint: session.endpoint, session_expires_at: new Date(session.expiresAt).toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: "connection_id" });
    if (secErr) return json({ error: "Could not store the credentials securely." }, 500);

    await admin.from("integrations").upsert(
      { user_id: owner, integration_type: "sage_intacct", status: "connected", config: { company_id: companyId, entity_id: entityId } },
      { onConflict: "user_id,integration_type" },
    );
    return json({ ok: true, connection_id: connectionId });
  } catch (error) {
    console.error(JSON.stringify({ event: "intacct_connect_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong connecting Sage Intacct." }, 500);
  }
});
