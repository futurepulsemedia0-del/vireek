// supabase/functions/next-best-actions/index.ts
//
// Proactive Customer Care / Next Best Action Engine.
//
// Gathers real, already-existing signals — open items in
// revenue_recovery_events (estimate at risk, invoice at risk, membership
// churn), cadence-based customer churn risk, and open technician capacity
// in the next 3 days — then hands them to the shared AI router to rank
// and write a short recommendation for each. The AI never invents a
// candidate; every result is validated against what was actually queried.
//
// Auth: the caller's own JWT. All reads run as the caller so RLS isolates
// tenants. The service-role client is used ONLY for the quota RPC and the
// final write to next_best_actions (so a client can't forge a priority
// score or a fake action).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { rankNextBestActions, type NextBestActionCandidate } from "../_shared/ai-core/nextBestActions.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const QUOTA_MAX_PER_HOUR = 6;
const QUOTA_WINDOW_SECONDS = 3600;

const ESTIMATE_TYPES = new Set(["declined_quote", "expired_quote", "quote_accepted_unbooked", "quote_financing_stalled"]);
const INVOICE_TYPES = new Set(["invoice_overdue", "job_completed_unbilled"]);
const CHURN_TYPES = new Set(["membership_cancelled", "membership_churned"]);
const CAP_PER_CATEGORY: Record<string, number> = { estimate_risk: 8, invoice_risk: 8, churn_risk: 5 };

