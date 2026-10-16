// supabase/functions/_shared/chat/providers.ts
//
// Thin, fetch-based clients for Slack and Microsoft Teams (Graph) plus the
// shared delivery routine. Used by chat-integrations (connect / channels /
// test) and chat-alerts-dispatch (real alerts).

import { toSlackPayload, toTeamsHtml, type AlertMessage, type ChatProvider } from "./alerts.ts";

export const SLACK_SCOPES = "chat:write,chat:write.public,channels:read,groups:read";
export const TEAMS_SCOPES = "offline_access User.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send";

const TIMEOUT_MS = 10_000;

/** authFailure = the stored credentials are dead and the owner must reconnect. */
export class ProviderError extends Error {
  constructor(message: string, public authFailure = false) {
    super(message);
  }
}

export interface ChannelInfo {
  id: string;
  name: string;
  containerId: string | null;
  containerName: string | null;
  isPrivate: boolean;
}

const SLACK_AUTH_ERRORS = new Set(["invalid_auth", "token_revoked", "account_inactive", "token_expired", "not_authed"]);

async function slackCall<T>(method: string, token: string, body?: Record<string, unknown>, query?: Record<string, string>): Promise<T> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (!data.ok) {
    const code = data.error ?? `http_${res.status}`;
    throw new ProviderError(slackErrorMessage(code), SLACK_AUTH_ERRORS.has(code));
  }
  return data;
}

function slackErrorMessage(code: string): string {
  const known: Record<string, string> = {
    channel_not_found: "That Slack channel no longer exists or the Vireek app can't see it. For a private channel, invite @Vireek first.",
    not_in_channel: "Invite the Vireek app to that channel (/invite @Vireek) and try again.",
    is_archived: "That Slack channel is archived.",
    invalid_auth: "Slack rejected our credentials. Reconnect Slack.",
    token_revoked: "The Slack connection was revoked. Reconnect Slack.",
    account_inactive: "The Slack connection is no longer active. Reconnect Slack.",
    ratelimited: "Slack is rate limiting us. Try again in a moment.",
  };
  return known[code] ?? `Slack error: ${code}`;
}

