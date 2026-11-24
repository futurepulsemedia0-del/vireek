import { describe, expect, it } from "vitest";
import { buildDigest, escapeHtml, parseClaimed, sortReminders, type ClaimedReminder } from "./vendorReviewDigest.ts";

const r = (over: Partial<ClaimedReminder> = {}): ClaimedReminder => ({
  reminder_id: "11111111-1111-1111-1111-111111111111",
  vendor_key: "stripe",
  vendor_name: "Stripe",
  criticality: "critical",
  kind: "overdue",
  due_on: "2026-10-01",
  last_reviewed_on: "2025-10-01",
  is_subprocessor: true,
  renotified: false,
  ...over,
});

describe("parseClaimed", () => {
  it("accepts well-formed rows and normalises optional fields", () => {
    const out = parseClaimed([{ ...r(), due_on: null, last_reviewed_on: "not-a-date", is_subprocessor: "yes" }]);
    expect(out).toHaveLength(1);
    expect(out[0].due_on).toBeNull();
    expect(out[0].last_reviewed_on).toBeNull();
    expect(out[0].is_subprocessor).toBe(false);
  });
  it("drops malformed rows instead of trusting them", () => {
    expect(parseClaimed(null)).toEqual([]);
    expect(parseClaimed("x")).toEqual([]);
    expect(parseClaimed([null, 1, {}, { ...r(), kind: "weird" }, { ...r(), criticality: "urgent" }, { ...r(), vendor_name: 5 }])).toEqual([]);
  });
});

describe("sortReminders", () => {
  it("orders overdue before due soon before never reviewed, then by criticality, due date and name", () => {
    const sorted = sortReminders([
      r({ vendor_name: "N", kind: "initial_review", due_on: null, criticality: "critical" }),
      r({ vendor_name: "S", kind: "due_soon", criticality: "low" }),
      r({ vendor_name: "B", kind: "overdue", criticality: "medium", due_on: "2026-09-01" }),
      r({ vendor_name: "A", kind: "overdue", criticality: "critical", due_on: "2026-10-01" }),
      r({ vendor_name: "C", kind: "overdue", criticality: "critical", due_on: "2026-08-01" }),
    ]).map((x) => x.vendor_name);
    expect(sorted).toEqual(["C", "A", "B", "S", "N"]);
  });
  it("does not mutate its input", () => {
    const input = [r({ vendor_name: "B", kind: "due_soon" }), r({ vendor_name: "A" })];
    sortReminders(input);
    expect(input.map((x) => x.vendor_name)).toEqual(["B", "A"]);
  });
});

describe("buildDigest", () => {
  it("returns null when there is nothing to send", () => {
    expect(buildDigest([])).toBeNull();
  });
  it("counts by kind and writes an exact subject", () => {
    const d = buildDigest([r(), r({ vendor_key: "b" }), r({ kind: "due_soon", vendor_key: "c" }), r({ kind: "initial_review", vendor_key: "d", due_on: null })])!;
    expect(d.counts).toEqual({ overdue: 2, due_soon: 1, initial_review: 1 });
    expect(d.subject).toBe("Vendor reviews: 2 overdue, 1 due soon, 1 never reviewed");
    expect(d.listed).toBe(4);
    expect(d.total).toBe(4);
  });
  it("omits zero groups from the subject", () => {
    expect(buildDigest([r({ kind: "due_soon" })])!.subject).toBe("Vendor reviews: 1 due soon");
  });
  it("caps the listed lines but keeps the true totals and says how many are hidden", () => {
    const many = Array.from({ length: 7 }, (_, i) => r({ vendor_key: `v${i}`, vendor_name: `Vendor ${i}` }));
    const d = buildDigest(many, { maxLines: 3 })!;
    expect(d.listed).toBe(3);
    expect(d.total).toBe(7);
    expect(d.counts.overdue).toBe(7);
    expect(d.text).toContain("…and 4 more");
    expect(d.text).toContain("vendor_review_status_v");
  });
  it("escapes HTML in vendor names", () => {
    const d = buildDigest([r({ vendor_name: "<script>alert(1)</script> & Co" })])!;
    expect(d.html).not.toContain("<script>");
    expect(d.html).toContain("&lt;script&gt;");
    expect(d.html).toContain("&amp; Co");
  });
  it("flags repeat reminders and published sub-processors, and tells the reader how to record a review", () => {
    const d = buildDigest([r({ renotified: true })])!;
    expect(d.text).toContain("repeat reminder");
    expect(d.text).toContain("published sub-processor");
    expect(d.text).toContain("evidence link");
  });
  it("never states a compliance claim", () => {
    const d = buildDigest([r()])!;
    expect(`${d.subject} ${d.text}`).not.toMatch(/compliant|certified|SOC ?2 (ready|compliant)/i);
  });
});

describe("escapeHtml", () => {
  it("escapes the five significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
