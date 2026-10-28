// supabase/functions/payroll-connector-oauth-callback/index.ts
//
// OAuth redirect target for Gusto. Secrets: see payroll-connector/index.ts.
//
// No user session here: the signed, 10-minute `state` identifies the account owner and the user.
// Tokens are exchanged server-side, ENCRYPTED and stored in payroll_connection_secrets (service
// role only), never in a client-readable table.
//
// Register this exact Redirect URI in the Gusto developer app:
//   https://<project-ref>.supabase.co/functions/v1/payroll-connector-oauth-callback
//
// Deploy: supabase functions deploy payroll-connector-oauth-callback --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { encryptSecret, verifyOAuthState } from "../_shared/quickbooks/engine.ts";
import {
  buildGustoTokenRequest,
  defaultSettings,
  gustoBaseFor,
  gustoHeaders,
  parseGustoCompanies,
  parseGustoTokens,
  type GustoEnvironment,
} from "../_shared/payroll-connectors/engine.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const back = (params: Record<string, string>) => {
    const dest = new URL(`${siteUrl}/dashboard/payroll-connectors`);
    for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
    return Response.redirect(dest.toString(), 302);
  };
  const fail = (reason: string) => back({ gusto: "error", reason });

  const stateSecret = Deno.env.get("PAYROLL_STATE_SECRET") ?? "";
  const encKey = Deno.env.get("PAYROLL_TOKEN_ENCRYPTION_KEY") ?? "";
  const clientId = Deno.env.get("GUSTO_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("GUSTO_CLIENT_SECRET") ?? "";

  const state = url.searchParams.get("state");
  const verified = state && stateSecret ? await verifyOAuthState(state, stateSecret) : null;
  if (!verified) return fail("invalid_state");
  if (url.searchParams.get("error")) return fail("access_denied");
  const code = url.searchParams.get("code");
  if (!code) return fail("missing_code");
  if (!clientId || !clientSecret || !encKey) return fail("not_configured");

  const environment: GustoEnvironment = Deno.env.get("GUSTO_ENVIRONMENT") === "sandbox" ? "sandbox" : "production";
  const base = gustoBaseFor(environment);
  const version = Deno.env.get("GUSTO_API_VERSION") || undefined;

  try {
    const tokenReq = buildGustoTokenRequest("code", {
      base,
      clientId,
      clientSecret,
      code,
      redirectUri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/payroll-connector-oauth-callback`,
    });
    const tokenRes = await fetch(tokenReq.url, { method: "POST", headers: tokenReq.headers, body: tokenReq.body, signal: AbortSignal.timeout(20_000) });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) throw new Error(`token_exchange_${tokenRes.status}`);
    const tokens = parseGustoTokens(tokenJson);
    if (!tokens.refreshToken) return fail("no_refresh_token");

    // Which companies can this user administer? Non-fatal: the owner can pick or paste one afterwards.
    let companies: { id: string; name: string }[] = [];
    try {
      const me = await fetch(`${base}/v1/me`, { headers: gustoHeaders(tokens.accessToken, version), signal: AbortSignal.timeout(20_000) });
      if (me.ok) companies = parseGustoCompanies(await me.json());
    } catch {
      /* ignore */
    }
    const only = companies.length === 1 ? companies[0] : null;

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });

    const { data: existing } = await admin
      .from("payroll_connections")
      .select("id, settings, external_company_id")
      .eq("user_id", verified.o)
      .eq("provider", "gusto")
      .maybeSingle();

    const patch = {
      mode: "api",
      status: "connected",
      environment,
      connected_by: verified.u,
      last_error: null,
      meta: { companies },
      // Keep a previously chosen company when it is still reachable; otherwise use the only one (or none yet).
      external_company_id:
        existing?.external_company_id && companies.some((c) => c.id === existing.external_company_id)
          ? existing.external_company_id
          : (only?.id ?? null),
      company_name:
        (existing?.external_company_id && companies.find((c) => c.id === existing.external_company_id)?.name) || only?.name || null,
    };

    let connectionId: string;
    if (existing) {
      connectionId = existing.id as string;
      const { error } = await admin.from("payroll_connections").update(patch).eq("id", connectionId);
      if (error) throw error;
    } else {
      const { data: created, error } = await admin
        .from("payroll_connections")
        .insert({ user_id: verified.o, provider: "gusto", settings: defaultSettings("gusto"), ...patch })
        .select("id")
        .single();
      if (error || !created) throw error ?? new Error("insert_failed");
      connectionId = created.id as string;
    }

    const { error: secErr } = await admin.from("payroll_connection_secrets").upsert(
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

    return back({ gusto: "connected" });
  } catch (error) {
    console.error(JSON.stringify({ event: "payroll_oauth_callback_failed", owner: verified.o, error: error instanceof Error ? error.message : String(error) }));
    return fail("exchange_failed");
  }
});
