import { describe, expect, it } from "vitest";
import {
  evaluate, legalHolidayKeys, nthBusinessDayAfter, selectEffective, timelineOf, validateRuleParams, validateVersionDraft,
} from "./engine.ts";
import { resolveCounterpartyState, stateFromAddress, stateFromPhone } from "./jurisdiction.ts";
import { SEED_EFFECTIVE_FROM, SEED_RULES, type SeedRule } from "./seedRules.ts";
import type { RuleVersion } from "./types.ts";

let n = 0;
/** Approved, effective version built from a seed rule (or overrides). */
function ver(seed: Partial<SeedRule> & Pick<SeedRule, "kind" | "jurisdiction" | "params">, over: Partial<RuleVersion> = {}): RuleVersion {
  n += 1;
  return {
    id: `v${n}`, packSlug: "t", ruleKey: `r${n}`, version: 1, severity: "block", appliesTo: ["call"],
    title: "Test rule", ownerExplanation: "Plain-language explanation of the rule.", sourceRefs: [{ citation: "Test § 1", type: "statute" }],
    status: "approved", effectiveFrom: "2020-01-01", effectiveTo: null, ...seed, ...over,
  } as RuleVersion;
}
const fromSeed = (key: string, jurisdiction: string): RuleVersion => {
  const s = SEED_RULES.find((r) => r.ruleKey === key && r.jurisdiction === jurisdiction);
  if (!s) throw new Error(`seed ${key}/${jurisdiction} missing`);
  return ver(s, { ruleKey: s.ruleKey, packSlug: s.packSlug, effectiveFrom: SEED_EFFECTIVE_FROM });
};
// Tue 2026-11-03 18:00 UTC = 12:00 CT / 10:00 PT / 13:00 ET
const NOON_CT = new Date("2026-11-03T18:00:00Z");

describe("selectEffective", () => {
  const base = { kind: "required_notice" as const, jurisdiction: "US", params: { noticeId: "abc", text: "x" } };
  it("ignores unapproved, future and expired versions", () => {
    const vs = [
      ver(base, { status: "in_review" }),
      ver(base, { effectiveFrom: "2027-01-01" }),
      ver(base, { effectiveTo: "2026-01-01" }),
      ver(base),
    ];
    expect(selectEffective(vs, "2026-11-03").map((v) => v.id)).toEqual([vs[3].id]);
  });
  it("treats effectiveTo as exclusive and picks the newest version per rule", () => {
    const v1 = ver(base, { ruleKey: "k", version: 1, effectiveTo: "2026-11-03" });
    const v2 = ver(base, { ruleKey: "k", version: 2, effectiveFrom: "2026-11-03" });
    expect(selectEffective([v1, v2], "2026-11-02").map((v) => v.version)).toEqual([1]);
    expect(selectEffective([v1, v2], "2026-11-03").map((v) => v.version)).toEqual([2]);
  });
  it("labels the timeline", () => {
    expect(timelineOf({ status: "approved", effectiveFrom: "2027-01-01", effectiveTo: null }, "2026-11-03")).toBe("upcoming");
    expect(timelineOf({ status: "approved", effectiveFrom: "2020-01-01", effectiveTo: "2026-01-01" }, "2026-11-03")).toBe("expired");
    expect(timelineOf({ status: "retired", effectiveFrom: "2020-01-01", effectiveTo: null }, "2026-11-03")).toBe("expired");
    expect(timelineOf({ status: "draft", effectiveFrom: "2020-01-01", effectiveTo: null }, "2026-11-03")).toBe("inactive");
  });
});

describe("recording consent", () => {
  const ca = fromSeed("recording-consent", "US-CA");
  const call = { surface: "call" as const, at: NOON_CT, businessTimezone: "America/Chicago" };
  it("requires the consent script for a Californian caller with no consent on file", () => {
    const r = evaluate({ ...call, businessState: "TX", counterpartyState: "CA", counterpartyStateBasis: "address" }, [ca]);
    expect(r.outcome).toBe("allow_with_actions");
    expect(r.recording?.permitted).toBe("after_consent");
    expect(r.recording?.script).toMatch(/may be recorded/);
  });
  it("passes when consent is granted and fails when it was revoked", () => {
    const base = { ...call, counterpartyState: "CA" };
    expect(evaluate({ ...base, consent: { call_recording: "granted" } }, [ca]).recording?.permitted).toBe("yes");
    expect(evaluate({ ...base, consent: { call_recording: "revoked" } }, [ca]).recording?.permitted).toBe("no");
  });
  it("applies the business's own state too (either party's state)", () => {
    expect(evaluate({ ...call, businessState: "CA", counterpartyState: "TX" }, [ca]).findings).toHaveLength(1);
  });
  it("assumes the strictest rule once when the caller's state is unknown", () => {
    const fl = fromSeed("recording-consent", "US-FL");
    const r = evaluate({ ...call, businessState: "TX", counterpartyState: null }, [ca, fl]);
    expect(r.findings).toHaveLength(1);
    expect(r.recording?.permitted).toBe("after_consent");
    expect(r.assumptions.join(" ")).toMatch(/strictest/);
  });
  it("does not apply to other states or non-call surfaces", () => {
    expect(evaluate({ ...call, businessState: "TX", counterpartyState: "TX" }, [ca]).findings).toHaveLength(0);
    expect(evaluate({ surface: "sms", at: NOON_CT, counterpartyState: "CA" }, [ca]).findings).toHaveLength(0);
  });
});

