// Provider clients + delivery orchestration. Deno-only (uses Deno.env, fetch, npm: imports).
import { buildMessageModel, type ChatEventType, type MessageModel, type RenderableEvent, type Technician } from "./events.ts";
import { buildSlackMessage } from "./slackBlocks.ts";
import { buildTeamsMessage } from "./teamsCards.ts";
import { decryptSecret, isTrustedServiceUrl, normalizeServiceUrl } from "./security.ts";
import { siteUrl, type Db } from "./server.ts";

export interface SendResult {
  ok: boolean;
  messageId?: string;
  conversationId?: string;
  serviceUrl?: string;
  error?: string;
  retryable?: boolean;
  /** The connection itself is unusable (revoked token, bot removed) — flag it for reconnect. */
  fatalConnection?: boolean;
}

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================== Slack ==============================
const SLACK_FATAL = new Set(["invalid_auth", "token_revoked", "token_expired", "account_inactive", "not_authed", "team_access_not_granted"]);
const SLACK_HINTS: Record<string, string> = {
  not_in_channel: "Vireek is not in this private channel — run /invite @Vireek there.",
  channel_not_found: "Channel not found — it may have been deleted or is private without Vireek.",
  is_archived: "The channel is archived.",
  msg_too_long: "The message was too long for Slack.",
};

type SlackResponse = { ok: boolean; error?: string; ts?: string; channel?: string; [k: string]: unknown };

async function slackFetch(method: string, token: string, init: { json?: unknown; form?: Record<string, string> }, retried = false): Promise<SlackResponse & { _rateLimited?: boolean }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let body: string;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    body = JSON.stringify(init.json);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form ?? {}).toString();
  }
  const res = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after") ?? "1");
    if (!retried && Number.isFinite(wait) && wait <= 5) {
      await sleep(wait * 1000);
      return slackFetch(method, token, init, true);
    }
    return { ok: false, error: "ratelimited", _rateLimited: true };
  }
  return (await res.json()) as SlackResponse;
}

function slackResult(r: SlackResponse & { _rateLimited?: boolean }): SendResult {
  if (r.ok) return { ok: true, messageId: r.ts, conversationId: r.channel };
  const code = r.error ?? "unknown_error";
  return {
    ok: false,
    error: SLACK_HINTS[code] ?? `Slack error: ${code}`,
    fatalConnection: SLACK_FATAL.has(code),
    retryable: code === "ratelimited" || code === "internal_error" || code === "service_unavailable" || code === "fatal_error",
  };
}

export async function slackPost(token: string, channel: string, model: MessageModel): Promise<SendResult> {
  const m = buildSlackMessage(model);
  return slackResult(await slackFetch("chat.postMessage", token, { json: { channel, text: m.text, blocks: m.blocks, unfurl_links: false, unfurl_media: false } }));
}

export async function slackUpdate(token: string, channel: string, ts: string, model: MessageModel): Promise<SendResult> {
  const m = buildSlackMessage(model);
  return slackResult(await slackFetch("chat.update", token, { json: { channel, ts, text: m.text, blocks: m.blocks } }));
}

