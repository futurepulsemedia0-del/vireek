import { describe, expect, it } from "vitest";
import { compileIr, computeBlocks, joinConfigFromParams } from "./spec.ts";

// c1 -> p ==(b0..b{m-1})==> one lookup per branch ==> j -> done
function parallelIr(m = 2, join: Record<string, unknown> = { mode: "all" }): any {
  const nodes: any[] = [
    { id: "c1", kind: "lookup", label: "Customer", capability: "customer_profile" },
    { id: "p", kind: "parallel", label: "Fan out" },
    { id: "j", kind: "join", label: "Join", params: { parallel: "p", ...join } },
    { id: "done", kind: "action", label: "Notify", capability: "notify_owner", params: { title: "ok", message: "x" } },
  ];
  const edges: any[] = [{ from: "c1", to: "p", on: "next" }, { from: "j", to: "done", on: "next" }];
  for (let i = 0; i < m; i++) {
    nodes.push({ id: `t${i}`, kind: "lookup", label: `Techs ${i}`, capability: "technician_roster" });
    edges.push({ from: "p", to: `t${i}`, on: `b${i}` }, { from: `t${i}`, to: "j", on: "next" });
  }
  return { name: "Parallel", summary: "s", trigger: { event: "call.emergency" }, sla_minutes: 30, nodes, edges };
}
const on = { allowParallel: true };
const errs = (ir: any) => ((compileIr(ir, on) as any).errors ?? []).join(" | ");

describe("parallel gate", () => {
  it("is rejected by default, so the live compiler cannot produce graphs the executor cannot run", () => {
    const r: any = compileIr(parallelIr());
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("not enabled");
  });
  it("a stray branch edge is also gated", () => {
    const ir = parallelIr(); ir.nodes = ir.nodes.filter((n: any) => n.kind !== "parallel" && n.kind !== "join");
    expect((compileIr(ir) as any).ok).toBe(false);
  });
});

describe("parallel compile (gate open)", () => {
  it("compiles 2..8 branches in every join mode", () => {
    for (let m = 2; m <= 8; m++) {
      for (const j of [{ mode: "all" }, { mode: "any" }, { mode: "n_of_m", n: m }, { mode: "timeout", timeout_minutes: 5, on_timeout: "proceed", min_success: 1 }]) {
        const r: any = compileIr(parallelIr(m, j), on);
        expect(r.ok).toBe(true);
        expect(r.report.parallel_blocks).toBe(1);
      }
    }
  });
  it("routes branch failures to the join and join failure to escalation", () => {
    const r: any = compileIr(parallelIr(3), on);
    for (let i = 0; i < 3; i++) expect(r.graph.edges[`t${i}`].fail).toBe("j");
    expect(r.graph.edges.j.fail).toBe("__escalate");
    expect(r.graph.edges.p.b2).toBe("t2");
  });
  it("keeps an explicit fail edge inside the branch", () => {
    const ir = parallelIr(2);
    ir.nodes.push({ id: "fix", kind: "action", label: "Fix", capability: "notify_owner", params: { title: "t", message: "m" } });
    ir.edges.push({ from: "t0", to: "fix", on: "fail" }, { from: "fix", to: "j", on: "next" });
    const r: any = compileIr(ir, on);
    expect(r.ok).toBe(true);
    expect(r.graph.edges.t0.fail).toBe("fix");
    expect(r.graph.edges.fix.fail).toBe("j");
  });
  it("computeBlocks exposes disjoint regions", () => {
    const [b] = computeBlocks(parallelIr(3));
    expect(b.join).toBe("j");
    expect(b.regions.map((r) => [...r])).toEqual([["t0"], ["t1"], ["t2"]]);
  });
  it("downstream nodes can read the join output but not a branch output", () => {
    const ok = parallelIr(2); ok.nodes[3].params.message = "done {{j.succeeded}}";
    expect((compileIr(ok, on) as any).ok).toBe(true);
    const bad = parallelIr(2); bad.nodes[3].params.message = "x {{t0.total}}";
    expect(errs(bad)).toContain("t0");
  });
});