describe("quiet hours", () => {
  const fed = fromSeed("telemarketing-hours", "US");
  const tx = fromSeed("telemarketing-hours", "US-TX");
  const fl = fromSeed("telemarketing-hours", "US-FL");
  it("allows a marketing call inside the window", () => {
    expect(evaluate({ surface: "call", purpose: "marketing", at: NOON_CT, counterpartyTimezone: "America/Chicago" }, [fed]).outcome).toBe("allow");
  });
  it("blocks at 21:30 local and gives the next open time", () => {
    const at = new Date("2026-11-04T03:30:00Z"); // 21:30 CST on Nov 3
    const r = evaluate({ surface: "sms", purpose: "marketing", at, counterpartyTimezone: "America/Chicago" }, [fed]);
    expect(r.outcome).toBe("block");
    expect(r.nextAllowedAt).toBe("2026-11-04T14:00:00.000Z"); // 08:00 CST
  });
  it("applies the stricter Florida 8 p.m. close", () => {
    const at = new Date("2026-11-04T01:30:00Z"); // 20:30 EST Nov 3
    const ctx = { surface: "call" as const, purpose: "marketing" as const, at, counterpartyTimezone: "America/New_York", counterpartyState: "FL" };
    expect(evaluate(ctx, [fed]).outcome).toBe("allow");
    expect(evaluate(ctx, [fed, fl]).outcome).toBe("block");
  });
  it("uses the Texas Sunday noon opening", () => {
    const sunMorning = new Date("2026-11-08T16:00:00Z"); // Sun 10:00 CST
    const r = evaluate({ surface: "call", purpose: "marketing", at: sunMorning, counterpartyTimezone: "America/Chicago", counterpartyState: "TX" }, [fed, tx]);
    expect(r.outcome).toBe("block");
    expect(r.nextAllowedAt).toBe("2026-11-08T18:00:00.000Z"); // 12:00 CST
  });
  it("never blocks service or emergency messages", () => {
    const at = new Date("2026-11-04T05:00:00Z");
    for (const purpose of ["service", "emergency"] as const) {
      expect(evaluate({ surface: "sms", purpose, at, counterpartyTimezone: "America/Chicago" }, [fed]).outcome).toBe("allow");
    }
  });
  it("is DST-safe across the fall-back weekend", () => {
    const at = new Date("2026-11-01T14:30:00Z"); // Sun Nov 1: CST already (08:30)
    expect(evaluate({ surface: "call", purpose: "marketing", at, counterpartyTimezone: "America/Chicago" }, [fed]).outcome).toBe("allow");
  });
  it("notes the assumption when the recipient timezone is unknown", () => {
    expect(evaluate({ surface: "sms", purpose: "marketing", at: NOON_CT }, [fed]).assumptions.join(" ")).toMatch(/timezone unknown/);
  });
});

describe("consent required", () => {
  const sms = fromSeed("marketing-sms-consent", "US");
  const ai = fromSeed("ai-voice-marketing-consent", "US");
  it("blocks marketing SMS without consent, passes with it, ignores service texts", () => {
    expect(evaluate({ surface: "sms", purpose: "marketing", at: NOON_CT }, [sms]).outcome).toBe("block");
    expect(evaluate({ surface: "sms", purpose: "marketing", at: NOON_CT, consent: { marketing_sms: "granted" } }, [sms]).outcome).toBe("allow");
    expect(evaluate({ surface: "sms", purpose: "service", at: NOON_CT }, [sms]).findings).toHaveLength(0);
  });
  it("applies the AI-voice rule only to AI calls", () => {
    expect(evaluate({ surface: "call", purpose: "marketing", at: NOON_CT, aiVoice: false }, [ai]).findings).toHaveLength(0);
    const r = evaluate({ surface: "call", purpose: "marketing", at: NOON_CT, aiVoice: true, consent: { ai_voice: "revoked" } }, [ai]);
    expect(r.outcome).toBe("block");
    expect(r.findings[0].message).toMatch(/revoked/);
  });
});

