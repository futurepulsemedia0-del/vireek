// Entra redirects the browser here. We only need the tenant id (`tid`) — no Graph permissions are requested.
// Secrets: TEAMS_OAUTH_CLIENT_ID, TEAMS_OAUTH_CLIENT_SECRET, TEAMS_STATE_SECRET
// Deploy:  supabase functions deploy chat-teams-oauth-callback --no-verify-jwt

import { verifyState } from "../_shared/price-book/oauthState.ts";
import { decodeJwtPayload } from "../_shared/chat-notify/security.ts";
import { adminClient, functionsBase, integrationsRedirect } from "../_shared/chat-notify/server.ts";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const fail = (reason: string) => integrationsRedirect({ teams: "error", reason });

  const denied = url.searchParams.get("error");
  if (denied) return fail(denied.slice(0, 40));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return fail("missing_code_or_state");

  const ownerId = await verifyState(state, Deno.env.get("TEAMS_STATE_SECRET") ?? "");
  if (!ownerId) return fail("invalid_state");

  try {
    const clientId = Deno.env.get("TEAMS_OAUTH_CLIENT_ID") ?? "";
    const res = await fetch("https://login.microsoftonline.com/organizations/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: Deno.env.get("TEAMS_OAUTH_CLIENT_SECRET") ?? "",
        grant_type: "authorization_code",
        code,
        scope: "openid profile",
        redirect_uri: `${functionsBase()}/chat-teams-oauth-callback`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const t = (await res.json()) as { id_token?: string; error_description?: string };
    if (!res.ok || !t.id_token) throw new Error(t.error_description ?? "token_exchange_failed");

    // The id_token came straight from Microsoft's token endpoint over TLS, so decoding (not re-verifying) is sufficient.
    const claims = decodeJwtPayload(t.id_token);
    const tid = typeof claims?.tid === "string" ? claims.tid : "";
    if (!claims || claims.aud !== clientId || !GUID.test(tid)) throw new Error("invalid_id_token");
    const upn = typeof claims.preferred_username === "string" ? claims.preferred_username : "";
    const tenantName = upn.includes("@") ? upn.split("@")[1] : "Microsoft 365 tenant";

    const admin = adminClient();
    const { data: taken } = await admin.from("chat_connections").select("id").eq("provider", "teams").eq("external_id", tid).neq("user_id", ownerId).maybeSingle();
    if (taken) return fail("workspace_in_use");

    const { data: existing } = await admin.from("chat_connections").select("id, external_id").eq("user_id", ownerId).eq("provider", "teams").maybeSingle();
    if (existing && existing.external_id !== tid) {
      await admin.from("chat_routes").delete().eq("connection_id", existing.id);
      await admin.from("chat_channels").delete().eq("connection_id", existing.id);
    }

    const { error } = await admin
      .from("chat_connections")
      .upsert({ user_id: ownerId, provider: "teams", external_id: tid, external_name: tenantName, status: "connected", last_error: null, updated_at: new Date().toISOString() }, { onConflict: "user_id,provider" });
    if (error) throw new Error(error.message);

    return integrationsRedirect({ teams: "connected" });
  } catch (e) {
    console.error(JSON.stringify({ event: "chat_teams_oauth_callback_failed", user_id: ownerId, error: e instanceof Error ? e.message : String(e) }));
    return fail("exchange_failed");
  }
});
