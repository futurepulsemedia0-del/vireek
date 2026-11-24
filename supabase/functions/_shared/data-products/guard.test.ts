import { beforeEach, describe, expect, it, vi } from "vitest";
import { POSITIVE_CACHE_MS, assertDataProductApproved, checkDataProduct, gateMode, resetGateCache, type RpcClient } from "./guard.ts";

function fakeClient(result: { data?: unknown; error?: unknown } | (() => never)) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      if (typeof result === "function") return result();
      return { data: result.data ?? null, error: result.error ?? null };
    },
  };
  return { client, calls };
}
const APPROVED = { data: { allowed: true, reason: "approved", review_id: "r-1" } };
const denied = (reason: string) => ({ data: { allowed: false, reason } });

beforeEach(() => {
  resetGateCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("gateMode", () => {
  it("defaults to shadow when unset or empty; anything else (including typos) enforces", () => {
    expect(gateMode(undefined)).toBe("shadow");
    expect(gateMode(null)).toBe("shadow");
    expect(gateMode("  ")).toBe("shadow");
    expect(gateMode("SHADOW")).toBe("shadow");
    expect(gateMode("enforce")).toBe("enforce");
    expect(gateMode("enfroce")).toBe("enforce");
  });
});

describe("checkDataProduct", () => {
  it("calls data_product_gate with the product and endpoint and allows an approved review", async () => {
    const { client, calls } = fakeClient(APPROVED);
    const d = await checkDataProduct(client, "vireek_insights", "insights-api", { mode: "enforce" });
    expect(calls).toEqual([{ fn: "data_product_gate", args: { p_product_key: "vireek_insights", p_endpoint: "insights-api" } }]);
    expect(d).toMatchObject({ allowed: true, reviewId: "r-1", blocking: false });
  });

  it.each(["no_review", "pending", "rejected", "revoked", "expired", "endpoint_not_covered"])("denies %s and blocks in enforce mode", async (reason) => {
    const { client } = fakeClient(denied(reason));
    const d = await checkDataProduct(client, "vireek_insights", "insights-api", { mode: "enforce" });
    expect(d).toMatchObject({ allowed: false, reason, blocking: true });
  });

  it("does not block in shadow mode but still reports the denial", async () => {
    const { client } = fakeClient(denied("pending"));
    expect(await checkDataProduct(client, "vireek_insights", "insights-api", { mode: "shadow" })).toMatchObject({ allowed: false, blocking: false });
  });

  it("fails closed on RPC error, malformed data, null data and thrown errors", async () => {
    for (const r of [{ error: { message: "boom" } }, { data: "yes" }, { data: null }, { data: { allowed: "true" } }]) {
      resetGateCache();
      const d = await checkDataProduct(fakeClient(r).client, "vireek_insights", "insights-api", { mode: "enforce" });
      expect(d.allowed).toBe(false);
      expect(d.blocking).toBe(true);
    }
    const thrower = fakeClient(() => { throw new Error("network"); });
    expect(await checkDataProduct(thrower.client, "vireek_insights", "insights-api", { mode: "enforce" })).toMatchObject({ allowed: false, reason: "gate_unavailable" });
  });

  it("rejects malformed product keys and empty endpoints without calling the database", async () => {
    const { client, calls } = fakeClient(APPROVED);
    for (const [k, e] of [["Bad-Key", "x"], ["", "x"], ["ok_key", "  "], ["a", "x"]] as const) {
      expect((await checkDataProduct(client, k, e, { mode: "enforce" })).reason).toBe("invalid_arguments");
    }
    expect(calls).toHaveLength(0);
  });

  it("caches only positive decisions, for 60 seconds", async () => {
    let t = 1_000;
    const now = () => t;
    const { client, calls } = fakeClient(APPROVED);
    await checkDataProduct(client, "vireek_insights", "insights-api", { mode: "enforce", now });
    await checkDataProduct(client, "vireek_insights", "insights-api", { mode: "enforce", now });
    expect(calls).toHaveLength(1);
    t += POSITIVE_CACHE_MS + 1;
    await checkDataProduct(client, "vireek_insights", "insights-api", { mode: "enforce", now });
    expect(calls).toHaveLength(2);

    resetGateCache();
    const den = fakeClient(denied("pending"));
    await checkDataProduct(den.client, "vireek_insights", "insights-api", { mode: "enforce", now });
    await checkDataProduct(den.client, "vireek_insights", "insights-api", { mode: "enforce", now });
    expect(den.calls).toHaveLength(2);
  });

  it("a revocation takes effect once the positive cache expires", async () => {
    let t = 0;
    const now = () => t;
    const state = { current: APPROVED as { data?: unknown; error?: unknown } };
    const client: RpcClient = { async rpc() { return { data: state.current.data ?? null, error: null }; } };
    expect((await checkDataProduct(client, "vireek_insights", "insights-api", { mode: "enforce", now })).allowed).toBe(true);
    state.current = denied("revoked");
    t += POSITIVE_CACHE_MS + 1;
    expect(await checkDataProduct(client, "vireek_insights", "insights-api", { mode: "enforce", now })).toMatchObject({ allowed: false, reason: "revoked" });
  });

  it("keys the cache by product and endpoint", async () => {
    const { client, calls } = fakeClient(APPROVED);
    await checkDataProduct(client, "vireek_insights", "insights-api", { mode: "enforce" });
    await checkDataProduct(client, "vireek_insights", "other-endpoint", { mode: "enforce" });
    expect(calls).toHaveLength(2);
  });
});

describe("assertDataProductApproved", () => {
  const cors = { "Access-Control-Allow-Origin": "*" };

  it("returns null when approved", async () => {
    expect(await assertDataProductApproved(fakeClient(APPROVED).client, "vireek_insights", "insights-api", cors, { mode: "enforce" })).toBeNull();
  });

  it("returns null (and logs) for a denial in shadow mode", async () => {
    const res = await assertDataProductApproved(fakeClient(denied("no_review")).client, "vireek_insights", "insights-api", cors, { mode: "shadow" });
    expect(res).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("shadow-denied product=vireek_insights endpoint=insights-api reason=no_review"));
  });

  it("returns a generic, no-store 403 for a denial in enforce mode and leaks no reason", async () => {
    const res = await assertDataProductApproved(fakeClient(denied("revoked")).client, "vireek_insights", "insights-api", cors, { mode: "enforce" });
    expect(res?.status).toBe(403);
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
    expect(res?.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = await res!.text();
    expect(body).not.toMatch(/revoked|review|pending/i);
  });

  it("returns 503 with Retry-After when the gate is unavailable in enforce mode", async () => {
    const res = await assertDataProductApproved(fakeClient({ error: { message: "down" } }).client, "vireek_insights", "insights-api", cors, { mode: "enforce" });
    expect(res?.status).toBe(503);
    expect(res?.headers.get("Retry-After")).toBe("30");
  });
});
