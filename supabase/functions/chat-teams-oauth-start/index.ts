// Starts the Microsoft Entra sign-in that links a Microsoft 365 tenant to the Vireek account. Owner-only.
// Secrets: TEAMS_OAUTH_CLIENT_ID, TEAMS_STATE_SECRET
// Deploy:  supabase functions deploy chat-teams-oauth-start

import { signState } from "../_shared/price-book/oauthState.ts";
import { adminClient, corsHeaders, functionsBase, json, requireOwner } from "../_shared/chat-notify/server.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const admin = adminClient();
    const auth = await requireOwner(req, admin);
    if (auth instanceof Response) return auth;

    const clientId = Deno.env.get("TEAMS_OAUTH_CLIENT_ID");
    const stateSecret = Deno.env.get("TEAMS_STATE_SECRET");
    if (!clientId || !stateSecret) return json({ error: "Microsoft Teams isn't configured on this server yet." }, 500);

    const url = new URL("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", "openid profile");
    url.searchParams.set("prompt", "select_account");
    url.searchParams.set("redirect_uri", `${functionsBase()}/chat-teams-oauth-callback`);
    url.searchParams.set("state", await signState(auth.ownerId, stateSecret));
    return json({ url: url.toString() });
  } catch (e) {
    console.error(JSON.stringify({ event: "chat_teams_oauth_start_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Something went wrong starting the Microsoft Teams connection." }, 500);
  }
});
