// supabase/functions/xero-oauth-callback/index.ts
//
// OAuth redirect target for Xero. Secrets: see xero-oauth-start/index.ts.
//
// It has no user session, so the signed, 10-minute `state` identifies the account owner and the user.
// Tokens are exchanged server-side, ENCRYPTED, and stored in xero_connection_secrets (service role
// only). The integrations row (read by the Integrations page and health strip) only gets status
// metadata, never a token.
//
// One Xero organisation per Vireek account: if the user ticked several organisations in the consent
// screen, ALL grants of this consent are removed again and the user is asked to pick exactly one
// (we never keep access to organisations we will not sync).
//
// Deploy: supabase functions deploy xero-oauth-callback --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  XERO_CONNECTIONS_URL,
  buildOrganisationRequest,
  buildTokenRequest,
  defaultSettings,
  encryptSecret,
  jwtClaims,
  parseConnections,
  parseOrganisation,
  parseTokenResponse,
  pickConnection,
  verifyOAuthState,
  REFRESH_TOKEN_TTL_SEC,
} from "../_shared/xero/engine.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const back = (params: Record<string, string>) => {
    const dest = new URL(`${siteUrl}/dashboard/xero`);
    for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
    return Response.redirect(dest.toString(), 302);
  };
  const fail = (reason: string) => back({ xero: "error", reason });

  const stateSecret = Deno.env.get("XERO_STATE_SECRET") ?? "";
  const encKey = Deno.env.get("XERO_TOKEN_ENCRYPTION_KEY") ?? "";
  const clientId = Deno.env.get("XERO_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("XERO_CLIENT_SECRET") ?? "";

  const state = url.searchParams.get("state");
  const verified = state && stateSecret ? await verifyOAuthState(state, stateSecret) : null;
  if (!verified) return fail("invalid_state");

  if (url.searchParams.get("error")) return fail("access_denied");
  const code = url.searchParams.get("code");
  if (!code) return fail("missing_code");
  if (!clientId || !clientSecret || !encKey) return fail("not_configured");

  try {
    const tokenReq = buildTokenRequest("code", {
      clientId,
      clientSecret,
      code,
      redirectUri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/xero-oauth-callback`,
    });
    const tokenRes = await fetch(tokenReq.url, { method: "POST", headers: tokenReq.headers, body: tokenReq.body });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) throw new Error(`token_exchange_${tokenRes.status}`);
    const tokens = parseTokenResponse(tokenJson);
    if (!tokens.refreshToken) return fail("no_refresh_token");

    // Which organisation(s) did the user just authorise?
    const connRes = await fetch(XERO_CONNECTIONS_URL, { headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" } });
    if (!connRes.ok) throw new Error(`connections_${connRes.status}`);
    const connections = parseConnections(await connRes.json().catch(() => []));
    const authEventId = typeof jwtClaims(tokens.accessToken).authentication_event_id === "string" ? (jwtClaims(tokens.accessToken).authentication_event_id as string) : null;
    const picked = pickConnection(connections, authEventId);
    if (!picked.ok) {
      // Never keep grants we will not use.
      for (const c of picked.extras) {
        await fetch(`${XERO_CONNECTIONS_URL}/${c.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${tokens.accessToken}` } }).catch(() => undefined);
      }
      return fail(picked.reason === "multiple" ? "multiple_orgs" : "no_org");
    }
    const tenant = picked.connection;

    // Organisation details (name + BASE CURRENCY: money documents only sync when it matches Vireek's).
    const orgReq = buildOrganisationRequest();
    const orgRes = await fetch(orgReq.url, { headers: { Authorization: `Bearer ${tokens.accessToken}`, "xero-tenant-id": tenant.tenantId, Accept: "application/json" } });
    const org = orgRes.ok ? parseOrganisation(await orgRes.json().catch(() => null)) : null;
    if (!org) console.error(JSON.stringify({ event: "xero_org_lookup_failed", status: orgRes.status }));

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

    const { data: existing } = await admin.from("xero_connections").select("id, tenant_id, settings, cursors").eq("user_id", verified.o).maybeSingle();
    const refreshExpiresAt = new Date(Date.now() + (REFRESH_TOKEN_TTL_SEC - 3600) * 1000).toISOString();
    const sameOrg = existing?.tenant_id === tenant.tenantId;
    const hasSettings = existing?.settings && typeof existing.settings === "object" && "entities" in (existing.settings as object);
    const fields = {
      tenant_id: tenant.tenantId,
      xero_connection_id: tenant.id,
      organisation_name: org?.name ?? tenant.tenantName,
      base_currency: org?.baseCurrency ?? null,
      country_code: org?.countryCode ?? null,
      is_demo: org?.isDemo ?? false,
      status: "connected",
      connected_by: verified.u,
      last_error: null,
      sync_locked_until: null,
      refresh_token_expires_at: refreshExpiresAt,
    };

    let connectionId: string;
    if (existing) {
      connectionId = existing.id as string;
      // A different organisation: old links point at records that don't exist there.
      if (!sameOrg) await admin.from("xero_record_links").delete().eq("connection_id", connectionId);
      const { error } = await admin
        .from("xero_connections")
        .update({ ...fields, settings: hasSettings && sameOrg ? existing.settings : defaultSettings(), cursors: sameOrg ? existing.cursors : {} })
        .eq("id", connectionId);
      if (error) throw error;
    } else {
      const { data: created, error } = await admin
        .from("xero_connections")
        .insert({ ...fields, user_id: verified.o, settings: defaultSettings() })
        .select("id")
        .single();
      if (error || !created) throw error ?? new Error("insert_failed");
      connectionId = created.id as string;
    }

    const { error: secErr } = await admin.from("xero_connection_secrets").upsert(
      {
        connection_id: connectionId,
        user_id: verified.o,
        access_token_enc: await encryptSecret(tokens.accessToken, encKey),
        refresh_token_enc: await encryptSecret(tokens.refreshToken, encKey),
        expires_at: tokens.expiresInSec ? new Date(Date.now() + tokens.expiresInSec * 1000).toISOString() : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "connection_id" },
    );
    if (secErr) throw secErr;

    // Status mirror for the Integrations page + health strip. Metadata only, never tokens.
    await admin.from("integrations").upsert(
      {
        user_id: verified.o,
        integration_type: "xero",
        status: "connected",
        config: { tenant_id: tenant.tenantId, organisation_name: org?.name ?? tenant.tenantName, base_currency: org?.baseCurrency ?? null, connected_at: new Date().toISOString() },
      },
      { onConflict: "user_id,integration_type" },
    );

    return back({ xero: "connected" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "xero_oauth_callback_failed", owner: verified.o, error: message }));
    // Unique index uq_xero_connections_live_tenant: this organisation is already linked to another account.
    if (/uq_xero_connections_live_tenant|duplicate key/i.test(message)) return fail("org_in_use");
    return fail("exchange_failed");
  }
});
