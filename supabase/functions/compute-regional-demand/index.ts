import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret" };

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const cronSecret = Deno.env.get("BENCHMARK_CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) return jsonResponse({ error: "Unauthorized." }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    const { data: rows, error } = await admin.rpc("compute_regional_demand", { min_sample_size: 5 });
    if (error) throw error;

    const now = new Date();
    const periodStart = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);
    const periodEnd = now.toISOString().slice(0, 10);

    for (const row of rows ?? []) {
      await admin.from("regional_demand_snapshots").upsert(
        {
          industry: row.industry,
          region_key: row.region_key,
          region_label: row.region_label,
          sample_size: row.sample_size,
          current_week_calls: row.current_week_calls,
          prior_week_calls: row.prior_week_calls,
          call_volume_change_pct: row.call_volume_change_pct,
          current_week_leads: row.current_week_leads,
          emergency_rate_pct: row.emergency_rate_pct,
          period_start: periodStart,
          period_end: periodEnd,
          computed_at: now.toISOString(),
        },
        { onConflict: "industry,region_key" },
      );
    }

    return jsonResponse({ segments_computed: rows?.length ?? 0 });
  } catch (error) {
    console.error(JSON.stringify({ event: "compute_regional_demand_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Regional demand computation failed." }, 500);
  }
});
