// supabase/functions/event-bus-dispatch/index.ts
//
// Called internally by the `dispatch_event_bus()` Postgres trigger and by
// the `send_test_webhook_event()` RPC (see
// supabase/migrations/20260924000000_developer_platform_event_bus.sql),
// via pg_net — never called directly by a customer's browser.
//
// What it does, per call:
//   1. Looks up the target `webhook_endpoints` row by id.
//   2. Builds the event payload and signs it with that endpoint's
//      signing_secret using HMAC-SHA256 (same idea as Stripe's
//      Stripe-Signature header) so the receiver can verify authenticity.
//   3. POSTs it with a short timeout + a single automatic retry on
//      network failure or a 5xx response.
//   4. Logs every attempt to `webhook_logs` (direction = 'outgoing',
//      endpoint_id set) and updates the endpoint's last_delivery_at /
//      last_delivery_status.
//
// Auth is the same shared secret already used by dispatch-webhook and
// send-push-notification (`x-push-dispatch-secret`), not a new pattern.
//
// Required secrets (already set if you deployed dispatch-webhook):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PUSH_DISPATCH_SECRET
//
// Deploy:
//   supabase functions deploy event-bus-dispatch --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-push-dispatch-secret",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface DispatchBody {
  endpoint_id?: string;
  event_type?: string;
  record?: Record<string, unknown>;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;

async function signPayload(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function postOnce(url: string, body: string, signature: string, deliveryId: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vireek-Signature": signature,
        "X-Vireek-Delivery-Id": deliveryId,
      },
      body,
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status as number | undefined, error: undefined as string | undefined };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `Timed out after ${FETCH_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, status: undefined, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const expectedSecret = Deno.env.get("PUSH_DISPATCH_SECRET");
  const providedSecret = req.headers.get("x-push-dispatch-secret");
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server not configured" }, 500);
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let body: DispatchBody;
  try {
    body = (await req.json()) as DispatchBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { endpoint_id, event_type, record } = body;
  if (!endpoint_id || !event_type) {
    return jsonResponse({ error: "Missing endpoint_id or event_type" }, 400);
  }

  const { data: endpoint } = await admin
    .from("webhook_endpoints")
    .select("id, user_id, url, signing_secret")
    .eq("id", endpoint_id)
    .maybeSingle();

  if (!endpoint) {
    return jsonResponse({ skipped: true, reason: "endpoint_not_found" });
  }

  const deliveryId = crypto.randomUUID();
  const payload = JSON.stringify({
    id: deliveryId,
    event: event_type,
    created_at: new Date().toISOString(),
    data: record ?? null,
  });
  const signature = await signPayload(endpoint.signing_secret, payload);

  let attempt = 0;
  let result: Awaited<ReturnType<typeof postOnce>> = { ok: false, status: undefined, error: "not_attempted" };

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    result = await postOnce(endpoint.url, payload, signature, deliveryId);
    const shouldRetry = attempt < MAX_ATTEMPTS && (!result.ok && (result.status === undefined || result.status >= 500));
    if (!shouldRetry) break;
  }

  const status = result.ok ? "success" : "error";
  await admin.from("webhook_logs").insert({
    user_id: endpoint.user_id,
    direction: "outgoing",
    event_type,
    status,
    status_code: result.status ?? null,
    target_url: endpoint.url,
    error_message: result.ok ? null : result.error ?? `Endpoint responded with HTTP ${result.status}`,
    endpoint_id: endpoint.id,
    attempt,
  });

  await admin
    .from("webhook_endpoints")
    .update({ last_delivery_at: new Date().toISOString(), last_delivery_status: status })
    .eq("id", endpoint.id);

  return jsonResponse({ delivered: result.ok, status: result.status, attempts: attempt });
});
