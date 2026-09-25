import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { narrateBusinessDrift, type DriftMetricInput } from "../_shared/ai-core/businessDriftNarrative.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

// Direction that counts as "bad" for each metric — used to decide
// whether a change crosses the flag threshold.
const BAD_DIRECTION: Record<string, "up" | "down"> = {
  discount_rate: "up",
  job_duration: "up",
  overtime_load: "up",
  evidence_quality: "down",
  callback_rate: "up",
  low_margin_mix: "up",
  dispatcher_overrides: "up",
};

interface DriftMetric {
  metric: string;
  recent: number;
  baseline: number;
  pct_change: number;
  unit: string;
  flagged: boolean;
  sample_ok: boolean;
}

function buildMetric(
  metric: string,
  recent: number,
  baseline: number,
  unit: string,
  minBaseline: number,
  baselineSampleSize: number,
  thresholdPct = 15,
): DriftMetric {
  const sample_ok = baselineSampleSize >= 5 && baseline >= minBaseline;
  const pct_change = baseline > 0 ? Math.round(((recent - baseline) / baseline) * 1000) / 10 : (recent > 0 ? 100 : 0);
  const direction = BAD_DIRECTION[metric];
  const flagged = sample_ok && (direction === "up" ? pct_change >= thresholdPct : pct_change <= -thresholdPct);
  return { metric, recent: Math.round(recent * 100) / 100, baseline: Math.round(baseline * 100) / 100, pct_change, unit, flagged, sample_ok };
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

    const now = new Date();
    const periodStart = new Date(now.getTime() - 30 * 86400000);
    const baselineStart = new Date(now.getTime() - 120 * 86400000);
    const baselineEnd = periodStart;

    const inRecent = (iso: string) => iso >= periodStart.toISOString();
    const inBaseline = (iso: string) => iso >= baselineStart.toISOString() && iso < baselineEnd.toISOString();

    const [
      quotesRes, evidenceRes, callbacksRes, assignmentsRes, profitJobsRes, businessProfileRes,
    ] = await Promise.all([
      db.from("quotes").select("status, discount_value, discount_type, line_items, sent_at")
        .eq("user_id", userId).in("status", ["sent", "accepted"]).gte("sent_at", baselineStart.toISOString()),
      db.from("job_evidence_checks").select("verdict, evidence_completeness, created_at")
        .eq("user_id", userId).gte("created_at", baselineStart.toISOString()),
      db.from("callback_root_cause_analyses").select("created_at")
        .eq("user_id", userId).gte("created_at", baselineStart.toISOString()),
      db.from("job_technician_assignments").select("previous_technician_id, assigned_at")
        .eq("user_id", userId).gte("assigned_at", baselineStart.toISOString()),
      db.from("jobs").select("id, job_status, created_at").eq("user_id", userId)
        .eq("job_status", "completed").gte("created_at", baselineStart.toISOString()),
      db.from("business_profile").select("margin_floor_pct").eq("id", userId).maybeSingle(),
    ]);

    const marginFloor = businessProfileRes.data?.margin_floor_pct ?? 20;

    // -------------------------------------------------------------
    // 1) discount_rate — % of sent/accepted quotes carrying a discount
    // -------------------------------------------------------------
    const quotes = quotesRes.data ?? [];
    const recentQuotes = quotes.filter((q) => q.sent_at && inRecent(q.sent_at));
    const baselineQuotes = quotes.filter((q) => q.sent_at && inBaseline(q.sent_at));
    const discRate = (arr: typeof quotes) => arr.length ? (arr.filter((q) => q.discount_value && q.discount_value > 0).length / arr.length) * 100 : 0;
    const discountMetric = buildMetric("discount_rate", discRate(recentQuotes), discRate(baselineQuotes), "% of quotes", 0, baselineQuotes.length);

    // -------------------------------------------------------------
    // 2) job_duration — avg duration_minutes for service types present
    //    in both windows, weighted by baseline job count
    // -------------------------------------------------------------
    const { data: jobsForDuration } = await db
      .from("jobs").select("service_type, duration_minutes, job_status, created_at")
      .eq("user_id", userId).eq("job_status", "completed").gte("created_at", baselineStart.toISOString());
    const byType: Record<string, { recent: number[]; baseline: number[] }> = {};
    for (const j of jobsForDuration ?? []) {
      const type = j.service_type ?? "unspecified";
      byType[type] ??= { recent: [], baseline: [] };
      if (inRecent(j.created_at)) byType[type].recent.push(j.duration_minutes ?? 60);
      else if (inBaseline(j.created_at)) byType[type].baseline.push(j.duration_minutes ?? 60);
    }
    let durRecentWeighted = 0, durBaselineWeighted = 0, durWeight = 0;
    for (const t of Object.values(byType)) {
      if (t.recent.length < 2 || t.baseline.length < 3) continue;
      const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
      durRecentWeighted += avg(t.recent) * t.baseline.length;
      durBaselineWeighted += avg(t.baseline) * t.baseline.length;
      durWeight += t.baseline.length;
    }
    const durationMetric = buildMetric(
      "job_duration",
      durWeight ? durRecentWeighted / durWeight : 0,
      durWeight ? durBaselineWeighted / durWeight : 0,
      "minutes", 0, durWeight,
    );

    // -------------------------------------------------------------
    // 3) overtime_load — proxy: minutes per technician-day beyond 8h
    //    (no dedicated timeclock table in this schema; swap this query
    //    for a real one if/when you add time tracking)
    // -------------------------------------------------------------
    const { data: jobsForOvertime } = await db
      .from("jobs").select("assigned_technician_id, scheduled_datetime, duration_minutes, job_status")
      .eq("user_id", userId).eq("job_status", "completed").not("assigned_technician_id", "is", null)
      .not("scheduled_datetime", "is", null).gte("scheduled_datetime", baselineStart.toISOString());
    const dayLoad: Record<string, number> = {};
    for (const j of jobsForOvertime ?? []) {
      const day = (j.scheduled_datetime as string).slice(0, 10);
      const key = `${j.assigned_technician_id}:${day}`;
      dayLoad[key] = (dayLoad[key] ?? 0) + (j.duration_minutes ?? 60);
    }
    let otRecent = 0, otBaseline = 0, otRecentDays = 0, otBaselineDays = 0;
    for (const [key, minutes] of Object.entries(dayLoad)) {
      const day = key.split(":")[1];
      const overMinutes = Math.max(0, minutes - 480); // 8h/day threshold
      const iso = `${day}T00:00:00.000Z`;
      if (inRecent(iso)) { otRecent += overMinutes; otRecentDays++; }
      else if (inBaseline(iso)) { otBaseline += overMinutes; otBaselineDays++; }
    }
    const overtimeMetric = buildMetric(
      "overtime_load",
      otRecentDays ? otRecent / otRecentDays : 0,
      otBaselineDays ? otBaseline / otBaselineDays : 0,
      "avg overtime minutes/technician-day", 0, otBaselineDays,
    );

    // -------------------------------------------------------------
    // 4) evidence_quality — avg evidence_completeness (0-100)
    // -------------------------------------------------------------
    const evidence = (evidenceRes.data ?? []).filter((e) => e.evidence_completeness != null);
    const recentEvidence = evidence.filter((e) => inRecent(e.created_at));
    const baselineEvidence = evidence.filter((e) => inBaseline(e.created_at));
    const avgCompleteness = (arr: typeof evidence) => arr.length ? arr.reduce((s, e) => s + (e.evidence_completeness ?? 0), 0) / arr.length : 0;
    const evidenceMetric = buildMetric(
      "evidence_quality",
      avgCompleteness(recentEvidence), avgCompleteness(baselineEvidence),
      "avg completeness score", 0, baselineEvidence.length,
    );

    // -------------------------------------------------------------
    // 5) callback_rate — callbacks per 100 completed jobs
    // -------------------------------------------------------------
    const completedJobs = profitJobsRes.data ?? [];
    const recentCompleted = completedJobs.filter((j) => inRecent(j.created_at)).length;
    const baselineCompleted = completedJobs.filter((j) => inBaseline(j.created_at)).length;
    const callbacks = callbacksRes.data ?? [];
    const recentCallbacks = callbacks.filter((c) => inRecent(c.created_at)).length;
    const baselineCallbacks = callbacks.filter((c) => inBaseline(c.created_at)).length;
    const per100 = (count: number, total: number) => total > 0 ? (count / total) * 100 : 0;
    const callbackMetric = buildMetric(
      "callback_rate",
      per100(recentCallbacks, recentCompleted), per100(baselineCallbacks, baselineCompleted),
      "callbacks per 100 jobs", 0, baselineCompleted,
    );

    // -------------------------------------------------------------
    // 6) low_margin_mix — % of completed-job revenue below margin floor
    // -------------------------------------------------------------
    const jobIds = completedJobs.map((j) => j.id);
    const { data: profitRows } = jobIds.length
      ? await db.from("job_profitability").select("job_id, margin_pct, revenue_cents").in("job_id", jobIds)
      : { data: [] as { job_id: string; margin_pct: number | null; revenue_cents: number | null }[] };
    const profitById = new Map((profitRows ?? []).map((p) => [p.job_id, p]));
    const lowMarginShare = (jobList: typeof completedJobs) => {
      let total = 0, low = 0;
      for (const j of jobList) {
        const p = profitById.get(j.id);
        if (!p || p.revenue_cents == null || p.margin_pct == null) continue;
        total += p.revenue_cents;
        if (p.margin_pct < marginFloor) low += p.revenue_cents;
      }
      return total > 0 ? (low / total) * 100 : 0;
    };
    const lowMarginMetric = buildMetric(
      "low_margin_mix",
      lowMarginShare(completedJobs.filter((j) => inRecent(j.created_at))),
      lowMarginShare(completedJobs.filter((j) => inBaseline(j.created_at))),
      "% of revenue below margin floor", 0, baselineCompleted,
    );

    // -------------------------------------------------------------
    // 7) dispatcher_overrides — reassignments of an already-assigned
    //    job, per 100 completed jobs (proxy for "manual override";
    //    auto-assign normally only fills unassigned jobs)
    // -------------------------------------------------------------
    const assignments = assignmentsRes.data ?? [];
    const overrides = assignments.filter((a) => a.previous_technician_id != null);
    const recentOverrides = overrides.filter((a) => inRecent(a.assigned_at)).length;
    const baselineOverrides = overrides.filter((a) => inBaseline(a.assigned_at)).length;
    const overridesMetric = buildMetric(
      "dispatcher_overrides",
      per100(recentOverrides, recentCompleted), per100(baselineOverrides, baselineCompleted),
      "overrides per 100 jobs", 0, baselineCompleted,
    );

    const allMetrics: DriftMetric[] = [
      discountMetric, durationMetric, overtimeMetric, evidenceMetric,
      callbackMetric, lowMarginMetric, overridesMetric,
    ];

    const flagged = allMetrics.filter((m) => m.flagged);
    const evaluable = allMetrics.filter((m) => m.sample_ok);
    const driftScore = evaluable.length > 0 ? Math.round((flagged.length / evaluable.length) * 100) : 0;

    // -------------------------------------------------------------
    // AI narrative — only over the flagged metrics.
    // -------------------------------------------------------------
    const insights = await narrateBusinessDrift(
      flagged.map((m): DriftMetricInput => ({ metric: m.metric, recent: m.recent, baseline: m.baseline, pct_change: m.pct_change, unit: m.unit })),
    );

    const metricsObj: Record<string, unknown> = {};
    for (const m of allMetrics) metricsObj[m.metric] = m;

    const { data: saved, error: insertError } = await db.from("business_drift_snapshots").insert({
      user_id: userId,
      period_start: periodStart.toISOString().slice(0, 10),
      period_end: now.toISOString().slice(0, 10),
      baseline_start: baselineStart.toISOString().slice(0, 10),
      baseline_end: baselineEnd.toISOString().slice(0, 10),
      metrics: metricsObj,
      flagged_count: flagged.length,
      drift_score: driftScore,
      insights,
    }).select("*").single();

    if (insertError) throw insertError;

    return new Response(JSON.stringify({ snapshot: saved }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
