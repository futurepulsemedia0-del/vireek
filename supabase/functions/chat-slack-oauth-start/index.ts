// Starts the Slack OAuth (v2) install flow. Owner-only.
// Secrets: SLACK_CLIENT_ID, SLACK_STATE_SECRET   (see docs/CHAT_NOTIFICATIONS.md)
// Deploy:  supabase functions deploy chat-slack-oauth-start

import { signState } from "../_shared/price-book/oauthState.ts";
import { adminClient, corsHeaders, functionsBase, json, requireOwner } from "../_shared/chat-notify/server.ts";

const BOT_SCOPES = ["chat:write", "chat:write.public", "channels:read", "groups:read"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const admin = adminClient();
    const auth = await requireOwner(req, admin);
    if (auth instanceof Response) return auth;

    const clientId = Deno.env.get("SLACK_CLIENT_ID");
    const stateSecret = Deno.env.get("SLACK_STATE_SECRET");
    if (!clientId || !stateSecret) return json({ error: "Slack isn't configured on this server yet." }, 500);

    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", BOT_SCOPES.join(","));
    url.searchParams.set("redirect_uri", `${functionsBase()}/chat-slack-oauth-callback`);
    url.searchParams.set("state", await signState(auth.ownerId, stateSecret));
    return json({ url: url.toString() });
  } catch (e) {
    console.error(JSON.stringify({ event: "chat_slack_oauth_start_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Something went wrong starting the Slack connection." }, 500);
  }
});
