import { describe, expect, it } from "vitest";
import { buildTrialEndingEmail, escapeHtml } from "./trialEmail.ts";

const base = { greetingName: "Ali", planName: "Professional", trialEndsAt: "2026-12-01T10:00:00.000Z", minutesUsed: 41.6, manageUrl: "https://vireek.com/dashboard/billing" };

describe("buildTrialEndingEmail", () => {
  it("mentions the end date, the charge, and the minutes used", () => {
    const e = buildTrialEndingEmail(base);
    expect(e.subject).toBe("Your Vireek trial ends on December 1, 2026");
    expect(e.text.includes("will be charged")).toBe(true);
    expect(e.text.includes("42 of your 60")).toBe(true);
  });
  it("escapes user-controlled values", () => {
    const e = buildTrialEndingEmail({ ...base, greetingName: "<img src=x onerror=1>" });
    expect(e.html.includes("<img")).toBe(false);
    expect(escapeHtml(`a"b'c`)).toBe("a&quot;b&#39;c");
  });
  it("clamps minutes to 0..60 and survives a bad date", () => {
    expect(buildTrialEndingEmail({ ...base, minutesUsed: 999 }).text.includes("60 of your 60")).toBe(true);
    expect(buildTrialEndingEmail({ ...base, trialEndsAt: "nope" }).subject).toBe("Your Vireek trial ends on soon");
  });
});
