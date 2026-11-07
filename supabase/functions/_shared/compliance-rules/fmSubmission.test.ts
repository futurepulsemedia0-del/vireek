import { describe, expect, it } from "vitest";
import { evaluate, selectEffective, validateRuleParams, validateVersionDraft } from "./engine.ts";
import { fmAddDays, fmDayDiff, fmDayKey, FM_KINDS } from "./fmSubmission.ts";
import type { FmFacts, FmKind } from "./fmSubmission.ts";
import { FM_SEED_RULES, FM_SEED_EFFECTIVE_FROM } from "./fmSeedRules.ts";
import type { RuleVersion, Severity } from "./types.ts";

let n = 0;
function ver(kind: FmKind, params: Record<string, unknown>, severity: Severity = "block", over: Partial<RuleVersion> = {}): RuleVersion {
  n += 1;
  return {
    id: `fm${n}`, packSlug: "t", ruleKey: `fm-rule-${n}`, version: 1, jurisdiction: "US", kind, severity, appliesTo: ["fm_submission"],
    title: "Portal rule", ownerExplanation: "Plain-language explanation of the portal rule.", params,
    sourceRefs: [{ citation: "Guide p. 1", type: "other" }], status: "approved", effectiveFrom: "2020-01-01", effectiveTo: null, ...over,
  };
}
const run = (versions: RuleVersion[], fm: FmFacts, at = "2026-11-05T15:00:00Z") =>
  evaluate({ surface: "fm_submission", at: new Date(at), fm }, versions);
const inv = (over: Partial<FmFacts> = {}): FmFacts => ({ documentType: "invoice", timezone: "America/New_York", ...over });

describe("fm_submission surface — engine wiring", () => {
  it("never applies unapproved versions and adds no state assumptions", () => {
    const r = run([ver("fm_single_invoice", {}, "block", { status: "in_review" })], inv({ existingInvoiceCount: 3 }));
    expect(r.findings).toHaveLength(0);
    expect(r.outcome).toBe("allow");
    expect(r.assumptions).toEqual([]);
  });
  it("is deterministic", () => {
    const vs = [ver("fm_nte_cap", {}), ver("fm_single_invoice", {})];
    const f = inv({ nteCents: 10_000, totalCents: 12_000, existingInvoiceCount: 1 });
    expect(JSON.stringify(run(vs, f))).toBe(JSON.stringify(run(vs, f)));
  });
  it("skips rules when no facts are supplied", () => {
    const r = evaluate({ surface: "fm_submission", at: new Date("2026-11-05T15:00:00Z") }, [ver("fm_single_invoice", {})]);
    expect(r.findings).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
  });
  it("only one-click fix is removing a line on the DRAFT (nothing can submit)", () => {
    const vs = FM_SEED_RULES.map((s) => ver(s.kind as FmKind, s.params, s.severity));
    const r = run(vs, inv({
      nteCents: 1_000, totalCents: 5_000, existingInvoiceCount: 2, billingParty: "portal", hasSubcontractor: true,
      workConfirmedAt: "2026-01-01T12:00:00Z", lineItems: [{ category: "sales_tax", amountCents: 100 }, { category: "new_business_fee", amountCents: 100 }],
    }));
    const kinds = new Set(r.actions.filter((a) => a.fix?.oneClick).map((a) => a.fix!.kind));
    expect([...kinds]).toEqual(["remove_line_item"]);
    expect(r.outcome).toBe("block");
  });
});

