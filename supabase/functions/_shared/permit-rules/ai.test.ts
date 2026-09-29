import { describe, expect, it } from "vitest";
import { extractJson, mergeLikelihood, normalizeAi } from "./ai.ts";
import type { RequirementItem } from "./types.ts";

const existing: RequirementItem[] = [{
  key: "permit.water_heater", category: "permit", severity: "blocker", title: "Water heater replacement: permit typically required",
  detail: "x", authority: null, reference: null, confidence: "medium", source: "rule",
}];

describe("normalizeAi", () => {
  it("caps severity/confidence and labels items as ai", () => {
    const r = normalizeAi({
      summary: "Verify with the AHJ.", permit_likelihood: "likely_required",
      extra_items: [{ category: "permit", title: "HOA approval", detail: "Check HOA.", confidence: "high", severity: "blocker" }],
    }, existing)!;
    expect(r.extra_items[0]).toMatchObject({ severity: "warning", confidence: "low", source: "ai" });
  });
  it("drops duplicates of rule items even when reworded", () => {
    const r = normalizeAi({
      summary: "s", permit_likelihood: "unknown",
      extra_items: [{ category: "permit", title: "Permit typically required for water heater replacement", detail: "dup" }],
    }, existing)!;
    expect(r.extra_items).toHaveLength(0);
  });
  it("rejects garbage and clamps list sizes", () => {
    expect(normalizeAi(null, existing)).toBeNull();
    expect(normalizeAi({ summary: "" }, existing)).toBeNull();
    const many = Array.from({ length: 20 }, (_, i) => ({ category: "safety", title: `Unique hazard number ${i} alpha${i}`, detail: "d" }));
    expect(normalizeAi({ summary: "s", extra_items: many, verify_questions: Array(9).fill("q?") }, existing)!.extra_items.length).toBeLessThanOrEqual(6);
  });
  it("coerces unknown enums safely", () => {
    const r = normalizeAi({ summary: "s", permit_likelihood: "definitely", extra_items: [{ category: "weird", title: "Zebra crossing rule", detail: "d" }] }, existing)!;
    expect(r.permit_likelihood).toBe("unknown");
    expect(r.extra_items[0].category).toBe("regulation");
  });
});

describe("mergeLikelihood", () => {
  it("never lets AI assert likely_required", () => expect(mergeLikelihood("unlikely", "likely_required")).toBe("possibly_required"));
  it("keeps deterministic likely", () => expect(mergeLikelihood("likely_required", "unlikely")).toBe("likely_required"));
  it("no AI = deterministic", () => expect(mergeLikelihood("unknown", null)).toBe("unknown"));
  it("fills unknown from AI (capped)", () => expect(mergeLikelihood("unknown", "unlikely")).toBe("unlikely"));
});

describe("extractJson", () => {
  it("handles fenced JSON", () => expect(extractJson("```json\n{\"a\":1}\n```")).toEqual({ a: 1 }));
  it("returns null for junk", () => expect(extractJson("nope")).toBeNull());
});
