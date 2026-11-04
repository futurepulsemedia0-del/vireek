import { describe, expect, it, vi } from "vitest";
import { createSupabasePorts } from "./ports.ts";
import { hmacHex } from "./stepUp.ts";

const SECRET = "s".repeat(40);
const T = "11111111-1111-4111-8111-111111111111";

function fakeAdmin(handlers: Record<string, (a: Record<string, unknown>) => unknown>, customers: unknown[] = []) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const h = handlers[fn];
      if (!h) return { data: null, error: { message: `no handler ${fn}` } };
      try { return { data: h(args), error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
    }),
    from: () => ({ select: () => ({ eq: () => ({ ilike: () => ({ limit: async () => ({ data: customers, error: null }) }) }) }) }),
  };
  return { admin: admin as never, calls };
}
const mk = (a: never) => createSupabasePorts(a, { secret: SECRET, scanInjection: () => ({ score: 0, rules: [] }), sendSms: async () => true });

describe("supabase ports", () => {
  it("rejects a weak secret", () => {
    const { admin } = fakeAdmin({});
    expect(() => createSupabasePorts(admin, { secret: "short", scanInjection: () => ({ score: 0, rules: [] }), sendSms: async () => true })).toThrow(/32/);
  });
  it("maps call state and drops non-numeric counters", async () => {
    const { admin } = fakeAdmin({ voice_call_state_get: () => ({ customerId: "c1", kdPassedAt: 5, otpPassedAt: null, kdFails: 1, restricted: true, locked: false, riskScore: 40, counters: { denied: 2, evil: "x" } }) });
    const s = await mk(admin).getCallState(T, { callId: "c", kind: "inbound", callerNumber: null, dialedNumberId: null });
    expect(s).toMatchObject({ customerId: "c1", kdPassedAt: 5, otpPassedAt: null, restricted: true, riskScore: 40, counters: { denied: 2 } });
  });
  it("unknown / error mode never silently becomes normal for errors (throws so the gate fails closed)", async () => {
    const { admin } = fakeAdmin({});
    await expect(mk(admin).getMode(T)).rejects.toThrow(/voice_get_mode/);
    const ok = fakeAdmin({ voice_get_mode: () => "lockdown" });
    expect(await mk(ok.admin).getMode(T)).toBe("lockdown");
  });
  it("audit never throws and truncates detail", async () => {
    const { admin, calls } = fakeAdmin({});
    await expect(mk(admin).audit(T, { kind: "k", severity: "low", callId: "c", tool: "t", decision: "deny", code: "x", detail: { a: "y".repeat(500) } })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    const ok = fakeAdmin({ voice_audit_append: () => 1 });
    await mk(ok.admin).audit(T, { kind: "k", severity: "low", callId: "c", tool: "t", decision: "deny", code: "x", detail: { a: "y".repeat(500) } });
    expect((ok.calls[0].args.p_detail as Record<string, string>).a).toHaveLength(120);
  });
  it("canary lookup sends only HMAC digests, never raw values", async () => {
    const { admin, calls } = fakeAdmin({ voice_canary_hit: () => true });
    expect(await mk(admin).isCanary(T, ["+1 (512) 555-0777"])).toBe(true);
    const sent = calls[0].args.p_digests as string[];
    expect(sent).toContain(await hmacHex(SECRET, "canary|5125550777"));
    expect(JSON.stringify(calls[0].args)).not.toContain("555-0777");
  });
  it("shared numbers are treated as no account (never guess whose data)", async () => {
    const a = { id: "1", name: "A", address: null, phone: "+15125550101" };
    const b = { id: "2", name: "B", address: null, phone: "512-555-0101" };
    expect(await mk(fakeAdmin({}, [a, b]).admin).findCustomerByPhone(T, "+15125550101")).toBeNull();
    expect(await mk(fakeAdmin({}, [a]).admin).findCustomerByPhone(T, "+15125550101")).toMatchObject({ id: "1" });
    expect(await mk(fakeAdmin({}, [a]).admin).findCustomerByPhone(T, "12345")).toBeNull();
  });
  it("pending consume maps unknown answers to missing", async () => {
    const { admin } = fakeAdmin({ voice_pending_consume: () => "weird" });
    expect(await mk(admin).pendingConsume(T, "c", "t", "h", "i", 0)).toBe("missing");
  });
});
