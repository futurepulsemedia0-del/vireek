import { describe, expect, it } from "vitest";
import { advanceCompensation, buildCompensationRows, createMemoryCompStore } from "./compensation.ts";
import { planCompensation, type SagaStep } from "./semantics.ts";

const steps: SagaStep[] = [
  { nodeId: "a", status: "completed", compensator: "undo_a", seq: 1 },
  { nodeId: "b", status: "completed", compensator: "undo_b", seq: 2 },
  { nodeId: "c", status: "completed", compensator: null, seq: 3 },
  { nodeId: "d", status: "failed", compensator: "undo_d", seq: 4 },
  { nodeId: "e", status: "completed", compensator: "undo_e", seq: 5 },
];
let clock = 0;
const mk = (leaseMs = 1000) => { clock = 0; return createMemoryCompStore({ now: () => clock, leaseMs }); };
const deps = (store: ReturnType<typeof mk>, log: string[], over: Partial<{ fail: string; deadline: number }> = {}) => ({
  store, now: () => clock, deadline: over.deadline ?? Infinity,
  run: async (c: string) => { log.push(c); clock++; if (c === over.fail) throw new Error("undo broke"); },
  record: async () => {},
});

describe("durable compensation", () => {
  it("plans exactly what planCompensation() would run / hand to a human", () => {
    const rows = buildCompensationRows(steps);
    const plan = planCompensation(steps);
    expect(rows.filter((r) => !r.manual).map((r) => r.compensator)).toEqual(plan.run);
    expect(rows.filter((r) => r.manual).map((r) => r.nodeId)).toEqual(plan.manual);
  });
  it("planning twice (crash + replan) inserts nothing new", async () => {
    const s = mk(); const rows = buildCompensationRows(steps);
    expect(await s.plan(rows)).toBe(3 + 1);
    expect(await s.plan(rows)).toBe(0);
  });
  it("runs undo in REVERSE completion order, once each; manual steps are never run", async () => {
    const s = mk(); await s.plan(buildCompensationRows(steps)); const log: string[] = [];
    const p = await advanceCompensation(deps(s, log));
    expect(log).toEqual(["undo_e", "undo_b", "undo_a"]);
    expect(p).toEqual({ finished: true, done: ["undo_e", "undo_b", "undo_a"], failed: [], manual: ["d"] });
  });
  it("a failing undo never blocks the rest and is reported", async () => {
    const s = mk(); await s.plan(buildCompensationRows(steps)); const log: string[] = [];
    const p = await advanceCompensation(deps(s, log, { fail: "undo_b" }));
    expect(log).toEqual(["undo_e", "undo_b", "undo_a"]);
    expect(p.failed).toEqual(["undo_b"]); expect(p.finished).toBe(true);
  });
  it("resumes across ticks without repeating a finished undo", async () => {
    const s = mk(); await s.plan(buildCompensationRows(steps)); const log: string[] = [];
    const first = await advanceCompensation(deps(s, log, { deadline: 1 }));      // deadline hits after one undo
    expect(first.finished).toBe(false); expect(log).toEqual(["undo_e"]);
    const second = await advanceCompensation(deps(s, log));
    expect(log).toEqual(["undo_e", "undo_b", "undo_a"]); expect(second.finished).toBe(true);
  });
  it("a crash mid-undo is failed (unknown outcome) and NEVER repeated", async () => {
    const s = mk(1000); await s.plan(buildCompensationRows(steps));
    const claimed = await s.claim();                       // worker takes undo_e ... and dies
    expect(claimed?.compensator).toBe("undo_e");
    expect(await s.claim()).toBeNull();                    // strictly one at a time while the lease is valid
    clock += 5000;
    const log: string[] = [];
    const p = await advanceCompensation(deps(s, log));
    expect(log).not.toContain("undo_e");
    expect(p.failed).toEqual(["undo_e"]); expect(log).toEqual(["undo_b", "undo_a"]);
  });
  it("two workers never run the same undo", async () => {
    const s = mk(); await s.plan(buildCompensationRows(steps)); const log: string[] = [];
    await Promise.all([advanceCompensation(deps(s, log)), advanceCompensation(deps(s, log))]);
    expect(log.length).toBe(new Set(log).size);
  });
  it("nothing to undo finishes immediately", async () => {
    const s = mk(); const p = await advanceCompensation(deps(s, []));
    expect(p.finished).toBe(true);
  });
});
