// Synthetic AI-caller eval (runs in CI with the rest of `npm test`).
// Pass criteria per scenario: correct range/price wording, NO invented price/time, correct availability,
// hold created exactly when allowed, summary sent — plus the global invariants in harness.ts (I1..I7).
import { describe, expect, it } from "vitest";
import { ADVERSARIAL, ALL_SCENARIOS, NORMAL } from "./scenarios.ts";
import { BUDGET, evaluate, runOnce } from "./harness.ts";

describe("synthetic AI-caller scenarios", () => {
  it("has at least 30 normal scenarios across 8+ trades and adversarial ones", () => {
    expect(NORMAL.length).toBeGreaterThanOrEqual(30);
    expect(new Set(NORMAL.map((s) => s.trade)).size).toBeGreaterThanOrEqual(8);
    expect(ADVERSARIAL.length).toBeGreaterThanOrEqual(20);
    expect(new Set(ALL_SCENARIOS.map((s) => s.id)).size).toBe(ALL_SCENARIOS.length);
  });

  for (const s of ALL_SCENARIOS) {
    it(`${s.kind}: ${s.id}`, async () => {
      expect(await evaluate(s)).toEqual([]);
    });
  }

  it("full happy path stays inside the simulated latency budget", async () => {
    const o = await runOnce(NORMAL[0]);
    expect(o.totalMs).toBeLessThanOrEqual(BUDGET.totalMs);
    for (const r of o.replies) expect(r.ms).toBeLessThanOrEqual(BUDGET.perToolMs);
  });

  it("a hold is created exactly once per call even if the agent retries the tool", async () => {
    const o = await runOnce({ ...NORMAL[0], steps: [...NORMAL[0].steps.slice(0, 2), { tool: "hold", window_id: "W1" }, { tool: "hold", window_id: "W2" }] });
    expect(o.rec.commits).toHaveLength(1);
  });
});
