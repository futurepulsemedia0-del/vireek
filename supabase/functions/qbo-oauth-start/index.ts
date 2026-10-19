// supabase/functions/qbo-oauth-start/index.ts
//
// Starts the QuickBooks Online connection (Intuit OAuth 2.0, authorization-code flow).
// The browser calls this with the user's JWT and gets back the Intuit consent URL.
//
// REQUIRED SECRETS (supabase secrets set NAME=value):
//   QBO_CLIENT_ID                 Intuit Developer app > Keys & credentials > Client ID
//   QBO_CLIENT_SECRET             same page > Client Secret
//   QBO_STATE_SECRET              $(openssl rand -hex 32)      signs the OAuth `state` (10-minute lifetime)
//   QBO_TOKEN_ENCRYPTION_KEY      $(openssl rand -base64 32)   AES-256 key that encrypts tokens at rest
//   CRON_SECRET                   $(openssl rand -hex 32)      lets pg_cron / qbo-webhook call qbo-sync-run
//   SITE_URL                      https://vireek.com           where the callback sends the user back to
// OPTIONAL:
//   QBO_ENVIRONMENT               "production" (default) or "sandbox". MUST match the key set you use:
//                                 Intuit "Development" keys talk to sandbox companies, "Production" keys to real ones.
//   QBO_WEBHOOK_VERIFIER_TOKEN    Intuit app > Webhooks > Verifier token (enables near-real-time sync via qbo-webhook)
//
// REDIRECT URI to register in the Intuit app (Keys & credentials > Redirect URIs), exactly:
//   https://<project-ref>.supabase.co/functions/v1/qbo-oauth-callback
//
// Deploy: supabase functions deploy qbo-oauth-start

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildAuthorizeUrl, signOAuthState } from "../_shared/quickbooks/engine.ts";

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

    const caller = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: userData, error: userErr } = await caller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Invalid or expired session." }, 401);

    const { data: ownerId } = await caller.rpc("get_account_owner_id");
    if (!ownerId) return json({ error: "Could not resolve your account." }, 401);
    const { data: allowed } = await caller.rpc("can_manage_quickbooks");
    if (allowed !== true) return json({ error: "You don't have permission to connect QuickBooks." }, 403);

    const clientId = Deno.env.get("QBO_CLIENT_ID");
    const stateSecret = Deno.env.get("QBO_STATE_SECRET");
    if (!clientId || !stateSecret || !Deno.env.get("QBO_CLIENT_SECRET") || !Deno.env.get("QBO_TOKEN_ENCRYPTION_KEY")) {
      return json({ error: "QuickBooks isn't configured on the server yet. Ask your administrator to set the QuickBooks secrets." }, 500);
    }

    const state = await signOAuthState({ owner: ownerId as string, user: userData.user.id }, stateSecret);
    const url = buildAuthorizeUrl({
      clientId,
      redirectUri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/qbo-oauth-callback`,
      state,
    });
    return json({ url });
  } catch (error) {
    console.error(JSON.stringify({ event: "qbo_oauth_start_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong starting the QuickBooks connection." }, 500);
  }
});
