import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { analyzeCashFlowForecast } from "../_shared/ai-core/cashFlowNarrative.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const WEEKS = 13;
const MS_DAY = 86400000;
const MS_WEEK = 7 * MS_DAY;

interface WeekBucket {
  week_index: number;
  week_start: string;
  week_end: string;
  committed_inflow: number;
  pipeline_inflow: number;
  fixed_outflow: number;
  variable_outflow: number;
  net_committed: number;
  projected_balance_committed: number;
  projected_balance_optimistic: number;
}

function round2(n: number) { return Math.round(n * 100) / 100; }

function weekIndexForDate(date: Date, horizonStart: Date): number | null {
  const diff = date.getTime() - horizonStart.getTime();
  if (diff < 0) return 0; // already due/overdue -> current week
  const idx = Math.floor(diff / MS_WEEK);
  return idx >= 0 && idx < WEEKS ? idx : null;
}

/** Best-effort dollar total from a quote's jsonb line_items — never throws,
 *  skips anything it can't confidently parse rather than guessing wrong. */
function sumQuoteLineItems(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    const qty = Number(it.quantity ?? 1) || 1;
    if (typeof it.total === "number") { total += it.total; continue; }
    if (typeof it.amount === "number") { total += it.amount; continue; }
    const unit = Number(it.unit_price ?? it.price ?? it.rate);
    if (Number.isFinite(unit)) total += unit * qty;
  }
  return total;
}

