// supabase/functions/analyze-job-autopsy/index.ts
//
// On-demand (same shape as analyze-callback-root-cause/index.ts): runs AS
// the authenticated user, not service role. Reads ONE row from the
// job_autopsy_candidates view (all facts already computed under RLS —
// nothing here re-detects a cost overrun), hands it to the AI root-cause
// layer, and upserts the result into job_autopsy_reports under RLS.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { analyzeJobAutopsy } from "../_shared/ai-core/jobAutopsyAnalysis.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: jsonHeaders });
    }

    let body: { job_id?: string } = {};
    try {
      body = await req.json();
    } catch {
      // no body
    }
    const jobId = body.job_id;
    if (!jobId) {
      return new Response(JSON.stringify({ error: "job_id is required." }), { status: 400, headers: jsonHeaders });
    }

    const { data: candidate, error: candErr } = await authClient
      .from("job_autopsy_candidates")
      .select("*")
      .eq("job_id", jobId)
      .maybeSingle();
    if (candErr) throw candErr;
    if (!candidate) {
      return new Response(
        JSON.stringify({ error: "That job isn't a completed, invoiced job matched to a Price Book entry yet." }),
        { status: 400, headers: jsonHeaders },
      );
    }

    const variance_cents = candidate.actual_cost_cents - candidate.expected_cost_cents;
    const variance_pct = candidate.expected_cost_cents > 0
      ? Math.round((variance_cents / candidate.expected_cost_cents) * 1000) / 10
      : null;

    const result = await analyzeJobAutopsy({
      service_type: candidate.service_type,
      technician_diagnosis: candidate.technician_diagnosis,
      expected_cost_cents: candidate.expected_cost_cents,
      actual_cost_cents: candidate.actual_cost_cents,
      variance_cents,
      variance_pct,
      duration_minutes: candidate.duration_minutes,
      reschedule_count: candidate.reschedule_count,
      schedule_shift_hours: candidate.schedule_shift_hours,
      parts_backordered_count: candidate.parts_backordered_count,
      is_rework: candidate.is_rework,
    });

    if (!result) {
      return new Response(JSON.stringify({ error: "Analysis failed — could not produce a grounded autopsy. Try again." }), {
        status: 502,
        headers: jsonHeaders,
      });
    }

    const estimated_recoverable_cents = variance_cents > 0
      ? Math.round((variance_cents * result.estimated_recoverable_pct) / 100)
      : 0;

    const payload = {
      user_id: user.id,
      job_id: jobId,
      expected_cost_cents: candidate.expected_cost_cents,
      actual_cost_cents: candidate.actual_cost_cents,
      variance_cents,
      variance_pct,
      root_causes: result.root_causes,
      ai_summary: result.ai_summary,
      counterfactual_summary: result.counterfactual_summary,
      recommended_prevention_action: result.recommended_prevention_action,
      estimated_recoverable_cents,
      confidence: result.confidence,
    };

    const { data: saved, error: saveErr } = await authClient
      .from("job_autopsy_reports")
      .upsert(payload, { onConflict: "job_id" })
      .select()
      .single();
    if (saveErr) throw saveErr;

    return new Response(JSON.stringify({ report: saved }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
