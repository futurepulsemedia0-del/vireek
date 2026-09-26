// Goal Decomposition Orchestrator — the tenant states one high-level goal
// in plain language; this function creates it, gathers a small snapshot
// of real account facts (never invented — see computeContext below),
// asks the shared Vireek AI router to decompose it into Strategies ->
// Actions (see _shared/ai-core/goalDecomposition.ts), and inserts every
// one of them as a real, owned, due-dated row (see the migration's
// header for why nothing here is allowed to just be a paragraph of
// advice that goes nowhere). Ends by writing one notifications row so
// the owner is told the moment execution-ready actions exist — the
// "automatic" half of Vision -> Execution.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { decomposeGoal } from "../_shared/ai-core/goalDecomposition.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

async function computeContext(db: ReturnType<typeof createClient>, userId: string) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const context: Record<string, unknown> = {};

  try {
    const [{ count: customerCount }, { data: jobs }, { count: openLeadCount }] = await Promise.all([
      db.from("customers").select("id", { count: "exact", head: true }).eq("user_id", userId),
      db.from("jobs").select("invoice_amount, job_status, created_at").eq("user_id", userId).gte("created_at", thirtyDaysAgo),
      db.from("leads").select("id", { count: "exact", head: true }).eq("user_id", userId).in("stage", ["new", "contacted", "quoted"]),
    ]);
    const completedJobs = (jobs ?? []).filter((j: { job_status: string | null }) => j.job_status === "completed");
    context.total_customers = customerCount ?? 0;
    context.open_leads = openLeadCount ?? 0;
    context.jobs_completed_last_30_days = completedJobs.length;
    context.revenue_last_30_days = Math.round(
      completedJobs.reduce((s: number, j: { invoice_amount: number | null }) => s + (j.invoice_amount ?? 0), 0) * 100,
    ) / 100;
  } catch {
    // Best-effort only — an incomplete/renamed schema on some installs
    // should never block a goal from being created and decomposed.
  }

  return context;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });

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
    if (!user) return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: jsonHeaders });
    const userId = user.id;

    const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const { vision, target_metric, target_value, horizon_days } = await req.json().catch(() => ({}));
    if (!vision?.trim()) {
      return new Response(JSON.stringify({ error: "vision is required" }), { status: 400, headers: jsonHeaders });
    }
    const horizonDays = Math.max(7, Math.min(Number(horizon_days) || 90, 730));

    const { data: goal, error: goalError } = await db
      .from("strategic_goals")
      .insert({
        user_id: userId,
        vision: vision.trim(),
        target_metric: target_metric?.trim() || null,
        target_value: typeof target_value === "number" ? target_value : null,
        horizon_days: horizonDays,
      })
      .select("*")
      .single();
    if (goalError || !goal) throw goalError ?? new Error("Failed to create goal");

    const context = await computeContext(db, userId);
    const strategies = await decomposeGoal(vision, target_metric ?? null, horizonDays, context);

    let actionsCount = 0;
    const now = Date.now();
    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[i];
      const { data: strategyRow, error: strategyError } = await db
        .from("goal_strategies")
        .insert({ user_id: userId, goal_id: goal.id, title: s.title, rationale: s.rationale, sort_order: i })
        .select("id")
        .single();
      if (strategyError || !strategyRow) continue;

      const actionRows = s.actions.map((a, j) => ({
        user_id: userId,
        strategy_id: strategyRow.id,
        title: a.title,
        description: a.description,
        action_type: a.action_type,
        owner_name: a.owner_name,
        due_at: new Date(now + a.due_in_days * 86400000).toISOString(),
        is_auto_generated: true,
        sort_order: j,
      }));
      if (actionRows.length > 0) {
        const { error: actionsError } = await db.from("goal_actions").insert(actionRows);
        if (!actionsError) actionsCount += actionRows.length;
      }
    }

    if (strategies.length > 0) {
      await db.from("notifications").insert({
        user_id: userId,
        type: "system",
        title: "Goal decomposed into action",
        message: `"${vision.trim()}" is now ${strategies.length} strategies and ${actionsCount} concrete, owned, due-dated actions — review and assign them.`,
        action_url: "/dashboard/goals",
      });
    }

    return new Response(
      JSON.stringify({ goal_id: goal.id, strategies_count: strategies.length, actions_count: actionsCount }),
      { status: 200, headers: jsonHeaders },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), { status: 500, headers: jsonHeaders });
  }
});
