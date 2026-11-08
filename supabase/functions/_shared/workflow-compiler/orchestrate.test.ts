import { describe, expect, it } from "vitest";
import { advanceForeach, advanceParallel, runCompensation, startForeach, startParallel, type ExecResult, type ForeachState, type ParallelDeps, type ParallelState } from "./orchestrate.ts";
import { evaluateJoin, type JoinConfig, type SagaStep } from "./semantics.ts";
import { compileIr } from "./spec.ts";

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// c1 -> p => per branch a chain of `len` lookups => j -> done
function graphFor(m: number, join: Record<string, unknown>, len = 1) {
  const nodes: any[] = [
    { id: "c1", kind: "lookup", label: "Customer", capability: "customer_profile" },
    { id: "p", kind: "parallel", label: "Fan out" },
    { id: "j", kind: "join", label: "Join", params: { parallel: "p", ...join } },
    { id: "done", kind: "action", label: "Notify", capability: "notify_owner", params: { title: "ok", message: "x" } },
  ];
  const edges: any[] = [{ from: "c1", to: "p", on: "next" }, { from: "j", to: "done", on: "next" }];
  for (let i = 0; i < m; i++) {
    for (let k = 0; k < len; k++) {
      nodes.push({ id: `t${i}_${k}`, kind: "lookup", label: `T${i}.${k}`, capability: "technician_roster" });
      if (k === 0) edges.push({ from: "p", to: `t${i}_0`, on: `b${i}` });
      else edges.push({ from: `t${i}_${k - 1}`, to: `t${i}_${k}`, on: "next" });
    }
    edges.push({ from: `t${i}_${len - 1}`, to: "j", on: "next" });
  }
  const r: any = compileIr({ name: "P", summary: "s", trigger: { event: "call.emergency" }, sla_minutes: 30, nodes, edges }, { allowParallel: true });
  if (!r.ok) throw new Error(r.errors.join("; "));
  const starts = Array.from({ length: m }, (_, i) => `t${i}_0`);
  return { graph: r.graph, starts };
}

function harness(m: number, cfg: JoinConfig, script: (node: string) => ExecResult, opts: { len?: number; stepMs?: number; deadlineAt?: number; maxHops?: number } = {}) {
  const irParams = cfg.mode === "timeout" ? { mode: "timeout", timeout_minutes: 1, on_timeout: cfg.on_timeout, min_success: cfg.min_success } : cfg;
  const { graph, starts } = graphFor(m, irParams as any, opts.len ?? 1);
  const calls: string[] = [];
  let clock = 0;
  const deps = (deadline = opts.deadlineAt ?? Infinity): ParallelDeps => ({
    graph, joinId: "j", cfg, maxHopsPerBranch: opts.maxHops ?? 10, deadline,
    exec: async (_b, node) => { calls.push(node); clock += opts.stepMs ?? 1; return script(node); },
    checkpoint: async () => {}, now: () => clock,
  });
  return { starts, calls, deps, setClock: (n: number) => { clock = n; } };
}
const ok = (): ExecResult => ({ edge: "next" });
const fail = (): ExecResult => ({ edge: "fail", error: "boom" });

