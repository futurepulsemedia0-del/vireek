// supabase/functions/crm-oauth-callback/index.ts
//
// OAuth redirect target for Salesforce, Pipedrive and Zoho CRM (mirrors
// hubspot-oauth-callback). Secrets: see crm-oauth-start/index.ts.
//
// It has no user session, so the signed, 10-minute `state` identifies the account
// owner and the user. Tokens are exchanged server-side, ENCRYPTED, and stored in
// crm_connection_secrets (service role only), never in a client-readable table.
//
// Deploy: supabase functions deploy crm-oauth-callback --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  buildTokenRequest,
  defaultSettings,
  encryptSecret,
  isAllowedZohoAccountsServer,
  parseTokenResponse,
  pkceVerifier,
  verifyOAuthState,
  type CrmProvider,
} from "../_shared/crm/engine.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const back = (params: Record<string, string>) => {
    const dest = new URL(`${siteUrl}/dashboard/crm-sync`);
    for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
    return Response.redirect(dest.toString(), 302);
  };

  const stateSecret = Deno.env.get("CRM_STATE_SECRET") ?? "";
  const encKey = Deno.env.get("CRM_TOKEN_ENCRYPTION_KEY") ?? "";
  const state = url.searchParams.get("state");
  const verified = state && stateSecret ? await verifyOAuthState(state, stateSecret) : null;
  if (!verified) return back({ crm: "error", reason: "invalid_state" });

  const provider: CrmProvider = verified.p;
  const fail = (reason: string) => back({ crm: "error", provider, reason });

  if (url.searchParams.get("error")) return fail("access_denied");
  const code = url.searchParams.get("code");
  if (!code) return fail("missing_code");

  const envName = provider.toUpperCase();
  const clientId = Deno.env.get(`${envName}_CLIENT_ID`) ?? "";
  const clientSecret = Deno.env.get(`${envName}_CLIENT_SECRET`) ?? "";
  if (!clientId || !clientSecret || !encKey) return fail("not_configured");

  try {
    // Zoho redirects to the user's own data centre and says which one. The value is
    // attacker-controllable, so it is only used if it is a genuine Zoho accounts server.
    let authBase: string | undefined;
    if (provider === "salesforce") authBase = Deno.env.get("SALESFORCE_LOGIN_URL") || undefined;
    if (provider === "zoho") {
      const fromZoho = url.searchParams.get("accounts-server");
      authBase = fromZoho && isAllowedZohoAccountsServer(fromZoho) ? fromZoho.replace(/\/+$/, "") : Deno.env.get("ZOHO_ACCOUNTS_URL") || undefined;
    }

    const tokenReq = buildTokenRequest(provider, "code", {
      clientId,
      clientSecret,
      redirectUri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/crm-oauth-callback`,
      code,
      authBase,
      codeVerifier: provider === "salesforce" ? await pkceVerifier(stateSecret, verified.n) : undefined,
    });
    const tokenRes = await fetch(tokenReq.url, { method: "POST", headers: tokenReq.headers, body: tokenReq.body });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) throw new Error(`token_exchange_${tokenRes.status}`);
    const tokens = parseTokenResponse(provider, tokenJson);
    if (!tokens.refreshToken) return fail("no_refresh_token");

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });

    const { data: existing } = await admin
      .from("crm_connections")
      .select("id, api_base, settings, cursors")
      .eq("user_id", verified.o)
      .eq("provider", provider)
      .maybeSingle();

    const label = new URL(tokens.apiBase).host;
    const sameOrg = existing?.api_base === tokens.apiBase;
    const hasSettings = existing?.settings && typeof existing.settings === "object" && "entities" in (existing.settings as object);

    let connectionId: string;
    if (existing) {
      connectionId = existing.id as string;
      if (!sameOrg) await admin.from("crm_record_links").delete().eq("connection_id", connectionId);
      const { error } = await admin
        .from("crm_connections")
        .update({
          status: "connected",
          account_label: label,
          api_base: tokens.apiBase,
          connected_by: verified.u,
          last_error: null,
          sync_locked_until: null,
          settings: hasSettings ? existing.settings : defaultSettings(provider),
          cursors: sameOrg ? existing.cursors : {},
        })
        .eq("id", connectionId);
      if (error) throw error;
    } else {
      const { data: created, error } = await admin
        .from("crm_connections")
        .insert({
          user_id: verified.o,
          provider,
          status: "connected",
          account_label: label,
          api_base: tokens.apiBase,
          connected_by: verified.u,
          settings: defaultSettings(provider),
        })
        .select("id")
        .single();
      if (error || !created) throw error ?? new Error("insert_failed");
      connectionId = created.id as string;
    }

    const { error: secErr } = await admin.from("crm_connection_secrets").upsert(
      {
        connection_id: connectionId,
        user_id: verified.o,
        access_token_enc: await encryptSecret(tokens.accessToken, encKey),
        refresh_token_enc: await encryptSecret(tokens.refreshToken, encKey),
        expires_at: tokens.expiresInSec ? new Date(Date.now() + tokens.expiresInSec * 1000).toISOString() : null,
        extra: authBase ? { auth_base: authBase } : {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: "connection_id" },
    );
    if (secErr) throw secErr;

    return back({ crm: "connected", provider });
  } catch (error) {
    console.error(JSON.stringify({ event: "crm_oauth_callback_failed", provider, owner: verified.o, error: error instanceof Error ? error.message : String(error) }));
    return fail("exchange_failed");
  }
});
