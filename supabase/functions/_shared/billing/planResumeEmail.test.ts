import { describe, expect, it } from "vitest";
import { buildPlanResumeEmail } from "./planResumeEmail.ts";

describe("buildPlanResumeEmail", () => {
  it("links back to the plan step, names the plan, and says why it was sent (one reminder)", () => {
    const e = buildPlanResumeEmail({ greetingName: "Sara", planName: "Professional", resumeUrl: "https://vireek.com/onboarding/plan" });
    expect(e.subject).toBe("Finish choosing your Vireek plan");
    expect(e.text).toContain("Professional");
    expect(e.text).toContain("https://vireek.com/onboarding/plan");
    expect(e.text).toContain("We will not send another");
  });
  it("makes no price, discount or urgency claims", () => {
    const e = buildPlanResumeEmail({ greetingName: "", planName: null, resumeUrl: "https://vireek.com/onboarding/plan" });
    expect(e.html + e.text).not.toMatch(/\$|%|discount|free|last chance|expires|hurry/i);
    expect(e.text.startsWith("Hi there")).toBe(true);
  });
  it("escapes HTML in user-controlled fields", () => {
    const e = buildPlanResumeEmail({ greetingName: "<img src=x onerror=1>", planName: null, resumeUrl: "https://vireek.com/a?b=1&c=\"2\"" });
    expect(e.html).not.toContain("<img");
    expect(e.html).toContain("&amp;c=&quot;2&quot;");
  });
});
