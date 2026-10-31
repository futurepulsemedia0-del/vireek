// supabase/functions/ns-connect/index.ts
//
// Connects a NetSuite account with Token-Based Authentication (NOT LIVE-VERIFIED).
//
// NetSuite has no consent screen for TBA: the NetSuite administrator creates an integration record and an
// access token, then pastes four values here. This function:
//   1. verifies the caller (JWT) and can_manage_netsuite(),
//   2. validates the pasted credentials,
//   3. proves them with one signed SuiteQL call BEFORE anything is stored,
//   4. stores them ENCRYPTED (AES-256-GCM) in ns_connection_secrets (service role only).
// The credentials never reach a client-readable table, a log line or an error message.
//
// POST JSON { account_id, consumer_key, consumer_secret, token_id, token_secret }
//   -> { ok: true, connection_id, company_name, environment }   |   { error } (4xx / 5xx)
//
// REQUIRED SECRETS: NS_TOKEN_ENCRYPTION_KEY (32 random bytes, base64; falls back to QBO_TOKEN_ENCRYPTION_KEY),
//                   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
// Deploy: supabase functions deploy ns-connect

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { NsAuthError, NsClient, NsFaultError, NsRateLimitError } from "../_shared/netsuite/client.ts";
import { defaultSettings, encryptSecret, environmentFor, validateCredentials } from "../_shared/netsuite/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const encKey = Deno.env.get("NS_TOKEN_ENCRYPTION_KEY") || Deno.env.get("QBO_TOKEN_ENCRYPTION_KEY") || "";
  if (!supabaseUrl || !encKey) return json({ error: "NetSuite is not configured on the server yet. Ask your administrator to set NS_TOKEN_ENCRYPTION_KEY." }, 503);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);
  const caller = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: userData } = await caller.auth.getUser();
  if (!userData?.user) return json({ error: "Not authenticated" }, 401);
  const { data: ownerData } = await caller.rpc("get_account_owner_id");
  if (!ownerData) return json({ error: "Could not resolve your account." }, 401);
  const ownerId = ownerData as string;
  const { data: allowed } = await caller.rpc("can_manage_netsuite");
  if (allowed !== true) return json({ error: "You don't have permission to manage NetSuite sync." }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = validateCredentials({
    accountId: body.account_id,
    consumerKey: body.consumer_key,
    consumerSecret: body.consumer_secret,
    tokenId: body.token_id,
    tokenSecret: body.token_secret,
  });
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const creds = parsed.credentials;

  // 1. Prove the credentials work before storing anything.
  const client = new NsClient({ credentials: creds, maxAttempts: 2 });
  try {
    await client.suiteql("SELECT id FROM customer", 1, 0);
  } catch (err) {
    if (err instanceof NsAuthError) return json({ error: "NetSuite rejected those credentials. Check the account ID, consumer key and secret, token ID and secret, and that the token is active." }, 422);
    if (err instanceof NsRateLimitError) return json({ error: "NetSuite is rate limiting requests. Try again in a minute." }, 429);
    if (err instanceof NsFaultError && err.kind === "permission") {
      return json({ error: "The token's role is missing permissions. Give it REST Web Services, Log in using Access Tokens, SuiteAnalytics Workbook and the record permissions for customers, items, invoices and payments." }, 422);
    }
    console.error(JSON.stringify({ event: "ns_connect_probe_failed", owner: ownerId, error: err instanceof Error ? err.message.slice(0, 200) : "unknown" }));
    return json({ error: "Could not reach NetSuite with those details. Check the account ID and that REST Web Services is enabled." }, 502);
  }

  // 2. Company name (non-fatal: OneWorld accounts only).
  let companyName: string | null = null;
  try {
    const page = await client.suiteql("SELECT name FROM subsidiary WHERE isElimination = 'F' ORDER BY id", 1, 0);
    const n = page.rows[0]?.name;
    if (typeof n === "string" && n.trim()) companyName = n.trim().slice(0, 120);
  } catch {
    /* not OneWorld, or no permission: fine */
  }
  const environment = environmentFor(creds.accountId);

  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  try {
    const { data: existing } = await admin.from("ns_connections").select("id, account_id, settings, cursors").eq("user_id", ownerId).maybeSingle();
    const sameAccount = existing?.account_id === creds.accountId;
    const hasSettings = existing?.settings && typeof existing.settings === "object" && "entities" in (existing.settings as object);

    let connectionId: string;
    if (existing) {
      connectionId = existing.id as string;
      // A different NetSuite account: the old links point at records that do not exist there.
      if (!sameAccount) await admin.from("ns_record_links").delete().eq("connection_id", connectionId);
      const { error } = await admin
        .from("ns_connections")
        .update({
          account_id: creds.accountId,
          environment,
          status: "connected",
          company_name: companyName,
          connected_by: userData.user.id,
          last_error: null,
          sync_locked_until: null,
          settings: hasSettings && sameAccount ? existing.settings : defaultSettings(),
          cursors: sameAccount ? existing.cursors : {},
        })
        .eq("id", connectionId);
      if (error) throw error;
    } else {
      const { data: created, error } = await admin
        .from("ns_connections")
        .insert({ user_id: ownerId, account_id: creds.accountId, environment, status: "connected", company_name: companyName, connected_by: userData.user.id, settings: defaultSettings() })
        .select("id")
        .single();
      if (error || !created) throw error ?? new Error("insert_failed");
      connectionId = created.id as string;
    }

    const blob = JSON.stringify({ consumerKey: creds.consumerKey, consumerSecret: creds.consumerSecret, tokenId: creds.tokenId, tokenSecret: creds.tokenSecret });
    const { error: secErr } = await admin
      .from("ns_connection_secrets")
      .upsert({ connection_id: connectionId, user_id: ownerId, credentials_enc: await encryptSecret(blob, encKey), updated_at: new Date().toISOString() }, { onConflict: "connection_id" });
    if (secErr) throw secErr;

    // Status mirror for the Integrations page + Overview health strip. Metadata only, never credentials.
    await admin.from("integrations").upsert(
      { user_id: ownerId, integration_type: "netsuite", status: "connected", config: { account_id: creds.accountId, company_name: companyName, environment, connected_at: new Date().toISOString() } },
      { onConflict: "user_id,integration_type" },
    );

    return json({ ok: true, connection_id: connectionId, company_name: companyName, environment });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "ns_connect_store_failed", owner: ownerId, error: message.slice(0, 300) }));
    // Unique index uq_ns_connections_live_account: this NetSuite account is already linked to another Vireek account.
    if (/uq_ns_connections_live_account|duplicate key/i.test(message)) return json({ error: "That NetSuite account is already connected to another Vireek account." }, 409);
    return json({ error: "Could not save the NetSuite connection. Please try again." }, 500);
  }
});
