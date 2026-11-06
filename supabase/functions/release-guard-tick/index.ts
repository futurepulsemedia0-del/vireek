// release-guard-tick — scheduled (every 5 min) by .github/workflows/release-guard.yml.
//   default mode  : evaluate every active canary rollout; record the decision; AUTO-ROLLBACK on SLO breach.
//   ?mode=drills  : list kill switches whose monthly drill is overdue (the workflow fails when any are).
// Auth: X-Cron-Secret is REQUIRED (fails closed if CRON_SECRET is not configured).
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { decideAction, evaluateHealth, type HealthSummary, type Slo } from "../_shared/release/rolloutHealth.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface ActiveRollout { flag_key: string; slo: Slo; breach_count: number; stage_pct: number; stage_started_at: string }

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("X-Cron-Secret") !== cronSecret) return json({ error: "Unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Server misconfigured" }, 500);
  const admin = createClient(url, key, { auth: { persistSession: false } });

  const mode = new URL(req.url).searchParams.get("mode") ?? "rollouts";

  if (mode === "drills") {
    const { data, error } = await admin.rpc("kill_switch_drills_overdue");
    if (error) return json({ error: "drill check failed" }, 500);
    return json({ overdue: data ?? [] });
  }

  const { data, error } = await admin.rpc("release_active_rollouts");
  if (error || !Array.isArray(data)) return json({ error: "could not load rollouts" }, 500);

  const results: Array<{ flag: string; decision: string; reasons: string[] }> = [];
  const rolledBack: string[] = [];

  for (const r of data as ActiveRollout[]) {
    try {
      const { data: summary, error: sErr } = await admin.rpc("release_health_summary", { p_flag_key: r.flag_key, p_minutes: 30 });
      if (sErr || !summary) {
        // Missing health data never rolls back and never promotes.
        await admin.rpc("release_record_decision", { p_flag_key: r.flag_key, p_decision: "hold", p_breach_count: r.breach_count, p_reasons: ["health data unavailable"] });
        results.push({ flag: r.flag_key, decision: "hold", reasons: ["health data unavailable"] });
        continue;
      }
      const soakMinutes = (Date.now() - Date.parse(r.stage_started_at)) / 60_000;
      const evaluation = evaluateHealth(summary as HealthSummary, r.slo ?? {});
      const action = decideAction({ evaluation, breachCount: r.breach_count, soakMinutes: Number.isFinite(soakMinutes) ? soakMinutes : 0, slo: r.slo ?? {} });

      await admin.rpc("release_record_decision", { p_flag_key: r.flag_key, p_decision: action.decision, p_breach_count: action.nextBreachCount, p_reasons: action.reasons });
      if (action.decision === "rollback") {
        const { error: rbErr } = await admin.rpc("release_auto_rollback", { p_flag_key: r.flag_key, p_reason: action.reasons.join("; ").slice(0, 400) });
        if (rbErr) throw new Error("rollback failed");
        rolledBack.push(r.flag_key);
        console.error(JSON.stringify({ event: "release_auto_rollback", flag: r.flag_key, reasons: action.reasons }));
      }
      results.push({ flag: r.flag_key, decision: action.decision, reasons: action.reasons });
    } catch (e) {
      console.error(JSON.stringify({ event: "release_guard_error", flag: r.flag_key, message: e instanceof Error ? e.message : "unknown" }));
      results.push({ flag: r.flag_key, decision: "error", reasons: ["evaluation failed"] });
    }
  }

  await admin.rpc("release_prune_health_samples");
  // A rollback or an evaluation error returns 500-class info to the scheduler so the workflow run is flagged.
  return json({ checked: results.length, rolled_back: rolledBack, results }, rolledBack.length || results.some((x) => x.decision === "error") ? 207 : 200);
});
