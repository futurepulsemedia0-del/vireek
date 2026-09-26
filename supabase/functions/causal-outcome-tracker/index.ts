import { createClient } from "npm:@supabase/supabase-js@2.57.4";

// Runs on a schedule (e.g. daily via pg_cron -> net.http_post, same
// operational pattern as compute-benchmarks — see that function's
// migration for the cron.schedule(...) integration note). For every
// account that confirmed it implemented a causally-simulated decision
// and whose timeframe has now elapsed, this measures the REAL revenue
// delta and writes it back — which is what lets
// compute_causal_cohort_insights() answer future users with actual
// outcomes instead of AI guesses.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface PendingRow {
  id: string;
  user_id: string;
  decision_made_at: string;
  timeframe_days: number;
  baseline_revenue_30d: number | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const cronSecret = Deno.env.get("CAUSAL_TRACKER_CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(JSON.stringify({ event: "causal_outcome_tracker_failed", error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }));
    return jsonResponse({ error: "Server misconfiguration." }, 500);
  }
  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  try {
    const { data: pending, error: pendingError } = await db
      .from("causal_outcome_tracking")
      .select("id, user_id, decision_made_at, timeframe_days, baseline_revenue_30d")
      .eq("decision_made", true)
      .is("outcome_recorded_at", null);
    if (pendingError) throw pendingError;

    const now = Date.now();
    const due = ((pending ?? []) as PendingRow[]).filter((row) => {
      const madeAt = new Date(row.decision_made_at).getTime();
      const elapsedDays = (now - madeAt) / 86400000;
      return elapsedDays >= row.timeframe_days;
    });

    let measured = 0;
    for (const row of due) {
      const windowStart = new Date(now - 30 * 86400000).toISOString();
      const { data: jobs } = await db
        .from("jobs")
        .select("invoice_amount")
        .eq("user_id", row.user_id)
        .eq("job_status", "completed")
        .gte("created_at", windowStart);

      const actual_revenue_30d = Math.round(((jobs ?? []) as { invoice_amount: number | null }[])
        .reduce((s, j) => s + (j.invoice_amount ?? 0), 0) * 100) / 100;

      const baseline = row.baseline_revenue_30d ?? 0;
      const actual_impact_pct = baseline > 0
        ? Math.round(((actual_revenue_30d - baseline) / baseline) * 10000) / 100
        : null;

      const { error: updateError } = await db.from("causal_outcome_tracking").update({
        actual_revenue_30d,
        actual_impact_pct,
        outcome_recorded_at: new Date().toISOString(),
      }).eq("id", row.id);

      if (!updateError) measured++;
    }

    return jsonResponse({ checked: pending?.length ?? 0, due: due.length, measured });
  } catch (error) {
    console.error(JSON.stringify({ event: "causal_outcome_tracker_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Outcome tracking sweep failed." }, 500);
  }
});
