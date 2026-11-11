// supabase/functions/_shared/fraud/inboundGate.test.ts
import { describe, expect, it } from "vitest";
import { INBOUND_EXHAUSTED_CODE, isPriorityCaller, runInboundAllowanceGate, type InboundGateLookups } from "./inboundGate.ts";
import type { FraudDb } from "./guard.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FWD = "+14155550100";
const CALLER = "+14155550123";

interface Inserted { table: string; row: Record<string, unknown> }

/** In-memory FraudDb: scripted RPC answers + captured inserts. */
function makeDb(opts: { allowance?: unknown; allowanceError?: boolean; allowanceThrows?: boolean; allowanceDelayMs?: number }) {
  const inserted: Inserted[] = [];
  const rpcCalls: string[] = [];
  const db: FraudDb = {
    rpc(fn: string) {
      rpcCalls.push(fn);
      if (fn === "fraud_inbound_allowance") {
        return new Promise((resolve, reject) => {
          const go = () => {
            if (opts.allowanceThrows) return reject(new Error("boom"));
            if (opts.allowanceError) return resolve({ data: null, error: { message: "rpc down" } });
            resolve({ data: opts.allowance ?? null, error: null });
          };
          if (opts.allowanceDelayMs) setTimeout(go, opts.allowanceDelayMs); else go();
        });
      }
      // guardOutbound for the forwarding hand-off: report the fraud store unavailable so only the local
      // domestic-emergency lane decides (that lane allows a US forward without any ledger).
      return Promise.resolve({ data: null, error: { message: "unavailable" } });
    },
    from(table: string) {
      return { insert: (row: Record<string, unknown>) => { inserted.push({ table, row }); return Promise.resolve({ error: null }); } };
    },
  };
  return { db, inserted, rpcCalls };
}

const FREE_OVER = { allowed: false, free: true, used: 60, included: 50, mode: "monthly" };

function lookups(over: Partial<{ mode: string | null; vip: boolean; plan: string; modeThrows: boolean; vipThrows: boolean }> = {}): InboundGateLookups {
  return {
    enforcementMode: () => over.modeThrows ? Promise.reject(new Error("settings down")) : Promise.resolve(over.mode === undefined ? "shadow" : over.mode),
    isVipCaller: () => over.vipThrows ? Promise.reject(new Error("vip down")) : Promise.resolve(over.vip ?? false),
    plan: () => Promise.resolve(over.plan ?? "free"),
  };
}

function harness() {
  const pending: Promise<unknown>[] = [];
  const logs: Array<{ level: string; payload: Record<string, unknown> }> = [];
  return {
    pending, logs,
    deps: {
      background: (p: Promise<unknown>) => { pending.push(p); },
      log: (level: "info" | "warn", payload: Record<string, unknown>) => { logs.push({ level, payload }); },
    },
    flush: () => Promise.all(pending),
  };
}

const input = (over: Record<string, unknown> = {}) => ({
  userId: OWNER, requestId: "req-1", callId: "call-1", callerNumber: CALLER, forwardingNumber: FWD, priorityNumbers: [] as string[], source: "vapi-webhook", ...over,
});

