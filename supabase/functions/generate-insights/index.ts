import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { analyzeBusinessInsights, type BusinessInsight } from "../_shared/ai-core/businessInsights.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface InsightRow {
  insight_type: "pattern" | "suggestion" | "alert";
  title: string;
  description: string;
  recommended_action: string | null;
  priority: number;
}

interface CallRow {
  is_emergency: boolean | null;
  status: string | null;
  call_datetime: string;
  caller_name: string | null;
  sentiment: "positive" | "neutral" | "negative" | null;
}

interface LeadRow {
  stage: string;
}

interface JobRow {
  job_status: string | null;
  invoice_status: string | null;
  invoice_amount: number | null;
}

// ---------------------------------------------------------------------
// Deterministic metric computation. This is intentionally the ONLY place
// that touches raw rows and does arithmetic — the AI layer below only
// ever reasons over the numbers this produces, so it can never invent a
// statistic that isn't real. Kept as small, named helpers so each metric
// is easy to audit independently.
// ---------------------------------------------------------------------

function computeEmergencySpike(calls: CallRow[]) {
  if (calls.length < 10) return null;
  const emergencyCalls = calls.filter((c) => c.is_emergency);
  if (emergencyCalls.length < 3) return null;
  const dayCount: Record<string, number> = {};
  emergencyCalls.forEach((c) => {
    const day = new Date(c.call_datetime).toLocaleDateString("en-US", { weekday: "long" });
    dayCount[day] = (dayCount[day] ?? 0) + 1;
  });
  const peakDay = Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0];
  if (!peakDay || peakDay[1] < 2) return null;
  return {
    peak_day: peakDay[0],
    peak_day_count: peakDay[1],
    total_emergency_calls: emergencyCalls.length,
    peak_day_pct: Math.round((peakDay[1] / emergencyCalls.length) * 100),
  };
}

function computeMissedCallRate(calls: CallRow[]) {
  if (calls.length < 8) return null;
  const missedCalls = calls.filter((c) => c.status === "missed");
  if (missedCalls.length < 2) return null;
  const overallMissedRate = Math.round((missedCalls.length / calls.length) * 100);

  const serviceMissed: Record<string, { total: number; missed: number }> = {};
  calls.forEach((c) => {
    const key = c.caller_name ?? "Unknown";
    if (!serviceMissed[key]) serviceMissed[key] = { total: 0, missed: 0 };
    serviceMissed[key].total++;
    if (c.status === "missed") serviceMissed[key].missed++;
  });
  const worstCaller = Object.entries(serviceMissed)
    .filter(([, v]) => v.total >= 2 && v.missed / v.total > 0.5)
    .sort((a, b) => b[1].missed - a[1].missed)[0];

  return {
    overall_missed_rate_pct: overallMissedRate,
    total_calls: calls.length,
    total_missed: missedCalls.length,
    repeat_missed_caller: worstCaller
      ? { name: worstCaller[0], missed: worstCaller[1].missed, total: worstCaller[1].total }
      : null,
  };
}

function computeStalledPipeline(leads: LeadRow[]) {
  if (leads.length < 5) return null;
  const stageCounts: Record<string, number> = {};
  leads.forEach((l) => {
    stageCounts[l.stage] = (stageCounts[l.stage] ?? 0) + 1;
  });
  const activeStages = ["new", "contacted", "quoted"];
  const stuckStage = activeStages
    .map((s) => ({ stage: s, count: stageCounts[s] ?? 0 }))
    .sort((a, b) => b.count - a.count)[0];
  if (!stuckStage || stuckStage.count < 3) return null;
  return {
    total_leads: leads.length,
    stalled_stage: stuckStage.stage,
    stalled_count: stuckStage.count,
    stalled_pct: Math.round((stuckStage.count / leads.length) * 100),
    stage_breakdown: stageCounts,
  };
}

function computeUsagePressure(profile: { minutes_used_this_month: number; minutes_included: number } | null) {
  if (!profile || profile.minutes_included <= 0) return null;
  const pct = Math.round((profile.minutes_used_this_month / profile.minutes_included) * 100);
  if (pct < 75) return null;
  return {
    minutes_used: profile.minutes_used_this_month,
    minutes_included: profile.minutes_included,
    usage_pct: pct,
    minutes_remaining: Math.max(0, profile.minutes_included - profile.minutes_used_this_month),
  };
}

