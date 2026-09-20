// Scheduled function (same idiom as check-warranty-alerts): scans active
// equipment across all accounts and scores lifecycle risk deterministically
// — age vs expected lifespan, overdue service interval, repair frequency
// via job_equipment. Rule-based on purpose: a health score has to be
// consistent and explainable, not an LLM guess.
//
// Deploy: supabase functions deploy analyze-equipment-lifecycle --no-verify-jwt
// Schedule it the same way check-warranty-alerts is documented to be
// scheduled (pg_cron or an external scheduler), once a day.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

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

function monthsBetween(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

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

  let flagged = 0;

  for (const eq of equipment as EquipmentRow[]) {
    if (!eq.install_date) continue;

    const installDate = new Date(eq.install_date);
    const ageYears = (now.getTime() - installDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    const lifespanUsedPct = eq.expected_lifespan_years > 0 ? ageYears / eq.expected_lifespan_years : 0;

    const lastService = eq.last_service_date ? new Date(eq.last_service_date) : installDate;
    const monthsSinceService = monthsBetween(lastService, now);
    const overdueService = monthsSinceService > eq.service_interval_months;

    const { count: repairCount12mo } = await admin
      .from("job_equipment")
      .select("job_id, jobs!inner(scheduled_datetime)", { count: "exact", head: true })
      .eq("equipment_id", eq.id)
      .gte("jobs.scheduled_datetime", new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString());

    const repairs = repairCount12mo ?? 0;
    const label = [eq.make, eq.model].filter(Boolean).join(" ") || eq.equipment_type;

    let riskLevel: "low" | "medium" | "high" = "low";
    let predictedIssue = `${label} is within its expected service life.`;
    let recommendedAction: string | null = null;

    if (lifespanUsedPct >= 1 || repairs >= 3) {
      riskLevel = "high";
      predictedIssue = lifespanUsedPct >= 1
        ? `${label} has passed its expected ${eq.expected_lifespan_years}-year lifespan (${ageYears.toFixed(1)} years in service).`
        : `${label} has needed ${repairs} repair visits in the last 12 months — a common pattern right before failure.`;
      recommendedAction = "Offer the customer a replacement quote before the next breakdown — this unit is a strong candidate for proactive replacement.";
    } else if (lifespanUsedPct >= 0.75 || overdueService || repairs >= 2) {
      riskLevel = "medium";
      predictedIssue = overdueService
        ? `${label} is overdue for its ${eq.service_interval_months}-month service interval (${monthsSinceService} months since last service).`
        : `${label} is at ${Math.round(lifespanUsedPct * 100)}% of its expected lifespan.`;
      recommendedAction = "Schedule a routine maintenance visit and flag this unit for a replacement conversation within the next 6–12 months.";
    }

    if (riskLevel === "low") continue;

    const { data: recent } = await admin
      .from("equipment_maintenance_alerts")
      .select("id")
      .eq("equipment_id", eq.id)
      .eq("risk_level", riskLevel)
      .eq("is_dismissed", false)
      .gte("created_at", new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .limit(1);

    if (recent && recent.length > 0) continue; // already flagged at this level recently — don't spam

    await admin.from("equipment_maintenance_alerts").insert({
      user_id: eq.user_id,
      equipment_id: eq.id,
      risk_level: riskLevel,
      predicted_issue: predictedIssue,
      recommended_action: recommendedAction,
      predicted_service_due: new Date(lastService.getTime() + eq.service_interval_months * 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      metric_snapshot: { age_years: Number(ageYears.toFixed(2)), lifespan_used_pct: Number(lifespanUsedPct.toFixed(2)), repairs_last_12mo: repairs, months_since_service: monthsSinceService },
    });
    flagged++;
  }

  return new Response(JSON.stringify({ scanned: equipment.length, flagged }), { headers: { "Content-Type": "application/json" } });
});
