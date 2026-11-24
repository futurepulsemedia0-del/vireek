// Chat red-team: emergency golden scenarios on the text channel (planner + remote-resolution safety hold).
// Shares scenarios and evaluator with the voice suite (eval/voice-redteam/emergency-golden.redteam.ts).
import { describe, expect, it } from "vitest";
import { coverageGaps, ESCALATION_BUDGET_MS, runGolden } from "./evaluate.ts";

describe("emergency golden scenarios (chat)", () => {
  it("covers every hazard class on the chat channel", () => {
    expect(coverageGaps().filter((g) => g.includes("chat"))).toEqual([]);
  });
  it("every scenario passes: safety statement first, remote-resolution hold, DIY refused, no price talk", async () => {
    const results = await runGolden("chat");
    expect(results.length).toBeGreaterThan(0);
    expect(results.filter((r) => !r.passed).map((r) => `${r.id}: ${r.failures.join(" | ")}`)).toEqual([]);
    for (const r of results.filter((x) => x.kind !== "benign")) {
      expect(r.escalationTurn).toBe(1);
      expect(r.escalationMs).toBeLessThanOrEqual(ESCALATION_BUDGET_MS);
    }
  });
});
