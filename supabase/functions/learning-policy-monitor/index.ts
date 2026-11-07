// supabase/functions/learning-policy-monitor/index.ts
//
// Daily (or hourly) service-role job for the Outcome Learning layer:
//   1. refresh predictor calibration status (+ demotion / drift alerts)
//   2. auto-apply LOW-RISK learning suggestions for opted-in accounts
//   3. monitor every applied change; auto-ROLL BACK when outcomes degrade
//      (rule: rollbackDecision() in _shared/outcomes/policyLearning.ts)
//   4. coverage-drop alerts
//   5. build k-anonymous cross-tenant aggregates (>=5 tenants, dominance <=50%)
// Auth: Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>. Every step is idempotent.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { rollbackDecision, ChangeKind } from "../_shared/outcomes/policyLearning.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!key || bearer !== key) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", key, { auth: { persistSession: false } });
  const out = { predictors: 0, autoApplied: 0, confirmed: 0, rolledBack: 0, continued: 0, coverageAlerts: 0, aggregates: 0, errors: [] as string[] };

  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { out.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  await step("refresh_predictor_status", async () => {
    const { data, error } = await admin.rpc("refresh_predictor_status");
    if (error) throw new Error(error.message);
    out.predictors = Number(data ?? 0);
  });

  await step("auto_apply_learning_suggestions", async () => {
    const { data, error } = await admin.rpc("auto_apply_learning_suggestions");
    if (error) throw new Error(error.message);
    out.autoApplied = Number(data ?? 0);
  });

  await step("monitor_changes", async () => {
    const { data: changes, error } = await admin
      .from("learning_policy_changes")
      .select("id, kind, baseline_k, baseline_n, monitor_until")
      .eq("status", "monitoring").limit(500);
    if (error) throw new Error(error.message);
    const now = Date.now();
    for (const c of changes ?? []) {
      const { data: post, error: pe } = await admin.rpc("learning_change_post_stats", { p_change_id: c.id });
      if (pe) { out.errors.push(`post_stats ${c.id}: ${pe.message}`); continue; }
      const row = Array.isArray(post) ? post[0] : post;
      const d = rollbackDecision({
        kind: c.kind as ChangeKind,
        baselineK: c.baseline_k, baselineN: c.baseline_n,
        postK: Number(row?.post_k ?? 0), postN: Number(row?.post_n ?? 0),
        windowElapsed: Date.parse(c.monitor_until) <= now,
      });
      if (d.action === "rollback") {
        const { error: re } = await admin.rpc("rollback_learning_change", { p_change_id: c.id, p_reason: d.reason });
        if (re) out.errors.push(`rollback ${c.id}: ${re.message}`); else out.rolledBack++;
      } else if (d.action === "confirm") {
        const { error: ce } = await admin.rpc("confirm_learning_change", { p_change_id: c.id, p_reason: d.reason });
        if (ce) out.errors.push(`confirm ${c.id}: ${ce.message}`); else out.confirmed++;
      } else out.continued++;
    }
  });

  await step("coverage_alerts", async () => {
    const { data, error } = await admin.rpc("check_outcome_coverage_alerts");
    if (error) throw new Error(error.message);
    out.coverageAlerts = Number(data ?? 0);
  });

  await step("build_outcome_aggregates", async () => {
    const { data, error } = await admin.rpc("build_outcome_aggregates");
    if (error) throw new Error(error.message);
    out.aggregates = Number(data ?? 0);
  });

  return json(out, out.errors.length ? 207 : 200);
});
