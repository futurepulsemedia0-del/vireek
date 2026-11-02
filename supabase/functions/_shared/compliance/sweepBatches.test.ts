import { describe, expect, it } from "vitest";
import { sweepOwnedRows, type SweepRpcClient } from "./sweepBatches.ts";

const fake = (results: Array<number | { message: string }>) => {
  const calls: Record<string, unknown>[] = [];
  const client: SweepRpcClient = {
    rpc: (_fn, args) => {
      calls.push(args);
      const r = results.shift();
      return Promise.resolve(typeof r === "object" ? { data: null, error: r } : { data: r ?? 0, error: null });
    },
  };
  return { client, calls };
};
const base = { table: "calls", userId: "u1", dateColumn: "created_at", cutoff: "2020-01-01T00:00:00Z" };

describe("sweepOwnedRows", () => {
  it("loops until a short batch and sums the rows", async () => {
    const { client, calls } = fake([100, 100, 40]);
    expect(await sweepOwnedRows(client, { ...base, batchSize: 100 })).toBe(240);
    expect(calls).toHaveLength(3);
  });
  it("stops at maxBatches", async () => {
    const { client, calls } = fake([10, 10, 10, 10]);
    expect(await sweepOwnedRows(client, { ...base, batchSize: 10, maxBatches: 2 })).toBe(20);
    expect(calls).toHaveLength(2);
  });
  it("sends null pii for delete mode and the list for anonymize mode", async () => {
    const a = fake([0]);
    await sweepOwnedRows(a.client, base);
    expect(a.calls[0].p_pii_columns).toBeNull();
    const b = fake([0]);
    await sweepOwnedRows(b.client, { ...base, pii: ["name"] });
    expect(b.calls[0].p_pii_columns).toEqual(["name"]);
  });
  it("throws on rpc error", async () => {
    const { client } = fake([{ message: "boom" }]);
    await expect(sweepOwnedRows(client, base)).rejects.toThrow("boom");
  });
});
