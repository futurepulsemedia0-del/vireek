import { describe, expect, it } from "vitest";
import { evaluate, selectEffective, validateRuleParams, validateVersionDraft } from "./engine.ts";
import { canadaBlockFromCatalog } from "./canadaGate.ts";
import {
  CA_GATE_RULE_KEY, CA_REQUIRED_RULE_KEYS, canadaPackStatus, dateKeyOf, impliedConsentMatch, parseImpliedWindows, windowEndKey,
} from "./canada.ts";
import { CA_AREA_CODES, countryFromPhone, jurisdictionCountry, provinceFromAddress, resolveCounterpartyCountry, stateFromPhone, stateOfJurisdiction } from "./jurisdiction.ts";
import { CA_MARKERS, CA_SEED_EFFECTIVE_FROM, CA_SEED_RULES } from "./caSeedRules.ts";
import type { RuleVersion } from "./types.ts";

let n = 0;
const fromSeed = (key: string, over: Partial<RuleVersion> = {}): RuleVersion => {
  const s = CA_SEED_RULES.find((r) => r.ruleKey === key)!;
  n += 1;
  return { id: `ca${n}`, version: 1, status: "approved", effectiveFrom: CA_SEED_EFFECTIVE_FROM, effectiveTo: null, ...s, ...over } as RuleVersion;
};
const allApproved = (surface: "call" | "sms" | "email") => CA_REQUIRED_RULE_KEYS[surface].map((k) => fromSeed(k));
// Tue 2026-12-01 15:00 UTC = 10:00 Toronto
const AT = new Date("2026-12-01T15:00:00Z");
const ctx = (surface: "call" | "sms" | "email", over = {}) => ({
  surface, at: AT, businessTimezone: "America/Toronto", businessState: "TX", counterpartyCountry: "CA" as const, counterpartyProvince: "ON", purpose: "marketing" as const, ...over,
});

describe("Canada jurisdiction helpers", () => {
  it("never confuses Canada (CA) with California (US-CA)", () => {
    expect(jurisdictionCountry("CA")).toBe("CA");
    expect(jurisdictionCountry("CA-ON")).toBe("CA");
    expect(jurisdictionCountry("US-CA")).toBe("US");
    expect(stateOfJurisdiction("CA")).toBeNull();
    expect(stateOfJurisdiction("CA-ON")).toBeNull();
    expect(stateOfJurisdiction("US-CA")).toBe("CA");
  });
  it("detects Canadian numbers by area code and never overlaps a US-resolved area code", () => {
    expect(countryFromPhone("+1 (416) 555-0100")).toBe("CA");
    expect(countryFromPhone("+14155552671")).toBeNull();
    expect(countryFromPhone("+442079460958")).toBeNull();
    for (const code of CA_AREA_CODES) {
      expect(code).toMatch(/^[2-9]\d\d$/);
      expect(stateFromPhone(`+1${code}5550100`), code).toBeNull();
    }
  });
  it("detects Canadian addresses only with a postal code or the word Canada", () => {
    expect(provinceFromAddress("100 King St W, Toronto, ON M5X 1A9")).toEqual({ country: "CA", province: "ON" });
    expect(provinceFromAddress("Montreal QC H2Y 1C6")).toEqual({ country: "CA", province: "QC" });
    expect(provinceFromAddress("12 Main St, Springfield, CA 90210")).toBeNull();
    expect(provinceFromAddress("5 Elm St, Austin, TX 78701")).toBeNull();
    expect(resolveCounterpartyCountry({ address: "1 Rue X, Quebec, QC G1A 1A1", phone: "+14155552671" }).country).toBe("CA");
  });
});

