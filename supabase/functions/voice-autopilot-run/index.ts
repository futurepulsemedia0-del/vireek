// supabase/functions/voice-autopilot-run/index.ts
//
// Voice Autopilot evaluator. Two entry points:
//   * Scheduled (hourly suggested): header  x-cron-secret: <VOICE_AUTOPILOT_CRON_SECRET>  -> every account with a live experiment.
//   * Signed-in user (JWT): { action: "evaluate" | "weekly_report" } -> THAT account only (needs can_edit_call_scripts()).
//
// Safety contract
//   - Win/loss is decided ONLY at the pre-registered looks, on exactly the first N calls per arm (no peeking bias).
//   - Guardrail breach / critical compliance finding => automatic rollback in EVERY mode (even "suggest"); mode "off" still rolls back.
//   - Promotion needs significance + all guardrails proven safe + locked language intact; "suggest" only requests approval.
//   - All writes go through voice_experiment_conclude() (row lock, idempotent, audited by the database).
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (auto), VOICE_AUTOPILOT_CRON_SECRET.
// Deploy:  supabase functions deploy voice-autopilot-run --no-verify-jwt   (auth is checked in code, like value-scoreboard-run)

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { classifyCallScenario, isScenarioKey, type ScenarioKey } from "../_shared/call-scripts/logic.ts";
import {
  DEFAULT_LIMITS, evaluateExperiment, outcomeFromCall, resolveAction,
  type AutopilotLimits, type CallOutcome, type CallRowForOutcome, type Evaluation, type MetricId, type Prereg,
} from "../_shared/voice-autopilot/decision.ts";
import { checkVariantText, EXPERIMENT_DIMENSIONS, type ExperimentDimension } from "../_shared/voice-autopilot/locks.ts";
import { K_LOOKS, lookThresholds } from "../_shared/voice-autopilot/stats.ts";
import { buildWeeklyReport, planNextTest, type ConcludedExperiment, type RunningExperiment } from "../_shared/voice-autopilot/report.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_ASSIGNMENTS = 20000;
const CHUNK = 150;
const TIME_BUDGET_MS = 90_000;

interface ExperimentRow {
  id: string; user_id: string; script_id: string; scenario: string; name: string; dimension: ExperimentDimension;
  control_version_id: string; challenger_version_id: string; prereg: Prereg; status: "running" | "awaiting_approval";
  last_look_done: number; started_at: string;
}
interface AssignmentRow { call_external_id: string; version_id: string; arm: "control" | "challenger"; after_hours: boolean; assigned_at: string }
interface CallRow extends CallRowForOutcome { id: string; vapi_call_id: string | null }

