import { describe, expect, it } from "vitest";
import { createMemoryTokenStore, mergeTokenOutputs, runForeach, runParallel, type ExecResult, type ParallelRunDeps, type Token } from "./tokens.ts";
import type { JoinConfig } from "./semantics.ts";
import { compileIr } from "./spec.ts";

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
  return { graph: r.graph, starts: Array.from({ length: m }, (_, i) => `t${i}_0`) };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function setup(m: number, cfg: JoinConfig, script: (node: string) => ExecResult = () => ({ edge: "next" }), o: { len?: number; concurrency?: number; leaseMs?: number; slow?: boolean } = {}) {
  const joinParams = cfg.mode === "timeout" ? { mode: "timeout", timeout_minutes: 1, on_timeout: cfg.on_timeout, min_success: cfg.min_success } : cfg;
  const { graph, starts } = graphFor(m, joinParams as any, o.len ?? 1);
  let clock = 1000;
  const store = createMemoryTokenStore({ now: () => clock, leaseMs: o.leaseMs ?? 90_000 });
  const calls: string[] = []; let live = 0; let peak = 0;
  const deps = (deadline = Infinity): ParallelRunDeps => ({
    graph, joinId: "j", maxHops: 10, store, cfg, starts, concurrency: o.concurrency ?? 8, deadline, now: () => clock,
    exec: async (_t: Token, node: string) => { calls.push(node); live++; peak = Math.max(peak, live); if (o.slow) await tick(); live--; clock += 1; return script(node); },
  });
  return { store, calls, deps, graph, advance: (ms: number) => { clock += ms; }, peak: () => peak, clock: () => clock };
}

describe("token spawn is idempotent (UNIQUE run_id+scope_key)", () => {
  it("spawning twice creates each token once", async () => {
    const h = setup(3, { mode: "all" });
    const s = [{ ordinal: 0, cursor: "t0_0" }, { ordinal: 1, cursor: "t1_0" }];
    expect(await h.store.spawn("p", "branch", s)).toBe(2);
    expect(await h.store.spawn("p", "branch", s)).toBe(0);
    expect((await h.store.list("p")).length).toBe(2);
  });
  it("a branch token without a cursor is rejected", async () => {
    const h = setup(2, { mode: "all" });
    await expect(h.store.spawn("p", "branch", [{ ordinal: 0, cursor: null }])).rejects.toBeTruthy();
  });
});

describe("runParallel", () => {
  it("all-mode: every branch node runs exactly once and the join proceeds", async () => {
    const h = setup(3, { mode: "all" }, undefined, { len: 2 });
    const r = await runParallel("p", h.deps());
    expect(r.kind).toBe("released");
    if (r.kind === "released") { expect(r.decision.action).toBe("proceed"); expect(r.tokens.every((t) => t.status === "succeeded")).toBe(true); }
    expect([...h.calls].sort()).toEqual(["t0_0", "t0_1", "t1_0", "t1_1", "t2_0", "t2_1"]);
  });
  it("branches really run concurrently", async () => {
    const h = setup(4, { mode: "all" }, undefined, { slow: true, concurrency: 4 });
    await runParallel("p", h.deps());
    expect(h.peak()).toBeGreaterThan(1);
  });
  it("concurrency 1 behaves sequentially", async () => {
    const h = setup(4, { mode: "all" }, undefined, { slow: true, concurrency: 1 });
    await runParallel("p", h.deps());
    expect(h.peak()).toBe(1);
  });
  it("any-mode: siblings nobody started are cancelled and never run", async () => {
    const h = setup(4, { mode: "any" }, undefined, { concurrency: 1 });
    const r = await runParallel("p", h.deps());
    expect(r.kind).toBe("released");
    expect(h.calls).toEqual(["t0_0"]);
    const st = (await h.store.list("p")).map((t) => t.status);
    expect(st).toEqual(["succeeded", "cancelled", "cancelled", "cancelled"]);
  });
  it("all-mode: one failing branch fails the join", async () => {
    const h = setup(3, { mode: "all" }, (n) => (n === "t1_0" ? { edge: "fail", error: "boom" } : { edge: "next" }));
    const r = await runParallel("p", h.deps());
    expect(r.kind === "released" && r.decision.action).toBe("fail");
  });
  it("a token interrupted mid-node (expired lease, inflight set) is failed and NEVER re-run", async () => {
    const h = setup(2, { mode: "all" }, undefined, { leaseMs: 1000 });
    await h.store.spawn("p", "branch", [{ ordinal: 0, cursor: "t0_0" }, { ordinal: 1, cursor: "t1_0" }]);
    const [t] = await h.store.claim("p", 1);
    t.inflight = t.cursor; await h.store.save(t, "running", { inflight: t.cursor }); // process dies here
    h.advance(5000);
    const r = await runParallel("p", h.deps());
    expect(h.calls).not.toContain("t0_0");
    expect(h.calls).toContain("t1_0");
    expect(r.kind === "released" && r.decision.action).toBe("fail");
    const tok = (await h.store.list("p"))[0];
    expect(tok.status).toBe("failed"); expect(tok.error).toMatch(/unknown/);
  });
  it("a token between nodes (no inflight marker) resumes from its cursor on the next tick", async () => {
    const h = setup(1 + 1, { mode: "all" }, undefined, { len: 3 });
    let stop = false;
    const d = h.deps(); const exec = d.exec;
    d.exec = async (t, n) => { const r = await exec(t, n); if (n === "t0_0") stop = true; return r; };
    d.deadline = 5_000_000;
    // first tick is cut right after the first node of branch 0 by a deadline function
    const cut = { ...d, now: () => (stop ? 9_000_000 : h.clock()) };
    expect((await runParallel("p", cut)).kind).toBe("yield");
    const second = await runParallel("p", h.deps(5_000_000));
    expect(second.kind).toBe("released");
    expect(h.calls.filter((c) => c === "t0_0").length).toBe(1);
    expect(h.calls.filter((c) => c.startsWith("t0_")).length).toBe(3);
  });
  it("two workers racing on the same block execute every node exactly once", async () => {
    const h = setup(6, { mode: "all" }, undefined, { slow: true, concurrency: 3, len: 2 });
    const [a, b] = await Promise.all([runParallel("p", h.deps()), runParallel("p", h.deps())]);
    let settled = [a, b].some((x) => x.kind === "released");
    for (let i = 0; i < 5 && !settled; i++) settled = (await runParallel("p", h.deps())).kind === "released";
    expect(settled).toBe(true);
    const counts = new Map<string, number>(); for (const c of h.calls) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(12);
    for (const v of counts.values()) expect(v).toBe(1);
  });
  it("hop limit fails the token instead of looping", async () => {
    const h = setup(2, { mode: "all" }, undefined, { len: 3 });
    const d = { ...h.deps(), maxHops: 1 };
    const r = await runParallel("p", d);
    expect(r.kind === "released" && r.decision.action).toBe("fail");
  });
});

