// supabase/functions/chief-of-staff/index.ts
//
// Chief of Staff — one read model over the engines Vireek already has. It does not rebuild them:
//   next_best_actions · opportunity_cost_entries · business_decisions · get_capacity_status ·
//   agent_action_log (pending approvals) · cos_goal_targets (live goal pace)
// are READ (as the caller, so RLS isolates tenants), normalised, checked for conflicts, ranked, and stored in
// cos_recommendations through the service-role RPC cos_apply_refresh (clients can never forge a row).
//
// Actions (POST { action }):
//   refresh_all  background refresh for the least recently refreshed accounts (X-Cron-Secret; deploy with --no-verify-jwt)
//   overview     read-only aggregate for the home screen
//   refresh      recompute recommendations + conflicts (throttled)
//   goals_parse  deterministic goal extraction (typed text or CSV) — no language model, nothing invented
//
// Everything that CHANGES state on behalf of a person (claim, dismiss, kill switch, autonomy, goal save) is a
// SECURITY DEFINER RPC called by the client with the user's own JWT; this function never acts for the user.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isValidTimeZone } from "../_shared/operator/dates.ts";
import { applyArbitration, detectConflicts, topActions } from "../_shared/chief-of-staff/conflicts.ts";
import { extractGoalTargets, type ExtractAnswers, type PeriodAnswer } from "../_shared/chief-of-staff/goalExtract.ts";
import {
  fromBusinessDecision, fromCapacityDay, fromGoalProgress, fromNextBestAction, fromOpportunityCost, fromPendingAgentAction,
  type CapacityDay, type DecisionRow, type NbaRow, type OppCostRow, type PendingActionRow,
} from "../_shared/chief-of-staff/normalize.ts";
import {
  answerRateActual, computeProgress, marginActual, type Actual, type GoalProgress,
} from "../_shared/chief-of-staff/progress.ts";
import { GOAL_METRICS, LIMITS, type CosCandidate, type GoalMetric, type SourceEngine } from "../_shared/chief-of-staff/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: jsonHeaders });

const MAX_BODY_CHARS = 60_000;
const REFRESH_THROTTLE_SECONDS = 30;
const DAY_MS = 86_400_000;

type Db = ReturnType<typeof createClient>;
interface Ctx { caller: Db; admin: Db; userId: string; ownerId: string; today: string; tz: string; canSeeBilling: boolean; system?: boolean }

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function localDate(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

interface PageResult<T> { rows: T[]; tooLarge: boolean; failed: boolean }

/** Pages through a query so PostgREST's 1,000-row default can never silently truncate a sum. */
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  pageSize = 1000, maxPages = 10,
): Promise<PageResult<T>> {
  const rows: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await build(page * pageSize, page * pageSize + pageSize - 1);
    if (error) { console.error("[chief-of-staff] query failed", error.message); return { rows: [], tooLarge: false, failed: true }; }
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < pageSize) return { rows, tooLarge: false, failed: false };
  }
  return { rows: [], tooLarge: true, failed: false };
}

