// Cron-only detector: creates "needs_review" manufacturer warranty claims for completed jobs whose
// equipment was in warranty. All logic lives in the SQL function wcc_detect_claims() (idempotent,
// advisory-locked, skips + logs malformed rows). Auth: X-Cron-Secret (env WARRANTY_CLAIM_CRON_SECRET).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isAuthorized } from "./auth.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isAuthorized(Deno.env.get("WARRANTY_CLAIM_CRON_SECRET"), req.headers.get("X-Cron-Secret"))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Server misconfiguration" }, 500);

  const admin = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc("wcc_detect_claims", { p_owner: null, p_limit: 500 });
  if (error) {
    console.error("wcc_detect_claims failed", error.message);
    return json({ error: "Detector failed" }, 500);
  }
  return json({ ok: true, result: data });
});
