// supabase/functions/lead-marketplace-ingest/index.ts
//
// Webhook receiver for lead marketplaces (Angi, HomeAdvisor, Thumbtack,
// Nextdoor, Google LSA — or Zapier/Make forwarding their notifications).
//
//   POST  <functions-url>/lead-marketplace-ingest?token=<source webhook_token>
//         JSON or form-urlencoded body. Token may also be sent as
//         `X-Vireek-Token` or `Authorization: Bearer <token>` (preferred when the
//         sender supports custom headers — URLs end up in logs).
//
//   POST  ...?action=sweep   (header X-Cron-Secret: $CRON_SECRET)
//         retries failed/stuck/quiet-hours auto-responses, purges old raw payloads.
//
// The token identifies the tenant AND the provider, so no provider/tenant ids
// travel in the URL. The response is always fast: the lead row is created
// synchronously, the < 60 s auto-response runs in EdgeRuntime.waitUntil.
//
// Deploy: supabase functions deploy lead-marketplace-ingest --no-verify-jwt
// (external senders cannot present a Supabase JWT; the secret token is the auth.)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { ingestParsedLead, sweepPending } from "../_shared/lead-marketplace/ingest.ts";
import { parseWebhookPayload } from "../_shared/lead-marketplace/parsers.ts";
import { createDeps } from "../_shared/lead-marketplace/runtime.ts";

const MAX_BODY_BYTES = 256 * 1024;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractToken(req: Request, url: URL): string {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  return (req.headers.get("x-vireek-token") ?? "").trim() || bearer || (url.searchParams.get("token") ?? "").trim();
}

async function readBody(req: Request): Promise<{ raw: string; body: unknown } | { tooLarge: true }> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return { tooLarge: true };
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return { tooLarge: true };
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("application/x-www-form-urlencoded")) {
    return { raw, body: Object.fromEntries(new URLSearchParams(raw).entries()) };
  }
  try {
    return { raw, body: JSON.parse(raw) };
  } catch {
    return { raw, body: null };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  const deps = createDeps(admin);

  if (url.searchParams.get("action") === "sweep") {
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (!cronSecret || !timingSafeEqual(req.headers.get("x-cron-secret") ?? "", cronSecret)) return json({ error: "Unauthorized" }, 401);
    try {
      return json({ ok: true, ...(await sweepPending(deps)) });
    } catch (error) {
      console.error(JSON.stringify({ event: "lead_marketplace_sweep_failed", error: String(error) }));
      return json({ error: "Sweep failed" }, 500);
    }
  }

  const token = extractToken(req, url);
  if (token.length < 20) return json({ error: "Unauthorized" }, 401);
  const source = await deps.store.getSourceByToken(token);
  if (!source) return json({ error: "Unauthorized" }, 401);

  const read = await readBody(req);
  if ("tooLarge" in read) return json({ error: "Payload too large" }, 413);

  const receivedAtMs = Date.now();
  const items = Array.isArray(read.body) ? read.body.slice(0, 20) : [read.body];
  const results: Array<{ status: string; leadId?: string | null; error?: string }> = [];

  for (const item of items) {
    const parsed = parseWebhookPayload(source.provider, item);
    if (!parsed.ok) {
      // 200 on purpose: a 4xx makes some marketplaces disable the webhook. The raw
      // body is kept as a parse_failed event so the parser can be tuned from it.
      await deps.store.insertFailedEvent({
        user_id: source.user_id,
        source_id: source.id,
        provider: source.provider,
        received_via: "webhook",
        parse_error: `${parsed.reason}: ${parsed.detail}`,
        raw_payload: read.raw.slice(0, 16_000),
        received_at: new Date(receivedAtMs).toISOString(),
      });
      results.push({ status: "parse_failed", error: parsed.reason });
      continue;
    }
    try {
      const outcome = await ingestParsedLead(deps, { source, receivedVia: "webhook", parsed: parsed.lead, rawPayload: read.raw, receivedAtMs });
      results.push({ status: outcome.status, leadId: outcome.leadId });
    } catch (error) {
      console.error(JSON.stringify({ event: "lead_marketplace_ingest_failed", provider: source.provider, error: String(error) }));
      return json({ error: "Temporary failure, please retry" }, 500); // retry -> idempotent duplicate path
    }
  }

  return json({ received: true, results });
});
