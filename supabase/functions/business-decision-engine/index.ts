import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { analyzeBusinessDecisions, type BusinessDecision } from "../_shared/ai-core/businessDecisions.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

interface CallRow {
  is_emergency: boolean | null;
  status: string | null;
  call_datetime: string;
  upsell_opportunities: string[] | null;
}
interface LeadRow { stage: string; }
interface JobRow {
  job_status: string | null;
  invoice_status: string | null;
  invoice_amount: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------
// Deterministic metric computation — the ONLY place that touches raw
// rows and does arithmetic. AI only ever reasons over these numbers.
// ---------------------------------------------------------------------

function computeEmergencySpike(calls: CallRow[]) {
  const emergencyCalls = calls.filter((c) => c.is_emergency);
  if (emergencyCalls.length < 5) return null;
  const dayCount: Record<string, number> = {};
  emergencyCalls.forEach((c) => {
    const day = new Date(c.call_datetime).toLocaleDateString("en-US", { weekday: "long" });
    dayCount[day] = (dayCount[day] ?? 0) + 1;
  });
  const peakDay = Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0];
  const peakPct = peakDay ? Math.round((peakDay[1] / emergencyCalls.length) * 100) : 0;
  return {
    total_emergency_calls: emergencyCalls.length,
    peak_day: peakDay?.[0] ?? null,
    peak_day_pct: peakPct,
    is_severe: emergencyCalls.length >= 5 && peakPct >= 40,
  };
}

function computeMissedCallRate(calls: CallRow[]) {
  if (calls.length < 8) return null;
  const missed = calls.filter((c) => c.status === "missed");
  if (missed.length < 2) return null;
  return {
    total_calls: calls.length,
    total_missed: missed.length,
    missed_rate_pct: Math.round((missed.length / calls.length) * 100),
  };
}

function computeStalledPipeline(leads: LeadRow[]) {
  if (leads.length < 5) return null;
  const counts: Record<string, number> = {};
  leads.forEach((l) => { counts[l.stage] = (counts[l.stage] ?? 0) + 1; });
  const stuck = ["new", "contacted", "quoted"]
    .map((s) => ({ stage: s, count: counts[s] ?? 0 }))
    .sort((a, b) => b.count - a.count)[0];
  if (!stuck || stuck.count < 3) return null;
  return { total_leads: leads.length, stalled_stage: stuck.stage, stalled_count: stuck.count };
}

function computeCollectionsRisk(jobs: JobRow[]) {
  const now = Date.now();
  const overdue = jobs.filter((j) =>
    j.invoice_status === "sent" && (now - new Date(j.created_at).getTime()) / 86400000 >= 14
  );
  if (overdue.length === 0) return null;
  return {
    overdue_invoice_count: overdue.length,
    overdue_total_value: Math.round(overdue.reduce((s, j) => s + (j.invoice_amount ?? 0), 0) * 100) / 100,
  };
}

function computeRevenueTrend(jobsLast60: JobRow[]) {
  const cutoff = Date.now() - 30 * 86400000;
  const recent = jobsLast60.filter((j) => j.job_status === "completed" && new Date(j.created_at).getTime() >= cutoff);
  const prior = jobsLast60.filter((j) => j.job_status === "completed" && new Date(j.created_at).getTime() < cutoff);
  const recentTotal = recent.reduce((s, j) => s + (j.invoice_amount ?? 0), 0);
  const priorTotal = prior.reduce((s, j) => s + (j.invoice_amount ?? 0), 0);
  if (recentTotal === 0 && priorTotal === 0) return null;
  const changePct = priorTotal > 0 ? Math.round(((recentTotal - priorTotal) / priorTotal) * 100) : null;
  return {
    last_30_days_revenue: Math.round(recentTotal * 100) / 100,
    prior_30_days_revenue: Math.round(priorTotal * 100) / 100,
    change_pct: changePct,
  };
}

