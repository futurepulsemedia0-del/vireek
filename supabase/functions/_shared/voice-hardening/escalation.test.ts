import { describe, expect, it } from "vitest";
import { findEscalationTarget, isValidE164 } from "./escalation.ts";

describe("emergency escalation target", () => {
  const rules = [
    { trigger: "after_hours" as const, action: "transfer" as const, target: "+15550000001" },
    { trigger: "emergency" as const, action: "sms" as const, target: "+15550000002" },
    { trigger: "emergency" as const, action: "transfer" as const, target: "555-0003" },
    { trigger: "emergency" as const, action: "transfer" as const, target: "+15550000004" },
  ];
  it("skips non-transfer actions and invalid numbers, picks the first valid emergency transfer", () => {
    expect(findEscalationTarget(rules, "emergency")).toBe("+15550000004");
    expect(findEscalationTarget(rules, "after_hours")).toBe("+15550000001");
  });
  it("null when nothing valid is configured (caller is sent to the main forwarding number, never a guessed one)", () => {
    expect(findEscalationTarget(null, "emergency")).toBeNull();
    expect(findEscalationTarget([], "emergency")).toBeNull();
    expect(findEscalationTarget(rules, "human_request")).toBeNull();
    expect(findEscalationTarget("garbage" as never, "emergency")).toBeNull();
  });
  it("E.164 validation rejects injection-shaped and malformed values", () => {
    for (const bad of ["", "+0123456789", "5550000001", "+1 555 000 0001", "+15550000001;rm", "+1555", null, undefined]) expect(isValidE164(bad as never)).toBe(false);
    expect(isValidE164("+442071838750")).toBe(true);
  });
});
