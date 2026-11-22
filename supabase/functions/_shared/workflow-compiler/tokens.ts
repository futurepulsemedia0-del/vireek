// supabase/functions/_shared/workflow-compiler/tokens.ts
//
// Multi-token execution for parallel blocks and bounded fan-out. Every branch / fan-out item is a TOKEN persisted in
// compiled_workflow_tokens (UNIQUE (run_id, scope_key)). Tokens are leased independently, so
//   - branches really run concurrently inside a tick (the legacy path in orchestrate.ts runs them one after another),
//   - a slow tick whose run lease expired cannot double-run a branch: the token lease + inflight marker decide who owns a node,
//   - fan-out concurrency is enforced by the number of valid leases (not by one process's memory), so it holds across ticks/workers.
//
// Pure with respect to I/O: persistence goes through the injected TokenStore (Supabase RPCs in the executor, MemoryTokenStore here).
// Decisions reuse semantics.ts (evaluateJoin / planFanOut); nothing is re-implemented.
//
// Crash rule (unchanged from the legacy executor): a token that was mid-node when its process died has an UNKNOWN outcome. It is failed,
// never re-run. A token between nodes (no inflight marker) is simply re-leased and continues from its cursor.

import { evaluateJoin, type BranchStatus, type JoinConfig, type JoinDecision } from "./semantics.ts";
import type { CompiledGraph } from "./spec.ts";

export type TokenStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface TokenOutput { outputs: Record<string, unknown>; done: Array<{ nodeId: string; status: "completed" | "failed" }> }
export const emptyOutput = (): TokenOutput => ({ outputs: {}, done: [] });

export interface Token {
  scope: string; // `${parent}:b${ordinal}` | `${parent}:i${ordinal}`
  parent: string;
  kind: "branch" | "item";
  ordinal: number;
  cursor: string | null;
  hops: number;
  status: TokenStatus;
  inflight: string | null;
  error: string | null;
  output: TokenOutput;
  createdAt: number;
  attempts: number;
}

export const scopeKey = (parent: string, kind: "branch" | "item", ordinal: number) => `${parent}:${kind === "branch" ? "b" : "i"}${ordinal}`;

export interface TokenStore {
  /** Idempotent. Returns how many tokens were NEW. */
  spawn(parent: string, kind: "branch" | "item", starts: ReadonlyArray<{ ordinal: number; cursor: string | null }>): Promise<number>;
  /** Leases up to `limit` tokens, counting valid leases against it (this is the concurrency cap). */
  claim(parent: string, limit: number): Promise<Token[]>;
  /** Guarded: false = the lease was lost (stop, do not execute anything). */
  save(t: Token, status: TokenStatus, patch?: { cursor?: string | null; inflight?: string | null; error?: string | null }): Promise<boolean>;
  list(parent: string): Promise<Token[]>;
  /** Cancel tokens nobody is executing. Returns how many. */
  cancelOpen(parent: string): Promise<number>;
}

export interface ExecResult { edge: string; error?: string; output?: unknown; done?: "completed" | "failed" }

const asBranchStatus = (s: TokenStatus): BranchStatus => s;
const isOpen = (s: TokenStatus) => s === "pending" || s === "running";
const isTerminal = (s: TokenStatus) => !isOpen(s);

// ------------------------------------------------------------------ one branch token
export interface BranchDeps {
  graph: CompiledGraph;
  joinId: string;
  maxHops: number;
  store: TokenStore;
  /** Executes one node for this token. MUST NOT mutate shared run state: return the output instead. */
  exec(token: Token, nodeId: string): Promise<ExecResult>;
  now(): number;
  deadline: number;
}

