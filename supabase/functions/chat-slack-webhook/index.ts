// Single Request URL for Slack's "Interactivity & Shortcuts" (button clicks) AND "Event Subscriptions"
// (app_uninstalled / tokens_revoked / URL verification). Every request is signature-verified.
// Secrets: SLACK_SIGNING_SECRET, CHAT_TOKEN_ENCRYPTION_KEY
// Deploy:  supabase functions deploy chat-slack-webhook --no-verify-jwt

import { verifySlackSignature } from "../_shared/chat-notify/security.ts";
import { SLACK_ACTION_ACK, SLACK_ACTION_ASSIGN, eventIdFromBlockId } from "../_shared/chat-notify/slackBlocks.ts";
import { acknowledgeEvent, assignEvent, type ActionResult } from "../_shared/chat-notify/actions.ts";
import { refreshEventMessages } from "../_shared/chat-notify/delivery.ts";
import { adminClient, runInBackground, type Db } from "../_shared/chat-notify/server.ts";

interface BlockActionsPayload {
  type: string;
  team?: { id: string };
  user?: { id: string; name?: string; username?: string; team_id?: string };
  response_url?: string;
  actions?: { action_id: string; block_id?: string; selected_option?: { value: string } }[];
}

async function whisper(responseUrl: string | undefined, text: string) {
  if (!responseUrl?.startsWith("https://hooks.slack.com/")) return;
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
    signal: AbortSignal.timeout(8_000),
  });
}

async function handleBlockActions(db: Db, p: BlockActionsPayload) {
  const teamId = p.team?.id ?? p.user?.team_id;
  const action = p.actions?.[0];
  if (!teamId || !action) return;
  const eventId = eventIdFromBlockId(action.block_id);
  if (!eventId) return;

  const { data: conn } = await db.from("chat_connections").select("user_id").eq("provider", "slack").eq("external_id", teamId).eq("status", "connected").maybeSingle();
  if (!conn) return;

  const actor = p.user?.name || p.user?.username || p.user?.id || "Slack user";
  let result: ActionResult;
  if (action.action_id === SLACK_ACTION_ACK) {
    result = await acknowledgeEvent(db, { eventId, ownerId: conn.user_id, actor, provider: "slack" });
  } else if (action.action_id === SLACK_ACTION_ASSIGN && action.selected_option?.value) {
    result = await assignEvent(db, { eventId, ownerId: conn.user_id, technicianId: action.selected_option.value, actor, provider: "slack" });
  } else {
    return; // e.g. the "Open in Vireek" link button also posts an interaction — nothing to do.
  }

  await refreshEventMessages(db, eventId);
  if (!result.ok || result.already) await whisper(p.response_url, result.message);
}

async function handleEvent(db: Db, body: { team_id?: string; event?: { type: string } }) {
  const type = body.event?.type;
  if ((type === "app_uninstalled" || type === "tokens_revoked") && body.team_id) {
    const { data: conn } = await db.from("chat_connections").select("id").eq("provider", "slack").eq("external_id", body.team_id).maybeSingle();
    if (!conn) return;
    await db.from("chat_connection_secrets").delete().eq("connection_id", conn.id);
    await db.from("chat_connections").update({ status: "disconnected", last_error: "Slack app was uninstalled from the workspace.", updated_at: new Date().toISOString() }).eq("id", conn.id);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await req.text();
  const ok = await verifySlackSignature(Deno.env.get("SLACK_SIGNING_SECRET") ?? "", req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature"), raw);
  if (!ok) return new Response("Invalid signature", { status: 401 });

  const db = adminClient();
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    let body: { type?: string; challenge?: string; team_id?: string; event?: { type: string } };
    try { body = JSON.parse(raw); } catch { return new Response("Bad request", { status: 400 }); }
    if (body.type === "url_verification") return new Response(JSON.stringify({ challenge: body.challenge }), { headers: { "Content-Type": "application/json" } });
    const pending = runInBackground(handleEvent(db, body));
    if (pending) await pending;
    return new Response("", { status: 200 });
  }

  let payload: BlockActionsPayload;
  try { payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? ""); } catch { return new Response("Bad request", { status: 400 }); }
  if (payload.type === "block_actions") {
    const pending = runInBackground(handleBlockActions(db, payload)); // Slack needs a reply within 3s
    if (pending) await pending;
  }
  return new Response("", { status: 200 });
});
