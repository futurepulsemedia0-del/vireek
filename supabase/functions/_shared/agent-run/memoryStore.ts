// supabase/functions/_shared/agent-run/memoryStore.ts
//
// TEST-ONLY. In-memory implementation of RunStore that mirrors the semantics of the SQL in
// 20281116000000_agent_run_runtime.sql (same actions, same budget/lease/breaker rules), plus a
// controllable clock. Fault-injection tests run against this; the SQL itself still needs the
// integration run listed in the report (NOT RUN without a Postgres).

import type {
  BeginResult, BeginStepParams, FinishStepParams, LeaseParams, RunHandle, RunStatus, RunStore, StartRunParams,
} from "./store.ts";
import type { GovernancePort } from "./executor.ts";

interface StepRow {
  id: string; runId: string; userId: string; index: number; tool: string; key: string; inputHash: string;
  status: string; attempt: number; maybeExecuted: boolean; result?: Record<string, unknown>;
  errorClass: string | null; error: string | null; actionLogId: string | null;
  nextRetryAt: number | null; updatedAt: number; verification: string;
}
interface RunRow {
  id: string; userId: string; agentSource: string; triggerRef?: string; correlationId: string;
  status: RunStatus; scopes: string[]; limits: Record<string, number>;
  usage: { steps: number; cost_cents: number; tokens: number; contacts: number }; deadlineAt: number; createdAt: number; stopReason?: string;
}

export class Clock {
  constructor(public t = 1_700_000_000_000) {}
  now = () => this.t;
  advance(ms: number) { this.t += ms; }
}

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

export class InMemoryRunStore implements RunStore {
  runs = new Map<string, RunRow>();
  steps = new Map<string, StepRow>();
  leases = new Map<string, { holder: string; expiresAt: number }>();
  breakers = new Map<string, { state: "closed" | "open" | "half_open"; failures: number; openUntil: number }>();
  staleAfterMs = 120_000;
  approvalTtlMs = 86_400_000;
  breakerThreshold = 5;
  breakerCooldownMs = 60_000;

  constructor(public clock: Clock = new Clock()) {}

  private handle(r: RunRow, created: boolean): RunHandle {
    return {
      runId: r.id, userId: r.userId, agentSource: r.agentSource, correlationId: r.correlationId,
      scopes: [...r.scopes], limits: { ...r.limits }, usage: { ...r.usage }, deadlineAt: r.deadlineAt, createdAtMs: r.createdAt, created, status: r.status,
    };
  }

  async startRun(p: StartRunParams): Promise<RunHandle> {
    if (p.triggerRef) {
      for (const r of this.runs.values()) {
        if (r.userId === p.userId && r.agentSource === p.agentSource && r.triggerRef === p.triggerRef) return this.handle(r, false);
      }
    }
    const r: RunRow = {
      id: uid("run"), userId: p.userId, agentSource: p.agentSource, triggerRef: p.triggerRef, correlationId: p.correlationId,
      status: "running", scopes: [...p.scopes], limits: { ...(p.limits as Record<string, number>) },
      usage: { steps: 0, cost_cents: 0, tokens: 0, contacts: 0 },
      deadlineAt: this.clock.now() + (p.deadlineSeconds ?? 300) * 1000, createdAt: this.clock.now(),
    };
    this.runs.set(r.id, r);
    return this.handle(r, true);
  }

