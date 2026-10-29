// supabase/functions/acct-webhook/index.ts
//
// Receives Xero webhooks (an invoice or contact changed) and asks acct-sync-run to pull right away, so Xero
// edits show up in Vireek within seconds instead of at the next 15-minute run. Zoho Books and NetSuite have no
// signed webhooks, so they use the scheduled sync.
//
// REQUIRED SECRETS: XERO_WEBHOOK_KEY (Xero app > Webhooks > signing key), CRON_SECRET.
// In the Xero app, set the delivery URL to  https://<project-ref>.supabase.co/functions/v1/acct-webhook
// and subscribe to Contacts and Invoices.
//
// Xero's "intent to receive" test needs 200 for a correct signature and 401 for a wrong one (empty body).
// The request is authenticated ONLY by the x-xero-signature HMAC; the payload is never trusted for anything
// except "which organisation changed".
//
// Deploy: supabase functions deploy acct-webhook --no-verify-jwt

import { verifyHmacBase64 } from "../_shared/accounting/core.ts";
import { xeroWebhookTenants } from "../_shared/accounting/xero.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const key = Deno.env.get("XERO_WEBHOOK_KEY") ?? "";
  const cron = Deno.env.get("CRON_SECRET") ?? "";
  if (!key || !cron) return new Response("Not configured", { status: 503 });

  const raw = await req.text();
  if (!(await verifyHmacBase64(raw, req.headers.get("x-xero-signature"), key))) return new Response(null, { status: 401 });

  let tenants: string[] = [];
  try { tenants = xeroWebhookTenants(JSON.parse(raw)); } catch { return new Response(null, { status: 200 }); }
  if (tenants.length === 0) return new Response(null, { status: 200 });

  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/acct-sync-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cron-Secret": cron },
      body: JSON.stringify({ action: "webhook", provider: "xero", tenant_ids: tenants }),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "acct_webhook_forward_failed", error: error instanceof Error ? error.message : String(error) }));
  }
  return new Response(null, { status: 200 });
});
