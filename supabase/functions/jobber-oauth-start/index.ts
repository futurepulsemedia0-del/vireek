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
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse({ error: "Missing Authorization header." }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session." }, 401);

    const clientId = Deno.env.get("JOBBER_CLIENT_ID");
    const stateSecret = Deno.env.get("JOBBER_STATE_SECRET");
    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
    if (!clientId || !stateSecret) {
      return jsonResponse({ error: "Jobber isn't configured on this server yet (missing JOBBER_CLIENT_ID / JOBBER_STATE_SECRET)." }, 500);
    }

    const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/jobber-oauth-callback`;
    const state = await signState(userData.user.id, stateSecret);

    const authorizeUrl = new URL("https://api.getjobber.com/api/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", state);

    return jsonResponse({ url: authorizeUrl.toString(), siteUrl });
  } catch (error) {
    console.error(JSON.stringify({ event: "jobber_oauth_start_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Something went wrong starting the Jobber connection." }, 500);
  }
});
