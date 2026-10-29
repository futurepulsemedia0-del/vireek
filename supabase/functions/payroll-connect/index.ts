// supabase/functions/payroll-connect/index.ts
//
// Connects a payroll provider (Gusto first). One function, two entry points:
//   POST  (user JWT)  { provider: "gusto" }  -> { url }  the provider consent URL
//   GET   ?code&state                         -> provider redirects here; exchanges the code, stores ENCRYPTED
//                                                tokens, then redirects the browser back to /dashboard/payroll-sync
//
// STATUS: Gusto is NOT LIVE-VERIFIED. Defaults to the Gusto DEMO environment until you opt in to production.
//
// REQUIRED SECRETS (supabase secrets set NAME=value):
//   GUSTO_CLIENT_ID / GUSTO_CLIENT_SECRET   Gusto developer app (demo keys for the demo environment)
//   PAYROLL_STATE_SECRET                    $(openssl rand -hex 32)     signs the OAuth `state` (10 min)
//   PAYROLL_TOKEN_ENCRYPTION_KEY            $(openssl rand -base64 32)  AES-256 key for tokens at rest
//   SITE_URL                                https://vireek.com
// OPTIONAL:
//   GUSTO_ENVIRONMENT                       "sandbox" (default, Gusto demo) or "production"
//
// REDIRECT URI to register in the Gusto app, exactly:
//   https://<project-ref>.supabase.co/functions/v1/payroll-connect
//
// Deploy (the callback is a plain browser redirect, so JWT verification is off; the POST verifies the JWT in code):
//   supabase functions deploy payroll-connect --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { encryptSecret, isPayrollProvider, isProviderLive, signPayrollState, verifyPayrollState } from "../_shared/payroll/engine.ts";
import { buildGustoAuthorizeUrl, buildGustoTokenRequest, gustoBase, GUSTO_API_VERSION, parseGustoMe, parseGustoToken } from "../_shared/payroll/gusto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const environment = (): "production" | "sandbox" => (Deno.env.get("GUSTO_ENVIRONMENT") === "production" ? "production" : "sandbox");
const redirectUri = () => `${Deno.env.get("SUPABASE_URL")}/functions/v1/payroll-connect`;

async function start(req: Request): Promise<Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "Missing Authorization header." }, 401);
  const caller = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Invalid or expired session." }, 401);
  const { data: ownerId } = await caller.rpc("get_account_owner_id");
  if (!ownerId) return json({ error: "Could not resolve your account." }, 401);
  const { data: allowed } = await caller.rpc("can_manage_payroll_sync");
  if (allowed !== true) return json({ error: "You don't have permission to connect a payroll provider." }, 403);

  const body = (await req.json().catch(() => ({}))) as { provider?: unknown };
  if (!isPayrollProvider(body.provider) || !isProviderLive(body.provider)) return json({ error: "That payroll provider is not available yet." }, 400);

  const clientId = Deno.env.get("GUSTO_CLIENT_ID");
  const stateSecret = Deno.env.get("PAYROLL_STATE_SECRET");
  if (!clientId || !stateSecret || !Deno.env.get("GUSTO_CLIENT_SECRET") || !Deno.env.get("PAYROLL_TOKEN_ENCRYPTION_KEY")) {
    return json({ error: "Gusto isn't configured on the server yet. Ask your administrator to set the payroll secrets." }, 500);
  }
  const state = await signPayrollState({ owner: ownerId as string, user: userData.user.id, provider: body.provider }, stateSecret);
  return json({ url: buildGustoAuthorizeUrl({ clientId, redirectUri: redirectUri(), state, environment: environment() }), environment: environment() });
}

async function callback(url: URL): Promise<Response> {
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const back = (params: Record<string, string>) => {
    const dest = new URL(`${siteUrl}/dashboard/payroll-sync`);
    for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
    return Response.redirect(dest.toString(), 302);
  };
  const fail = (reason: string) => back({ payroll: "error", reason });

  const stateSecret = Deno.env.get("PAYROLL_STATE_SECRET") ?? "";
  const encKey = Deno.env.get("PAYROLL_TOKEN_ENCRYPTION_KEY") ?? "";
  const clientId = Deno.env.get("GUSTO_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("GUSTO_CLIENT_SECRET") ?? "";

  const state = url.searchParams.get("state");
  const verified = state && stateSecret ? await verifyPayrollState(state, stateSecret) : null;
  if (!verified) return fail("invalid_state");
  if (url.searchParams.get("error")) return fail("access_denied");
  const code = url.searchParams.get("code");
  if (!code) return fail("missing_code");
  if (!clientId || !clientSecret || !encKey) return fail("not_configured");
  const env = environment();

  try {
    const tokenReq = buildGustoTokenRequest("code", { environment: env, clientId, clientSecret, redirectUri: redirectUri(), code });
    const tokenRes = await fetch(tokenReq.url, { method: "POST", headers: tokenReq.headers, body: tokenReq.body });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) throw new Error(`token_exchange_${tokenRes.status}`);
    const tokens = parseGustoToken(tokenJson);
    if (!tokens.refreshToken) return fail("no_refresh_token");

    const me = await fetch(`${gustoBase(env)}/v1/me`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json", "X-Gusto-API-Version": GUSTO_API_VERSION },
    });
    const company = me.ok ? parseGustoMe(await me.json().catch(() => ({}))) : null;
    if (!company) return fail("no_company");

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: existing } = await admin.from("payroll_connections").select("id, external_company_id").eq("user_id", verified.o).eq("provider", verified.p).maybeSingle();

    let connectionId: string;
    const fields = { environment: env, status: "connected", external_company_id: company.companyId, company_name: company.companyName, connected_by: verified.u, last_error: null, last_verified_at: new Date().toISOString(), sync_locked_until: null };
    if (existing) {
      connectionId = existing.id as string;
      // A different provider company means the old employee links no longer apply.
      if (existing.external_company_id && existing.external_company_id !== company.companyId) {
        await admin.from("payroll_employee_links").delete().eq("connection_id", connectionId);
      }
      const { error } = await admin.from("payroll_connections").update(fields).eq("id", connectionId);
      if (error) throw error;
    } else {
      const { data: created, error } = await admin.from("payroll_connections").insert({ user_id: verified.o, provider: verified.p, ...fields }).select("id").single();
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
    await admin.from("payroll_sync_events").insert({ user_id: verified.o, connection_id: connectionId, event: "connected", detail: { provider: verified.p, environment: env }, actor: verified.u });
    return back({ payroll: "connected", provider: verified.p });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "payroll_connect_failed", owner: verified.o, error: message }));
    if (/uq_payroll_connections_live_company|duplicate key/i.test(message)) return fail("company_in_use");
    return fail("exchange_failed");
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  try {
    if (req.method === "GET") return await callback(new URL(req.url));
    if (req.method === "POST") return await start(req);
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error(JSON.stringify({ event: "payroll_connect_unhandled", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong connecting the payroll provider." }, 500);
  }
});
