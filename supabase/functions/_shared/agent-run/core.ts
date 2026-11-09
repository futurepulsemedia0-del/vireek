// supabase/functions/_shared/agent-run/core.ts
//
// Pure, side-effect-free building blocks of the agent run runtime:
//   - failure taxonomy + bounded exponential backoff with full jitter
//   - budget limits (mirrors the atomic check inside SQL agent_step_begin)
//   - deterministic idempotency keys / input hashing
// No Deno-only imports: testable with Vitest as well as runnable in Edge Functions.

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------
export type ErrorClass = "transient" | "permanent" | "policy_blocked" | "ambiguous_input" | "dependency_down";

/** Errors a tool can throw to state its class explicitly (preferred over sniffing). */
export class ToolError extends Error {
  constructor(
    message: string,
    public readonly errorClass: ErrorClass,
    /** true when the side effect MAY already have happened (timeout after request sent). */
    public readonly maybeExecuted = false,
    /** false when the failure is the tenant's/request's fault (bad number, A2P not approved): must NOT trip the global provider breaker. */
    public readonly providerFault = true,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export class ToolTimeoutError extends Error {
  constructor(public readonly toolName: string, public readonly timeoutMs: number) {
    super(`tool ${toolName} timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}

export interface ClassifiedError {
  errorClass: ErrorClass;
  maybeExecuted: boolean;
  message: string;
  /** whether this failure should count against the provider's circuit breaker */
  providerFault: boolean;
}

function statusOf(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { status?: unknown; statusCode?: unknown };
  const s = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : null;
  return s;
}

/**
 * Classifies an unknown thrown value.
 * - Timeouts are AMBIGUOUS-FOR-EFFECT (request may have been processed): maybeExecuted=true.
 * - 5xx/429/network → transient (429/503 → dependency_down so the breaker counts it).
 * - other 4xx → permanent (the request itself is wrong; retrying cannot help).
 */
export function classifyError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ToolError) return { errorClass: err.errorClass, maybeExecuted: err.maybeExecuted, message, providerFault: err.providerFault };
  if (err instanceof ToolTimeoutError) return { errorClass: "transient", maybeExecuted: true, message, providerFault: true };

  const status = statusOf(err);
  if (status !== null) {
    if (status === 429 || status === 503 || status === 502 || status === 504) {
      return { errorClass: "dependency_down", maybeExecuted: status === 504, message, providerFault: true };
    }
    if (status >= 500) return { errorClass: "transient", maybeExecuted: true, message, providerFault: true };
    if (status === 400 || status === 422) return { errorClass: "ambiguous_input", maybeExecuted: false, message, providerFault: false };
    if (status === 401 || status === 403) return { errorClass: "policy_blocked", maybeExecuted: false, message, providerFault: false };
    if (status >= 400) return { errorClass: "permanent", maybeExecuted: false, message, providerFault: false };
  }
  if (/fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(message)) {
    return { errorClass: "transient", maybeExecuted: true, message, providerFault: true };
  }
  // Unknown → do NOT blindly retry something that may have moved money / texted a customer.
  return { errorClass: "permanent", maybeExecuted: true, message, providerFault: true };
}

export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
}

/** Full-jitter exponential backoff, bounded. `attempt` is the attempt that just failed (1-based). */
export function backoffMs(attempt: number, policy: RetryPolicy, rng: () => number = Math.random): number {
  const exp = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(rng() * exp);
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------
export interface RunLimits {
  max_steps: number;
  max_cost_cents: number;
  max_tokens: number;
  max_contacts: number;
}
export interface RunUsage {
  steps: number;
  cost_cents: number;
  tokens: number;
  contacts: number;
}
export type BudgetViolation = "max_steps" | "max_cost" | "max_tokens" | "max_contacts" | "wall_clock";

export const DEFAULT_RUN_LIMITS: RunLimits = { max_steps: 12, max_cost_cents: 200, max_tokens: 60_000, max_contacts: 2 };

export function checkBudget(
  usage: RunUsage,
  limits: Partial<RunLimits>,
  next: { costCents?: number; tokens?: number; isContact?: boolean },
  now: number,
  deadlineAt: number,
): { ok: true } | { ok: false; reason: BudgetViolation } {
  if (now > deadlineAt) return { ok: false, reason: "wall_clock" };
  if (limits.max_steps !== undefined && usage.steps + 1 > limits.max_steps) return { ok: false, reason: "max_steps" };
  if (limits.max_cost_cents !== undefined && usage.cost_cents + Math.max(0, next.costCents ?? 0) > limits.max_cost_cents) {
    return { ok: false, reason: "max_cost" };
  }
  if (limits.max_tokens !== undefined && usage.tokens + Math.max(0, next.tokens ?? 0) > limits.max_tokens) {
    return { ok: false, reason: "max_tokens" };
  }
  if (next.isContact && limits.max_contacts !== undefined && usage.contacts + 1 > limits.max_contacts) {
    return { ok: false, reason: "max_contacts" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const hashInput = (args: unknown): Promise<string> => sha256Hex(stableStringify(args));

/**
 * Key for one (run, step, tool). Deterministic: a re-walk of the same plan after a crash
 * yields the SAME key, so the ledger replays the stored result instead of acting twice.
 * Also passed to providers that support their own dedupe (e.g. sendCompliantSms dedupeKey).
 */
export function stepIdempotencyKey(runId: string, stepIndex: number, tool: string): string {
  return `run:${runId}:step:${stepIndex}:${tool}`;
}

/** Caps what we persist so a hostile/huge provider response can't bloat the ledger. */
export function sanitizeResult(value: unknown, maxBytes = 16_384): Record<string, unknown> {
  const json = JSON.stringify(value ?? {}) ?? "{}";
  if (json.length > maxBytes) return { truncated: true, preview: json.slice(0, 1024) };
  const parsed: unknown = JSON.parse(json);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : { value: parsed };
}
