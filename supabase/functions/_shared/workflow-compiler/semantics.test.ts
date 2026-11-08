import { describe, expect, it } from "vitest";
import {
  evaluateJoin, idempotencyKey, InvariantViolation, MAX_FANOUT_CONCURRENCY, planCompensation, planFanOut, replay,
  validateFanOut, validateJoinConfig,
  type BranchStatus, type JoinConfig, type RunEvent, type RunStatus, type SagaStep,
} from "./semantics.ts";

// Seeded PRNG so every property run is reproducible.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const STATUSES: BranchStatus[] = ["pending", "running", "succeeded", "failed", "cancelled", "timed_out"];
const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
const randBranches = (r: () => number) => Array.from({ length: 2 + Math.floor(r() * 7) }, () => pick(r, STATUSES));
const isOpen = (s: BranchStatus) => s === "pending" || s === "running";

describe("evaluateJoin properties (2000 seeded cases per mode)", () => {
  it("all: proceeds iff every branch succeeded; never proceeds while one is open", () => {
    const r = rng(1);
    for (let i = 0; i < 2000; i++) {
      const b = randBranches(r);
      const d = evaluateJoin({ mode: "all" }, b);
      expect(d.action === "proceed").toBe(b.every((s) => s === "succeeded"));
      if (b.some(isOpen)) expect(d.action === "proceed").toBe(false);
    }
  });

  it("any: proceeds iff at least one succeeded and cancels exactly the open branches", () => {
    const r = rng(2);
    for (let i = 0; i < 2000; i++) {
      const b = randBranches(r);
      const d = evaluateJoin({ mode: "any" }, b);
      expect(d.action === "proceed").toBe(b.includes("succeeded"));
      if (d.action === "proceed") expect(d.cancel).toEqual(b.flatMap((s, k) => (isOpen(s) ? [k] : [])));
    }
  });

  it("n_of_m: proceeds iff succeeded >= n; fails only when quorum is unreachable", () => {
    const r = rng(3);
    for (let i = 0; i < 2000; i++) {
      const b = randBranches(r);
      const n = 1 + Math.floor(r() * b.length);
      const ok = b.filter((s) => s === "succeeded").length;
      const open = b.filter(isOpen).length;
      const d = evaluateJoin({ mode: "n_of_m", n }, b);
      expect(d.action === "proceed").toBe(ok >= n);
      expect(d.action === "fail").toBe(ok < n && ok + open < n);
    }
  });

  it("liveness: when every branch is terminal no mode ever waits", () => {
    const r = rng(4);
    const terminal: BranchStatus[] = ["succeeded", "failed", "cancelled", "timed_out"];
    for (let i = 0; i < 2000; i++) {
      const b = Array.from({ length: 2 + Math.floor(r() * 7) }, () => pick(r, terminal));
      const cfgs: JoinConfig[] = [
        { mode: "all" }, { mode: "any" }, { mode: "n_of_m", n: 1 + Math.floor(r() * b.length) },
        { mode: "timeout", timeout_ms: 5000, on_timeout: "proceed", min_success: 1 },
      ];
      for (const c of cfgs) expect(evaluateJoin(c, b, 0).action === "wait").toBe(false);
    }
  });

  it("monotonicity: a branch turning into a success never makes a proceed worse", () => {
    const r = rng(5);
    for (let i = 0; i < 2000; i++) {
      const b = randBranches(r);
      const cfg: JoinConfig = pick(r, [{ mode: "any" }, { mode: "n_of_m", n: 1 + Math.floor(r() * b.length) }] as JoinConfig[]);
      if (evaluateJoin(cfg, b).action !== "proceed") continue;
      const k = Math.floor(r() * b.length);
      const b2 = b.map((s, j) => (j === k && isOpen(s) ? "succeeded" : s)) as BranchStatus[];
      expect(evaluateJoin(cfg, b2).action).toBe("proceed");
    }
  });

  it("timeout mode: waits before the deadline, then follows on_timeout and min_success", () => {
    const open: BranchStatus[] = ["succeeded", "running", "pending"];
    const cfg = (on: "proceed" | "fail", min = 1): JoinConfig => ({ mode: "timeout", timeout_ms: 60_000, on_timeout: on, min_success: min });
    expect(evaluateJoin(cfg("proceed"), open, 59_999).action).toBe("wait");
    expect(evaluateJoin(cfg("proceed"), open, 60_000)).toEqual({ action: "proceed", succeeded: 1, cancel: [1, 2] });
    expect(evaluateJoin(cfg("fail"), open, 60_000).action).toBe("fail");
    expect(evaluateJoin(cfg("proceed", 2), open, 60_000).action).toBe("fail");
  });

  it("empty branch list fails closed", () => {
    expect(evaluateJoin({ mode: "all" }, []).action).toBe("fail");
  });
});

