import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { askVireekAi } from "../_shared/ai-core/index.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const MS_DAY = 86400000;
const MS_WEEK = 7 * MS_DAY;
const WORKDAYS_PER_WEEK = 5;
const TRAILING_WEEKS = 8;

interface Technician {
  id: string;
  member_name: string | null;
  skills: string[];
}

interface SkillGap {
  skill: string;
  weekly_demand: number;
  weekly_supply: number;
  gap: number;
  status: "shortage" | "balanced" | "surplus";
}

interface WorkforceAction {
  action_type: "cross_train" | "hire" | "reallocate_marketing";
  title: string;
  detail: string;
  ref_table: "team_members" | null;
  ref_id: string | null;
  impact_jobs_per_week: number;
  priority: number;
}

function round1(n: number) { return Math.round(n * 10) / 10; }

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

    let horizonWeeks = 4;
    try {
      const body = await req.json();
      if (body?.horizon_weeks && Number.isFinite(body.horizon_weeks)) {
        horizonWeeks = Math.min(12, Math.max(1, Math.round(body.horizon_weeks)));
      }
    } catch { /* no body / not JSON — use default */ }

    const { data: technicians } = await db
      .from("team_members")
      .select("id, member_name, skills, max_jobs_per_day")
      .eq("account_owner_id", userId)
      .eq("role", "technician")
      .eq("dispatch_enabled", true);

    const techs = (technicians ?? []) as (Technician & { max_jobs_per_day: number })[];
    if (techs.length === 0) {
      return new Response(
        JSON.stringify({ error: "No dispatch-enabled technicians yet. Add your team first." }),
        { status: 409, headers: jsonHeaders },
      );
    }

    const now = new Date();
    const trailingStart = new Date(now.getTime() - TRAILING_WEEKS * MS_WEEK).toISOString();
    const horizonEnd = new Date(now.getTime() + horizonWeeks * MS_WEEK).toISOString();

    const [{ data: trailingJobs }, { data: bookedJobs }] = await Promise.all([
      db.from("jobs").select("service_type").eq("user_id", userId).eq("job_status", "completed")
        .gte("scheduled_datetime", trailingStart).not("service_type", "is", null),
      db.from("jobs").select("service_type").eq("user_id", userId)
        .in("job_status", ["scheduled", "en_route", "in_progress"])
        .gte("scheduled_datetime", now.toISOString()).lte("scheduled_datetime", horizonEnd)
        .not("service_type", "is", null),
    ]);

    const trailingCounts: Record<string, number> = {};
    for (const j of (trailingJobs ?? []) as { service_type: string }[]) {
      trailingCounts[j.service_type] = (trailingCounts[j.service_type] ?? 0) + 1;
    }
    const bookedCounts: Record<string, number> = {};
    for (const j of (bookedJobs ?? []) as { service_type: string }[]) {
      bookedCounts[j.service_type] = (bookedCounts[j.service_type] ?? 0) + 1;
    }

    const skills = Array.from(new Set(techs.flatMap((t) => t.skills ?? []))).filter(Boolean);

    const skillGaps: SkillGap[] = skills.map((skill) => {
      const trailingWeekly = (trailingCounts[skill] ?? 0) / TRAILING_WEEKS;
      const bookedTotal = bookedCounts[skill] ?? 0;
      const bookedWeekly = bookedTotal / horizonWeeks;
      const weeklyDemand = bookedTotal > 0 ? trailingWeekly * 0.4 + bookedWeekly * 0.6 : trailingWeekly;
      const weeklySupply = techs
        .filter((t) => (t.skills ?? []).includes(skill))
        .reduce((sum, t) => sum + (t.max_jobs_per_day ?? 0) * WORKDAYS_PER_WEEK, 0);
      const gap = round1(weeklySupply - weeklyDemand);
      const status: SkillGap["status"] =
        weeklyDemand > weeklySupply * 1.1 ? "shortage" : weeklyDemand < weeklySupply * 0.6 ? "surplus" : "balanced";
      return { skill, weekly_demand: round1(weeklyDemand), weekly_supply: round1(weeklySupply), gap, status };
    }).sort((a, b) => a.gap - b.gap);

    const actions: WorkforceAction[] = [];

    for (const g of skillGaps.filter((s) => s.status === "shortage").slice(0, 3)) {
      const shortfall = round1(g.weekly_demand - g.weekly_supply);
      const candidate = techs
        .filter((t) => !(t.skills ?? []).includes(g.skill))
        .sort((a, b) => (a.skills?.length ?? 0) - (b.skills?.length ?? 0))[0];
      if (candidate) {
        actions.push({
          action_type: "cross_train",
          title: `Cross-train ${candidate.member_name ?? "a technician"} into ${g.skill}`,
          detail: `${g.skill} demand is running ~${shortfall} job${shortfall === 1 ? "" : "s"}/week above current capacity. ${candidate.member_name ?? "This technician"} has the most open bandwidth to pick it up.`,
          ref_table: "team_members",
          ref_id: candidate.id,
          impact_jobs_per_week: shortfall,
          priority: 0,
        });
      } else {
        actions.push({
          action_type: "hire",
          title: `Hire for ${g.skill}`,
          detail: `${g.skill} demand is running ~${shortfall} job${shortfall === 1 ? "" : "s"}/week above what the current team can cover, with no one else to cross-train.`,
          ref_table: null,
          ref_id: null,
          impact_jobs_per_week: shortfall,
          priority: 0,
        });
      }
    }

    for (const g of skillGaps.filter((s) => s.status === "surplus").slice(0, 3)) {
      actions.push({
        action_type: "reallocate_marketing",
        title: `Shift demand generation toward tighter skills, away from ${g.skill}`,
        detail: `${g.skill} has about ${g.gap} job${g.gap === 1 ? "" : "s"}/week of spare capacity. Redirect ads/follow-ups here toward the shortage skills above instead.`,
        ref_table: null,
        ref_id: null,
        impact_jobs_per_week: g.gap,
        priority: 0,
      });
    }

    actions.sort((a, b) => b.impact_jobs_per_week - a.impact_jobs_per_week);
    actions.forEach((a, i) => { a.priority = i + 1; });

    let aiSummary = "";
    try {
      const result = await askVireekAi({
        task: "workforce_equilibrium_narrative",
        jsonMode: false,
        maxTokens: 220,
        temperature: 0.3,
        messages: [
          {
            role: "user",
            content: `Per-skill weekly technician supply vs demand, already computed (jobs/week):\n${JSON.stringify(skillGaps)}\nRanked recommended actions, already computed:\n${JSON.stringify(actions.map((a) => ({ title: a.title, impact_jobs_per_week: a.impact_jobs_per_week })))}`,
          },
        ],
      });
      aiSummary = result.text.slice(0, 600);
    } catch {
      const worst = skillGaps.find((s) => s.status === "shortage");
      aiSummary = worst
        ? `${worst.skill} is the tightest skill right now, running short by about ${Math.abs(worst.gap)} job(s)/week. Work the actions below in order to close the gap before it costs you bookings.`
        : "Supply and demand look balanced across your team's skills right now. Re-run this after busy weeks to catch drift early.";
    }

    const { data: run, error: insertError } = await db.from("workforce_equilibrium_runs").insert({
      user_id: userId,
      horizon_weeks: horizonWeeks,
      skill_gaps: skillGaps,
      actions,
      ai_summary: aiSummary,
    }).select("*").single();
    if (insertError) throw insertError;

    return new Response(JSON.stringify({ run }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
