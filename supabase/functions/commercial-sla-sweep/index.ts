// supabase/functions/commercial-sla-sweep/index.ts
// Cron-driven SLA sweep for the Commercial pack (flag `commercial_pack` + installed pack, per tenant).
// Reads active timers in pages, evaluates them with the SAME pure clock the UI uses
// (src/lib/commercial/slaClock.ts), and records escalations / breaches idempotently via
// commercial_sla_apply(). Safe to run every 1–5 minutes; overlapping runs cannot double-fire a step
// (unique index on (timer_id, step_key)).
//
// Deploy:  supabase functions deploy commercial-sla-sweep --no-verify-jwt
// Cron:    POST with header  X-Cron-Secret: <CRON_SECRET>   (CRON_SECRET must be >= 16 chars)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isCronAuthorized } from "../_shared/c2c/cronAuth.ts";
import { evaluateSweepRow, type SweepResult, type SweepRow } from "../../../src/lib/commercial/sweep.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const PAGE = 200;
const MAX_PAGES = 25; // 5,000 timers per invocation; the cursor resumes next run

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!isCronAuthorized(Deno.env.get("CRON_SECRET"), req.headers.get("X-Cron-Secret"))) return json({ error: "unauthorized" }, 401);
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "server_misconfigured" }, 500);

  const admin = createClient(url, key, { auth: { persistSession: false } });
  const started = Date.now();
  const totals = { evaluated: 0, skipped: 0, updated: 0, events: 0, breaches: 0 };
  let after: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await admin.rpc("commercial_sla_sweep_batch", { p_after: after, p_limit: PAGE });
    if (error) {
      console.error(JSON.stringify({ event: "commercial_sweep_read_failed", message: error.message }));
      return json({ error: "sweep_failed" }, 500);
    }
    const rows = (data ?? []) as SweepRow[];
    if (rows.length === 0) break;
    const now = new Date().toISOString();
    const results: SweepResult[] = [];
    for (const row of rows) {
      const r = evaluateSweepRow(row, now);
      if (r) results.push(r); else totals.skipped++;
    }
    totals.evaluated += results.length;
    if (results.length) {
      const { data: applied, error: applyErr } = await admin.rpc("commercial_sla_apply", { p_results: results });
      if (applyErr) {
        console.error(JSON.stringify({ event: "commercial_sweep_apply_failed", message: applyErr.message }));
        return json({ error: "sweep_failed", ...totals }, 500);
      }
      totals.updated += applied?.updated ?? 0;
      totals.events += applied?.events ?? 0;
      totals.breaches += applied?.breaches ?? 0;
    }
    after = rows[rows.length - 1].timer_id;
    if (rows.length < PAGE) break;
  }
  console.log(JSON.stringify({ event: "commercial_sweep_done", ...totals, ms: Date.now() - started }));
  return json({ ...totals, ms: Date.now() - started });
});
