// Aggregator webhook for RCS Business Messaging + Apple Messages for Business (Sinch Conversation API).
// Counterpart of sms-webhook for the two rich channels: inbound messages / button taps, delivery +
// read receipts, capability answers, provider opt-outs and Apple "conversation deleted" events.
//
// DEPLOY:   supabase functions deploy rich-webhook --no-verify-jwt   (config.toml also sets verify_jwt=false)
// SECRETS:  SINCH_WEBHOOK_SECRET (required), SINCH_PROJECT_ID, SINCH_KEY_ID, SINCH_KEY_SECRET
// SETUP:    Sinch Conversation API app -> Webhooks -> target = this function's URL, secret = SINCH_WEBHOOK_SECRET,
//           triggers: MESSAGE_INBOUND, MESSAGE_DELIVERY, EVENT_INBOUND, CAPABILITY, OPT_OUT.
//
// Unlike sms-webhook (always 200 to stop Twilio retry storms) this returns:
//   401 bad / missing signature (fails CLOSED when the secret is unset)
//   500 only when processing genuinely failed, so Sinch retries; every event is de-duplicated
//       (rich_webhook_events) and every handler is idempotent, so a retry is always safe.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  handleCapability, handleConversationDeleted, handleInbound, handleProviderOptOut,
} from "../_shared/richMessaging/inbound.ts";
import { createRichDeps } from "../_shared/richMessaging/runtime.ts";
import { applyDelivery } from "../_shared/richMessaging/send.ts";
import { eventKey, parseSinchEvents, verifySinchSignature } from "../_shared/richMessaging/sinch.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const rawBody = await req.text();
  const verified = await verifySinchSignature({ rawBody, headers: req.headers, secret: Deno.env.get("SINCH_WEBHOOK_SECRET") });
  if (!verified.ok) {
    console.error(JSON.stringify({ event: "rich_webhook_rejected", reason: verified.reason }));
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const events = parseSinchEvents(payload);
  if (events.length === 0) return json({ received: true, processed: 0 });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  const deps = createRichDeps(admin);

  let processed = 0;
  let failed = false;

  for (const ev of events) {
    const key = eventKey(ev);
    const claim = await admin.from("rich_webhook_events").insert({ provider: "sinch", event_key: key });
    if (claim.error) {
      if (claim.error.code === "23505") continue; // provider retry of an event we already handled
      console.error(JSON.stringify({ event: "rich_webhook_claim_failed", key, error: claim.error.message }));
      failed = true;
      continue;
    }

    try {
      switch (ev.type) {
        case "inbound": {
          const outcome = await handleInbound(deps, ev);
          if (outcome === "unknown_account") console.error(JSON.stringify({ event: "rich_webhook_unknown_app", appId: ev.appId }));
          break;
        }
        case "delivery":
          await applyDelivery(deps, ev);
          break;
        case "capability":
          await handleCapability(deps, ev);
          break;
        case "opt_out":
          await handleProviderOptOut(deps, ev);
          break;
        case "conversation_deleted":
          await handleConversationDeleted(deps, ev);
          break;
      }
      processed++;
    } catch (error) {
      failed = true;
      console.error(JSON.stringify({ event: "rich_webhook_failed", type: ev.type, error: error instanceof Error ? error.message : String(error) }));
      await admin.from("rich_webhook_events").delete().eq("provider", "sinch").eq("event_key", key); // release so the retry reprocesses
    }
  }

  return failed ? json({ error: "processing_failed", processed }, 500) : json({ received: true, processed });
});
