// supabase/functions/_shared/operator/runner.ts
//
// Executes an APPROVED plan and undoes it. All I/O is injected (RunnerDeps) so
// the orchestration — permission re-check, per-step governance gate, budget,
// partial failure, "text only customers whose job really moved", compare-and-swap
// undo — is covered by unit tests without a database.
//
// Safety properties enforced here:
//  - a step runs only if its governance row is auto_approved / approved;
//  - the caller's permissions are re-checked at execution time (stored plans are not trusted);
//  - every job change goes through move_job with the preview-time snapshot as `expected`,
//    so anything that changed since the preview is skipped, never overwritten;
//  - an SMS is only sent for a job whose move was actually applied;
//  - an effect that crashed mid-send stays "running" and is never retried automatically.

import { formatClock, formatDay } from "./dates.ts";
import { renderTemplate } from "./plan.ts";
import { toolsAllowedFor } from "./policy.ts";
import { TOOL_SLUG, type Actor, type EffectRow, type StepRow } from "./types.ts";

export interface MoveResult { status: string; reason?: string; job?: Record<string, unknown> | null }
export interface SmsJob {
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  scheduled_datetime: string | null;
}
export type SmsResult = { ok: true; deferred: boolean; ref: string; sendAt?: string } | { ok: false; reason: string; detail?: string };

export interface RunnerDeps {
  tz: string;
  moveJob(jobId: string, patch: Record<string, unknown>, expected: Record<string, unknown>): Promise<MoveResult>;
  loadJob(jobId: string): Promise<SmsJob | null>;
  sendSms(job: SmsJob, body: string, dedupeKey: string): Promise<SmsResult>;
  saveEffect(e: EffectRow): Promise<void>;
  saveStep(s: StepRow): Promise<void>;
  recordOutcome(logId: string, status: "executed" | "failed", error?: string): Promise<void>;
  checkBudget(slug: string): Promise<{ allowed: boolean; reason?: string }>;
  now?: () => number;
}

export interface RunState { runId: string; steps: StepRow[]; effects: EffectRow[] }

export interface RunSummary {
  status: "completed" | "partial" | "failed";
  applied: number;
  failed: number;
  skipped: number;
  steps: { key: string; tool: string; status: string; applied: number; failed: number; skipped: number; error: string | null }[];
}

const GATE_OK = new Set(["auto_approved", "approved"]);
/** Refusals that are the system working as designed → skipped, not failed. */
const SAFE_REFUSALS = new Set(["stale", "conflict", "at_capacity", "blocked", "blocked_compliance", "not_found"]);
const HARD_STOP_SMS = new Set(["A2P_NOT_APPROVED", "NOT_CONFIGURED"]);

const count = (effs: EffectRow[], s: EffectRow["status"]) => effs.filter((e) => e.status === s).length;
const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

async function setEffect(deps: RunnerDeps, e: EffectRow, status: EffectRow["status"], reason: string | null = null, extra: Partial<EffectRow> = {}) {
  Object.assign(e, extra, { status, reason });
  await deps.saveEffect(e);
}

// ---------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------
export async function executeRun(state: RunState, actor: Actor, deps: RunnerDeps): Promise<RunSummary> {
  const allowed = toolsAllowedFor(actor);
  const ordered = [...state.steps].sort((a, b) => a.position - b.position);

  for (const step of ordered) {
    const effects = state.effects.filter((e) => e.step_id === step.id);

    const stop = async (status: StepRow["status"], error: string, logFail: boolean) => {
      for (const e of effects) if (e.status === "planned") await setEffect(deps, e, "skipped", error);
      step.status = status;
      step.error = error;
      await deps.saveStep(step);
      if (logFail && step.action_log_id) await deps.recordOutcome(step.action_log_id, "failed", error);
    };

    if (!GATE_OK.has(step.gov_status ?? "")) { await stop("skipped", "Not approved.", false); continue; }
    if (!allowed.has(step.tool)) { await stop("failed", "Your permissions don’t allow this action.", true); continue; }
    const budget = await deps.checkBudget(TOOL_SLUG[step.tool]);
    if (!budget.allowed) { await stop("blocked", budget.reason ?? "Autonomy budget reached.", true); continue; }

    step.status = "running";
    await deps.saveStep(step);
    try {
      if (step.tool === "message_customers") await runSms(state, step, effects, deps);
      else await runMoves(step, effects, deps);
    } catch (err) {
      for (const e of effects) if (e.status === "planned") await setEffect(deps, e, "skipped", "Stopped after an unexpected error.");
      step.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    }

    const applied = count(effects, "applied");
    const bad = count(effects, "failed") + count(effects, "skipped") + count(effects, "running");
    step.affected_count = applied;
    step.status = applied > 0 && bad === 0 ? "succeeded" : applied > 0 ? "partial" : effects.length ? "failed" : "skipped";
    if (step.status !== "succeeded" && !step.error) {
      step.error = effects.find((e) => e.reason && e.status !== "applied")?.reason ?? null;
    }
    await deps.saveStep(step);
    if (step.action_log_id) {
      await deps.recordOutcome(step.action_log_id, applied > 0 ? "executed" : "failed", applied > 0 ? undefined : step.error ?? "Nothing was applied.");
    }
  }

  return summarize(state, ordered);
}