/** Every due date a fixed expense lands on within [horizonStart, horizonEnd]. */
function getDueDatesInHorizon(expense: { frequency: string; next_due_date: string }, horizonStart: Date, horizonEnd: Date): Date[] {
  const dates: Date[] = [];
  let cursor = new Date(expense.next_due_date + "T00:00:00Z");

  if (expense.frequency === "one_time") {
    if (cursor <= horizonEnd) dates.push(cursor < horizonStart ? horizonStart : cursor);
    return dates;
  }

  const stepDays = expense.frequency === "weekly" ? 7 : expense.frequency === "biweekly" ? 14 : null;
  let guard = 0;
  while (cursor <= horizonEnd && guard < 200) {
    guard++;
    if (cursor >= horizonStart) dates.push(new Date(cursor));
    if (stepDays) {
      cursor = new Date(cursor.getTime() + stepDays * MS_DAY);
    } else {
      // monthly
      const next = new Date(cursor);
      next.setUTCMonth(next.getUTCMonth() + 1);
      cursor = next;
    }
  }
  return dates;
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

    let { data: settings } = await db.from("cash_flow_settings").select("*").eq("user_id", userId).maybeSingle();
    if (!settings) {
      const { data: created } = await db.from("cash_flow_settings").insert({ user_id: userId }).select("*").single();
      settings = created;
    }

    const horizonStart = new Date();
    horizonStart.setUTCHours(0, 0, 0, 0);
    const horizonEnd = new Date(horizonStart.getTime() + WEEKS * MS_WEEK - MS_DAY);
    const ninetyDaysAgoIso = new Date(horizonStart.getTime() - 90 * MS_DAY).toISOString();

    const [
      { data: fixedExpenses },
      { data: openPayments },
      { data: completedJobs },
      { data: upcomingJobs },
      { data: activeMemberships },
      { data: openQuotes },
      profitabilityRes,
    ] = await Promise.all([
      db.from("cash_flow_fixed_expenses").select("*").eq("user_id", userId).eq("active", true),
      db.from("payment_requests").select("amount, status, job_id, created_at").eq("user_id", userId).in("status", ["pending", "sent", "overdue"]),
      db.from("jobs").select("id, invoice_amount, invoice_status, job_status, created_at").eq("user_id", userId).eq("job_status", "completed").neq("invoice_status", "paid").gte("created_at", ninetyDaysAgoIso),
      db.from("jobs").select("id, invoice_amount, scheduled_datetime, job_status").eq("user_id", userId).in("job_status", ["scheduled", "en_route"]).not("scheduled_datetime", "is", null).not("invoice_amount", "is", null).gte("scheduled_datetime", horizonStart.toISOString()).lte("scheduled_datetime", horizonEnd.toISOString()),
      db.from("memberships").select("plan_id, status, membership_plans(price_cents, billing_interval)").eq("user_id", userId).eq("status", "active"),
      db.from("quotes").select("line_items, valid_until, status").eq("user_id", userId).eq("status", "sent"),
      db.from("job_profitability").select("revenue_cents, total_cost_cents").eq("user_id", userId).eq("job_status", "completed").gte("scheduled_datetime", ninetyDaysAgoIso),
    ]);

    // Cost ratio: prefer real job_profitability data; degrade to the
    // account's configured default when the view is missing/empty/errors.
    let costRatio = Number(settings?.default_cost_ratio ?? 55) / 100;
    let costRatioSource: "actual" | "default" = "default";
    if (!profitabilityRes.error && profitabilityRes.data && profitabilityRes.data.length > 0) {
      const revSum = profitabilityRes.data.reduce((s: number, r: { revenue_cents: number }) => s + (r.revenue_cents ?? 0), 0);
      const costSum = profitabilityRes.data.reduce((s: number, r: { total_cost_cents: number }) => s + (r.total_cost_cents ?? 0), 0);
      if (revSum > 0) { costRatio = costSum / revSum; costRatioSource = "actual"; }
    }

    // Dedup: a completed job that already has a payment_request shouldn't
    // count its invoice_amount twice.
    const paymentJobIds = new Set((openPayments ?? []).map((p: { job_id: string | null }) => p.job_id).filter(Boolean));
    const unbilledCompletedJobs = (completedJobs ?? []).filter((j: { id: string }) => !paymentJobIds.has(j.id));

    const weeks: WeekBucket[] = Array.from({ length: WEEKS }, (_, i) => {
      const weekStart = new Date(horizonStart.getTime() + i * MS_WEEK);
      const weekEnd = new Date(weekStart.getTime() + 6 * MS_DAY);
      return {
        week_index: i,
        week_start: weekStart.toISOString().slice(0, 10),
        week_end: weekEnd.toISOString().slice(0, 10),
        committed_inflow: 0,
        pipeline_inflow: 0,
        fixed_outflow: 0,
        variable_outflow: 0,
        net_committed: 0,
        projected_balance_committed: 0,
        projected_balance_optimistic: 0,
      };
    });

    // Open/overdue payment requests — assume net-7 terms from creation;
    // anything past due lands in the current week (index 0).
    for (const p of (openPayments ?? []) as { amount: number; status: string; created_at: string }[]) {
      const idx = p.status === "overdue" ? 0 : weekIndexForDate(new Date(new Date(p.created_at).getTime() + 7 * MS_DAY), horizonStart);
      if (idx !== null) weeks[idx].committed_inflow += Number(p.amount ?? 0);
    }

    // Completed work with no payment request yet — already earned, treat
    // as due now.
    for (const j of unbilledCompletedJobs as { invoice_amount: number | null }[]) {
      weeks[0].committed_inflow += Number(j.invoice_amount ?? 0);
    }

    // Booked future work — 90% completion probability (cancellations/reschedules happen).
    for (const j of (upcomingJobs ?? []) as { invoice_amount: number | null; scheduled_datetime: string }[]) {
      const idx = weekIndexForDate(new Date(j.scheduled_datetime), horizonStart);
      if (idx !== null) weeks[idx].committed_inflow += Number(j.invoice_amount ?? 0) * 0.9;
    }

    // Recurring membership revenue — predictable, applies to every week.
    let weeklyMembershipRevenue = 0;
    for (const m of (activeMemberships ?? []) as { membership_plans: { price_cents: number; billing_interval: string } | null }[]) {
      const plan = m.membership_plans;
      if (!plan) continue;
      const dollars = (plan.price_cents ?? 0) / 100;
      weeklyMembershipRevenue += plan.billing_interval === "monthly" ? (dollars * 12) / 52 : dollars / 52;
    }
    for (const w of weeks) w.committed_inflow += weeklyMembershipRevenue;

    // Pipeline (optimistic-only) — open quotes weighted by win rate.
    const winRate = Number(settings?.quote_win_rate ?? 25) / 100;
    for (const q of (openQuotes ?? []) as { line_items: unknown; valid_until: string | null }[]) {
      const value = sumQuoteLineItems(q.line_items) * winRate;
      if (value <= 0) continue;
      const idx = q.valid_until ? weekIndexForDate(new Date(q.valid_until), horizonStart) : 0;
      weeks[idx ?? 0].pipeline_inflow += value;
    }

    // Fixed expenses — placed on their actual due date(s) within the horizon.
    for (const e of (fixedExpenses ?? []) as { amount: number; frequency: string; next_due_date: string }[]) {
      const dueDates = getDueDatesInHorizon(e, horizonStart, horizonEnd);
      for (const d of dueDates) {
        const idx = weekIndexForDate(d, horizonStart);
        if (idx !== null) weeks[idx].fixed_outflow += Number(e.amount ?? 0);
      }
    }

    // Variable cost + running balances.
    let runningCommitted = Number(settings?.starting_cash_balance ?? 0);
    let runningOptimistic = runningCommitted;
    for (const w of weeks) {
      w.variable_outflow = round2(w.committed_inflow * costRatio);
      w.net_committed = round2(w.committed_inflow - w.fixed_outflow - w.variable_outflow);
      runningCommitted += w.net_committed;
      runningOptimistic += round2(w.committed_inflow + w.pipeline_inflow - w.fixed_outflow - round2((w.committed_inflow + w.pipeline_inflow) * costRatio));
      w.committed_inflow = round2(w.committed_inflow);
      w.pipeline_inflow = round2(w.pipeline_inflow);
      w.fixed_outflow = round2(w.fixed_outflow);
      w.projected_balance_committed = round2(runningCommitted);
      w.projected_balance_optimistic = round2(runningOptimistic);
    }

    const narrative = await analyzeCashFlowForecast(weeks as unknown as Record<string, unknown>[]);

    const { data: snapshot, error: insertError } = await db.from("cash_flow_snapshots").insert({
      user_id: userId,
      starting_balance: Number(settings?.starting_cash_balance ?? 0),
      weeks,
      narrative,
      cost_ratio_used: round2(costRatio * 100),
      cost_ratio_source: costRatioSource,
    }).select("*").single();
    if (insertError) throw insertError;

    return new Response(JSON.stringify({ snapshot }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
