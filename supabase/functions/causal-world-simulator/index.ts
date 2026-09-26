import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { analyzeCausalScenario } from "../_shared/ai-core/causalSimulator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const VALID_CATEGORIES = new Set([
  "pricing", "dispatch", "staffing", "marketing", "collections", "retention", "operations", "other",
]);

interface CohortRow {
  sample_size: number;
  success_rate: number | null;
  avg_impact_pct: number | null;
  median_impact_pct: number | null;
  p25_impact_pct: number | null;
  p75_impact_pct: number | null;
}

// ---------------------------------------------------------------------
// Deterministic own-account baseline — the ONLY place that touches raw
// rows. Mirrors the metric style used by business-decision-engine so
// the AI is always reasoning over the same kind of ground truth.
// ---------------------------------------------------------------------
async function computeOwnBaseline(
  db: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ metrics: Record<string, unknown>; revenue_30d: number }> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString();

  const [recentJobs, priorJobs, callsRes, leadsRes] = await Promise.all([
    db.from("jobs").select("invoice_amount, job_status, created_at")
      .eq("user_id", userId).eq("job_status", "completed").gte("created_at", thirtyDaysAgo),
    db.from("jobs").select("invoice_amount, job_status, created_at")
      .eq("user_id", userId).eq("job_status", "completed").gte("created_at", sixtyDaysAgo).lt("created_at", thirtyDaysAgo),
    db.from("calls").select("is_emergency, status").eq("user_id", userId).gte("call_datetime", thirtyDaysAgo),
    db.from("leads").select("stage").eq("user_id", userId).gte("created_at", thirtyDaysAgo),
  ]);

  const recent = (recentJobs.data ?? []) as { invoice_amount: number | null }[];
  const prior = (priorJobs.data ?? []) as { invoice_amount: number | null }[];
  const calls = (callsRes.data ?? []) as { is_emergency: boolean | null; status: string | null }[];
  const leads = (leadsRes.data ?? []) as { stage: string }[];

  const revenue_30d = Math.round(recent.reduce((s, j) => s + (j.invoice_amount ?? 0), 0) * 100) / 100;
  const revenue_prior_30d = Math.round(prior.reduce((s, j) => s + (j.invoice_amount ?? 0), 0) * 100) / 100;

  const metrics: Record<string, unknown> = {
    completed_jobs_last_30d: recent.length,
    revenue_last_30d: revenue_30d,
    revenue_prior_30d: revenue_prior_30d,
    total_calls_last_30d: calls.length,
    missed_calls_last_30d: calls.filter((c) => c.status === "missed").length,
    emergency_calls_last_30d: calls.filter((c) => c.is_emergency).length,
    new_leads_last_30d: leads.length,
  };

  return { metrics, revenue_30d };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: jsonHeaders });
    }
    const userId = user.id;
    const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const body = await req.json().catch(() => ({}));
    const action = body?.action === "mark_implemented" ? "mark_implemented" : "simulate";

    // -----------------------------------------------------------------
    // ACTION: mark_implemented — owner confirms they actually did it.
    // Captures today's revenue as the baseline the outcome will later
    // be measured against by causal-outcome-tracker.
    // -----------------------------------------------------------------
    if (action === "mark_implemented") {
      const scenarioId = body?.scenario_id;
      if (typeof scenarioId !== "string") {
        return new Response(JSON.stringify({ error: "scenario_id is required." }), { status: 400, headers: jsonHeaders });
      }

      const { data: scenario } = await db.from("causal_scenarios").select("id, user_id").eq("id", scenarioId).eq("user_id", userId).maybeSingle();
      if (!scenario) {
        return new Response(JSON.stringify({ error: "Scenario not found." }), { status: 404, headers: jsonHeaders });
      }

      const { data: simulation } = await db.from("causal_simulations").select("id, timeframe_days").eq("scenario_id", scenarioId).eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!simulation) {
        return new Response(JSON.stringify({ error: "No simulation to attach an outcome to." }), { status: 404, headers: jsonHeaders });
      }

      const { data: existing } = await db.from("causal_outcome_tracking").select("id").eq("simulation_id", simulation.id).maybeSingle();
      if (existing) {
        return new Response(JSON.stringify({ error: "This scenario is already being tracked." }), { status: 409, headers: jsonHeaders });
      }

      const { revenue_30d } = await computeOwnBaseline(db, userId);

      const { error: insertError } = await db.from("causal_outcome_tracking").insert({
        scenario_id: scenarioId,
        simulation_id: simulation.id,
        user_id: userId,
        decision_made: true,
        decision_made_at: new Date().toISOString(),
        baseline_revenue_30d: revenue_30d,
        timeframe_days: simulation.timeframe_days,
      });
      if (insertError) throw insertError;

      return new Response(JSON.stringify({ tracking_started: true, baseline_revenue_30d: revenue_30d }), { headers: jsonHeaders });
    }

    // -----------------------------------------------------------------
    // ACTION: simulate — the main causal simulation.
    // -----------------------------------------------------------------
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, 140) : "";
    const decisionCategory = typeof body?.decision_category === "string" ? body.decision_category : "";
    const decisionDescription = typeof body?.decision_description === "string" ? body.decision_description.trim().slice(0, 2000) : "";

    if (!title || !VALID_CATEGORIES.has(decisionCategory) || decisionDescription.length < 10) {
      return new Response(
        JSON.stringify({ error: "title, a valid decision_category, and a decision_description (10+ chars) are required." }),
        { status: 400, headers: jsonHeaders },
      );
    }

    const { data: scenario, error: scenarioError } = await db.from("causal_scenarios").insert({
      user_id: userId,
      title,
      decision_category: decisionCategory,
      decision_description: decisionDescription,
      status: "simulating",
    }).select("*").single();
    if (scenarioError) throw scenarioError;

    try {
      const { metrics: own_metrics } = await computeOwnBaseline(db, userId);

      const { data: cohortRows } = await db.rpc("compute_causal_cohort_insights", {
        p_category: decisionCategory,
        p_min_sample: 5,
      });
      const cohortRow = (cohortRows as CohortRow[] | null)?.[0] ?? null;
      const cohort = cohortRow
        ? {
            available: true,
            sample_size: cohortRow.sample_size,
            success_rate: cohortRow.success_rate,
            avg_impact_pct: cohortRow.avg_impact_pct,
            median_impact_pct: cohortRow.median_impact_pct,
            p25_impact_pct: cohortRow.p25_impact_pct,
            p75_impact_pct: cohortRow.p75_impact_pct,
          }
        : { available: false, sample_size: 0, success_rate: null, avg_impact_pct: null, median_impact_pct: null, p25_impact_pct: null, p75_impact_pct: null };

      const analysis = await analyzeCausalScenario({
        decision_category: decisionCategory,
        decision_description: decisionDescription,
        own_metrics,
        cohort,
      });

      const { data: simulation, error: simError } = await db.from("causal_simulations").insert({
        scenario_id: scenario.id,
        user_id: userId,
        cohort_available: cohort.available,
        cohort_sample_size: cohort.sample_size,
        cohort_success_rate: cohort.success_rate,
        cohort_avg_impact_pct: cohort.avg_impact_pct,
        cohort_median_impact_pct: cohort.median_impact_pct,
        cohort_p25_impact_pct: cohort.p25_impact_pct,
        cohort_p75_impact_pct: cohort.p75_impact_pct,
        predicted_impact_pct: analysis.predicted_impact_pct,
        predicted_confidence: analysis.predicted_confidence,
        timeframe_days: analysis.timeframe_days,
        causal_factors: analysis.causal_factors,
        risk_factors: analysis.risk_factors,
        counterfactual_narrative: analysis.counterfactual_narrative,
      }).select("*").single();
      if (simError) throw simError;

      await db.from("causal_scenarios").update({ status: "completed" }).eq("id", scenario.id);

      return new Response(JSON.stringify({ scenario: { ...scenario, status: "completed" }, simulation }), { headers: jsonHeaders });
    } catch (innerError) {
      await db.from("causal_scenarios").update({ status: "failed" }).eq("id", scenario.id);
      throw innerError;
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "causal_world_simulator_failed", error: error instanceof Error ? error.message : String(error) }));
    return new Response(JSON.stringify({ error: "Simulation failed. Please try again." }), { status: 500, headers: jsonHeaders });
  }
});