describe("fm_nte_cap", () => {
  const v = [ver("fm_nte_cap", {})];
  it("passes at exactly the NTE", () => expect(run(v, inv({ nteCents: 50_000, totalCents: 50_000 })).findings[0].status).toBe("pass"));
  it("fails over the NTE with reduce + create_proposal fixes", () => {
    const r = run(v, inv({ nteCents: 50_000, totalCents: 62_550 }));
    expect(r.outcome).toBe("block");
    expect(r.findings[0].message).toContain("$125.50");
    expect(r.actions.map((a) => a.fix?.kind)).toEqual(["reduce_total_to_cap", "create_proposal"]);
    expect(r.actions[0].fix?.params).toEqual({ capCents: 50_000, overCents: 12_550 });
  });
  it("suggests waiting when a proposal is pending, and no new proposal when approved", () => {
    expect(run(v, inv({ nteCents: 100, totalCents: 200, proposalStatus: "pending" })).actions.map((a) => a.fix?.kind)).toEqual(["reduce_total_to_cap", "wait_for_approval"]);
    expect(run(v, inv({ nteCents: 100, totalCents: 200, proposalStatus: "approved" })).actions.map((a) => a.fix?.kind)).toEqual(["reduce_total_to_cap"]);
  });
  it("asks for the NTE when unknown instead of guessing", () => {
    const r = run(v, inv({ totalCents: 100 }));
    expect(r.findings[0].status).toBe("action");
    expect(r.actions[0].fix?.kind).toBe("enter_nte");
  });
  it("does not apply to proposals unless the rule says so", () => expect(run(v, { documentType: "proposal", nteCents: 1, totalCents: 9 }).findings).toHaveLength(0));
});

describe("fm_proposal_before_parts", () => {
  const v = [ver("fm_proposal_before_parts", {}, "warn")];
  const po = (o: Partial<FmFacts>): FmFacts => ({ documentType: "parts_order", nteCents: 100_000, partsCents: 40_000, totalCents: 130_000, ...o });
  it("fails when projected cost exceeds NTE with no approved proposal", () => {
    const r = run(v, po({}));
    expect(r.findings[0].status).toBe("fail");
    expect(r.actions[0].fix?.kind).toBe("create_proposal");
    expect(r.outcome).toBe("allow"); // severity warn is advisory
  });
  it("passes when the proposal is approved or the total stays within NTE", () => {
    expect(run(v, po({ proposalStatus: "approved" })).findings[0].status).toBe("pass");
    expect(run(v, po({ totalCents: 90_000 })).findings[0].status).toBe("pass");
  });
  it("holds while the proposal is pending", () => expect(run(v, po({ proposalStatus: "pending" })).actions[0].fix?.kind).toBe("wait_for_approval"));
  it("is not applied to invoices and ignores orders without parts", () => {
    expect(run(v, inv({ nteCents: 1, totalCents: 9, partsCents: 9 })).findings).toHaveLength(0);
    expect(run(v, po({ partsCents: 0 })).findings).toHaveLength(0);
  });
});

