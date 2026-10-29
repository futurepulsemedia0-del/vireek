// supabase/functions/xero-webhook/index.ts
//
// Receives Xero webhooks (an invoice or contact changed) and asks xero-sync-run to pull right away.
// Xero webhooks only cover contacts and invoices; items, accounts, payments and tax rates are picked
// up by the 15-minute scheduled sync (a payment normally also fires an invoice event).
//
// REQUIRED SECRETS: XERO_WEBHOOK_KEY (Xero app > Webhooks > Signing key), CRON_SECRET.
// In the Xero app set the delivery URL to
//   https://<project-ref>.supabase.co/functions/v1/xero-webhook
// and subscribe to Invoices and Contacts. Xero verifies the endpoint with an "intent to receive"
// request: valid signature -> 200 with an empty body, invalid signature -> 401. This function does
// exactly that and answers within milliseconds (Xero allows 5 seconds).
//
// The request is authenticated ONLY by the x-xero-signature HMAC; the payload is never trusted for
// anything except "which organisation changed". Duplicate deliveries are harmless: a sync is a
// lock-guarded, idempotent merge.
//
// Deploy: supabase functions deploy xero-webhook --no-verify-jwt

import { verifyWebhookSignature, webhookTenants } from "../_shared/xero/engine.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response(null, { status: 405 });

  const key = Deno.env.get("XERO_WEBHOOK_KEY") ?? "";
  const cron = Deno.env.get("CRON_SECRET") ?? "";
  if (!key || !cron) return new Response(null, { status: 503 });

  const raw = await req.text();
  if (!(await verifyWebhookSignature(raw, req.headers.get("x-xero-signature"), key))) {
    return new Response(null, { status: 401 });
  }

  let tenants: string[] = [];
  try {
    tenants = webhookTenants(JSON.parse(raw));
  } catch {
    return new Response(null, { status: 200 });
  }
  if (tenants.length === 0) return new Response(null, { status: 200 }); // intent-to-receive probe

  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/xero-sync-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cron-Secret": cron },
      body: JSON.stringify({ action: "webhook", tenant_ids: tenants }),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "xero_webhook_forward_failed", error: error instanceof Error ? error.message : String(error) }));
  }
  return new Response(null, { status: 200 });
});
