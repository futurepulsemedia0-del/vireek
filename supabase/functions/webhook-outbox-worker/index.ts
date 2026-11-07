// supabase/functions/webhook-outbox-worker/index.ts
//
// Drains webhook_outbox: claims due rows (FOR UPDATE SKIP LOCKED + lease), signs with the v1 scheme,
// delivers with SSRF checks, classifies the response and schedules retries with exponential
// backoff + jitter (Retry-After honoured). Permanent failures / exhausted retries become 'dead'
// (dead-letter queue) and can be replayed from the dashboard.
//
// Auth: same shared secret as event-bus-dispatch (x-push-dispatch-secret).
// Schedule (pg_cron, every minute):
//   select cron.schedule('webhook-outbox-worker', '* * * * *', $$ select net.http_post(
//     url := current_setting('app.settings.edge_function_base_url') || '/webhook-outbox-worker',
//     headers := jsonb_build_object('Content-Type','application/json','x-push-dispatch-secret', current_setting('app.settings.push_dispatch_secret')),
//     body := '{}'::jsonb) $$);
// Deploy: supabase functions deploy webhook-outbox-worker --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  DELIVERY_TIMEOUT_MS, MAX_ATTEMPTS, backoffSeconds, buildEventPayload, classifyDelivery,
  resolvedAddressesSafe, retryAfterSeconds, signDelivery, validateDeliveryUrl,
} from "../_shared/webhooks/outbound.ts";

const BATCH = 25;
const CONCURRENCY = 5;

interface Claimed {
  id: string; user_id: string; endpoint_id: string; delivery_id: string; event_type: string;
  payload: Record<string, unknown> | null; attempts: number; created_at: string;
  url: string; signing_secret: string; previous_secret: string | null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Resolve A and AAAA and refuse if ANY answer is non-public (blocks DNS names that point inside our network). */
async function hostResolvesPublic(hostname: string): Promise<boolean> {
  try {
    const [a, aaaa] = await Promise.all([
      Deno.resolveDns(hostname, "A").catch(() => [] as string[]),
      Deno.resolveDns(hostname, "AAAA").catch(() => [] as string[]),
    ]);
    return resolvedAddressesSafe([...a, ...aaaa]);
  } catch {
    return false;
  }
}

async function deliverOne(row: Claimed): Promise<{ cls: "delivered" | "retry" | "dead"; status?: number; error?: string; delay: number }> {
  const check = validateDeliveryUrl(row.url);
  if (!check.ok) return { cls: "dead", error: check.error, delay: 0 };
  if (!(await hostResolvesPublic(new URL(check.url).hostname))) return { cls: "retry", error: "dns_not_public_or_unresolved", delay: backoffSeconds(row.attempts) };

  const built = buildEventPayload({ deliveryId: row.delivery_id, event: row.event_type, createdAt: row.created_at, data: row.payload });
  if (!built.ok) return { cls: "dead", error: built.error, delay: 0 };

  const signed = await signDelivery({
    secrets: [row.signing_secret, row.previous_secret ?? ""], body: built.body,
    deliveryId: row.delivery_id, event: row.event_type, timestamp: Math.floor(Date.now() / 1000),
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
  try {
    // redirect: "manual" — a 3xx must never be followed (it could point at an internal address).
    const res = await fetch(check.url, { method: "POST", headers: signed.headers, body: signed.body, signal: ctrl.signal, redirect: "manual" });
    await res.body?.cancel();
    const cls = classifyDelivery(res.status);
    const ra = retryAfterSeconds(res.headers.get("retry-after"), Date.now());
    return { cls, status: res.status, error: cls === "delivered" ? undefined : `HTTP ${res.status}`, delay: ra ?? backoffSeconds(row.attempts) };
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? `timeout_${DELIVERY_TIMEOUT_MS}ms` : "network_error";
    return { cls: "retry", error: msg, delay: backoffSeconds(row.attempts) };
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  const expected = Deno.env.get("PUSH_DISPATCH_SECRET") ?? "";
  const provided = req.headers.get("x-push-dispatch-secret") ?? "";
  if (!expected || !constantTimeEqual(expected, provided)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response(JSON.stringify({ error: "Server not configured" }), { status: 500 });
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data, error } = await admin.rpc("claim_webhook_deliveries", { p_limit: BATCH, p_lease_seconds: 60 });
  if (error) {
    console.error(JSON.stringify({ event: "webhook_outbox_claim_failed", error: error.message }));
    return new Response(JSON.stringify({ error: "claim_failed" }), { status: 500 });
  }
  const rows = (data ?? []) as Claimed[];
  const summary = { claimed: rows.length, delivered: 0, retry: 0, dead: 0 };

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    await Promise.all(rows.slice(i, i + CONCURRENCY).map(async (row) => {
      const r = await deliverOne(row);
      const { data: final, error: cErr } = await admin.rpc("complete_webhook_delivery", {
        p_id: row.id, p_class: r.cls, p_status: r.status ?? null, p_error: r.error ?? null,
        p_delay_seconds: r.delay, p_max_attempts: MAX_ATTEMPTS,
      });
      if (cErr) console.error(JSON.stringify({ event: "webhook_outbox_complete_failed", id: row.id, error: cErr.message }));
      if (final === "delivered") summary.delivered++;
      else if (final === "pending") summary.retry++;
      else if (final === "dead") summary.dead++;
    }));
  }
  return new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } });
});
