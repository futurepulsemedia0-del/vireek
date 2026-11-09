// supabase/functions/_shared/agent-run/toolRegistry.ts
//
// Single declaration point for every tool an agent may call. A tool is declared ONCE with:
// JSON-schema params, required scope, risk class, governance slug (the SAME slugs as
// agent_action_catalog / ACTION_GOVERNANCE_SLUG — this is not a parallel registry), timeout,
// retry policy, provider (circuit-breaker key) and how a crash/timeout is made safe.
//
// Invariants enforced at registration (so a mis-declared tool fails at boot/test time, not in prod):
//   1. every non-"read" tool has a governanceSlug
//   2. every side-effecting tool is crash-safe: idempotency "provider_key" or a deterministic verify()
//   3. "verify_before_retry" requires verify()
//   4. customer_contact tools declare leaseEntity (no two agents may text one customer at once)
//   5. money_moving / customer_contact / irreversible tools may not use idempotency "none"
//   6. every side-effecting tool declares target() so tenant ownership is verified before execution

import type { JsonSchema } from "./jsonSchema.ts";
import type { RetryPolicy } from "./core.ts";

export type RiskClass = "read" | "reversible_write" | "irreversible" | "money_moving" | "customer_contact";

/** provider_key: provider dedupes on the key itself. verify_before_retry: we look the effect up first. none: read-only only. */
export type IdempotencyMode = "provider_key" | "verify_before_retry" | "none";

export interface ToolContext {
  userId: string;
  runId: string;
  stepIndex: number;
  /** Pass to providers that dedupe (e.g. sendCompliantSms({ dedupeKey })). */
  idempotencyKey: string;
  correlationId: string;
  /** run creation time (ms): lower bound for provider-side lookups after a crash */
  runStartedAt: number;
  attempt: number;
  signal: AbortSignal;
}

export type VerifyResult =
  | { ok: true; result?: Record<string, unknown> }
  | { ok: false; pending?: boolean; reason: string };

export interface EntityRef {
  table: string;
  id: string;
  /** true for synthetic lease keys (e.g. normalized phone): not a DB row, so no row-ownership check.
   *  Tenant isolation still holds because the lease primary key includes user_id. */
  virtual?: boolean;
}

export interface ToolDef<A extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  params: JsonSchema;
  /** e.g. "messaging:send", "booking:write", "payments:request". Granted per run by CODE, never by model output. */
  requiredScope: string;
  risk: RiskClass;
  governanceSlug: string | null;
  timeoutMs: number;
  retry: RetryPolicy;
  idempotency: IdempotencyMode;
  /** Circuit-breaker key, e.g. "twilio", "stripe", "vapi". */
  provider: string;
  /** Row this call targets (also used for governance target + ownership check). */
  target?: (args: A) => EntityRef | null;
  /** Entity to lease for the duration of the step (mandatory for customer_contact). */
  leaseEntity?: (args: A) => EntityRef | null;
  /** Dollar amount for governance spending limits. */
  amountCents?: (args: A) => number | undefined;
  /** Projected run cost for the budget (tokens are accounted separately by planners). */
  estimateCostCents?: (args: A) => number;
  execute: (args: A, ctx: ToolContext) => Promise<Record<string, unknown>>;
  /**
   * Deterministic effect check — NEVER an LLM judgement.
   * `result === null` means "lookup mode" after a crash/timeout: did the effect already happen?
   */
  verify?: (args: A, result: Record<string, unknown> | null, ctx: ToolContext) => Promise<VerifyResult>;
  /** Best-effort undo for reversible_write when verification fails. Must itself be idempotent. */
  compensate?: (args: A, result: Record<string, unknown>, ctx: ToolContext) => Promise<void>;
}

const NAME_RE = /^[a-z][a-z0-9_]{2,47}$/;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef<any>>();

  register<A extends Record<string, unknown>>(tool: ToolDef<A>): this {
    const fail = (why: string): never => {
      throw new Error(`tool registry: "${tool.name}" ${why}`);
    };
    if (!NAME_RE.test(tool.name)) fail("has an invalid name");
    if (this.tools.has(tool.name)) fail("is already registered");
    if (tool.params.type !== "object") fail("params must be an object schema");
    if (tool.params.additionalProperties === true) fail("params must not allow additionalProperties (model output is untrusted)");
    if (!tool.requiredScope) fail("needs a requiredScope");
    if (tool.timeoutMs <= 0 || tool.timeoutMs > 120_000) fail("timeoutMs must be within (0, 120000]");
    if (tool.retry.maxAttempts < 1 || tool.retry.maxAttempts > 8) fail("retry.maxAttempts must be 1..8");

    const sideEffect = tool.risk !== "read";
    if (sideEffect && !tool.governanceSlug) fail("is side-effecting but has no governanceSlug");
    if (!sideEffect && tool.governanceSlug) fail("is read-only; remove governanceSlug");
    if (sideEffect) {
      if (!tool.target) fail("is side-effecting and must declare target() for ownership + governance");
      if (tool.idempotency === "none") fail("is side-effecting and must declare idempotency provider_key or verify_before_retry");
      if (tool.idempotency === "verify_before_retry" && !tool.verify) fail("uses verify_before_retry but has no verify()");
      if (!tool.verify && tool.idempotency !== "provider_key") fail("is side-effecting without verify() or provider-level dedupe");
      if (tool.risk === "reversible_write" && tool.compensate === undefined && tool.verify === undefined) {
        fail("reversible_write needs verify() or compensate()");
      }
    }
    if (tool.risk === "customer_contact" && !tool.leaseEntity) fail("customer_contact must declare leaseEntity");
    if (tool.risk === "money_moving" && tool.amountCents === undefined) fail("money_moving must declare amountCents");
    if ((tool.risk === "money_moving" || tool.risk === "customer_contact") && !tool.verify && tool.idempotency !== "provider_key") {
      fail("money/contact tools need provider_key dedupe or verify()");
    }
    this.tools.set(tool.name, tool as ToolDef<any>);
    return this;
  }

  get(name: string): ToolDef<any> | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef<any>[] {
    return [...this.tools.values()];
  }

  /** Model-facing description (no secrets, no execute). */
  describe(): Array<{ name: string; description: string; params: JsonSchema; risk: RiskClass }> {
    return this.list().map((t) => ({ name: t.name, description: t.description, params: t.params, risk: t.risk }));
  }
}
