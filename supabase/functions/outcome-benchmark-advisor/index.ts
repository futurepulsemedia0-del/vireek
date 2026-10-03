// supabase/functions/outcome-benchmark-advisor/index.ts
//
// Runs entirely with the CALLER's JWT (no service-role key): every number the
// AI sees comes from get_outcome_benchmark()/get_outcome_drivers(), which
// enforce manager-only access, participation and k-anonymity in Postgres.
// Advice is cached per account+window (24h; 10-minute cooldown on refresh).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { ALLOWED_LEVERS, generateOutcomeAdvice } from "../_shared/ai-core/outcomeBenchmarkNarrative.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });

const CACHE_TTL_MS = 24 * 3600 * 1000;
const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

interface Row {
  metric: string; unit: string; direction: string; my_value: number; my_sample: number; scope: string;
  industry: string; region_key: string; p50: number | null; p25: number | null; p75: number | null; percentile_bucket: string | null;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await db.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    const body = (await req.json().catch(() => ({}))) as { window_days?: number; mode?: string };
    const windowDays = body.window_days === 90 ? 90 : 30;
    const mode = body.mode === "refresh" ? "refresh" : body.mode === "cached" ? "cached" : "generate";

    const [{ data: benchRows, error: benchErr }, { data: drivers }, { data: cacheRows }] = await Promise.all([
      db.rpc("get_outcome_benchmark", { p_window_days: windowDays }),
      db.rpc("get_outcome_drivers", { p_window_days: windowDays }),
      db.rpc("get_outcome_advice", { p_window_days: windowDays }),
    ]);
    if (benchErr) throw benchErr;

    const rows = ((benchRows ?? []) as Row[]).filter((r) => r.scope !== "none" && r.p50 !== null);
    if (rows.length === 0) return json({ advice: null, cached: false, generated_at: null, reason: "no_benchmark" });

    const cache = (cacheRows as { input_hash: string; advice: unknown; generated_at: string }[] | null)?.[0] ?? null;
    const ageMs = cache ? Date.now() - new Date(cache.generated_at).getTime() : Infinity;

    const inputHash = await sha256(
      JSON.stringify({
        rows: rows.map((r) => [r.metric, r.my_value, r.percentile_bucket, r.scope]),
        drivers: ((drivers ?? []) as { service_type: string; ftf_rate: number }[]).map((d) => [d.service_type, d.ftf_rate]),
      }),
    );

    const cacheFresh = !!cache && ageMs < CACHE_TTL_MS && cache.input_hash === inputHash;
    if (cache && (mode === "cached" || (mode === "generate" && cacheFresh) || (mode === "refresh" && ageMs < REFRESH_COOLDOWN_MS))) {
      return json({ advice: cache.advice, cached: true, generated_at: cache.generated_at, reason: null });
    }
    if (mode === "cached") return json({ advice: null, cached: false, generated_at: null, reason: "not_generated" });

    const payload = {
      metrics: rows.map((r) => {
        const topQ = r.direction === "higher_is_better" ? r.p75 : r.p25;
        const higher = r.direction === "higher_is_better";
        const gapMedian = Math.max(0, higher ? (r.p50 as number) - r.my_value : r.my_value - (r.p50 as number));
        const gapTop = topQ === null ? null : Math.max(0, higher ? topQ - r.my_value : r.my_value - topQ);
        return {
          metric: r.metric, unit: r.unit === "minutes" ? "minutes" : "percent", direction: r.direction,
          my_value: r.my_value, peer_median: r.p50, peer_top_quartile: topQ,
          gap_to_median: gapMedian, gap_to_top_quartile: gapTop, standing: r.percentile_bucket,
          peer_group: `${r.scope}:${r.industry}:${r.region_key}`, my_sample_size: r.my_sample,
        };
      }),
      my_lowest_first_time_fix_service_types: drivers ?? [],
      allowed_levers: ALLOWED_LEVERS,
    };

    if (payload.metrics.every((m) => m.gap_to_median === 0)) {
      return json({
        advice: { summary: "You are at or above the peer median on every metric. Keep doing what works and check back after the next nightly refresh.", changes: [] },
        cached: false, generated_at: new Date().toISOString(), reason: null,
      });
    }

    const advice = await generateOutcomeAdvice(payload);
    if (!advice) return json({ advice: null, cached: false, generated_at: null, reason: "ai_unavailable" });

    await db.rpc("save_outcome_advice", { p_window_days: windowDays, p_input_hash: inputHash, p_advice: advice });
    return json({ advice, cached: false, generated_at: new Date().toISOString(), reason: null });
  } catch (err) {
    console.error(JSON.stringify({ event: "outcome_benchmark_advisor_failed", error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "Could not build the improvement plan." }, 500);
  }
});
