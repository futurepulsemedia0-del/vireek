import { describe, expect, it } from "vitest";
import { renderConsentScript, resolveRecordingProfile } from "./recordingProfiles";

describe("resolveRecordingProfile", () => {
  it("Germany is opt_in_strict and gates recording", () => {
    const p = resolveRecordingProfile({ country: "de" });
    expect(p.mode).toBe("opt_in_strict");
    expect(p.gateBeforeRecording).toBe(true);
  });
  it("other EU is opt_in", () => expect(resolveRecordingProfile({ country: "FR" }).mode).toBe("opt_in"));
  it("UK is notice and not gated", () => {
    const p = resolveRecordingProfile({ country: "GB" });
    expect(p.mode).toBe("notice");
    expect(p.gateBeforeRecording).toBe(false);
  });
  it("Quebec is opt_in, rest of Canada notice", () => {
    expect(resolveRecordingProfile({ country: "CA", subdivision: "qc" }).mode).toBe("opt_in");
    expect(resolveRecordingProfile({ country: "CA", subdivision: "ON" }).mode).toBe("notice");
  });
  it("US all-party state opt_in, others notice", () => {
    expect(resolveRecordingProfile({ country: "US", subdivision: "CA" }).mode).toBe("opt_in");
    expect(resolveRecordingProfile({ country: "US", subdivision: "TX" }).mode).toBe("notice");
  });
  it("unknown or missing country never falls back to off", () => {
    expect(resolveRecordingProfile({ country: null }).mode).toBe("opt_in");
    expect(resolveRecordingProfile({ country: "ZZ" }).gateBeforeRecording).toBe(true);
  });
  it("every profile is draft until counsel approves", () => {
    for (const c of ["DE", "FR", "GB", "CA", "AU", "US", "XX"]) expect(resolveRecordingProfile({ country: c }).legalReview).toBe("draft");
  });
});

describe("renderConsentScript", () => {
  it("substitutes purpose and keeps German wording", () => {
    const s = renderConsentScript("de", "Qualitätssicherung");
    expect(s.ask).toContain("Qualitätssicherung");
    expect(s.ask).not.toContain("[Purpose]");
  });
  it("falls back to a default purpose", () => expect(renderConsentScript("en", "  ").ask).toContain("quality and service"));
});
