// supabase/functions/synthetic-webhook-sink/index.ts
//
// Receiver for the probe tenant's outbound webhook. dispatch-webhook POSTs { event, data } to the URL
// saved in the probe tenant's "webhook" integration:
//   https://<project-ref>.supabase.co/functions/v1/synthetic-webhook-sink?t=<synthetic_probe_targets.sink_token>
// Every accepted delivery becomes a row in synthetic_webhook_receipts, which synthetic-probe uses to
// measure webhook delivery latency.
//
// Deploy: supabase functions deploy synthetic-webhook-sink --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const MAX_BODY_BYTES = 64 * 1024;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });

  const token = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) return reply(401, { error: "Unauthorized" });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return reply(413, { error: "Payload too large" });
  let body: { event?: unknown; data?: Record<string, unknown> | null };
  try {
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: "Invalid JSON" });
  }
  if (typeof body.event !== "string" || body.event.length === 0 || body.event.length > 64) {
    return reply(400, { error: "Missing event" });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return reply(500, { error: "Server not configured" });
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: target } = await admin.from("synthetic_probe_targets").select("id").eq("sink_token", token).maybeSingle();
  if (!target) return reply(401, { error: "Unauthorized" });

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
