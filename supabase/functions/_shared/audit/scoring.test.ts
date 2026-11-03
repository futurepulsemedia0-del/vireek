import { describe, expect, it } from "vitest";
import { bandFor, scoreAudit, speedPoints, voicemailPoints } from "./scoring.ts";
import { DEFAULT_ASSUMPTIONS, estimateRevenueAtRisk, sanitizeAssumptions, wilson } from "./revenue.ts";
import type { AnswerKind, CallObservations, Condition, ScoredCall } from "./types.ts";

const call = (condition: Condition, kind: AnswerKind | null, o: Partial<ScoredCall> & { obs?: CallObservations } = {}): ScoredCall => ({
  slot: condition === "business_hours" ? 1 : condition === "lunch" ? 2 : 3, condition, status: o.status ?? "completed",
  answer_kind: kind, ring_seconds: o.ring_seconds ?? null, observations: o.obs ?? {},
});
const GREAT_VM: CallObservations = { greeting_present: true, business_name_stated: true, callback_promised: true, alternate_option_offered: true, greeting_seconds: 15 };

describe("point functions", () => {
  it("speedPoints is piecewise linear", () => {
    expect([0, 12, 18, 24, 30, 36, 90].map(speedPoints).map(Math.round)).toEqual([100, 100, 80, 60, 30, 0, 0]);
  });
  it("voicemailPoints sums to 100 for a perfect greeting and 0 for none", () => {
    expect(voicemailPoints(GREAT_VM)).toBe(100);
    expect(voicemailPoints({})).toBe(0);
    expect(voicemailPoints({ greeting_present: true })).toBe(30);
    expect(voicemailPoints({ ...GREAT_VM, greeting_seconds: 60 })).toBe(90);
  });
  it("bands", () => expect([100, 85, 84, 65, 64, 40, 39, 0].map(bandFor)).toEqual(["strong", "strong", "fair", "fair", "leaking", "leaking", "critical", "critical"]));
});

describe("scoreAudit", () => {
  const perfect = [
    call("business_hours", "live_person", { ring_seconds: 6, obs: { offered_to_book: true } }),
    call("lunch", "live_ai", { ring_seconds: 8, obs: { offered_to_book: true } }),
    call("after_hours", "live_ai", { ring_seconds: 4, obs: { offered_to_book: true } }),
  ];
  it("a business that always answers, fast, and books scores 100 / strong with full confidence", () => {
    const r = scoreAudit(perfect);
    expect(r).toMatchObject({ total: 100, band: "strong", confidence: "ok", conclusive_calls: 3, inconclusive_calls: 0 });
    expect(r.findings.some((f) => f.severity === "critical" || f.severity === "warn")).toBe(false);
  });
  it("weights: 30/20/10/25/15", () => {
    const r = scoreAudit([
      call("business_hours", "no_answer"), call("lunch", "no_answer"), call("after_hours", "voicemail", { obs: GREAT_VM }),
    ]);
    // answer 0, speed null, voicemail (0+0+100)/3=33, after-hours 35+20=55, booking null -> (0*30+33*10+55*25)/65
    expect(r.sub.answer_rate.score).toBe(0);
    expect(r.sub.speed_to_answer.score).toBeNull();
    expect(r.sub.voicemail_quality.score).toBe(33);
    expect(r.sub.after_hours_coverage.score).toBe(55);
    expect(r.sub.booking_readiness.score).toBeNull();
    expect(r.total).toBe(26); // (0*30 + 33.3*10 + 55*25) / 65
  });
  it("a null sub-score is dropped, not counted as zero", () => {
    const r = scoreAudit([call("business_hours", "live_person", { ring_seconds: 6, obs: { offered_to_book: true } })]);
    expect(r.sub.after_hours_coverage.score).toBeNull();
    expect(r.total).toBe(100);
    expect(r.confidence).toBe("low");
    expect(r.findings.map((f) => f.id)).toEqual(expect.arrayContaining(["after_hours_not_tested", "small_sample"]));
  });
  it("our own failures are excluded and never penalise the owner", () => {
    const r = scoreAudit([
      call("business_hours", "live_person", { ring_seconds: 6, obs: { offered_to_book: true } }),
      call("lunch", "failed", { status: "failed" }),
      call("after_hours", "unknown"),
    ]);
    expect(r).toMatchObject({ total: 100, conclusive_calls: 1, inconclusive_calls: 2 });
    expect(r.findings.map((f) => f.id)).toContain("inconclusive");
  });
  it("no conclusive calls => no score at all", () => {
    const r = scoreAudit([call("business_hours", "failed", { status: "failed" })]);
    expect(r.total).toBeNull();
    expect(r.band).toBeNull();
  });
  it("hold time past 20 s reduces speed up to 30 points", () => {
    const base = scoreAudit([call("business_hours", "live_person", { ring_seconds: 6 })]).sub.speed_to_answer.score;
    const held = scoreAudit([call("business_hours", "live_person", { ring_seconds: 6, obs: { hold_seconds: 60 } })]).sub.speed_to_answer.score;
    expect(base).toBe(100);
    expect(held).toBe(70);
  });
  it("message-only answers score low on booking and produce a finding + fix step", () => {
    const r = scoreAudit([call("business_hours", "live_person", { ring_seconds: 6, obs: { message_only: true } })]);
    expect(r.sub.booking_readiness.score).toBe(35);
    expect(r.findings.map((f) => f.id)).toContain("booking_unclear");
    expect(r.fix_path.map((s) => s.id)).toContain("book_on_first_call");
  });
  it("ring-out and dark after-hours are critical, with evidence slots and a plain-language fix path", () => {
    const r = scoreAudit([call("business_hours", "no_answer"), call("lunch", "no_answer"), call("after_hours", "no_answer")]);
    const ids = r.findings.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["open_hours_missed", "no_voicemail", "after_hours_dark"]));
    expect(r.findings.find((f) => f.id === "after_hours_dark")!.evidence).toEqual([{ slot: 3, condition: "after_hours" }]);
    expect(r.total).toBe(0);
    expect(r.fix_path.map((s) => s.id)).toEqual(expect.arrayContaining(["fix_voicemail", "cover_after_hours", "answer_faster"]));
    expect(r.fix_path.find((s) => s.id === "fix_voicemail")!.vireek_can_help).toBe(false); // honest: free fix
  });
  it("is deterministic", () => expect(scoreAudit(perfect)).toEqual(scoreAudit(structuredClone(perfect))));
  it("scores are always integers within 0-100", () => {
    const kinds: AnswerKind[] = ["live_person", "live_ai", "ivr", "voicemail", "no_answer", "busy"];
    for (const a of kinds) for (const b of kinds) for (const c of kinds) {
      const r = scoreAudit([call("business_hours", a, { ring_seconds: 14 }), call("lunch", b, { ring_seconds: 30 }), call("after_hours", c, { ring_seconds: 3 })]);
      expect(Number.isInteger(r.total)).toBe(true);
      expect(r.total!).toBeGreaterThanOrEqual(0);
      expect(r.total!).toBeLessThanOrEqual(100);
    }
  });
});

