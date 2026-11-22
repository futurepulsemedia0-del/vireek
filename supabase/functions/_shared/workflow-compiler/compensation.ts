// supabase/functions/_shared/workflow-compiler/compensation.ts
//
// Durable saga state. Instead of undoing everything inside the failing tick (and losing track if the process dies), the undo plan is
// written to compiled_workflow_compensations (UNIQUE (run_id, node_id)) and the run enters the 'compensating' status. Each undo is
// leased strictly one at a time in REVERSE completion order (I4), runs at most once, and a crash mid-undo leaves that step 'failed'
// (outcome unknown, never repeated) and raises a manual follow-up — exactly the legacy semantics, but resumable across ticks.
// Pure with respect to I/O (injected CompStore); decisions reuse planCompensation's rules from semantics.ts.

import type { SagaStep } from "./semantics.ts";

export type CompStatus = "pending" | "running" | "done" | "failed" | "manual";
export interface CompRow { nodeId: string; compensator: string; seq: number; status: CompStatus; error: string | null }

export interface CompStore {
  /** Idempotent (UNIQUE run_id,node_id). Returns the number of NEW rows. */
  plan(rows: ReadonlyArray<{ nodeId: string; compensator: string; seq: number; manual: boolean }>): Promise<number>;
  /** Next undo in reverse completion order, or null when none is runnable now (nothing pending, or one is still leased). */
  claim(): Promise<CompRow | null>;
  settle(nodeId: string, status: "done" | "failed", error?: string): Promise<void>;
  list(): Promise<CompRow[]>;
}

/** Same rules as planCompensation(): completed+compensator => undo; failed/compensation_failed+compensator => manual follow-up. */
export function buildCompensationRows(steps: readonly SagaStep[]): Array<{ nodeId: string; compensator: string; seq: number; manual: boolean }> {
  const seen = new Set<string>();
  const out: Array<{ nodeId: string; compensator: string; seq: number; manual: boolean }> = [];
  for (const s of [...steps].sort((a, b) => b.seq - a.seq)) {
    if (!s.compensator || seen.has(s.nodeId)) continue;
    if (s.status === "completed") { out.push({ nodeId: s.nodeId, compensator: s.compensator, seq: s.seq, manual: false }); seen.add(s.nodeId); }
    else if (s.status === "failed" || s.status === "compensation_failed") { out.push({ nodeId: s.nodeId, compensator: s.compensator, seq: s.seq, manual: true }); seen.add(s.nodeId); }
  }
  return out;
}

export interface CompDeps {
  store: CompStore;
  /** Runs one undo node (idempotency-keyed by the caller). Throw = failed. */
  run(compensatorId: string, nodeId: string): Promise<void>;
  record(event: "compensation_done" | "compensation_failed", compensatorId: string, error?: string): Promise<void>;
  now(): number;
  deadline: number;
}
export interface CompProgress { finished: boolean; done: string[]; failed: string[]; manual: string[] }

export async function advanceCompensation(d: CompDeps): Promise<CompProgress> {
  for (;;) {
    if (d.now() >= d.deadline) break;
    const row = await d.store.claim();
    if (!row) break;
    try { await d.run(row.compensator, row.nodeId); await d.store.settle(row.nodeId, "done"); await d.record("compensation_done", row.compensator); }
    catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      await d.store.settle(row.nodeId, "failed", msg.slice(0, 300));
      await d.record("compensation_failed", row.compensator, msg);
    }
  }
  const rows = await d.store.list();
  const open = rows.some((r) => r.status === "pending" || r.status === "running");
  return {
    finished: !open,
    done: rows.filter((r) => r.status === "done").map((r) => r.compensator),
    failed: rows.filter((r) => r.status === "failed").map((r) => r.compensator),
    manual: rows.filter((r) => r.status === "manual").map((r) => r.nodeId),
  };
}

export function createMemoryCompStore(opts: { now: () => number; leaseMs?: number }): CompStore & { rows: Map<string, CompRow & { leaseUntil: number | null }> } {
  const leaseMs = opts.leaseMs ?? 90_000;
  const rows = new Map<string, CompRow & { leaseUntil: number | null }>();
  return {
    rows,
    async plan(r) { let n = 0; for (const x of r) { if (rows.has(x.nodeId)) continue; rows.set(x.nodeId, { nodeId: x.nodeId, compensator: x.compensator, seq: x.seq, status: x.manual ? "manual" : "pending", error: null, leaseUntil: null }); n++; } return n; },
    async claim() {
      const now = opts.now();
      for (const r of rows.values()) if (r.status === "running" && (r.leaseUntil ?? 0) < now) { r.status = "failed"; r.error = "interrupted: outcome unknown, not repeated"; r.leaseUntil = null; }
      if ([...rows.values()].some((r) => r.status === "running")) return null;
      const next = [...rows.values()].filter((r) => r.status === "pending").sort((a, b) => b.seq - a.seq)[0];
      if (!next) return null;
      next.status = "running"; next.leaseUntil = now + leaseMs;
      return { nodeId: next.nodeId, compensator: next.compensator, seq: next.seq, status: "running", error: null };
    },
    async settle(nodeId, status, error) { const r = rows.get(nodeId); if (r && r.status === "running") { r.status = status; r.error = error ?? null; r.leaseUntil = null; } },
    async list() { return [...rows.values()].map((r) => ({ nodeId: r.nodeId, compensator: r.compensator, seq: r.seq, status: r.status, error: r.error })); },
  };
}
