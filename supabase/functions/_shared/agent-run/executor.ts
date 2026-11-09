// supabase/functions/_shared/agent-run/executor.ts
//
// THE single governed path for agent tool calls. Order of checks for every call:
//
//   registered tool → JSON-schema args → scope (granted by code) → tenant ownership
//   → circuit breaker → entity lease (customer contact) → ledger begin
//       (idempotent replay · budget · deadline · crash reconcile · backoff · approval expiry)
//   → governance (authorizeAgentAction)  → execute (timeout)
//   → governance outcome → deterministic verify → ledger finish
//
// Crash-safety argument: the ONLY window where an effect exists but the ledger doesn't know is
// between tool.execute() resolving and store.finishStep(). A step left `in_flight` past the stale
// timeout is returned by SQL agent_step_begin as `reconcile`; we then (1) ask tool.verify() in
// lookup mode, and (2) otherwise re-execute with the SAME idempotency key, which the provider
// dedupes (provider_key). Registry invariants make one of the two always available.

import { backoffMs, classifyError, hashInput, sanitizeResult, stepIdempotencyKey, ToolTimeoutError, type ErrorClass } from "./core.ts";
import { validateAgainstSchema } from "./jsonSchema.ts";
import type { ToolContext, ToolDef, ToolRegistry } from "./toolRegistry.ts";
import type { RunHandle, RunStatus, RunStore, Verification } from "./store.ts";

export interface GovernancePort {
  authorize(p: {
    userId: string;
    actionSlug: string;
    agentSource: string;
    targetTable?: string;
    targetId?: string;
    amountCents?: number;
    reasoning?: string;
    payload?: Record<string, unknown>;
    correlationId?: string;
  }): Promise<{ decision: "auto_approved" | "approved" | "pending_approval" | "rejected"; logId: string; existing: boolean }>;
  recordOutcome(logId: string, outcome: { status: "executed" | "failed"; error?: string; afterState?: Record<string, unknown> }): Promise<void>;
}

export interface EscalationInfo {
  run: RunHandle;
  stepIndex: number;
  tool: string;
  reason: string;
  errorClass: ErrorClass;
  deadLetter: boolean;
  context: Record<string, unknown>;
}

export interface RuntimeDeps {
  store: RunStore;
  registry: ToolRegistry;
  governance: GovernancePort;
  /** True only if the row exists AND belongs to userId. Implemented with tenantScope.ownsRow. */
  ownsRow(userId: string, table: string, id: string): Promise<boolean>;
  /** Creates the human task (create_agent_task) with full context. Must be idempotent per run+step. */
  escalate(info: EscalationInfo): Promise<void>;
  log?(event: string, fields: Record<string, unknown>): void;
  now?(): number;
  rng?(): number;
}

export type StepOutcome =
  | { kind: "ok"; result: Record<string, unknown>; replayed: boolean; recovered?: boolean }
  | { kind: "awaiting_approval"; logId: string }
  | { kind: "blocked"; reason: string; errorClass: ErrorClass }
  | { kind: "retry_later"; reason: string; retryAt?: Date }
  | { kind: "escalate"; reason: string; errorClass: ErrorClass; deadLetter?: boolean };

const defaultLog = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }));

