// supabase/functions/qbo-webhook/index.ts
//
// Receives Intuit webhooks (a record changed in QuickBooks) and asks qbo-sync-run to pull right away,
// so QuickBooks edits show up in Vireek within seconds instead of at the next 15-minute run.
//
// REQUIRED SECRETS: QBO_WEBHOOK_VERIFIER_TOKEN (Intuit app > Webhooks), CRON_SECRET.
// In the Intuit app, set the webhook endpoint URL to
//   https://<project-ref>.supabase.co/functions/v1/qbo-webhook
// and subscribe to Customer, Item, Account, Invoice and Payment (Create + Update + Void).
//
// The request is authenticated ONLY by the intuit-signature HMAC; the payload is never trusted for
// anything except "which company changed". Always answers 200 quickly (Intuit retries on failure).
//
// Deploy: supabase functions deploy qbo-webhook --no-verify-jwt

import { verifyWebhookSignature, webhookRealms } from "../_shared/quickbooks/engine.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const verifier = Deno.env.get("QBO_WEBHOOK_VERIFIER_TOKEN") ?? "";
  const cron = Deno.env.get("CRON_SECRET") ?? "";
  if (!verifier || !cron) return new Response("Not configured", { status: 503 });

  const raw = await req.text();
  if (!(await verifyWebhookSignature(raw, req.headers.get("intuit-signature"), verifier))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let realms: string[] = [];
  try {
    realms = webhookRealms(JSON.parse(raw));
  } catch {
    return new Response("OK", { status: 200 });
  }
  if (realms.length === 0) return new Response("OK", { status: 200 });

  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/qbo-sync-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cron-Secret": cron },
      body: JSON.stringify({ action: "webhook", realm_ids: realms }),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "qbo_webhook_forward_failed", error: error instanceof Error ? error.message : String(error) }));
  }
  return new Response("OK", { status: 200 });
});
