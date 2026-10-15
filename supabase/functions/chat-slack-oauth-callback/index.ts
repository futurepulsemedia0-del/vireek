// Slack redirects the browser here after the user approves the app.
// Secrets: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_STATE_SECRET, CHAT_TOKEN_ENCRYPTION_KEY
// Deploy:  supabase functions deploy chat-slack-oauth-callback --no-verify-jwt

import { verifyState } from "../_shared/price-book/oauthState.ts";
import { encryptSecret } from "../_shared/chat-notify/security.ts";
import { adminClient, functionsBase, integrationsRedirect } from "../_shared/chat-notify/server.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const fail = (reason: string) => integrationsRedirect({ slack: "error", reason });

  const denied = url.searchParams.get("error");
  if (denied) return fail(denied.slice(0, 40));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return fail("missing_code_or_state");

  const ownerId = await verifyState(state, Deno.env.get("SLACK_STATE_SECRET") ?? "");
  if (!ownerId) return fail("invalid_state");

  const encKey = Deno.env.get("CHAT_TOKEN_ENCRYPTION_KEY");
  if (!encKey) return fail("server_not_configured");

  try {
    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: Deno.env.get("SLACK_CLIENT_ID") ?? "",
        client_secret: Deno.env.get("SLACK_CLIENT_SECRET") ?? "",
        code,
        redirect_uri: `${functionsBase()}/chat-slack-oauth-callback`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const t = (await res.json()) as {
      ok: boolean; error?: string; access_token?: string; bot_user_id?: string; is_enterprise_install?: boolean;
      team?: { id: string; name: string };
    };
    if (!t.ok || !t.access_token || !t.team?.id) throw new Error(t.error ?? "token_exchange_failed");
    if (t.is_enterprise_install) return fail("enterprise_unsupported");

    const admin = adminClient();
    const { data: taken } = await admin.from("chat_connections").select("id").eq("provider", "slack").eq("external_id", t.team.id).neq("user_id", ownerId).maybeSingle();
    if (taken) return fail("workspace_in_use");

    const { data: existing } = await admin.from("chat_connections").select("id, external_id").eq("user_id", ownerId).eq("provider", "slack").maybeSingle();
    if (existing && existing.external_id !== t.team.id) await admin.from("chat_routes").delete().eq("connection_id", existing.id); // channel ids belong to the old workspace

    const now = new Date().toISOString();
    const { data: conn, error } = await admin
      .from("chat_connections")
      .upsert({ user_id: ownerId, provider: "slack", external_id: t.team.id, external_name: t.team.name, bot_user_id: t.bot_user_id ?? null, status: "connected", last_error: null, updated_at: now }, { onConflict: "user_id,provider" })
      .select("id")
      .single();
    if (error || !conn) throw new Error(error?.message ?? "connection_upsert_failed");

    const { error: secretErr } = await admin
      .from("chat_connection_secrets")
      .upsert({ connection_id: conn.id, token_ciphertext: await encryptSecret(t.access_token, encKey), updated_at: now }, { onConflict: "connection_id" });
    if (secretErr) throw new Error(secretErr.message);

    return integrationsRedirect({ slack: "connected" });
  } catch (e) {
    console.error(JSON.stringify({ event: "chat_slack_oauth_callback_failed", user_id: ownerId, error: e instanceof Error ? e.message : String(e) }));
    return fail("exchange_failed");
  }
});