describe("Canada gate in evaluate()", () => {
  it("blocks Canadian outbound contact on every gated surface when no pack exists", () => {
    for (const surface of ["call", "sms", "email"] as const) {
      const r = evaluate(ctx(surface), []);
      expect(r.outcome, surface).toBe("block");
      expect(r.findings.some((f) => f.ruleKey === CA_GATE_RULE_KEY && f.severity === "block")).toBe(true);
      expect(r.canadaPack?.enabled).toBe(false);
      expect(r.canadaPack?.missing).toEqual([...CA_REQUIRED_RULE_KEYS[surface]]);
    }
  });
  it("a partial pack does not open the gate; only in_review versions never count", () => {
    const partial = CA_REQUIRED_RULE_KEYS.sms.slice(0, 2).map((k) => fromSeed(k));
    expect(evaluate(ctx("sms"), partial).canadaPack?.enabled).toBe(false);
    const inReview = CA_REQUIRED_RULE_KEYS.sms.map((k) => fromSeed(k, { status: "in_review" }));
    expect(evaluate(ctx("sms"), inReview).canadaPack?.enabled).toBe(false);
  });
  it("opens only when every required rule is approved and effective; real rules then apply", () => {
    const pack = allApproved("sms");
    const r = evaluate(ctx("sms"), pack);
    expect(r.canadaPack).toEqual({ enabled: true, missing: [] });
    expect(r.findings.some((f) => f.ruleKey === CA_GATE_RULE_KEY)).toBe(false);
    // no consent on file and no relationship -> the consent rule blocks
    expect(r.findings.find((f) => f.ruleKey === "ca-sms-consent")?.status).toBe("fail");
    expect(r.outcome).toBe("block");
  });
  it("a future-dated or expired version does not enable the pack", () => {
    const future = allApproved("email").map((v) => ({ ...v, effectiveFrom: "2027-01-01" }));
    expect(evaluate(ctx("email"), future).canadaPack?.enabled).toBe(false);
    const expired = allApproved("email").map((v) => ({ ...v, effectiveTo: "2026-06-01" }));
    expect(evaluate(ctx("email"), expired).canadaPack?.enabled).toBe(false);
  });
  it("does not touch US or unknown recipients, inbound contact, or non-outbound surfaces", () => {
    expect(evaluate({ ...ctx("sms"), counterpartyCountry: null }, []).canadaPack).toBeUndefined();
    expect(evaluate({ ...ctx("sms"), counterpartyCountry: "US" }, []).canadaPack).toBeUndefined();
    expect(evaluate({ ...ctx("sms"), outbound: false }, []).canadaPack).toBeUndefined();
    expect(evaluate({ surface: "quote", at: AT, businessTimezone: "America/Toronto", counterpartyCountry: "CA" }, []).canadaPack).toBeUndefined();
  });
  it("the gate also blocks service/emergency purposes (no override)", () => {
    for (const purpose of ["service", "emergency"] as const) {
      expect(evaluate(ctx("call", { purpose }), []).outcome).toBe("block");
    }
  });
  it("Canadian rules never match US recipients; province rules need the matching province", () => {
    const on = fromSeed("ca-sms-consent", { jurisdiction: "CA-ON" });
    const us = evaluate({ ...ctx("sms"), counterpartyCountry: null, counterpartyState: "TX" }, [on]);
    expect(us.findings.length).toBe(0);
    expect(evaluate(ctx("sms", { counterpartyProvince: "QC" }), [on]).findings.some((f) => f.ruleKey === "ca-sms-consent")).toBe(false);
    expect(evaluate(ctx("sms", { counterpartyProvince: "ON" }), [on]).findings.some((f) => f.ruleKey === "ca-sms-consent")).toBe(true);
  });
  it("California recipients are not treated as Canadian", () => {
    const r = evaluate({ surface: "sms", at: AT, businessTimezone: "America/Chicago", counterpartyState: "CA", purpose: "marketing" }, []);
    expect(r.canadaPack).toBeUndefined();
  });
});

describe("implied consent windows", () => {
  const pack = allApproved("sms");
  const consentFinding = (over: Record<string, unknown>) =>
    evaluate(ctx("sms", over), pack).findings.find((f) => f.ruleKey === "ca-sms-consent")!;
  it("passes inside the transaction window, fails outside, and fails with no facts", () => {
    expect(consentFinding({ relationship: { transactionAt: "2025-01-15" } }).status).toBe("pass");
    expect(consentFinding({ relationship: { transactionAt: "2024-11-30" } }).status).toBe("fail");
    expect(consentFinding({}).status).toBe("fail");
  });
  it("uses the inquiry window independently and ignores future or malformed dates", () => {
    expect(consentFinding({ relationship: { inquiryAt: "2026-08-01" } }).status).toBe("pass");
    expect(consentFinding({ relationship: { inquiryAt: "2026-05-01" } }).status).toBe("fail");
    expect(consentFinding({ relationship: { transactionAt: "2027-01-01" } }).status).toBe("fail");
    expect(consentFinding({ relationship: { transactionAt: "not-a-date" } }).status).toBe("fail");
  });
  it("express consent passes; revoked consent beats any window", () => {
    expect(consentFinding({ consent: { marketing_sms: "granted" } }).status).toBe("pass");
    expect(consentFinding({ consent: { marketing_sms: "revoked" }, relationship: { transactionAt: "2026-11-01" } }).status).toBe("fail");
  });
  it("window helpers: month-end clamping, validation, ordering", () => {
    expect(windowEndKey("2026-08-31", 6)).toBe("2027-02-28");
    expect(windowEndKey("2024-02-29", 12)).toBe("2025-02-28");
    expect(dateKeyOf("2026-02-30")).toBeNull();
    expect(parseImpliedWindows([{ basis: "inquiry", months: 6 }, { basis: "inquiry", months: 2 }])).toBeNull();
    expect(parseImpliedWindows([{ basis: "transaction", months: 0 }])).toBeNull();
    expect(parseImpliedWindows([])).toBeNull();
    expect(impliedConsentMatch([{ basis: "inquiry", months: 6 }], { inquiryAt: "2026-06-01" }, "2026-12-01")?.until).toBe("2026-12-01");
    expect(impliedConsentMatch([{ basis: "inquiry", months: 6 }], { inquiryAt: "2026-06-01" }, "2026-12-02")).toBeNull();
  });
});