function withTimeout<T>(p: Promise<T>, ms: number, name: string, ac: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new ToolTimeoutError(name, ms));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function runTool(
  deps: RuntimeDeps,
  run: RunHandle,
  call: { tool: string; rawArgs: unknown; stepIndex: number; reasoning?: string },
): Promise<StepOutcome> {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? Date.now;
  const rng = deps.rng ?? Math.random;
  const base = { run_id: run.runId, step: call.stepIndex, tool: call.tool, correlation_id: run.correlationId, user_id: run.userId };

  // 1. registered tool
  const tool = deps.registry.get(call.tool) as ToolDef<any> | undefined;
  if (!tool) {
    log("agent_tool_unregistered", base);
    return { kind: "blocked", reason: "unknown_tool", errorClass: "policy_blocked" };
  }

  // 2. schema validation (model output is untrusted)
  const v = validateAgainstSchema(call.rawArgs, tool.params);
  if (!v.ok) {
    log("agent_tool_invalid_args", { ...base, errors: v.errors.slice(0, 5) });
    return { kind: "blocked", reason: `invalid_args: ${v.errors[0]}`, errorClass: "ambiguous_input" };
  }
  const args = v.value;

  // 3. scope — granted by code at run start; the model cannot widen it
  if (!run.scopes.includes(tool.requiredScope)) {
    log("agent_tool_scope_denied", { ...base, scope: tool.requiredScope });
    return { kind: "blocked", reason: `scope_denied:${tool.requiredScope}`, errorClass: "policy_blocked" };
  }

  // 4. tenant ownership of every referenced row
  const refs = [tool.target?.(args), tool.leaseEntity?.(args)].filter((x): x is { table: string; id: string; virtual?: boolean } => Boolean(x) && !(x as { virtual?: boolean }).virtual);
  for (const ref of refs) {
    if (!(await deps.ownsRow(run.userId, ref.table, ref.id))) {
      log("agent_tool_ownership_failed", { ...base, table: ref.table });
      return { kind: "blocked", reason: "ownership_failed", errorClass: "policy_blocked" };
    }
  }

  // 5. circuit breaker (per provider)
  const circuit = await deps.store.circuitAllow(tool.provider);
  if (!circuit.allowed) {
    log("agent_circuit_open", { ...base, provider: tool.provider });
    return { kind: "retry_later", reason: `circuit_open:${tool.provider}`, retryAt: circuit.retryAt ? new Date(circuit.retryAt) : undefined };
  }

  // 6. entity lease — two agents never act on one customer at the same time
  const lease = tool.leaseEntity?.(args) ?? null;
  const holder = `${run.agentSource}:${run.runId}`;
  if (lease) {
    const got = await deps.store.acquireLease({
      userId: run.userId, entityTable: lease.table, entityId: lease.id, holder, runId: run.runId,
      ttlSeconds: Math.ceil(tool.timeoutMs / 1000) + 30,
    });
    if (!got.acquired) {
      log("agent_lease_denied", { ...base, entity: lease.table, held_by: got.holder });
      return { kind: "retry_later", reason: "entity_leased" };
    }
  }

  try {
    return await runLeased(deps, run, tool, args, call, base, { log, now, rng });
  } finally {
    if (lease) await deps.store.releaseLease({ userId: run.userId, entityTable: lease.table, entityId: lease.id, holder });
  }
}