describe("license display", () => {
  const ca = fromSeed("license-display", "US-CA");
  const ctx = { surface: "quote" as const, at: NOON_CT, counterpartyState: "CA", businessState: "TX" };
  it("fails when no license is on file for the job's state", () => {
    const r = evaluate({ ...ctx, licenses: [{ state: "TX", number: "123" }] }, [ca]);
    expect(r.findings[0].status).toBe("fail");
    expect(r.actions[0].type).toBe("add_license_to_profile");
  });
  it("asks to display it, then passes once shown; flags an expired license", () => {
    const lic = [{ state: "CA", number: "B-998877", expiresOn: "2027-01-01" }];
    expect(evaluate({ ...ctx, licenses: lic }, [ca]).actions[0].text).toMatch(/B-998877/);
    expect(evaluate({ ...ctx, licenses: lic, document: { licenseNumberShown: true } }, [ca]).findings[0].status).toBe("pass");
    expect(evaluate({ ...ctx, licenses: [{ ...lic[0], expiresOn: "2026-01-01" }] }, [ca]).findings[0].message).toMatch(/expired/);
  });
});

describe("rescission", () => {
  const fed = fromSeed("right-of-rescission", "US");
  const base = { surface: "contract" as const, at: new Date("2026-11-04T15:00:00Z"), businessTimezone: "America/Chicago", counterpartyState: "TX" };
  it("computes the third business day and demands the notice", () => {
    const r = evaluate({ ...base, document: { saleLocation: "customer_home", totalCents: 850000 } }, [fed]);
    expect(r.rescissionDeadline).toBe("2026-11-07"); // signed Wed Nov 4 → Thu, Fri, Sat
    expect(r.outcome).toBe("allow_with_actions");
    expect(r.actions[0].type).toBe("add_notice");
  });
  it("skips Sundays and legal holidays", () => {
    expect(nthBusinessDayAfter("2026-11-06", 3)).toBe("2026-11-10"); // Sat, (Sun), Mon, Tue
    expect(nthBusinessDayAfter("2026-11-09", 3)).toBe("2026-11-13"); // Tue, (Veterans Day), Thu... Fri
    expect(legalHolidayKeys(2026).has("2026-11-26")).toBe(true);
  });
  it("is satisfied when the notice is present", () => {
    const r = evaluate({ ...base, document: { saleLocation: "customer_home", totalCents: 850000, cancellationNoticePresent: true } }, [fed]);
    expect(r.outcome).toBe("allow");
    expect(r.findings[0].status).toBe("info");
  });
  it("does not apply to sales at the business or under the threshold", () => {
    expect(evaluate({ ...base, document: { saleLocation: "business_premises", totalCents: 850000 } }, [fed]).findings).toHaveLength(0);
    expect(evaluate({ ...base, document: { saleLocation: "customer_home", totalCents: 1000 } }, [fed]).findings).toHaveLength(0);
  });
  it("honours a signed emergency waiver", () => {
    const r = evaluate({ ...base, document: { saleLocation: "customer_home", totalCents: 850000, isEmergencyRepair: true, emergencyWaiverSigned: true } }, [fed]);
    expect(r.rescissionDeadline).toBeNull();
    expect(r.findings[0].message).toMatch(/waiver/);
  });
  it("assumes applicability when facts are missing, and says so", () => {
    const r = evaluate({ ...base }, [fed]);
    expect(r.rescissionDeadline).not.toBeNull();
    expect(r.assumptions.join(" ")).toMatch(/Sale location not provided/);
  });
});

describe("price cap", () => {
  const ca = fromSeed("emergency-price-cap", "US-CA");
  const ctx = { surface: "quote" as const, at: NOON_CT, counterpartyState: "CA" };
  it("only applies during a declared emergency", () => {
    expect(evaluate({ ...ctx, document: { totalCents: 999999, baselinePriceCents: 100000 } }, [ca]).findings).toHaveLength(0);
  });
  it("blocks a price above 10% over baseline and suggests the maximum", () => {
    const r = evaluate({ ...ctx, document: { emergencyDeclared: true, totalCents: 120000, baselinePriceCents: 100000 } }, [ca]);
    expect(r.outcome).toBe("block");
    expect(r.actions[0].text).toMatch(/\$1,100\.00/);
  });
  it("passes at exactly the cap and asks for a baseline when missing", () => {
    expect(evaluate({ ...ctx, document: { emergencyDeclared: true, totalCents: 110000, baselinePriceCents: 100000 } }, [ca]).outcome).toBe("allow");
    expect(evaluate({ ...ctx, document: { emergencyDeclared: true, totalCents: 110000 } }, [ca]).actions[0].type).toBe("provide_baseline");
  });
});

