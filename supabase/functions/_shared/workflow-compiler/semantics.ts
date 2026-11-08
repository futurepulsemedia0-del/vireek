// supabase/functions/_shared/workflow-compiler/semantics.ts
//
// Vireek Workflow Engine — execution semantics, Phase 1 (pure core).
//
// Zero imports, zero I/O: runs under Deno (edge functions) and vitest.
// Nothing here is wired into the executor yet; it is the verified, deterministic
// decision layer the executor will call. Existing compiled graphs never reference
// these functions, so their behavior is unchanged.
//
// RUN STATE MACHINE (run.status)
//   active ──► waiting_approval ──► active
//   active ──► waiting_timer    ──► active
//   active ──► compensating ──► failed | cancelled
//   active ──► completed | failed | cancelled           (terminal)
//   waiting_* ──► cancelled | failed                     (terminal)
//   Terminal states absorb nothing: any later event is an invariant violation.
//
// INVARIANTS
//   I1 a node can complete/fail only after it started, and only once per scope
//   I2 a join is released at most once
//   I3 a terminal run never changes
//   I4 compensation runs in reverse completion order, once per step
//   I5 fan-out starts every item exactly once and never exceeds `concurrency`

export const MAX_BRANCHES = 8;
export const MAX_FANOUT_ITEMS = 200;
export const MAX_FANOUT_CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// Joins
// ---------------------------------------------------------------------------

export type BranchStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export type JoinConfig =
  | { mode: "all" }
  | { mode: "any" }
  | { mode: "n_of_m"; n: number }
  | { mode: "timeout"; timeout_ms: number; on_timeout: "proceed" | "fail"; min_success?: number };

export type JoinDecision =
  | { action: "wait" }
  | { action: "proceed"; succeeded: number; cancel: number[] }
  | { action: "fail"; reason: string; cancel: number[] };

const isOpen = (s: BranchStatus) => s === "pending" || s === "running";

export function validateJoinConfig(cfg: JoinConfig, branchCount: number): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(branchCount) || branchCount < 2 || branchCount > MAX_BRANCHES) {
    errors.push(`a parallel block needs 2..${MAX_BRANCHES} branches`);
  }
  if (cfg.mode === "n_of_m" && !(Number.isInteger(cfg.n) && cfg.n >= 1 && cfg.n <= branchCount)) {
    errors.push(`n_of_m: n must be an integer 1..${branchCount}`);
  }
  if (cfg.mode === "timeout") {
    if (!(Number.isInteger(cfg.timeout_ms) && cfg.timeout_ms >= 1000 && cfg.timeout_ms <= 7 * 86_400_000)) errors.push("timeout: timeout_ms must be 1000..604800000");
    if (cfg.on_timeout !== "proceed" && cfg.on_timeout !== "fail") errors.push("timeout: on_timeout must be proceed or fail");
    const ms = cfg.min_success ?? 1;
    if (!(Number.isInteger(ms) && ms >= 1 && ms <= branchCount)) errors.push(`timeout: min_success must be 1..${branchCount}`);
  }
  if (!["all", "any", "n_of_m", "timeout"].includes(cfg.mode)) errors.push(`unknown join mode "${String((cfg as { mode: unknown }).mode)}"`);
  return errors;
}

/** Pure join decision. `elapsedMs` = time since the fork. */
export function evaluateJoin(cfg: JoinConfig, branches: readonly BranchStatus[], elapsedMs = 0): JoinDecision {
  const m = branches.length;
  if (m === 0) return { action: "fail", reason: "no_branches", cancel: [] };
  const open = branches.flatMap((s, i) => (isOpen(s) ? [i] : []));
  const succeeded = branches.filter((s) => s === "succeeded").length;
  const failed = m - succeeded - open.length;

  switch (cfg.mode) {
    case "all":
      if (failed > 0) return { action: "fail", reason: "branch_failed", cancel: open };
      return open.length === 0 ? { action: "proceed", succeeded, cancel: [] } : { action: "wait" };
    case "any":
      if (succeeded >= 1) return { action: "proceed", succeeded, cancel: open };
      return open.length === 0 ? { action: "fail", reason: "no_branch_succeeded", cancel: [] } : { action: "wait" };
    case "n_of_m": {
      if (succeeded >= cfg.n) return { action: "proceed", succeeded, cancel: open };
      if (succeeded + open.length < cfg.n) return { action: "fail", reason: "quorum_unreachable", cancel: open };
      return { action: "wait" };
    }
    case "timeout": {
      const min = cfg.min_success ?? 1;
      if (open.length === 0) return succeeded >= min ? { action: "proceed", succeeded, cancel: [] } : { action: "fail", reason: "below_min_success", cancel: [] };
      if (elapsedMs >= cfg.timeout_ms) {
        return succeeded >= min && cfg.on_timeout === "proceed"
          ? { action: "proceed", succeeded, cancel: open }
          : { action: "fail", reason: "join_timeout", cancel: open };
      }
      return { action: "wait" };
    }
    default:
      return { action: "fail", reason: "unknown_join_mode", cancel: open };
  }
}

// ---------------------------------------------------------------------------
// Bounded fan-out over a collection
// ---------------------------------------------------------------------------

export interface FanOutState { total: number; concurrency: number; done: ReadonlySet<number>; inflight: ReadonlySet<number> }

