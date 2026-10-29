// Facebook Messenger webhook for the Unified Inbox (one Meta App for the platform, one Page per tenant).
//
// DEPLOY:   supabase functions deploy messenger-webhook --no-verify-jwt   (config.toml also sets verify_jwt=false)
// SECRETS:  META_APP_SECRET        - Meta App > Settings > Basic > App Secret (signature check, REQUIRED)
//           MESSENGER_VERIFY_TOKEN - any random string; the same value goes into the Meta webhook setup
//           META_GRAPH_VERSION     - optional, defaults to the version pinned in _shared/dmChannels/protocol.ts
// SETUP:    Meta App > Messenger > Webhooks: Callback URL = this function's URL, Verify Token =
//           MESSENGER_VERIFY_TOKEN, subscribe the `messages` field. Tenant Pages are subscribed to the
//           app by dm-connect.
//
// Fails CLOSED: without META_APP_SECRET every POST is rejected. Invalid signature = 401.
// 500 only when storing genuinely failed (Meta retries; storage is idempotent on the message id).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { fetchMessengerName, sendMessenger } from "../_shared/dmChannels/api.ts";
import { persistInbound, recordSystemReply, type DmConnection } from "../_shared/dmChannels/inbound.ts";
import { optInAckText, optOutAckText, parseMessengerEvents, safeEqual, verifyMetaSignature } from "../_shared/dmChannels/protocol.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  // Meta webhook verification handshake.
  if (req.method === "GET") {
    const url = new URL(req.url);
    const expected = Deno.env.get("MESSENGER_VERIFY_TOKEN");
    if (expected && url.searchParams.get("hub.mode") === "subscribe" && safeEqual(url.searchParams.get("hub.verify_token") ?? "", expected)) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const appSecret = Deno.env.get("META_APP_SECRET");
  if (!appSecret) {
    console.error(JSON.stringify({ event: "messenger_webhook_misconfigured", error: "META_APP_SECRET is not set" }));
    return json({ error: "not_configured" }, 500);
  }
  const rawBody = await req.text();
  if (!(await verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256"), appSecret))) {
    return json({ error: "invalid_signature" }, 401);
  }

  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { return json({ error: "invalid_json" }, 400); }

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const connections = new Map<string, DmConnection | null>();

  try {
    for (const msg of parseMessengerEvents(payload)) {
      if (!connections.has(msg.externalAccountId)) {
        const { data } = await admin
          .from("dm_channel_connections")
          .select("id, user_id, channel, external_account_id, access_token, webhook_secret, display_name, status")
          .eq("channel", "messenger").eq("external_account_id", msg.externalAccountId).eq("status", "connected").maybeSingle();
        connections.set(msg.externalAccountId, data as DmConnection | null);
      }
      const conn = connections.get(msg.externalAccountId);
      if (!conn) {
        console.error(JSON.stringify({ event: "messenger_webhook_unknown_page", pageId: msg.externalAccountId }));
        continue;
      }

      const outcome = await persistInbound(admin, conn.user_id, msg, () => fetchMessengerName(conn.access_token, msg.customerId));
      if (!outcome.duplicate && outcome.keyword) {
        const brand = conn.display_name ?? "us";
        const ack = outcome.keyword === "stop" ? optOutAckText(brand) : optInAckText(brand);
        const sent = await sendMessenger(conn.access_token, msg.customerId, ack);
        if (sent.ok) await recordSystemReply(admin, outcome.conversationId, ack, sent.providerMessageId);
      }
    }
    return json({ received: true });
  } catch (error) {
    console.error(JSON.stringify({ event: "messenger_webhook_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "processing_failed" }, 500);
  }
});
