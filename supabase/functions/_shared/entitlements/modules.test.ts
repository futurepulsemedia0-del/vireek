// @vitest-environment node
import { describe, it, expect } from "vitest";
import { isModuleEnabled, requireModule, MODULE_KEY_RE, type RpcClient } from "./modules.ts";

const OWNER = "11111111-1111-1111-1111-111111111111";
const client = (res: { data: unknown; error: { message: string } | null } | Error): RpcClient & { calls: unknown[] } => {
  const c = { calls: [] as unknown[], rpc: async (fn: string, args: Record<string, unknown>) => {
    c.calls.push([fn, args]);
    if (res instanceof Error) throw res;
    return res;
  } };
  return c;
};

describe("isModuleEnabled", () => {
  it("is true only when the RPC returns exactly true", async () => {
    expect(await isModuleEnabled(client({ data: true, error: null }), OWNER, "supply_orders")).toBe(true);
    expect(await isModuleEnabled(client({ data: false, error: null }), OWNER, "supply_orders")).toBe(false);
    expect(await isModuleEnabled(client({ data: "true", error: null }), OWNER, "supply_orders")).toBe(false);
    expect(await isModuleEnabled(client({ data: null, error: null }), OWNER, "supply_orders")).toBe(false);
  });
  it("fails closed on RPC error or exception", async () => {
    expect(await isModuleEnabled(client({ data: true, error: { message: "boom" } }), OWNER, "supply_orders")).toBe(false);
    expect(await isModuleEnabled(client(new Error("network")), OWNER, "supply_orders")).toBe(false);
  });
  it("rejects malformed keys / empty owner without calling the database", async () => {
    const c = client({ data: true, error: null });
    expect(await isModuleEnabled(c, OWNER, "Bad Key")).toBe(false);
    expect(await isModuleEnabled(c, "", "supply_orders")).toBe(false);
    expect(c.calls).toHaveLength(0);
  });
  it("passes owner and key to has_module_for", async () => {
    const c = client({ data: true, error: null });
    await isModuleEnabled(c, OWNER, "supply_orders");
    expect(c.calls[0]).toEqual(["has_module_for", { p_owner: OWNER, p_key: "supply_orders" }]);
  });
});

describe("requireModule", () => {
  it("returns null when enabled and a 403 when not", async () => {
    expect(await requireModule(client({ data: true, error: null }), OWNER, "supply_orders")).toBeNull();
    const res = await requireModule(client({ data: false, error: null }), OWNER, "supply_orders", { "X-A": "1" });
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "module_not_enabled", module: "supply_orders" });
    expect(res?.headers.get("X-A")).toBe("1");
  });
});

describe("MODULE_KEY_RE", () => {
  it("accepts snake_case keys only", () => {
    expect(MODULE_KEY_RE.test("agent_payments")).toBe(true);
    for (const bad of ["ab", "1abc", "Has-Dash", "a".repeat(50), "with space"]) expect(MODULE_KEY_RE.test(bad)).toBe(false);
  });
});
