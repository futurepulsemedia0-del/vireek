import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { rankOpportunityCosts, type OpportunityCostCandidate } from "../_shared/ai-core/opportunityCostRanking.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

interface LineItem { description?: string; quantity?: number; unit_price_cents?: number; }
function quoteTotalCents(lineItems: LineItem[] | null | undefined): number {
  if (!Array.isArray(lineItems)) return 0;
  return lineItems.reduce((sum, li) => sum + (Number(li.quantity ?? 0) * Number(li.unit_price_cents ?? 0)), 0);
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
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000).toISOString();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 86400000).toISOString();
    const today = now.toISOString().slice(0, 10);

    const newRows: Record<string, unknown>[] = [];

    // ===================================================================
    // Detector 1: technician_low_margin_time
    // ===================================================================
    const { data: recentJobs } = await db
      .from("jobs")
      .select("id, customer_name, service_type, duration_minutes, assigned_technician_id, job_status, created_at")
      .eq("user_id", userId)
      .eq("job_status", "completed")
      .not("assigned_technician_id", "is", null)
      .gte("created_at", fourteenDaysAgo);

    const jobIds = (recentJobs ?? []).map((j) => j.id);
    const { data: profitRows } = jobIds.length
      ? await db.from("job_profitability").select("job_id, margin_pct").in("job_id", jobIds)
      : { data: [] as { job_id: string; margin_pct: number | null }[] };
    const marginByJob = new Map((profitRows ?? []).map((p) => [p.job_id, p.margin_pct]));

    const { data: teamRows } = await db.from("team_members").select("id, member_name").eq("account_owner_id", userId);
    const techName = new Map((teamRows ?? []).map((t) => [t.id, t.member_name ?? "This technician"]));

    // Baseline margin + revenue-per-hour per technician, from their own jobs only.
    const byTech = new Map<string, { id: string; margin: number; minutes: number }[]>();
    for (const j of recentJobs ?? []) {
      const margin = marginByJob.get(j.id);
      if (margin == null || !j.assigned_technician_id) continue;
      const list = byTech.get(j.assigned_technician_id) ?? [];
      list.push({ id: j.id, margin, minutes: j.duration_minutes ?? 60 });
      byTech.set(j.assigned_technician_id, list);
    }

    for (const [techId, techJobs] of byTech.entries()) {
      if (techJobs.length < 3) continue; // not enough of this tech's own history to call anything "low"
      const avgMargin = techJobs.reduce((s, j) => s + j.margin, 0) / techJobs.length;
      for (const job of techJobs) {
        if (job.margin >= avgMargin - 15 || job.minutes < 60) continue; // "low" = 15pt below their own average
        const higherMarginJobs = techJobs.filter((j) => j.id !== job.id && j.margin >= avgMargin);
        const avgHigherMinutes = higherMarginJobs.length
          ? higherMarginJobs.reduce((s, j) => s + j.minutes, 0) / higherMarginJobs.length
          : job.minutes;
        const foregoneCalls = Math.max(1, Math.round(job.minutes / Math.max(avgHigherMinutes, 30)));
        const marginGapPct = Math.round(avgMargin - job.margin);
        const hours = Math.round((job.minutes / 60) * 10) / 10;
        const jobRow = (recentJobs ?? []).find((j) => j.id === job.id);
        const estimatedCostCents = Math.round((marginGapPct / 100) * (job.minutes / 60) * 15000); // 15000 = a conservative $150/hr revenue-rate proxy

        newRows.push({
          user_id: userId,
          entry_type: "technician_low_margin_time",
          source_table: "jobs",
          source_id: job.id,
          occurred_on: today,
          estimated_cost_cents: Math.max(0, estimatedCostCents),
          detail: { hours_spent: hours, job_margin_pct: job.margin, tech_avg_margin_pct: Math.round(avgMargin), foregone_calls: foregoneCalls },
          headline: `${techName.get(techId) ?? "This technician"} spent ${hours}h on a low-margin job (${jobRow?.service_type ?? "service call"}, ${Math.round(job.margin)}% margin vs their own ${Math.round(avgMargin)}% average) — that time could have covered roughly ${foregoneCalls} higher-margin call(s).`,
        });
      }
    }

    // ===================================================================
    // Detector 2: quote_stalled_followup
    // ===================================================================
    const { data: conversionRows } = await db
      .from("quotes").select("status").eq("user_id", userId)
      .in("status", ["accepted", "declined"]).gte("created_at", ninetyDaysAgo);
    const accepted = (conversionRows ?? []).filter((q) => q.status === "accepted").length;
    const conversionRate = (conversionRows ?? []).length > 0 ? accepted / (conversionRows ?? []).length : 0.3; // 30% fallback until there's enough history

    const seventyTwoHoursAgo = new Date(now.getTime() - 72 * 3600000).toISOString();
    const { data: stalledQuotes } = await db
      .from("quotes")
      .select("id, customer_name, line_items, sent_at")
      .eq("user_id", userId).eq("status", "sent")
      .lte("sent_at", seventyTwoHoursAgo);

    for (const q of stalledQuotes ?? []) {
      const totalCents = quoteTotalCents(q.line_items);
      if (totalCents <= 0) continue;
      const daysStalled = Math.floor((now.getTime() - new Date(q.sent_at).getTime()) / 86400000);
      const expectedValueCents = Math.round(totalCents * conversionRate);
      newRows.push({
        user_id: userId,
        entry_type: "quote_stalled_followup",
        source_table: "quotes",
        source_id: q.id,
        occurred_on: today,
        estimated_cost_cents: expectedValueCents,
        detail: { days_stalled: daysStalled, quote_value_cents: totalCents, conversion_rate_pct: Math.round(conversionRate * 100) },
        headline: `Quote for ${q.customer_name} ($${(totalCents / 100).toLocaleString()}) has sat ${daysStalled} day(s) without follow-up since it was sent — at your ${Math.round(conversionRate * 100)}% typical close rate that's roughly $${(expectedValueCents / 100).toLocaleString()} in expected value at risk.`,
      });
    }

    // ===================================================================
    // Detector 3: idle_capacity
    // ===================================================================
    const { data: completedJobs60 } = await db
      .from("jobs").select("invoice_amount").eq("user_id", userId).eq("job_status", "completed")
      .gte("created_at", new Date(now.getTime() - 60 * 86400000).toISOString());
    const valuedJobs = (completedJobs60 ?? []).filter((j) => j.invoice_amount);
    const avgJobValueCents = valuedJobs.length
      ? Math.round((valuedJobs.reduce((s, j) => s + (j.invoice_amount ?? 0), 0) / valuedJobs.length) * 100)
      : 0;

    const { data: lowCapacityDays } = await db
      .from("capacity_demand_events")
      .select("id, event_date, day_load, day_capacity")
      .eq("user_id", userId).eq("status", "low")
      .gte("event_date", fourteenDaysAgo.slice(0, 10));

    for (const d of lowCapacityDays ?? []) {
      const idleSlots = Math.max(0, d.day_capacity - d.day_load);
      if (idleSlots === 0 || avgJobValueCents === 0) continue;
      const costCents = idleSlots * avgJobValueCents;
      newRows.push({
        user_id: userId,
        entry_type: "idle_capacity",
        source_table: "capacity_demand_events",
        source_id: d.id,
        occurred_on: d.event_date,
        estimated_cost_cents: costCents,
        detail: { idle_slots: idleSlots, avg_job_value_cents: avgJobValueCents },
        headline: `On ${d.event_date} capacity was under-booked by ${idleSlots} slot(s) — at your average job value that's roughly $${(costCents / 100).toLocaleString()} in reachable revenue left on the table.`,
      });
    }

    // ===================================================================
    // Write (idempotent — unique constraint skips ones already logged today)
    // ===================================================================
    let inserted = 0;
    if (newRows.length > 0) {
      const { data: insertedRows } = await db
        .from("opportunity_cost_entries")
        .upsert(newRows, { onConflict: "entry_type,source_table,source_id,occurred_on", ignoreDuplicates: true })
        .select("id");
      inserted = insertedRows?.length ?? 0;
    }

    // ===================================================================
    // AI ranking pass — only over OPEN entries that don't have a score yet.
    // ===================================================================
    const { data: unranked } = await db
      .from("opportunity_cost_entries")
      .select("id, entry_type, headline, estimated_cost_cents, detail")
      .eq("user_id", userId).eq("status", "open").is("priority_score", null)
      .order("estimated_cost_cents", { ascending: false }).limit(20);

    let ranked = 0;
    if (unranked && unranked.length > 0) {
      const candidates: OpportunityCostCandidate[] = unranked.map((e) => ({
        id: e.id, entry_type: e.entry_type, headline: e.headline,
        estimated_cost_cents: e.estimated_cost_cents, detail: e.detail,
      }));
      const results = await rankOpportunityCosts(candidates);
      for (const r of results) {
        await db.from("opportunity_cost_entries").update({
          ai_narrative: r.narrative,
          ai_recommended_action: r.recommended_action,
          priority_score: r.priority_score,
        }).eq("id", r.entry_id).eq("user_id", userId);
        ranked++;
      }
    }

    return new Response(JSON.stringify({ inserted, ranked }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