function computeUpsellPotential(calls: CallRow[]) {
  const withUpsell = calls.filter((c) => (c.upsell_opportunities?.length ?? 0) > 0);
  if (withUpsell.length < 3) return null;
  return { calls_with_missed_upsell: withUpsell.length };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    // Real auth: never trust a user_id from the request body for
    // something that can auto-modify account settings.
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
      .from("business_decision_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (!settings) {
      const { data: created } = await db
        .from("business_decision_settings")
        .insert({ user_id: userId })
        .select("*")
        .single();
      settings = created;
    }

    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString();
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString();

    const [callsRes, callsRecentRes, leadsRes, jobsRes, profileRes] = await Promise.all([
      db.from("calls").select("is_emergency, status, call_datetime, upsell_opportunities").eq("user_id", userId).gte("call_datetime", sixtyDaysAgo),
      db.from("calls").select("is_emergency, call_datetime").eq("user_id", userId).gte("call_datetime", fourteenDaysAgo),
      db.from("leads").select("stage").eq("user_id", userId).gte("created_at", sixtyDaysAgo),
      db.from("jobs").select("job_status, invoice_status, invoice_amount, created_at").eq("user_id", userId).gte("created_at", sixtyDaysAgo),
      db.from("profiles").select("surge_mode_active, surge_mode_note").eq("id", userId).maybeSingle(),
    ]);

    const calls = (callsRes.data ?? []) as CallRow[];
    const callsRecent = (callsRecentRes.data ?? []) as CallRow[];
    const leads = (leadsRes.data ?? []) as LeadRow[];
    const jobs = (jobsRes.data ?? []) as JobRow[];
    const profile = profileRes.data as { surge_mode_active: boolean; surge_mode_note: string | null } | null;

    const metrics: Record<string, unknown> = {};
    const spike14d = computeEmergencySpike(callsRecent);
    const missedCallRate = computeMissedCallRate(calls);
    const stalledPipeline = computeStalledPipeline(leads);
    const collectionsRisk = computeCollectionsRisk(jobs);
    const revenueTrend = computeRevenueTrend(jobs);
    const upsellPotential = computeUpsellPotential(calls);

    if (spike14d) metrics.emergency_call_spike = spike14d;
    if (missedCallRate) metrics.missed_call_rate = missedCallRate;
    if (stalledPipeline) metrics.stalled_pipeline = stalledPipeline;
    if (collectionsRisk) metrics.collections_risk = collectionsRisk;
    if (revenueTrend) metrics.revenue_trend = revenueTrend;
    if (upsellPotential) metrics.upsell_potential = upsellPotential;

    // -----------------------------------------------------------------
    // Deterministic auto-execution — rule-based, NEVER driven by raw AI
    // output. The only lever touched is the pre-existing surge mode flag.
    // -----------------------------------------------------------------
    let autoExecuted = 0;
    if (settings?.autonomy_enabled && settings?.surge_mode_auto_control && profile) {
      const wasAutoSet = (profile.surge_mode_note ?? "").startsWith("Auto-enabled by the Business Decision Engine");

      if (spike14d?.is_severe && !profile.surge_mode_active) {
        await db.from("profiles").update({
          surge_mode_active: true,
          surge_mode_note: `Auto-enabled by the Business Decision Engine — ${spike14d.total_emergency_calls} emergency calls in the last 14 days, ${spike14d.peak_day_pct}% concentrated on ${spike14d.peak_day}.`,
          surge_mode_activated_at: new Date().toISOString(),
        }).eq("id", userId);

        await db.from("business_decisions").insert({
          user_id: userId,
          category: "dispatch",
          title: "Surge mode enabled automatically",
          reasoning: `Emergency call volume spiked (${spike14d.total_emergency_calls} calls, ${spike14d.peak_day_pct}% on ${spike14d.peak_day}), matching the threshold you set for automatic surge response.`,
          recommended_action: "Surge mode was turned on for you. Review pricing/on-call coverage if this continues.",
          confidence_score: 92,
          estimated_impact: 0,
          status: "auto_executed",
          is_auto_executable: true,
          executed_at: new Date().toISOString(),
          metric_snapshot: { emergency_call_spike: spike14d },
        });
        autoExecuted++;
      } else if (wasAutoSet && profile.surge_mode_active && !spike14d?.is_severe) {
        await db.from("profiles").update({
          surge_mode_active: false,
          surge_mode_note: null,
          surge_mode_activated_at: null,
        }).eq("id", userId);

        await db.from("business_decisions").insert({
          user_id: userId,
          category: "dispatch",
          title: "Surge mode disabled automatically",
          reasoning: "Emergency call volume has returned to normal levels.",
          recommended_action: "Surge mode was turned back off for you.",
          confidence_score: 88,
          estimated_impact: 0,
          status: "auto_executed",
          is_auto_executable: true,
          executed_at: new Date().toISOString(),
          metric_snapshot: { emergency_call_spike: spike14d },
        });
        autoExecuted++;
      }
    }

    // -----------------------------------------------------------------
    // Advisory decisions — AI reasons over the metrics, owner approves.
    // -----------------------------------------------------------------
    let generated = 0;
    if (Object.keys(metrics).length > 0) {
      const decisions: BusinessDecision[] = await analyzeBusinessDecisions(metrics);
      const minConfidence = Number(settings?.min_confidence_threshold ?? 70);
      const qualifying = decisions.filter((d) => d.confidence_score >= minConfidence);

      if (qualifying.length > 0) {
        const { data: existing } = await db
          .from("business_decisions")
          .select("title")
          .eq("user_id", userId)
          .in("status", ["pending", "auto_executed"])
          .gte("created_at", fourteenDaysAgo);
        const existingTitles = new Set((existing ?? []).map((r: { title: string }) => r.title));
        const fresh = qualifying.filter((d) => !existingTitles.has(d.title)).slice(0, 5);

        if (fresh.length > 0) {
          const rows = fresh.map((d) => ({
            user_id: userId,
            category: d.category,
            title: d.title,
            reasoning: d.reasoning,
            recommended_action: d.recommended_action,
            confidence_score: d.confidence_score,
            estimated_impact: d.estimated_impact,
            status: "pending",
            is_auto_executable: false,
            metric_snapshot: metrics,
          }));
          const { error: insertError } = await db.from("business_decisions").insert(rows);
          if (insertError) throw insertError;
          generated = fresh.length;
        }
      }
    }

    return new Response(JSON.stringify({ generated, auto_executed: autoExecuted }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
