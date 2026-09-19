// Required secrets:
//   supabase secrets set HUBSPOT_CLIENT_ID=xxxxx
//   supabase secrets set HUBSPOT_CLIENT_SECRET=xxxxx
//   supabase secrets set HUBSPOT_STATE_SECRET=$(openssl rand -hex 32)
// در تنظیمات اپ HubSpot -> Auth، این redirect URI رو اضافه کن:
//   https://<project-ref>.supabase.co/functions/v1/hubspot-oauth-callback
// Deploy: supabase functions deploy hubspot-oauth-start

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { signState } from "../_shared/price-book/oauthState.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse({ error: "Missing Authorization header." }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session." }, 401);

    const clientId = Deno.env.get("HUBSPOT_CLIENT_ID");
    const stateSecret = Deno.env.get("HUBSPOT_STATE_SECRET");
    if (!clientId || !stateSecret) return jsonResponse({ error: "HubSpot isn't configured on this server yet." }, 500);

    const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/hubspot-oauth-callback`;
    const state = await signState(userData.user.id, stateSecret);

    const authorizeUrl = new URL("https://app.hubspot.com/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "crm.objects.contacts.write crm.objects.contacts.read");
    authorizeUrl.searchParams.set("state", state);

    return jsonResponse({ url: authorizeUrl.toString() });
  } catch (error) {
    console.error(JSON.stringify({ event: "hubspot_oauth_start_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Something went wrong starting the HubSpot connection." }, 500);
  }
});
