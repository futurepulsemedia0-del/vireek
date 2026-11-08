import { describe, expect, it } from "vitest";
import { applyEdits, diffIr, MAX_EDIT_OPS, rollbackCandidate, stable } from "./graph-diff.ts";
import { compileIr, type WorkflowIr } from "./spec.ts";

const base = (): WorkflowIr => ({
  name: "Chain", summary: "s", trigger: { event: "call.emergency" }, sla_minutes: 30,
  nodes: [
    { id: "c1", kind: "lookup", label: "Customer", capability: "customer_profile" },
    { id: "l1", kind: "lookup", label: "Techs", capability: "technician_roster" },
    { id: "l2", kind: "lookup", label: "Parts", capability: "part_availability", params: { query_path: "c1.name", min_qty: 1 } },
    { id: "n", kind: "action", label: "Notify", capability: "notify_owner", params: { title: "t", message: "m" } },
  ],
  edges: [{ from: "c1", to: "l1", on: "next" }, { from: "l1", to: "l2", on: "next" }, { from: "l2", to: "n", on: "next" }],
});

describe("diffIr", () => {
  it("is identical for the same graph regardless of key order", () => {
    const a = base(); const b = JSON.parse(JSON.stringify(a)); b.nodes[2].params = { min_qty: 1, query_path: "c1.name" };
    expect(diffIr(a, b).identical).toBe(true);
    expect(stable({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(stable({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
  it("reports added/removed nodes, retargeted edges, changed params and meta", () => {
    const a = base(); const b = base();
    b.nodes[2].params = { query_path: "c1.name", min_qty: 5 };
    b.nodes.push({ id: "z", kind: "action", label: "Z", capability: "notify_owner", params: { title: "t", message: "m" } });
    b.edges.push({ from: "n", to: "z", on: "next" });
    b.sla_minutes = 45; b.name = "Chain v2";
    const d = diffIr(a, b);
    expect(d.nodes.added).toEqual(["z"]);
    expect(d.nodes.changed.map((c) => c.id)).toEqual(["l2"]);
    expect(d.nodes.changed[0].fields[0].field).toBe("params");
    expect(d.edges.added).toHaveLength(1);
    expect(d.meta.map((m) => m.field)).toEqual(["name", "sla_minutes"]);
    const back = diffIr(b, a);
    expect(back.nodes.removed).toEqual(["z"]);
  });
  it("rollback candidate is a deep copy that diffs as identical and shares no references", () => {
    const a = base(); const r = rollbackCandidate(a);
    expect(diffIr(a, r).identical).toBe(true);
    r.nodes[0].label = "changed";
    expect(a.nodes[0].label).toBe("Customer");
  });
});

describe("applyEdits", () => {
  it("never mutates the base and the result still compiles", () => {
    const a = base(); const snap = stable(a);
    const r = applyEdits(a, [{ op: "set_label", node: "n", label: "Tell owner" }, { op: "set_param", node: "l2", key: "min_qty", value: 3 }]);
    expect(stable(a)).toBe(snap);
    expect(r.errors).toEqual([]);
    expect((compileIr(r.ir) as any).ok).toBe(true);
    const d = diffIr(a, r.ir!);
    expect(d.nodes.added).toEqual([]); expect(d.edges.added).toEqual([]); expect(d.edges.removed).toEqual([]);
    expect(d.nodes.changed.map((c) => c.id)).toEqual(["l2", "n"]);
  });
  it("swaps two consecutive steps and rewires edges consistently", () => {
    const r = applyEdits(base(), [{ op: "swap_adjacent", first: "l1", second: "l2" }]);
    expect(r.errors).toEqual([]);
    expect(r.ir!.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["c1>l2", "l1>n", "l2>l1"]);
    expect((compileIr(r.ir) as any).ok).toBe(true);
  });
  it("refuses swaps that are not a plain next-chain, including the entry node", () => {
    expect(applyEdits(base(), [{ op: "swap_adjacent", first: "c1", second: "l1" }]).ir).toBeNull();
    expect(applyEdits(base(), [{ op: "swap_adjacent", first: "l1", second: "n" }]).ir).toBeNull();
    expect(applyEdits(base(), [{ op: "swap_adjacent", first: "l1", second: "l1" }]).ir).toBeNull();
  });
  it("rejects prototype pollution, bad values, wrong node kinds, unknown ops and oversize batches", () => {
    const bad = (op: any) => applyEdits(base(), [op]).errors.length > 0;
    expect(bad({ op: "set_param", node: "l2", key: "__proto__", value: 1 })).toBe(true);
    expect(bad({ op: "set_param", node: "l2", key: "constructor", value: 1 })).toBe(true);
    expect(bad({ op: "set_param", node: "l2", key: "Bad Key", value: 1 })).toBe(true);
    expect(bad({ op: "set_param", node: "l2", key: "k", value: { a: 1 } })).toBe(true);
    expect(bad({ op: "set_param", node: "l2", key: "k", value: Infinity })).toBe(true);
    expect(bad({ op: "set_param", node: "l2", key: "k", value: "x".repeat(401) })).toBe(true);
    expect(bad({ op: "set_timeout_minutes", node: "l2", minutes: 5 })).toBe(true);
    expect(bad({ op: "set_label", node: "nope", label: "x" })).toBe(true);
    expect(bad({ op: "set_label", node: "n", label: "  " })).toBe(true);
    expect(bad({ op: "drop_node", node: "n" })).toBe(true);
    expect(applyEdits(base(), []).ir).toBeNull();
    expect(applyEdits(base(), Array.from({ length: MAX_EDIT_OPS + 1 }, () => ({ op: "set_label", node: "n", label: "x" } as const))).ir).toBeNull();
    expect(({} as any).k).toBe(undefined); // global prototype untouched
  });
  it("an edit that breaks validation is caught by the real validator (server stays the authority)", () => {
    const r = applyEdits(base(), [{ op: "set_param", node: "l2", key: "query_path", value: "zzz.x" }]);
    expect(r.errors).toEqual([]);
    expect((compileIr(r.ir) as any).ok).toBe(false);
  });
});
