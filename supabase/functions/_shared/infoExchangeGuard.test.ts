import { describe, expect, it, vi } from "vitest";
import { GuardUnavailableError, guardRows, type GuardRpcClient } from "./infoExchangeGuard.ts";

type Row = { id: string; n: number };

/** Fake server: allows an item when cohort_size >= 5, otherwise blocks with cohort_below_minimum. */
function fakeClient(overrides?: { error?: string; data?: unknown }): GuardRpcClient & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    rpc: vi.fn(async (_fn: string, args: Record<string, unknown>) => {
      calls.push(args);
      if (overrides?.error) return { data: null, error: { message: overrides.error } };
      if (overrides && "data" in overrides) return { data: overrides.data, error: null };
      const items = args.p_items as Array<{ key: string; cohort_size: number }>;
      return {
        data: items.map((it) => ({
          key: it.key,
          allowed: it.cohort_size >= 5,
          reasons: it.cohort_size >= 5 ? [] : ["cohort_below_minimum"],
        })),
        error: null,
      };
    }),
  };
}

const rows: Row[] = [{ id: "a", n: 9 }, { id: "b", n: 4 }, { id: "c", n: 5 }];

describe("guardRows", () => {
  it("splits rows into allowed and blocked with reasons", async () => {
    const client = fakeClient();
    const res = await guardRows(client, "benchmark_cohorts", rows, (r) => [{ metric: "avg_call_score", cohort_size: r.n }]);
    expect(res.allowed.map((r) => r.id)).toEqual(["a", "c"]);
    expect(res.blocked).toEqual([{ row: rows[1], reasons: ["cohort_below_minimum"] }]);
  });

  it("sends the flow and indexed keys, and no thresholds", async () => {
    const client = fakeClient();
    await guardRows(client, "regional_demand", rows, (r) => [{ metric: "m1", cohort_size: r.n }, { metric: "m2", cohort_size: r.n }]);
    const args = client.calls[0] as { p_flow: string; p_items: Array<Record<string, unknown>> };
    expect(args.p_flow).toBe("regional_demand");
    expect(args.p_items.map((i) => i.key)).toEqual(["0:0", "0:1", "1:0", "1:1", "2:0", "2:1"]);
    expect(JSON.stringify(args)).not.toMatch(/min_cohort|max_single|data_lag/);
  });

  it("a wide row is allowed only if ALL of its metrics pass", async () => {
    const client: GuardRpcClient = {
      rpc: async (_fn, args) => ({
        data: (args.p_items as Array<{ key: string }>).map((it) => ({
          key: it.key,
          allowed: it.key !== "0:1",
          reasons: it.key !== "0:1" ? [] : ["single_tenant_share_exceeded"],
        })),
        error: null,
      }),
    };
    const res = await guardRows(client, "regional_demand", [rows[0]], () => [
      { metric: "current_week_calls", cohort_size: 9 },
      { metric: "prior_week_calls", cohort_size: 9 },
    ]);
    expect(res.allowed).toEqual([]);
    expect(res.blocked[0].reasons).toEqual(["single_tenant_share_exceeded"]);
  });

  it("blocks a row that maps to zero items (nothing proven)", async () => {
    const client = fakeClient();
    const res = await guardRows(client, "f", [rows[0]], () => []);
    expect(res.allowed).toEqual([]);
    expect(res.blocked[0].reasons).toEqual(["no_items_to_evaluate"]);
  });

  it("returns immediately for an empty input without calling the server", async () => {
    const client = fakeClient();
    const res = await guardRows(client, "f", [] as Row[], () => []);
    expect(res).toEqual({ allowed: [], blocked: [] });
    expect(client.calls).toHaveLength(0);
  });

  it("FAILS CLOSED when the RPC errors", async () => {
    await expect(guardRows(fakeClient({ error: "boom" }), "f", rows, (r) => [{ metric: "m", cohort_size: r.n }])).rejects.toBeInstanceOf(GuardUnavailableError);
  });

  it("FAILS CLOSED on a non-array response", async () => {
    await expect(guardRows(fakeClient({ data: { allowed: true } }), "f", rows, (r) => [{ metric: "m", cohort_size: r.n }])).rejects.toBeInstanceOf(GuardUnavailableError);
  });

  it("FAILS CLOSED when verdicts are missing", async () => {
    await expect(guardRows(fakeClient({ data: [] }), "f", rows, (r) => [{ metric: "m", cohort_size: r.n }])).rejects.toThrow(/unexpected shape/);
  });

  it("FAILS CLOSED on malformed verdicts (allowed is not a boolean)", async () => {
    const bad = [{ key: "0:0", allowed: "yes", reasons: [] }, { key: "1:0", allowed: true, reasons: [] }, { key: "2:0", allowed: true, reasons: [] }];
    await expect(guardRows(fakeClient({ data: bad }), "f", rows, (r) => [{ metric: "m", cohort_size: r.n }])).rejects.toBeInstanceOf(GuardUnavailableError);
  });

  it("FAILS CLOSED when a verdict key is wrong (cannot match an item)", async () => {
    const wrong = [{ key: "9:9", allowed: true, reasons: [] }, { key: "1:0", allowed: true, reasons: [] }, { key: "2:0", allowed: true, reasons: [] }];
    await expect(guardRows(fakeClient({ data: wrong }), "f", rows, (r) => [{ metric: "m", cohort_size: r.n }])).rejects.toBeInstanceOf(GuardUnavailableError);
  });
});
