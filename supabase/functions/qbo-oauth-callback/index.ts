// supabase/functions/qbo-oauth-callback/index.ts
//
// OAuth redirect target for QuickBooks Online. Secrets: see qbo-oauth-start/index.ts.
//
// It has no user session, so the signed, 10-minute `state` identifies the account owner and the
// user. Tokens are exchanged server-side, ENCRYPTED, and stored in qbo_connection_secrets (service
// role only), never in a client-readable table. The integrations row (read by the Integrations page
// and the Overview health strip) only ever receives status metadata, never a token.
//
// Deploy: supabase functions deploy qbo-oauth-callback --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  apiBaseFor,
  buildTokenRequest,
  defaultSettings,
  encryptSecret,
  isValidRealmId,
  parseTokenResponse,
  verifyOAuthState,
  type QboEnvironment,
} from "../_shared/quickbooks/engine.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const back = (params: Record<string, string>) => {
    const dest = new URL(`${siteUrl}/dashboard/quickbooks`);
    for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
    return Response.redirect(dest.toString(), 302);
  };
  const fail = (reason: string) => back({ qbo: "error", reason });

  const stateSecret = Deno.env.get("QBO_STATE_SECRET") ?? "";
  const encKey = Deno.env.get("QBO_TOKEN_ENCRYPTION_KEY") ?? "";
  const clientId = Deno.env.get("QBO_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("QBO_CLIENT_SECRET") ?? "";

  const state = url.searchParams.get("state");
  const verified = state && stateSecret ? await verifyOAuthState(state, stateSecret) : null;
  if (!verified) return fail("invalid_state");

  if (url.searchParams.get("error")) return fail("access_denied");
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  if (!code) return fail("missing_code");
  if (!isValidRealmId(realmId)) return fail("missing_realm");
  if (!clientId || !clientSecret || !encKey) return fail("not_configured");

  const environment: QboEnvironment = Deno.env.get("QBO_ENVIRONMENT") === "sandbox" ? "sandbox" : "production";

  try {
    const tokenReq = buildTokenRequest("code", {
      clientId,
      clientSecret,
      code,
      redirectUri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/qbo-oauth-callback`,
    });
    const tokenRes = await fetch(tokenReq.url, { method: "POST", headers: tokenReq.headers, body: tokenReq.body });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) throw new Error(`token_exchange_${tokenRes.status}`);
    const tokens = parseTokenResponse(tokenJson);
    if (!tokens.refreshToken) return fail("no_refresh_token");

    // Company name (also proves the token works). Non-fatal: the connection is valid without it.
    let companyName: string | null = null;
    try {
      const info = await fetch(`${apiBaseFor(environment)}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=75`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
      });
      if (info.ok) {
        const j = (await info.json()) as { CompanyInfo?: { CompanyName?: string; LegalName?: string } };
        companyName = j.CompanyInfo?.CompanyName ?? j.CompanyInfo?.LegalName ?? null;
      }
    } catch {
      /* ignore */
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });

    const { data: existing } = await admin
      .from("qbo_connections")
      .select("id, realm_id, settings, cursors")
      .eq("user_id", verified.o)
      .maybeSingle();

    const refreshExpiresAt = tokens.refreshExpiresInSec ? new Date(Date.now() + tokens.refreshExpiresInSec * 1000).toISOString() : null;
    const sameCompany = existing?.realm_id === realmId;
    const hasSettings = existing?.settings && typeof existing.settings === "object" && "entities" in (existing.settings as object);

    let connectionId: string;
    if (existing) {
      connectionId = existing.id as string;
      // A different QuickBooks company: old links point at records that don't exist there.
      if (!sameCompany) await admin.from("qbo_record_links").delete().eq("connection_id", connectionId);
      const { error } = await admin
        .from("qbo_connections")
        .update({
          realm_id: realmId,
          environment,
          status: "connected",
          company_name: companyName,
          connected_by: verified.u,
          last_error: null,
          sync_locked_until: null,
          refresh_token_expires_at: refreshExpiresAt,
          settings: hasSettings && sameCompany ? existing.settings : defaultSettings(),
          cursors: sameCompany ? existing.cursors : {},
        })
        .eq("id", connectionId);
      if (error) throw error;
    } else {
      const { data: created, error } = await admin
        .from("qbo_connections")
        .insert({
          user_id: verified.o,
          realm_id: realmId,
          environment,
          status: "connected",
          company_name: companyName,
          connected_by: verified.u,
          refresh_token_expires_at: refreshExpiresAt,
          settings: defaultSettings(),
        })
        .select("id")
        .single();
      if (error || !created) throw error ?? new Error("insert_failed");
      connectionId = created.id as string;
    }

    const { error: secErr } = await admin.from("qbo_connection_secrets").upsert(
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

    // Status mirror for the Integrations page + Overview health strip. Metadata only, never tokens.
    await admin.from("integrations").upsert(
      {
        user_id: verified.o,
        integration_type: "quickbooks",
        status: "connected",
        config: { realm_id: realmId, company_name: companyName, environment, connected_at: new Date().toISOString() },
      },
      { onConflict: "user_id,integration_type" },
    );

    return back({ qbo: "connected" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "qbo_oauth_callback_failed", owner: verified.o, error: message }));
    // Unique index uq_qbo_connections_live_realm: this QuickBooks company is already linked to another account.
    if (/uq_qbo_connections_live_realm|duplicate key/i.test(message)) return fail("realm_in_use");
    return fail("exchange_failed");
  }
});