export function slackAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL("https://slack.com/oauth/v2/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("scope", SLACK_SCOPES);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

export async function slackExchange(code: string, clientId: string, clientSecret: string, redirectUri: string) {
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const d = await res.json().catch(() => ({}));
  if (!d.ok || !d.access_token || !d.team?.id) throw new ProviderError(d.error ?? "slack_exchange_failed");
  return { accessToken: d.access_token as string, workspaceId: d.team.id as string, workspaceName: (d.team.name as string) ?? null };
}

export async function slackListChannels(token: string): Promise<ChannelInfo[]> {
  const out: ChannelInfo[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const d = await slackCall<{ channels: Array<{ id: string; name: string; is_private?: boolean }>; response_metadata?: { next_cursor?: string } }>(
      "conversations.list",
      token,
      undefined,
      { types: "public_channel,private_channel", exclude_archived: "true", limit: "200", ...(cursor ? { cursor } : {}) },
    );
    for (const c of d.channels) out.push({ id: c.id, name: c.name, containerId: null, containerName: null, isPrivate: !!c.is_private });
    cursor = d.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function slackRevoke(token: string): Promise<void> {
  await slackCall("auth.revoke", token, undefined).catch(() => undefined);
}

// ------------------------------------------------------------------ Teams

export interface TeamsTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
}

const msTokenUrl = (tenant: string) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

export function teamsAuthUrl(clientId: string, redirectUri: string, state: string, tenant: string): string {
  const u = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", TEAMS_SCOPES);
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

async function msToken(tenant: string, params: Record<string, string>): Promise<TeamsTokens> {
  const res = await fetch(msTokenUrl(tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    throw new ProviderError("Microsoft rejected the sign-in. Reconnect Microsoft Teams.", d.error === "invalid_grant");
  }
  return { accessToken: d.access_token, refreshToken: d.refresh_token ?? null, expiresAt: new Date(Date.now() + (d.expires_in ?? 3600) * 1000).toISOString() };
}

export async function teamsExchange(code: string, clientId: string, clientSecret: string, redirectUri: string, tenant: string) {
  const tokens = await msToken(tenant, {
    grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, scope: TEAMS_SCOPES,
  });
  const [me, org] = await Promise.all([
    graph<{ displayName?: string }>("/me?$select=displayName", tokens.accessToken),
    graph<{ value?: Array<{ id: string; displayName?: string }> }>("/organization?$select=id,displayName", tokens.accessToken),
  ]);
  const tenantInfo = org.value?.[0];
  if (!tenantInfo?.id) throw new ProviderError("teams_no_tenant");
  return { tokens, workspaceId: tenantInfo.id, workspaceName: tenantInfo.displayName ?? null, connectedByName: me.displayName ?? null };
}

export function teamsRefresh(refreshToken: string, clientId: string, clientSecret: string, tenant: string): Promise<TeamsTokens> {
  return msToken(tenant, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, scope: TEAMS_SCOPES });
}

async function graph<T>(path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new ProviderError("Microsoft session expired.", true);
  if (res.status === 403) throw new ProviderError("Microsoft Teams denied access. Reconnect and approve all requested permissions.", true);
  if (res.status === 404) throw new ProviderError("That Teams channel no longer exists or you are not a member of its team.");
  if (!res.ok) throw new ProviderError(`Microsoft Teams error (${res.status}).`);
  return (await res.json().catch(() => ({}))) as T;
}

export async function teamsListChannels(token: string): Promise<ChannelInfo[]> {
  const teams = await graph<{ value: Array<{ id: string; displayName: string }> }>("/me/joinedTeams?$select=id,displayName", token);
  const perTeam = await Promise.all(
    teams.value.slice(0, 25).map(async (team) => {
      const chans = await graph<{ value: Array<{ id: string; displayName: string; membershipType?: string }> }>(
        `/teams/${encodeURIComponent(team.id)}/channels?$select=id,displayName,membershipType`,
        token,
      ).catch(() => ({ value: [] }));
      return chans.value
        .filter((c) => c.membershipType !== "shared")
        .map((c): ChannelInfo => ({ id: c.id, name: c.displayName, containerId: team.id, containerName: team.displayName, isPrivate: c.membershipType === "private" }));
    }),
  );
  return perTeam.flat().sort((a, b) => `${a.containerName}${a.name}`.localeCompare(`${b.containerName}${b.name}`));
}

// --------------------------------------------------------------- delivery

// deno-lint-ignore no-explicit-any
type Admin = any;

export interface ConnectionRow {
  id: string;
  user_id: string;
  provider: ChatProvider;
}

export interface RuleTarget {
  channel_id: string | null;
  channel_name: string | null;
  container_id: string | null;
}

async function loadAccessToken(admin: Admin, conn: ConnectionRow, teamsCreds: { clientId: string; clientSecret: string; tenant: string } | null, forceRefresh: boolean): Promise<string> {
  const { data: secret } = await admin.from("chat_connection_secrets").select("access_token, refresh_token, expires_at").eq("connection_id", conn.id).maybeSingle();
  if (!secret) throw new ProviderError("Missing credentials. Reconnect.", true);
  if (conn.provider === "slack") return secret.access_token as string;

  const stale = !secret.expires_at || new Date(secret.expires_at).getTime() - Date.now() < 120_000;
  if (!forceRefresh && !stale) return secret.access_token as string;
  if (!secret.refresh_token || !teamsCreds) throw new ProviderError("Microsoft session expired. Reconnect Microsoft Teams.", true);
  const fresh = await teamsRefresh(secret.refresh_token, teamsCreds.clientId, teamsCreds.clientSecret, teamsCreds.tenant);
  await admin.from("chat_connection_secrets").update({
    access_token: fresh.accessToken,
    refresh_token: fresh.refreshToken ?? secret.refresh_token,
    expires_at: fresh.expiresAt,
    updated_at: new Date().toISOString(),
  }).eq("connection_id", conn.id);
  return fresh.accessToken;
}

export function teamsCredsFromEnv(): { clientId: string; clientSecret: string; tenant: string } | null {
  const clientId = Deno.env.get("TEAMS_CLIENT_ID");
  const clientSecret = Deno.env.get("TEAMS_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, tenant: Deno.env.get("TEAMS_TENANT") || "organizations" };
}

/**
 * Posts one alert. Marks the connection 'error' when the credentials are dead
 * (so the UI asks the owner to reconnect) and back to 'connected' on success.
 * Returns null on success or a user-safe error message.
 */
export async function deliverAlert(admin: Admin, conn: ConnectionRow, target: RuleTarget, msg: AlertMessage, siteUrl: string): Promise<string | null> {
  if (!target.channel_id) return "No channel selected.";
  const teamsCreds = teamsCredsFromEnv();
  const send = async (token: string) => {
    if (conn.provider === "slack") {
      await slackCall("chat.postMessage", token, { channel: target.channel_id, ...toSlackPayload(msg, siteUrl), unfurl_links: false });
    } else {
      if (!target.container_id) throw new ProviderError("Re-select the Teams channel and save again.");
      await graph(
        `/teams/${encodeURIComponent(target.container_id)}/channels/${encodeURIComponent(target.channel_id!)}/messages`,
        token,
        { body: { contentType: "html", content: toTeamsHtml(msg, siteUrl) } },
      );
    }
  };

  try {
    try {
      await send(await loadAccessToken(admin, conn, teamsCreds, false));
    } catch (e) {
      // A Graph 401 can mean the access token expired early: refresh once and retry.
      if (!(e instanceof ProviderError) || !e.authFailure || conn.provider !== "teams") throw e;
      await send(await loadAccessToken(admin, conn, teamsCreds, true));
    }
    await admin.from("chat_connections").update({ status: "connected", last_error: null, updated_at: new Date().toISOString() }).eq("id", conn.id);
    return null;
  } catch (e) {
    const message = e instanceof ProviderError ? e.message : "Delivery failed. Please try again.";
    if (e instanceof ProviderError && e.authFailure) {
      await admin.from("chat_connections").update({ status: "error", last_error: message, updated_at: new Date().toISOString() }).eq("id", conn.id);
    }
    return message;
  }
}

export async function listChannels(admin: Admin, conn: ConnectionRow): Promise<ChannelInfo[]> {
  const token = await loadAccessToken(admin, conn, teamsCredsFromEnv(), false);
  return conn.provider === "slack" ? slackListChannels(token) : teamsListChannels(token);
}
