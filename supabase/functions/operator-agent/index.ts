// supabase/functions/operator-agent/index.ts
//
// ============================================================
// OPERATOR AGENT — multi-step requests from Cmd+K
// ============================================================
//   request ─► pre-screen ─► PLANNER (LLM, sees no business data) ─► strict plan validation
//           ─► deterministic dry run (resolves names/dates, lists every affected record,
//              predicts clashes, renders the exact texts) ─► governance gate per step
//              (approval queue / autonomy settings / guardrails) ─► approval ─► execution
//              through existing APIs ─► ledger ─► undo.
//
// Actions (POST, user JWT):
//   { action: "plan",    instruction }
//   { action: "execute", run_id, approve: true | false }
//   { action: "undo",    run_id }
//
// Security model
//  - The model only PLANS. It never sees records, never writes SQL, never picks ids.
//  - Authority is the CALLER'S: jobs are changed through move_job with the caller's JWT
//    (tenancy, capacity, compliance and double-booking rules apply); texts go through
//    sendCompliantSms (A2P, opt-out, quiet hours).
//  - Every step is registered in agent_action_log (the approval queue) and executes only
//    when its row is auto_approved / approved in the DATABASE — the client cannot skip approval.
//  - Guardrails (bulk size, far dates, dry-run warnings) force a human even when autonomy
//    settings would allow autopilot.
//  - Every change is compare-and-swap against the preview snapshot and recorded for undo.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { askVireekAi } from "../_shared/ai-core/index.ts";
import { extractJsonObject, isUuid } from "../_shared/agent-marketplace/contract.ts";
import { authorizeAgentAction, recordAgentActionOutcome } from "../_shared/governance/agentGovernance.ts";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { daysBetween, dayBoundsUtc, isValidTimeZone, localDate, weekdayIndex } from "../_shared/operator/dates.ts";
import { buildDryRun, plannedCount, type BuiltStep, type DryRunData, type JobRow } from "../_shared/operator/dryrun.ts";
import { parsePlanOutput, plannerPrompt, screenInstruction, type RosterTech } from "../_shared/operator/plan.ts";
import { escalationReasons, toolsAllowedFor } from "../_shared/operator/policy.ts";
import { executeRun, undoRun, type RunnerDeps, type RunState } from "../_shared/operator/runner.ts";
import {
  LIMITS, OPERATOR_AGENT_SOURCE, TOOL_SLUG, WEEKDAYS,
  type Actor, type EffectRow, type OperatorTool, type StepRow,
} from "../_shared/operator/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type Row = Record<string, unknown>;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const JOB_COLS = "id, customer_id, customer_name, customer_phone, service_type, scheduled_datetime, duration_minutes, assigned_technician_id, job_status";
const LIVE = ["scheduled", "en_route", "in_progress"];
const iso = (ms: number) => new Date(ms).toISOString();

interface Ctx { db: SupabaseClient; admin: SupabaseClient; actor: Actor }

// ---------------------------------------------------------------------
// Caller identity (same rule as ask-vireek: owner, or an active team member)
// ---------------------------------------------------------------------
async function loadActor(db: SupabaseClient, userId: string, userEmail: string | undefined): Promise<Actor | null> {
  const { data: profile } = await db.from("profiles").select("id, role, email").eq("id", userId).maybeSingle();
  if (profile?.role === "owner") return { userId, ownerId: userId, role: "owner", permissions: {} };
  const { data: tm } = await db
    .from("team_members")
    .select("account_owner_id, role, permissions, custom_role:custom_roles(permissions)")
    .eq("member_email", profile?.email ?? userEmail ?? "")
    .eq("invite_status", "active")
    .maybeSingle();
  if (!tm?.account_owner_id) return null;
  const permissions = { ...((tm.permissions as Row) ?? {}), ...(((tm.custom_role as Row | null)?.permissions as Row) ?? {}) };
  return { userId, ownerId: tm.account_owner_id as string, role: tm.role as Actor["role"], permissions };
}

