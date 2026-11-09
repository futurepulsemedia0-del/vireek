// supabase/functions/_shared/agent-run/store.ts
//
// Port (interface) + Supabase adapter for the durable run ledger. The executor only
// depends on RunStore, so fault-injection tests run against an in-memory fake that
// mirrors the SQL semantics of 20281116000000_agent_run_runtime.sql.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import type { ErrorClass, RunLimits, RunUsage } from "./core.ts";

export type RunStatus = "running" | "awaiting_approval" | "succeeded" | "failed" | "escalated" | "dead_letter" | "cancelled";
export type StepStatus = "succeeded" | "failed_retryable" | "failed_permanent" | "awaiting_approval" | "blocked" | "needs_human";
export type Verification = "not_required" | "pending" | "verified" | "failed";

export interface RunHandle {
  runId: string;
  userId: string;
  agentSource: string;
  correlationId: string;
  scopes: readonly string[];
  limits: Partial<RunLimits>;
  usage: RunUsage;
  deadlineAt: number;
  /** when the run was first created (stable across resumes) */
  createdAtMs: number;
  created: boolean;
  status: RunStatus;
}

export interface StartRunParams {
  userId: string;
  agentSource: string;
  /** Unique per trigger (cron tick / webhook id). Duplicate triggers resume the same run. */
  triggerRef?: string;
  correlationId: string;
  plan: Record<string, unknown>;
  /** Granted by code only. Never derive from model output. */
  scopes: readonly string[];
  limits: Partial<RunLimits>;
  deadlineSeconds?: number;
}

export type BeginResult =
  | { action: "execute"; stepId: string; attempt: number; actionLogId?: string | null; wasAwaitingApproval?: boolean }
  | { action: "reconcile"; stepId: string; attempt: number; actionLogId?: string | null }
  | { action: "replay"; stepId: string; result: Record<string, unknown> }
  | { action: "in_flight"; stepId: string }
  | { action: "backoff"; stepId: string; retryAt: string }
  | { action: "exhausted"; stepId: string }
  | { action: "terminal"; stepId: string; status: string; errorClass: ErrorClass | null; error: string | null }
  | { action: "approval_expired"; stepId: string }
  | { action: "budget_exceeded"; reason: string }
  | { action: "run_closed"; runStatus: string }
  | { action: "conflict"; stepId: string };

export interface BeginStepParams {
  run: RunHandle;
  stepIndex: number;
  tool: string;
  idempotencyKey: string;
  inputHash: string;
  input: Record<string, unknown>;
  maxAttempts: number;
  projectedCostCents: number;
  isContact: boolean;
}

export interface FinishStepParams {
  stepId: string;
  userId: string;
  status: StepStatus;
  result?: Record<string, unknown>;
  errorClass?: ErrorClass;
  error?: string;
  nextRetryAt?: Date;
  maybeExecuted?: boolean;
  verification?: Verification;
  costCents?: number;
  tokens?: number;
  isContact?: boolean;
}

export interface LeaseParams {
  userId: string;
  entityTable: string;
  entityId: string;
  holder: string;
  runId: string;
  ttlSeconds: number;
}

export interface RunStore {
  startRun(p: StartRunParams): Promise<RunHandle>;
  beginStep(p: BeginStepParams): Promise<BeginResult>;
  attachActionLog(stepId: string, userId: string, logId: string): Promise<void>;
  finishStep(p: FinishStepParams): Promise<void>;
  finishRun(runId: string, userId: string, status: RunStatus, reason?: string): Promise<void>;
  acquireLease(p: LeaseParams): Promise<{ acquired: boolean; holder: string | null }>;
  releaseLease(p: Omit<LeaseParams, "ttlSeconds" | "runId">): Promise<void>;
  circuitAllow(provider: string): Promise<{ allowed: boolean; retryAt?: string }>;
  circuitRecord(provider: string, ok: boolean): Promise<void>;
}

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null || res.data === undefined) throw new Error(`${what}: empty response`);
  return res.data;
}

type Json = Record<string, any>;

export class SupabaseRunStore implements RunStore {
  constructor(private readonly admin: SupabaseClient) {}

  async startRun(p: StartRunParams): Promise<RunHandle> {
    const d = must(
      await this.admin.rpc("agent_run_start", {
        p_user_id: p.userId,
        p_agent_source: p.agentSource,
        p_trigger_ref: p.triggerRef ?? null,
        p_correlation_id: p.correlationId,
        p_plan: p.plan,
        p_scopes: [...p.scopes],
        p_limits: p.limits,
        p_deadline_seconds: p.deadlineSeconds ?? 300,
      }),
      "agent_run_start",
    ) as Json;
    return {
      runId: d.run_id,
      userId: p.userId,
      agentSource: p.agentSource,
      correlationId: d.correlation_id,
      // On resume the STORED scopes/limits win — a re-invocation can never widen them.
      scopes: d.scopes ?? [],
      limits: d.limits ?? {},
      usage: d.usage,
      deadlineAt: Date.parse(d.deadline_at),
      createdAtMs: Date.parse(d.created_at),
      created: Boolean(d.created),
      status: d.status,
    };
  }