describe("config validation", () => {
  it("rejects bad branch counts, quorum and timeouts", () => {
    expect(validateJoinConfig({ mode: "all" }, 1)).toHaveLength(1);
    expect(validateJoinConfig({ mode: "all" }, 9)).toHaveLength(1);
    expect(validateJoinConfig({ mode: "n_of_m", n: 4 }, 3).length).toBeGreaterThan(0);
    expect(validateJoinConfig({ mode: "n_of_m", n: 0 }, 3).length).toBeGreaterThan(0);
    expect(validateJoinConfig({ mode: "timeout", timeout_ms: 10, on_timeout: "proceed" }, 3).length).toBeGreaterThan(0);
    expect(validateJoinConfig({ mode: "n_of_m", n: 2 }, 3)).toEqual([]);
    expect(validateJoinConfig({ mode: "bogus" } as unknown as JoinConfig, 3).length).toBeGreaterThan(0);
  });
  it("rejects unbounded fan-out", () => {
    expect(validateFanOut(201, 5).length).toBeGreaterThan(0);
    expect(validateFanOut(10, 0).length).toBeGreaterThan(0);
    expect(validateFanOut(10, MAX_FANOUT_CONCURRENCY + 1).length).toBeGreaterThan(0);
    expect(validateFanOut(0, 1)).toEqual([]);
    expect(() => planFanOut({ total: 500, concurrency: 5, done: new Set(), inflight: new Set() })).toThrow();
  });
});

describe("planFanOut properties", () => {
  it("starts every item exactly once, never exceeds concurrency, always terminates", () => {
    const r = rng(7);
    for (let c = 0; c < 300; c++) {
      const total = Math.floor(r() * 60);
      const concurrency = 1 + Math.floor(r() * MAX_FANOUT_CONCURRENCY);
      const done = new Set<number>(); const inflight = new Set<number>(); const started: number[] = [];
      let guard = 0;
      for (;;) {
        const plan = planFanOut({ total, concurrency, done, inflight });
        for (const i of plan.start) { inflight.add(i); started.push(i); }
        expect(inflight.size).toBeLessThanOrEqual(concurrency);
        if (plan.finished) break;
        const live = [...inflight];
        const k = live[Math.floor(r() * live.length)];
        inflight.delete(k); done.add(k);
        if (++guard > total + 5) throw new Error("did not terminate");
      }
      expect(started).toHaveLength(total);
      expect(new Set(started).size).toBe(total);
    }
  });
});

describe("saga compensation", () => {
  const steps: SagaStep[] = [
    { nodeId: "sms", status: "completed", compensator: "sms_undo", seq: 1 },
    { nodeId: "lookup", status: "completed", seq: 2 },
    { nodeId: "dispatch", status: "completed", compensator: "dispatch_undo", seq: 3 },
    { nodeId: "handoff", status: "failed", compensator: "handoff_undo", seq: 4 },
  ];
  it("undoes completed reversible steps in reverse completion order, never the unknown-outcome one", () => {
    expect(planCompensation(steps)).toEqual({ run: ["dispatch_undo", "sms_undo"], manual: ["handoff"] });
  });
  it("is idempotent: once steps are marked compensated nothing runs again", () => {
    const after = steps.map((s) => (s.status === "completed" && s.compensator ? { ...s, status: "compensated" as const } : s));
    expect(planCompensation(after).run).toEqual([]);
  });
  it("surfaces a failed compensation for manual handling", () => {
    const s: SagaStep[] = [{ nodeId: "a", status: "compensation_failed", compensator: "a_undo", seq: 1 }];
    expect(planCompensation(s)).toEqual({ run: [], manual: ["a"] });
  });
});