async function runMoves(step: StepRow, effects: EffectRow[], deps: RunnerDeps) {
  let halted: string | null = null;
  for (const e of effects) {
    if (e.status !== "planned") continue;
    if (halted) { await setEffect(deps, e, "skipped", halted); continue; }

    const reschedule = e.kind === "job_reschedule";
    const patch = reschedule
      ? { scheduled_datetime: e.after.scheduled_datetime }
      : { assigned_technician_id: e.after.assigned_technician_id };
    const expected = {
      scheduled_datetime: e.before.scheduled_datetime ?? null,
      assigned_technician_id: e.before.assigned_technician_id ?? null,
      job_status: e.before.job_status,
    };

    await setEffect(deps, e, "running");
    let res: MoveResult;
    try {
      res = await deps.moveJob(e.record_id, patch, expected);
    } catch (err) {
      res = { status: "error", reason: err instanceof Error ? err.message.slice(0, 200) : "Unexpected error." };
    }

    if (res.status === "moved") {
      const j = res.job ?? null;
      await setEffect(deps, e, "applied", null, {
        after: {
          scheduled_datetime: asStr(j?.scheduled_datetime) ?? e.after.scheduled_datetime ?? null,
          assigned_technician_id: j ? (j.assigned_technician_id as string | null) ?? null : e.after.assigned_technician_id ?? null,
        },
      });
    } else if (SAFE_REFUSALS.has(res.status) || res.status === "forbidden") {
      await setEffect(deps, e, "skipped", res.reason ?? res.status);
      if (res.status === "forbidden") halted = "Stopped: permission denied.";
    } else {
      await setEffect(deps, e, "failed", res.reason ?? "The change could not be saved.");
    }
  }
}

async function runSms(state: RunState, step: StepRow, effects: EffectRow[], deps: RunnerDeps) {
  const template = asStr(step.params.body) ?? "";
  const src = state.steps.find((s) => s.step_key === step.params.from_step);
  const srcEffects = src ? state.effects.filter((e) => e.step_id === src.id) : [];
  const srcIsReschedule = src?.tool === "reschedule_jobs";
  let halted: string | null = null;

  for (const e of effects) {
    if (e.status !== "planned") continue;
    if (halted) { await setEffect(deps, e, "skipped", halted); continue; }

    const moved = srcEffects.find((x) => x.record_id === e.record_id);
    if (!moved || moved.status !== "applied") {
      await setEffect(deps, e, "skipped", "The job wasn’t changed, so no text was sent.");
      continue;
    }
    const job = await deps.loadJob(e.record_id);
    if (!job || !job.customer_phone) { await setEffect(deps, e, "skipped", "No phone number on file."); continue; }
    const when = Date.parse(job.scheduled_datetime ?? asStr(moved.after.scheduled_datetime) ?? "");
    if (Number.isNaN(when)) { await setEffect(deps, e, "skipped", "The job has no scheduled time."); continue; }
    const oldMs = srcIsReschedule ? Date.parse(asStr(moved.before.scheduled_datetime) ?? "") : NaN;

    const message = renderTemplate(template, {
      first_name: job.customer_name,
      new_date: formatDay(when, deps.tz),
      new_time: formatClock(when, deps.tz),
      old_date: Number.isNaN(oldMs) ? null : formatDay(oldMs, deps.tz),
    });

    await setEffect(deps, e, "running"); // claimed: a crash from here on is never retried automatically
    let res: SmsResult;
    try {
      res = await deps.sendSms(job, message, `operator:${state.runId}:${e.id}`);
    } catch (err) {
      res = { ok: false, reason: "ERROR", detail: err instanceof Error ? err.message.slice(0, 200) : "Unexpected error." };
    }

    if (res.ok) {
      await setEffect(deps, e, "applied", res.deferred ? `Queued for ${res.sendAt ?? "later"} (quiet hours).` : null, {
        external_ref: res.ref,
        after: { message },
      });
    } else if (res.reason === "OPTED_OUT") {
      await setEffect(deps, e, "skipped", "Customer opted out of texts.");
    } else {
      await setEffect(deps, e, "failed", `Text not sent: ${res.detail ?? res.reason}`);
      if (HARD_STOP_SMS.has(res.reason)) halted = "Stopped: texting isn’t set up for this account.";
    }
  }
}