// ---------------------------------------------------------------------
// Data access for the dry run (RLS-scoped with the caller's JWT)
// ---------------------------------------------------------------------
async function loadRoster(admin: SupabaseClient, ownerId: string): Promise<RosterTech[]> {
  const { data } = await admin.from("team_members").select("id, member_name, max_jobs_per_day")
    .eq("account_owner_id", ownerId).eq("role", "technician").eq("invite_status", "active");
  return (data ?? []) as RosterTech[];
}

function dryRunData(ctx: Ctx, roster: RosterTech[], tz: string): DryRunData {
  return {
    roster,
    async jobsOn(date, techId) {
      const { startMs, endMs } = dayBoundsUtc(date, tz);
      let q = ctx.db.from("jobs").select(JOB_COLS).eq("user_id", ctx.actor.ownerId)
        .gte("scheduled_datetime", iso(startMs)).lt("scheduled_datetime", iso(endMs))
        .order("scheduled_datetime", { ascending: true }).limit(LIMITS.maxRecordsPerStep + 1);
      if (techId) q = q.eq("assigned_technician_id", techId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as JobRow[];
    },
    async liveJobsOn(date, techIds) {
      if (!techIds.length) return [];
      const { startMs, endMs } = dayBoundsUtc(date, tz);
      const { data, error } = await ctx.db.from("jobs").select(JOB_COLS).eq("user_id", ctx.actor.ownerId)
        .in("assigned_technician_id", techIds).in("job_status", LIVE)
        .gte("scheduled_datetime", iso(startMs)).lt("scheduled_datetime", iso(endMs)).limit(500);
      if (error) throw new Error(error.message);
      return (data ?? []) as JobRow[];
    },
  };
}

// ---------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------
async function insertRun(ctx: Ctx, instruction: string, status: string, message: string | null, extra: Row = {}) {
  const { data, error } = await ctx.admin.from("operator_runs").insert({
    user_id: ctx.actor.ownerId, requested_by: ctx.actor.userId, instruction: instruction.slice(0, LIMITS.maxInstructionChars),
    status, message, ...extra,
  }).select("id, expires_at").single();
  if (error) throw new Error(error.message);
  return data as { id: string; expires_at: string };
}

const setRun = (ctx: Ctx, id: string, patch: Row) => ctx.admin.from("operator_runs").update(patch).eq("id", id);

/** Reject every still-pending proposal of a run so nothing dangles in the approval queue. */
const rejectPending = (ctx: Ctx, runId: string) =>
  ctx.admin.rpc("operator_decide_run", { p_user_id: ctx.actor.ownerId, p_run_id: runId, p_approve: false, p_decided_by: ctx.actor.userId });

function stepRows(steps: Row[], logs: Map<string, string>): StepRow[] {
  return steps.map((s) => ({
    id: s.id as string, step_key: s.step_key as string, position: s.position as number, tool: s.tool as OperatorTool,
    title: s.title as string, status: s.status as StepRow["status"], action_log_id: (s.action_log_id as string | null) ?? null,
    gov_status: s.action_log_id ? logs.get(s.action_log_id as string) ?? null : null,
    affected_count: s.affected_count as number, error: (s.error as string | null) ?? null, params: (s.params as Row) ?? {},
  }));
}

async function loadRunState(ctx: Ctx, runId: string): Promise<RunState & { rawSteps: Row[] }> {
  const [{ data: steps }, { data: effects }] = await Promise.all([
    ctx.admin.from("operator_run_steps").select("*").eq("run_id", runId).order("position", { ascending: true }),
    ctx.admin.from("operator_run_effects").select("*").eq("run_id", runId).order("created_at", { ascending: true }),
  ]);
  const logIds = ((steps ?? []) as Row[]).map((s) => s.action_log_id).filter((x): x is string => typeof x === "string");
  const logs = new Map<string, string>();
  if (logIds.length) {
    const { data } = await ctx.admin.from("agent_action_log").select("id, status").in("id", logIds).eq("user_id", ctx.actor.ownerId);
    for (const l of (data ?? []) as Row[]) logs.set(l.id as string, l.status as string);
  }
  return {
    runId, rawSteps: (steps ?? []) as Row[], steps: stepRows((steps ?? []) as Row[], logs),
    effects: ((effects ?? []) as Row[]).map((e) => ({
      id: e.id as string, step_id: e.step_id as string, kind: e.kind as EffectRow["kind"], record_id: e.record_id as string,
      label: (e.label as string) ?? "", before: (e.before as Row) ?? {}, after: (e.after as Row) ?? {}, status: e.status as EffectRow["status"],
      reason: (e.reason as string | null) ?? null, external_ref: (e.external_ref as string | null) ?? null,
    })),
  };
}

// ---------------------------------------------------------------------
// Runner dependencies (the only code that touches jobs / customers)
// ---------------------------------------------------------------------
function runnerDeps(ctx: Ctx, runId: string, tz: string, sessionId: string | null): RunnerDeps {
  const now = () => new Date().toISOString();
  return {
    tz,
    async moveJob(jobId, patch, expected) {
      // The CALLER's JWT: move_job applies tenancy, role, capacity, compliance and double-booking rules.
      const { data, error } = await ctx.db.rpc("move_job", { p_job_id: jobId, p_patch: patch, p_expected: expected });
      if (error) {
        if (error.code === "23P01" || /double.?book|overlap/i.test(error.message)) return { status: "conflict", reason: "That time overlaps another job for this technician." };
        throw new Error(error.message);
      }
      return (data ?? { status: "error", reason: "Empty response." }) as { status: string; reason?: string; job?: Row | null };
    },
    async loadJob(jobId) {
      const { data } = await ctx.admin.from("jobs").select("customer_id, customer_name, customer_phone, scheduled_datetime")
        .eq("id", jobId).eq("user_id", ctx.actor.ownerId).is("deleted_at", null).maybeSingle();
      return (data as { customer_id: string | null; customer_name: string | null; customer_phone: string | null; scheduled_datetime: string | null } | null) ?? null;
    },
    async sendSms(job, body, dedupeKey) {
      const r = await sendCompliantSms(ctx.admin, ctx.actor.ownerId, job.customer_phone!, body, {
        purpose: "service", customerId: job.customer_id, source: OPERATOR_AGENT_SOURCE, dedupeKey,
      });
      if (r.ok) return { ok: true, deferred: Boolean(r.deferred), ref: r.sid, sendAt: "sendAt" in r ? (r as { sendAt?: string }).sendAt : undefined };
      return { ok: false, reason: r.reason, detail: "detail" in r ? r.detail : undefined };
    },
    async saveEffect(e) {
      await ctx.admin.from("operator_run_effects").update({
        status: e.status, reason: e.reason, after: e.after, external_ref: e.external_ref,
        ...(e.status === "applied" ? { applied_at: now() } : {}), ...(e.status === "undone" ? { undone_at: now() } : {}),
      }).eq("id", e.id);
    },
    async saveStep(s) {
      const terminal = !["planned", "running"].includes(s.status);
      await ctx.admin.from("operator_run_steps").update({
        status: s.status, error: s.error, affected_count: s.affected_count,
        ...(s.status === "running" ? { started_at: now() } : {}), ...(terminal ? { finished_at: now() } : {}),
      }).eq("id", s.id);
    },
    async recordOutcome(logId, status, error) {
      await recordAgentActionOutcome(ctx.admin, logId, { status, error });
    },
    async checkBudget(slug) {
      if (!sessionId) return { allowed: true }; // no autonomy budget configured for Operator
      const { data, error } = await ctx.admin.rpc("check_autonomy_action", { p_session_id: sessionId, p_action_slug: slug, p_amount_cents: 0 });
      if (error) return { allowed: false, reason: "Autonomy budget check failed." }; // fail closed
      const row = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean; reason?: string } | null;
      return row?.allowed ? { allowed: true } : { allowed: false, reason: row?.reason ?? "Autonomy budget reached." };
    },
  };
}

