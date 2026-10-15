// Bot Framework messaging endpoint ("Messaging endpoint" of your Azure Bot):
//   https://<project-ref>.supabase.co/functions/v1/chat-teams-bot
// Handles (1) app installed / channels changed -> refresh the channel cache, (2) Acknowledge / Assign card buttons.
// Every request carries a Bot Framework JWT which is verified (issuer, audience, serviceUrl claim).
// Secrets: TEAMS_BOT_APP_ID, TEAMS_BOT_APP_SECRET, TEAMS_BOT_TENANT_ID, SITE_URL
// Deploy:  supabase functions deploy chat-teams-bot --no-verify-jwt

import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";
import { isTrustedServiceUrl } from "../_shared/chat-notify/security.ts";
import { TEAMS_ACTION_ACK, TEAMS_ACTION_ASSIGN, TEAMS_FIELD_TECH } from "../_shared/chat-notify/teamsCards.ts";
import { acknowledgeEvent, assignEvent, type ActionResult } from "../_shared/chat-notify/actions.ts";
import { refreshEventMessages, syncTeamChannels, teamsReply } from "../_shared/chat-notify/delivery.ts";
import { adminClient, runInBackground, type Db } from "../_shared/chat-notify/server.ts";

const JWKS = createRemoteJWKSet(new URL("https://login.botframework.com/v1/.well-known/keys"));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Activity {
  type: string;
  id?: string;
  replyToId?: string;
  serviceUrl?: string;
  action?: string;
  from?: { name?: string; id?: string };
  recipient?: { id?: string };
  membersAdded?: { id?: string }[];
  conversation?: { id?: string; tenantId?: string };
  channelData?: { tenant?: { id?: string }; team?: { id?: string; name?: string }; eventType?: string };
  value?: { vk?: string; e?: string; technicianId?: string };
}

async function authorized(req: Request, activity: Activity): Promise<boolean> {
  const appId = Deno.env.get("TEAMS_BOT_APP_ID");
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!appId || !token) return false;
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: "https://api.botframework.com", audience: appId });
    const claim = payload.serviceurl as string | undefined;
    return !claim || claim.replace(/\/+$/, "") === (activity.serviceUrl ?? "").replace(/\/+$/, "");
  } catch {
    return false;
  }
}

const CHANNEL_EVENTS = new Set(["channelCreated", "channelDeleted", "channelRenamed", "channelRestored", "teamRenamed"]);

async function handleInstall(db: Db, conn: { id: string; user_id: string }, a: Activity) {
  const team = a.channelData?.team;
  if (!team?.id || !isTrustedServiceUrl(a.serviceUrl)) return;

  if (a.type === "installationUpdate" && a.action === "remove") {
    const { data: gone } = await db.from("chat_channels").select("channel_id").eq("connection_id", conn.id).eq("team_id", team.id);
    const ids = (gone ?? []).map((c: { channel_id: string }) => c.channel_id);
    if (ids.length) await db.from("chat_routes").delete().eq("connection_id", conn.id).in("channel_id", ids);
    await db.from("chat_channels").delete().eq("connection_id", conn.id).eq("team_id", team.id);
    return;
  }

  const botAdded = a.type === "conversationUpdate" && !!a.membersAdded?.some((m) => m.id && m.id === a.recipient?.id);
  const channelChange = a.type === "conversationUpdate" && CHANNEL_EVENTS.has(a.channelData?.eventType ?? "");
  const installed = a.type === "installationUpdate" && (a.action === "add" || a.action === "add-upgrade");
  if (botAdded || channelChange || installed) await syncTeamChannels(db, conn, a.serviceUrl, team.id, team.name ?? null);
}

async function handleButton(db: Db, conn: { user_id: string }, a: Activity) {
  const v = a.value;
  if (!v?.vk || !v.e || !UUID.test(v.e) || !isTrustedServiceUrl(a.serviceUrl)) return;
  const actor = a.from?.name || "Teams user";
  let result: ActionResult;

  if (v.vk === TEAMS_ACTION_ACK) {
    result = await acknowledgeEvent(db, { eventId: v.e, ownerId: conn.user_id, actor, provider: "teams" });
  } else if (v.vk === TEAMS_ACTION_ASSIGN) {
    const techId = v.technicianId ?? (a.value as Record<string, string> | undefined)?.[TEAMS_FIELD_TECH];
    if (!techId) {
      if (a.conversation?.id && a.id) await teamsReply(a.serviceUrl, a.conversation.id, a.id, "Pick a team member from the dropdown first, then press Assign.");
      return;
    }
    result = await assignEvent(db, { eventId: v.e, ownerId: conn.user_id, technicianId: techId, actor, provider: "teams" });
  } else {
    return;
  }

  await refreshEventMessages(db, v.e);
  if ((!result.ok || result.already) && a.conversation?.id && (a.replyToId || a.id)) {
    await teamsReply(a.serviceUrl, a.conversation.id, (a.replyToId ?? a.id)!, result.message);
  }
}

async function process(db: Db, a: Activity) {
  const tenantId = a.channelData?.tenant?.id ?? a.conversation?.tenantId;
  if (!tenantId) return;
  const { data: conn } = await db.from("chat_connections").select("id, user_id").eq("provider", "teams").eq("external_id", tenantId).eq("status", "connected").maybeSingle();
  if (!conn) return; // tenant isn't linked to any Vireek account
  if (a.type === "message" && a.value?.vk) return handleButton(db, conn, a);
  if (a.type === "conversationUpdate" || a.type === "installationUpdate") return handleInstall(db, conn, a);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let activity: Activity;
  try { activity = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
  if (!(await authorized(req, activity))) return new Response("Unauthorized", { status: 401 });

  const pending = runInBackground(process(adminClient(), activity));
  if (pending) await pending;
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
});