describe("idempotency keys", () => {
  const run = "11111111-1111-1111-1111-111111111111";
  it("is stable and distinct per (node, purpose, branch, item)", () => {
    const keys = new Set<string>();
    for (const nodeId of ["a", "b"]) for (const purpose of ["exec", "compensate"] as const) for (const branch of [undefined, 0, 1]) for (const item of [undefined, 0, 1]) {
      keys.add(idempotencyKey({ runId: run, nodeId, purpose, branch, item }));
    }
    expect(keys.size).toBe(2 * 2 * 3 * 3);
    expect(idempotencyKey({ runId: run, nodeId: "a", purpose: "exec" })).toBe(idempotencyKey({ runId: run, nodeId: "a", purpose: "exec" }));
  });
  it("rejects ambiguous or malformed parts", () => {
    expect(() => idempotencyKey({ runId: run, nodeId: "a:b", purpose: "exec" })).toThrow();
    expect(() => idempotencyKey({ runId: "", nodeId: "a", purpose: "exec" })).toThrow();
    expect(() => idempotencyKey({ runId: run, nodeId: "a", purpose: "exec", item: -1 })).toThrow();
    expect(() => idempotencyKey({ runId: run, nodeId: "a", purpose: "exec", branch: 1.5 })).toThrow();
  });
});

describe("deterministic replay", () => {
  function genValid(r: () => number): RunEvent[] {
    const ev: RunEvent[] = [{ type: "run_started" }];
    const n = 1 + Math.floor(r() * 8);
    for (let i = 0; i < n; i++) {
      ev.push({ type: "node_started", scope: `n${i}` });
      if (r() < 0.2) { ev.push({ type: "status", to: "waiting_timer" }, { type: "status", to: "active" }); }
      ev.push({ type: r() < 0.85 ? "node_completed" : "node_failed", scope: `n${i}` });
    }
    ev.push({ type: "join_released", join: "j1" });
    ev.push({ type: "status", to: pick(r, ["completed", "failed", "cancelled"] as RunStatus[]) });
    return ev;
  }

  it("valid logs replay without violations and give identical state every time", () => {
    const r = rng(11);
    for (let i = 0; i < 500; i++) {
      const ev = genValid(r);
      expect(replay(ev)).toEqual(replay(ev));
      expect(replay(ev).events).toBe(ev.length);
    }
  });

  it("any event after a terminal status is rejected (I3)", () => {
    const r = rng(12);
    for (let i = 0; i < 300; i++) {
      const ev = [...genValid(r), { type: "node_started", scope: "late" } as RunEvent];
      expect(() => replay(ev)).toThrow(InvariantViolation);
    }
  });

  it("rejects finishing an unstarted node, double start, double join release, and illegal transitions", () => {
    expect(() => replay([{ type: "run_started" }, { type: "node_completed", scope: "x" }])).toThrow(/I1/);
    expect(() => replay([{ type: "run_started" }, { type: "node_started", scope: "x" }, { type: "node_started", scope: "x" }])).toThrow(/I1/);
    expect(() => replay([{ type: "run_started" }, { type: "join_released", join: "j" }, { type: "join_released", join: "j" }])).toThrow(/I2/);
    expect(() => replay([{ type: "run_started" }, { type: "status", to: "waiting_timer" }, { type: "status", to: "compensating" }])).toThrow(/illegal transition/);
    expect(() => replay([{ type: "node_started", scope: "x" }])).toThrow(/run_started/);
    expect(() => replay([{ type: "run_started" }, { type: "run_started" }])).toThrow();
  });

  it("compensating can only end in failed or cancelled", () => {
    const base: RunEvent[] = [{ type: "run_started" }, { type: "status", to: "compensating" }];
    expect(replay([...base, { type: "status", to: "failed" }]).status).toBe("failed");
    expect(() => replay([...base, { type: "status", to: "completed" }])).toThrow();
  });
});