describe("fm_invoice_deadline / fm_ineligibility_window", () => {
  const dl = [ver("fm_invoice_deadline", { days: 10, warnDays: 3 }, "warn")];
  it("fails after the window, warns inside it, passes before", () => {
    const f = inv({ workConfirmedAt: "2026-10-20T16:00:00Z" }); // window ends 2026-10-30
    expect(run(dl, f, "2026-11-05T15:00:00Z").findings[0].status).toBe("fail");
    expect(run(dl, f, "2026-10-28T15:00:00Z").findings[0]).toMatchObject({ status: "action", message: expect.stringContaining("in 2 days") });
    expect(run(dl, f, "2026-10-22T15:00:00Z").findings[0].status).toBe("pass");
    expect(run(dl, f, "2026-10-30T15:00:00Z").findings[0].message).toContain("today");
  });
  it("counts days in the account timezone (23:00 ET on Oct 30 is still Oct 30)", () => {
    expect(fmDayKey("2026-10-31T03:00:00Z", "America/New_York")).toBe("2026-10-30");
    const f = inv({ workConfirmedAt: "2026-10-31T03:00:00Z" });
    expect(run(dl, f, "2026-11-09T04:59:00Z").findings[0].message).toContain("in 1 day"); // 23:59 ET Nov 8, across the DST change
    expect(run(dl, f, "2026-11-10T05:00:00Z").findings[0].status).toBe("fail");
  });
  it("asks for the confirmed date when missing", () => {
    const r = run(dl, inv({}));
    expect(r.findings[0].status).toBe("action");
    expect(r.actions[0].fix?.kind).toBe("enter_confirmed_date");
  });
  it("90-day ineligibility fails once passed and warns before", () => {
    const v = [ver("fm_ineligibility_window", { days: 90, warnDays: 14 }, "require")];
    const f = inv({ workConfirmedAt: "2026-08-01T12:00:00Z" }); // ends 2026-10-30
    expect(run(v, f).findings[0].status).toBe("fail");
    expect(run(v, f, "2026-10-20T12:00:00Z").findings[0].status).toBe("action");
    expect(run(v, f, "2026-09-01T12:00:00Z").findings[0].status).toBe("pass");
  });
  it("ineligibility window can count from the received date", () => {
    const v = [ver("fm_ineligibility_window", { days: 90, warnDays: 14, anchor: "work_received" }, "require")];
    const f = inv({ workReceivedAt: "2026-08-01T12:00:00Z", workConfirmedAt: "2026-10-01T12:00:00Z" });
    expect(run(v, f).findings[0].status).toBe("fail"); // received 96 days ago, confirmed only 35 days ago
    expect(run([ver("fm_ineligibility_window", { days: 90, warnDays: 14 }, "require")], f).findings[0].status).toBe("pass");
    expect(run(v, inv({ workConfirmedAt: "2026-10-01T12:00:00Z" })).findings[0].message).toContain("received date is missing");
  });
  it("date helpers", () => {
    expect(fmAddDays("2026-02-25", 5)).toBe("2026-03-02");
    expect(fmDayDiff("2026-10-30", "2026-11-09")).toBe(10);
    expect(fmDayKey("not a date", "UTC")).toBeNull();
  });
});

describe("fm_prohibited_line_item", () => {
  const tax = [ver("fm_prohibited_line_item", { categories: ["sales_tax"], appliesWhenBilling: "portal" })];
  const lines = [{ category: "labor" as const, amountCents: 5_000 }, { category: "sales_tax" as const, label: "Tax", amountCents: 412 }];
  it("fails on a tax line when billing the portal, with a one-click remove of that exact line", () => {
    const r = run(tax, inv({ billingParty: "portal", lineItems: lines }));
    expect(r.outcome).toBe("block");
    expect(r.actions[0].fix).toMatchObject({ kind: "remove_line_item", oneClick: true, params: { index: 1 } });
  });
  it("does not apply when billing the customer directly", () => {
    const r = run(tax, inv({ billingParty: "customer", lineItems: lines }));
    expect(r.findings).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
  });
  it("asks to confirm the billing party instead of guessing", () => {
    const r = run(tax, inv({ lineItems: lines }));
    expect(r.findings[0].status).toBe("action");
    expect(r.actions[0].fix?.kind).toBe("confirm_billing_party");
  });
  it("ignores zero-amount lines and applies to proposals when listed", () => {
    const nbf = [ver("fm_prohibited_line_item", { categories: ["new_business_fee"], documentTypes: ["invoice", "proposal"] })];
    expect(run(nbf, { documentType: "proposal", lineItems: [{ category: "new_business_fee", amountCents: 0 }] }).findings[0].status).toBe("pass");
    expect(run(nbf, { documentType: "proposal", lineItems: [{ category: "new_business_fee", amountCents: 2_500 }] }).findings[0].status).toBe("fail");
  });
});