async function runLeased(
  deps: RuntimeDeps,
  run: RunHandle,
  tool: ToolDef<any>,
  args: Record<string, unknown>,
  call: { stepIndex: number; reasoning?: string },
  base: Record<string, unknown>,
  h: { log: (e: string, f: Record<string, unknown>) => void; now: () => number; rng: () => number },
): Promise<StepOutcome> {
  const { store } = deps;
  const isContact = tool.risk === "customer_contact";
  const projectedCost = tool.estimateCostCents?.(args) ?? 0;

  // Budget/deadline are enforced atomically by SQL agent_step_begin under the run row lock
  // (core.checkBudget mirrors that logic for planners and tests).
  const key = stepIdempotencyKey(run.runId, call.stepIndex, tool.name);
  const inputHash = await hashInput(args);

  const begin = await store.beginStep({
    run, stepIndex: call.stepIndex, tool: tool.name, idempotencyKey: key, inputHash, input: args,
    maxAttempts: tool.retry.maxAttempts, projectedCostCents: projectedCost, isContact,
  });

  switch (begin.action) {
    case "replay":
      h.log("agent_step_replayed", base);
      return { kind: "ok", result: begin.result, replayed: true };
    case "in_flight":
      return { kind: "retry_later", reason: "step_in_flight" };
    case "backoff":
      return { kind: "retry_later", reason: "backoff", retryAt: new Date(begin.retryAt) };
    case "exhausted":
      return { kind: "escalate", reason: "retries_exhausted", errorClass: "transient", deadLetter: true };
    case "terminal":
      return begin.status === "blocked"
        ? { kind: "blocked", reason: begin.error ?? "blocked", errorClass: begin.errorClass ?? "policy_blocked" }
        : { kind: "escalate", reason: begin.error ?? begin.status, errorClass: begin.errorClass ?? "permanent" };
    case "approval_expired":
      return { kind: "blocked", reason: "approval_expired", errorClass: "policy_blocked" };
    case "budget_exceeded":
      h.log("agent_budget_exceeded", { ...base, reason: begin.reason });
      return { kind: "escalate", reason: `budget:${begin.reason}`, errorClass: "policy_blocked" };
    case "run_closed":
      return { kind: "blocked", reason: `run_${begin.runStatus}`, errorClass: "policy_blocked" };
    case "conflict":
      h.log("agent_idempotency_conflict", base);
      return { kind: "blocked", reason: "idempotency_key_conflict", errorClass: "ambiguous_input" };
    case "execute":
    case "reconcile":
      break;
  }

  const stepId = begin.stepId;
  const attempt = begin.attempt;
  const ac = new AbortController();
  const ctx: ToolContext = {
    userId: run.userId, runId: run.runId, stepIndex: call.stepIndex, idempotencyKey: key,
    correlationId: run.correlationId, runStartedAt: run.createdAtMs, attempt, signal: ac.signal,
  };
  const target = tool.target?.(args) ?? null;
  const finishRetry = async (c: { errorClass: ErrorClass; maybeExecuted: boolean; message: string; providerFault?: boolean }): Promise<StepOutcome> => {
    if (attempt >= tool.retry.maxAttempts) {
      await store.finishStep({ stepId, userId: run.userId, status: "needs_human", errorClass: c.errorClass, error: c.message, maybeExecuted: c.maybeExecuted });
      return { kind: "escalate", reason: c.message, errorClass: c.errorClass, deadLetter: true };
    }
    const retryAt = new Date(h.now() + backoffMs(attempt, tool.retry, h.rng));
    await store.finishStep({ stepId, userId: run.userId, status: "failed_retryable", errorClass: c.errorClass, error: c.message, nextRetryAt: retryAt, maybeExecuted: c.maybeExecuted });
    return { kind: "retry_later", reason: c.message, retryAt };
  };

  // 7. crash/timeout reconcile: did the effect already happen?
  if (begin.action === "reconcile" && tool.verify) {
    try {
      const found = await tool.verify(args, null, ctx);
      if (found.ok) {
        const result = sanitizeResult(found.result ?? { recovered: true });
        await store.finishStep({ stepId, userId: run.userId, status: "succeeded", result, verification: "verified", costCents: projectedCost, isContact });
        if (begin.actionLogId) await deps.governance.recordOutcome(begin.actionLogId, { status: "executed", afterState: { recovered: true } });
        h.log("agent_step_recovered", base);
        return { kind: "ok", result, replayed: true, recovered: true };
      }
    } catch (e) {
      // lookup itself failed → we cannot prove either way; never guess for money/contact
      const c = classifyError(e);
      if (tool.risk === "money_moving" || isContact) return finishRetry({ ...c, maybeExecuted: true });
    }
  }

  // 8. governance — mandatory for every side effect
  let logId = begin.actionLogId ?? null;
  const needAuth = Boolean(tool.governanceSlug) && (!logId || (begin.action === "execute" && begin.wasAwaitingApproval));
  if (needAuth) {
    try {
      const auth = await deps.governance.authorize({
        userId: run.userId,
        actionSlug: tool.governanceSlug as string,
        agentSource: run.agentSource,
        targetTable: target?.table,
        targetId: target?.id,
        amountCents: tool.amountCents?.(args),
        reasoning: call.reasoning ?? `${tool.name} (run ${run.runId} step ${call.stepIndex})`,
        payload: { tool: tool.name, step_key: key, args_hash: inputHash },
        correlationId: run.correlationId,
      });
      logId = auth.logId;
      await store.attachActionLog(stepId, run.userId, auth.logId);
      if (auth.decision === "pending_approval") {
        await store.finishStep({ stepId, userId: run.userId, status: "awaiting_approval" });
        return { kind: "awaiting_approval", logId: auth.logId };
      }
      if (auth.decision === "rejected") {
        await store.finishStep({ stepId, userId: run.userId, status: "blocked", errorClass: "policy_blocked", error: "governance_rejected" });
        return { kind: "blocked", reason: "governance_rejected", errorClass: "policy_blocked" };
      }
    } catch (e) {
      // Governance fails CLOSED: nothing executed, safe to retry later.
      return finishRetry({ errorClass: "dependency_down", maybeExecuted: false, message: `governance_unavailable: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // 9. execute
  let result: Record<string, unknown>;
  try {
    result = sanitizeResult(await withTimeout(tool.execute(args, ctx), tool.timeoutMs, tool.name, ac));
  } catch (e) {
    const c = classifyError(e);
    if (logId) await deps.governance.recordOutcome(logId, { status: "failed", error: c.message.slice(0, 500) });
    h.log("agent_tool_failed", { ...base, error_class: c.errorClass, maybe_executed: c.maybeExecuted, attempt });

    if (c.errorClass === "transient" || c.errorClass === "dependency_down") {
      if (c.providerFault) await store.circuitRecord(tool.provider, false);
      return finishRetry(c);
    }
    if (c.errorClass === "policy_blocked") {
      await store.finishStep({ stepId, userId: run.userId, status: "blocked", errorClass: c.errorClass, error: c.message });
      return { kind: "blocked", reason: c.message, errorClass: c.errorClass };
    }
    // permanent / ambiguous_input → a human decides (we never auto-retry a possibly-executed money/contact call)
    await store.finishStep({ stepId, userId: run.userId, status: "needs_human", errorClass: c.errorClass, error: c.message, maybeExecuted: c.maybeExecuted });
    return { kind: "escalate", reason: c.message, errorClass: c.errorClass };
  }
  await store.circuitRecord(tool.provider, true);
  if (logId) await deps.governance.recordOutcome(logId, { status: "executed", afterState: { step_key: key } });

  // 10. deterministic verification (never an LLM check)
  let verification: Verification = "not_required";
  if (tool.risk !== "read" && tool.verify) {
    let ver: Awaited<ReturnType<NonNullable<typeof tool.verify>>>;
    try {
      ver = await tool.verify(args, result, ctx);
    } catch (e) {
      ver = { ok: false, pending: true, reason: `verify_unavailable: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (ver.ok) {
      verification = "verified";
      if (ver.result) result = { ...result, ...sanitizeResult(ver.result) };
    } else if (ver.pending) {
      verification = "pending"; // e.g. SMS delivery receipt arrives later; swept asynchronously
    } else {
      h.log("agent_verification_failed", { ...base, reason: ver.reason });
      if (logId) await deps.governance.recordOutcome(logId, { status: "failed", error: `verification_failed: ${ver.reason}`.slice(0, 500) });
      if (tool.risk === "reversible_write") {
        let compensated = false;
        if (tool.compensate) {
          try { await tool.compensate(args, result, ctx); compensated = true; } catch { /* escalate below */ }
        }
        if (compensated) return finishRetry({ errorClass: "transient", maybeExecuted: false, message: `verification_failed_compensated: ${ver.reason}` });
      }
      // money / contact / irreversible: never blindly retry — a human sees the evidence
      await store.finishStep({ stepId, userId: run.userId, status: "needs_human", errorClass: "ambiguous_input", error: `verification_failed: ${ver.reason}`, maybeExecuted: true, verification: "failed" });
      return { kind: "escalate", reason: `verification_failed: ${ver.reason}`, errorClass: "ambiguous_input" };
    }
  }

  await store.finishStep({ stepId, userId: run.userId, status: "succeeded", result, verification, costCents: projectedCost, isContact });
  return { kind: "ok", result, replayed: false };
}

// ---------------------------------------------------------------------------
// Plan runner — bounded, resumable by re-walking (completed steps replay for free)
// ---------------------------------------------------------------------------
export interface PlannedStep {
  tool: string;
  args: unknown;
  reasoning?: string;
}
export interface StepRecord {
  index: number;
  tool: string;
  outcome: StepOutcome;
}
export type PlanOutcome =
  | { status: "succeeded"; history: StepRecord[] }
  | { status: "awaiting_approval"; history: StepRecord[] }
  | { status: "parked"; reason: string; history: StepRecord[] }
  | { status: "failed" | "cancelled" | "escalated" | "dead_letter"; reason: string; history: StepRecord[] };

const HARD_STEP_CAP = 50;

/**
 * `next(history)` MUST be deterministic given the stored results (it is re-invoked from step 0 on
 * resume). Completed steps return their stored result via ledger replay without executing again.
 */
export async function runPlan(
  deps: RuntimeDeps,
  run: RunHandle,
  next: (history: StepRecord[]) => PlannedStep | null,
): Promise<PlanOutcome> {
  const history: StepRecord[] = [];
  const finish = async (status: RunStatus, reason?: string) => deps.store.finishRun(run.runId, run.userId, status, reason);

  for (let i = 0; i < HARD_STEP_CAP; i++) {
    const step = next(history);
    if (!step) {
      await finish("succeeded");
      return { status: "succeeded", history };
    }
    const outcome = await runTool(deps, run, { tool: step.tool, rawArgs: step.args, stepIndex: i, reasoning: step.reasoning });
    history.push({ index: i, tool: step.tool, outcome });

    switch (outcome.kind) {
      case "ok":
        continue;
      case "awaiting_approval":
        await finish("awaiting_approval", "awaiting_approval");
        return { status: "awaiting_approval", history };
      case "retry_later":
        // leave the run 'running'; the next cron tick (same trigger_ref) resumes at this step
        return { status: "parked", reason: outcome.reason, history };
      case "blocked": {
        const status: RunStatus = outcome.errorClass === "policy_blocked" ? "cancelled" : "failed";
        await finish(status, outcome.reason);
        return { status, reason: outcome.reason, history };
      }
      case "escalate": {
        await deps.escalate({
          run, stepIndex: i, tool: step.tool, reason: outcome.reason, errorClass: outcome.errorClass,
          deadLetter: Boolean(outcome.deadLetter),
          context: { history: history.map((h) => ({ index: h.index, tool: h.tool, kind: h.outcome.kind })) },
        });
        const status: RunStatus = outcome.deadLetter ? "dead_letter" : "escalated";
        await finish(status, outcome.reason);
        return { status, reason: outcome.reason, history };
      }
    }
  }
  await finish("escalated", "plan_exceeded_hard_step_cap");
  return { status: "escalated", reason: "plan_exceeded_hard_step_cap", history };
}
