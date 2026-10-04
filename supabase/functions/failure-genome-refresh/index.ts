// Scheduled fallback for the nightly Failure Genome rebuild + emerging-pattern scan,
// for projects where pg_cron is not enabled (the migration schedules it itself when it is).
//
// Auth: header `X-Cron-Secret` must equal the CRON_SECRET secret (fails closed if unset).
// Deploy:   supabase functions deploy failure-genome-refresh --no-verify-jwt
// Schedule: once a day, POST with the X-Cron-Secret header.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("X-Cron-Secret") !== cronSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server misconfiguration." }, 500);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc("run_failure_genome_nightly");
  if (error) {
    console.error(JSON.stringify({ event: "failure_genome_refresh_failed", error: error.message }));
    return json({ error: "Refresh failed." }, 500);
  }
  return json({ ok: true, patterns_published: data });
});
