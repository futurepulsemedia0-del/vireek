// supabase/functions/c2c-sweep/index.ts
// Cron-driven, retry-safe call-to-cash sweep. Currently: completed job -> draft invoice
// (flag `c2c_orchestration`, per tenant). Safe to run every 1-5 minutes; overlapping runs are
// serialised per job by the RPC's row lock and by unique indexes.
//
// Deploy:  supabase functions deploy c2c-sweep --no-verify-jwt
// Cron:    POST with header  X-Cron-Secret: <CRON_SECRET>   (CRON_SECRET must be >= 16 chars)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isCronAuthorized } from "../_shared/c2c/cronAuth.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!isCronAuthorized(Deno.env.get("CRON_SECRET"), req.headers.get("X-Cron-Secret"))) {
    return json({ error: "unauthorized" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "server_misconfigured" }, 500);

  const admin = createClient(url, key, { auth: { persistSession: false } });
  const started = Date.now();
  const { data, error } = await admin.rpc("c2c_sweep_completed_jobs", { p_limit: 50 });
  if (error) {
    console.error(JSON.stringify({ event: "c2c_sweep_failed", message: error.message }));
    return json({ error: "sweep_failed" }, 500);
  }
  console.log(JSON.stringify({ event: "c2c_sweep_done", ...data, ms: Date.now() - started }));
  return json({ ...data, ms: Date.now() - started });
});
