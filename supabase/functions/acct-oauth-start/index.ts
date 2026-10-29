// supabase/functions/acct-oauth-start/index.ts
//
// Starts (or, for NetSuite, completes) the connection to Xero, Zoho Books or NetSuite.
// The browser calls this with the user's JWT.
//   Xero / Zoho Books : returns { url } = the provider's consent page (OAuth 2.0 authorization code).
//   NetSuite          : machine-to-machine, no redirect. { provider, account_id, client_id, certificate_id } is
//                       verified against NetSuite right away and the connection is created: returns { connected: true }.
//   { action: "certificate" } returns the public certificate the customer uploads in NetSuite.
//
// REQUIRED SECRETS (supabase secrets set NAME=value):
//   ACCT_STATE_SECRET             $(openssl rand -hex 32)      signs the OAuth `state` (10-minute lifetime)
//   ACCT_TOKEN_ENCRYPTION_KEY     $(openssl rand -base64 32)   AES-256 key that encrypts tokens at rest
//   CRON_SECRET                   $(openssl rand -hex 32)      lets pg_cron / acct-webhook call acct-sync-run
//   SITE_URL                      https://vireek.com           where the callback sends the user back to
//   XERO_CLIENT_ID / XERO_CLIENT_SECRET            developer.xero.com > app > Configuration
//   XERO_WEBHOOK_KEY                               (optional) app > Webhooks > signing key, enables near-real-time sync
//   XERO_SCOPES                                    (optional) default: offline_access accounting.contacts accounting.settings accounting.invoices accounting.payments
//                                                  Apps created BEFORE 2 March 2026 may still use the broad `accounting.transactions` scope.
//   ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET            api-console.zoho.com > Server-based Application (use the same credentials for all data centres)
//   NETSUITE_M2M_PRIVATE_KEY                       PKCS#8 PEM private key Vireek signs the client assertion with
//   NETSUITE_M2M_CERT_PEM                          the matching public certificate (shown to the customer to upload in NetSuite)
//   NETSUITE_M2M_ALG                               (optional) ES256 (default) or PS256
//
// REDIRECT URI to register (Xero and Zoho), exactly:
//   https://<project-ref>.supabase.co/functions/v1/acct-oauth-callback
//
// Deploy: supabase functions deploy acct-oauth-start

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { defaultSettings, encryptSecret, isProvider, parseTokenResponse, signOAuthState, type AcctProvider } from "../_shared/accounting/core.ts";
import { PROVIDERS } from "../_shared/accounting/registry.ts";
import { nsBase, nsNormalizeAccountId } from "../_shared/accounting/netsuite.ts";
import { isZohoRegion, ZOHO_DEFAULT_SCOPES } from "../_shared/accounting/zoho.ts";
import { XERO_DEFAULT_SCOPES } from "../_shared/accounting/xero.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const NS_ID = /^[A-Za-z0-9_.-]{8,200}$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "Missing Authorization header." }, 401);
    const caller = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: userData, error: userErr } = await caller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Invalid or expired session." }, 401);
    const { data: ownerId } = await caller.rpc("get_account_owner_id");
    if (!ownerId) return json({ error: "Could not resolve your account." }, 401);
    const { data: allowed } = await caller.rpc("can_manage_accounting");
    if (allowed !== true) return json({ error: "You don't have permission to connect an accounting system." }, 403);

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* empty body */ }
    const provider = body.provider as unknown;
    if (!isProvider(provider)) return json({ error: "Unknown accounting system." }, 400);
    const p = PROVIDERS[provider];

    if (provider === "netsuite" && body.action === "certificate") {
      const pem = Deno.env.get("NETSUITE_M2M_CERT_PEM");
      return pem ? json({ certificate: pem, algorithm: Deno.env.get("NETSUITE_M2M_ALG") === "PS256" ? "PS256" : "ES256" }) : json({ error: "NetSuite is not configured on the server yet. Ask your administrator." }, 500);
    }

    const stateSecret = Deno.env.get("ACCT_STATE_SECRET");
    const encKey = Deno.env.get("ACCT_TOKEN_ENCRYPTION_KEY");
    const clientId = Deno.env.get(`${p.auth.envPrefix}_CLIENT_ID`);
    const notConfigured = () => json({ error: "This connection isn't configured on the server yet. Ask your administrator to set the accounting secrets." }, 500);
    if (!stateSecret || !encKey) return notConfigured();

    // ---- NetSuite: machine to machine ---------------------------------------
    if (provider === "netsuite") {
      const accountId = typeof body.account_id === "string" ? nsNormalizeAccountId(body.account_id) : null;
      const cid = typeof body.client_id === "string" ? body.client_id.trim() : "";
      const cert = typeof body.certificate_id === "string" ? body.certificate_id.trim() : "";
      if (!accountId) return json({ error: "Enter your NetSuite account ID, for example 1234567 or 1234567_SB1." }, 400);
      if (!NS_ID.test(cid)) return json({ error: "Enter the Client ID of your NetSuite integration record." }, 400);
      if (!NS_ID.test(cert)) return json({ error: "Enter the Certificate ID from the OAuth 2.0 Client Credentials (M2M) setup." }, 400);
      const pem = Deno.env.get("NETSUITE_M2M_PRIVATE_KEY");
      if (!pem) return notConfigured();

      const info = { provider, tenantId: accountId, region: null, config: { client_id: cid, certificate_id: cert } };
      const tokenReq = await p.auth.tokenRequest("client", { clientId: cid, clientSecret: "", c: info, certificateId: cert, privateKeyPem: pem, alg: Deno.env.get("NETSUITE_M2M_ALG") ?? "ES256" });
      if (!p.auth.isAllowedTokenUrl(tokenReq.url, info)) return json({ error: "Invalid NetSuite account ID." }, 400);
      const tr = await fetch(tokenReq.url, { method: "POST", headers: tokenReq.headers, body: tokenReq.body });
      const tj = await tr.json().catch(() => ({}));
      if (!tr.ok) {
        const why = String((tj as Record<string, unknown>).error_description ?? (tj as Record<string, unknown>).error ?? "");
        return json({ error: `NetSuite refused the credentials${why ? ` (${why.slice(0, 120)})` : ""}. Check the Client ID, Certificate ID and that the certificate was uploaded.` }, 400);
      }
      const tokens = parseTokenResponse(tj);
      // Prove the role can use the REST API before saving anything.
      const probe = await fetch(`${nsBase(accountId)}/record/v1/customer?limit=1`, { headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" } });
      if (!probe.ok) return json({ error: "Connected, but the NetSuite role cannot read customers over REST. Enable REST Web Services and give the role the Customer permission." }, 400);
      return await saveConnection({ ownerId: ownerId as string, userId: userData.user.id, provider, tenantId: accountId, region: null, config: info.config, companyName: `NetSuite ${accountId}`, tokens, encKey, currency: null });
    }

    // ---- Xero / Zoho Books: OAuth redirect -----------------------------------
    if (!clientId || !Deno.env.get(`${p.auth.envPrefix}_CLIENT_SECRET`)) return notConfigured();
    const region = provider === "zoho_books" ? (isZohoRegion(body.region) ? body.region : "com") : null;
    const state = await signOAuthState({ owner: ownerId as string, user: userData.user.id, provider, region }, stateSecret);
    const scopes = provider === "xero" ? Deno.env.get("XERO_SCOPES") || XERO_DEFAULT_SCOPES : ZOHO_DEFAULT_SCOPES;
    const url = p.auth.authorizeUrl!({ clientId, redirectUri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/acct-oauth-callback`, state, region, scopes });
    return json({ url });
  } catch (error) {
    console.error(JSON.stringify({ event: "acct_oauth_start_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong starting the connection." }, 500);
  }
});

/** Creates / updates the connection + encrypted secrets (shared shape with acct-oauth-callback). */
async function saveConnection(a: {
  ownerId: string; userId: string; provider: AcctProvider; tenantId: string; region: string | null; config: Record<string, unknown>; companyName: string | null;
  tokens: ReturnType<typeof parseTokenResponse>; encKey: string; currency: string | null;
}): Promise<Response> {
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  try {
    const { data: existing } = await admin.from("acct_connections").select("id, tenant_id, settings, cursors").eq("user_id", a.ownerId).eq("provider", a.provider).maybeSingle();
    const same = existing?.tenant_id === a.tenantId;
    const fresh = defaultSettings(a.provider);
    if (a.currency && /^[A-Z]{3}$/.test(a.currency)) fresh.defaults.currency = a.currency;
    const hasSettings = existing?.settings && typeof existing.settings === "object" && "entities" in (existing.settings as object);
    const refreshExp = a.tokens.refreshExpiresInSec ? new Date(Date.now() + a.tokens.refreshExpiresInSec * 1000).toISOString() : null;
    let id: string;
    if (existing) {
      id = existing.id as string;
      if (!same) await admin.from("acct_record_links").delete().eq("connection_id", id);
      const { error } = await admin.from("acct_connections").update({
        tenant_id: a.tenantId, region: a.region, config: a.config, status: "connected", company_name: a.companyName, connected_by: a.userId, last_error: null, sync_locked_until: null,
        refresh_token_expires_at: refreshExp, settings: hasSettings && same ? existing.settings : fresh, cursors: same ? existing.cursors : {},
      }).eq("id", id);
      if (error) throw error;
    } else {
      const { data: created, error } = await admin.from("acct_connections").insert({
        user_id: a.ownerId, provider: a.provider, tenant_id: a.tenantId, region: a.region, config: a.config, status: "connected", company_name: a.companyName, connected_by: a.userId,
        refresh_token_expires_at: refreshExp, settings: fresh,
      }).select("id").single();
      if (error || !created) throw error ?? new Error("insert_failed");
      id = created.id as string;
    }
    const { error: secErr } = await admin.from("acct_connection_secrets").upsert({
      connection_id: id, user_id: a.ownerId,
      access_token_enc: await encryptSecret(a.tokens.accessToken, a.encKey),
      refresh_token_enc: a.tokens.refreshToken ? await encryptSecret(a.tokens.refreshToken, a.encKey) : null,
      expires_at: a.tokens.expiresInSec ? new Date(Date.now() + a.tokens.expiresInSec * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "connection_id" });
    if (secErr) throw secErr;
    await admin.from("integrations").upsert({ user_id: a.ownerId, integration_type: a.provider, status: "connected", config: { tenant_id: a.tenantId, company_name: a.companyName, connected_at: new Date().toISOString() } }, { onConflict: "user_id,integration_type" });
    return json({ connected: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "acct_connect_save_failed", provider: a.provider, error: message }));
    if (/uq_acct_connections_live_tenant|duplicate key/i.test(message)) return json({ error: "That organisation is already connected to another Vireek account." }, 409);
    return json({ error: "Could not save the connection. Please try again." }, 500);
  }
}
