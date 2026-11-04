import { describe, expect, it } from "vitest";
import { assertPublicSafe, buildPublicFields, findPii, isHype, monthText, RedactionError, roundValue, speedBand, timeBucket } from "./redact.ts";
import { generateToken, isValidToken, attributionRef, reporterHash } from "./token.ts";
import { DEFAULT_SELECTION, type PrivateFacts, type Selection } from "./types.ts";

const settings = { timezone: "America/New_York", businessHoursStart: 8, businessHoursEnd: 18 };
const facts: PrivateFacts = {
  trigger: "emergency_handled",
  occurredAt: "2026-11-03T07:14:00.000Z", // 02:14 in New York (Tue)
  valueCents: 420_000,
  valueBasis: "invoiced",
  pii: ["Sarah Mitchell", "+1 (212) 555-0147", "2125550147", "42 Elm Street"],
};
const all: Selection = { ...DEFAULT_SELECTION, showValue: true, showTimeBucket: true, showMonth: true, showBusinessName: true, serviceLabel: "Emergency repair" };

describe("roundValue — never inflates", () => {
  it("rounds collected/invoiced values DOWN", () => {
    expect(roundValue(420_099, "invoiced")?.text).toBe("Over $4,000");
    expect(roundValue(99_999, "collected")?.text).toBe("Over $900");
    expect(roundValue(1_234_500, "collected")?.text).toBe("Over $12,000");
  });
  it("labels estimates as ranges starting at the floor", () => {
    const r = roundValue(420_099, "estimate");
    expect(r?.text).toBe("Estimated $4,000–$4,500");
    expect(r?.isEstimate).toBe(true);
  });
  it("shows nothing for missing, zero, negative or tiny values", () => {
    for (const v of [undefined, null, 0, -5, Number.NaN, 5_000]) expect(roundValue(v as number, "collected")).toBeNull();
  });
});

describe("time handling", () => {
  it("buckets by the OWNER timezone and never returns a clock time", () => {
    expect(timeBucket(facts.occurredAt, "America/New_York", 8, 18)).toBe("overnight");
    expect(timeBucket("2026-11-03T15:00:00Z", "America/New_York", 8, 18)).toBe("business hours");
    expect(timeBucket("2026-11-07T15:00:00Z", "America/New_York", 8, 18)).toBe("weekend");
    expect(timeBucket("2026-11-03T23:30:00Z", "America/New_York", 8, 18)).toBe("evening");
    expect(timeBucket("2026-11-03T11:00:00Z", "America/New_York", 8, 18)).toBe("early morning");
  });
  it("month text only", () => expect(monthText(facts.occurredAt, "America/New_York")).toBe("November 2026"));
  it("speed is a ceiling band, never exact", () => {
    expect(speedBand(23_400)).toBe("under 30 seconds");
    expect(speedBand(900_000)).toBeNull();
  });
});

describe("findPii", () => {
  it("catches email, phone, url, street, exact time, ip", () => {
    for (const t of ["mail me a@b.co", "call 212-555-0147", "see https://x.io/a", "at 42 Elm Street", "at 2:14 AM", "around 2am", "from 10.0.0.1"])
      expect(findPii(t).length > 0).toBe(true);
  });
  it("catches private terms and their individual words (case-insensitive)", () => {
    expect(findPii("thanks sarah!", facts.pii).length > 0).toBe(true);
    expect(findPii("the MITCHELL family", facts.pii).length > 0).toBe(true);
    expect(findPii("number 2125550147 call", facts.pii).length > 0).toBe(true);
  });
  it("passes clean text", () => expect(findPii("A call after hours became a booked job.", facts.pii)).toHaveLength(0));
});