/** Constant-time-ish string comparison for the cron secret. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function loadOutcomes(admin: SupabaseClient, e: ExperimentRow): Promise<{ control: { at: string; o: CallOutcome }[]; challenger: { at: string; o: CallOutcome }[] }> {
  const { data: aData, error: aErr } = await admin.from("call_script_assignments")
    .select("call_external_id, version_id, arm, after_hours, assigned_at")
    .eq("script_id", e.script_id).gte("assigned_at", e.started_at)
    .in("version_id", [e.control_version_id, e.challenger_version_id])
    .order("assigned_at", { ascending: true }).limit(MAX_ASSIGNMENTS);
  if (aErr) throw aErr;
  const assignments = (aData ?? []) as AssignmentRow[];
  const ids = [...new Set(assignments.map((a) => a.call_external_id))];

  const calls = new Map<string, CallRow>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await admin.from("calls")
      .select("id, vapi_call_id, is_emergency, intent, status, is_voicemail, booking_outcome, sentiment, duration_seconds")
      .in("vapi_call_id", ids.slice(i, i + CHUNK));
    if (error) throw error;
    for (const c of (data ?? []) as CallRow[]) if (c.vapi_call_id) calls.set(c.vapi_call_id, c);
  }
  const dbIds = [...calls.values()].map((c) => c.id);
  const escalated = new Set<string>();
  const findings = new Map<string, ("low" | "medium" | "high" | "critical")[]>();
  for (let i = 0; i < dbIds.length; i += CHUNK) {
    const chunk = dbIds.slice(i, i + CHUNK);
    const [esc, fin, disc] = await Promise.all([
      admin.from("csr_call_actions").select("call_id").eq("action", "transfer").in("call_id", chunk),
      admin.from("ai_quality_findings").select("call_id, severity").eq("kind", "compliance_miss").in("call_id", chunk),
      admin.from("call_ai_disclosures").select("call_id, status").in("call_id", chunk).in("status", ["missing", "late", "partial"]),
    ]);
    if (esc.error || fin.error || disc.error) throw esc.error ?? fin.error ?? disc.error;
    for (const r of (esc.data ?? []) as { call_id: string }[]) escalated.add(r.call_id);
    for (const r of (fin.data ?? []) as { call_id: string; severity: "low" | "medium" | "high" | "critical" }[]) findings.set(r.call_id, [...(findings.get(r.call_id) ?? []), r.severity]);
    // A missing / late / partial AI disclosure is a compliance flag; a MISSING one is a hard stop (severity "high").
    for (const r of (disc.data ?? []) as { call_id: string; status: string }[]) findings.set(r.call_id, [...(findings.get(r.call_id) ?? []), r.status === "missing" ? "high" : "medium"]);
  }

  const scenario = e.scenario as ScenarioKey;
  const out = { control: [] as { at: string; o: CallOutcome }[], challenger: [] as { at: string; o: CallOutcome }[] };
  for (const a of assignments) {
    const c = calls.get(a.call_external_id);
    if (!c || c.duration_seconds === null) continue;                          // not finished yet
    if (c.is_voicemail || c.status === "spam" || c.status === "missed") continue;
    if (classifyCallScenario(c, a.after_hours) !== scenario) continue;        // same attribution rule as the existing panel
    out[a.arm].push({
      at: a.assigned_at,
      o: outcomeFromCall(c, { afterHours: a.after_hours, escalated: escalated.has(c.id), complianceFindings: findings.get(c.id) ?? [], latencyMs: null, emergencyLabel: null }),
    });
  }
  return out;
}

async function getLimits(admin: SupabaseClient, userId: string): Promise<AutopilotLimits> {
  const { data } = await admin.from("voice_autopilot_settings").select("mode, max_traffic_pct, max_auto_promotions_per_week").eq("user_id", userId).maybeSingle();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { count } = await admin.from("voice_experiments").select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("status", "promoted").gte("concluded_at", since).contains("conclusion", { auto: true });
  const s = data as { mode: "off" | "suggest" | "auto"; max_traffic_pct: number; max_auto_promotions_per_week: number } | null;
  return s
    ? { ...DEFAULT_LIMITS, mode: s.mode, maxTrafficPct: s.max_traffic_pct, maxAutoPromotionsPerWeek: s.max_auto_promotions_per_week, autoPromotionsThisWeek: count ?? 0 }
    : { ...DEFAULT_LIMITS, autoPromotionsThisWeek: count ?? 0 };
}

function summarize(ev: Evaluation, nControl: number, nChallenger: number, auto: boolean) {
  const d = ev.primary.diff;
  return {
    decision: ev.decision, reasons: ev.reasons, metric: ev.primary.metric, auto,
    estimate: d?.estimate ?? null, low: ev.reportInterval?.low ?? null, high: ev.reportInterval?.high ?? null,
    nControl, nChallenger, earlyStop: ev.earlyStop, look: ev.lookIndex,
    guardrails: ev.guardrails.map((g) => ({ metric: g.metric, status: g.status, harm: g.harm, margin: g.margin })),
  };
}

async function processExperiment(admin: SupabaseClient, e: ExperimentRow): Promise<{ id: string; outcome: string }> {
  if (!isScenarioKey(e.scenario)) return { id: e.id, outcome: "skipped_unknown_scenario" };
  const limits = await getLimits(admin, e.user_id);
  const data = await loadOutcomes(admin, e);
  const control = data.control.map((x) => x.o);
  const challenger = data.challenger.map((x) => x.o);

  // Re-check the locked language on the CURRENT challenger text (defence in depth; the DB trigger already blocks writes).
  const { data: v } = await admin.from("call_script_versions").select("opening_line, body").eq("id", e.challenger_version_id).maybeSingle();
  const lockOk = !!v && checkVariantText((v as { opening_line: string }).opening_line, (v as { body: string }).body).length === 0;

  // 1) continuous safety monitoring on ALL data (look logic suppressed with lastLookDone = K).
  const monitor = evaluateExperiment({ prereg: e.prereg, control, challenger, lastLookDone: K_LOOKS, lockOk });
  if (monitor.decision === "rollback" || monitor.decision === "blocked_by_lock") {
    const action = monitor.decision === "rollback" ? "rollback" : "stop";
    const res = await admin.rpc("voice_experiment_conclude", { p_experiment_id: e.id, p_action: action, p_conclusion: summarize(monitor, control.length, challenger.length, true) });
    if (res.error) throw res.error;
    return { id: e.id, outcome: action };
  }
  if (e.status === "awaiting_approval") return { id: e.id, outcome: "awaiting_approval" };

  // 2) the pre-registered look, on EXACTLY the first N calls per arm.
  const k = e.last_look_done + 1;
  if (k > K_LOOKS) return { id: e.id, outcome: "no_more_looks" };
  const n = lookThresholds(e.prereg.nMaxPerArm)[k - 1];
  if (control.length < n || challenger.length < n) return { id: e.id, outcome: "waiting_for_look" };
  const ev = evaluateExperiment({ prereg: e.prereg, control: control.slice(0, n), challenger: challenger.slice(0, n), lastLookDone: e.last_look_done, lockOk });

  // Record the look first: UNIQUE(experiment_id, look) makes concurrent runs safe (the loser stops here).
  const ins = await admin.from("voice_experiment_looks").insert({ experiment_id: e.id, user_id: e.user_id, look: k, n_control: n, n_challenger: n, result: ev, decision: ev.decision });
  if (ins.error) return { id: e.id, outcome: (ins.error as { code?: string }).code === "23505" ? "look_already_done" : "look_insert_failed" };
  const upd = await admin.from("voice_experiments").update({ last_look_done: k }).eq("id", e.id).eq("last_look_done", e.last_look_done);
  if (upd.error) throw upd.error;

  const { action } = resolveAction(ev, limits, e.scenario as ScenarioKey);
  const conclusion = summarize(ev, n, n, action === "auto_promote");
  const call = (a: string) => admin.rpc("voice_experiment_conclude", { p_experiment_id: e.id, p_action: a, p_conclusion: conclusion });
  let outcome = "continue";
  if (action === "auto_promote") { const r = await call("promote"); if (r.error) throw r.error; outcome = "promoted"; }
  else if (action === "request_approval") { const r = await call("await_approval"); if (r.error) throw r.error; outcome = "awaiting_approval"; }
  else if (action === "stop") { const r = await call(ev.decision === "inconclusive" ? "inconclusive" : "stop"); if (r.error) throw r.error; outcome = ev.decision; }
  else if (action === "rollback") { const r = await call("rollback"); if (r.error) throw r.error; outcome = "rolled_back"; }
  else if (ev.decision === "continue" && ev.lookIndex === K_LOOKS) { const r = await call("inconclusive"); if (r.error) throw r.error; outcome = "inconclusive"; }

  // Opt-in, anonymised pooled prior: only the CONTROL arm's counts for the primary binary metric, never ids.
  {
    const { data: st } = await admin.from("voice_autopilot_settings").select("pooled_priors_opt_in").eq("user_id", e.user_id).maybeSingle();
    const pc = ev.primary.control;
    if ((st as { pooled_priors_opt_in?: boolean } | null)?.pooled_priors_opt_in && pc.kind === "binary" && ["promoted", "stopped", "stop_harm", "inconclusive", "rolled_back"].includes(outcome)) {
      await admin.from("voice_prior_contributions").upsert(
        { experiment_id: e.id, user_id: e.user_id, scenario: e.scenario, metric: e.prereg.primaryMetric, successes: pc.t.k, trials: pc.t.n },
        { onConflict: "experiment_id", ignoreDuplicates: true });
    }
  }
  return { id: e.id, outcome };
}

async function weeklyReport(admin: SupabaseClient, userId: string) {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86_400_000);
  const { data: done } = await admin.from("voice_experiments").select("id, name, scenario, dimension, status, conclusion, concluded_at")
    .eq("user_id", userId).in("status", ["promoted", "rolled_back", "stopped", "inconclusive", "awaiting_approval"]).gte("concluded_at", start.toISOString());
  const concluded: ConcludedExperiment[] = ((done ?? []) as { id: string; name: string; scenario: string; dimension: ExperimentDimension; status: string; conclusion: Record<string, unknown> | null; concluded_at: string }[]).map((r) => {
    const c = r.conclusion ?? {};
    const decision = r.status === "rolled_back" ? "rollback" : r.status === "promoted" || r.status === "awaiting_approval" ? "promote_ready" : (c.decision as string) === "stop_harm" ? "stop_harm" : "inconclusive";
    return {
      id: r.id, name: r.name, scenario: r.scenario, dimension: r.dimension, decision: decision as ConcludedExperiment["decision"],
      metric: (c.metric as MetricId) ?? "qualified_booking_rate", estimate: (c.estimate as number | null) ?? null, low: (c.low as number | null) ?? null, high: (c.high as number | null) ?? null,
      nControl: (c.nControl as number) ?? 0, nChallenger: (c.nChallenger as number) ?? 0, earlyStop: Boolean(c.earlyStop),
      appliedAction: r.status === "promoted" ? "promoted" : r.status === "awaiting_approval" ? "awaiting_approval" : r.status === "rolled_back" ? "rolled_back" : "stopped",
      concludedAt: r.concluded_at,
    };
  });
  const { data: live } = await admin.from("voice_experiments").select("id, user_id, script_id, scenario, name, dimension, control_version_id, challenger_version_id, prereg, status, last_look_done, started_at").eq("user_id", userId).eq("status", "running");
  const running: RunningExperiment[] = [];
  for (const e of (live ?? []) as ExperimentRow[]) {
    const d = await loadOutcomes(admin, e);
    running.push({ id: e.id, name: e.name, dimension: e.dimension, nMin: Math.min(d.control.length, d.challenger.length), nTarget: e.prereg.nMaxPerArm });
  }
  const { data: hist } = await admin.from("voice_experiments").select("dimension, scenario").eq("user_id", userId).order("started_at", { ascending: false }).limit(50);
  const history = (hist ?? []) as { dimension: ExperimentDimension; scenario: string }[];
  const next = planNextTest(history, EXPERIMENT_DIMENSIONS, history[0]?.scenario ?? "new_inquiry");
  const lowVolume = running.length === 0 && concluded.length === 0 && history.length > 0;
  return buildWeeklyReport({ weekStart: start.toISOString(), weekEnd: end.toISOString(), concluded, running, next, lowVolume });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const cronSecret = Deno.env.get("VOICE_AUTOPILOT_CRON_SECRET") ?? "";
  const provided = req.headers.get("x-cron-secret") ?? "";
  const isCron = cronSecret.length >= 16 && safeEqual(provided, cronSecret);

  let body: { action?: string } = {};
  try { body = await req.json(); } catch { /* empty body is fine for cron */ }

  let ownerFilter: string | null = null;
  if (!isCron) {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: u, error } = await userClient.auth.getUser();
    if (error || !u.user) return json({ error: "Unauthorized" }, 401);
    const [can, owner] = await Promise.all([userClient.rpc("can_edit_call_scripts"), userClient.rpc("get_account_owner_id")]);
    if (can.error || can.data !== true || owner.error || typeof owner.data !== "string") return json({ error: "Forbidden" }, 403);
    ownerFilter = owner.data as string;
  }

  try {
    if (body.action === "weekly_report") {
      if (!ownerFilter) return json({ error: "weekly_report requires a signed-in user" }, 400);
      return json({ report: await weeklyReport(admin, ownerFilter) });
    }
    let q = admin.from("voice_experiments")
      .select("id, user_id, script_id, scenario, name, dimension, control_version_id, challenger_version_id, prereg, status, last_look_done, started_at")
      .in("status", ["running", "awaiting_approval"]).order("started_at", { ascending: true }).limit(200);
    if (ownerFilter) q = q.eq("user_id", ownerFilter);
    const { data, error } = await q;
    if (error) throw error;
    const started = Date.now();
    const results: { id: string; outcome: string }[] = [];
    for (const e of (data ?? []) as ExperimentRow[]) {
      if (Date.now() - started > TIME_BUDGET_MS) { results.push({ id: e.id, outcome: "deferred_time_budget" }); continue; }
      try { results.push(await processExperiment(admin, e)); }
      catch (err) { console.error("[voice-autopilot-run] experiment failed", e.id, err instanceof Error ? err.message : err); results.push({ id: e.id, outcome: "error" }); }
    }
    return json({ processed: results.length, results });
  } catch (err) {
    console.error("[voice-autopilot-run]", err instanceof Error ? err.message : err);
    return json({ error: "Could not evaluate experiments" }, 500);
  }
});