// ---------------------------------------------------------------------
// Views returned to the browser
// ---------------------------------------------------------------------
function previewView(runId: string, expiresAt: string, summary: string, tz: string, steps: (BuiltStep & { needsApproval: boolean; reasons: string[] })[]) {
  return {
    status: steps.some((s) => s.needsApproval) ? "awaiting_approval" : "ready",
    run_id: runId, summary, timezone: tz, expires_at: expiresAt,
    approval: { required: steps.some((s) => s.needsApproval), reasons: [...new Set(steps.flatMap((s) => s.reasons))] },
    steps: steps.map((s) => ({
      key: s.key, tool: s.tool, title: s.title, affected: plannedCount(s), skipped: s.effects.length - plannedCount(s),
      note: s.note, warnings: s.warnings, needs_approval: s.needsApproval, reasons: s.reasons,
      effects: s.effects.slice(0, 12).map((e) => ({ label: e.label, before: e.before.display ?? "", after: e.after.display ?? "", status: e.status, reason: e.reason })),
      more: Math.max(0, s.effects.length - 12),
    })),
  };
}

// ---------------------------------------------------------------------
// PLAN
// ---------------------------------------------------------------------
async function handlePlan(ctx: Ctx, body: Row): Promise<Response> {
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  const allowed = toolsAllowedFor(ctx.actor);
  if (allowed.size === 0) return reply(403, { error: "Operator is available to the account owner and to team members who can view all jobs." });

  const { count } = await ctx.admin.from("operator_runs").select("id", { count: "exact", head: true })
    .eq("requested_by", ctx.actor.userId).gte("created_at", iso(Date.now() - 3_600_000));
  if ((count ?? 0) >= LIMITS.runsPerHour) return reply(429, { error: "You’ve reached the hourly Operator limit. Try again in a bit." });

  const screen = screenInstruction(instruction);
  if (!screen.ok) {
    if (screen.category !== "length") await insertRun(ctx, instruction, "refused", screen.message);
    return reply(200, { status: "refused", message: screen.message });
  }

  // ---- business clock ----
  const { data: bp } = await ctx.admin.from("business_profile").select("timezone").eq("user_id", ctx.actor.ownerId).maybeSingle();
  const tzOk = isValidTimeZone(bp?.timezone);
  const tz = tzOk ? (bp!.timezone as string) : "UTC";
  const today = localDate(Date.now(), tz);

  // ---- plan (the model sees the request only) ----
  let raw: unknown;
  try {
    const result = await askVireekAi({
      task: "operator_plan", messages: [{ role: "user", content: instruction }], maxTokens: 900, temperature: 0, jsonMode: true, timeoutMs: 30_000,
      extraInstructions: plannerPrompt(today, WEEKDAYS[weekdayIndex(today)], tz),
    });
    raw = extractJsonObject(result.text);
  } catch (e) {
    console.error("[operator-agent] planner failed:", errMsg(e));
    return reply(503, { error: "Operator couldn’t plan that right now. Please try again." });
  }
  const outcome = parsePlanOutput(raw, allowed);
  if (outcome.kind === "clarify") return reply(200, { status: "clarify", message: outcome.question });
  if (outcome.kind === "refusal" || outcome.kind === "denied") {
    await insertRun(ctx, instruction, "refused", outcome.reason);
    return reply(200, { status: "refused", message: outcome.reason });
  }
  if (outcome.kind === "invalid") {
    console.warn("[operator-agent] invalid plan:", outcome.error);
    await insertRun(ctx, instruction, "failed", "The request couldn’t be turned into a safe plan.");
    return reply(200, { status: "failed", message: "I couldn’t turn that into a safe plan. Try rephrasing it with who, which day and what to do." });
  }
  const plan = outcome.plan;

  // ---- dry run ----
  const roster = await loadRoster(ctx.admin, ctx.actor.ownerId);
  let dry;
  try {
    dry = await buildDryRun(plan, { tz, today }, dryRunData(ctx, roster, tz));
  } catch (e) {
    console.error("[operator-agent] dry run failed:", errMsg(e));
    return reply(500, { error: "Operator couldn’t read your schedule. Please try again." });
  }
  if (!dry.ok) {
    if (dry.kind === "clarify") return reply(200, { status: "clarify", message: dry.message });
    await insertRun(ctx, instruction, "blocked", dry.message, { summary: plan.summary, plan, timezone: tz });
    return reply(200, { status: "blocked", message: dry.message });
  }
  const built = dry.steps;
  if (built.every((s) => plannedCount(s) === 0)) {
    const msg = `No matching jobs to change. ${built.map((s) => s.note).filter(Boolean).join(" ")}`.trim();
    await insertRun(ctx, instruction, "blocked", msg, { summary: plan.summary, plan, timezone: tz });
    return reply(200, { status: "blocked", message: msg });
  }
  if (!tzOk) for (const s of built) s.warnings.push("Your business timezone isn’t set, so UTC is used for “days”. Set it in Business Profile.");

  // ---- persist ledger, then register each step in the approval queue ----
  const run = await insertRun(ctx, instruction, "awaiting_approval", null, {
    summary: plan.summary, plan, timezone: tz, expires_at: iso(Date.now() + LIMITS.planTtlMinutes * 60_000),
  });
  try {
    const { data: stepIns, error: sErr } = await ctx.admin.from("operator_run_steps").insert(built.map((s, i) => ({
      run_id: run.id, user_id: ctx.actor.ownerId, step_key: s.key, position: i, tool: s.tool, title: s.title, params: s.params,
      warnings: s.warnings, affected_count: 0,
    }))).select("id, step_key");
    if (sErr) throw new Error(sErr.message);
    const stepId = new Map(((stepIns ?? []) as Row[]).map((r) => [r.step_key as string, r.id as string]));

    const effectRows = built.flatMap((s) => s.effects.map((e) => ({
      run_id: run.id, step_id: stepId.get(s.key)!, user_id: ctx.actor.ownerId, kind: e.kind, record_id: e.record_id,
      label: e.label, before: e.before, after: e.after, status: e.status, reason: e.reason,
    })));
    for (let i = 0; i < effectRows.length; i += 100) {
      const { error } = await ctx.admin.from("operator_run_effects").insert(effectRows.slice(i, i + 100));
      if (error) throw new Error(error.message);
    }

    const decorated: (BuiltStep & { needsApproval: boolean; reasons: string[] })[] = [];
    for (const s of built) {
      const affected = plannedCount(s);
      if (affected === 0) { decorated.push({ ...s, needsApproval: false, reasons: [] }); continue; }
      const forced = escalationReasons({ affected, targetDates: s.dates, today, warnings: s.warnings, daysBetween });
      const auth = await authorizeAgentAction(ctx.admin, {
        userId: ctx.actor.ownerId, actionSlug: TOOL_SLUG[s.tool], agentSource: OPERATOR_AGENT_SOURCE,
        targetTable: "operator_runs", targetId: `${run.id}:${s.key}`, reasoning: plan.summary,
        payload: { operator: { run_id: run.id, step_key: s.key, tool: s.tool, affected } }, correlationId: run.id,
      });
      if (auth.decision === "rejected") {
        await rejectPending(ctx, run.id);
        const message = `“${s.title}” is turned off in Agent Governance.`;
        await setRun(ctx, run.id, { status: "blocked", message });
        return reply(200, { status: "blocked", message });
      }
      let pending = auth.decision === "pending_approval";
      if (!pending && forced.length) {
        await ctx.admin.rpc("operator_force_pending", { p_log_id: auth.logId, p_reason: forced.join(" ") });
        pending = true;
      }
      await ctx.admin.from("operator_run_steps").update({ action_log_id: auth.logId, needs_approval: pending, approval_reasons: forced }).eq("id", stepId.get(s.key)!);
      decorated.push({ ...s, needsApproval: pending, reasons: forced });
    }
    const view = previewView(run.id, run.expires_at, plan.summary, tz, decorated);
    await setRun(ctx, run.id, { status: view.status });
    return reply(200, view);
  } catch (e) {
    console.error("[operator-agent] persisting plan failed:", errMsg(e));
    await rejectPending(ctx, run.id);
    await setRun(ctx, run.id, { status: "failed", message: "The plan could not be saved." });
    return reply(500, { error: "Operator couldn’t prepare that plan. Please try again." });
  }
}