describe("runForeach", () => {
  const mk = (total: number, concurrency: number, fail = -1) => {
    let clock = 0; const store = createMemoryTokenStore({ now: () => clock });
    const ran: number[] = []; let live = 0; let peak = 0;
    const deps = () => ({
      store, total, concurrency, now: () => clock, deadline: Infinity,
      runItem: async (i: number) => { ran.push(i); live++; peak = Math.max(peak, live); await tick(); live--; clock++; return { ok: i !== fail, output: { i } }; },
    });
    return { store, ran, deps, peak: () => peak };
  };
  it("runs every item once and never exceeds the concurrency limit", async () => {
    const h = mk(20, 3);
    const r = await runForeach("f", h.deps());
    expect(r).toEqual({ kind: "completed", done: 20, failed: 0 });
    expect([...h.ran].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(h.peak()).toBeLessThanOrEqual(3);
  });
  it("the concurrency limit also holds across two competing workers", async () => {
    const h = mk(24, 4);
    await Promise.all([runForeach("f", h.deps()), runForeach("f", h.deps())]);
    const r = await runForeach("f", h.deps());
    expect(r.kind).toBe("completed");
    expect(h.peak()).toBeLessThanOrEqual(4);
    expect(h.ran.length).toBe(24);
    expect(new Set(h.ran).size).toBe(24);
  });
  it("fail-fast: after a failed item no new item starts and the block fails", async () => {
    const h = mk(10, 1, 3);
    const r = await runForeach("f", h.deps());
    expect(r.kind).toBe("failed");
    expect(h.ran).toEqual([0, 1, 2, 3]);
  });
  it("an empty collection is rejected upstream; one item works", async () => {
    const h = mk(1, 1);
    expect((await runForeach("f", h.deps())).kind).toBe("completed");
  });
});

describe("mergeTokenOutputs", () => {
  it("is deterministic regardless of completion order", () => {
    const t = (ordinal: number, id: string): Token => ({ scope: `p:b${ordinal}`, parent: "p", kind: "branch", ordinal, cursor: null, hops: 1, status: "succeeded", inflight: null, error: null, createdAt: 0, attempts: 1, output: { outputs: { [id]: { v: ordinal } }, done: [{ nodeId: id, status: "completed" }] } });
    const a = mergeTokenOutputs([t(1, "x"), t(0, "y")], 5);
    const b = mergeTokenOutputs([t(0, "y"), t(1, "x")], 5);
    expect(a).toEqual(b);
    expect(a.done.map((d) => d.seq)).toEqual([5, 6]);
    expect(a.done[0].nodeId).toBe("y");
  });
});