export async function advanceBranchToken(t: Token, d: BranchDeps): Promise<"succeeded" | "failed" | "yielded"> {
  for (;;) {
    if (t.inflight !== null) { // defensive: claim() already converts these to failed
      t.error = "interrupted: outcome unknown, not re-run";
      await d.store.save(t, "failed", { inflight: null, error: t.error });
      return "failed";
    }
    if (d.now() >= d.deadline) { await d.store.save(t, "pending"); return "yielded"; }
    const cursor = t.cursor;
    const node = cursor ? d.graph.nodes[cursor] : undefined;
    if (!cursor || !node || t.hops >= d.maxHops) {
      t.error = !node ? "missing_node" : "hop_limit";
      await d.store.save(t, "failed", { error: t.error });
      return "failed";
    }
    t.inflight = cursor;
    if (!(await d.store.save(t, "running", { inflight: cursor }))) return "yielded"; // lease lost BEFORE running anything

    let r: ExecResult;
    try { r = await d.exec(t, cursor); } catch (e) { r = { edge: "fail", error: e instanceof Error ? e.message : "error" }; }
    t.inflight = null;
    t.hops++;
    if (r.output !== undefined) t.output.outputs[cursor] = r.output;
    if (r.done) t.output.done.push({ nodeId: cursor, status: r.done });
    if (r.error) t.error = r.error.slice(0, 300);

    const next = d.graph.edges[cursor]?.[r.edge as keyof CompiledGraph["edges"][string]];
    if (!next) { t.error = t.error ?? "no_edge"; await d.store.save(t, "failed", { inflight: null, error: t.error }); return "failed"; }
    if (next === d.joinId) {
      const status: TokenStatus = r.edge === "fail" ? "failed" : "succeeded";
      await d.store.save(t, status, { inflight: null, error: status === "failed" ? t.error : null });
      return status;
    }
    t.cursor = next;
    if (!(await d.store.save(t, "running", { cursor: next, inflight: null }))) return "yielded";
  }
}

// ------------------------------------------------------------------ parallel block
export interface ParallelRunDeps extends Omit<BranchDeps, "deadline"> {
  cfg: JoinConfig;
  starts: readonly string[];
  /** How many branch tokens one tick may run at once. */
  concurrency: number;
  deadline: number;
}

export type ParallelOutcome =
  | { kind: "yield" }
  | { kind: "released"; decision: Exclude<JoinDecision, { action: "wait" }>; tokens: Token[] };

export async function runParallel(parent: string, d: ParallelRunDeps): Promise<ParallelOutcome> {
  await d.store.spawn(parent, "branch", d.starts.map((cursor, ordinal) => ({ ordinal, cursor })));
  for (;;) {
    const tokens = await d.store.list(parent);
    const first = Math.min(...tokens.map((t) => t.createdAt));
    const decision = evaluateJoin(d.cfg, tokens.map((t) => asBranchStatus(t.status)), d.now() - first);
    if (decision.action !== "wait") {
      await d.store.cancelOpen(parent);
      return { kind: "released", decision, tokens: await d.store.list(parent) };
    }
    if (d.now() >= d.deadline) return { kind: "yield" };
    const claimed = await d.store.claim(parent, d.concurrency);
    if (claimed.length === 0) return { kind: "yield" }; // everything open is leased elsewhere: come back next tick
    const outcomes = await Promise.all(claimed.map((t) => advanceBranchToken(t, { ...d, deadline: d.deadline })));
    if (outcomes.every((o) => o === "yielded") && d.now() >= d.deadline) return { kind: "yield" };
  }
}

// ------------------------------------------------------------------ fan-out
export interface ForeachRunDeps {
  store: TokenStore;
  total: number;
  concurrency: number;
  /** Runs the body for one item. Must claim its own idempotency key. Throwing / ok:false = failed item. */
  runItem(index: number): Promise<{ ok: boolean; output?: unknown }>;
  now(): number;
  deadline: number;
}
export type ForeachOutcome = { kind: "yield" } | { kind: "completed" | "failed"; done: number; failed: number };

/** Fail-fast: once an item fails no new item starts; items already leased finish. Never repeats an item. */
export async function runForeach(parent: string, d: ForeachRunDeps): Promise<ForeachOutcome> {
  await d.store.spawn(parent, "item", Array.from({ length: d.total }, (_, ordinal) => ({ ordinal, cursor: null })));
  for (;;) {
    const tokens = await d.store.list(parent);
    const failed = tokens.filter((t) => t.status === "failed").length;
    const done = tokens.filter((t) => t.status === "succeeded").length;
    if (failed > 0) {
      await d.store.cancelOpen(parent);
      if (!(await d.store.list(parent)).some((t) => t.status === "running")) return { kind: "failed", done, failed };
      return { kind: "yield" }; // let in-flight items settle first
    }
    if (done === d.total) return { kind: "completed", done, failed: 0 };
    if (d.now() >= d.deadline) return { kind: "yield" };
    const claimed = await d.store.claim(parent, d.concurrency);
    if (claimed.length === 0) return { kind: "yield" };
    await Promise.all(claimed.map(async (t) => {
      let ok = false; let output: unknown; let error: string | null = null;
      t.inflight = `item${t.ordinal}`;
      if (!(await d.store.save(t, "running", { inflight: t.inflight }))) return;
      try { const r = await d.runItem(t.ordinal); ok = r.ok; output = r.output; if (!ok) error = "item_failed"; } catch (e) { error = e instanceof Error ? e.message : "error"; }
      t.inflight = null;
      if (output !== undefined) t.output.outputs[`item${t.ordinal}`] = output;
      await d.store.save(t, ok ? "succeeded" : "failed", { inflight: null, error });
    }));
  }
}