// ---------------------------------------------------------------------
// EXECUTE
// ---------------------------------------------------------------------
async function loadRun(ctx: Ctx, runId: string): Promise<Row | null> {
  const { data } = await ctx.admin.from("operator_runs").select("*").eq("id", runId).eq("user_id", ctx.actor.ownerId).maybeSingle();
  const run = data as Row | null;
  if (!run) return null;
  // Only the requester (or the account owner) may act on a run.
  if (run.requested_by !== ctx.actor.userId && ctx.actor.userId !== ctx.actor.ownerId) return null;
  return run;
}

async function handleExecute(ctx: Ctx, body: Row): Promise<Response> {
  if (!isUuid(body.run_id)) return reply(400, { error: "run_id is required." });
  if (typeof body.approve !== "boolean") return reply(400, { error: "approve must be true or false." });
  const run = await loadRun(ctx, body.run_id);
  if (!run) return reply(404, { error: "Run not found." });
  const runId = run.id as string;

  if (!["awaiting_approval", "ready"].includes(run.status as string)) return reply(409, { error: `This run is already ${String(run.status).replace(/_/g, " ")}.` });

  if (body.approve === false) {
    await rejectPending(ctx, runId);
    await setRun(ctx, runId, { status: "cancelled", message: "Cancelled before anything ran." }).in("status", ["awaiting_approval", "ready"]);
    return reply(200, { status: "cancelled" });
  }
  if (Date.parse(run.expires_at as string) < Date.now()) {
    await rejectPending(ctx, runId);
    await setRun(ctx, runId, { status: "expired", message: "The preview expired. Ask again for a fresh one." }).in("status", ["awaiting_approval", "ready"]);
    return reply(410, { error: "That preview expired. Ask again to get a fresh one." });
  }

  // Authority is re-checked NOW: a stored plan is never trusted.
  const allowed = toolsAllowedFor(ctx.actor);
  const pre = await loadRunState(ctx, runId);
  if (pre.steps.some((s) => !allowed.has(s.tool))) return reply(403, { error: "Your permissions no longer allow this action." });

  await ctx.admin.rpc("operator_decide_run", { p_user_id: ctx.actor.ownerId, p_run_id: runId, p_approve: true, p_decided_by: ctx.actor.userId });
  const state = await loadRunState(ctx, runId); // re-read: governance statuses are the authority
  if (state.steps.some((s) => s.gov_status === "rejected")) {
    await setRun(ctx, runId, { status: "cancelled", message: "Rejected in Agent Governance." }).in("status", ["awaiting_approval", "ready"]);
    return reply(409, { error: "This plan was rejected in Agent Governance." });
  }
  if (state.steps.some((s) => s.action_log_id && s.gov_status === "pending_approval")) return reply(409, { error: "This plan still needs approval." });

  // Atomic claim: a double-click or a second tab cannot run it twice.
  const { data: claimed } = await ctx.admin.from("operator_runs")
    .update({ status: "running", approved_by: ctx.actor.userId, approved_at: new Date().toISOString(), started_at: new Date().toISOString() })
    .eq("id", runId).in("status", ["awaiting_approval", "ready"]).select("id");
  if (!claimed?.length) return reply(409, { error: "This run is already in progress." });

  // Optional autonomy budget (opt-in: no budget row = no extra limit).
  let sessionId: string | null = null;
  const { data: sid, error: sErr } = await ctx.admin.rpc("start_autonomy_session", { p_user_id: ctx.actor.ownerId, p_agent_source: OPERATOR_AGENT_SOURCE });
  if (sErr && !/No active autonomy budget/i.test(sErr.message)) {
    await setRun(ctx, runId, { status: "failed", finished_at: new Date().toISOString(), message: "The autonomy budget couldn’t be checked." });
    return reply(503, { error: "Operator couldn’t verify its autonomy budget. Nothing was changed." });
  }
  if (!sErr && typeof sid === "string") sessionId = sid;

  const tz = (run.timezone as string) || "UTC";
  let summary;
  try {
    summary = await executeRun(state, ctx.actor, runnerDeps(ctx, runId, tz, sessionId));
  } catch (e) {
    console.error("[operator-agent] execution crashed:", errMsg(e));
    await setRun(ctx, runId, { status: "failed", finished_at: new Date().toISOString(), message: "The run stopped unexpectedly. Check the activity log before retrying." });
    return reply(500, { error: "The run stopped unexpectedly. Some steps may have completed — check the activity log." });
  } finally {
    if (sessionId) await ctx.admin.rpc("end_autonomy_session", { p_session_id: sessionId });
  }

  await setRun(ctx, runId, { status: summary.status, finished_at: new Date().toISOString() });
  const undoable = state.effects.some((e) => e.kind !== "sms" && e.status === "applied");
  const problems = state.effects.filter((e) => ["failed", "skipped"].includes(e.status) && e.reason).slice(0, 10)
    .map((e) => ({ label: e.label, status: e.status, reason: e.reason }));
  return reply(200, { status: summary.status, run_id: runId, summary, problems, undo_available: undoable });
}

