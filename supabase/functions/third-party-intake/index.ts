// supabase/functions/third-party-intake/index.ts
//
// API intake for warranty / insurance / manufacturer / property-manager partners
// (or Zapier/Make forwarding their notifications).
//
//   POST  <functions-url>/third-party-intake
//         Header  X-Vireek-Token: <partner intake token>   (or Authorization: Bearer <token>)
//         Body    JSON object, or an array of up to 20 objects
//         ?token=<token> also works for senders that cannot set headers (URLs end up in logs).
//
//   POST  ...?action=sweep   (header X-Cron-Secret: $CRON_SECRET)
//         SLA at-risk / breached notifications + 30-day raw payload purge.
//
// The token identifies the tenant AND the partner. Requests are idempotent: the same
// partner + reference returns the existing request ({ duplicate: true }), so partners can retry safely.
//
// Deploy: supabase functions deploy third-party-intake --no-verify-jwt
// (external senders cannot present a Supabase JWT; the secret token is the auth.)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { parseApiPayload } from "../_shared/third-party-intake/core.ts";
import { getPayerByToken, ingestIntake } from "../_shared/third-party-intake/runtime.ts";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_ITEMS = 20;

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

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  if (url.searchParams.get("action") === "sweep") {
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (!cronSecret || !timingSafeEqual(req.headers.get("x-cron-secret") ?? "", cronSecret)) return json({ error: "Unauthorized" }, 401);
    const { data, error } = await admin.rpc("third_party_intake_sla_sweep");
    if (error) {
      console.error(JSON.stringify({ event: "third_party_sweep_failed", error: error.message }));
      return json({ error: "Sweep failed" }, 500);
    }
    return json({ ok: true, ...(data as Record<string, unknown>) });
  }

  const token = extractToken(req, url);
  if (token.length < 20) return json({ error: "Unauthorized" }, 401);
  const payer = await getPayerByToken(admin, token);
  if (!payer) return json({ error: "Unauthorized" }, 401);

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return json({ error: "Payload too large" }, 413);
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return json({ error: "Payload too large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_json", detail: "The body must be valid JSON." }, 400);
  }

  const items = Array.isArray(body) ? body.slice(0, MAX_ITEMS) : [body];
  const results: Array<Record<string, unknown>> = [];

  for (const item of items) {
    const parsed = parseApiPayload(item);
    if (!parsed.ok) {
      results.push({ status: "rejected", reason: parsed.reason, detail: parsed.detail });
      continue;
    }
    try {
      const out = await ingestIntake(admin, { payer, via: "api", intake: parsed.intake, raw: JSON.stringify(item) });
      results.push({ status: out.duplicate ? "duplicate" : "created", id: out.id, duplicate: out.duplicate, request_status: out.status });
    } catch (error) {
      console.error(JSON.stringify({ event: "third_party_ingest_failed", payer: payer.id, error: String(error) }));
      return json({ error: "Temporary failure, please retry" }, 500); // safe: retries are idempotent
    }
  }

  const allRejected = results.every((r) => r.status === "rejected");
  return json({ received: !allRejected, results }, allRejected ? 422 : 200);
});
