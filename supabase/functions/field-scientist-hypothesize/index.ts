// supabase/functions/field-scientist-hypothesize/index.ts
//
// AI Field Scientist — candidate-cause stage.
//
// Input : { hypothesis_id: string }
// Effect: loads ONE already-validated hypothesis (as the caller, so RLS
//         isolates tenants), asks the shared AI router for 2-5 candidate
//         causes + job-level interventions, and writes them back with the
//         service-role client (so a browser can never forge AI output).
//
// Statistics, sample sizes, randomisation and verdicts are NOT computed here
// — see src/lib/fieldScientist.ts.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { generateCandidateCauses, type FieldFinding } from "../_shared/ai-core/fieldScientist.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });

const AVAILABLE_DATA = [
  "technician", "technician group", "equipment type", "service type",
  "booked duration bucket", "time-of-day / weekday bucket", "callback within 30 days",
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "Method not allowed." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const authClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return reply({ error: "Not authenticated." }, 401);

    const body = await req.json().catch(() => ({})) as { hypothesis_id?: unknown };
    const hypothesisId = typeof body.hypothesis_id === "string" ? body.hypothesis_id : "";
    if (!/^[0-9a-f-]{36}$/i.test(hypothesisId)) return reply({ error: "hypothesis_id is required." }, 400);

    // Read as the caller: RLS returns the row only if it belongs to their account.
    const { data: row, error: readError } = await authClient
      .from("field_hypotheses")
      .select("id, user_id, status, statement, segment_dimension, segment_label, direction, outcome_metric, discovery")
      .eq("id", hypothesisId)
      .maybeSingle();
    if (readError) throw readError;
    if (!row) return reply({ error: "Hypothesis not found." }, 404);
    if (row.status !== "proposed" && row.status !== "ready") {
      return reply({ error: "Causes can only be (re)generated before an experiment starts." }, 409);
    }

    const d = (row.discovery ?? {}) as Record<string, unknown>;
    const finding: FieldFinding = {
      statement: row.statement,
      segment_dimension: row.segment_dimension,
      segment_label: row.segment_label,
      direction: row.direction,
      outcome_metric: row.outcome_metric,
      segment_rate_pct: Number(d.segment_rate_pct ?? 0),
      comparison_rate_pct: Number(d.comparison_rate_pct ?? 0),
      segment_jobs: Number(d.segment_n ?? 0),
      adjusted_for_service_mix: d.adjusted_significant === true,
      drilldown: Array.isArray(d.drilldown) ? (d.drilldown as FieldFinding["drilldown"]).slice(0, 4) : [],
      available_data: AVAILABLE_DATA,
    };

    const causes = await generateCandidateCauses(finding);
    if (!causes) return reply({ error: "AI could not produce valid candidate causes right now." }, 503);

    const db = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { error: updateError } = await db
      .from("field_hypotheses")
      .update({ candidate_causes: causes, status: "ready", selected_cause_id: null, experiment_design: null })
      .eq("id", row.id)
      .eq("user_id", row.user_id);
    if (updateError) throw updateError;

    await db.from("field_hypothesis_events").insert({
      user_id: row.user_id,
      hypothesis_id: row.id,
      event_type: "causes_generated",
      payload: { count: causes.length },
    });

    return reply({ causes_created: causes.length });
  } catch (err) {
    return reply({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
