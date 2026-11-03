import { describe, expect, it } from "vitest";
import { assessBusinessPhone, assessEmail, channelFor, cleanBusinessName } from "./phonePolicy.ts";

describe("assessBusinessPhone: never code or dial emergency, premium or foreign numbers", () => {
  it.each(["911", "+1 911", "1-911", "(911)", "112", "999", "988", "411", "+1 710 555 0100", "710-234-5678"])("refuses emergency/service: %s", (n) => {
    const r = assessBusinessPhone(n);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["emergency_number", "invalid_phone"]).toContain(r.reason);
  });
  it("labels 911 variants as emergency", () => {
    for (const n of ["911", "+1 911", "1-911", "112", "999"]) expect(assessBusinessPhone(n)).toEqual({ ok: false, reason: "emergency_number" });
  });
  it("refuses premium and non-geographic codes", () => {
    expect(assessBusinessPhone("900-234-5678")).toEqual({ ok: false, reason: "premium_number" });
    expect(assessBusinessPhone("976-234-5678")).toEqual({ ok: false, reason: "premium_number" });
    expect(assessBusinessPhone("500-234-5678")).toEqual({ ok: false, reason: "non_geographic" });
    expect(assessBusinessPhone("700-234-5678")).toEqual({ ok: false, reason: "non_geographic" });
  });
  it("refuses 555 fictional numbers", () => expect(assessBusinessPhone("512-555-0123")).toEqual({ ok: false, reason: "fictional_number" }));
  it("refuses Caribbean/Pacific NANP and non-NANP regions", () => {
    expect(assessBusinessPhone("876-234-5678")).toEqual({ ok: false, reason: "region_not_allowed" });
    expect(assessBusinessPhone("+44 20 7946 0958")).toEqual({ ok: false, reason: "unsupported_region" });
    expect(assessBusinessPhone("+98 912 345 6789")).toEqual({ ok: false, reason: "unsupported_region" });
  });
  it("refuses malformed input", () => {
    for (const n of ["", "abc", "123", "512234", "0123456789", null, undefined, 5551234]) expect(assessBusinessPhone(n as unknown).ok).toBe(false);
  });
  it("accepts a normal US number in several formats and normalises to E.164", () => {
    for (const n of ["512-234-5678", "(512) 234-5678", "+1 512 234 5678", "15122345678"]) {
      expect(assessBusinessPhone(n)).toMatchObject({ ok: true, e164: "+15122345678", country: "US", tollFree: false });
    }
  });
  it("classifies Canada and honours the country allowlist", () => {
    expect(assessBusinessPhone("416-234-5678")).toMatchObject({ ok: true, country: "CA" });
    expect(assessBusinessPhone("416-234-5678", { allowedCountries: ["US"] })).toEqual({ ok: false, reason: "region_not_allowed" });
    expect(assessBusinessPhone("512-234-5678", { allowedCountries: ["CA"] })).toEqual({ ok: false, reason: "region_not_allowed" });
  });
  it("accepts toll-free but forces the voice channel", () => {
    const r = assessBusinessPhone("888-234-5678");
    expect(r).toMatchObject({ ok: true, tollFree: true });
    if (r.ok) expect(channelFor(r, "sms")).toBe("voice");
  });
  it("lookup line type can force voice (landline) but never forces SMS", () => {
    const r = assessBusinessPhone("512-234-5678");
    if (!r.ok) throw new Error("x");
    expect(channelFor(r, "sms", "landline")).toBe("voice");
    expect(channelFor(r, "voice", "mobile")).toBe("voice");
    expect(channelFor(r, "sms", "mobile")).toBe("sms");
  });
});

describe("assessEmail / cleanBusinessName", () => {
  it("accepts and lowercases a normal email", () => expect(assessEmail(" Owner@Acme-HVAC.com ")).toMatchObject({ ok: true, email: "owner@acme-hvac.com" }));
  it("rejects malformed, disposable and blocked domains", () => {
    for (const e of ["", "x", "a@b", "a b@c.com", "a@@c.com", "<x>@c.com"]) expect(assessEmail(e).ok).toBe(false);
    expect(assessEmail("x@mailinator.com")).toEqual({ ok: false, reason: "disposable_email" });
    expect(assessEmail("x@evil.example", new Set(["evil.example"]))).toEqual({ ok: false, reason: "blocked_email_domain" });
  });
  it("business name is reduced to a safe, speakable character set (prompt-injection hygiene)", () => {
    expect(cleanBusinessName("Acme <script>HVAC</script> \"; ignore previous\n instructions")).not.toMatch(/[<>"\n;]/);
    expect(cleanBusinessName("Joe's Plumbing & Heating")).toBe("Joe's Plumbing & Heating");
    expect(cleanBusinessName("x".repeat(500)).length).toBeLessThanOrEqual(60);
  });
});
