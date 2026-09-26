import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { askVireekAi } from "../_shared/ai-core/index.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const MS_DAY = 86400000;

interface WeekBucket {
  week_index: number;
  projected_balance_committed: number;
}

interface WarRoomAction {
  action_type: "chase_invoice" | "push_quote" | "delay_expense";
  title: string;
  detail: string;
  ref_table: "payment_requests" | "quotes" | "cash_flow_fixed_expenses";
  ref_id: string;
  impact_amount: number;
  priority: number;
}

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

function round2(n: number) { return Math.round(n * 100) / 100; }

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

    const { data: snapshot } = await db
      .from("cash_flow_snapshots")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!snapshot) {
      return new Response(
        JSON.stringify({ error: "No cash flow forecast yet. Run the 13-week forecast first." }),
        { status: 409, headers: jsonHeaders },
      );
    }

    const weeks = (snapshot.weeks ?? []) as WeekBucket[];

    let runwayWeeks: number | null = null;
    let shortfallAmount = 0;
    for (const w of weeks) {
      if (w.projected_balance_committed < shortfallAmount) shortfallAmount = w.projected_balance_committed;
      if (runwayWeeks === null && w.projected_balance_committed < 0) runwayWeeks = w.week_index;
    }
    const severity: "safe" | "watch" | "critical" =
      runwayWeeks === null ? "safe" : runwayWeeks <= 2 ? "critical" : runwayWeeks <= 6 ? "watch" : "safe";

    const now = new Date();
    const threeWeeksOut = new Date(now.getTime() + 21 * MS_DAY).toISOString();

    const [{ data: overduePayments }, { data: openQuotes }, { data: upcomingExpenses }] = await Promise.all([
      db.from("payment_requests")
        .select("id, amount, status, created_at, jobs(customer_name)")
        .eq("user_id", userId)
        .eq("status", "overdue")
        .order("amount", { ascending: false })
        .limit(5),
      db.from("quotes")
        .select("id, customer_name, line_items, valid_until, status")
        .eq("user_id", userId)
        .eq("status", "sent"),
      db.from("cash_flow_fixed_expenses")
        .select("id, name, amount, next_due_date")
        .eq("user_id", userId)
        .eq("active", true)
        .lte("next_due_date", threeWeeksOut)
        .order("amount", { ascending: true })
        .limit(3),
    ]);

    const actions: WarRoomAction[] = [];

    for (const p of (overduePayments ?? []) as { id: string; amount: number; jobs: { customer_name: string } | null }[]) {
      actions.push({
        action_type: "chase_invoice",
        title: `Collect overdue invoice — ${p.jobs?.customer_name ?? "customer"}`,
        detail: `Overdue payment request of $${round2(Number(p.amount)).toLocaleString()}. Call or send a payment link today.`,
        ref_table: "payment_requests",
        ref_id: p.id,
        impact_amount: round2(Number(p.amount)),
        priority: 0,
      });
    }

    const rankedQuotes = ((openQuotes ?? []) as { id: string; customer_name: string; line_items: unknown; valid_until: string | null }[])
      .map((q) => ({ q, value: sumQuoteLineItems(q.line_items) }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3);
    for (const { q, value } of rankedQuotes) {
      actions.push({
        action_type: "push_quote",
        title: `Push open quote to close — ${q.customer_name}`,
        detail: `Open quote worth $${round2(value).toLocaleString()}${q.valid_until ? `, valid until ${q.valid_until}` : ""}. Follow up now to convert it into booked cash.`,
        ref_table: "quotes",
        ref_id: q.id,
        impact_amount: round2(value),
        priority: 0,
      });
    }

    for (const e of (upcomingExpenses ?? []) as { id: string; name: string; amount: number; next_due_date: string }[]) {
      actions.push({
        action_type: "delay_expense",
        title: `Negotiate a delay — ${e.name}`,
        detail: `$${round2(Number(e.amount)).toLocaleString()} due ${e.next_due_date}. Ask the vendor for a short extension to protect this week's balance.`,
        ref_table: "cash_flow_fixed_expenses",
        ref_id: e.id,
        impact_amount: round2(Number(e.amount)),
        priority: 0,
      });
    }

    actions.sort((a, b) => b.impact_amount - a.impact_amount);
    actions.forEach((a, i) => { a.priority = i + 1; });
    const finalActions = actions.slice(0, 10);

    let aiSummary = "";
    try {
      const result = await askVireekAi({
        task: "cash_flow_war_room_plan",
        jsonMode: false,
        maxTokens: 220,
        temperature: 0.3,
        messages: [
          {
            role: "user",
            content: `Severity: ${severity}. Runway: ${runwayWeeks === null ? "does not go negative within 13 weeks" : `${runwayWeeks} week(s)`}. Worst projected balance: $${shortfallAmount.toLocaleString()}. Ranked recovery actions already computed:\n${JSON.stringify(finalActions.map((a) => ({ title: a.title, impact_amount: a.impact_amount })))}`,
          },
        ],
      });
      aiSummary = result.text.slice(0, 600);
    } catch {
      aiSummary = severity === "critical"
        ? "Cash is tight in the next few weeks. Work the top actions below in order — collections first, then closing open quotes, then buying time on bills."
        : severity === "watch"
        ? "No immediate danger, but the trend needs attention. Work through the actions below to build a bigger buffer."
        : "The forecast looks healthy for the next 13 weeks. Keep an eye on it and revisit if anything changes.";
    }

    const { data: plan, error: insertError } = await db.from("cash_flow_war_room_plans").insert({
      user_id: userId,
      snapshot_id: snapshot.id,
      severity,
      runway_weeks: runwayWeeks,
      shortfall_amount: shortfallAmount,
      ai_summary: aiSummary,
      actions: finalActions,
    }).select("*").single();
    if (insertError) throw insertError;

    return new Response(JSON.stringify({ plan }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
