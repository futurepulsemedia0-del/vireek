// supabase/functions/synthetic-webhook-sink/index.ts
//
// Receiver for the probe tenant's outbound webhook. dispatch-webhook POSTs { event, data } to the URL
// saved in the probe tenant's "webhook" integration:
//   https://<project-ref>.supabase.co/functions/v1/synthetic-webhook-sink?t=<synthetic_probe_targets.sink_token>
// Every accepted delivery becomes a row in synthetic_webhook_receipts, which synthetic-probe uses to
// measure webhook delivery latency.
// Authentication (two layers):
//   1. the unguessable ?t= sink token (looked up in synthetic_probe_targets), and
//   2. an HMAC signature added by dispatch-webhook when the probe tenant's webhook integration has
//      config.signing_secret:  X-Vireek-Timestamp + X-Vireek-Signature: sha256=<HMAC(secret, `${ts}.${rawBody}`)>.
//      The same value must be set here as SYNTHETIC_SINK_SIGNING_SECRET (SYNTHETIC_SINK_SIGNING_SECRET_NEXT for rotation).
//      SYNTHETIC_SINK_SIG_MODE=shadow (default) logs would-be rejections, =enforce rejects with 401.
// A client IP rate limit runs before the database lookup.
//
//
// Deploy: supabase functions deploy synthetic-webhook-sink --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { guardPublic } from "../_shared/http/publicGuardDeno.ts";
import { dbReplayStore } from "../_shared/http/rateLimit.ts";
import { applySignedInboundPolicy, parseMode, verifyInboundSignature } from "../_shared/http/signedInbound.ts";

const MAX_BODY_BYTES = 64 * 1024;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
  // Pre-auth limit per client IP (the probe sends ~1 delivery/minute). Fail closed.
  const ipBlocked = await guardPublic(req, { endpoint: "synthetic-webhook-sink", limit: 60, windowSeconds: 60, failClosed: true });
  if (ipBlocked) return ipBlocked;

  const token = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) return reply(401, { error: "Unauthorized" });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return reply(413, { error: "Payload too large" });
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return reply(500, { error: "Server not configured" });
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: target } = await admin.from("synthetic_probe_targets").select("id").eq("sink_token", token).maybeSingle();
  if (!target) return reply(401, { error: "Unauthorized" });

  // HMAC over the raw body: timestamp tolerance + one-time claim of each signed request.
  const sigVerdict = await verifyInboundSignature({
    provider: `synthetic-sink:${target.id}`,
    rawBody: raw,
    headers: req.headers,
    secrets: [Deno.env.get("SYNTHETIC_SINK_SIGNING_SECRET"), Deno.env.get("SYNTHETIC_SINK_SIGNING_SECRET_NEXT")],
    replay: dbReplayStore({ rpc: (fn, args) => admin.rpc(fn, args) }),
  });
  const sigBlocked = applySignedInboundPolicy("synthetic-webhook-sink", sigVerdict, parseMode(Deno.env.get("SYNTHETIC_SINK_SIG_MODE")));
  if (sigBlocked) return sigBlocked;

  // Parse only AFTER the token and signature were checked.
  let body: { event?: unknown; data?: Record<string, unknown> | null };
  try {
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: "Invalid JSON" });
  }
  if (typeof body.event !== "string" || body.event.length === 0 || body.event.length > 64) {
    return reply(400, { error: "Missing event" });
  }
  
  const data = body.data ?? {};
  const createdAt = typeof data.created_at === "string" && !Number.isNaN(Date.parse(data.created_at)) ? data.created_at : null;
  const { error } = await admin.from("synthetic_webhook_receipts").insert({
    target_id: target.id,
    event: body.event,
    record_id: typeof data.id === "string" ? data.id : null,
    record_created_at: createdAt,
    payload_bytes: raw.length,
  });
  if (error) return reply(500, { error: "Could not record receipt" });
  return reply(200, { ok: true });
});