describe("parallel structural rejections", () => {
  it("one branch, nine branches, gaps", () => {
    expect(errs(parallelIr(1))).toContain("2..8");
    const nine = parallelIr(8); nine.nodes.push({ id: "x", kind: "lookup", label: "x", capability: "technician_roster" });
    nine.edges.push({ from: "p", to: "x", on: "b8" });
    expect((compileIr(nine, on) as any).ok).toBe(false);
    const gap = parallelIr(3); gap.edges.find((e: any) => e.on === "b1").on = "b5";
    expect(errs(gap)).toContain("without gaps");
  });
  it("missing, duplicate or mistargeted join", () => {
    const none = parallelIr(); none.nodes = none.nodes.filter((n: any) => n.id !== "j"); none.edges = none.edges.filter((e: any) => e.from !== "j" && e.to !== "j");
    expect((compileIr(none, on) as any).ok).toBe(false); // orphaned downstream node is rejected as a second entry
    const bad = parallelIr(); bad.nodes[2].params.parallel = "c1";
    expect(errs(bad)).toContain("must be the id of a parallel node");
    const dbl = parallelIr(); dbl.nodes.push({ id: "j2", kind: "join", label: "J2", params: { parallel: "p", mode: "all" } });
    expect((compileIr(dbl, on) as any).ok).toBe(false); // second join is an unreachable second entry
  });
  it("bad join config", () => {
    expect(errs(parallelIr(2, { mode: "n_of_m", n: 3 }))).toContain("n must be");
    expect(errs(parallelIr(2, { mode: "bogus" }))).toContain("params.mode");
    expect(errs(parallelIr(2, { mode: "timeout", timeout_minutes: 0, on_timeout: "proceed" }))).toContain("timeout_ms");
    expect(errs(parallelIr(2, { mode: "all", evil: 1 }))).toContain("unknown param");
  });
  it("empty branch, approval inside a branch, nested parallel", () => {
    const empty = parallelIr(); empty.edges.find((e: any) => e.on === "b1").to = "j"; empty.nodes = empty.nodes.filter((n: any) => n.id !== "t1"); empty.edges = empty.edges.filter((e: any) => e.from !== "t1");
    expect(errs(empty)).toContain("is empty");
    const ap = parallelIr(); ap.nodes[4] = { id: "t0", kind: "approval", label: "A", prompt: "ok?", timeout_minutes: 5 };
    ap.edges = ap.edges.map((e: any) => (e.from === "t0" ? { ...e, on: "approved" } : e));
    expect(errs(ap)).toContain("not allowed inside a parallel branch");
    const nest = parallelIr(); nest.nodes[4] = { id: "t0", kind: "parallel", label: "N" };
    expect((compileIr(nest, on) as any).ok).toBe(false);
  });
  it("branch that escapes the join, shared nodes, and entering a branch from outside", () => {
    const esc = parallelIr(); esc.edges.push({ from: "t0", to: "done", on: "fail" });
    expect(errs(esc)).toContain("must lead to join");
    const shared = parallelIr(); shared.edges.find((e: any) => e.from === "p" && e.on === "b1").to = "t0";
    expect((compileIr(shared, on) as any).ok).toBe(false); // orphaned t1 is a second entry
    const outside = parallelIr(); outside.edges.push({ from: "c1", to: "t1", on: "fail" });
    expect(errs(outside)).toContain("entered from outside");
    const side = parallelIr(); side.nodes.push({ id: "z", kind: "lookup", label: "z", capability: "technician_roster" }); side.edges.push({ from: "z", to: "j", on: "next" }, { from: "c1", to: "z", on: "fail" });
    expect(errs(side)).toContain("can only be entered from its own branches");
  });
  it("a cycle through a branch is still rejected", () => {
    const cyc = parallelIr(); cyc.edges.push({ from: "done", to: "c1", on: "fail" });
    expect((compileIr(cyc, on) as any).ok).toBe(false);
  });
});

describe("safety model is preserved", () => {
  it("commitment action inside a branch needs an approval before the fork", () => {
    const ir = parallelIr();
    ir.nodes[4] = { id: "t0", kind: "action", label: "Dispatch", capability: "dispatch_technician" };
    expect(errs(ir)).toContain("human_approval");
    ir.nodes.push({ id: "ap", kind: "approval", label: "Confirm", prompt: "ok?", timeout_minutes: 10 });
    ir.edges = ir.edges.filter((e: any) => !(e.from === "c1" && e.to === "p")).concat([{ from: "c1", to: "ap", on: "next" }, { from: "ap", to: "p", on: "approved" }]);
    const r: any = compileIr(ir, on);
    expect(r.ok).toBe(true);
  });
  it("warns when a non-'all' join can cancel a branch that holds a commitment action", () => {
    const ir = parallelIr(2, { mode: "any" });
    ir.nodes[4] = { id: "t0", kind: "action", label: "Dispatch", capability: "dispatch_technician" };
    ir.nodes.push({ id: "ap", kind: "approval", label: "Confirm", prompt: "ok?", timeout_minutes: 10 });
    ir.edges = ir.edges.filter((e: any) => !(e.from === "c1" && e.to === "p")).concat([{ from: "c1", to: "ap", on: "next" }, { from: "ap", to: "p", on: "approved" }]);
    const r: any = compileIr(ir, on);
    expect(r.ok).toBe(true);
    expect(r.report.warnings.join(" ")).toContain("does not undo");
  });
  it("joinConfigFromParams maps minutes to ms", () => {
    expect(joinConfigFromParams({ mode: "timeout", timeout_minutes: 2, on_timeout: "fail" })).toEqual({ mode: "timeout", timeout_ms: 120000, on_timeout: "fail", min_success: undefined });
    expect(joinConfigFromParams({ mode: "zzz" })).toBeNull();
  });
});