  async beginStep(p: BeginStepParams): Promise<BeginResult> {
    const d = must(
      await this.admin.rpc("agent_step_begin", {
        p_run_id: p.run.runId,
        p_user_id: p.run.userId,
        p_step_index: p.stepIndex,
        p_tool: p.tool,
        p_idempotency_key: p.idempotencyKey,
        p_input_hash: p.inputHash,
        p_input: p.input,
        p_max_attempts: p.maxAttempts,
        p_projected_cost_cents: Math.ceil(p.projectedCostCents),
        p_is_contact: p.isContact,
      }),
      "agent_step_begin",
    ) as Json;
    switch (d.action) {
      case "execute":
        return { action: "execute", stepId: d.step_id, attempt: d.attempt, actionLogId: d.action_log_id ?? null, wasAwaitingApproval: Boolean(d.was_awaiting_approval) };
      case "reconcile":
        return { action: "reconcile", stepId: d.step_id, attempt: d.attempt, actionLogId: d.action_log_id ?? null };
      case "replay":
        return { action: "replay", stepId: d.step_id, result: d.result ?? {} };
      case "in_flight":
        return { action: "in_flight", stepId: d.step_id };
      case "backoff":
        return { action: "backoff", stepId: d.step_id, retryAt: d.retry_at };
      case "exhausted":
        return { action: "exhausted", stepId: d.step_id };
      case "terminal":
        return { action: "terminal", stepId: d.step_id, status: d.status, errorClass: d.error_class ?? null, error: d.error ?? null };
      case "approval_expired":
        return { action: "approval_expired", stepId: d.step_id };
      case "budget_exceeded":
        return { action: "budget_exceeded", reason: d.reason };
      case "run_closed":
        return { action: "run_closed", runStatus: d.run_status };
      case "conflict":
        return { action: "conflict", stepId: d.step_id };
      default:
        throw new Error(`agent_step_begin: unknown action ${String(d.action)}`);
    }
  }

  async attachActionLog(stepId: string, userId: string, logId: string): Promise<void> {
    const { error } = await this.admin.rpc("agent_step_attach_log", { p_step_id: stepId, p_user_id: userId, p_action_log_id: logId });
    if (error) throw new Error(`agent_step_attach_log: ${error.message}`);
  }

  async finishStep(p: FinishStepParams): Promise<void> {
    const { error } = await this.admin.rpc("agent_step_finish", {
      p_step_id: p.stepId,
      p_user_id: p.userId,
      p_status: p.status,
      p_result: p.result ?? null,
      p_error_class: p.errorClass ?? null,
      p_error: p.error ?? null,
      p_next_retry_at: p.nextRetryAt ? p.nextRetryAt.toISOString() : null,
      p_maybe_executed: p.maybeExecuted ?? false,
      p_verification: p.verification ?? "not_required",
      p_cost_cents: Math.ceil(p.costCents ?? 0),
      p_tokens: p.tokens ?? 0,
      p_is_contact: p.isContact ?? false,
    });
    if (error) throw new Error(`agent_step_finish: ${error.message}`);
  }

  async finishRun(runId: string, userId: string, status: RunStatus, reason?: string): Promise<void> {
    const { error } = await this.admin.rpc("agent_run_finish", { p_run_id: runId, p_user_id: userId, p_status: status, p_stop_reason: reason ?? null });
    if (error) throw new Error(`agent_run_finish: ${error.message}`);
  }

  async acquireLease(p: LeaseParams): Promise<{ acquired: boolean; holder: string | null }> {
    const d = must(
      await this.admin.rpc("agent_lease_acquire", {
        p_user_id: p.userId, p_entity_table: p.entityTable, p_entity_id: p.entityId,
        p_holder: p.holder, p_run_id: p.runId, p_ttl_seconds: p.ttlSeconds,
      }),
      "agent_lease_acquire",
    ) as Json;
    return { acquired: Boolean(d.acquired), holder: d.holder ?? null };
  }

  async releaseLease(p: Omit<LeaseParams, "ttlSeconds" | "runId">): Promise<void> {
    const { error } = await this.admin.rpc("agent_lease_release", {
      p_user_id: p.userId, p_entity_table: p.entityTable, p_entity_id: p.entityId, p_holder: p.holder,
    });
    // TTL is the backstop; a failed release must not fail the step.
    if (error) console.error(JSON.stringify({ event: "agent_lease_release_failed", error: error.message }));
  }

  async circuitAllow(provider: string): Promise<{ allowed: boolean; retryAt?: string }> {
    const { data, error } = await this.admin.rpc("agent_circuit_allow", { p_provider: provider });
    // Fail OPEN on breaker infra errors: the breaker protects providers, it must not stop the business.
    if (error || !data) return { allowed: true };
    const d = data as Json;
    return { allowed: Boolean(d.allowed), retryAt: d.retry_at ?? undefined };
  }

  async circuitRecord(provider: string, ok: boolean): Promise<void> {
    const { error } = await this.admin.rpc("agent_circuit_record", { p_provider: provider, p_ok: ok });
    if (error) console.error(JSON.stringify({ event: "agent_circuit_record_failed", provider, error: error.message }));
  }
}
