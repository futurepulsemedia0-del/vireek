import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface InsightRow {
  insight_type: "pattern" | "suggestion" | "alert";
  title: string;
  description: string;
}

interface CallRow {
  is_emergency: boolean | null;
  status: string | null;
  call_datetime: string;
  caller_name: string | null;
}

interface LeadRow {
  stage: string;
}

interface JobRow {
  job_status: string | null;
  invoice_status: string | null;
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

    // Fetch recent data: last 30 days of calls, leads, jobs, and profile
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

    const insights: InsightRow[] = [];

    // -------------------------------------------------------
    // 1. Emergency call spike on a specific day of week
    // -------------------------------------------------------
    if (calls.length >= 10) {
      const emergencyCalls = calls.filter((c) => c.is_emergency);
      if (emergencyCalls.length >= 3) {
        const dayCount: Record<string, number> = {};
        emergencyCalls.forEach((c) => {
          const day = new Date(c.call_datetime).toLocaleDateString("en-US", { weekday: "long" });
          dayCount[day] = (dayCount[day] ?? 0) + 1;
        });
        const peakDay = Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0];
        if (peakDay && peakDay[1] >= 2) {
          const totalEmergencies = emergencyCalls.length;
          const pct = Math.round((peakDay[1] / totalEmergencies) * 100);
          insights.push({
            insight_type: "pattern",
            title: `Emergency calls spike on ${peakDay[0]}s`,
            description: `${pct}% of your recent emergency calls fall on ${peakDay[0]}s (${peakDay[1]} of ${totalEmergencies}). Consider adding extra technician coverage or adjusting your on-call schedule for that day.`,
          });
        }
      }
    }

    // -------------------------------------------------------
    // 2. High missed-call rate for a specific service type
    // -------------------------------------------------------
    if (calls.length >= 8) {
      const missedCalls = calls.filter((c) => c.status === "missed");
      if (missedCalls.length >= 2) {
        const overallMissedRate = missedCalls.length / calls.length;
        // Group by caller_name or summary keywords as a proxy for service type
        const serviceMissed: Record<string, { total: number; missed: number }> = {};
        calls.forEach((c) => {
          const key = c.caller_name ?? "Unknown";
          if (!serviceMissed[key]) serviceMissed[key] = { total: 0, missed: 0 };
          serviceMissed[key].total++;
          if (c.status === "missed") serviceMissed[key].missed++;
        });
        // Find callers with high missed rate (at least 2 calls, >50% missed)
        const highMissCallers = Object.entries(serviceMissed)
          .filter(([, v]) => v.total >= 2 && v.missed / v.total > 0.5)
          .sort((a, b) => b[1].missed - a[1].missed);
        if (highMissCallers.length > 0) {
          const top = highMissCallers[0];
          const rate = Math.round((top[1].missed / top[1].total) * 100);
          insights.push({
            insight_type: "alert",
            title: `High missed-call rate from ${top[0]}`,
            description: `${rate}% of calls from ${top[0]} were missed (${top[1].missed} of ${top[1].total}). This caller may need a follow-up — consider scheduling a callback or adjusting your availability.`,
          });
        } else if (overallMissedRate > 0.2) {
          const pct = Math.round(overallMissedRate * 100);
          insights.push({
            insight_type: "alert",
            title: `Overall missed-call rate is ${pct}%`,
            description: `You're missing ${pct}% of incoming calls. Each missed call is a potential lost customer. Consider extending your business hours or enabling after-hours forwarding.`,
          });
        }
      }
    }

    // -------------------------------------------------------
    // 3. Lead pipeline stalling at a specific stage
    // -------------------------------------------------------
    if (leads.length >= 5) {
      const stageCounts: Record<string, number> = {};
      leads.forEach((l) => {
        stageCounts[l.stage] = (stageCounts[l.stage] ?? 0) + 1;
      });
      const stages = ["new", "contacted", "quoted", "won", "lost"];
      // Find the stage with the most leads stuck (excluding won/lost)
      const activeStages = stages.filter((s) => s !== "won" && s !== "lost");
      const stuckStage = activeStages
        .map((s) => ({ stage: s, count: stageCounts[s] ?? 0 }))
        .sort((a, b) => b.count - a.count)[0];
      if (stuckStage && stuckStage.count >= 3) {
        const pct = Math.round((stuckStage.count / leads.length) * 100);
        insights.push({
          insight_type: "suggestion",
          title: `Leads stalling at "${stuckStage.stage}" stage`,
          description: `${stuckStage.count} leads (${pct}% of your pipeline) are stuck in the "${stuckStage.stage}" stage. Consider following up with these leads or reviewing your quoting process to move them forward.`,
        });
      }
    }

    // -------------------------------------------------------
    // 4. Minutes usage trending toward plan limit
    // -------------------------------------------------------
    if (profile && profile.minutes_used_this_month !== null && profile.minutes_included !== null) {
      const used = profile.minutes_used_this_month;
      const included = profile.minutes_included;
      const pct = included > 0 ? (used / included) * 100 : 0;
      if (pct >= 75) {
        const remaining = Math.max(0, included - used);
        insights.push({
          insight_type: pct >= 90 ? "alert" : "suggestion",
          title: pct >= 90 ? "Minutes usage near plan limit" : "Minutes usage trending high",
          description: `You've used ${used} of ${included} included minutes (${Math.round(pct)}%). ${remaining} minutes remaining this month. ${pct >= 90 ? "Consider upgrading your plan to avoid interruptions." : "Monitor your usage to avoid hitting the limit."}`,
        });
      }
    }

    // -------------------------------------------------------
    // 5. Jobs completed but invoices not sent
    // -------------------------------------------------------
    if (jobs.length >= 3) {
      const completedNoInvoice = jobs.filter(
        (j) => j.job_status === "completed" && j.invoice_status === "not_sent",
      );
      if (completedNoInvoice.length >= 2) {
        insights.push({
          insight_type: "suggestion",
          title: `${completedNoInvoice.length} completed jobs without invoices`,
          description: `You have ${completedNoInvoice.length} completed jobs with invoices not yet sent. Send these invoices to collect payment sooner — each one represents outstanding revenue.`,
        });
      }
    }

    // -------------------------------------------------------
    // Deduplicate: check if identical insights already exist
    // -------------------------------------------------------
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

    // -------------------------------------------------------
    // Insert new insights (cap at 4 to stay sparse)
    // -------------------------------------------------------
    const toInsert = newInsights.slice(0, 4);
    let generated = 0;
    if (toInsert.length > 0) {
      const rows = toInsert.map((i) => ({ ...i, user_id }));
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