describe("inbound allowance gate", () => {
  it("free over limit + enforce => exhausted response (forward to owner)", async () => {
    const { db, inserted } = makeDb({ allowance: FREE_OVER });
    const h = harness();
    const out = await runInboundAllowanceGate(db, input(), lookups({ mode: "enforce" }), h.deps);
    expect(out.action).toBe("respond");
    if (out.action !== "respond") throw new Error("unreachable");
    expect(out.reason).toBe("exhausted");
    expect(out.response).toEqual({ destination: { type: "number", number: FWD, message: "Connecting you with the business now." } });
    await h.flush();
    const denied = inserted.find((i) => i.row.kind === "denied" && i.row.code === INBOUND_EXHAUSTED_CODE);
    expect(denied?.row.user_id).toBe(OWNER);
  });

  it("free over limit + enforce + no forwarding number => spoken message, never a silent drop", async () => {
    const { db } = makeDb({ allowance: FREE_OVER });
    const out = await runInboundAllowanceGate(db, input({ forwardingNumber: null }), lookups({ mode: "enforce" }), harness().deps);
    expect(out.action).toBe("respond");
    if (out.action !== "respond") throw new Error("unreachable");
    expect("error" in out.response && out.response.error.length > 20).toBe(true);
  });

  it("free over limit + shadow => call continues and would_block is logged with user_id, plan, used, included", async () => {
    const { db, inserted } = makeDb({ allowance: FREE_OVER });
    const h = harness();
    const out = await runInboundAllowanceGate(db, input(), lookups({ mode: "shadow", plan: "free" }), h.deps);
    expect(out.action).toBe("continue");
    expect(out.reason).toBe("shadow");
    await h.flush();
    expect(inserted.length).toBe(1);
    expect(inserted[0].table).toBe("fraud_events");
    expect(inserted[0].row.kind).toBe("would_block");
    expect(inserted[0].row.code).toBe(INBOUND_EXHAUSTED_CODE);
    expect(inserted[0].row.user_id).toBe(OWNER);
    expect(inserted[0].row.detail).toEqual({ plan: "free", used: 60, included: 50, mode: "monthly", enforcement: "shadow", call_id: "call-1" });
  });

  it("default is shadow: missing, unknown or unreadable mode never blocks", async () => {
    for (const l of [lookups({ mode: null }), lookups({ mode: "ENFORCE-ish" }), lookups({ modeThrows: true })]) {
      const { db } = makeDb({ allowance: FREE_OVER });
      const out = await runInboundAllowanceGate(db, input(), l, harness().deps);
      expect(out.action).toBe("continue");
    }
  });

  it("paid => allowed (enforce) and nothing logged in shadow", async () => {
    const paid = { allowed: true, free: false };
    const a = makeDb({ allowance: paid });
    const out = await runInboundAllowanceGate(a.db, input(), lookups({ mode: "enforce" }), harness().deps);
    expect(out.action).toBe("continue");
    expect(out.reason).toBe("allowed");

    const b = makeDb({ allowance: paid });
    const h = harness();
    await runInboundAllowanceGate(b.db, input(), lookups({ mode: "shadow" }), h.deps);
    await h.flush();
    expect(b.inserted.length).toBe(0);
  });

  it("RPC error / throw / unexpected shape / timeout => fail-open with a structured warning (ids only)", async () => {
    const cases = [
      makeDb({ allowanceError: true }),
      makeDb({ allowanceThrows: true }),
      makeDb({ allowance: { nope: 1 } }),
      makeDb({ allowance: FREE_OVER, allowanceDelayMs: 400 }),
    ];
    for (const c of cases) {
      const h = harness();
      const out = await runInboundAllowanceGate(c.db, input(), lookups({ mode: "enforce" }), { ...h.deps, timeoutMs: 50 });
      expect(out.action).toBe("continue");
      expect(out.reason).toBe("fail_open");
      const w = h.logs.find((l) => l.payload.event === "inbound_allowance_fail_open");
      expect(w?.level).toBe("warn");
      expect(w?.payload.user_id).toBe(OWNER);
      expect(JSON.stringify(w?.payload).includes(CALLER)).toBe(false); // no phone numbers in logs
      expect(out.latencyMs).toBeLessThan(300);
    }
  });

  it("emergency / on-call / priority number => never blocked, no database work at all", async () => {
    for (const mode of ["enforce", "shadow"]) {
      const { db, rpcCalls, inserted } = makeDb({ allowance: FREE_OVER });
      const h = harness();
      const out = await runInboundAllowanceGate(db, input({ priorityNumbers: [undefined, "(415) 555-0123"] }), lookups({ mode }), h.deps);
      expect(out.action).toBe("continue");
      expect(out.reason).toBe("emergency_bypass");
      await h.flush();
      expect(rpcCalls.length).toBe(0);
      expect(inserted.length).toBe(0);
    }
  });

  it("VIP-tagged caller => never blocked in enforce, and not counted as would_block in shadow", async () => {
    const e = makeDb({ allowance: FREE_OVER });
    const out = await runInboundAllowanceGate(e.db, input(), lookups({ mode: "enforce", vip: true }), harness().deps);
    expect(out.action).toBe("continue");
    expect(out.reason).toBe("vip_bypass");

    const s = makeDb({ allowance: FREE_OVER });
    const h = harness();
    await runInboundAllowanceGate(s.db, input(), lookups({ mode: "shadow", vip: true }), h.deps);
    await h.flush();
    expect(s.inserted.length).toBe(0);
  });

  it("VIP lookup failure => never blocks (cannot rule out a VIP)", async () => {
    const { db } = makeDb({ allowance: FREE_OVER });
    const out = await runInboundAllowanceGate(db, input(), lookups({ mode: "enforce", vipThrows: true }), harness().deps);
    expect(out.action).toBe("continue");
    expect(out.reason).toBe("fail_open");
  });

  it("isPriorityCaller matches on the last 10 digits and ignores anonymous callers", () => {
    expect(isPriorityCaller("+1 (415) 555-0123", ["+14155550123"])).toBe(true);
    expect(isPriorityCaller("+14155550999", ["+14155550123"])).toBe(false);
    expect(isPriorityCaller("anonymous", ["anonymous", ""])).toBe(false);
    expect(isPriorityCaller(null, ["+14155550123"])).toBe(false);
  });
});
