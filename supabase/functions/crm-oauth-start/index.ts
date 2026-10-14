// supabase/functions/crm-oauth-start/index.ts
//
// Starts the OAuth connection for Salesforce, Pipedrive or Zoho CRM.
// Mirrors hubspot-oauth-start, but ONE function serves all three providers.
//
// REQUIRED SECRETS (supabase secrets set NAME=value):
//   CRM_STATE_SECRET            $(openssl rand -hex 32)      signs the OAuth `state`; also derives the PKCE verifier
//   CRM_TOKEN_ENCRYPTION_KEY    $(openssl rand -base64 32)   AES-256 key that encrypts tokens at rest (used by the callback + sync)
//   CRON_SECRET                 $(openssl rand -hex 32)      lets pg_cron call crm-sync-run
//   SITE_URL                    https://vireek.com           where the callback sends the user back to
//   SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET          Salesforce Connected App (consumer key / secret)
//   PIPEDRIVE_CLIENT_ID  / PIPEDRIVE_CLIENT_SECRET           Pipedrive app (OAuth & access scopes)
//   ZOHO_CLIENT_ID       / ZOHO_CLIENT_SECRET                Zoho API Console "Server-based Application"
// OPTIONAL:
//   SALESFORCE_LOGIN_URL        default https://login.salesforce.com  (use https://test.salesforce.com for sandboxes,
//                               or your https://<domain>.my.salesforce.com My Domain URL)
//   ZOHO_ACCOUNTS_URL           default https://accounts.zoho.com     (e.g. https://accounts.zoho.eu for the EU data centre)
//
// REDIRECT URI to register in EACH provider's app settings (same URL for all three):
//   https://<project-ref>.supabase.co/functions/v1/crm-oauth-callback
//
// Deploy: supabase functions deploy crm-oauth-start

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  CRM_PROVIDERS,
  buildAuthorizeUrl,
  pkceChallenge,
  pkceVerifier,
  signOAuthState,
  type CrmProvider,
} from "../_shared/crm/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "Missing Authorization header." }, 401);

    const body = (await req.json().catch(() => ({}))) as { provider?: string };
    const provider = body.provider as CrmProvider;
    if (!CRM_PROVIDERS.includes(provider)) return json({ error: "Unknown CRM provider." }, 400);

    const caller = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: userData, error: userErr } = await caller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Invalid or expired session." }, 401);

    const { data: ownerId } = await caller.rpc("get_account_owner_id");
    if (!ownerId) return json({ error: "Could not resolve your account." }, 401);
    const { data: allowed } = await caller.rpc("can_manage_crm");
    if (allowed !== true) return json({ error: "You don't have permission to connect a CRM." }, 403);

    const envName = provider.toUpperCase();
    const clientId = Deno.env.get(`${envName}_CLIENT_ID`);
    const stateSecret = Deno.env.get("CRM_STATE_SECRET");
    if (!clientId || !stateSecret || !Deno.env.get(`${envName}_CLIENT_SECRET`) || !Deno.env.get("CRM_TOKEN_ENCRYPTION_KEY")) {
      return json({ error: "This CRM isn't configured on the server yet. Ask your administrator to set the CRM secrets." }, 500);
    }

    const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/crm-oauth-callback`;
    const { state, nonce } = await signOAuthState({ owner: ownerId as string, user: userData.user.id, provider }, stateSecret);

    const url = buildAuthorizeUrl(provider, {
      clientId,
      redirectUri,
      state,
      authBase: provider === "salesforce" ? Deno.env.get("SALESFORCE_LOGIN_URL") : provider === "zoho" ? Deno.env.get("ZOHO_ACCOUNTS_URL") : undefined,
      pkceChallenge: provider === "salesforce" ? await pkceChallenge(await pkceVerifier(stateSecret, nonce)) : undefined,
    });
    return json({ url });
  } catch (error) {
    console.error(JSON.stringify({ event: "crm_oauth_start_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong starting the CRM connection." }, 500);
  }
});
