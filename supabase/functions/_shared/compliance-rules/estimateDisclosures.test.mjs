// Run: node --experimental-strip-types --no-warnings --test supabase/functions/_shared/compliance-rules/estimateDisclosures.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuoteDisclosures, unavailableDisclosures } from "./estimateDisclosures.ts";
import { ESTIMATE_DISCLOSURE_MATRIX, REQUIREMENTS, matrixCoverage } from "./estimateDisclosureMatrix.ts";

const AT = new Date("2026-11-24T12:00:00Z");
let n = 0;
const rule = (over) => ({
  id: `v${++n}`, packSlug: "us-tx", ruleKey: `r${n}`, version: 1, jurisdiction: "US-TX", kind: "required_notice", severity: "require",
  appliesTo: ["quote", "contract"], title: "Rule title", ownerExplanation: "x", params: {}, sourceRefs: [{ citation: "Cite §1", type: "statute" }],
  status: "approved", effectiveFrom: "2026-01-01", effectiveTo: null, legalReviewed: true, ...over,
});
const notice = (text, over = {}) => rule({ kind: "required_notice", params: { noticeId: "written-estimate", text }, title: "Written estimate", ...over });
const licenseRule = (over = {}) => rule({ kind: "license_display", params: { licenseLabel: "Contractor License" }, title: "License", ...over });
const rescission = (extra = {}, over = {}) => rule({ kind: "rescission", params: { days: 3, minAmountCents: 2500, saleLocations: ["customer_home"], ...extra }, title: "Cancellation", ...over });
const base = (over = {}) => ({
  rules: [], businessState: "TX", licenses: [], serviceAddress: { line1: "1 Main St", city: "Austin", state: "TX", postal_code: "78701" },
  customerPhone: null, totalCents: 500000, at: AT, ...over,
});
const codes = (r) => r.warnings.map((w) => w.code);

test("matrix: 51 jurisdictions x 3 requirements, every row is a counsel TODO and uncovered by default", () => {
  assert.equal(ESTIMATE_DISCLOSURE_MATRIX.length, 51 * REQUIREMENTS.length);
  assert.ok(ESTIMATE_DISCLOSURE_MATRIX.every((r) => r.todo.includes("TODO(counsel)") && r.tradeScope === null));
  assert.ok(matrixCoverage([], "2026-11-24").every((c) => !c.covered));
});

test("unknown job state: warns; only business-state rules can apply (engine matchOn=either); no counsel-pending noise", () => {
  const r = buildQuoteDisclosures(base({ serviceAddress: null, rules: [notice("Estimate text.")] }));
  assert.equal(r.jurisdiction, null);
  assert.ok(codes(r).includes("service_state_unknown"));
  assert.ok(!codes(r).includes("counsel_review_pending"));
  assert.equal(r.clauses.length, 1); // TX business-state notice still applies
  const none = buildQuoteDisclosures(base({ serviceAddress: null, businessState: null, rules: [notice("Estimate text.")] }));
  assert.deepEqual(none.clauses, []);
});

test("approved notice for the job state becomes a clause; other states' rules do not apply", () => {
  const r = buildQuoteDisclosures(base({ rules: [notice("Counsel-approved estimate text."), notice("Florida text.", { jurisdiction: "US-FL", packSlug: "us-fl" })] }));
  assert.equal(r.clauses.length, 1);
  assert.equal(r.clauses[0].text, "Counsel-approved estimate text.");
  assert.deepEqual(r.clauses[0].sources, ["Cite §1"]);
  const pending = r.warnings.find((w) => w.code === "counsel_review_pending");
  assert.ok(pending && pending.message.includes("cancellation notice") && pending.message.includes("license number display"));
  assert.ok(!pending.message.includes("written estimate notice"));
});

test("placeholder / empty text is never rendered", () => {
  const r = buildQuoteDisclosures(base({ rules: [notice("TODO(counsel): insert text")] }));
  assert.deepEqual(r.clauses, []);
  assert.ok(codes(r).includes("rule_text_placeholder"));
  const rescissionNoText = buildQuoteDisclosures(base({ rules: [rescission()] }));
  assert.deepEqual(rescissionNoText.clauses, []);
  assert.ok(codes(rescissionNoText).includes("rule_text_missing"));
});

test("draft / in_review versions are ignored", () => {
  const r = buildQuoteDisclosures(base({ rules: [notice("Draft text.", { status: "in_review" }), notice("Other.", { status: "draft", ruleKey: "zz" })] }));
  assert.deepEqual(r.clauses, []);
});

test("cancellation notice text comes only from counsel's noticeText; sale location assumption is surfaced", () => {
  const r = buildQuoteDisclosures(base({ rules: [rescission({ noticeText: "You may cancel within 3 days." })] }));
  assert.equal(r.clauses[0].text, "You may cancel within 3 days.");
  assert.ok(codes(r).includes("sale_location_assumed"));
  const known = buildQuoteDisclosures(base({ saleLocation: "customer_home", rules: [rescission({ noticeText: "You may cancel within 3 days." })] }));
  assert.ok(!codes(known).includes("sale_location_assumed"));
  const office = buildQuoteDisclosures(base({ saleLocation: "business_premises", rules: [rescission({ noticeText: "You may cancel within 3 days." })] }));
  assert.deepEqual(office.clauses, []);
});

test("license: line when on file, warnings when missing or expired", () => {
  const ok = buildQuoteDisclosures(base({ rules: [licenseRule()], licenses: [{ state: "TX", number: " TX-12345 " }] }));
  assert.deepEqual(ok.licenseLines, ["Contractor License TX-12345"]);
  assert.ok(!codes(ok).includes("license_missing"));
  const missing = buildQuoteDisclosures(base({ rules: [licenseRule()], licenses: [{ state: "FL", number: "F1" }] }));
  assert.deepEqual(missing.licenseLines, []);
  assert.ok(codes(missing).includes("license_missing"));
  const expired = buildQuoteDisclosures(base({ rules: [licenseRule()], licenses: [{ state: "TX", number: "TX-1", expiresOn: "2026-01-01" }] }));
  assert.deepEqual(expired.licenseLines, []);
  assert.ok(codes(expired).includes("license_expired"));
});

test("state guessed from phone is flagged as weak", () => {
  const r = buildQuoteDisclosures(base({ serviceAddress: null, customerPhone: "(512) 555-0100" }));
  assert.equal(r.jurisdiction, "US-TX");
  assert.equal(r.stateBasis, "phone");
  assert.ok(codes(r).includes("service_state_from_phone"));
});

test("business state missing is reported; unavailable helper fails visible", () => {
  assert.ok(codes(buildQuoteDisclosures(base({ businessState: null }))).includes("business_state_missing"));
  const u = unavailableDisclosures("Could not load rules.", AT);
  assert.deepEqual(u.warnings.map((w) => w.code), ["rules_unavailable"]);
});

test("duplicate notices are rendered once", () => {
  const r = buildQuoteDisclosures(base({ rules: [notice("Text A.", { ruleKey: "a" }), notice("Text A.", { ruleKey: "b" })] }));
  assert.equal(r.clauses.length, 1);
});
