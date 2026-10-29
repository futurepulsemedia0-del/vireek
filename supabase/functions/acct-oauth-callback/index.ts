// supabase/functions/acct-oauth-callback/index.ts
//
// OAuth redirect target for Xero and Zoho Books. Secrets: see acct-oauth-start/index.ts.
//
// It has no user session, so the signed, 10-minute `state` identifies the account owner, the user AND the
// provider (a state issued for one provider is never accepted for another). Tokens are exchanged server-side,
// ENCRYPTED, and stored in acct_connection_secrets (service role only). The integrations row (read by the
// Integrations page) only ever receives status metadata, never a token.
//
// Deploy: supabase functions deploy acct-oauth-callback --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { defaultSettings, encryptSecret, parseTokenResponse, verifyOAuthState, type AcctProvider } from "../_shared/accounting/core.ts";
import { PROVIDERS } from "../_shared/accounting/registry.ts";
import { XERO_CONNECTIONS_URL, jwtClaims, parseConnections } from "../_shared/accounting/xero.ts";
import { isZohoRegion, parseOrganizations, regionFromAccountsServer, zohoOrganizationsUrl } from "../_shared/accounting/zoho.ts";

const SLUG: Record<AcctProvider, string> = { xero: "xero", zoho_books: "zoho-books", netsuite: "netsuite" };

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const back = (provider: AcctProvider | null, params: Record<string, string>) => {
    const dest = new URL(`${siteUrl}/dashboard/accounting/${provider ? SLUG[provider] : ""}`);
    for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
    return Response.redirect(dest.toString(), 302);
  };

  const stateSecret = Deno.env.get("ACCT_STATE_SECRET") ?? "";
  const encKey = Deno.env.get("ACCT_TOKEN_ENCRYPTION_KEY") ?? "";
  const state = url.searchParams.get("state");
  const verified = state && stateSecret ? await verifyOAuthState(state, stateSecret) : null;
  if (!verified || verified.p === "netsuite") return back(null, { acct: "error", reason: "invalid_state" });
  const provider = verified.p;
  const p = PROVIDERS[provider];
  const fail = (reason: string) => back(provider, { acct: "error", reason });

  if (url.searchParams.get("error")) return fail("access_denied");
  const code = url.searchParams.get("code");
  const clientId = Deno.env.get(`${p.auth.envPrefix}_CLIENT_ID`) ?? "";
  const clientSecret = Deno.env.get(`${p.auth.envPrefix}_CLIENT_SECRET`) ?? "";
  if (!code) return fail("missing_code");
  if (!clientId || !clientSecret || !encKey) return fail("not_configured");

  try {
    // Zoho tells us the user's real data centre; fall back to the one chosen in the UI.
    const region = provider === "zoho_books" ? regionFromAccountsServer(url.searchParams.get("accounts-server")) ?? (isZohoRegion(verified.r) ? verified.r : "com") : null;
    const tokenReq = await p.auth.tokenRequest("code", { clientId, clientSecret, code, region, redirectUri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/acct-oauth-callback` });
    if (!p.auth.isAllowedTokenUrl(tokenReq.url, null)) throw new Error("token_host_not_allowed");
    const tokenRes = await fetch(tokenReq.url, { method: "POST", headers: tokenReq.headers, body: tokenReq.body });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) throw new Error(`token_exchange_${tokenRes.status}`);
    const tokens = parseTokenResponse(tokenJson);
    if (!tokens.refreshToken) return fail("no_refresh_token");

    let tenantId: string | null = null;
    let companyName: string | null = null;
    let currency: string | null = null;
    const config: Record<string, unknown> = {};

    if (provider === "xero") {
      const authEventId = jwtClaims(tokens.accessToken).authentication_event_id;
      const cu = new URL(XERO_CONNECTIONS_URL);
      if (typeof authEventId === "string" && /^[0-9a-f-]{36}$/i.test(authEventId)) cu.searchParams.set("authEventId", authEventId);
      const cr = await fetch(cu.toString(), { headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" } });
      const tenants = cr.ok ? parseConnections(await cr.json().catch(() => [])) : [];
      if (!tenants.length) return fail("no_organisation");
      tenantId = tenants[0].tenantId; // the organisation just authorised (newest first)
      companyName = tenants[0].name;
      config.connection_id = tenants[0].connectionId;
      try {
        const org = await fetch("https://api.xero.com/api.xro/2.0/Organisation", { headers: { Authorization: `Bearer ${tokens.accessToken}`, "Xero-Tenant-Id": tenantId, Accept: "application/json" } });
        if (org.ok) currency = ((await org.json()) as { Organisations?: { BaseCurrency?: string }[] }).Organisations?.[0]?.BaseCurrency ?? null;
      } catch { /* optional */ }
    } else {
      const orgRes = await fetch(zohoOrganizationsUrl(region ?? "com"), { headers: { Authorization: `Zoho-oauthtoken ${tokens.accessToken}`, Accept: "application/json" } });
      const org = orgRes.ok ? parseOrganizations(await orgRes.json().catch(() => ({}))) : null;
      if (!org) return fail("no_organisation");
      tenantId = org.id;
      companyName = org.name;
      currency = org.currency;
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: existing } = await admin.from("acct_connections").select("id, tenant_id, settings, cursors").eq("user_id", verified.o).eq("provider", provider).maybeSingle();
    const same = existing?.tenant_id === tenantId;
    const fresh = defaultSettings(provider);
    if (currency && /^[A-Z]{3}$/.test(currency)) fresh.defaults.currency = currency;
    const hasSettings = existing?.settings && typeof existing.settings === "object" && "entities" in (existing.settings as object);
    const refreshExp = tokens.refreshExpiresInSec ? new Date(Date.now() + tokens.refreshExpiresInSec * 1000).toISOString() : null;

    let connectionId: string;
    if (existing) {
      connectionId = existing.id as string;
      if (!same) await admin.from("acct_record_links").delete().eq("connection_id", connectionId); // other organisation: old links point at nothing
      const { error } = await admin.from("acct_connections").update({
        tenant_id: tenantId, region, config, status: "connected", company_name: companyName, connected_by: verified.u, last_error: null, sync_locked_until: null,
        refresh_token_expires_at: refreshExp, settings: hasSettings && same ? existing.settings : fresh, cursors: same ? existing.cursors : {},
      }).eq("id", connectionId);
      if (error) throw error;
    } else {
      const { data: created, error } = await admin.from("acct_connections").insert({
        user_id: verified.o, provider, tenant_id: tenantId, region, config, status: "connected", company_name: companyName, connected_by: verified.u, refresh_token_expires_at: refreshExp, settings: fresh,
      }).select("id").single();
      if (error || !created) throw error ?? new Error("insert_failed");
      connectionId = created.id as string;
    }

    const { error: secErr } = await admin.from("acct_connection_secrets").upsert({
      connection_id: connectionId, user_id: verified.o,
      access_token_enc: await encryptSecret(tokens.accessToken, encKey), refresh_token_enc: await encryptSecret(tokens.refreshToken, encKey),
      expires_at: tokens.expiresInSec ? new Date(Date.now() + tokens.expiresInSec * 1000).toISOString() : null, updated_at: new Date().toISOString(),
    }, { onConflict: "connection_id" });
    if (secErr) throw secErr;

    await admin.from("integrations").upsert(
      { user_id: verified.o, integration_type: provider, status: "connected", config: { tenant_id: tenantId, company_name: companyName, connected_at: new Date().toISOString() } },
      { onConflict: "user_id,integration_type" },
    );
    return back(provider, { acct: "connected" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "acct_oauth_callback_failed", provider, owner: verified.o, error: message }));
    if (/uq_acct_connections_live_tenant|duplicate key/i.test(message)) return fail("tenant_in_use");
    return fail("exchange_failed");
  }
});
