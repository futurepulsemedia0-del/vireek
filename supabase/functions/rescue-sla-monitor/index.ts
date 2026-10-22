// supabase/functions/rescue-sla-monitor/index.ts
//
// Cron entry point for the Rescue Loop first-response SLA monitor.
// All logic lives in the database (rescue_sla_scan(), see
// supabase/migrations/20271011000000_rescue_loop_sla.sql): it gives a verdict
// to every missed / voicemail / abandoned call that is past its limit and
// writes ONE `notifications` row per breach (or one digest for a burst),
// which the existing push + notification-routing triggers deliver.
//
// DEPLOYMENT:
//   supabase functions deploy rescue-sla-monitor --no-verify-jwt
// Then point the SAME external cron that calls workflow-engine-executor /
// followup-agent-dispatcher at this function EVERY MINUTE, same header:
//   X-Cron-Secret: <CRON_SECRET>
// Idempotent: running it twice in a row never double-alerts.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const JSON_HEADERS = { "Content-Type": "application/json" };

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: JSON_HEADERS });
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { data, error } = await admin.rpc("rescue_sla_scan");
  if (error) {
    console.error("rescue_sla_scan failed", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: JSON_HEADERS });
  }

  return new Response(JSON.stringify({ breaches_notified: data ?? 0 }), { headers: JSON_HEADERS });
});
