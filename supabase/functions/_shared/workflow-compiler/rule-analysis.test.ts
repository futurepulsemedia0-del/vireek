import { describe, expect, it } from "vitest";
import { analyzeRules, disjoint, impactPreview, implies, runGolden, type PrioritizedRule } from "./rule-analysis.ts";
import { evaluateRule, type Rule } from "./spec.ts";

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const OPS = ["gt", "gte", "lt", "lte", "eq"] as const;
const rnd = (r: () => number): Rule => ({ path: "x", op: OPS[Math.floor(r() * OPS.length)], value: Math.floor(r() * 11) });
const SAMPLES = Array.from({ length: 49 }, (_, i) => -1 + i * 0.25);
const holds = (rule: Rule, x: number) => evaluateRule(rule, { x });

describe("soundness against brute force (never a false positive)", () => {
  it("implies(a,b) => every sampled x matching a also matches b", () => {
    const r = rng(21);
    for (let i = 0; i < 4000; i++) {
      const a = rnd(r), b = rnd(r);
      if (implies(a, b)) for (const x of SAMPLES) if (holds(a, x)) expect(holds(b, x)).toBe(true);
    }
  });
  it("disjoint(a,b) => no sampled x matches both", () => {
    const r = rng(22);
    for (let i = 0; i < 4000; i++) {
      const a = rnd(r), b = rnd(r);
      if (disjoint(a, b)) for (const x of SAMPLES) expect(holds(a, x) && holds(b, x)).toBe(false);
    }
  });
  it("shadowed/redundant findings are real: the later rule never matches anything the earlier one misses", () => {
    const r = rng(23);
    for (let i = 0; i < 1500; i++) {
      const rules: PrioritizedRule[] = Array.from({ length: 4 }, (_, k) => ({ id: `r${k}`, priority: k, when: [rnd(r), rnd(r)].slice(0, 1 + Math.floor(r() * 2)), outcome: r() < 0.5 ? "A" : "B" }));
      const byId = new Map(rules.map((x) => [x.id, x]));
      for (const f of analyzeRules(rules)) {
        const later = byId.get(f.rule)!;
        if (f.kind === "unsatisfiable") { for (const x of SAMPLES) expect(later.when.every((c) => holds(c, x))).toBe(false); }
        if ((f.kind === "shadowed" || f.kind === "redundant") && f.by) {
          const earlier = byId.get(f.by)!;
          for (const x of SAMPLES) if (later.when.every((c) => holds(c, x))) expect(earlier.when.every((c) => holds(c, x))).toBe(true);
        }
      }
    }
  });
});

describe("analyzeRules", () => {
  const rule = (id: string, priority: number, when: Rule[], outcome: string): PrioritizedRule => ({ id, priority, when, outcome });
  it("finds shadowing, redundancy, unsatisfiable and ambiguity", () => {
    const f = analyzeRules([
      rule("vip_any", 1, [{ path: "spend", op: "gt", value: 100 }], "priority"),
      rule("vip_big", 2, [{ path: "spend", op: "gt", value: 500 }], "standard"),
      rule("vip_big2", 3, [{ path: "spend", op: "gte", value: 600 }], "priority"),
      rule("never", 4, [{ path: "a", op: "gt", value: 5 }, { path: "a", op: "lt", value: 3 }], "x"),
      rule("tie_a", 5, [{ path: "t", op: "gt", value: 1 }], "A"),
      rule("tie_b", 5, [{ path: "t", op: "lt", value: 9 }], "B"),
    ]);
    const kinds = f.map((x) => `${x.kind}:${x.rule}`);
    expect(kinds).toContain("shadowed:vip_big");
    expect(kinds).toContain("redundant:vip_big2");
    expect(kinds).toContain("unsatisfiable:never");
    expect(kinds).toContain("ambiguous:tie_b");
  });
  it("reports nothing for disjoint, well-ordered rules", () => {
    expect(analyzeRules([
      { id: "a", priority: 1, when: [{ path: "x", op: "lt", value: 5 }], outcome: "A" },
      { id: "b", priority: 2, when: [{ path: "x", op: "gte", value: 5 }], outcome: "B" },
    ])).toEqual([]);
  });
});

describe("golden scenarios and impact preview", () => {
  const decide = (rules: Rule[]) => (i: { x: number }) => (rules.every((r) => evaluateRule(r, i)) ? "go" : "stop");
  it("passes, fails and survives a throwing decider", () => {
    const g = runGolden([{ name: "big", input: { x: 9 }, expect: "go" }, { name: "small", input: { x: 1 }, expect: "go" }], decide([{ path: "x", op: "gt", value: 5 }]));
    expect(g.passed).toBe(1);
    expect(g.failures.map((f) => f.name)).toEqual(["small"]);
    const t = runGolden([{ name: "boom", input: 1, expect: 1 }], () => { throw new Error("bad"); });
    expect(t.failures[0].actual).toEqual({ error: "bad" });
  });
  it("counts exactly the decisions a change would have altered", () => {
    const past = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, input: { x: i } }));
    const r = impactPreview(past, decide([{ path: "x", op: "gt", value: 50 }]), decide([{ path: "x", op: "gt", value: 60 }]), 5);
    expect(r.total).toBe(100);
    expect(r.altered).toBe(10);
    expect(r.ids).toHaveLength(5);
    expect(impactPreview(past, decide([]), decide([])).altered).toBe(0);
  });
});
