import { describe, expect, it } from "vitest";
import { compileIr, enumeratePaths, findEntry, sideNodes } from "./spec.ts";

const on = { allowParallel: true };
const errs = (ir: any) => ((compileIr(ir, on) as any).errors ?? []).join(" | ");
const ok = (ir: any) => (compileIr(ir, on) as any).ok === true;

function fanIr(): any {
  return {
    name: "Fan out", summary: "s", trigger: { event: "call.emergency" }, sla_minutes: 30,
    nodes: [
      { id: "c1", kind: "lookup", label: "Customer", capability: "customer_profile" },
      { id: "l_tech", kind: "lookup", label: "Techs", capability: "technician_roster" },
      { id: "fe", kind: "foreach", label: "Each tech", params: { collection_path: "l_tech.available_names", max_items: 50, concurrency: 5, body: "each" } },
      { id: "each", kind: "action", label: "Text one", capability: "send_sms", params: { body: "Hello {{item.name}}, job for {{customer.name}}" } },
      { id: "done", kind: "action", label: "Notify", capability: "notify_owner", params: { title: "ok", message: "{{fe.processed}} done" } },
    ],
    edges: [{ from: "c1", to: "l_tech", on: "next" }, { from: "l_tech", to: "fe", on: "next" }, { from: "fe", to: "done", on: "next" }],
  };
}

function sagaIr(): any {
  return {
    name: "Saga", summary: "s", trigger: { event: "call.emergency" }, sla_minutes: 30,
    nodes: [
      { id: "c1", kind: "lookup", label: "Customer", capability: "customer_profile" },
      { id: "ap", kind: "approval", label: "Confirm", prompt: "ok?", timeout_minutes: 10 },
      { id: "dispatch", kind: "action", label: "Dispatch", capability: "dispatch_technician", compensator: "undo" },
      { id: "undo", kind: "action", label: "Tell owner to undo", capability: "notify_owner", params: { title: "Undo", message: "Cancel job {{dispatch.job_id}}" } },
      { id: "done", kind: "action", label: "Notify", capability: "notify_owner", params: { title: "ok", message: "x" } },
    ],
    edges: [{ from: "c1", to: "ap", on: "next" }, { from: "ap", to: "dispatch", on: "approved" }, { from: "dispatch", to: "done", on: "next" }],
  };
}

describe("gate", () => {
  it("foreach and compensator are rejected unless the runtime supports them", () => {
    for (const ir of [fanIr(), sagaIr()]) {
      const r: any = compileIr(ir);
      expect(r.ok).toBe(false);
      expect(r.errors.join(" ")).toContain("not enabled");
    }
  });
});

describe("foreach", () => {
  it("compiles; side body is declared, not wired, and never an entry", () => {
    const r: any = compileIr(fanIr(), on);
    expect(r.ok).toBe(true);
    expect(r.report.fan_out_nodes).toBe(1);
    expect(r.graph.entry).toBe("c1");
    expect(findEntry(fanIr())).toEqual(["c1"]);
    expect([...sideNodes(fanIr()).keys()]).toEqual(["each"]);
    expect(r.graph.nodes.each.capability).toBe("send_sms");
    expect(r.graph.edges.each).toEqual({});
    expect(r.graph.edges.fe.fail).toBe("__escalate");
    expect(enumeratePaths(r.graph).paths.every((p) => !p.includes("each"))).toBe(true);
  });
  it("item.* is available only inside the body", () => {
    expect(errs(fanIr())).toBe("");
    const bad = fanIr(); bad.nodes[4].params.message = "{{item.name}}";
    expect(errs(bad)).toContain("only available inside a foreach body");
  });
  it("the body cannot read nodes that were not guaranteed before the foreach", () => {
    const bad = fanIr(); bad.nodes[3].params.body = "{{done.x}} {{item.name}}";
    expect(errs(bad)).toContain("done");
  });
  it("rejects bad limits, params and collection paths", () => {
    const t = (mut: (n: any) => void) => { const ir = fanIr(); mut(ir.nodes[2]); return errs(ir); };
    expect(t((n) => { n.params.max_items = 0; })).toContain("max_items");
    expect(t((n) => { n.params.max_items = 201; })).toContain("0..200");
    expect(t((n) => { n.params.concurrency = 11; })).toContain("concurrency");
    expect(t((n) => { n.params.concurrency = 0; })).toContain("concurrency");
    expect(t((n) => { delete n.params.max_items; })).toContain("max_items");
    expect(t((n) => { n.params.evil = 1; })).toContain("unknown param");
    expect(t((n) => { n.params.collection_path = "nope"; })).toContain("collection_path");
    expect(t((n) => { n.params.collection_path = "done.x"; })).toContain("collection_path");
    expect(t((n) => { delete n.params.body; })).toContain("params.body");
  });
  it("body must exist, be an action/lookup, have no edges and belong to one foreach", () => {
    const unknown = fanIr(); unknown.nodes[2].params.body = "ghost";
    expect(errs(unknown)).toContain("unknown node");
    const kind = fanIr(); kind.nodes[3] = { id: "each", kind: "wait", label: "w", params: { minutes: 5 } };
    expect(errs(kind)).toContain("must be an action or lookup");
    const wired = fanIr(); wired.edges.push({ from: "each", to: "done", on: "next" });
    expect(errs(wired)).toContain("must not have any edges");
    const twice = fanIr();
    twice.nodes.splice(3, 0, { id: "fe2", kind: "foreach", label: "Again", params: { collection_path: "l_tech.available_names", max_items: 5, concurrency: 1, body: "each" } });
    twice.edges = [{ from: "c1", to: "l_tech", on: "next" }, { from: "l_tech", to: "fe", on: "next" }, { from: "fe", to: "fe2", on: "next" }, { from: "fe2", to: "done", on: "next" }];
    expect(errs(twice)).toContain("used by more than one");
  });
  it("a commitment body needs an approval before the foreach and carries a warning", () => {
    const ir = fanIr(); ir.nodes[3] = { id: "each", kind: "action", label: "Dispatch each", capability: "dispatch_technician" };
    expect(errs(ir)).toContain("human_approval");
    ir.nodes.splice(2, 0, { id: "ap", kind: "approval", label: "Confirm", prompt: "ok?", timeout_minutes: 10 });
    ir.edges = [{ from: "c1", to: "l_tech", on: "next" }, { from: "l_tech", to: "ap", on: "next" }, { from: "ap", to: "fe", on: "approved" }, { from: "fe", to: "done", on: "next" }];
    const r: any = compileIr(ir, on);
    expect(r.ok).toBe(true);
    expect(r.report.warnings.join(" ")).toContain("once per item");
  });
  it("is not allowed inside a parallel branch", () => {
    const ir: any = fanIr();
    ir.nodes = [
      { id: "c1", kind: "lookup", label: "Customer", capability: "customer_profile" },
      { id: "p", kind: "parallel", label: "Fan" },
      { id: "j", kind: "join", label: "Join", params: { parallel: "p", mode: "all" } },
      { id: "fe", kind: "foreach", label: "Each", params: { collection_path: "c1.tags", max_items: 5, concurrency: 1, body: "each" } },
      { id: "t1", kind: "lookup", label: "T", capability: "technician_roster" },
      { id: "each", kind: "action", label: "Text", capability: "send_sms", params: { body: "hi {{item.x}}" } },
      { id: "done", kind: "action", label: "Notify", capability: "notify_owner", params: { title: "o", message: "m" } },
    ];
    ir.edges = [{ from: "c1", to: "p", on: "next" }, { from: "p", to: "fe", on: "b0" }, { from: "p", to: "t1", on: "b1" }, { from: "fe", to: "j", on: "next" }, { from: "t1", to: "j", on: "next" }, { from: "j", to: "done", on: "next" }];
    expect(errs(ir)).toContain("not allowed inside a parallel branch");
  });
});

