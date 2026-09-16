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
    const { data: rows, error } = await admin.rpc("compute_platform_benchmarks", { min_sample_size: 5 });
    if (error) throw error;

    const now = new Date();
    const periodStart = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10);
    const periodEnd = now.toISOString().slice(0, 10);

    for (const row of rows ?? []) {
      await admin.from("benchmark_snapshots").upsert(
        {
          metric_key: row.metric_key,
          segment: row.segment,
          sample_size: row.sample_size,
          p25: row.p25,
          median: row.median,
          p75: row.p75,
          average: row.average,
          period_start: periodStart,
          period_end: periodEnd,
          computed_at: now.toISOString(),
        },
        { onConflict: "metric_key,segment" },
      );
    }

    return jsonResponse({ metrics_computed: rows?.length ?? 0 });
  } catch (error) {
    console.error(JSON.stringify({ event: "compute_benchmarks_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Benchmark computation failed." }, 500);
  }
});
