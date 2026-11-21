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
    console.error(JSON.stringify({ event: "compute_regional_demand_failed", error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }));
    return jsonResponse({ error: "Server misconfiguration." }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  try {
    const { data: rows, error: rpcError } = await admin.rpc("compute_regional_demand", { min_sample_size: 5 });
    if (rpcError) throw rpcError;

    const now = new Date();
    const periodStart = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);
    const periodEnd = now.toISOString().slice(0, 10);
    const computedAt = now.toISOString();

    const candidateRows = rows ?? [];

    // Antitrust information-exchange guard (fail closed): minimum cohort, single-tenant share and narrow-geography
    // suppression, all from the database config. If the guard cannot answer, publish nothing and purge below.
    let safeRows: typeof candidateRows = [];
    let guardFailed = false;
    try {
      const { data: shares, error: sharesError } = await admin.rpc("ixg_regional_segment_shares");
      if (sharesError) throw sharesError;
      const shareBySegment = new Map<string, number>(
        ((shares ?? []) as Array<{ industry: string; region_key: string; max_share_pct: number | null }>)
          .filter((s) => s.max_share_pct !== null)
          .map((s) => [`${s.industry}|${s.region_key}`, Number(s.max_share_pct)]),
      );
      const metrics = ["current_week_calls", "prior_week_calls", "call_volume_change_pct", "current_week_leads", "emergency_rate_pct"];
      const guarded = await guardRows(
        admin as unknown as GuardRpcClient,
        "regional_demand",
        candidateRows,
        (row: { industry: string; region_key: string; sample_size: number }) =>
          metrics.map((metric) => ({
            metric,
            cohort_size: row.sample_size,
            geo_text: row.region_key,
            max_share_pct: shareBySegment.get(`${row.industry}|${row.region_key}`) ?? null,
          })),
      );
      safeRows = guarded.allowed;
    } catch (guardError) {
      guardFailed = true;
      console.error(JSON.stringify({ event: "info_exchange_guard_unavailable", flow: "regional_demand", error: guardError instanceof Error ? guardError.message : String(guardError) }));
    }

    if (safeRows.length > 0) {
      const snapshots = safeRows.map((row) => ({
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
        computed_at: computedAt,
      }));

      const { error: upsertError } = await admin
        .from("regional_demand_snapshots")
        .upsert(snapshots, { onConflict: "industry,region_key" });

      if (upsertError) throw upsertError;
    }
    // Consent revocation: a segment that no longer clears k-anonymity (or whose contributors withdrew
    // consent) is absent from this run. Remove every row not written in this run, even when the run
    // returned zero rows, so withdrawn data never lingers in the published table.
    const { error: purgeError } = await admin
      .from("regional_demand_snapshots")
      .delete()
      .lt("computed_at", computedAt);
    if (purgeError) throw purgeError;
    if (guardFailed) return jsonResponse({ error: "Regional demand publication blocked by the information-exchange guard." }, 503);
    return jsonResponse({ segments_computed: safeRows.length });
  } catch (error) {
    console.error(JSON.stringify({ event: "compute_regional_demand_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Regional demand computation failed." }, 500);
  }
});