function summarize(state: RunState, ordered: StepRow[]): RunSummary {
  const steps = ordered.map((s) => {
    const effs = state.effects.filter((e) => e.step_id === s.id);
    return {
      key: s.step_key, tool: s.tool, status: s.status,
      applied: count(effs, "applied"), failed: count(effs, "failed"), skipped: count(effs, "skipped"), error: s.error,
    };
  });
  const applied = steps.reduce((n, s) => n + s.applied, 0);
  const failed = steps.reduce((n, s) => n + s.failed, 0);
  const skipped = steps.reduce((n, s) => n + s.skipped, 0);
  const status = applied === 0 ? "failed" : steps.every((s) => s.status === "succeeded") ? "completed" : "partial";
  return { status, applied, failed, skipped, steps };
}

// ---------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------
export interface UndoSummary { status: "undone" | "undo_partial"; undone: number; failed: number; irreversible: number; steps: { key: string; status: string }[] }

export async function undoRun(state: RunState, actor: Actor, deps: RunnerDeps): Promise<UndoSummary> {
  const allowed = toolsAllowedFor(actor);
  let undone = 0, failed = 0, irreversible = 0;
  const stepStatus: UndoSummary["steps"] = [];

  for (const step of [...state.steps].sort((a, b) => b.position - a.position)) {
    const applied = state.effects.filter((e) => e.step_id === step.id && e.status === "applied");

    if (step.tool === "message_customers") {
      for (const e of applied) { await setEffect(deps, e, "irreversible", "A text that was already sent can’t be recalled."); irreversible++; }
      continue;
    }

    let stepFailed = 0;
    for (const e of applied) {
      if (!allowed.has(step.tool)) { await setEffect(deps, e, "undo_failed", "Your permissions don’t allow this action."); failed++; stepFailed++; continue; }
      const reschedule = e.kind === "job_reschedule";
      const patch = reschedule
        ? { scheduled_datetime: e.before.scheduled_datetime ?? null }
        : { assigned_technician_id: e.before.assigned_technician_id ?? null };
      const expected = reschedule
        ? { scheduled_datetime: e.after.scheduled_datetime, job_status: e.before.job_status }
        : { assigned_technician_id: e.after.assigned_technician_id, job_status: e.before.job_status };

      let res: MoveResult;
      try {
        res = await deps.moveJob(e.record_id, patch, expected);
      } catch (err) {
        res = { status: "error", reason: err instanceof Error ? err.message.slice(0, 200) : "Unexpected error." };
      }
      if (res.status === "moved") { await setEffect(deps, e, "undone", null); undone++; }
      else {
        const why = res.status === "stale" ? "Changed since the run, so it was left as it is." : res.reason ?? "Could not be restored.";
        await setEffect(deps, e, "undo_failed", why);
        failed++; stepFailed++;
      }
    }
    if (applied.length) {
      step.status = stepFailed === 0 ? "undone" : "undo_partial";
      await deps.saveStep(step);
      stepStatus.push({ key: step.step_key, status: step.status });
    }
  }
  return { status: failed === 0 ? "undone" : "undo_partial", undone, failed, irreversible, steps: stepStatus };
}
