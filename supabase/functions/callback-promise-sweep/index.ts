// supabase/functions/callback-promise-sweep/index.ts
//
// Cron entry point for the Callback Promise rule ("every missed call gets a callback within X").
// All logic lives in the database (callback_promise_sweep(), see
// supabase/migrations/20290312000000_callback_promise.sql): it creates one `promises` row per missed /
// voicemail / abandoned call, closes the ones with a recorded callback attempt, and writes ONE
// `notifications` row per stage (overdue / escalated) per account, which the existing push +
// notification-routing triggers deliver. Idempotent: running it twice in a row changes nothing.
//
// DEPLOYMENT:
//   supabase functions deploy callback-promise-sweep --no-verify-jwt
//   set the secret:  supabase secrets set CRON_SECRET=<long random value>
// Then call it EVERY MINUTE from the same external cron that calls rescue-sla-monitor, with:
//   X-Cron-Secret: <CRON_SECRET>
// Unlike older cron functions this one FAILS CLOSED: without CRON_SECRET configured it refuses to run.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Constant-time string comparison (no early exit on the first differing byte). */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret) {
    console.error("callback-promise-sweep: CRON_SECRET is not configured");
    return json({ error: "Not configured" }, 500);
  }
  if (!safeEqual(req.headers.get("X-Cron-Secret") ?? "", cronSecret)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    console.error("callback-promise-sweep: Supabase credentials are not configured");
    return json({ error: "Not configured" }, 500);
  }

  const admin = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc("callback_promise_sweep");
  if (error) {
    console.error("callback_promise_sweep failed", error.message);
    return json({ error: "Sweep failed" }, 500);
  }
  return json(data ?? {});
});
