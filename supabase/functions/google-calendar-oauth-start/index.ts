// Required secrets:
//   supabase secrets set GOOGLE_CALENDAR_CLIENT_ID=xxxxx.apps.googleusercontent.com
//   supabase secrets set GOOGLE_CALENDAR_CLIENT_SECRET=xxxxx
//   supabase secrets set GOOGLE_CALENDAR_STATE_SECRET=$(openssl rand -hex 32)
// در Google Cloud Console -> Credentials -> OAuth client -> Authorized redirect URIs اضافه کن:
//   https://<project-ref>.supabase.co/functions/v1/google-calendar-oauth-callback
// Deploy: supabase functions deploy google-calendar-oauth-start

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

    const clientId = Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID");
    const stateSecret = Deno.env.get("GOOGLE_CALENDAR_STATE_SECRET");
    if (!clientId || !stateSecret) {
      return jsonResponse({ error: "Google Calendar isn't configured on this server yet." }, 500);
    }

    const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-calendar-oauth-callback`;
    const state = await signState(userData.user.id, stateSecret);

    const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("access_type", "offline");
    authorizeUrl.searchParams.set("prompt", "consent");
    authorizeUrl.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events");
    authorizeUrl.searchParams.set("state", state);

    return jsonResponse({ url: authorizeUrl.toString() });
  } catch (error) {
    console.error(JSON.stringify({ event: "google_calendar_oauth_start_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Something went wrong starting the Google Calendar connection." }, 500);
  }
});