describe("fm_single_invoice / fm_required_attachment", () => {
  it("one invoice per work order", () => {
    const v = [ver("fm_single_invoice", {})];
    expect(run(v, inv({ existingInvoiceCount: 0 })).findings[0].status).toBe("pass");
    expect(run(v, inv({ existingInvoiceCount: 1 })).actions[0].fix?.kind).toBe("merge_into_existing_invoice");
  });
  const att = [ver("fm_required_attachment", { attachment: "subcontractor_invoice", label: "Subcontractor invoice", condition: "has_subcontractor" }, "require")];
  it("only applies when a subcontractor is involved", () => {
    expect(run(att, inv({})).findings).toHaveLength(0);
    const r = run(att, inv({ hasSubcontractor: true }));
    expect(r.outcome).toBe("allow_with_actions");
    expect(r.actions[0].fix).toMatchObject({ kind: "attach_file", params: { attachment: "subcontractor_invoice" } });
    expect(run(att, inv({ hasSubcontractor: true, attachments: ["subcontractor_invoice"] })).findings[0].status).toBe("pass");
  });
});

describe("validation", () => {
  it("rejects bad params per kind", () => {
    expect(validateRuleParams("fm_invoice_deadline", { days: 0 })).not.toEqual([]);
    expect(validateRuleParams("fm_invoice_deadline", { days: 10, warnDays: 99 })).not.toEqual([]);
    expect(validateRuleParams("fm_ineligibility_window", { days: 90, anchor: "x" })).not.toEqual([]);
    expect(validateRuleParams("fm_prohibited_line_item", { categories: [] })).not.toEqual([]);
    expect(validateRuleParams("fm_prohibited_line_item", { categories: ["nope"] })).not.toEqual([]);
    expect(validateRuleParams("fm_required_attachment", { attachment: "Bad Name", label: "x" })).not.toEqual([]);
    expect(validateRuleParams("fm_nte_cap", { documentTypes: ["bogus"] })).not.toEqual([]);
    expect(validateRuleParams("fm_nte_cap", {})).toEqual([]);
  });
  it("an invalid-param version is skipped, never applied", () => {
    const r = run([ver("fm_invoice_deadline", { days: -1 })], inv({ workConfirmedAt: "2026-01-01T00:00:00Z" }));
    expect(r.findings).toHaveLength(0);
    expect(r.skipped[0].reason).toBe("invalid_params");
  });
  it("legacy kinds cannot target the portal surface; fm kinds cannot target other surfaces", () => {
    const base = { jurisdiction: "US", severity: "warn", title: "t", ownerExplanation: "x".repeat(30), sourceRefs: [{ citation: "c" }], effectiveFrom: "2026-11-04", effectiveTo: null };
    expect(validateVersionDraft({ ...base, kind: "required_notice", appliesTo: ["fm_submission"], params: { noticeId: "abc", text: "t" } })).not.toEqual([]);
    expect(validateVersionDraft({ ...base, kind: "fm_nte_cap", appliesTo: ["quote"], params: {} })).not.toEqual([]);
    expect(validateVersionDraft({ ...base, kind: "fm_nte_cap", appliesTo: ["fm_submission"], params: {} })).toEqual([]);
  });
});

describe("starter pack", () => {
  it("covers every fm kind, validates, and is fully cited", () => {
    expect(new Set(FM_SEED_RULES.map((r) => r.kind))).toEqual(new Set(FM_KINDS));
    expect(new Set(FM_SEED_RULES.map((r) => r.ruleKey)).size).toBe(FM_SEED_RULES.length);
    for (const r of FM_SEED_RULES) {
      expect(r.ruleKey).toMatch(/^[a-z0-9][a-z0-9-]{1,80}$/);
      expect(validateVersionDraft({ ...r, effectiveFrom: FM_SEED_EFFECTIVE_FROM, effectiveTo: null })).toEqual([]);
      expect(r.sourceRefs.every((s) => s.citation && s.retrievedOn === "2026-11-04" && s.url)).toBe(true);
    }
  });
  it("is inert until approved", () => {
    const vs = FM_SEED_RULES.map((r, i) => ({ ...ver(r.kind as FmKind, r.params, r.severity), ruleKey: r.ruleKey, id: `s${i}`, status: "in_review" as const }));
    expect(selectEffective(vs, "2026-11-05")).toHaveLength(0);
  });
});