  async beginStep(p: BeginStepParams): Promise<BeginResult> {
    const run = this.runs.get(p.run.runId);
    if (!run || run.userId !== p.run.userId) throw new Error("agent_step_begin: run not found for tenant");
    if (run.status !== "running" && run.status !== "awaiting_approval") return { action: "run_closed", runStatus: run.status };
    const now = this.clock.now();

    const step = [...this.steps.values()].find((s) => s.userId === run.userId && s.key === p.idempotencyKey);
    if (step) {
      if (step.inputHash !== p.inputHash) return { action: "conflict", stepId: step.id };
      if (step.status === "succeeded") return { action: "replay", stepId: step.id, result: step.result ?? {} };
      if (["failed_permanent", "blocked", "needs_human"].includes(step.status)) {
        return { action: "terminal", stepId: step.id, status: step.status, errorClass: step.errorClass as never, error: step.error };
      }
      if (step.status === "in_flight") {
        if (step.updatedAt > now - this.staleAfterMs) return { action: "in_flight", stepId: step.id };
        step.updatedAt = now; step.maybeExecuted = true;
        return { action: "reconcile", stepId: step.id, attempt: step.attempt, actionLogId: step.actionLogId };
      }
      if (step.status === "awaiting_approval") {
        if (step.updatedAt < now - this.approvalTtlMs) {
          step.status = "blocked"; step.errorClass = "policy_blocked"; step.error = "approval_expired";
          return { action: "approval_expired", stepId: step.id };
        }
        step.status = "in_flight"; step.updatedAt = now; run.status = "running";
        return { action: "execute", stepId: step.id, attempt: step.attempt, actionLogId: step.actionLogId, wasAwaitingApproval: true };
      }
      if (step.status === "failed_retryable") {
        if (step.attempt >= Math.max(p.maxAttempts, 1)) return { action: "exhausted", stepId: step.id };
        if (step.nextRetryAt !== null && step.nextRetryAt > now) return { action: "backoff", stepId: step.id, retryAt: new Date(step.nextRetryAt).toISOString() };
        step.status = "in_flight"; step.attempt += 1; step.updatedAt = now;
        return step.maybeExecuted
          ? { action: "reconcile", stepId: step.id, attempt: step.attempt, actionLogId: step.actionLogId }
          : { action: "execute", stepId: step.id, attempt: step.attempt, actionLogId: step.actionLogId };
      }
    }

    if (now > run.deadlineAt) return { action: "budget_exceeded", reason: "wall_clock" };
    const l = run.limits, u = run.usage;
    if (l.max_steps !== undefined && u.steps + 1 > l.max_steps) return { action: "budget_exceeded", reason: "max_steps" };
    if (l.max_cost_cents !== undefined && u.cost_cents + Math.max(p.projectedCostCents, 0) > l.max_cost_cents) return { action: "budget_exceeded", reason: "max_cost" };
    if (p.isContact && l.max_contacts !== undefined && u.contacts + 1 > l.max_contacts) return { action: "budget_exceeded", reason: "max_contacts" };

    const row: StepRow = {
      id: uid("step"), runId: run.id, userId: run.userId, index: p.stepIndex, tool: p.tool, key: p.idempotencyKey,
      inputHash: p.inputHash, status: "in_flight", attempt: 1, maybeExecuted: false, errorClass: null, error: null,
      actionLogId: null, nextRetryAt: null, updatedAt: now, verification: "not_required",
    };
    this.steps.set(row.id, row);
    return { action: "execute", stepId: row.id, attempt: 1 };
  }

  async attachActionLog(stepId: string, userId: string, logId: string) {
    const s = this.steps.get(stepId);
    if (s && s.userId === userId) s.actionLogId = logId;
  }

  async finishStep(p: FinishStepParams) {
    const s = this.steps.get(p.stepId);
    if (!s || s.userId !== p.userId) throw new Error("agent_step_finish: step not found for tenant");
    if (s.status === "succeeded") return; // no double count / overwrite
    s.status = p.status; s.errorClass = p.errorClass ?? null; s.error = p.error ?? null;
    s.nextRetryAt = p.nextRetryAt ? p.nextRetryAt.getTime() : null;
    s.maybeExecuted = p.status === "succeeded" ? false : Boolean(p.maybeExecuted);
    s.verification = p.verification ?? "not_required";
    s.updatedAt = this.clock.now();
    if (p.status === "succeeded") {
      s.result = p.result;
      const run = this.runs.get(s.runId)!;
      run.usage.steps += 1; run.usage.cost_cents += Math.max(p.costCents ?? 0, 0);
      run.usage.tokens += Math.max(p.tokens ?? 0, 0); run.usage.contacts += p.isContact ? 1 : 0;
    } else if (p.status === "awaiting_approval") {
      const run = this.runs.get(s.runId)!;
      if (run.status === "running") run.status = "awaiting_approval";
    }
  }

