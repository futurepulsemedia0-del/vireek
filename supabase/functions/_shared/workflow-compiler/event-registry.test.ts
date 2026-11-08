import { describe, expect, it } from "vitest";
import { compatibilityErrors, dedupeKey, isExpired, nextRetry, planDelivery, planReplay, pressure, validatePayload, type EventSchema, type Pending } from "./event-registry.ts";

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

describe("schemas", () => {
  const v1: EventSchema = { fields: { job_id: { type: "string", required: true }, amount: { type: "number" } } };
  it("allows additive optional fields only", () => {
    expect(compatibilityErrors(v1, { fields: { ...v1.fields, note: { type: "string" } } })).toEqual([]);
    expect(compatibilityErrors(v1, { fields: { ...v1.fields, note: { type: "string", required: true } } })).toHaveLength(1);
    expect(compatibilityErrors(v1, { fields: { job_id: v1.fields.job_id } })).toEqual(['field "amount" was removed']);
    expect(compatibilityErrors(v1, { fields: { job_id: { type: "number", required: true }, amount: { type: "number" } } })[0]).toContain("changed type");
    expect(compatibilityErrors(v1, { fields: { job_id: v1.fields.job_id, amount: { type: "number", required: true } } })[0]).toContain("became required");
  });
  it("validates payloads", () => {
    expect(validatePayload(v1, { job_id: "j" })).toEqual([]);
    expect(validatePayload(v1, { amount: 1 })).toEqual(['missing required field "job_id"']);
    expect(validatePayload(v1, { job_id: 5 })).toEqual(['field "job_id" must be string']);
    expect(validatePayload(v1, [])).toHaveLength(1);
    expect(validatePayload(v1, null)).toHaveLength(1);
  });
  it("dedupe keys are strict", () => {
    expect(dedupeKey("job.created", "a1", 3)).toBe("job.created|a1|3");
    expect(() => dedupeKey("a|b", "x", 1)).toThrow();
    expect(() => dedupeKey("a", "x", 0)).toThrow();
  });
});

describe("planDelivery (per-aggregate ordering)", () => {
  it("delivers only the next version per aggregate, skips duplicates, blocks gaps", () => {
    const p: Pending[] = [
      { id: "1", aggregate_id: "A", aggregate_version: 1 }, { id: "2", aggregate_id: "A", aggregate_version: 2 },
      { id: "3", aggregate_id: "B", aggregate_version: 4 }, { id: "4", aggregate_id: "C", aggregate_version: 1 },
    ];
    const r = planDelivery(p, new Map([["B", 2], ["C", 1]]));
    expect(r.deliver.map((e) => e.id)).toEqual(["1"]);
    expect(r.blocked.map((e) => e.id).sort()).toEqual(["2", "3"]);
    expect(r.duplicates.map((e) => e.id)).toEqual(["4"]);
  });
  it("property: any arrival order and duplicates still processes every gap-free event exactly once, in order", () => {
    const r = rng(31);
    for (let c = 0; c < 300; c++) {
      const aggs = ["A", "B", "C", "D"].slice(0, 1 + Math.floor(r() * 4));
      const all: Pending[] = [];
      for (const a of aggs) { const n = Math.floor(r() * 8); for (let v = 1; v <= n; v++) all.push({ id: `${a}${v}`, aggregate_id: a, aggregate_version: v }); }
      const withDupes = [...all, ...all.filter(() => r() < 0.3)].sort(() => r() - 0.5);
      const committed = new Map<string, number>(); const processed: string[] = [];
      for (let guard = 0; guard < 200; guard++) {
        const plan = planDelivery(withDupes, committed);
        if (!plan.deliver.length) break;
        for (const e of plan.deliver) { expect(e.aggregate_version).toBe((committed.get(e.aggregate_id) ?? 0) + 1); committed.set(e.aggregate_id, e.aggregate_version); processed.push(e.id); }
      }
      expect(new Set(processed).size).toBe(processed.length);
      expect([...processed].sort()).toEqual(all.map((e) => e.id).sort());
    }
  });
  it("property: a missing version blocks everything after it, nothing is delivered out of order", () => {
    const p: Pending[] = [1, 2, 4, 5].map((v) => ({ id: `A${v}`, aggregate_id: "A", aggregate_version: v }));
    const committed = new Map<string, number>();
    const done: number[] = [];
    for (let i = 0; i < 10; i++) { const pl = planDelivery(p, committed); if (!pl.deliver.length) break; for (const e of pl.deliver) { committed.set("A", e.aggregate_version); done.push(e.aggregate_version); } }
    expect(done).toEqual([1, 2]);
  });
});

describe("backpressure, retry, dead letters", () => {
  const cfg = { warnDepth: 100, shedDepth: 1000, warnAgeMs: 60_000, shedAgeMs: 600_000 };
  it("classifies pressure by depth or age", () => {
    expect(pressure(0, 0, cfg)).toBe("ok");
    expect(pressure(100, 0, cfg)).toBe("warn");
    expect(pressure(0, 60_000, cfg)).toBe("warn");
    expect(pressure(1000, 0, cfg)).toBe("shed");
    expect(pressure(0, 600_000, cfg)).toBe("shed");
  });
  it("backoff grows, is capped, jitter stays in [50%,100%], and the last attempt dead-letters", () => {
    const rc = { maxAttempts: 6, baseMs: 1000, capMs: 10_000 };
    let prev = 0;
    for (let a = 1; a < 6; a++) { const n: any = nextRetry(a, rc, 0.999); expect(n.action).toBe("retry"); expect(n.delayMs <= rc.capMs).toBe(true); expect(n.delayMs >= prev).toBe(true); prev = n.delayMs; }
    expect((nextRetry(1, rc, 0) as any).delayMs).toBe(500);
    expect((nextRetry(1, rc, 5) as any).delayMs <= 1000).toBe(true);
    expect(nextRetry(6, rc)).toEqual({ action: "dead_letter" });
    expect(() => nextRetry(0, rc)).toThrow();
  });
  it("replay picks oldest first, skips replayed, filters, and bounds the batch", () => {
    const d = [
      { id: "3", event_type: "a", failed_at: "2026-11-03" }, { id: "1", event_type: "a", failed_at: "2026-11-01" },
      { id: "2", event_type: "b", failed_at: "2026-11-02" }, { id: "0", event_type: "a", failed_at: "2026-10-01", replayed_at: "2026-10-02" },
    ];
    expect(planReplay(d, { maxBatch: 10 }).map((x) => x.id)).toEqual(["1", "2", "3"]);
    expect(planReplay(d, { maxBatch: 1 }).map((x) => x.id)).toEqual(["1"]);
    expect(planReplay(d, { types: ["b"], maxBatch: 10 }).map((x) => x.id)).toEqual(["2"]);
    expect(planReplay(d, { since: "2026-11-02", maxBatch: 10 }).map((x) => x.id)).toEqual(["2", "3"]);
  });
  it("retention", () => {
    expect(isExpired("2026-01-01T00:00:00Z", Date.parse("2026-03-01T00:00:00Z"), 30)).toBe(true);
    expect(isExpired("2026-02-20T00:00:00Z", Date.parse("2026-03-01T00:00:00Z"), 30)).toBe(false);
  });
});