// ---------------------------------------------------------------------
// UNDO
// ---------------------------------------------------------------------
async function handleUndo(ctx: Ctx, body: Row): Promise<Response> {
  if (!isUuid(body.run_id)) return reply(400, { error: "run_id is required." });
  const run = await loadRun(ctx, body.run_id);
  if (!run) return reply(404, { error: "Run not found." });
  const runId = run.id as string;
  if (!["completed", "partial", "undo_partial"].includes(run.status as string)) return reply(409, { error: "Nothing to undo for this run." });
  const finished = Date.parse((run.finished_at as string) ?? (run.created_at as string));
  if (Date.now() - finished > LIMITS.undoWindowHours * 3_600_000) return reply(410, { error: `Undo is available for ${LIMITS.undoWindowHours} hours after a run.` });

  const { data: claimed } = await ctx.admin.from("operator_runs").update({ status: "undoing" })
    .eq("id", runId).in("status", ["completed", "partial", "undo_partial"]).select("id");
  if (!claimed?.length) return reply(409, { error: "An undo is already in progress." });

  const state = await loadRunState(ctx, runId);
  let result;
  try {
    result = await undoRun(state, ctx.actor, runnerDeps(ctx, runId, (run.timezone as string) || "UTC", null));
  } catch (e) {
    console.error("[operator-agent] undo crashed:", errMsg(e));
    await setRun(ctx, runId, { status: "undo_partial", message: "The undo stopped unexpectedly. Run it again to finish." });
    return reply(500, { error: "The undo stopped unexpectedly. Run it again to finish." });
  }
  const fullyUndone = state.steps.filter((s) => s.status === "undone" && s.action_log_id).map((s) => s.action_log_id as string);
  if (fullyUndone.length) await ctx.admin.rpc("operator_mark_rolled_back", { p_user_id: ctx.actor.ownerId, p_log_ids: fullyUndone, p_by: ctx.actor.userId });
  await setRun(ctx, runId, { status: result.status, undone_at: new Date().toISOString() });
  return reply(200, { status: result.status, summary: result });
}

// ---------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed." });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return reply(401, { error: "Missing Authorization header." });
    let body: Row;
    try {
      const parsed = await req.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Row;
    } catch {
      return reply(400, { error: "Invalid request body." });
    }

    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const db = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await db.auth.getUser();
    if (!user) return reply(401, { error: "Not authenticated." });
    const actor = await loadActor(db, user.id, user.email);
    if (!actor) return reply(403, { error: "Operator is available to the account owner and to team members who can view all jobs." });
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const ctx: Ctx = { db, admin, actor };

    switch (body.action) {
      case "plan": return await handlePlan(ctx, body);
      case "execute": return await handleExecute(ctx, body);
      case "undo": return await handleUndo(ctx, body);
      default: return reply(400, { error: "Unknown action." });
    }
  } catch (e) {
    console.error("[operator-agent] unhandled error:", e instanceof Error ? e.stack ?? e.message : e);
    return reply(500, { error: "Something went wrong. Please try again." });
  }
});
