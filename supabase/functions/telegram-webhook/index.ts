// Telegram bot webhook for the Unified Inbox (one bot per tenant).
//
// Registered by dm-connect via setWebhook with  ?c=<connection id>  and a per-connection
// secret_token, which Telegram echoes in X-Telegram-Bot-Api-Secret-Token on every update.
// Only that header proves the request came from Telegram, so it is checked in constant time
// before anything is read or written.
//
// DEPLOY:  supabase functions deploy telegram-webhook --no-verify-jwt   (config.toml also sets verify_jwt=false)
// Responses: 404 unknown / disconnected connection, 403 bad secret, 500 only when storing the
// message genuinely failed (Telegram retries; storage is idempotent so a retry is always safe).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendTelegram } from "../_shared/dmChannels/api.ts";
import { persistInbound, recordSystemReply, type DmConnection } from "../_shared/dmChannels/inbound.ts";
import { optInAckText, optOutAckText, parseTelegramUpdate, safeEqual } from "../_shared/dmChannels/protocol.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = () => new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const connectionId = new URL(req.url).searchParams.get("c") ?? "";
  if (!UUID_RE.test(connectionId)) return new Response("Not found", { status: 404 });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const { data } = await admin
    .from("dm_channel_connections")
    .select("id, user_id, channel, external_account_id, access_token, webhook_secret, display_name, status")
    .eq("id", connectionId).eq("channel", "telegram").maybeSingle();
  const conn = data as DmConnection | null;
  if (!conn || conn.status !== "connected" || !conn.webhook_secret) return new Response("Not found", { status: 404 });

  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", conn.webhook_secret)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const msg = parseTelegramUpdate(await req.json(), conn.external_account_id);
    if (!msg) return ok(); // edits, groups, callbacks, bots… are intentionally not stored

    const outcome = await persistInbound(admin, conn.user_id, msg);
    if (!outcome.duplicate && outcome.keyword) {
      const brand = conn.display_name ?? "us";
      const ack = outcome.keyword === "stop" ? optOutAckText(brand) : optInAckText(brand);
      const sent = await sendTelegram(conn.access_token, msg.customerId, ack);
      if (sent.ok) await recordSystemReply(admin, outcome.conversationId, ack, sent.providerMessageId);
    }
    return ok();
  } catch (error) {
    console.error(JSON.stringify({ event: "telegram_webhook_failed", error: error instanceof Error ? error.message : String(error) }));
    return new Response(JSON.stringify({ error: "processing_failed" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
