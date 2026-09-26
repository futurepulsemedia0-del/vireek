// supabase/functions/business-scientist-cycle/index.ts
//
// Autonomous Business Scientist — Research + Hypothesis stage.
//
// RESEARCH + PROBLEM DISCOVERY are deliberately NOT reimplemented here:
// they already happen in business-decision-engine, which mines calls,
// leads, and jobs into grounded, numeric `business_decisions` rows. This
// function's only job is to pick up decisions the owner hasn't acted on
// yet, turn each into a falsifiable HYPOTHESIS via the shared AI router,
// and create a study. Simulation (whether the effect is big enough to be
// worth a real experiment) runs immediately after, client-side, in
// src/lib/businessScientist.ts — never here, never AI-driven.
//
// Auth: the caller's own JWT. Reads run as the caller so RLS isolates
// tenants; the service-role client is used ONLY for the final insert
// (so a client can't forge a confidence score or a fake hypothesis).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { generateHypothesis, type ScientistProblem } from "../_shared/ai-core/businessScientist.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const MAX_STUDIES_PER_RUN = 3;
const LOOKBACK_DAYS = 30;

interface DecisionRow {
  id: string;
  category: string;
  title: string;
  reasoning: string;
  recommended_action: string;
  confidence_score: number;
  estimated_impact: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed." }), { status: 405, headers: jsonHeaders });
  }

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

    let { data: settings } = await db
      .from("business_scientist_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (!settings) {
      const { data: created } = await db
        .from("business_scientist_settings")
        .insert({ user_id: userId })
        .select("*")
        .single();
      settings = created;
    }
    const minConfidence = Number(settings?.min_confidence_threshold ?? 70);

    const lookback = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

    // Candidates: pending, sufficiently confident, quantifiable decisions
    // that don't already have a study.
    const { data: alreadyStudied } = await db
      .from("business_scientist_studies")
      .select("source_decision_id")
      .not("source_decision_id", "is", null);
    const studiedIds = new Set((alreadyStudied ?? []).map((r: { source_decision_id: string }) => r.source_decision_id));

    const { data: decisions, error: decisionsError } = await db
      .from("business_decisions")
      .select("id, category, title, reasoning, recommended_action, confidence_score, estimated_impact")
      .eq("user_id", userId)
      .eq("status", "pending")
      .gte("confidence_score", minConfidence)
      .gt("estimated_impact", 0)
      .gte("created_at", lookback)
      .order("confidence_score", { ascending: false })
      .limit(20);
    if (decisionsError) throw decisionsError;

    const candidates = ((decisions ?? []) as DecisionRow[])
      .filter((d) => !studiedIds.has(d.id))
      .slice(0, MAX_STUDIES_PER_RUN);

    let created = 0;
    const skipped: string[] = [];

    for (const decision of candidates) {
      const problem: ScientistProblem = {
        title: decision.title,
        category: decision.category,
        reasoning: decision.reasoning,
        recommended_action: decision.recommended_action,
        estimated_impact: decision.estimated_impact,
      };

      const hypothesis = await generateHypothesis(problem);
      if (!hypothesis) {
        skipped.push(decision.id);
        continue;
      }

      const { error: insertError } = await db.from("business_scientist_studies").insert({
        user_id: userId,
        source_decision_id: decision.id,
        category: decision.category,
        problem_title: decision.title,
        problem_evidence: { reasoning: decision.reasoning, recommended_action: decision.recommended_action },
        source_estimated_impact: decision.estimated_impact,
        stage: "hypothesis",
        hypothesis: hypothesis.hypothesis,
        proposed_intervention: hypothesis.proposed_intervention,
        predicted_metric: hypothesis.predicted_metric,
        predicted_direction: hypothesis.predicted_direction,
        predicted_magnitude_pct: hypothesis.predicted_magnitude_pct,
        confidence_score: hypothesis.confidence_score,
      });
      if (insertError) throw insertError;
      created++;
    }

    return new Response(
      JSON.stringify({ studies_created: created, candidates_considered: candidates.length, skipped: skipped.length }),
      { status: 200, headers: jsonHeaders },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