describe("notices and disclosure", () => {
  it("requires a missing notice and passes when present", () => {
    const sms = fromSeed("sms-opt-out-notice", "US");
    expect(evaluate({ surface: "sms", at: NOON_CT }, [sms]).outcome).toBe("allow_with_actions");
    expect(evaluate({ surface: "sms", at: NOON_CT, document: { noticesPresent: ["sms-opt-out"] } }, [sms]).outcome).toBe("allow");
  });
  it("requires AI disclosure only for AI interactions", () => {
    const co = fromSeed("ai-disclosure", "US-CO");
    expect(evaluate({ surface: "call", at: NOON_CT, counterpartyState: "CO" }, [co]).findings).toHaveLength(0);
    expect(evaluate({ surface: "call", at: NOON_CT, counterpartyState: "CO", aiVoice: true }, [co]).actions[0].type).toBe("disclose");
    expect(evaluate({ surface: "call", at: NOON_CT, counterpartyState: "CO", aiVoice: true, disclosureGiven: true }, [co]).outcome).toBe("allow");
  });
});

describe("engine safety", () => {
  it("never applies unapproved rules", () => {
    const sms = { ...fromSeed("marketing-sms-consent", "US"), status: "in_review" as const };
    expect(evaluate({ surface: "sms", purpose: "marketing", at: NOON_CT }, [sms]).findings).toHaveLength(0);
  });
  it("skips (and reports) rules with invalid params instead of crashing", () => {
    const bad = ver({ kind: "quiet_hours", jurisdiction: "US", params: { windows: "nope" } }, { appliesTo: ["call"] });
    const r = evaluate({ surface: "call", purpose: "marketing", at: NOON_CT }, [bad]);
    expect(r.skipped[0].reason).toBe("invalid_params");
    expect(r.assumptions.join(" ")).toMatch(/invalid parameters/);
  });
  it("is deterministic and orders blockers first", () => {
    const vs = [fromSeed("sms-opt-out-notice", "US"), fromSeed("marketing-sms-consent", "US")];
    const ctx = { surface: "sms" as const, purpose: "marketing" as const, at: NOON_CT };
    const a = evaluate(ctx, vs);
    expect(a).toEqual(evaluate(ctx, vs));
    expect(a.findings[0].severity).toBe("block");
  });
});

describe("validation", () => {
  it("every starter rule passes version validation and has a source", () => {
    for (const s of SEED_RULES) {
      const errs = validateVersionDraft({ ...s, effectiveFrom: SEED_EFFECTIVE_FROM, effectiveTo: null });
      expect({ rule: `${s.jurisdiction}/${s.ruleKey}`, errs }).toEqual({ rule: `${s.jurisdiction}/${s.ruleKey}`, errs: [] });
    }
  });
  it("starter rule keys are unique per jurisdiction", () => {
    const keys = SEED_RULES.map((s) => `${s.jurisdiction}|${s.ruleKey}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("rejects malformed parameters", () => {
    expect(validateRuleParams("quiet_hours", { windows: [{ days: [0], start: "21:00", end: "08:00" }] })).not.toEqual([]);
    expect(validateRuleParams("rescission", { days: 0, minAmountCents: 1, saleLocations: [] })).not.toEqual([]);
    expect(validateRuleParams("price_cap", { condition: "emergency_declared", maxIncreasePercent: 150 })).not.toEqual([]);
    expect(validateRuleParams("recording_consent", { mode: "all_party" })).not.toEqual([]);
  });
  it("rejects invalid drafts (no sources, bad dates, wrong surface, federal license rule)", () => {
    const d = { jurisdiction: "US", kind: "license_display", severity: "require", appliesTo: ["call"], title: "t", ownerExplanation: "short", params: { licenseLabel: "x" }, sourceRefs: [], effectiveFrom: "2026-02-30", effectiveTo: null };
    const errs = validateVersionDraft(d).join("|");
    expect(errs).toMatch(/source reference/);
    expect(errs).toMatch(/effective-from/);
    expect(errs).toMatch(/cannot apply to call/);
    expect(errs).toMatch(/state jurisdiction/);
    expect(errs).toMatch(/at least 20/);
  });
});

describe("jurisdiction helpers", () => {
  it("reads the state from an address", () => {
    expect(stateFromAddress("12 Oak St, Austin, TX 78701")).toBe("TX");
    expect(stateFromAddress("12 Oak St, Austin, TX")).toBe("TX");
    expect(stateFromAddress("no state here")).toBeNull();
  });
  it("maps area codes and ranks address above phone", () => {
    expect(stateFromPhone("+1 (650) 910-6703")).toBe("CA");
    expect(stateFromPhone("12345")).toBeNull();
    expect(resolveCounterpartyState({ address: "1 Main St, Miami, FL 33101", phone: "650-910-6703" })).toEqual({ state: "FL", basis: "address" });
    expect(resolveCounterpartyState({ phone: "650-910-6703" })).toEqual({ state: "CA", basis: "phone" });
    expect(resolveCounterpartyState({})).toEqual({ state: null, basis: "unknown" });
  });
});
