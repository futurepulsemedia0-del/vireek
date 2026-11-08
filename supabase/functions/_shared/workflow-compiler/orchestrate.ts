// supabase/functions/_shared/workflow-compiler/orchestrate.ts
//
// Runtime orchestration for parallel blocks, bounded fan-out and saga compensation.
// Pure with respect to I/O: every side effect goes through injected functions, so the
// executor stays thin and this logic is testable with fakes. State is plain JSON so the
// executor can persist it in run.state between ticks (a tick may be cut by its deadline).
import { evaluateJoin, planCompensation, planFanOut, type BranchStatus, type JoinConfig, type JoinDecision, type SagaStep } from "./semantics.ts";
import type { CompiledGraph } from "./spec.ts";

export interface ExecResult { edge: string; error?: string }

// ------------------------------------------------------------ parallel
export interface BranchState { status: BranchStatus; cursor: string; hops: number; inflight: string | null }
export interface ParallelState { branches: BranchState[]; startedAt: number }

export function startParallel(starts: readonly string[], now: number): ParallelState {
  return { startedAt: now, branches: starts.map((cursor) => ({ status: "pending" as BranchStatus, cursor, hops: 0, inflight: null })) };
}

export interface ParallelDeps {
  graph: CompiledGraph;
  joinId: string;
  cfg: JoinConfig;
  maxHopsPerBranch: number;
  /** Executes one branch node. MUST be safe to call at most once per (branch, node). */
  exec(branch: number, nodeId: string): Promise<ExecResult>;
  /** Persist state. Called before each node (inflight set) and after it. */
  checkpoint(state: ParallelState): Promise<void>;
  now(): number;
  deadline: number;
}

/** Runs open branches one after another until the join decides, or the deadline yields. Idempotent on resume. */
export async function advanceParallel(st: ParallelState, d: ParallelDeps): Promise<{ state: ParallelState; decision: JoinDecision }> {
  // A branch that was mid-node when the process died has an unknown outcome: never re-run it.
  for (const b of st.branches) if (b.inflight !== null && (b.status === "pending" || b.status === "running")) { b.status = "failed"; b.inflight = null; }

  const decide = () => evaluateJoin(d.cfg, st.branches.map((b) => b.status), d.now() - st.startedAt);
  let decision = decide();

  for (let i = 0; i < st.branches.length && decision.action === "wait"; i++) {
    const b = st.branches[i];
    while ((b.status === "pending" || b.status === "running") && decision.action === "wait") {
      if (d.now() >= d.deadline) return { state: st, decision };
      b.status = "running";
      const node = d.graph.nodes[b.cursor];
      if (!node) { b.status = "failed"; break; }
      if (b.hops >= d.maxHopsPerBranch) { b.status = "failed"; break; }
      b.inflight = b.cursor; await d.checkpoint(st);
      let r: ExecResult;
      try { r = await d.exec(i, b.cursor); } catch (e) { r = { edge: "fail", error: e instanceof Error ? e.message : "error" }; }
      b.inflight = null; b.hops++;
      const next = d.graph.edges[b.cursor]?.[r.edge as keyof CompiledGraph["edges"][string]];
      if (!next) b.status = "failed"; // validation guarantees every branch node reaches the join; fail closed if it ever does not
      else if (next === d.joinId) b.status = r.edge === "fail" ? "failed" : "succeeded";
      else b.cursor = next;
      await d.checkpoint(st);
      decision = decide();
    }
    decision = decide();
  }

  if (decision.action !== "wait") for (const idx of decision.cancel) if (st.branches[idx].status === "pending" || st.branches[idx].status === "running") st.branches[idx].status = "cancelled";
  return { state: st, decision };
}

// ------------------------------------------------------------ fan-out
export interface ForeachState { total: number; concurrency: number; done: number[]; failed: number[]; inflight: number[] }
export function startForeach(total: number, concurrency: number): ForeachState { return { total, concurrency, done: [], failed: [], inflight: [] }; }

export interface ForeachDeps {
  /** Runs the body for one item. Must claim its own idempotency key; throwing counts as a failed item. */
  runItem(index: number): Promise<{ ok: boolean }>;
  checkpoint(state: ForeachState): Promise<void>;
  now(): number;
  deadline: number;
}

/** Fail-fast: once an item fails nothing new starts; in-flight items finish. Never repeats an item. */
export async function advanceForeach(st: ForeachState, d: ForeachDeps): Promise<{ state: ForeachState; status: "running" | "completed" | "failed" }> {
  // In-flight at resume = process died mid-item: unknown outcome, not repeated.
  for (const i of st.inflight) if (!st.failed.includes(i) && !st.done.includes(i)) st.failed.push(i);
  st.inflight = [];

  for (;;) {
    const settled = new Set([...st.done, ...st.failed]);
    if (st.failed.length > 0) return { state: st, status: "failed" };
    const plan = planFanOut({ total: st.total, concurrency: st.concurrency, done: settled, inflight: new Set(st.inflight) });
    if (plan.finished) return { state: st, status: "completed" };
    if (d.now() >= d.deadline) return { state: st, status: "running" };
    st.inflight = plan.start; await d.checkpoint(st);
    const results = await Promise.all(plan.start.map(async (i) => {
      try { return { i, ok: (await d.runItem(i)).ok }; } catch { return { i, ok: false }; }
    }));
    st.inflight = [];
    for (const r of results) (r.ok ? st.done : st.failed).push(r.i);
    await d.checkpoint(st);
  }
}

// ------------------------------------------------------------ compensation
export interface CompensationDeps {
  /** Runs one undo node (idempotency-keyed by the caller). Throwing = that undo failed. */
  run(compensatorId: string): Promise<void>;
  record(event: "compensation_done" | "compensation_failed", compensatorId: string, error?: string): Promise<void>;
}

/** Best effort, reverse order, every undo attempted once; a failed undo never blocks the rest. */
export async function runCompensation(steps: readonly SagaStep[], d: CompensationDeps): Promise<{ done: string[]; failed: string[]; manual: string[] }> {
  const plan = planCompensation(steps);
  const done: string[] = [], failed: string[] = [];
  for (const id of plan.run) {
    try { await d.run(id); done.push(id); await d.record("compensation_done", id); }
    catch (e) { failed.push(id); await d.record("compensation_failed", id, e instanceof Error ? e.message : "error"); }
  }
  return { done, failed, manual: plan.manual };
}
