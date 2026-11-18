import { describe, it, expect } from "vitest";
import { evaluateMinuteCap, alertLevelFor, overageChargeCents, usageAlertKey } from "./usageCaps";

describe("evaluateMinuteCap", () => {
  it("ok below 80%", () => expect(evaluateMinuteCap({ usedMinutes: 100, includedMinutes: 200, isEmergency: false }).level).toBe("ok"));
  it("warns at 80% and at 100%", () => {
    expect(evaluateMinuteCap({ usedMinutes: 160, includedMinutes: 200, isEmergency: false }).level).toBe("warn_80");
    const d = evaluateMinuteCap({ usedMinutes: 200, includedMinutes: 200, isEmergency: false });
    expect(d.level).toBe("over_100");
    expect(d.allowCall).toBe(true); // overage is billed, calls are not dropped
  });
  it("counts whole overage minutes", () => expect(evaluateMinuteCap({ usedMinutes: 210.2, includedMinutes: 200, isEmergency: false }).overageMinutes).toBe(11));
  it("hard ceiling restricts non-emergency only", () => {
    const n = evaluateMinuteCap({ usedMinutes: 700, includedMinutes: 200, hardCeilingMultiple: 3, isEmergency: false });
    expect(n.level).toBe("hard_stop"); expect(n.allowCall).toBe(false);
    const e = evaluateMinuteCap({ usedMinutes: 700, includedMinutes: 200, hardCeilingMultiple: 3, isEmergency: true });
    expect(e.allowCall).toBe(true); expect(e.reason).toBe("emergency_never_restricted");
  });
  it("is safe on bad input and when no allowance is configured", () => {
    expect(evaluateMinuteCap({ usedMinutes: NaN, includedMinutes: 0, isEmergency: false }).allowCall).toBe(true);
    expect(evaluateMinuteCap({ usedMinutes: -5, includedMinutes: 200, isEmergency: false }).level).toBe("ok");
  });
  it("maps levels to one alert per month", () => {
    expect(alertLevelFor(evaluateMinuteCap({ usedMinutes: 170, includedMinutes: 200, isEmergency: false }))).toBe("warn_80");
    expect(alertLevelFor(evaluateMinuteCap({ usedMinutes: 20, includedMinutes: 200, isEmergency: false }))).toBeNull();
    expect(usageAlertKey("a", "warn_80", "2026-11-01")).not.toBe(usageAlertKey("a", "warn_80", "2026-12-01"));
  });
  it("overage charge", () => {
    expect(overageChargeCents(250, 200, 25)).toBe(1250);
    expect(overageChargeCents(100, 200, 25)).toBe(0);
    expect(overageChargeCents(250, 200, 0)).toBe(0);
  });
});