describe("call rules", () => {
  it("holds marketing calls outside the recipient's window and allows inside it", () => {
    const pack = allApproved("call");
    const inside = evaluate(ctx("call", { counterpartyTimezone: "America/Toronto", consent: { marketing_call: "granted" } }), pack);
    expect(inside.findings.find((f) => f.ruleKey === "ca-call-hours")?.status).toBe("pass");
    const night = evaluate(ctx("call", { at: new Date("2026-12-02T03:00:00Z"), consent: { marketing_call: "granted" } }), pack); // 22:00 Toronto
    expect(night.findings.find((f) => f.ruleKey === "ca-call-hours")?.status).not.toBe("pass");
  });
  it("AI-voice marketing calls need express ai_voice consent (no implied window)", () => {
    const pack = [...allApproved("call"), fromSeed("ca-call-ai-voice-consent")];
    const r = evaluate(ctx("call", { aiVoice: true, relationship: { transactionAt: "2026-11-01" }, consent: { marketing_call: "granted" } }), pack);
    expect(r.findings.find((f) => f.ruleKey === "ca-call-ai-voice-consent")?.status).toBe("fail");
  });
});

describe("Canada seed data", () => {
  it("every rule is marked [COUNSEL][VERIFY] in title, explanation, text and sources", () => {
    for (const r of CA_SEED_RULES) {
      for (const m of CA_MARKERS) {
        expect(r.title, r.ruleKey).toContain(m);
        expect(r.ownerExplanation, r.ruleKey).toContain(m);
        expect(JSON.stringify(r.params.text ?? ""), r.ruleKey).toSatisfy((t: string) => t === '""' || t.includes(m));
        for (const s of r.sourceRefs) expect(s.note ?? "", r.ruleKey).toContain(m);
      }
    }
  });
  it("all seed rules validate with the same validator staff use, and use the CA jurisdiction", () => {
    for (const r of CA_SEED_RULES) {
      expect(r.jurisdiction).toBe("CA");
      expect(validateRuleParams(r.kind, r.params), r.ruleKey).toEqual([]);
      expect(validateVersionDraft({ ...r, effectiveFrom: CA_SEED_EFFECTIVE_FROM, effectiveTo: null }), r.ruleKey).toEqual([]);
    }
  });
  it("rule keys are unique and cover every required key for every gated surface", () => {
    const keys = CA_SEED_RULES.map((r) => r.ruleKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [surface, req] of Object.entries(CA_REQUIRED_RULE_KEYS)) {
      for (const k of req) {
        const rule = CA_SEED_RULES.find((r) => r.ruleKey === k);
        expect(rule, k).toBeDefined();
        expect(rule!.appliesTo, k).toContain(surface);
      }
    }
  });
  it("the seed alone never enables the pack (nothing is approved)", () => {
    const seeded = CA_SEED_RULES.map((r) => fromSeed(r.ruleKey, { status: "in_review" }));
    for (const surface of ["call", "sms", "email"] as const) expect(canadaPackStatus(selectEffective(seeded, "2026-12-01"), surface).enabled).toBe(false);
  });
  it("validators reject unsupported Canadian kinds, bad provinces and bad windows", () => {
    const base = { ...CA_SEED_RULES.find((r) => r.ruleKey === "ca-sms-consent")!, effectiveFrom: CA_SEED_EFFECTIVE_FROM, effectiveTo: null };
    expect(validateVersionDraft({ ...base, jurisdiction: "CA-XX" }).join()).toMatch(/CA-<province/);
    expect(validateVersionDraft({ ...base, kind: "rescission", params: { days: 3 } }).join()).toMatch(/not supported for Canadian/);
    expect(validateRuleParams("consent_required", { consentType: "marketing_sms", impliedWindows: [{ basis: "x", months: 3 }] })[0]).toMatch(/impliedWindows/);
    expect(validateVersionDraft({ ...base, jurisdiction: "US-CA" }).join()).not.toMatch(/jurisdiction/);
  });
});

describe("canadaBlockFromCatalog", () => {
  it("blocks until the catalog holds the full approved pack", () => {
    expect(canadaBlockFromCatalog([], "email", "2026-12-01")).toMatchObject({ blocked: true, reason: "pack_not_enabled" });
    expect(canadaBlockFromCatalog(allApproved("email"), "email", "2026-12-01")).toEqual({ blocked: false });
    expect(canadaBlockFromCatalog(allApproved("email"), "sms", "2026-12-01")).toMatchObject({ blocked: true });
  });
});