async function loadActual(ctx: Ctx, metric: GoalMetric, start: string, end: string): Promise<Actual> {
  const from = `${start}T00:00:00Z`;
  const toExclusive = `${addDays(end, 1)}T00:00:00Z`;
  const unavailable = (u: Actual["unavailable"], basis: string): Actual => ({ value: null, basis, unavailable: u });

  if ((metric === "revenue" || metric === "gross_margin") && !ctx.canSeeBilling) {
    return unavailable("no_permission", "Requires billing permission");
  }

  if (metric === "booked_jobs") {
    const { count, error } = await ctx.caller.from("jobs").select("id", { count: "exact", head: true }).eq("user_id", ctx.ownerId)
      .gte("created_at", from).lt("created_at", toExclusive).not("job_status", "in", "(cancelled,canceled)");
    if (error || count === null) return unavailable("query_failed", "jobs count failed");
    return { value: count, basis: `${count} jobs created in the period, excluding cancelled` };
  }

  if (metric === "answer_rate") {
    const base = () => ctx.caller.from("calls").select("id", { count: "exact", head: true }).eq("user_id", ctx.ownerId).gte("call_datetime", from).lt("call_datetime", toExclusive);
    const [total, missed] = await Promise.all([base(), base().eq("status", "missed")]);
    if (total.error || missed.error || total.count === null || missed.count === null) return unavailable("query_failed", "calls count failed");
    return answerRateActual(total.count, missed.count);
  }

  // revenue + gross margin both start from completed jobs scheduled in the period
  const jobs = await fetchAll<{ id: string; invoice_amount: number | string | null }>((a, b) =>
    ctx.caller.from("jobs").select("id, invoice_amount").eq("user_id", ctx.ownerId).eq("job_status", "completed")
      .gte("scheduled_datetime", from).lt("scheduled_datetime", toExclusive).order("id").range(a, b));
  if (jobs.failed) return unavailable("query_failed", "jobs query failed");
  if (jobs.tooLarge) return unavailable("too_large", "more than 10,000 completed jobs in the period");

  const amount = (v: number | string | null) => { const n = Number(v ?? 0); return Number.isFinite(n) && n > 0 ? n : 0; };

  if (metric === "revenue") {
    const total = jobs.rows.reduce((s, j) => s + amount(j.invoice_amount), 0);
    return { value: Math.round(total * 100) / 100, basis: `${jobs.rows.length} completed jobs scheduled in the period` };
  }

  // gross_margin
  if (jobs.rows.length === 0) return unavailable("not_enough_data", "0 completed jobs in the period");
  const byJob = new Map<string, number>();
  const ids = jobs.rows.map((j) => j.id);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const costs = await fetchAll<{ job_id: string; total_cost_cents: number }>((a, b) =>
      ctx.caller.from("job_cost_entries").select("job_id, total_cost_cents").in("job_id", chunk).order("id").range(a, b));
    if (costs.failed) return unavailable("query_failed", "cost query failed");
    if (costs.tooLarge) return unavailable("too_large", "too many cost entries");
    for (const c of costs.rows) byJob.set(c.job_id, (byJob.get(c.job_id) ?? 0) + (Number(c.total_cost_cents) || 0));
  }
  const costed = jobs.rows.filter((j) => byJob.has(j.id));
  const revenue = costed.reduce((s, j) => s + amount(j.invoice_amount), 0);
  const costCents = costed.reduce((s, j) => s + (byJob.get(j.id) ?? 0), 0);
  return marginActual(revenue, costCents, costed.length, jobs.rows.length);
}

interface TargetRow {
  id: string; metric: GoalMetric; target_value: number | string; unit: string; period_start: string; period_end: string;
  source: string; source_ref: string | null; created_at: string;
}

async function loadGoals(ctx: Ctx): Promise<{ target: TargetRow; progress: GoalProgress }[]> {
  const { data, error } = await ctx.caller.from("cos_goal_targets")
    .select("id, metric, target_value, unit, period_start, period_end, source, source_ref, created_at")
    .eq("user_id", ctx.ownerId).eq("status", "confirmed").gte("period_end", addDays(ctx.today, -7)).order("period_end", { ascending: true }).limit(12);
  if (error) { console.error("[chief-of-staff] goals query failed", error.message); return []; }
  const targets = ((data ?? []) as TargetRow[]).filter((t) => (GOAL_METRICS as readonly string[]).includes(t.metric));
  return await Promise.all(targets.map(async (t) => {
    const actual = ctx.today < t.period_start
      ? { value: null, basis: "Period has not started", unavailable: "not_enough_data" as const }
      : await loadActual(ctx, t.metric, t.period_start, t.period_end);
    return { target: t, progress: computeProgress(t.metric, Number(t.target_value), t.period_start, t.period_end, ctx.today, actual) };
  }));
}

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