describe("compensator", () => {
  it("compiles; the undo node can read its owner's outputs and is a wiring-free side node", () => {
    const r: any = compileIr(sagaIr(), on);
    expect(r.ok).toBe(true);
    expect(r.report.compensated_actions).toBe(1);
    expect(r.graph.entry).toBe("c1");
    expect(r.graph.edges.undo).toEqual({});
    expect(r.graph.nodes.undo.capability).toBe("notify_owner");
  });
  it("other nodes still cannot read the undo node's context", () => {
    const ir = sagaIr(); ir.nodes[4].params.message = "{{undo.sent}}";
    expect(errs(ir)).toContain("undo");
  });
  it("rejects misuse", () => {
    const wrongKind = sagaIr(); wrongKind.nodes[0].compensator = "undo";
    expect(errs(wrongKind)).toContain("only action nodes");
    const unknown = sagaIr(); unknown.nodes[2].compensator = "ghost";
    expect(errs(unknown)).toContain("unknown node");
    const self = sagaIr(); self.nodes[2].compensator = "dispatch";
    expect(ok(self)).toBe(false);
    const wired = sagaIr(); wired.edges.push({ from: "undo", to: "done", on: "next" });
    expect(errs(wired)).toContain("must not have any edges");
    const nested = sagaIr(); nested.nodes[3].compensator = "done";
    expect(errs(nested)).toContain("cannot have a compensator of its own");
    const shared = sagaIr(); shared.nodes[4].compensator = "undo";
    expect(errs(shared)).toContain("used by more than one");
    const notAction = sagaIr(); notAction.nodes[3] = { id: "undo", kind: "wait", label: "w", params: { minutes: 1 } };
    expect(errs(notAction)).toContain("must be an action node");
  });
  it("the safety model still applies: an ungated commitment owner is rejected", () => {
    const ir = sagaIr(); ir.nodes = ir.nodes.filter((n: any) => n.id !== "ap");
    ir.edges = [{ from: "c1", to: "dispatch", on: "next" }, { from: "dispatch", to: "done", on: "next" }];
    expect(errs(ir)).toContain("human_approval");
  });
  it("a commitment compensator is gated by its owner's approval", () => {
    const ir = sagaIr(); ir.nodes[3] = { id: "undo", kind: "action", label: "Cancel dispatch", capability: "post_contractor_handoff", params: { trade: "hvac", title: "cancel" } };
    expect(ok(ir)).toBe(true);
    ir.nodes = ir.nodes.filter((n: any) => n.id !== "ap");
    ir.edges = [{ from: "c1", to: "dispatch", on: "next" }, { from: "dispatch", to: "done", on: "next" }];
    expect(ok(ir)).toBe(false);
  });
});
