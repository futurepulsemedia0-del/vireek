// supabase/functions/dispatch-webhook/index.ts
//
// Called internally by the `dispatch_customer_webhook()` Postgres trigger
// (see supabase/migrations/20260912010000_webhook_logs.sql) via pg_net,
// every time a row is inserted into `calls`, `leads`, or `jobs`.
//
// What it does:
//   1. Looks up whether this user has a connected "webhook" integration
//      with a URL configured (src/pages/IntegrationsPage.tsx writes this
//      to `integrations` where integration_type = 'webhook').
//   2. If yes, POSTs { event, data } to that URL.
//   3. Logs the attempt (success or failure) to `webhook_logs` so it shows
//      up in the dashboard's Webhook Logs page (Outgoing tab).
//
// This function is NOT called directly by the customer's browser — it's
// server-to-server, triggered by Postgres. Auth is the same shared secret
// used by send-push-notification (`x-push-dispatch-secret`), matching the
// existing pattern in this project instead of inventing a new one.
//
// Required secrets (already set if you deployed send-push-notification):
//   SUPABASE_URL                — already provided by the platform
//   SUPABASE_SERVICE_ROLE_KEY   — already provided by the platform
//   PUSH_DISPATCH_SECRET        — same value as
//                                  app.settings.push_dispatch_secret
//
// Deploy:
//   supabase functions deploy dispatch-webhook --no-verify-jwt

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
  user_id?: string;
  event_type?: string;
  record?: Record<string, unknown>;
}

const FETCH_TIMEOUT_MS = 10_000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // ---- Auth: only our own Postgres trigger should call this -------------
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

  const { user_id, event_type, record } = body;
  if (!user_id || !event_type) {
    return jsonResponse({ error: "Missing user_id or event_type" }, 400);
  }

  // ---- Look up this user's webhook integration --------------------------
  const { data: integration } = await admin
    .from("integrations")
    .select("config, status")
    .eq("user_id", user_id)
    .eq("integration_type", "webhook")
    .maybeSingle();

  const targetUrl =
    integration?.status === "connected" &&
    integration?.config &&
    typeof integration.config === "object" &&
    "url" in (integration.config as Record<string, unknown>)
      ? String((integration.config as Record<string, unknown>).url || "").trim()
      : "";

  // Nothing configured for this user — nothing to do, nothing to log.
  if (!targetUrl) {
    return jsonResponse({ skipped: true, reason: "no_webhook_configured" });
  }

  // ---- Send the actual POST to the customer's endpoint -------------------
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: event_type, data: record ?? null }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      await admin.from("webhook_logs").insert({
        user_id,
        direction: "outgoing",
        event_type,
        status: "success",
        status_code: res.status,
        target_url: targetUrl,
      });
      return jsonResponse({ delivered: true, status: res.status });
    }

    await admin.from("webhook_logs").insert({
      user_id,
      direction: "outgoing",
      event_type,
      status: "error",
      status_code: res.status,
      target_url: targetUrl,
      error_message: `Endpoint responded with HTTP ${res.status}`,
    });
    return jsonResponse({ delivered: false, status: res.status });
  } catch (error) {
    clearTimeout(timeout);
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `Timed out after ${FETCH_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error);

    await admin.from("webhook_logs").insert({
      user_id,
      direction: "outgoing",
      event_type,
      status: "error",
      target_url: targetUrl,
      error_message: message,
    });
    return jsonResponse({ delivered: false, error: message });
  }
});
