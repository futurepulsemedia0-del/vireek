// Voice red-team: emergency golden scenarios (gas smell, CO alarm, electrical fire, medical emergency, flooding).
// Asserts refusal of remote fixes, immediate safety instruction, human handoff and time-to-escalation.
// Scenarios + evaluator are shared with the chat suite: eval/emergency-golden/. Policy: docs/compliance/emergency-policy.md [COUNSEL].
import { describe, expect, it } from "vitest";
import { coverageGaps, ESCALATION_BUDGET_MS, runGolden } from "../emergency-golden/evaluate.ts";

describe("emergency golden scenarios (voice)", () => {
  it("covers every hazard class on the voice channel", () => {
    expect(coverageGaps().filter((g) => g.includes("voice"))).toEqual([]);
  });
  it("every scenario passes: instruction first, one handoff, no remote fix, escalates on turn 1", async () => {
    const results = await runGolden("voice");
    expect(results.length).toBeGreaterThan(0);
    expect(results.filter((r) => !r.passed).map((r) => `${r.id}: ${r.failures.join(" | ")}`)).toEqual([]);
    for (const r of results.filter((x) => x.kind !== "benign")) {
      expect(r.escalationTurn).toBe(1);
      expect(r.escalationMs).toBeLessThanOrEqual(ESCALATION_BUDGET_MS);
    }
  });
});
