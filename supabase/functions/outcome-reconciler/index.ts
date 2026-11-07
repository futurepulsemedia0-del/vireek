// supabase/functions/outcome-reconciler/index.ts
//
// Scheduled reconciliation: turns real events (job booked, financing
// accepted, invoice paid) into conservative, versioned outcomes for governed
// agent actions. Decision logic lives in _shared/outcomes/attribution.ts.
//
// Schedule it like flywheel-engine (external cron / Supabase scheduler),
// e.g. every 30 minutes, POST with the service-role key:
//   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
// Optional body: { "limit": 500 }
//
// Only accounts that enabled capture (outcome_learning_settings) are touched.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  Decision, decideBooking, decideFinancing, decideInvoicePaid, RuleKey,
} from "../_shared/outcomes/attribution.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WatchRow {
  id: string;
  user_id: string;
  log_id: string;
  rule_key: RuleKey;
  executed_at_observed: string | null;
  state: string;
}

const unresolvable = (): Decision => ({
  state: "final", outcome: "unknown", confidence: 0, financialCents: null,
  conflict: false, flags: ["unresolvable_target"], evidence: {},
});

async function decide(admin: SupabaseClient, w: WatchRow, targetId: string | null, now: Date): Promise<Decision> {
  if (!targetId || !UUID_RE.test(targetId)) return unresolvable();
  const executedAt = w.executed_at_observed;

  if (w.rule_key === "booking_after_sms") {
    const { data: run } = await admin
      .from("workflow_runs").select("id, entity_type, entity_id")
      .eq("id", targetId).eq("user_id", w.user_id).maybeSingle();
    if (!run || run.entity_type !== "call" || !run.entity_id) return unresolvable();

    const { data: jobs } = await admin
      .from("jobs").select("created_at")
      .eq("user_id", w.user_id).eq("call_id", run.entity_id);

    const { data: sibling } = await admin
      .from("workflow_runs").select("id")
      .eq("user_id", w.user_id).eq("entity_type", "call").eq("entity_id", run.entity_id);
    const siblingIds = (sibling ?? []).map((r) => r.id as string);
    let touches: string[] = [];
    if (siblingIds.length > 0) {
      const { data: others } = await admin
        .from("agent_action_log").select("executed_at")
        .eq("user_id", w.user_id).eq("status", "executed").eq("target_table", "workflow_runs")
        .in("target_id", siblingIds).neq("id", w.log_id).not("executed_at", "is", null);
      touches = (others ?? []).map((o) => o.executed_at as string);
    }
    return decideBooking({
      executedAt, now,
      jobCreatedAt: (jobs ?? []).map((j) => j.created_at as string),
      otherTouchAt: touches,
    });
  }

  if (w.rule_key === "financing_offer_acceptance") {
    const { data: o } = await admin
      .from("financing_offers").select("status, updated_at, approved_amount_cents")
      .eq("id", targetId).eq("user_id", w.user_id).maybeSingle();
    if (!o) return unresolvable();
    return decideFinancing({
      executedAt, now, status: o.status as string,
      statusUpdatedAt: o.updated_at as string, approvedAmountCents: o.approved_amount_cents as number | null,
    });
  }

  const { data: inv } = await admin
    .from("invoices").select("status, paid_at")
    .eq("id", targetId).eq("user_id", w.user_id).maybeSingle();
  if (!inv) return unresolvable();
  return decideInvoicePaid({ executedAt, now, status: inv.status as string, paidAt: inv.paid_at as string | null });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!serviceRoleKey || bearer !== serviceRoleKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceRoleKey, { auth: { persistSession: false } });
    let limit = 500;
    try {
      const body = await req.json();
      if (Number.isInteger(body?.limit) && body.limit > 0) limit = Math.min(body.limit, 2000);
    } catch { /* no body */ }

    const { data: enrolled, error: enrollErr } = await admin.rpc("enroll_outcome_watches", { p_limit: limit });
    if (enrollErr) throw new Error(`enroll failed: ${enrollErr.message}`);

    const { data: watches, error: wErr } = await admin
      .from("agent_outcome_watch")
      .select("id, user_id, log_id, rule_key, executed_at_observed, state")
      .in("state", ["pending", "measured"])
      .order("window_ends_at", { ascending: true })
      .limit(limit);
    if (wErr) throw new Error(`load watches failed: ${wErr.message}`);

    const now = new Date();
    const counts = { enrolled: Number(enrolled ?? 0), evaluated: 0, finalized: 0, measured: 0, pending: 0, errors: 0 };

    for (const w of (watches ?? []) as WatchRow[]) {
      try {
        const { data: log } = await admin
          .from("agent_action_log").select("target_id").eq("id", w.log_id).maybeSingle();
        const d = await decide(admin, w, (log?.target_id as string | null) ?? null, now);
        counts.evaluated++;
        if (d.state === "pending") { counts.pending++; continue; }
        if (d.state === "measured" && w.state === "measured") { counts.pending++; continue; }
        const { error } = await admin.rpc("finalize_outcome_watch", {
          p_watch_id: w.id,
          p_state: d.state,
          p_outcome: d.outcome,
          p_financial_cents: d.financialCents,
          p_confidence: d.confidence,
          p_evidence: d.evidence,
          p_flags: d.flags,
          p_conflict: d.conflict,
        });
        if (error) throw new Error(error.message);
        if (d.state === "final") counts.finalized++; else counts.measured++;
      } catch (e) {
        counts.errors++;
        console.error("outcome-reconciler watch failed", w.id, e instanceof Error ? e.message : e);
      }
    }

    return new Response(JSON.stringify(counts), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