function usd(dollars: number): string {
  return `$${Math.round(dollars).toLocaleString("en-US")}`;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

interface RecoveryRow {
  id: string;
  source_type: string;
  customer_name: string | null;
  estimated_value_cents: number | null;
  occurred_at: string;
}
interface ChurnRow {
  customer_id: string;
  customer_name: string;
  tier: string;
  days_since_last_job: number;
  ltv_dollars: number | null;
}
interface CapacityStatus {
  status?: string;
  normal_slots_remaining?: number;
  day_capacity?: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    const { data: ownerId } = await callerClient.rpc("get_account_owner_id");
    const accountId: string = (ownerId as string | null) ?? user.id;

    const serviceClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });

    // ---- Atomic quota (service role, RPC only) ------------------------
    const { data: allowed, error: quotaError } = await serviceClient.rpc("consume_next_best_action_quota", {
      p_user_id: accountId,
      p_max: QUOTA_MAX_PER_HOUR,
      p_window_seconds: QUOTA_WINDOW_SECONDS,
    });
    if (quotaError) {
      console.error("[next-best-actions] quota rpc failed", quotaError.message);
      return json({ error: "Could not verify your usage limit. Try again shortly." }, 500);
    }
    if (allowed === false) {
      return json({ error: "You've reached the hourly limit for refreshing next best actions." }, 429);
    }

    const today = new Date().toISOString().slice(0, 10);
    const candidates: NextBestActionCandidate[] = [];
    const perCategoryCount: Record<string, number> = {};

    // ---- Signal 1+2+3: revenue recovery ledger (caller-scoped, RLS) ----
    const { data: recoveryData } = await callerClient
      .from("revenue_recovery_events")
      .select("id, source_type, customer_name, estimated_value_cents, occurred_at")
      .eq("status", "open")
      .order("estimated_value_cents", { ascending: false })
      .limit(60);

    for (const r of (recoveryData ?? []) as RecoveryRow[]) {
      const category = ESTIMATE_TYPES.has(r.source_type)
        ? "estimate_risk"
        : INVOICE_TYPES.has(r.source_type)
        ? "invoice_risk"
        : CHURN_TYPES.has(r.source_type)
        ? "churn_risk"
        : null;
      if (!category) continue;

      const cap = CAP_PER_CATEGORY[category] ?? 5;
      perCategoryCount[category] = perCategoryCount[category] ?? 0;
      if (perCategoryCount[category] >= cap) continue;
      perCategoryCount[category]++;

      const ageDays = Math.max(0, Math.floor((Date.now() - new Date(r.occurred_at).getTime()) / 86400000));
      candidates.push({
        id: `recovery:${r.id}`,
        category,
        entity_type: category === "estimate_risk" ? "quote" : category === "invoice_risk" ? "invoice" : "customer",
        entity_id: r.id,
        entity_label: r.customer_name || "Customer",
        amount_label: (r.estimated_value_cents ?? 0) > 0 ? usd((r.estimated_value_cents ?? 0) / 100) : null,
        detail: `${r.source_type.replace(/_/g, " ")}, ${ageDays} day(s) open`,
        cta_href: "/dashboard/recovery",
      });
    }

    // ---- Signal 4: cadence-based churn risk (RPC) ----------------------
    const { data: churnData } = await callerClient.rpc("get_next_best_action_churn_candidates", { p_limit: 8 });
    for (const c of (churnData ?? []) as ChurnRow[]) {
      candidates.push({
        id: `churn:${c.customer_id}`,
        category: "churn_risk",
        entity_type: "customer",
        entity_id: c.customer_id,
        entity_label: c.customer_name,
        amount_label: (c.ltv_dollars ?? 0) > 0 ? usd(c.ltv_dollars ?? 0) : null,
        detail: `${c.tier === "at_risk" ? "At risk" : "Watch"} — ${c.days_since_last_job} day(s) since their last job`,
        cta_href: `/dashboard/customers/${c.customer_id}`,
      });
    }

    // ---- Signal 5: open capacity in the next 3 days (RPC) --------------
    for (let offset = 0; offset < 3; offset++) {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      const dateStr = d.toISOString().slice(0, 10);
      const { data: status } = await callerClient.rpc("get_capacity_status", { p_date: dateStr });
      const s = status as CapacityStatus | null;
      if (s?.status === "low" && (s.normal_slots_remaining ?? 0) > 0 && (s.day_capacity ?? 0) > 0) {
        candidates.push({
          id: `capacity:${dateStr}`,
          category: "capacity_gap",
          entity_type: null,
          entity_id: null,
          entity_label: offset === 0 ? "Today" : offset === 1 ? "Tomorrow" : dateStr,
          amount_label: null,
          detail: `${s.normal_slots_remaining} open technician slot(s) on ${dateStr}`,
          cta_href: "/dashboard/capacity-demand",
        });
      }
    }

    if (candidates.length === 0) {
      await serviceClient.from("next_best_actions").delete().eq("user_id", accountId).eq("action_date", today).eq("status", "open");
      return json({ generated: 0, actions: [] });
    }

    // ---- AI: rank + write copy over the real candidates ----------------
    const ranked = await rankNextBestActions(candidates);
    const byId = new Map(candidates.map((c) => [c.id, c]));

    const rows = ranked
      .map((r) => {
        const c = byId.get(r.candidate_id);
        if (!c) return null;
        return {
          user_id: accountId,
          action_date: today,
          category: c.category,
          title: r.title,
          reasoning: r.reasoning,
          recommended_action: r.recommended_action,
          priority_score: r.priority_score,
          amount_label: c.amount_label,
          entity_type: c.entity_type,
          entity_id: c.entity_id,
          entity_label: c.entity_label,
          cta_href: c.cta_href,
          status: "open" as const,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // Replace today's still-open auto-generated rows so re-running never
    // piles up duplicates; rows already marked done/dismissed are untouched.
    await serviceClient.from("next_best_actions").delete().eq("user_id", accountId).eq("action_date", today).eq("status", "open");

    if (rows.length === 0) return json({ generated: 0, actions: [] });

    const { data: inserted, error: insertError } = await serviceClient
      .from("next_best_actions")
      .insert(rows)
      .select("*");
    if (insertError) throw insertError;

    return json({ generated: inserted?.length ?? 0, actions: inserted ?? [] });
  } catch (err) {
    console.error("[next-best-actions] unhandled error", err);
    return json({ error: err instanceof Error ? err.message : "Something went wrong ranking today's actions." }, 500);
  }
});