async function runRefresh(ctx: Ctx, minAgeSeconds = REFRESH_THROTTLE_SECONDS): Promise<Record<string, unknown>> {
  const { data: last } = await ctx.admin.from("company_events").select("occurred_at").eq("user_id", ctx.ownerId)
    .eq("event_type", "cos_refreshed").order("occurred_at", { ascending: false }).limit(1).maybeSingle();
  if (last?.occurred_at && Date.now() - Date.parse(last.occurred_at as string) < minAgeSeconds * 1000) {
    return { throttled: true };
  }

  const failed: SourceEngine[] = [];
  const candidates: CosCandidate[] = [];
  const ok: SourceEngine[] = [];
  const horizon = addDays(ctx.today, -14);

  const guard = async (engine: SourceEngine, fn: () => Promise<CosCandidate[]>) => {
    try { candidates.push(...(await fn())); ok.push(engine); }
    catch (e) { console.error(`[chief-of-staff] ${engine} failed`, e instanceof Error ? e.message : e); failed.push(engine); }
  };
  const must = <T,>(r: { data: T | null; error: { message: string } | null }): T => {
    if (r.error) throw new Error(r.error.message);
    return (r.data ?? ([] as unknown as T));
  };

  const capacityFullDates: string[] = [];
  let marginBelowTarget = false;

  await Promise.all([
    guard("next-best-actions", async () => {
      const rows = must(await ctx.caller.from("next_best_actions")
        .select("id, category, title, reasoning, recommended_action, priority_score, amount_label, entity_type, entity_id, entity_label, cta_href, action_date")
        .eq("user_id", ctx.ownerId).eq("status", "open").gte("action_date", addDays(ctx.today, -2)).order("priority_score", { ascending: false }).limit(40)) as NbaRow[];
      return rows.map(fromNextBestAction).filter((c): c is CosCandidate => c !== null);
    }),
    guard("opportunity-cost-scan", async () => {
      const rows = must(await ctx.caller.from("opportunity_cost_entries")
        .select("id, entry_type, source_table, source_id, occurred_on, estimated_cost_cents, headline, ai_narrative, ai_recommended_action, priority_score")
        .eq("user_id", ctx.ownerId).eq("status", "open").gte("occurred_on", horizon).order("priority_score", { ascending: false, nullsFirst: false }).limit(40)) as OppCostRow[];
      return rows.map(fromOpportunityCost).filter((c): c is CosCandidate => c !== null);
    }),
    guard("business-decision-engine", async () => {
      const rows = must(await ctx.caller.from("business_decisions")
        .select("id, category, title, reasoning, recommended_action, confidence_score, estimated_impact, metric_snapshot, created_at")
        .eq("user_id", ctx.ownerId).eq("status", "pending").gte("created_at", `${horizon}T00:00:00Z`).order("created_at", { ascending: false }).limit(40)) as DecisionRow[];
      return rows.map(fromBusinessDecision).filter((c): c is CosCandidate => c !== null);
    }),
    guard("agent-governance", async () => {
      const [pending, catalog] = await Promise.all([
        ctx.caller.from("agent_action_log").select("id, action_slug, agent_source, amount_cents, reasoning, created_at")
          .eq("user_id", ctx.ownerId).eq("status", "pending_approval").order("created_at", { ascending: false }).limit(50),
        ctx.caller.from("agent_action_catalog").select("slug, label, category"),
      ]);
      const cat = new Map((must(catalog) as { slug: string; label: string; category: string }[]).map((c) => [c.slug, c]));
      return (must(pending) as Omit<PendingActionRow, "category" | "label">[])
        .map((r) => { const c = cat.get(r.action_slug); return c ? fromPendingAgentAction({ ...r, category: c.category, label: c.label }) : null; })
        .filter((c): c is CosCandidate => c !== null);
    }),
    guard("capacity-demand-control", async () => {
      const days = [0, 1, 2].map((i) => addDays(ctx.today, i));
      const out: CosCandidate[] = [];
      for (const d of days) {
        const { data, error } = ctx.system
          ? await ctx.admin.rpc("cos_capacity_status_for", { p_owner: ctx.ownerId, p_date: d })
          : await ctx.caller.rpc("get_capacity_status", { p_date: d });
        if (error) throw new Error(error.message);
        const s = data as { status: string; day_load: number; day_capacity: number; load_pct: number | null };
        const day: CapacityDay = { date: d, status: s.status, day_load: s.day_load, day_capacity: s.day_capacity, load_pct: s.load_pct };
        if (s.status === "full") capacityFullDates.push(d);
        const c = fromCapacityDay(day);
        if (c) out.push(c);
      }
      return out;
    }),
    guard("goal-pace", async () => {
      const goals = await loadGoals(ctx);
      const out: CosCandidate[] = [];
      for (const g of goals) {
        if (g.target.metric === "gross_margin" && g.progress.status === "behind") marginBelowTarget = true;
        const c = fromGoalProgress(g.target.id, g.progress, g.target.period_start, g.target.period_end, ctx.today);
        if (c) out.push(c);
      }
      return out;
    }),
  ]);

  // De-duplicate, cap, arbitrate.
  const unique = [...new Map(candidates.filter((c) => c.evidence.length > 0).map((c) => [c.dedupe_key, c])).values()]
    .sort((a, b) => b.priority_score - a.priority_score).slice(0, LIMITS.maxCandidates);
  const result = detectConflicts(unique, { capacityFull: capacityFullDates.length > 0, capacityFullDates, marginBelowTarget });
  const arbitrated = applyArbitration(unique, result);

  const { data: applied, error } = await ctx.admin.rpc("cos_apply_refresh", {
    p_user_id: ctx.ownerId, p_recs: arbitrated, p_conflicts: result.conflicts, p_engines: ok,
  });
  if (error) { console.error("[chief-of-staff] apply failed", error.message); throw new Error("apply_failed"); }

  await ctx.admin.rpc("cos_publish_event", {
    p_user_id: ctx.ownerId, p_event_type: "cos_refreshed", p_source: "chief-of-staff", p_subject_type: "account",
    p_payload: { candidates: arbitrated.length, suppressed: result.suppressed.size, failed_sources: failed },
  });

  return { refreshed: true, candidates: arbitrated.length, suppressed: result.suppressed.size, failed_sources: failed, applied };
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

interface RecRow {
  id: string; kind: string; domain: string; title: string; why_it_matters: string; evidence: unknown;
  impact_low_cents: number | null; impact_high_cents: number | null; impact_basis: string | null;
  confidence: number | null; confidence_basis: string | null; owner_role: string; action_kind: string; action_label: string | null;
  action_href: string | null; action_command: string | null; works_with: string[]; priority_score: number; source_engine: string;
  status: string; suppressed_reason: string | null; claimed_by: string | null; claim_expires_at: string | null; created_at: string;
}

const FEED_PAYLOAD_KEYS = ["action_slug", "amount_cents", "engine", "kind", "count", "mode", "reason"] as const;

async function runOverview(ctx: Ctx): Promise<Record<string, unknown>> {
  const nowIso = new Date().toISOString();
  const stillClaimed = (s: string | null) => (s ? Date.parse(s) > Date.now() : false);
  const [recs, supp, conflicts, feed, settings, dials, usefulness, lastRefresh, pending, goals] = await Promise.all([
    ctx.caller.from("cos_recommendations").select("*").in("status", ["open", "claimed"])
      .order("priority_score", { ascending: false }).order("created_at", { ascending: false }).limit(60),
    ctx.caller.from("cos_recommendations").select("id, title, domain, suppressed_reason, priority_score")
      .eq("status", "suppressed").order("priority_score", { ascending: false }).limit(10),
    ctx.caller.from("cos_conflicts").select("id, rule_key, severity, summary, dedupe_keys, winner_dedupe_key, created_at")
      .eq("status", "open").order("created_at", { ascending: false }).limit(10),
    ctx.caller.from("company_events").select("id, event_type, source, subject_type, payload, occurred_at")
      .order("occurred_at", { ascending: false }).limit(25),
    ctx.caller.rpc("cos_get_settings"),
    ctx.caller.rpc("cos_list_agent_dials"),
    ctx.caller.rpc("cos_usefulness_metrics", { p_days: 30 }),
    ctx.caller.from("company_events").select("occurred_at").eq("event_type", "cos_refreshed").order("occurred_at", { ascending: false }).limit(1).maybeSingle(),
    ctx.caller.from("agent_action_log").select("id", { count: "exact", head: true }).eq("status", "pending_approval"),
    loadGoals(ctx),
  ]);

  const rows = ((recs.data ?? []) as RecRow[]).filter((r) => ctx.canSeeBilling || r.domain !== "finance");
  const shape = (r: RecRow) => ({
    id: r.id, kind: r.kind, domain: r.domain, title: r.title, why_it_matters: r.why_it_matters, evidence: r.evidence,
    impact_low_cents: ctx.canSeeBilling ? r.impact_low_cents : null,
    impact_high_cents: ctx.canSeeBilling ? r.impact_high_cents : null,
    impact_basis: ctx.canSeeBilling ? r.impact_basis : null,
    confidence: r.confidence, confidence_basis: r.confidence_basis, owner_role: r.owner_role,
    action_kind: r.action_kind, action_label: r.action_label, action_href: r.action_href, action_command: r.action_command,
    works_with: r.works_with, priority_score: r.priority_score, source_engine: r.source_engine, status: r.status,
    claimed_by_me: r.status === "claimed" && r.claimed_by === ctx.userId,
    claimed_by_other: r.status === "claimed" && r.claimed_by !== ctx.userId && stillClaimed(r.claim_expires_at),
    claim_expires_at: r.status === "claimed" ? r.claim_expires_at : null,
  });
  // An expired claim is open again for everyone.
  const live = rows.filter((r) => r.status === "open" || stillClaimed(r.claim_expires_at) || r.claimed_by === ctx.userId);
  const ranked = live.map(shape);

  return {
    as_of: nowIso, timezone: ctx.tz, today: ctx.today, can_see_billing: ctx.canSeeBilling,
    last_refresh_at: (lastRefresh.data as { occurred_at?: string } | null)?.occurred_at ?? null,
    settings: settings.data ?? null,
    dials: dials.data ?? [],
    top: ranked.slice(0, LIMITS.maxTop),
    more_count: Math.max(0, ranked.length - LIMITS.maxTop),
    suppressed: supp.data ?? [],
    conflicts: conflicts.data ?? [],
    goals: goals
      .filter((g) => ctx.canSeeBilling || (g.target.metric !== "revenue" && g.target.metric !== "gross_margin"))
      .map((g) => ({ target: g.target, progress: g.progress })),
    feed: ((feed.data ?? []) as { id: string; event_type: string; source: string; subject_type: string | null; payload: Record<string, unknown>; occurred_at: string }[])
      .map((e) => ({
        id: e.id, event_type: e.event_type, source: e.source, subject_type: e.subject_type, occurred_at: e.occurred_at,
        payload: Object.fromEntries(FEED_PAYLOAD_KEYS.filter((k) => e.payload && k in e.payload).map((k) => [k, e.payload[k]])),
      })),
    pending_approvals: pending.count ?? 0,
    usefulness: usefulness.data ?? [],
  };
}


// ---------------------------------------------------------------------------
// background refresh (pg_cron -> X-Cron-Secret). Runs as the service role, so every read above is scoped
// by owner explicitly; the least recently refreshed accounts go first and a time budget keeps it bounded.
// ---------------------------------------------------------------------------

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

async function runRefreshAll(admin: Db): Promise<Record<string, unknown>> {
  const started = Date.now();
  const BUDGET_MS = 100_000;
  const { data: owners, error } = await admin.rpc("cos_active_owners", { p_limit: 25 });
  if (error) { console.error("[chief-of-staff] cos_active_owners failed", error.message); throw new Error("owners_failed"); }
  let done = 0, skipped = 0, failed = 0;
  for (const ownerId of (owners ?? []) as string[]) {
    if (Date.now() - started > BUDGET_MS) { skipped++; continue; }
    try {
      const { data: bp } = await admin.from("business_profile").select("timezone").eq("user_id", ownerId).maybeSingle();
      const tz = isValidTimeZone((bp as { timezone?: string } | null)?.timezone) ? (bp as { timezone: string }).timezone : "UTC";
      const ctx: Ctx = { caller: admin, admin, userId: ownerId, ownerId, today: localDate(tz), tz, canSeeBilling: true, system: true };
      const r = await runRefresh(ctx, 600);
      if (r.throttled) skipped++; else done++;
    } catch (e) {
      failed++;
      console.error("[chief-of-staff] background refresh failed for one account", e instanceof Error ? e.message : e);
    }
  }
  return { accounts: ((owners ?? []) as string[]).length, refreshed: done, skipped, failed };
}

// ---------------------------------------------------------------------------
// request handling
// ---------------------------------------------------------------------------

const PERIODS: readonly PeriodAnswer[] = ["week", "month", "quarter", "year"];

function parseAnswers(raw: unknown): ExtractAnswers | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { period?: unknown; pick?: unknown };
  const out: ExtractAnswers = {};
  if (typeof r.period === "string" && (PERIODS as readonly string[]).includes(r.period)) out.period = r.period as PeriodAnswer;
  if (r.pick && typeof r.pick === "object") {
    const pick: Partial<Record<GoalMetric, number>> = {};
    for (const m of GOAL_METRICS) {
      const v = (r.pick as Record<string, unknown>)[m];
      if (typeof v === "number" && Number.isFinite(v)) pick[m] = v;
    }
    out.pick = pick;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_CHARS) return json({ error: "Request too large." }, 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return json({ error: "Invalid JSON." }, 400); }
    const action = typeof body.action === "string" ? body.action : "";
    const url = Deno.env.get("SUPABASE_URL") ?? "";

    // Scheduled path: shared secret, fail closed when CRON_SECRET is not configured.
    if (action === "refresh_all") {
      const secret = Deno.env.get("CRON_SECRET");
      if (!secret || !timingSafeEqual(req.headers.get("X-Cron-Secret") ?? "", secret)) return json({ error: "Forbidden" }, 403);
      const adminOnly = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
      return json(await runRefreshAll(adminOnly));
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false }, global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    const { data: ownerData } = await caller.rpc("get_account_owner_id");
    const ownerId = ownerData as string | null;
    if (!ownerId) return json({ error: "No account found." }, 403);

    // Technicians never see the company brain; the RPC is the single definition of "may act".
    const { data: canAct } = await caller.rpc("cos_can_act");
    if (canAct !== true) return json({ error: "Your role does not have access to Chief of Staff." }, 403);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

    const { data: bp } = await admin.from("business_profile").select("timezone").eq("user_id", ownerId).maybeSingle();
    const tz = isValidTimeZone((bp as { timezone?: string } | null)?.timezone) ? (bp as { timezone: string }).timezone : "UTC";

    let canSeeBilling = user.id === ownerId;
    if (!canSeeBilling) {
      const { data: tm } = await admin.from("team_members").select("permissions").eq("account_owner_id", ownerId).eq("user_id", user.id).maybeSingle();
      canSeeBilling = (tm as { permissions?: Record<string, unknown> } | null)?.permissions?.can_view_billing === true;
    }

    const ctx: Ctx = { caller, admin, userId: user.id, ownerId, today: localDate(tz), tz, canSeeBilling };

    if (action === "overview") return json(await runOverview(ctx));
    if (action === "refresh") return json(await runRefresh(ctx));
    if (action === "goals_parse") {
      const text = typeof body.text === "string" ? body.text : undefined;
      const csv = typeof body.csv === "string" ? body.csv : undefined;
      if (text === undefined && csv === undefined) return json({ error: "Provide text or csv." }, 400);
      return json(extractGoalTargets({ text, csv, today: ctx.today, answers: parseAnswers(body.answers) }));
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error("[chief-of-staff] unhandled", e instanceof Error ? e.message : e);
    return json({ error: "Chief of Staff could not complete that. Please try again." }, 500);
  }
});