function computeUnsentInvoices(jobs: JobRow[]) {
  const completedNoInvoice = jobs.filter((j) => j.job_status === "completed" && j.invoice_status === "not_sent");
  if (completedNoInvoice.length < 2) return null;
  return {
    count: completedNoInvoice.length,
    estimated_value_cents: completedNoInvoice.reduce((sum, j) => sum + (j.invoice_amount ?? 0), 0),
  };
}

function computeSentimentBreakdown(calls: CallRow[]) {
  const withSentiment = calls.filter((c) => c.sentiment !== null);
  if (withSentiment.length < 5) return null;
  const counts = { positive: 0, neutral: 0, negative: 0 };
  withSentiment.forEach((c) => {
    if (c.sentiment) counts[c.sentiment]++;
  });
  return { ...counts, total_analyzed: withSentiment.length };
}

// ---------------------------------------------------------------------
// Rule-based fallback — used ONLY if the AI layer is unavailable or
// returns nothing, so the feature degrades gracefully instead of going
// silent. Turns the same metrics straight into plain-language insights.
// ---------------------------------------------------------------------

function buildFallbackInsights(metrics: Record<string, unknown>): InsightRow[] {
  const insights: InsightRow[] = [];

  const spike = metrics.emergency_call_spike as ReturnType<typeof computeEmergencySpike>;
  if (spike) {
    insights.push({
      insight_type: "pattern",
      title: `Emergency calls spike on ${spike.peak_day}s`,
      description: `${spike.peak_day_pct}% of your recent emergency calls fall on ${spike.peak_day}s (${spike.peak_day_count} of ${spike.total_emergency_calls}).`,
      recommended_action: "Consider adding extra technician coverage or adjusting your on-call schedule for that day.",
      priority: 3,
    });
  }

  const missed = metrics.missed_call_rate as ReturnType<typeof computeMissedCallRate>;
  if (missed) {
    if (missed.repeat_missed_caller) {
      const c = missed.repeat_missed_caller;
      insights.push({
        insight_type: "alert",
        title: `High missed-call rate from ${c.name}`,
        description: `${Math.round((c.missed / c.total) * 100)}% of calls from ${c.name} were missed (${c.missed} of ${c.total}).`,
        recommended_action: "Schedule a callback or adjust your availability for this caller.",
        priority: 4,
      });
    } else if (missed.overall_missed_rate_pct > 20) {
      insights.push({
        insight_type: "alert",
        title: `Overall missed-call rate is ${missed.overall_missed_rate_pct}%`,
        description: `You're missing ${missed.overall_missed_rate_pct}% of incoming calls (${missed.total_missed} of ${missed.total_calls}).`,
        recommended_action: "Consider extending business hours or enabling after-hours forwarding.",
        priority: 4,
      });
    }
  }

  const stalled = metrics.stalled_pipeline as ReturnType<typeof computeStalledPipeline>;
  if (stalled) {
    insights.push({
      insight_type: "suggestion",
      title: `Leads stalling at "${stalled.stalled_stage}" stage`,
      description: `${stalled.stalled_count} leads (${stalled.stalled_pct}% of your pipeline) are stuck in "${stalled.stalled_stage}".`,
      recommended_action: "Follow up with these leads or review your quoting process to move them forward.",
      priority: 3,
    });
  }

  const usage = metrics.usage_pressure as ReturnType<typeof computeUsagePressure>;
  if (usage) {
    insights.push({
      insight_type: usage.usage_pct >= 90 ? "alert" : "suggestion",
      title: usage.usage_pct >= 90 ? "Minutes usage near plan limit" : "Minutes usage trending high",
      description: `You've used ${usage.minutes_used} of ${usage.minutes_included} included minutes (${usage.usage_pct}%). ${usage.minutes_remaining} minutes remaining this month.`,
      recommended_action: usage.usage_pct >= 90 ? "Upgrade your plan to avoid interruptions." : "Monitor usage to avoid hitting the limit.",
      priority: usage.usage_pct >= 90 ? 5 : 3,
    });
  }

  const invoices = metrics.unsent_invoices as ReturnType<typeof computeUnsentInvoices>;
  if (invoices) {
    insights.push({
      insight_type: "suggestion",
      title: `${invoices.count} completed jobs without invoices`,
      description: `You have ${invoices.count} completed jobs with invoices not yet sent, representing outstanding revenue.`,
      recommended_action: "Send these invoices now to collect payment sooner.",
      priority: 4,
    });
  }

  return insights.slice(0, 4);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { user_id } = await req.json();
    if (!user_id) {
      return new Response(
        JSON.stringify({ error: "user_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysIso = thirtyDaysAgo.toISOString();

    const [callsRes, leadsRes, jobsRes, profileRes] = await Promise.all([
      supabase.from("calls").select("*").eq("user_id", user_id).gte("call_datetime", thirtyDaysIso),
      supabase.from("leads").select("*").eq("user_id", user_id).gte("created_at", thirtyDaysIso),
      supabase.from("jobs").select("*").eq("user_id", user_id).gte("created_at", thirtyDaysIso),
      supabase.from("profiles").select("minutes_used_this_month, minutes_included").eq("id", user_id).maybeSingle(),
    ]);

    const calls = (callsRes.data ?? []) as CallRow[];
    const leads = (leadsRes.data ?? []) as LeadRow[];
    const jobs = (jobsRes.data ?? []) as JobRow[];
    const profile = profileRes.data;

    // Build the ground-truth metric snapshot. Every field is either null
    // (nothing notable) or a real computed object — never a guess.
    const metrics: Record<string, unknown> = {};
    const emergencySpike = computeEmergencySpike(calls);
    const missedCallRate = computeMissedCallRate(calls);
    const stalledPipeline = computeStalledPipeline(leads);
    const usagePressure = computeUsagePressure(profile);
    const unsentInvoices = computeUnsentInvoices(jobs);
    const sentimentBreakdown = computeSentimentBreakdown(calls);

    if (emergencySpike) metrics.emergency_call_spike = emergencySpike;
    if (missedCallRate) metrics.missed_call_rate = missedCallRate;
    if (stalledPipeline) metrics.stalled_pipeline = stalledPipeline;
    if (usagePressure) metrics.usage_pressure = usagePressure;
    if (unsentInvoices) metrics.unsent_invoices = unsentInvoices;
    if (sentimentBreakdown) metrics.call_sentiment_breakdown = sentimentBreakdown;

    let insights: InsightRow[] = [];

    if (Object.keys(metrics).length > 0) {
      // Real AI layer: let the model reason over the grounded metrics and
      // produce prioritized, narrative insights with a concrete action.
      const aiInsights: BusinessInsight[] = await analyzeBusinessInsights(metrics);
      if (aiInsights.length > 0) {
        insights = aiInsights;
      } else {
        // AI unavailable or returned nothing usable — degrade gracefully
        // to the deterministic rule-based version rather than going silent.
        insights = buildFallbackInsights(metrics);
      }
    }

    // Deduplicate against insights already shown and not dismissed.
    let newInsights: InsightRow[] = [];
    if (insights.length > 0) {
      const { data: existing } = await supabase
        .from("ai_insights")
        .select("title")
        .eq("user_id", user_id)
        .eq("is_dismissed", false)
        .order("created_at", { ascending: false })
        .limit(20);

      const existingTitles = new Set((existing ?? []).map((r: { title: string }) => r.title));
      newInsights = insights.filter((i) => !existingTitles.has(i.title));
    }

    const toInsert = newInsights.slice(0, 4);
    let generated = 0;
    if (toInsert.length > 0) {
      const rows = toInsert.map((i) => ({
        user_id,
        insight_type: i.insight_type,
        title: i.title,
        description: i.description,
        recommended_action: i.recommended_action,
        priority: i.priority,
        metric_snapshot: metrics,
      }));
      const { error: insertError } = await supabase.from("ai_insights").insert(rows);
      if (insertError) throw insertError;
      generated = toInsert.length;
    }

    return new Response(
      JSON.stringify({ generated, analyzed: { calls: calls.length, leads: leads.length, jobs: jobs.length } }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