export async function slackListChannels(token: string): Promise<{ id: string; name: string; isPrivate: boolean }[]> {
  const out: { id: string; name: string; isPrivate: boolean }[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const r = await slackFetch("conversations.list", token, {
      form: { types: "public_channel,private_channel", exclude_archived: "true", limit: "200", ...(cursor ? { cursor } : {}) },
    });
    if (!r.ok) throw new Error(slackResult(r).error);
    for (const c of (r.channels as { id: string; name: string; is_private?: boolean }[] | undefined) ?? []) {
      out.push({ id: c.id, name: c.name, isPrivate: !!c.is_private });
    }
    cursor = ((r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "").trim();
    if (!cursor) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function slackRevoke(token: string): Promise<void> {
  try {
    await slackFetch("auth.revoke", token, { form: {} });
  } catch { /* best effort */ }
}

export async function getSlackToken(db: Db, connectionId: string): Promise<string> {
  const key = Deno.env.get("CHAT_TOKEN_ENCRYPTION_KEY");
  if (!key) throw new Error("CHAT_TOKEN_ENCRYPTION_KEY is not configured on the server.");
  const { data } = await db.from("chat_connection_secrets").select("token_ciphertext").eq("connection_id", connectionId).maybeSingle();
  if (!data?.token_ciphertext) throw new Error("Slack credentials are missing — please reconnect Slack.");
  return decryptSecret(data.token_ciphertext, key);
}

// ============================== Teams ==============================
let cachedBotToken: { token: string; exp: number } | null = null;

export async function teamsBotToken(force = false): Promise<string> {
  if (!force && cachedBotToken && cachedBotToken.exp > Date.now() + 60_000) return cachedBotToken.token;
  const appId = Deno.env.get("TEAMS_BOT_APP_ID");
  const secret = Deno.env.get("TEAMS_BOT_APP_SECRET");
  if (!appId || !secret) throw new Error("Teams bot credentials are not configured on the server.");
  const tenant = Deno.env.get("TEAMS_BOT_TENANT_ID") || "botframework.com";
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: appId, client_secret: secret, scope: "https://api.botframework.com/.default" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(`Teams bot token request failed: ${data.error_description ?? res.status}`);
  cachedBotToken = { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

async function teamsFetch(method: string, serviceUrl: string, path: string, body?: unknown, retriedAuth = false): Promise<{ status: number; data: Record<string, unknown> }> {
  if (!isTrustedServiceUrl(serviceUrl)) throw new Error("Untrusted Teams service URL.");
  const token = await teamsBotToken(retriedAuth);
  const res = await fetch(`${normalizeServiceUrl(serviceUrl)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 && !retriedAuth) return teamsFetch(method, serviceUrl, path, body, true);
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
}

function teamsResult(r: { status: number; data: Record<string, unknown> }): SendResult {
  if (r.status >= 200 && r.status < 300) {
    return { ok: true, messageId: (r.data.activityId ?? r.data.id) as string | undefined, conversationId: r.data.id as string | undefined };
  }
  const err = (r.data.error as { code?: string; message?: string } | undefined) ?? {};
  const roster = err.code === "BotNotInConversationRoster" || r.status === 403;
  return {
    ok: false,
    error: roster ? "The Vireek app is not installed in this Team — add it in Teams, then refresh channels." : `Teams error ${r.status}${err.message ? `: ${err.message}` : ""}`,
    retryable: r.status === 429 || r.status >= 500,
    fatalConnection: false,
  };
}

export async function teamsPost(serviceUrl: string, tenantId: string, channelId: string, model: MessageModel): Promise<SendResult> {
  const appId = Deno.env.get("TEAMS_BOT_APP_ID") ?? "";
  const r = await teamsFetch("POST", serviceUrl, "v3/conversations", {
    isGroup: true,
    bot: { id: `28:${appId}`, name: "Vireek" },
    channelData: { channel: { id: channelId } },
    tenantId,
    activity: buildTeamsMessage(model),
  });
  const res = teamsResult(r);
  if (res.ok) res.serviceUrl = normalizeServiceUrl(serviceUrl);
  return res;
}

export async function teamsUpdate(serviceUrl: string, conversationId: string, activityId: string, model: MessageModel): Promise<SendResult> {
  const msg = buildTeamsMessage(model);
  return teamsResult(await teamsFetch("PUT", serviceUrl, `v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`, { ...msg, id: activityId }));
}

export async function teamsReply(serviceUrl: string, conversationId: string, replyToId: string, text: string): Promise<void> {
  await teamsFetch("POST", serviceUrl, `v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(replyToId)}`, { type: "message", text });
}

export async function teamsListChannels(serviceUrl: string, teamId: string): Promise<{ id: string; name: string }[]> {
  const r = await teamsFetch("GET", serviceUrl, `v3/teams/${encodeURIComponent(teamId)}/conversations`);
  if (r.status !== 200) throw new Error(teamsResult(r).error);
  const list = (r.data.conversations as { id: string; name?: string | null }[] | undefined) ?? [];
  return list.map((c) => ({ id: c.id, name: c.name || "General" }));
}

/** Upserts the channel cache for one team and drops channels that no longer exist. */
export async function syncTeamChannels(db: Db, conn: { id: string; user_id: string }, serviceUrl: string, teamId: string, teamName: string | null): Promise<number> {
  const channels = await teamsListChannels(serviceUrl, teamId);
  const rows = channels.map((c) => ({
    connection_id: conn.id,
    user_id: conn.user_id,
    channel_id: c.id,
    channel_name: c.name,
    team_id: teamId,
    team_name: teamName,
    service_url: normalizeServiceUrl(serviceUrl),
    updated_at: new Date().toISOString(),
  }));
  if (rows.length) await db.from("chat_channels").upsert(rows, { onConflict: "connection_id,channel_id" });
  const keep = channels.map((c) => c.id);
  const del = db.from("chat_channels").delete().eq("connection_id", conn.id).eq("team_id", teamId);
  await (keep.length ? del.not("channel_id", "in", `(${keep.map((k) => `"${k.replace(/"/g, "")}"`).join(",")})`) : del);
  return rows.length;
}

// ============================== Rendering ==============================
export async function loadTechnicians(db: Db, ownerId: string): Promise<Technician[]> {
  const { data } = await db
    .from("team_members")
    .select("id, member_name, member_email")
    .eq("account_owner_id", ownerId)
    .eq("invite_status", "active")
    .order("member_name", { ascending: true })
    .limit(25);
  return (data ?? []).map((r: { id: string; member_name: string | null; member_email: string }) => ({ id: r.id, name: r.member_name || r.member_email }));
}

// deno-lint-ignore no-explicit-any
export async function toRenderable(db: Db, event: any): Promise<RenderableEvent> {
  let assignedToName: string | null = null;
  if (event.assigned_to) {
    const { data } = await db.from("team_members").select("member_name, member_email").eq("id", event.assigned_to).maybeSingle();
    assignedToName = data?.member_name || data?.member_email || null;
  }
  return { id: event.id, eventType: event.event_type as ChatEventType, payload: event.payload ?? {}, acknowledgedBy: event.acknowledged_by, assignedToName };
}

interface RouteOptions { include_contact_details: boolean; actions_enabled: boolean }
const modelFor = (ev: RenderableEvent, route: RouteOptions, technicians: Technician[]) =>
  buildMessageModel(ev, { siteUrl: siteUrl(), includeContact: route.include_contact_details, actionsEnabled: route.actions_enabled, technicians });

/** Re-renders every delivered copy of an event (Slack + Teams) so all channels show the same state. */
export async function refreshEventMessages(db: Db, eventId: string): Promise<void> {
  const { data: event } = await db.from("chat_events").select("*").eq("id", eventId).maybeSingle();
  if (!event) return;
  const [renderable, technicians, deliveriesRes, routesRes] = await Promise.all([
    toRenderable(db, event),
    loadTechnicians(db, event.user_id),
    db.from("chat_deliveries").select("*").eq("event_id", eventId).eq("status", "sent"),
    db.from("chat_routes").select("connection_id, include_contact_details, actions_enabled").eq("user_id", event.user_id).eq("event_type", event.event_type),
  ]);
  const tokens = new Map<string, string>();
  for (const d of deliveriesRes.data ?? []) {
    const route = (routesRes.data ?? []).find((r: { connection_id: string }) => r.connection_id === d.connection_id);
    if (!route || !d.external_message_id) continue;
    const model = modelFor(renderable, route, technicians);
    try {
      if (d.provider === "slack") {
        if (!tokens.has(d.connection_id)) tokens.set(d.connection_id, await getSlackToken(db, d.connection_id));
        await slackUpdate(tokens.get(d.connection_id)!, d.channel_id, d.external_message_id, model);
      } else if (d.provider === "teams" && d.service_url && d.external_conversation_id) {
        await teamsUpdate(d.service_url, d.external_conversation_id, d.external_message_id, model);
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "chat_refresh_failed", delivery_id: d.id, error: e instanceof Error ? e.message : String(e) }));
    }
  }
}

// ============================== Delivery ==============================
// deno-lint-ignore no-explicit-any
export async function sendToRoute(db: Db, route: any, conn: any, model: MessageModel): Promise<SendResult> {
  if (conn.provider === "slack") return slackPost(await getSlackToken(db, conn.id), route.channel_id, model);
  const { data: ch } = await db.from("chat_channels").select("service_url").eq("connection_id", conn.id).eq("channel_id", route.channel_id).maybeSingle();
  const serviceUrl = ch?.service_url || "https://smba.trafficmanager.net/teams/";
  return teamsPost(serviceUrl, conn.external_id, route.channel_id, model);
}

export interface DeliverySummary { sent: number; failed: number; skipped: number }

// deno-lint-ignore no-explicit-any
export async function deliverToRoute(db: Db, event: any, route: any, technicians: Technician[]): Promise<"sent" | "failed" | "skipped"> {
  const conn = route.connection;
  const base = { event_id: event.id, user_id: event.user_id, connection_id: route.connection_id, provider: conn?.provider ?? "slack", channel_id: route.channel_id, channel_name: route.channel_name };

  const skip = async (reason: string) => {
    await db.from("chat_deliveries").upsert({ ...base, status: "skipped", error: reason, updated_at: new Date().toISOString() }, { onConflict: "event_id,connection_id", ignoreDuplicates: true });
    return "skipped" as const;
  };
  if (!conn || conn.status !== "connected") return skip("Connection is not active.");
  if (event.event_type === "low_csat" && Number(event.payload?.rating) > route.csat_threshold) return skip(`Rating above the ${route.csat_threshold}-star threshold.`);

  const { data: existing } = await db.from("chat_deliveries").select("id, status, attempts").eq("event_id", event.id).eq("connection_id", route.connection_id).maybeSingle();
  if (existing?.status === "sent") return "sent";

  const model = modelFor(await toRenderable(db, event), route, technicians);
  let attempts = existing?.attempts ?? 0;
  let result: SendResult = { ok: false, error: "Not attempted." };
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    attempts++;
    try {
      result = await sendToRoute(db, route, conn, model);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true };
    }
    if (result.ok || !result.retryable) break;
    await sleep(400 * 3 ** i);
  }

  await db.from("chat_deliveries").upsert(
    {
      ...base,
      status: result.ok ? "sent" : "failed",
      attempts,
      error: result.ok ? null : (result.error ?? "Unknown error").slice(0, 500),
      external_message_id: result.messageId ?? null,
      external_conversation_id: result.conversationId ?? null,
      service_url: result.serviceUrl ?? null,
      sent_at: result.ok ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "event_id,connection_id" },
  );
  if (result.fatalConnection) {
    await db.from("chat_connections").update({ status: "error", last_error: result.error, updated_at: new Date().toISOString() }).eq("id", route.connection_id);
  }
  return result.ok ? "sent" : "failed";
}

export async function deliverEvent(db: Db, eventId: string): Promise<DeliverySummary> {
  const summary: DeliverySummary = { sent: 0, failed: 0, skipped: 0 };
  const { data: event } = await db.from("chat_events").select("*").eq("id", eventId).maybeSingle();
  if (!event) return summary;
  const { data: routes } = await db.from("chat_routes").select("*, connection:chat_connections(*)").eq("user_id", event.user_id).eq("event_type", event.event_type).eq("enabled", true);
  if (!routes?.length) return summary;
  const technicians = routes.some((r: { actions_enabled: boolean }) => r.actions_enabled) ? await loadTechnicians(db, event.user_id) : [];
  for (const route of routes) summary[await deliverToRoute(db, event, route, technicians)]++;
  return summary;
}