describe("revenue at risk", () => {
  const missAll = [call("business_hours", "no_answer"), call("lunch", "no_answer"), call("after_hours", "no_answer")];
  const answerAll = [call("business_hours", "live_person"), call("lunch", "live_person"), call("after_hours", "live_person")];
  it("defaults are flagged as placeholders and mirror /calculator", () => {
    const r = estimateRevenueAtRisk(missAll);
    expect(r.is_placeholder).toBe(true);
    expect(r.assumptions.every((a) => a.source === "default")).toBe(true);
    expect(DEFAULT_ASSUMPTIONS).toMatchObject({ monthlyInboundCalls: 217, avgJobValue: 350, jobConversionRate: 0.3 });
  });
  it("formula: 217 calls * 50% * 100% miss * 30% * $350 = $11,392 (rounded to $10)", () => {
    expect(estimateRevenueAtRisk(missAll).monthly.point).toBe(11390);
  });
  it("is zero when everything is answered, and annual = 12 x monthly", () => {
    const r = estimateRevenueAtRisk(answerAll);
    expect(r.monthly.point).toBe(0);
    expect(r.annual.point).toBe(r.monthly.point * 12);
  });
  it("range is ordered and the interval is wide for tiny samples", () => {
    const r = estimateRevenueAtRisk([call("business_hours", "no_answer"), call("lunch", "live_person"), call("after_hours", "voicemail")]);
    expect(r.monthly.low).toBeLessThanOrEqual(r.monthly.point);
    expect(r.monthly.point).toBeLessThanOrEqual(r.monthly.high);
    expect(r.monthly.high - r.monthly.low).toBeGreaterThan(1000);
    expect(r.notes.join(" ")).toMatch(/illustrative/i);
  });
  it("owner edits flip the source and change the result linearly; hostile input is clamped", () => {
    const r = estimateRevenueAtRisk(missAll, { avgJobValue: 700 });
    expect(r.monthly.point).toBe(22780);
    expect(r.assumptions.find((a) => a.key === "avgJobValue")!.source).toBe("owner");
    expect(r.is_placeholder).toBe(true);
    expect(sanitizeAssumptions({ avgJobValue: -5, newCustomerShare: 9, monthlyInboundCalls: 1e12, evil: 1, jobConversionRate: "x" })).toEqual({ avgJobValue: 0, newCustomerShare: 1, monthlyInboundCalls: 20000 });
  });
  it("voicemail recovery reduces risk only for misses that reached voicemail", () => {
    const vm = [call("business_hours", "voicemail"), call("lunch", "voicemail"), call("after_hours", "voicemail")];
    expect(estimateRevenueAtRisk(vm).monthly.point).toBeLessThan(estimateRevenueAtRisk(missAll).monthly.point);
    expect(estimateRevenueAtRisk(vm, { voicemailRecoveryRate: 1 }).monthly.point).toBe(0);
  });
  it("makes no estimate with no conclusive calls", () => expect(estimateRevenueAtRisk([call("lunch", "failed", { status: "failed" })]).monthly.point).toBe(0));
  it("wilson interval sanity", () => {
    const w = wilson(0, 3); expect(w.low).toBe(0); expect(w.high).toBeGreaterThan(0.3);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });
});