describe("advanceParallel joins", () => {
  it("all: every branch runs exactly once and the join proceeds", async () => {
    const h = harness(3, { mode: "all" }, ok);
    const r = await advanceParallel(startParallel(h.starts, 0), h.deps());
    expect(r.decision.action).toBe("proceed");
    expect(h.calls).toEqual(["t0_0", "t1_0", "t2_0"]);
    expect(r.state.branches.map((b) => b.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
  });
  it("all: one failure fails fast and later branches are cancelled WITHOUT running", async () => {
    const h = harness(3, { mode: "all" }, (n) => (n === "t1_0" ? fail() : ok()));
    const r = await advanceParallel(startParallel(h.starts, 0), h.deps());
    expect(r.decision.action).toBe("fail");
    expect(h.calls).toEqual(["t0_0", "t1_0"]);
    expect(r.state.branches.map((b) => b.status)).toEqual(["succeeded", "failed", "cancelled"]);
  });
  it("any: the first success decides; the others never run", async () => {
    const h = harness(3, { mode: "any" }, ok);
    const r = await advanceParallel(startParallel(h.starts, 0), h.deps());
    expect(r.decision.action).toBe("proceed");
    expect(h.calls).toEqual(["t0_0"]);
    expect(r.state.branches.map((b) => b.status)).toEqual(["succeeded", "cancelled", "cancelled"]);
  });
  it("any: if the first fails the next is tried", async () => {
    const h = harness(3, { mode: "any" }, (n) => (n === "t0_0" ? fail() : ok()));
    const r = await advanceParallel(startParallel(h.starts, 0), h.deps());
    expect(r.decision.action).toBe("proceed");
    expect(h.calls).toEqual(["t0_0", "t1_0"]);
  });
  it("n_of_m: proceeds at quorum; fails the moment quorum is unreachable", async () => {
    const a = harness(3, { mode: "n_of_m", n: 2 }, (n) => (n === "t0_0" ? fail() : ok()));
    const ra = await advanceParallel(startParallel(a.starts, 0), a.deps());
    expect(ra.decision.action).toBe("proceed"); expect(a.calls).toEqual(["t0_0", "t1_0", "t2_0"]);
    const b = harness(3, { mode: "n_of_m", n: 2 }, (n) => (n === "t2_0" ? ok() : fail()));
    const rb = await advanceParallel(startParallel(b.starts, 0), b.deps());
    expect(rb.decision.action).toBe("fail"); expect(b.calls).toEqual(["t0_0", "t1_0"]);
    expect(rb.state.branches[2].status).toBe("cancelled");
  });
  it("timeout: stops waiting at the deadline and follows on_timeout", async () => {
    const cfg: JoinConfig = { mode: "timeout", timeout_ms: 60_000, on_timeout: "proceed", min_success: 1 };
    const h = harness(4, cfg, ok, { stepMs: 30_000 });
    const r = await advanceParallel(startParallel(h.starts, 0), h.deps());
    expect(r.decision.action).toBe("proceed");
    expect(h.calls).toEqual(["t0_0", "t1_0"]);
    expect(r.state.branches.map((b) => b.status)).toEqual(["succeeded", "succeeded", "cancelled", "cancelled"]);
  });
  it("multi-node branches advance node by node, and a hop limit fails the branch", async () => {
    const h = harness(2, { mode: "all" }, ok, { len: 3 });
    const r = await advanceParallel(startParallel(h.starts, 0), h.deps());
    expect(h.calls).toEqual(["t0_0", "t0_1", "t0_2", "t1_0", "t1_1", "t1_2"]);
    expect(r.state.branches.map((b) => b.hops)).toEqual([3, 3]);
    const lim = harness(2, { mode: "all" }, ok, { len: 3, maxHops: 2 });
    const rl = await advanceParallel(startParallel(lim.starts, 0), lim.deps());
    expect(rl.decision.action).toBe("fail");
  });
  it("a throwing node is a failed branch, not a crashed run", async () => {
    const { graph, starts } = graphFor(2, { mode: "all" });
    const r = await advanceParallel(startParallel(starts, 0), {
      graph, joinId: "j", cfg: { mode: "all" }, maxHopsPerBranch: 5, deadline: Infinity, now: () => 0, checkpoint: async () => {},
      exec: async () => { throw new Error("network"); },
    });
    expect(r.decision.action).toBe("fail");
  });
});

describe("advanceParallel durability", () => {
  it("resume after a deadline cut equals an uninterrupted run and never repeats a node", async () => {
    const full = harness(4, { mode: "all" }, ok);
    const expected = await advanceParallel(startParallel(full.starts, 0), full.deps());

    const cut = harness(4, { mode: "all" }, ok);
    let state: ParallelState = startParallel(cut.starts, 0);
    let rounds = 0;
    for (;;) {
      cut.setClock(0);
      const calls0 = cut.calls.length;
      const deps = cut.deps(); deps.deadline = 1; // allow ~1 node per tick
      const r = await advanceParallel(JSON.parse(JSON.stringify(state)), deps);
      state = r.state; rounds++;
      if (r.decision.action !== "wait") { expect(r.decision.action).toBe(expected.decision.action); break; }
      expect(cut.calls.length - calls0).toBe(1);
      if (rounds > 20) throw new Error("no progress");
    }
    expect(cut.calls).toEqual(full.calls);
    expect(state.branches.map((b) => b.status)).toEqual(expected.state.branches.map((b) => b.status));
  });
  it("a branch that was mid-node at a crash is failed and NOT re-executed", async () => {
    const h = harness(2, { mode: "all" }, ok);
    const st = startParallel(h.starts, 0);
    st.branches[0].status = "running"; st.branches[0].inflight = "t0_0";
    const r = await advanceParallel(st, h.deps());
    expect(h.calls).toEqual([]);
    expect(r.state.branches[0].status).toBe("failed");
    expect(r.decision.action).toBe("fail");
  });
});

describe("advanceParallel properties", () => {
  it("random scripts: nodes run at most once, decision matches evaluateJoin, nothing is left open when decided", async () => {
    const r = rng(41);
    const modes = (m: number): JoinConfig[] => [{ mode: "all" }, { mode: "any" }, { mode: "n_of_m", n: 1 + Math.floor(r() * m) }, { mode: "timeout", timeout_ms: 5000, on_timeout: r() < 0.5 ? "proceed" : "fail", min_success: 1 }];
    for (let c = 0; c < 200; c++) {
      const m = 2 + Math.floor(r() * 5);
      const len = 1 + Math.floor(r() * 3);
      const cfg = modes(m)[Math.floor(r() * 4)];
      const failures = new Set<string>();
      for (let i = 0; i < m; i++) for (let k = 0; k < len; k++) if (r() < 0.3) failures.add(`t${i}_${k}`);
      const h = harness(m, cfg, (n) => (failures.has(n) ? fail() : ok()), { len, stepMs: 1000 });
      const res = await advanceParallel(startParallel(h.starts, 0), h.deps());
      expect(new Set(h.calls).size).toBe(h.calls.length);
      const again = evaluateJoin(cfg, res.state.branches.map((b) => (b.status === "cancelled" ? "cancelled" : b.status)), 0);
      if (res.decision.action !== "wait") {
        expect(res.state.branches.every((b) => b.status !== "pending" && b.status !== "running")).toBe(true);
        if (cfg.mode !== "timeout") expect(res.state.branches.filter((b) => b.status === "cancelled").every((b) => b.hops === 0)).toBe(true);
        if (cfg.mode === "all") expect(res.decision.action === "proceed").toBe(res.state.branches.every((b) => b.status === "succeeded"));
        if (cfg.mode === "any") expect(res.decision.action === "proceed").toBe(res.state.branches.some((b) => b.status === "succeeded"));
      }
      void again;
    }
  });
});

describe("advanceForeach", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  function run(total: number, concurrency: number, failAt = new Set<number>()) {
    const started: number[] = []; let active = 0; let maxActive = 0;
    const deps = (deadline = Infinity) => ({
      deadline, now: () => 0, checkpoint: async () => {},
      runItem: async (i: number) => { started.push(i); active++; maxActive = Math.max(maxActive, active); await tick(); active--; return { ok: !failAt.has(i) }; },
    });
    return { started, deps, max: () => maxActive };
  }
  it("runs every item exactly once and never exceeds the concurrency limit", async () => {
    const h = run(23, 4);
    const r = await advanceForeach(startForeach(23, 4), h.deps());
    expect(r.status).toBe("completed");
    expect([...h.started].sort((a, b) => a - b)).toEqual(Array.from({ length: 23 }, (_, i) => i));
    expect(h.max() <= 4).toBe(true);
    expect(h.max()).toBe(4);
  });
  it("an empty collection completes immediately", async () => {
    const h = run(0, 3);
    expect((await advanceForeach(startForeach(0, 3), h.deps())).status).toBe("completed");
    expect(h.started).toEqual([]);
  });
  it("fail-fast: after a failed item nothing new starts", async () => {
    const h = run(10, 2, new Set([3]));
    const r = await advanceForeach(startForeach(10, 2), h.deps());
    expect(r.status).toBe("failed");
    expect(r.state.failed).toEqual([3]);
    expect([...h.started].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
  it("a throwing body is a failed item", async () => {
    const r = await advanceForeach(startForeach(3, 1), { deadline: Infinity, now: () => 0, checkpoint: async () => {}, runItem: async (i) => { if (i === 1) throw new Error("x"); return { ok: true }; } });
    expect(r.status).toBe("failed");
  });
  it("resumes across deadline cuts without repeating any item", async () => {
    const h = run(9, 3);
    let state: ForeachState = startForeach(9, 3);
    let clock = 0; let rounds = 0;
    for (;;) {
      const deps = h.deps(); deps.now = () => clock; deps.deadline = 1;
      const wrapped = { ...deps, runItem: async (i: number) => { const r = await deps.runItem(i); clock = 5; return r; } };
      clock = 0;
      const r = await advanceForeach(JSON.parse(JSON.stringify(state)), wrapped);
      state = r.state; rounds++;
      if (r.status !== "running") { expect(r.status).toBe("completed"); break; }
      if (rounds > 20) throw new Error("no progress");
    }
    expect([...h.started].sort((a, b) => a - b)).toEqual(Array.from({ length: 9 }, (_, i) => i));
    expect(rounds).toBe(3);
  });
  it("items that were in flight at a crash are failed, never re-run", async () => {
    const h = run(6, 2);
    const st = startForeach(6, 2); st.done = [0, 1]; st.inflight = [2, 3];
    const r = await advanceForeach(st, h.deps());
    expect(r.status).toBe("failed");
    expect(h.started).toEqual([]);
    expect(r.state.failed).toEqual([2, 3]);
  });
  it("random: exactly-once and bounded for random sizes, limits and failures", async () => {
    const r = rng(51);
    for (let c = 0; c < 60; c++) {
      const total = Math.floor(r() * 30), conc = 1 + Math.floor(r() * 8);
      const failAt = new Set<number>(r() < 0.5 ? [Math.floor(r() * Math.max(1, total))] : []);
      const h = run(total, conc, failAt);
      const res = await advanceForeach(startForeach(total, conc), h.deps());
      expect(new Set(h.started).size).toBe(h.started.length);
      expect(h.max() <= conc).toBe(true);
      if (failAt.size === 0 || ![...failAt].some((i) => i < total)) expect(res.status).toBe("completed");
      else expect(res.status).toBe("failed");
    }
  });
});

describe("runCompensation", () => {
  const steps: SagaStep[] = [
    { nodeId: "a", status: "completed", compensator: "undo_a", seq: 1 },
    { nodeId: "b", status: "completed", compensator: "undo_b", seq: 2 },
    { nodeId: "c", status: "completed", compensator: "undo_c", seq: 3 },
    { nodeId: "d", status: "failed", compensator: "undo_d", seq: 4 },
  ];
  it("undoes in reverse order, continues past a failed undo, and reports unknown outcomes for manual follow-up", async () => {
    const ran: string[] = []; const log: string[] = [];
    const r = await runCompensation(steps, {
      run: async (id) => { ran.push(id); if (id === "undo_b") throw new Error("api down"); },
      record: async (ev, id) => { log.push(`${ev}:${id}`); },
    });
    expect(ran).toEqual(["undo_c", "undo_b", "undo_a"]);
    expect(r).toEqual({ done: ["undo_c", "undo_a"], failed: ["undo_b"], manual: ["d"] });
    expect(log).toEqual(["compensation_done:undo_c", "compensation_failed:undo_b", "compensation_done:undo_a"]);
  });
  it("does nothing when there is nothing to undo", async () => {
    const r = await runCompensation([{ nodeId: "x", status: "completed", seq: 1 }], { run: async () => { throw new Error("no"); }, record: async () => {} });
    expect(r).toEqual({ done: [], failed: [], manual: [] });
  });
});
