import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { extractShockScenario, analyzeCausalCascade, type ShockType } from "../_shared/ai-core/causalShockAnalysis.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

interface JobRow {
  id: string;
  customer_name: string;
  service_type: string | null;
  scheduled_datetime: string | null;
  assigned_technician_id: string | null;
  job_status: string | null;
  invoice_amount: number | null;
  invoice_status: string | null;
}
interface TeamMemberRow { id: string; member_name: string | null; role: string; }
interface CustomerRow { name: string; lifecycle_stage: string; }

function severityFromImpact(impact: Record<string, any>): "low" | "moderate" | "high" | "severe" {
  const revenueRisk = Number(impact?.cash?.revenue_at_risk_usd ?? 0);
  const jobsAffected = Number(impact?.jobs?.jobs_affected ?? 0);
  const capacityLossPct = Number(impact?.crew?.capacity_loss_pct ?? 0);
  const score = (revenueRisk >= 5000 ? 2 : revenueRisk >= 1500 ? 1 : 0)
    + (jobsAffected >= 8 ? 2 : jobsAffected >= 3 ? 1 : 0)
    + (capacityLossPct >= 50 ? 2 : capacityLossPct >= 25 ? 1 : 0);
  if (score >= 5) return "severe";
  if (score >= 3) return "high";
  if (score >= 1) return "moderate";
  return "low";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const { question } = await req.json().catch(() => ({ question: "" }));
    if (!question || typeof question !== "string" || !question.trim()) {
      return new Response(JSON.stringify({ error: "A question is required." }), { status: 400, headers: jsonHeaders });
    }

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

    // -----------------------------------------------------------------
    // Step 1: turn the free-text question into structured shock params.
    // -----------------------------------------------------------------
    const extraction = await extractShockScenario(question);
    const shockType: ShockType = extraction.shock_type;

    // -----------------------------------------------------------------
    // Step 2: deterministic compute — real account data ONLY.
    // -----------------------------------------------------------------
    const now = new Date();
    const windowHours = extraction.duration_hours ?? (shockType === "payment_outage" ? 3 : shockType === "supply_shortage" ? 72 : 24);
    const windowEnd = new Date(now.getTime() + windowHours * 3600000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000).toISOString();
    const sevenDaysAhead = new Date(now.getTime() + 7 * 86400000).toISOString();

    const [jobsWindowRes, jobsUpcomingRes, teamRes, jobs60Res, customersRes] = await Promise.all([
      db.from("jobs").select("id, customer_name, service_type, scheduled_datetime, assigned_technician_id, job_status, invoice_amount, invoice_status")
        .eq("user_id", userId).in("job_status", ["scheduled", "in_progress"])
        .gte("scheduled_datetime", now.toISOString()).lte("scheduled_datetime", windowEnd.toISOString()),
      db.from("jobs").select("assigned_technician_id")
        .eq("user_id", userId).in("job_status", ["scheduled", "in_progress"])
        .gte("scheduled_datetime", now.toISOString()).lte("scheduled_datetime", sevenDaysAhead),
      db.from("team_members").select("id, member_name, role").eq("account_owner_id", userId),
      db.from("jobs").select("invoice_amount, job_status").eq("user_id", userId).gte("created_at", sixtyDaysAgo),
      db.from("customers").select("name, lifecycle_stage").eq("user_id", userId),
    ]);

    const jobsInWindow = (jobsWindowRes.data ?? []) as JobRow[];
    const upcomingAssignments = (jobsUpcomingRes.data ?? []) as { assigned_technician_id: string | null }[];
    const team = (teamRes.data ?? []) as TeamMemberRow[];
    const jobs60 = (jobs60Res.data ?? []) as { invoice_amount: number | null; job_status: string | null }[];
    const customers = (customersRes.data ?? []) as CustomerRow[];
    const vipNames = new Set(customers.filter((c) => c.lifecycle_stage === "vip").map((c) => c.name));

    const completedRecent = jobs60.filter((j) => j.job_status === "completed" && j.invoice_amount);
    const avgJobValue = completedRecent.length > 0
      ? completedRecent.reduce((s, j) => s + (j.invoice_amount ?? 0), 0) / completedRecent.length
      : 0;
    const revenue30d = jobs60
      .filter((j) => j.job_status === "completed")
      .reduce((s, j) => s + (j.invoice_amount ?? 0), 0) / 2; // 60d window halved as a 30d proxy

    const activeTechnicianIds = new Set(
      upcomingAssignments.map((j) => j.assigned_technician_id).filter((id): id is string => !!id),
    );
    const activeTechnicianCount = Math.max(activeTechnicianIds.size, team.length, 1);

    let jobsAffected: JobRow[] = [];
    let capacityLossPct = 0;
    let revenueAtRiskUsd = 0;

    if (shockType === "technician_unavailable") {
      const sickCount = Math.max(1, Math.min(extraction.technician_count ?? 1, activeTechnicianCount));
      capacityLossPct = Math.round((sickCount / activeTechnicianCount) * 100);
      const affectedCount = Math.round(jobsInWindow.length * (sickCount / activeTechnicianCount));
      jobsAffected = jobsInWindow.slice(0, affectedCount);
      revenueAtRiskUsd = jobsAffected.reduce((s, j) => s + (j.invoice_amount ?? avgJobValue), 0);
    } else if (shockType === "payment_outage") {
      // Every job scheduled to invoice/collect in the outage window is at risk of a failed charge.
      jobsAffected = jobsInWindow.filter((j) => j.invoice_status !== "paid");
      revenueAtRiskUsd = jobsAffected.reduce((s, j) => s + (j.invoice_amount ?? avgJobValue), 0);
    } else if (shockType === "demand_surge") {
      const multiplier = Math.max(1, extraction.surge_multiplier ?? 2);
      const relevant = extraction.affected_service_type
        ? jobsInWindow.filter((j) => (j.service_type ?? "").toLowerCase().includes(extraction.affected_service_type!.toLowerCase()))
        : jobsInWindow;
      const extraDemand = Math.round(relevant.length * (multiplier - 1));
      jobsAffected = relevant; // existing load that now competes with the surge for the same crew
      capacityLossPct = Math.min(100, Math.round((extraDemand / Math.max(activeTechnicianCount, 1)) * 20));
      revenueAtRiskUsd = extraDemand * avgJobValue; // upside if capacity holds, at-risk if it doesn't
    } else if (shockType === "supply_shortage") {
      jobsAffected = jobsInWindow.filter((j) =>
        !extraction.affected_service_type || (j.service_type ?? "").toLowerCase().includes(extraction.affected_service_type!.toLowerCase())
      );
      revenueAtRiskUsd = jobsAffected.reduce((s, j) => s + (j.invoice_amount ?? avgJobValue), 0);
    } else {
      jobsAffected = jobsInWindow;
      revenueAtRiskUsd = jobsAffected.reduce((s, j) => s + (j.invoice_amount ?? avgJobValue), 0) * 0.3;
    }

    const vipJobsAffected = jobsAffected.filter((j) => vipNames.has(j.customer_name)).length;

    const impact = {
      customer: {
        jobs_at_risk: jobsAffected.length,
        vip_customers_at_risk: vipJobsAffected,
      },
      sla: {
        jobs_likely_delayed: jobsAffected.length,
        avg_delay_hours: shockType === "technician_unavailable" || shockType === "supply_shortage" ? windowHours : Math.round(windowHours / 2),
      },
      cash: {
        revenue_at_risk_usd: Math.round(revenueAtRiskUsd * 100) / 100,
        revenue_at_risk_pct_of_30d: revenue30d > 0 ? Math.round((revenueAtRiskUsd / revenue30d) * 1000) / 10 : null,
      },
      jobs: {
        jobs_in_window: jobsInWindow.length,
        jobs_affected: jobsAffected.length,
        window_hours: windowHours,
      },
      crew: {
        active_technicians: activeTechnicianCount,
        technicians_unavailable: shockType === "technician_unavailable" ? (extraction.technician_count ?? 1) : 0,
        capacity_loss_pct: capacityLossPct,
      },
      reputation: {
        vip_jobs_affected: vipJobsAffected,
        total_customers_tracked: customers.length,
      },
    };

    const severity = severityFromImpact(impact);

    // -----------------------------------------------------------------
    // Step 3: AI turns the numbers above into an ordered causal chain.
    // -----------------------------------------------------------------
    const { cascade, response_plan, summary } = await analyzeCausalCascade(question, impact);

    const { data: saved, error: insertError } = await db.from("causal_shock_simulations").insert({
      user_id: userId,
      question: question.slice(0, 1000),
      shock_type: shockType,
      shock_params: extraction,
      impact,
      severity,
      cascade,
      response_plan,
      summary,
    }).select("*").single();

    if (insertError) throw insertError;

    return new Response(JSON.stringify({ simulation: saved }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