  async finishRun(runId: string, userId: string, status: RunStatus, reason?: string) {
    const r = this.runs.get(runId);
    if (r && r.userId === userId && (r.status === "running" || r.status === "awaiting_approval")) { r.status = status; r.stopReason = reason; }
  }

  async acquireLease(p: LeaseParams) {
    const k = `${p.userId}|${p.entityTable}|${p.entityId}`;
    const cur = this.leases.get(k);
    const now = this.clock.now();
    if (!cur || cur.expiresAt <= now || cur.holder === p.holder) {
      this.leases.set(k, { holder: p.holder, expiresAt: now + Math.max(5, Math.min(p.ttlSeconds, 3600)) * 1000 });
      return { acquired: true, holder: p.holder };
    }
    return { acquired: false, holder: cur.holder };
  }

  async releaseLease(p: { userId: string; entityTable: string; entityId: string; holder: string }) {
    const k = `${p.userId}|${p.entityTable}|${p.entityId}`;
    if (this.leases.get(k)?.holder === p.holder) this.leases.delete(k);
  }

  async circuitAllow(provider: string) {
    const now = this.clock.now();
    const cb = this.breakers.get(provider) ?? { state: "closed" as const, failures: 0, openUntil: 0 };
    this.breakers.set(provider, cb);
    if (cb.state === "closed") return { allowed: true };
    if (cb.openUntil <= now) { cb.state = "half_open"; cb.openUntil = now + this.breakerCooldownMs; return { allowed: true }; }
    return { allowed: false, retryAt: new Date(cb.openUntil).toISOString() };
  }

  async circuitRecord(provider: string, ok: boolean) {
    const now = this.clock.now();
    const cb = this.breakers.get(provider) ?? { state: "closed" as const, failures: 0, openUntil: 0 };
    this.breakers.set(provider, cb);
    if (ok) { cb.state = "closed"; cb.failures = 0; cb.openUntil = 0; return; }
    cb.failures += 1;
    if (cb.state === "half_open" || cb.failures >= this.breakerThreshold) { cb.state = "open"; cb.openUntil = now + this.breakerCooldownMs; }
  }
}

/** Governance double implementing the SAME decisions as evaluate_agent_action for the cases tests need. */
export class FakeGovernance implements GovernancePort {
  logs: Array<{ id: string; slug: string; status: string; target?: string; error?: string }> = [];
  /** slug → forced decision (default auto_approved). */
  decisions = new Map<string, "auto_approved" | "pending_approval" | "rejected">();
  approved = new Set<string>(); // `${slug}|${target}` approved by a human
  failClosed = false;

  async authorize(p: Parameters<GovernancePort["authorize"]>[0]) {
    if (this.failClosed) throw new Error("Agent governance check failed: db down");
    const target = `${p.targetTable ?? ""}:${p.targetId ?? ""}`;
    const existing = this.logs.find((l) => l.slug === p.actionSlug && l.target === target && ["pending_approval", "approved", "rejected"].includes(l.status));
    if (existing) {
      if (existing.status === "pending_approval" && this.approved.has(`${p.actionSlug}|${target}`)) existing.status = "approved";
      return { decision: existing.status as "approved" | "pending_approval" | "rejected", logId: existing.id, existing: true };
    }
    const decision = this.decisions.get(p.actionSlug) ?? "auto_approved";
    const row = { id: uid("log"), slug: p.actionSlug, status: decision, target };
    this.logs.push(row);
    return { decision, logId: row.id, existing: false };
  }

  async recordOutcome(logId: string, o: { status: "executed" | "failed"; error?: string }) {
    const l = this.logs.find((x) => x.id === logId);
    if (l) { l.status = o.status; l.error = o.error; }
  }
}
