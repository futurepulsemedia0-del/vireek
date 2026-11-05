import { describe, expect, it } from "vitest";
import { diffCalls, gapSeverity, toEndOfCallReport } from "./reconcile.ts";
import type { ProviderCallRef } from "./providers.ts";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const pc = (id: string, endedMinAgo: number | null, dur: number | null = 60, status: ProviderCallRef["status"] = "ended"): ProviderCallRef => ({
  providerCallId: id, to: "+1", from: "+2", startedAt: new Date(NOW - 60 * 60_000).toISOString(),
  endedAt: endedMinAgo == null ? null : new Date(NOW - endedMinAgo * 60_000).toISOString(), status, durationSeconds: dur,
});
const opts = { graceMs: 10 * 60_000, now: NOW };

describe("diffCalls", () => {
  it("finds calls the provider has and we do not", () => {
    const d = diffCalls([pc("a", 30), pc("b", 30)], [{ providerCallId: "a", durationSeconds: 60 }], opts);
    expect(d.missing.map((m) => m.providerCallId)).toEqual(["b"]);
  });
  it("ignores in-progress calls and calls inside the grace window", () => {
    const d = diffCalls([pc("live", null, null, "in_progress"), pc("fresh", 2)], [], opts);
    expect(d.missing).toHaveLength(0); expect(d.skipped).toBe(2);
  });
  it("reports orphans and material duration mismatches only", () => {
    const d = diffCalls([pc("a", 30, 100), pc("b", 30, 100)], [{ providerCallId: "a", durationSeconds: 60 }, { providerCallId: "b", durationSeconds: 98 }, { providerCallId: "z", durationSeconds: 5 }], opts);
    expect(d.durationMismatch).toEqual([{ providerCallId: "a", providerSeconds: 100, internalSeconds: 60 }]);
    expect(d.orphaned.map((o) => o.providerCallId)).toEqual(["z"]);
  });
  it("honours the minimum-duration filter", () => {
    expect(diffCalls([pc("tiny", 30, 1)], [], { ...opts, minDurationSeconds: 3 }).missing).toHaveLength(0);
  });
  it("empty inputs are clean", () => expect(diffCalls([], [], opts)).toEqual({ missing: [], orphaned: [], durationMismatch: [], skipped: 0 }));
});

describe("gapSeverity", () => {
  it("none / warn / page", () => {
    expect(gapSeverity({ missingBefore: 0, unrecovered: 0, compared: 50 })).toBe("none");
    expect(gapSeverity({ missingBefore: 1, unrecovered: 0, compared: 100 })).toBe("warn");
    expect(gapSeverity({ missingBefore: 5, unrecovered: 0, compared: 1000 })).toBe("page");
    expect(gapSeverity({ missingBefore: 3, unrecovered: 0, compared: 20 })).toBe("page");
    expect(gapSeverity({ missingBefore: 1, unrecovered: 1, compared: 1000 })).toBe("page");
  });
});

describe("toEndOfCallReport", () => {
  it("rebuilds the fields the webhook handler reads", () => {
    const m = toEndOfCallReport({ id: "v1", phoneNumberId: "pn", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:02:00Z", endedReason: "hangup", artifact: { transcript: "T", recordingUrl: "R" }, analysis: { summary: "S" } });
    expect(m).toMatchObject({ type: "end-of-call-report", transcript: "T", summary: "S", recordingUrl: "R", durationSeconds: 120, phoneNumber: { id: "pn" }, endedReason: "hangup" });
  });
  it("does not invent a duration when timestamps are missing", () => {
    expect(toEndOfCallReport({ id: "v" }).durationSeconds).toBeUndefined();
  });
});
