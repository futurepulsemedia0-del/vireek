// supabase/functions/jobber-webhook/index.ts
//
// Receives Jobber webhooks (Developer Center -> your app -> Webhooks). Acts on APP_DISCONNECT: when a Jobber account
// removes the app, every Vireek connection bound to that account is disconnected and its credentials deleted.
// All other topics are acknowledged and ignored (this app does not subscribe to them).
//
// Per Jobber's docs: respond within 1 second; delivery is at-least-once; authenticity = base64 HMAC-SHA256 of the raw
// body with the app's OAuth client secret in `X-Jobber-Hmac-SHA256`.
//
// Secrets: JOBBER_CLIENT_SECRET (already used for OAuth).
// Deploy:  supabase functions deploy jobber-webhook --no-verify-jwt
// Then in Jobber Developer Center: webhook URL = https://<ref>.supabase.co/functions/v1/jobber-webhook, topic APP_DISCONNECT
// (confirm the topic exists in the WebHookTopicEnum of your GraphQL schema).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { verifyJobberWebhook } from "../_shared/price-book/jobberWebhookSignature.ts";
import { jobberEventKey, parseJobberWebhook } from "../_shared/price-book/jobberWebhook.ts";
import { markPriceBookDisconnected } from "../_shared/price-book/disconnect.ts";

const MAX_BODY_BYTES = 64 * 1024;
const text = (body: string, status: number) => new Response(body, { status, headers: { "Content-Type": "text/plain" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return text("Method not allowed", 405);

  const secret = Deno.env.get("JOBBER_CLIENT_SECRET") ?? "";
  if (!secret) return text("Not configured", 503);

  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return text("Payload too large", 413);
  if (!(await verifyJobberWebhook(raw, req.headers.get("X-Jobber-Hmac-SHA256"), secret))) return text("Invalid signature", 401);

  const event = parseJobberWebhook(raw);
  if (!event) return text("ignored", 200); // authenticated but not a JSON event we understand (e.g. legacy form encoding)

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const key = await jobberEventKey(event);

  try {
    const { error: dedupeError } = await admin.from("jobber_webhook_events").insert({ event_key: key, topic: event.topic });
    if (dedupeError) {
      if ((dedupeError as { code?: string }).code === "23505") return text("duplicate", 200);
      throw new Error("dedupe_failed");
    }

    if (event.topic === "APP_DISCONNECT") {
      const { data, error } = await admin.from("price_book_connections").select("user_id").eq("provider", "jobber").eq("jobber_account_id", event.accountId);
      if (error) throw new Error("lookup_failed");
      for (const row of (data ?? []) as Array<{ user_id: string }>) {
        await markPriceBookDisconnected(admin, row.user_id, "jobber");
      }
      console.log(JSON.stringify({ event: "jobber_app_disconnected", connections: (data ?? []).length }));
    }

    // Opportunistic retention: keep 30 days of de-dupe keys.
    if (Math.random() < 0.01) {
      await admin.from("jobber_webhook_events").delete().lt("received_at", new Date(Date.now() - 30 * 86_400_000).toISOString());
    }
    return text("ok", 200);
  } catch (err) {
    // Release the de-dupe key so Jobber's redelivery is processed, and signal failure.
    await admin.from("jobber_webhook_events").delete().eq("event_key", key);
    console.error(JSON.stringify({ event: "jobber_webhook_failed", topic: event.topic, error: err instanceof Error ? err.message : String(err) }));
    return text("error", 500);
  }
});