export function validateFanOut(total: number, concurrency: number): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(total) || total < 0 || total > MAX_FANOUT_ITEMS) errors.push(`fan-out collection must have 0..${MAX_FANOUT_ITEMS} items`);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_FANOUT_CONCURRENCY) errors.push(`concurrency must be 1..${MAX_FANOUT_CONCURRENCY}`);
  return errors;
}

/** Items to start now: lowest indices first, never above the concurrency limit. */
export function planFanOut(s: FanOutState): { start: number[]; finished: boolean } {
  const errs = validateFanOut(s.total, s.concurrency);
  if (errs.length) throw new Error(errs.join("; "));
  const slots = Math.max(0, s.concurrency - s.inflight.size);
  const start: number[] = [];
  for (let i = 0; i < s.total && start.length < slots; i++) if (!s.done.has(i) && !s.inflight.has(i)) start.push(i);
  return { start, finished: s.done.size >= s.total && s.inflight.size === 0 };
}

// ---------------------------------------------------------------------------
// Saga compensation
// ---------------------------------------------------------------------------

export interface SagaStep {
  nodeId: string;
  status: "completed" | "failed" | "compensated" | "compensation_failed";
  /** Node id of the undo action; absent when the step is not reversible. */
  compensator?: string | null;
  /** Monotonic completion order (the audit seq works). */
  seq: number;
}

/**
 * Reverse-order undo plan. A step whose outcome is unknown ("failed" action that
 * may have partially happened) is never auto-compensated: it goes to `manual`.
 */
export function planCompensation(steps: readonly SagaStep[]): { run: string[]; manual: string[] } {
  const ordered = [...steps].sort((a, b) => b.seq - a.seq);
  const run = ordered.filter((s) => s.status === "completed" && s.compensator).map((s) => s.compensator as string);
  const manual = ordered.filter((s) => s.status === "compensation_failed" || (s.status === "failed" && s.compensator)).map((s) => s.nodeId);
  return { run, manual };
}

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

export interface KeyParts { runId: string; nodeId: string; purpose: "exec" | "compensate"; branch?: number; item?: number }

/** Stable per-step key, stored under a UNIQUE constraint so a retry can never repeat a side effect. */
export function idempotencyKey(p: KeyParts): string {
  const parts = [p.runId, p.nodeId, p.purpose, p.branch === undefined ? "-" : String(p.branch), p.item === undefined ? "-" : String(p.item)];
  if (parts.some((x) => x.length === 0 || x.includes(":"))) throw new Error("idempotency key parts must be non-empty and contain no ':'");
  if (p.branch !== undefined && !(Number.isInteger(p.branch) && p.branch >= 0)) throw new Error("branch must be a non-negative integer");
  if (p.item !== undefined && !(Number.isInteger(p.item) && p.item >= 0)) throw new Error("item must be a non-negative integer");
  return parts.join(":");
}

// ---------------------------------------------------------------------------
// Deterministic replay
// ---------------------------------------------------------------------------

export type RunStatus = "active" | "waiting_approval" | "waiting_timer" | "compensating" | "completed" | "failed" | "cancelled";

export const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  active: ["waiting_approval", "waiting_timer", "compensating", "completed", "failed", "cancelled"],
  waiting_approval: ["active", "failed", "cancelled"],
  waiting_timer: ["active", "failed", "cancelled"],
  compensating: ["failed", "cancelled"],
  completed: [], failed: [], cancelled: [],
};

export type RunEvent =
  | { type: "run_started" }
  | { type: "status"; to: RunStatus }
  | { type: "node_started"; scope: string }
  | { type: "node_completed"; scope: string }
  | { type: "node_failed"; scope: string }
  | { type: "join_released"; join: string };

export interface ReplayState {
  status: RunStatus;
  started: boolean;
  nodes: Record<string, "started" | "completed" | "failed">;
  joins: string[];
  events: number;
}

export class InvariantViolation extends Error {
  constructor(message: string) { super(message); this.name = "InvariantViolation"; }
}

const TERMINAL: readonly RunStatus[] = ["completed", "failed", "cancelled"];

/** Pure fold: same events in, same state out. Throws on any broken invariant. */
export function replay(events: readonly RunEvent[]): ReplayState {
  const s: ReplayState = { status: "active", started: false, nodes: {}, joins: [], events: 0 };
  for (const e of events) {
    if (TERMINAL.includes(s.status)) throw new InvariantViolation(`I3: event "${e.type}" after terminal status "${s.status}"`);
    if (e.type !== "run_started" && !s.started) throw new InvariantViolation("event before run_started");
    switch (e.type) {
      case "run_started":
        if (s.started) throw new InvariantViolation("run_started twice");
        s.started = true; break;
      case "status":
        if (!RUN_TRANSITIONS[s.status].includes(e.to)) throw new InvariantViolation(`illegal transition ${s.status} -> ${e.to}`);
        s.status = e.to; break;
      case "node_started":
        if (s.nodes[e.scope]) throw new InvariantViolation(`I1: "${e.scope}" started twice`);
        s.nodes[e.scope] = "started"; break;
      case "node_completed":
      case "node_failed":
        if (s.nodes[e.scope] !== "started") throw new InvariantViolation(`I1: "${e.scope}" finished without being started once`);
        s.nodes[e.scope] = e.type === "node_completed" ? "completed" : "failed"; break;
      case "join_released":
        if (s.joins.includes(e.join)) throw new InvariantViolation(`I2: join "${e.join}" released twice`);
        s.joins.push(e.join); break;
    }
    s.events++;
  }
  return s;
}
