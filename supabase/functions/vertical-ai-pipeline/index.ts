// supabase/functions/vertical-ai-pipeline/index.ts
//
// Orchestrator for the Proprietary Vertical AI / Data Pipeline — see
// supabase/migrations/20261001000000_vertical_ai_data_pipeline.sql for the
// full design. This function does no analysis itself: it logs a run to
// `vertical_pipeline_runs`, calls the SECURITY DEFINER
// `mine_vertical_intelligence()` RPC (the only place allowed to scan every
// tenant's calls), and records the outcome. No transcript or per-tenant
// data ever passes through this function — only a row count comes back.
//
// Intended to run once a night via an external scheduler (pg_cron, a
// Supabase scheduled function, or any cron host) POSTing here with the
// `X-Cron-Secret` header set to the `VERTICAL_AI_CRON_SECRET` env var.
// Mirrors supabase/functions/compute-benchmarks/index.ts on purpose, so
// anyone maintaining one already knows how the other works.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

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
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const cronSecret = Deno.env.get("VERTICAL_AI_CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const triggeredBy = req.headers.get("X-Cron-Secret") ? "cron" : "manual";

  const { data: run, error: runInsertError } = await admin
    .from("vertical_pipeline_runs")
    .insert({ status: "running", triggered_by: triggeredBy })
    .select("id")
    .single();

  if (runInsertError || !run) {
    console.error(JSON.stringify({ event: "vertical_ai_pipeline_run_log_failed", error: runInsertError?.message }));
    return jsonResponse({ error: "Could not start pipeline run." }, 500);
  }

  try {
    const periodDaysParam = new URL(req.url).searchParams.get("period_days");
    const periodDays = periodDaysParam ? Number(periodDaysParam) : 30;

    const { data: signalsWritten, error: mineError } = await admin.rpc("mine_vertical_intelligence", {
      p_period_days: Number.isFinite(periodDays) ? periodDays : 30,
    });
    if (mineError) throw mineError;

    await admin
      .from("vertical_pipeline_runs")
      .update({ status: "succeeded", finished_at: new Date().toISOString(), signals_written: signalsWritten ?? 0 })
      .eq("id", run.id);

    return jsonResponse({ run_id: run.id, signals_written: signalsWritten ?? 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "vertical_ai_pipeline_failed", run_id: run.id, error: message }));

    await admin
      .from("vertical_pipeline_runs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_message: message.slice(0, 500) })
      .eq("id", run.id);

    return jsonResponse({ error: "Vertical AI pipeline run failed." }, 500);
  }
});
