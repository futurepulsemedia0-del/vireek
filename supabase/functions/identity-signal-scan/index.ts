import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { narrateIdentityDrift, type IdentityDimension } from "../_shared/ai-core/identityLearner.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const LOOKBACK_DAYS = 45;
const RECENT_WINDOW_DAYS = 14;
const BASELINE_WINDOW_DAYS = 90;
const DRIFT_THRESHOLD = 30;
const MIN_RECENT_SAMPLES = 2;
const MIN_BASELINE_SAMPLES = 3;

const DIMENSIONS: IdentityDimension[] = [
  "growth_vs_stability", "risk_tolerance", "price_position", "automation_trust", "speed_vs_quality",
];

// ---------------------------------------------------------------------
// Deterministic category -> dimension signal map. This is the ONLY
// place a real decision gets translated into a number — never the AI.
// ---------------------------------------------------------------------
const CATEGORY_SIGNALS: Record<string, { dimension: IdentityDimension; onApprove: number; onReject: number }[]> = {
  pricing: [
    { dimension: "price_position", onApprove: 40, onReject: -20 },
    { dimension: "growth_vs_stability", onApprove: 15, onReject: -10 },
  ],
  dispatch: [{ dimension: "speed_vs_quality", onApprove: 30, onReject: -15 }],
  staffing: [{ dimension: "growth_vs_stability", onApprove: 35, onReject: -20 }],
  marketing: [{ dimension: "growth_vs_stability", onApprove: 40, onReject: -20 }],
  collections: [{ dimension: "risk_tolerance", onApprove: -25, onReject: 15 }],
  retention: [{ dimension: "growth_vs_stability", onApprove: -20, onReject: 10 }],
  operations: [{ dimension: "automation_trust", onApprove: 20, onReject: -10 }],
};

interface ObservationRow {
  user_id: string;
  source_type: "business_decision" | "causal_outcome" | "regret_console" | "autonomy_setting";
  source_id: string;
  dimension: IdentityDimension;
  signal: number;
  weight: number;
  note: string;
  observed_at: string;
}

