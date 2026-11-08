import { describe, expect, it } from "vitest";
import { anomalies, bottlenecks, buildSpans, costPerRun, funnel, nodeStats, percentile, redactForReplay, replayFrames, slaHotspots, type AuditRow, type RunRow } from "./run-analytics.ts";

const t = (s: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, s)).toISOString();
function run(runId: string, steps: Array<[string, string | null, number, Record<string, unknown>?]>): AuditRow[] {
  return steps.map(([event_type, node_id, at, detail], i) => ({ run_id: runId, seq: i + 1, event_type, node_id, detail: detail ?? {}, created_at: t(at) }));
}
const rows: AuditRow[] = [
  ...run("r1", [["node_started", "lookup", 0, { kind: "lookup" }], ["edge_taken", "lookup", 2, { edge: "next" }], ["node_started", "ask", 2, { kind: "approval" }], ["approval_requested", "ask", 2], ["edge_taken", "ask", 302, { edge: "approved" }]]),
  ...run("r2", [["node_started", "lookup", 0, { kind: "lookup" }], ["edge_taken", "lookup", 4, { edge: "fail" }], ["node_started", "__escalate", 4, { kind: "action" }], ["edge_taken", "__escalate", 5, { edge: "next" }]]),
];

describe("spans and stats", () => {
  const spans = buildSpans(rows);
  it("derives durations, edges and approval wait from audit events", () => {
    const ask = spans.find((s) => s.node === "ask")!;
    expect(ask.durationMs).toBe(300_000); expect(ask.approvalWaitMs).toBe(300_000);
    expect(spans.filter((s) => s.node === "lookup").map((s) => s.durationMs)).toEqual([2000, 4000]);
  });
  it("computes failure rate and percentiles", () => {
    const s = nodeStats(spans).find((x) => x.node === "lookup")!;
    expect(s.runs).toBe(2); expect(s.failures).toBe(1); expect(s.failureRate).toBe(0.5);
    expect(s.p50).toBe(2000); expect(s.p95).toBe(4000);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
  });
  it("an unfinished step has no duration instead of a made-up one", () => {
    const open = buildSpans(run("r3", [["node_started", "lookup", 0, { kind: "lookup" }]]));
    expect(open[0].durationMs).toBeNull();
  });
  it("bottleneck ignores human approval wait; funnel counts distinct runs", () => {
    const stats = nodeStats(spans);
    const kinds = new Map([["lookup", "lookup"], ["ask", "approval"], ["__escalate", "action"]]);
    expect(bottlenecks(stats, kinds, 0.3).map((b) => b.node)).toEqual(["lookup"]);
    const f = funnel(spans, ["lookup", "ask", "__escalate"]);
    expect(f.map((x) => x.runs)).toEqual([2, 1, 1]);
    expect(f[1].ofStart).toBe(0.5);
  });
  it("attributes an SLA breach to the slowest step of that run", () => {
    const runs: RunRow[] = [{ id: "r1", status: "completed", started_at: t(0), completed_at: t(302), sla_breached_at: t(100), stop_reason: null }, { id: "r2", status: "completed", started_at: t(0), completed_at: t(5), sla_breached_at: null, stop_reason: null }];
    expect(slaHotspots(runs, spans)).toEqual([{ node: "ask", breaches: 1 }]);
  });
});

describe("cost, anomalies, replay", () => {
  it("cost is null (not zero) when tokens are not recorded; sums when they are", () => {
    expect(costPerRun(rows, 1, 2)).toBeNull();
    const c = costPerRun([...rows, ...run("r9", [["node_started", "q", 0, { tokens_in: 2000, tokens_out: 1000 }], ["edge_taken", "q", 1, { tokens_in: 1000 }]])], 1, 2)!;
    expect(c.get("r9")).toEqual({ tokensIn: 3000, tokensOut: 1000, usd: 5 });
  });
  it("flags outliers robustly and stays quiet on small or flat samples", () => {
    expect(anomalies([10, 11, 9, 10, 12, 10, 300])).toEqual([6]);
    expect(anomalies([1, 2, 3])).toEqual([]);
    expect(anomalies([5, 5, 5, 5, 5, 5])).toEqual([]);
  });
  it("redacts secrets and PII in replay frames and supports scrubbing", () => {
    const red: any = redactForReplay({ api_key: "sk-123", note: "call me +1 555 123 4567 or a@b.com", nested: { customer_phone: "555", ok: 1 } });
    expect(red.api_key).toBe("[redacted]"); expect(red.nested.customer_phone).toBe("[redacted]");
    expect(red.note).toContain("[phone]"); expect(red.note).toContain("[email]");
    const frames = replayFrames(run("r1", [["node_started", "a", 0, { secret: "x" }], ["edge_taken", "a", 1, { edge: "next" }]]), 1);
    expect(frames).toHaveLength(1);
    expect((frames[0].detail as any).secret).toBe("[redacted]");
  });
});
