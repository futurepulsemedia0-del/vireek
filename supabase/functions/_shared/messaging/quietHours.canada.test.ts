import { describe, expect, it } from "vitest";
import { CANADA_RECHECK_MS, gateOutbound } from "./quietHours.ts";
import { CA_REQUIRED_RULE_KEYS } from "../compliance-rules/canada.ts";
import { CA_SEED_EFFECTIVE_FROM, CA_SEED_RULES } from "../compliance-rules/caSeedRules.ts";

const NOW = new Date("2026-12-02T16:00:00Z"); // Wed 11:00 Toronto / 10:00 Chicago
const approved = (channel: "call" | "sms" | "email") =>
  CA_REQUIRED_RULE_KEYS[channel].map((k, i) => ({ id: `v${i}`, version: 1, status: "approved", effectiveFrom: CA_SEED_EFFECTIVE_FROM, effectiveTo: null, ...CA_SEED_RULES.find((r) => r.ruleKey === k)! }));

/** Minimal admin stub: table lookups fail (the gate falls back to defaults); rpc returns the catalog. */
function admin(catalog: unknown[] | Error) {
  const calls = { rpc: 0 };
  return {
    calls,
    // deno-lint-ignore no-explicit-any
    client: {
      from() { throw new Error("no db in unit test"); },
      rpc() { calls.rpc += 1; return Promise.resolve(catalog instanceof Error ? { data: null, error: { message: catalog.message } } : { data: catalog, error: null }); },
    // deno-lint-ignore no-explicit-any
    } as any,
  };
}

describe("gateOutbound — Canada gate", () => {
  it("holds a Canadian call (even a service call with an override) until the pack is enabled", async () => {
    const a = admin([]);
    const r = await gateOutbound(a.client, "u1", { channel: "call", to: "+14165550100", purpose: "service", override: { reason: "customer asked" }, now: NOW });
    expect(r.proceed).toBe(false);
    if (!r.proceed) {
      expect(r.decision.reason).toBe("CANADA_PACK_NOT_ENABLED");
      expect(new Date(r.sendAt).getTime()).toBe(NOW.getTime() + CANADA_RECHECK_MS);
    }
  });
  it("fails closed when the rule catalog cannot be read", async () => {
    const r = await gateOutbound(admin(new Error("db down")).client, "u1", { channel: "sms", to: "+16045550100", now: NOW });
    expect(r.proceed).toBe(false);
  });
  it("lets the normal quiet-hours decision run once the full pack is approved", async () => {
    const r = await gateOutbound(admin(approved("call")).client, "u1", { channel: "call", to: "+14165550100", purpose: "service", now: NOW });
    expect(r.proceed).toBe(true);
  });
  it("does not consult the catalog for non-Canadian recipients", async () => {
    const a = admin([]);
    const r = await gateOutbound(a.client, "u1", { channel: "call", to: "+12145550100", purpose: "service", now: NOW });
    expect(r.proceed).toBe(true);
    expect(a.calls.rpc).toBe(0);
  });
});