async function collectObservations(db: ReturnType<typeof createClient>, userId: string): Promise<ObservationRow[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const rows: ObservationRow[] = [];

  // 1. business_decisions the owner has already acted on
  const { data: decisions } = await db
    .from("business_decisions")
    .select("id, category, status, confidence_score, created_at")
    .eq("user_id", userId)
    .in("status", ["approved", "rejected"])
    .gte("created_at", since);

  for (const d of decisions ?? []) {
    const mappings = CATEGORY_SIGNALS[d.category as string];
    if (!mappings) continue;
    const weight = Math.max(0.3, Number(d.confidence_score ?? 50) / 100);
    for (const m of mappings) {
      const base = d.status === "approved" ? m.onApprove : m.onReject;
      if (base === 0) continue;
      rows.push({
        user_id: userId,
        source_type: "business_decision",
        source_id: d.id,
        dimension: m.dimension,
        signal: Math.max(-100, Math.min(100, base)),
        weight: Math.round(weight * 100) / 100,
        note: `${d.status === "approved" ? "Approved" : "Rejected"} a ${d.category} decision (${d.confidence_score}% confidence).`,
        observed_at: d.created_at,
      });
    }
  }

  // 2. causally-simulated decisions the owner actually implemented
  const { data: outcomeRows } = await db
    .from("causal_outcome_tracking")
    .select("id, scenario_id, decision_made_at")
    .eq("user_id", userId)
    .eq("decision_made", true)
    .gte("decision_made_at", since);

  if (outcomeRows && outcomeRows.length > 0) {
    const scenarioIds = outcomeRows.map((r) => r.scenario_id);
    const { data: scenarios } = await db.from("causal_scenarios").select("id, decision_category").in("id", scenarioIds);
    const categoryById = new Map((scenarios ?? []).map((s) => [s.id as string, s.decision_category as string]));

    for (const o of outcomeRows) {
      const category = categoryById.get(o.scenario_id);
      rows.push({
        user_id: userId,
        source_type: "causal_outcome",
        source_id: o.id,
        dimension: "risk_tolerance",
        signal: 25,
        weight: 1,
        note: `Implemented a simulated ${category ?? "business"} decision instead of only reading the forecast.`,
        observed_at: o.decision_made_at as string,
      });
      const growthMapping = category ? CATEGORY_SIGNALS[category]?.find((m) => m.dimension === "growth_vs_stability") : null;
      if (growthMapping) {
        rows.push({
          user_id: userId,
          source_type: "causal_outcome",
          source_id: `${o.id}:growth`,
          dimension: "growth_vs_stability",
          signal: Math.round(growthMapping.onApprove * 0.5),
          weight: 0.8,
          note: `Implemented a simulated ${category} decision.`,
          observed_at: o.decision_made_at as string,
        });
      }
    }
  }

  // 3. regret console — real choices, not just built matrices
  const { data: regretDecisions } = await db
    .from("regret_console_decisions")
    .select("id, options, recommended_option_id, chosen_option_id, decided_at")
    .eq("user_id", userId)
    .not("decided_at", "is", null)
    .gte("decided_at", since);

  for (const r of regretDecisions ?? []) {
    const options = (r.options ?? []) as { id: string; reversibility?: string }[];
    const chosen = options.find((o) => o.id === r.chosen_option_id);
    if (chosen?.reversibility === "hard") {
      rows.push({
        user_id: userId, source_type: "regret_console", source_id: `${r.id}:reversibility`,
        dimension: "risk_tolerance", signal: 25, weight: 1,
        note: "Chose a hard-to-reverse option in the Regret Console.", observed_at: r.decided_at as string,
      });
    } else if (chosen?.reversibility === "easy") {
      rows.push({
        user_id: userId, source_type: "regret_console", source_id: `${r.id}:reversibility`,
        dimension: "risk_tolerance", signal: -10, weight: 0.8,
        note: "Chose an easily-reversible option in the Regret Console.", observed_at: r.decided_at as string,
      });
    }
    if (r.chosen_option_id && r.recommended_option_id) {
      const followedSafePick = r.chosen_option_id === r.recommended_option_id;
      rows.push({
        user_id: userId, source_type: "regret_console", source_id: `${r.id}:pick`,
        dimension: "growth_vs_stability", signal: followedSafePick ? -10 : 10, weight: 0.7,
        note: followedSafePick ? "Followed the minimax-regret-safe recommendation." : "Went with a bolder option than the safe recommendation.",
        observed_at: r.decided_at as string,
      });
    }
  }

  // 4. autonomy setting — a direct statement of trust in automation
  const { data: settings } = await db
    .from("business_decision_settings")
    .select("user_id, autonomy_enabled, updated_at")
    .eq("user_id", userId)
    .gte("updated_at", since)
    .maybeSingle();

  if (settings) {
    rows.push({
      user_id: userId,
      source_type: "autonomy_setting",
      source_id: settings.updated_at as string,
      dimension: "automation_trust",
      signal: settings.autonomy_enabled ? 50 : -30,
      weight: 1.2,
      note: settings.autonomy_enabled ? "Turned on autonomous execution in the Decision Engine." : "Turned off autonomous execution in the Decision Engine.",
      observed_at: settings.updated_at as string,
    });
  }

  return rows;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

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

    // Step 1: derive fresh signals from real events, idempotently.
    const candidates = await collectObservations(db, userId);
    let newObservations = 0;
    if (candidates.length > 0) {
      const { data: inserted, error: insertError } = await db
        .from("identity_observations")
        .upsert(candidates, { onConflict: "user_id,source_type,source_id,dimension", ignoreDuplicates: true })
        .select("id");
      if (insertError) throw insertError;
      newObservations = inserted?.length ?? 0;
    }

    // Step 2: compute the live profile from the full observation log.
    const lookback = new Date(Date.now() - BASELINE_WINDOW_DAYS * 86400000).toISOString();
    const { data: allObservations } = await db
      .from("identity_observations")
      .select("dimension, signal, weight, note, observed_at")
      .eq("user_id", userId)
      .gte("observed_at", lookback)
      .order("observed_at", { ascending: false });

    const observations = allObservations ?? [];
    const recentCutoff = Date.now() - RECENT_WINDOW_DAYS * 86400000;

    const profile: Record<string, { recent_value: number | null; baseline_value: number | null; recent_samples: number; baseline_samples: number }> = {};
    const driftAlertsCreated: { dimension: string; title: string }[] = [];

    for (const dim of DIMENSIONS) {
      const dimRows = observations.filter((o) => o.dimension === dim);
      const recentRows = dimRows.filter((o) => new Date(o.observed_at).getTime() >= recentCutoff);
      const baselineRows = dimRows.filter((o) => new Date(o.observed_at).getTime() < recentCutoff);

      const weightedAvg = (rows: typeof dimRows) => {
        const totalWeight = rows.reduce((s, r) => s + Number(r.weight), 0);
        if (totalWeight === 0) return null;
        return Math.round((rows.reduce((s, r) => s + Number(r.signal) * Number(r.weight), 0) / totalWeight) * 100) / 100;
      };

      const recent_value = weightedAvg(recentRows);
      const baseline_value = weightedAvg(baselineRows);

      profile[dim] = {
        recent_value, baseline_value,
        recent_samples: recentRows.length, baseline_samples: baselineRows.length,
      };

      if (
        recent_value !== null && baseline_value !== null &&
        recentRows.length >= MIN_RECENT_SAMPLES && baselineRows.length >= MIN_BASELINE_SAMPLES &&
        Math.abs(recent_value - baseline_value) >= DRIFT_THRESHOLD
      ) {
        const { data: existingAlert } = await db
          .from("identity_drift_alerts")
          .select("id")
          .eq("user_id", userId)
          .eq("dimension", dim)
          .eq("status", "open")
          .gte("created_at", new Date(Date.now() - RECENT_WINDOW_DAYS * 86400000).toISOString())
          .maybeSingle();

        if (!existingAlert) {
          const narration = await narrateIdentityDrift({
            dimension: dim,
            baseline_value, recent_value,
            baseline_samples: baselineRows.length, recent_samples: recentRows.length,
            example_notes: recentRows.slice(0, 3).map((r) => r.note as string),
          });

          const { error: alertError } = await db.from("identity_drift_alerts").insert({
            user_id: userId,
            dimension: dim,
            baseline_value, recent_value,
            shift_magnitude: Math.round(Math.abs(recent_value - baseline_value) * 100) / 100,
            title: narration.title,
            summary: narration.summary,
            status: "open",
          });
          if (!alertError) driftAlertsCreated.push({ dimension: dim, title: narration.title });
        }
      }
    }

    return new Response(JSON.stringify({ profile, new_observations: newObservations, drift_alerts_created: driftAlertsCreated }), { headers: jsonHeaders });
  } catch (error) {
    console.error(JSON.stringify({ event: "identity_signal_scan_failed", error: error instanceof Error ? error.message : String(error) }));
    return new Response(JSON.stringify({ error: "Could not scan identity signals." }), { status: 500, headers: jsonHeaders });
  }
});
