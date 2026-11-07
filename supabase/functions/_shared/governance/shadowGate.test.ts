import { beforeEach, describe, expect, it } from "vitest";
import { governedGate, isEnforced } from "./shadowGate.ts";

const store = new Map<string, string>();
(globalThis as any).Deno ??= {
  env: { get: (k: string) => store.get(k), set: (k: string, v: string) => void store.set(k, v), delete: (k: string) => void store.delete(k) },
};
const p = { userId: "u1", actionSlug: "outbound_dial", agentSource: "t" };
const ok = (decision: string) => async () => ({ decision: decision as any, logId: "l1", existing: false });
const boom = async () => { throw new Error("db down"); };

describe("governedGate", () => {
  beforeEach(() => Deno.env.delete("GOVERNANCE_ENFORCE"));

  it("defaults to shadow", () => expect(isEnforced("outbound_dial")).toBe(false));
  it("enforce flag: list, all, other slug", () => {
    Deno.env.set("GOVERNANCE_ENFORCE", "outbound_dial, x");
    expect(isEnforced("outbound_dial")).toBe(true);
    expect(isEnforced("followup_dispatch")).toBe(false);
    Deno.env.set("GOVERNANCE_ENFORCE", "all");
    expect(isEnforced("anything")).toBe(true);
  });
  it("approved actions always allowed", async () => {
    Deno.env.set("GOVERNANCE_ENFORCE", "all");
    expect((await governedGate({} as any, p, ok("auto_approved"))).allow).toBe(true);
  });
  it("shadow: pending/rejected/error are allowed but flagged wouldBlock", async () => {
    for (const [fn, wb] of [[ok("pending_approval"), "pending_approval"], [ok("rejected"), "rejected"], [boom, "gate_error"]] as const) {
      const r = await governedGate({} as any, p, fn as any);
      expect(r.allow).toBe(true);
      expect(r.wouldBlock).toBe(wb);
    }
  });
  it("enforce: pending/rejected/error are blocked (fail closed)", async () => {
    Deno.env.set("GOVERNANCE_ENFORCE", "outbound_dial");
    for (const fn of [ok("pending_approval"), ok("rejected"), boom]) {
      expect((await governedGate({} as any, p, fn as any)).allow).toBe(false);
    }
  });
});
