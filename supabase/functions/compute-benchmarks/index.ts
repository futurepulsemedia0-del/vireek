import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { guardRows, type GuardRpcClient } from "../_shared/infoExchangeGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const cronSecret = Deno.env.get("BENCHMARK_CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(JSON.stringify({ event: "compute_benchmarks_failed", error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }));
    return jsonResponse({ error: "Server misconfiguration." }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  try {
    const { data: rows, error: rpcError } = await admin.rpc("compute_platform_benchmarks", { min_sample_size: 5 });
    if (rpcError) throw rpcError;

    const now = new Date();
    const periodStart = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10);
    const periodEnd = now.toISOString().slice(0, 10);
    const computedAt = now.toISOString();

    const candidateRows = rows ?? [];

    // Antitrust information-exchange guard (fail closed). Thresholds live in the database config.
    // If the guard cannot answer, publish nothing: the purge below then removes what is already published.
    let safeRows: typeof candidateRows = [];
    let guardFailed = false;
    try {
      const guarded = await guardRows(
        admin as unknown as GuardRpcClient,
        "platform_benchmarks",
        candidateRows,
        (row: { metric_key: string; sample_size: number }) => [{ metric: row.metric_key, cohort_size: row.sample_size }],
      );
      safeRows = guarded.allowed;
    } catch (guardError) {
      guardFailed = true;
      console.error(JSON.stringify({ event: "info_exchange_guard_unavailable", flow: "platform_benchmarks", error: guardError instanceof Error ? guardError.message : String(guardError) }));
    }

    if (safeRows.length > 0) {
      const snapshots = safeRows.map((row) => ({
        metric_key: row.metric_key,
        segment: row.segment,
        sample_size: row.sample_size,
        p25: row.p25,
        median: row.median,
        p75: row.p75,
        average: row.average,
        period_start: periodStart,
        period_end: periodEnd,
        computed_at: computedAt,
      }));

      const { error: upsertError } = await admin
        .from("benchmark_snapshots")
        .upsert(snapshots, { onConflict: "metric_key,segment" });

      if (upsertError) throw upsertError;
    }
    // Consent revocation: remove every metric not written in this run (including when this run
    // produced zero rows), so data from tenants that withdrew consent never lingers.
    const { error: purgeError } = await admin
      .from("benchmark_snapshots")
      .delete()
      .lt("computed_at", computedAt);
    if (purgeError) throw purgeError;
    if (guardFailed) return jsonResponse({ error: "Benchmark publication blocked by the information-exchange guard." }, 503);
    return jsonResponse({ metrics_computed: safeRows.length });
  } catch (error) {
    console.error(JSON.stringify({ event: "compute_benchmarks_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Benchmark computation failed." }, 500);
  }
});