describe("buildPublicFields — privacy by default", () => {
  it("default selection shows no value, no time, no business name", () => {
    const p = buildPublicFields({ facts, selection: DEFAULT_SELECTION, settings, businessName: "Acme HVAC" });
    expect(p.valueText).toBeNull();
    expect(p.timeBucketText).toBeNull();
    expect(p.monthText).toBeNull();
    expect(p.businessName).toBeNull();
    expect(p.disclaimer).toBeNull();
  });
  it("with everything selected: rounded value, bucket, month; zero PII anywhere in the serialised payload", () => {
    const p = buildPublicFields({ facts, selection: all, settings, businessName: "Acme HVAC" });
    const json = JSON.stringify(p);
    expect(p.valueText).toBe("Over $4,000");
    expect(p.timeBucketText).toBe("Overnight");
    expect(p.monthText).toBe("November 2026");
    for (const leak of ["Sarah", "Mitchell", "555", "Elm", "2:14", "4,200", "4200", "420000", "07:14", "T07"]) expect(json).not.toContain(leak);
  });
  it("estimates are labelled and carry the disclaimer", () => {
    const p = buildPublicFields({ facts: { ...facts, valueBasis: "estimate" }, selection: all, settings, businessName: null });
    expect(p.valueIsEstimate).toBe(true);
    expect(p.valueText).toContain("Estimated");
    expect(p.disclaimer).toContain("estimate");
  });
  it("owner-typed captions/labels containing PII are rejected, not silently kept", () => {
    for (const caption of ["Great job Sarah", "Call 212-555-0147", "At 42 Elm Street", "Booked at 2:14 AM", "email sarah@x.com"])
      expect(() => buildPublicFields({ facts, selection: { ...all, caption }, settings, businessName: null })).toThrow(RedactionError);
    expect(() => buildPublicFields({ facts, selection: { ...all, serviceLabel: "Sarah's boiler" }, settings, businessName: null })).toThrow(RedactionError);
  });
  it("hype captions are rejected", () => {
    expect(isHype("This is insane!!")).toBe(true);
    expect(() => buildPublicFields({ facts, selection: { ...all, caption: "Game-changing result" }, settings, businessName: null })).toThrow();
  });
  it("control / bidi characters are stripped from owner text", () => {
    const p = buildPublicFields({ facts, selection: { ...all, caption: "Good\u202E night \u200bwork" }, settings, businessName: null });
    expect(p.caption).toBe("Good night work");
  });
  it("assertPublicSafe fails if the raw value sneaks in", () => {
    const p = buildPublicFields({ facts, selection: all, settings, businessName: null });
    expect(() => assertPublicSafe({ ...p, detail: "It was $4,200 exactly" }, facts)).toThrow(RedactionError);
  });
  it("business name is allowed even if it shares a word with a private term, but contact info in it is not", () => {
    const f = { ...facts, pii: [...facts.pii, "Acme"] };
    expect(buildPublicFields({ facts: f, selection: all, settings, businessName: "Acme HVAC" }).businessName).toBe("Acme HVAC");
    expect(() => buildPublicFields({ facts, selection: all, settings, businessName: "Acme 212-555-0147" })).toThrow(RedactionError);
  });
});

describe("tokens", () => {
  it("are 43-char base64url, unique, validated strictly", () => {
    const a = generateToken(), b = generateToken();
    expect(isValidToken(a)).toBe(true);
    expect(a === b).toBe(false);
    for (const bad of ["", "short", a + "x", a.slice(0, 42) + "!", null, 5, "../../etc/passwd"]) expect(isValidToken(bad)).toBe(false);
  });
  it("attribution ref and reporter hash are deterministic, salted and not the token", async () => {
    const r1 = await attributionRef("id-1", "salt"), r2 = await attributionRef("id-1", "salt"), r3 = await attributionRef("id-1", "other");
    expect(r1).toBe(r2); expect(r1 === r3).toBe(false); expect(r1).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(await reporterHash("1.2.3.4", "ua", "s")).toBe(await reporterHash("1.2.3.4", "ua", "s"));
  });
});
