// supabase/functions/chat-integrations/index.ts
//
// Backend for /dashboard/settings/slack-teams. One function, two jobs:
//
//   GET  ?code=…&state=…   OAuth redirect target for BOTH Slack and Teams.
//                          Verifies the signed state, exchanges the code,
//                          stores the connection, redirects back to the app.
//   POST { action, … }     list | connect | channels | save_rules | test | disconnect
//                          Requires a signed-in user who is the account owner
//                          or an active team member with can_manage_team.
//
// Everything is scoped to the ACCOUNT OWNER's id. A team member acts on their
// owner's connection, never on a connection of their own.
//
// ─── Required secrets ────────────────────────────────────────────────────
//   supabase secrets set CHAT_OAUTH_STATE_SECRET=$(openssl rand -hex 32)   # both providers
//   supabase secrets set SITE_URL=https://vireek.com                      # redirect + alert links
//   Slack (api.slack.com/apps → your app):
//   supabase secrets set SLACK_CLIENT_ID=…  SLACK_CLIENT_SECRET=…
//   Microsoft Teams (Entra ID → App registrations):
//   supabase secrets set TEAMS_CLIENT_ID=…  TEAMS_CLIENT_SECRET=…
//   supabase secrets set TEAMS_TENANT=organizations     # optional, default "organizations"
//
// Redirect URI to register in BOTH Slack and Microsoft Entra (exactly):
//   https://<project-ref>.supabase.co/functions/v1/chat-integrations
//
// Deploy (no-verify-jwt: the OAuth redirect has no Supabase session; the POST
// actions verify the user's JWT themselves):
//   supabase functions deploy chat-integrations --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { signState, verifyState } from "../_shared/price-book/oauthState.ts";
import {
  ALERT_EVENT_TYPES,
  buildTestMessage,
  canManageChatIntegrations,
  packChatState,
  sanitizeRules,
  unpackChatState,
  type AlertEventType,
  type ChatProvider,
} from "../_shared/chat/alerts.ts";
import {
  ProviderError,
  deliverAlert,
  listChannels,
  slackAuthUrl,
  slackExchange,
  slackRevoke,
  teamsAuthUrl,
  teamsCredsFromEnv,
  teamsExchange,
  type ConnectionRow,
} from "../_shared/chat/providers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const env = (k: string) => Deno.env.get(k) ?? "";
const siteUrl = () => (env("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
const redirectUri = () => `${env("SUPABASE_URL")}/functions/v1/chat-integrations`;
const isProvider = (v: unknown): v is ChatProvider => v === "slack" || v === "teams";

const admin = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

function configured() {
  return {
    slack: !!(env("SLACK_CLIENT_ID") && env("SLACK_CLIENT_SECRET") && env("CHAT_OAUTH_STATE_SECRET")),
    teams: !!(env("TEAMS_CLIENT_ID") && env("TEAMS_CLIENT_SECRET") && env("CHAT_OAUTH_STATE_SECRET")),
  };
}

// ───────────────────────────────────────────────────────── OAuth callback

async function handleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const back = (provider: ChatProvider | "slack", params: Record<string, string>) => {
    const dest = new URL(`${siteUrl()}/dashboard/settings/slack-teams`);
    for (const [k, v] of Object.entries(params)) dest.searchParams.set(k === "status" ? provider : k, v);
    return Response.redirect(dest.toString(), 302);
  };

  const stateSecret = env("CHAT_OAUTH_STATE_SECRET");
  const state = url.searchParams.get("state");
  const payload = state && stateSecret ? await verifyState(state, stateSecret) : null;
  const ctx = payload ? unpackChatState(payload) : null;
  if (!ctx) return back("slack", { status: "error", reason: "invalid_state" });
  const { provider, ownerId, actorId } = ctx;

  if (url.searchParams.get("error")) return back(provider, { status: "error", reason: "denied" });
  const code = url.searchParams.get("code");
  if (!code) return back(provider, { status: "error", reason: "missing_code" });

  const db = admin();
  try {
    let workspaceId: string;
    let workspaceName: string | null;
    let connectedByName: string | null = null;
    let secrets: { access_token: string; refresh_token: string | null; expires_at: string | null };

    if (provider === "slack") {
      const r = await slackExchange(code, env("SLACK_CLIENT_ID"), env("SLACK_CLIENT_SECRET"), redirectUri());
      workspaceId = r.workspaceId;
      workspaceName = r.workspaceName;
      secrets = { access_token: r.accessToken, refresh_token: null, expires_at: null };
    } else {
      const creds = teamsCredsFromEnv();
      if (!creds) return back(provider, { status: "error", reason: "not_configured" });
      const r = await teamsExchange(code, creds.clientId, creds.clientSecret, redirectUri(), creds.tenant);
      workspaceId = r.workspaceId;
      workspaceName = r.workspaceName;
      connectedByName = r.connectedByName;
      secrets = { access_token: r.tokens.accessToken, refresh_token: r.tokens.refreshToken, expires_at: r.tokens.expiresAt };
    }

    const { data: existing } = await db.from("chat_connections").select("id, external_workspace_id").eq("user_id", ownerId).eq("provider", provider).maybeSingle();
    // Reconnecting to a DIFFERENT workspace invalidates every saved channel.
    if (existing && existing.external_workspace_id !== workspaceId) {
      await db.from("chat_alert_rules").delete().eq("user_id", ownerId).eq("provider", provider);
    }

    const { data: conn, error } = await db
      .from("chat_connections")
      .upsert(
        {
          user_id: ownerId,
          provider,
          status: "connected",
          external_workspace_id: workspaceId,
          workspace_name: workspaceName,
          connected_by: actorId,
          connected_by_name: connectedByName,
          last_error: null,
          connected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" },
      )
      .select("id")
      .single();
    if (error || !conn) throw new Error(error?.message ?? "connection upsert failed");

    const { error: secretError } = await db
      .from("chat_connection_secrets")
      .upsert({ connection_id: conn.id, ...secrets, updated_at: new Date().toISOString() }, { onConflict: "connection_id" });
    if (secretError) throw new Error(secretError.message);

    return back(provider, { status: "connected" });
  } catch (e) {
    console.error(JSON.stringify({ event: "chat_oauth_callback_failed", provider, owner_id: ownerId, error: e instanceof Error ? e.message : String(e) }));
    return back(provider, { status: "error", reason: "exchange_failed" });
  }
}

// ─────────────────────────────────────────────────────────── POST actions

async function authorize(req: Request): Promise<{ ownerId: string; actorId: string } | Response> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header." }, 401);
  const db = admin();
  const { data: userData, error } = await db.auth.getUser(jwt);
  if (error || !userData?.user) return json({ error: "Invalid or expired session." }, 401);

  const { data: profile } = await db.from("profiles").select("id, email, role").eq("id", userData.user.id).maybeSingle();
  if (!profile) return json({ error: "Account not found." }, 403);

  let ownerId: string = profile.id;
  let member: Parameters<typeof canManageChatIntegrations>[0]["member"] = null;
  if (profile.role !== "owner") {
    const { data: tm } = await db
      .from("team_members")
      .select("account_owner_id, invite_status, permissions, custom_role:custom_roles(permissions)")
      .eq("member_email", profile.email)
      .maybeSingle();
    if (tm) {
      ownerId = tm.account_owner_id as string;
      const cr = Array.isArray(tm.custom_role) ? tm.custom_role[0] : tm.custom_role;
      member = {
        inviteStatus: tm.invite_status as string,
        permissions: tm.permissions as Record<string, boolean> | null,
        customRolePermissions: (cr as { permissions?: Record<string, boolean> } | null)?.permissions ?? null,
      };
    }
  }
  if (!canManageChatIntegrations({ profileRole: profile.role, member })) {
    return json({ error: "You don't have permission to manage Slack and Teams." }, 403);
  }
  return { ownerId, actorId: profile.id };
}

async function loadConnection(ownerId: string, provider: ChatProvider): Promise<ConnectionRow | null> {
  const { data } = await admin().from("chat_connections").select("id, user_id, provider").eq("user_id", ownerId).eq("provider", provider).maybeSingle();
  return (data as ConnectionRow | null) ?? null;
}

async function handleAction(req: Request): Promise<Response> {
  const auth = await authorize(req);
  if (auth instanceof Response) return auth;
  const { ownerId, actorId } = auth;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action;
  const db = admin();

  if (action === "list") {
    const [connections, rules, deliveries] = await Promise.all([
      db.from("chat_connections").select("id, provider, status, workspace_name, connected_by_name, last_error, connected_at").eq("user_id", ownerId),
      db.from("chat_alert_rules").select("provider, event_type, enabled, channel_id, channel_name, container_id, container_name, threshold").eq("user_id", ownerId),
      db.from("chat_alert_deliveries").select("id, provider, event_type, status, channel_name, error, created_at").eq("user_id", ownerId).order("created_at", { ascending: false }).limit(15),
    ]);
    if (connections.error || rules.error || deliveries.error) return json({ error: "Could not load your integrations." }, 500);
    return json({
      configured: configured(),
      connections: (connections.data ?? []).map((c) => ({
        id: c.id, provider: c.provider, status: c.status, workspaceName: c.workspace_name,
        connectedByName: c.connected_by_name, lastError: c.last_error, connectedAt: c.connected_at,
      })),
      rules: (rules.data ?? []).map((r) => ({
        provider: r.provider, eventType: r.event_type, enabled: r.enabled, channelId: r.channel_id, channelName: r.channel_name,
        containerId: r.container_id, containerName: r.container_name, threshold: r.threshold,
      })),
      deliveries: (deliveries.data ?? []).map((d) => ({
        id: d.id, provider: d.provider, eventType: d.event_type, status: d.status, channelName: d.channel_name, error: d.error, createdAt: d.created_at,
      })),
    });
  }

  const provider = body.provider;
  if (!isProvider(provider)) return json({ error: "Unknown provider." }, 400);

  if (action === "connect") {
    const stateSecret = env("CHAT_OAUTH_STATE_SECRET");
    if (!configured()[provider]) return json({ error: `${provider === "slack" ? "Slack" : "Microsoft Teams"} isn't configured on this server yet.` }, 500);
    const state = await signState(packChatState(provider, ownerId, actorId), stateSecret);
    const creds = teamsCredsFromEnv();
    const url = provider === "slack"
      ? slackAuthUrl(env("SLACK_CLIENT_ID"), redirectUri(), state)
      : teamsAuthUrl(creds!.clientId, redirectUri(), state, creds!.tenant);
    return json({ url });
  }

  const conn = await loadConnection(ownerId, provider);
  if (!conn) return json({ error: "Connect this workspace first." }, 404);

  if (action === "channels") {
    try {
      return json({ channels: await listChannels(db, conn) });
    } catch (e) {
      const message = e instanceof ProviderError ? e.message : "Could not load channels.";
      if (e instanceof ProviderError && e.authFailure) {
        await db.from("chat_connections").update({ status: "error", last_error: message, updated_at: new Date().toISOString() }).eq("id", conn.id);
      }
      return json({ error: message }, 502);
    }
  }

  if (action === "save_rules") {
    const result = sanitizeRules(body.rules);
    if (!result.ok) return json({ error: result.error }, 400);
    const now = new Date().toISOString();
    const rows = result.rules.map((r) => ({
      user_id: ownerId, provider, event_type: r.eventType, enabled: r.enabled, channel_id: r.channelId, channel_name: r.channelName,
      container_id: r.containerId, container_name: r.containerName, threshold: r.threshold, updated_at: now,
    }));
    const { error } = await db.from("chat_alert_rules").upsert(rows, { onConflict: "user_id,provider,event_type" });
    if (error) return json({ error: "Could not save your alert routing." }, 500);
    return json({ ok: true });
  }

  if (action === "test") {
    const eventType = body.eventType as AlertEventType;
    if (!ALERT_EVENT_TYPES.includes(eventType)) return json({ error: "Unknown alert type." }, 400);
    const { data: rule } = await db.from("chat_alert_rules").select("channel_id, channel_name, container_id").eq("user_id", ownerId).eq("provider", provider).eq("event_type", eventType).maybeSingle();
    if (!rule?.channel_id) return json({ error: "Save a channel for this alert first." }, 400);
    const failure = await deliverAlert(db, conn, rule, buildTestMessage(eventType), siteUrl());
    return failure ? json({ error: failure }, 502) : json({ ok: true });
  }

  if (action === "disconnect") {
    if (provider === "slack") {
      const { data: secret } = await db.from("chat_connection_secrets").select("access_token").eq("connection_id", conn.id).maybeSingle();
      if (secret?.access_token) await slackRevoke(secret.access_token as string);
    }
    const { error } = await db.from("chat_connections").delete().eq("id", conn.id); // cascades to secrets + rules
    if (error) return json({ error: "Could not disconnect. Please try again." }, 500);
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, 400);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  try {
    if (req.method === "GET") return await handleCallback(req);
    if (req.method === "POST") return await handleAction(req);
    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    console.error(JSON.stringify({ event: "chat_integrations_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