/** Merges the per-token results into run state in a deterministic order (ordinal), so replays are identical. */
export function mergeTokenOutputs(tokens: readonly Token[], nextSeq: number): { outputs: Record<string, unknown>; done: Array<{ nodeId: string; seq: number; status: "completed" | "failed" }> } {
  const outputs: Record<string, unknown> = {};
  const done: Array<{ nodeId: string; seq: number; status: "completed" | "failed" }> = [];
  let seq = nextSeq;
  for (const t of [...tokens].sort((a, b) => a.ordinal - b.ordinal)) {
    Object.assign(outputs, t.output.outputs);
    for (const e of t.output.done) done.push({ nodeId: e.nodeId, seq: seq++, status: e.status });
  }
  return { outputs, done };
}

// ------------------------------------------------------------------ in-memory store (tests, load simulation)
export function createMemoryTokenStore(opts: { now: () => number; leaseMs?: number; runId?: string }) {
  const leaseMs = opts.leaseMs ?? 90_000;
  const rows = new Map<string, Token & { leaseUntil: number | null }>();
  const clone = (t: Token & { leaseUntil: number | null }): Token => ({ ...t, output: { outputs: { ...t.output.outputs }, done: [...t.output.done] } });
  const store: TokenStore & { rows: typeof rows; stats: { spawned: number; claims: number; lostLeases: number } } = {
    rows, stats: { spawned: 0, claims: 0, lostLeases: 0 },
    async spawn(parent, kind, starts) {
      let n = 0;
      for (const s of starts) {
        const key = scopeKey(parent, kind, s.ordinal);
        if (rows.has(key)) continue; // UNIQUE (run_id, scope_key)
        if (kind === "branch" && !s.cursor) throw new Error("branch token needs a cursor");
        rows.set(key, { scope: key, parent, kind, ordinal: s.ordinal, cursor: s.cursor, hops: 0, status: "pending", inflight: null, error: null, output: emptyOutput(), createdAt: opts.now(), attempts: 0, leaseUntil: null });
        n++;
      }
      store.stats.spawned += n;
      return n;
    },
    async claim(parent, limit) {
      const now = opts.now();
      const mine = [...rows.values()].filter((t) => t.parent === parent).sort((a, b) => a.ordinal - b.ordinal);
      for (const t of mine) if (t.status === "running" && (t.leaseUntil ?? 0) < now && t.inflight !== null) { t.status = "failed"; t.error = "interrupted: outcome unknown, not re-run"; t.inflight = null; t.leaseUntil = null; }
      const busy = mine.filter((t) => t.status === "running" && (t.leaseUntil ?? 0) >= now).length;
      const room = Math.max(0, Math.min(limit, 50) - busy);
      const out: Token[] = [];
      for (const t of mine) {
        if (out.length >= room) break;
        if (t.status === "pending" || (t.status === "running" && (t.leaseUntil ?? 0) < now)) { t.status = "running"; t.attempts++; t.leaseUntil = now + leaseMs; out.push(clone(t)); store.stats.claims++; }
      }
      return out;
    },
    async save(t, status, patch = {}) {
      const row = rows.get(t.scope);
      if (!row || row.status !== "running") { store.stats.lostLeases++; return false; }
      row.status = status; row.hops = t.hops; if (patch.cursor !== undefined && patch.cursor !== null) row.cursor = patch.cursor;
      if (patch.inflight !== undefined) row.inflight = patch.inflight;
      if (patch.error !== undefined) row.error = patch.error;
      row.output = { outputs: { ...t.output.outputs }, done: [...t.output.done] };
      row.leaseUntil = status === "running" ? opts.now() + leaseMs : null;
      return true;
    },
    async list(parent) { return [...rows.values()].filter((t) => t.parent === parent).sort((a, b) => a.ordinal - b.ordinal).map(clone); },
    async cancelOpen(parent) {
      const now = opts.now(); let n = 0;
      for (const t of rows.values()) if (t.parent === parent && (t.status === "pending" || (t.status === "running" && (t.leaseUntil ?? 0) < now && t.inflight === null))) { t.status = "cancelled"; t.leaseUntil = null; n++; }
      return n;
    },
  };
  return store;
}
export { isTerminal };
