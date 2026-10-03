// Scheduled function (same idiom as check-warranty-alerts): scans active
// equipment across all accounts and scores lifecycle risk deterministically
// — age vs expected lifespan, overdue service interval, repair frequency,
// and (new) the sealed Equipment Passport history from EVERY verified
// servicing company: repeat failures after repair, the same part replaced
// again and again, accelerating repairs, many companies / no owner of the
// root cause, repeated warranty claims. Rule-based on purpose: a health
// score has to be consistent and explainable, not an LLM guess.
// Scoring lives in _shared/equipment-lifecycle/score.ts (pure + unit-tested).
//
// Needs migration 20270210000100_equipment_passport_lifecycle_signals.sql.
// If it is not applied yet the function falls back to the previous behaviour.
//
// Deploy: supabase functions deploy analyze-equipment-lifecycle --no-verify-jwt
// Schedule it the same way check-warranty-alerts is documented to be
// scheduled (pg_cron or an external scheduler), once a day.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { assessLifecycle, parseSignals, type PassportSignals } from "../_shared/equipment-lifecycle/score.ts";

interface EquipmentRow {
  id: string;
  user_id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
  last_service_date: string | null;
  expected_lifespan_years: number;
  service_interval_months: number;
}

const CHUNK = 200;

Deno.serve(async (_req: Request) => {
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const now = new Date();

  const { data: equipment, error } = await admin
    .from("equipment")
    .select("id, user_id, equipment_type, make, model, install_date, last_service_date, expected_lifespan_years, service_interval_months")
    .eq("status", "active");

  if (error || !equipment) {
    console.error("analyze-equipment-lifecycle: could not load equipment", error);
    return new Response(JSON.stringify({ error: "Could not load equipment." }), { status: 500 });
  }

  const rows = equipment as EquipmentRow[];

  // Passport signals in bulk (one RPC per CHUNK units). Failure is non-fatal: we simply score without them.
  const signalsById = new Map<string, PassportSignals>();
  let passportAvailable = true;
  for (let i = 0; i < rows.length && passportAvailable; i += CHUNK) {
    const ids = rows.slice(i, i + CHUNK).map((r) => r.id);
    const { data, error: sigError } = await admin.rpc("lifecycle_passport_signals", { p_equipment_ids: ids });
    if (sigError) {
      console.warn("analyze-equipment-lifecycle: passport signals unavailable, using account-only history:", sigError.message);
      passportAvailable = false;
      break;
    }
    for (const [id, raw] of Object.entries((data ?? {}) as Record<string, unknown>)) {
      const parsed = parseSignals(raw);
      if (parsed) signalsById.set(id, parsed);
    }
  }

  let flagged = 0;
  let withPassport = 0;

  for (const eq of rows) {
    const signals = signalsById.get(eq.id) ?? null;
    if (!eq.install_date && !signals) continue; // nothing to reason about

    // Legacy evidence (this account's own linked jobs); only needed when there is no passport history.
    let localRepairs = 0;
    if (!signals) {
      const { count } = await admin
        .from("job_equipment")
        .select("job_id, jobs!inner(scheduled_datetime)", { count: "exact", head: true })
        .eq("equipment_id", eq.id)
        .gte("jobs.scheduled_datetime", new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString());
      localRepairs = count ?? 0;
    } else {
      withPassport++;
    }

    const a = assessLifecycle(eq, now, localRepairs, signals);
    if (a.riskLevel === "low") continue;

    const { data: recent } = await admin
      .from("equipment_maintenance_alerts")
      .select("id")
      .eq("equipment_id", eq.id)
      .eq("risk_level", a.riskLevel)
      .eq("is_dismissed", false)
      .gte("created_at", new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .limit(1);

    if (recent && recent.length > 0) continue; // already flagged at this level recently — don't spam

    await admin.from("equipment_maintenance_alerts").insert({
      user_id: eq.user_id,
      equipment_id: eq.id,
      risk_level: a.riskLevel,
      predicted_issue: a.predictedIssue,
      recommended_action: a.recommendedAction,
      predicted_service_due: a.predictedServiceDue,
      metric_snapshot: a.snapshot,
    });
    flagged++;
  }

  return new Response(
    JSON.stringify({ scanned: rows.length, flagged, with_passport_history: withPassport, passport_signals: passportAvailable }),
    { headers: { "Content-Type": "application/json" } },
  );
});
