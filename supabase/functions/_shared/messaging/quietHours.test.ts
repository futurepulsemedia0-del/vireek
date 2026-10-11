import { describe, it, expect } from "vitest";
import { gateOutbound, gateAndDefer } from "./quietHours.ts";
import { zonedToUtc } from "./quietHoursCore.ts";

type Row = Record<string, unknown>;

/** Minimal chainable fake of the Supabase query builder. */
function fakeAdmin(tables: Record<string, Row[]>, opts: { failInsert?: string; dupCode?: boolean } = {}) {
  const inserted: Record<string, Row[]> = {};
  const admin = {
    from(name: string) {
      let rows = (tables[name] ?? []).slice();
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
        in: (c: string, v: unknown[]) => { rows = rows.filter((r) => v.includes(r[c])); return q; },
        limit: () => q,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        single: async () => ({ data: rows[0] ?? null, error: null }),
        insert: (row: Row) => {
          if (opts.failInsert === name) {
            const err = { message: "boom", code: opts.dupCode ? "23505" : "XX000" };
            const p = Promise.resolve({ data: null, error: err });
            return Object.assign(p, { select: () => ({ single: async () => ({ data: null, error: err }) }) });
          }
          const withId = { id: `${name}-${(inserted[name]?.length ?? 0) + 1}`, ...row };
          (inserted[name] ??= []).push(withId);
          const p = Promise.resolve({ data: null, error: null });
          return Object.assign(p, { select: () => ({ single: async () => ({ data: withId, error: null }) }) });
        },
      };
      return q;
    },
  };
  return { admin: admin as never, inserted };
}

const USER = "u1";
const at = (h: number, tz = "America/Chicago", d = 10) => zonedToUtc(2026, 3, d, h, 0, tz);
const profile = { user_id: USER, timezone: "America/Chicago", quiet_hours: { start: "20:00", end: "08:00" } };

describe("gateOutbound", () => {
  it("passes during the day and writes no audit", async () => {
    const { admin, inserted } = fakeAdmin({ business_profile: [profile], customers: [] });
    const r = await gateOutbound(admin, USER, { channel: "email", to: "a@b.co", now: at(12), source: "t" });
    expect(r.proceed).toBe(true);
    expect(inserted.messaging_gate_events).toBeUndefined();
  });

  it("uses the phone-detected timezone: business is quiet but the LA customer is not", async () => {
    // 21:00 Chicago = 19:00 Los Angeles. Business window (20:00-08:00 Chicago) would block; the customer's clock doesn't.
    const { admin } = fakeAdmin({ business_profile: [profile], customers: [] });
    const r = await gateOutbound(admin, USER, { channel: "sms", to: "+13105550100", now: zonedToUtc(2026, 3, 10, 20, 30, "America/Chicago") });
    expect(r.proceed).toBe(true);
  });

  it("holds when the customer's local time is quiet even if the business is open", async () => {
    // 07:00 Chicago business is quiet, but pick 09:30 Chicago = 07:30 in LA customer.
    const { admin } = fakeAdmin({ business_profile: [profile], customers: [{ id: "c1", user_id: USER, phone: "+13105550100", timezone: null, address: null }] });
    const r = await gateOutbound(admin, USER, { channel: "sms", to: "+13105550100", customerId: "c1", now: zonedToUtc(2026, 3, 10, 9, 30, "America/Chicago") });
    expect(r.proceed).toBe(false);
    if (!r.proceed) expect(r.decision.timezone).toBe("America/Los_Angeles");
  });

  it("audits emergency overrides", async () => {
    const { admin, inserted } = fakeAdmin({ business_profile: [profile], customers: [] });
    const r = await gateOutbound(admin, USER, { channel: "sms", to: "+12145550100", purpose: "emergency", now: at(2), source: "escalate-emergency" });
    expect(r.proceed).toBe(true);
    expect(inserted.messaging_gate_events?.[0]).toMatchObject({ decision: "emergency_override", source: "escalate-emergency" });
  });

  it("defaults safely when settings can't be read", async () => {
    const { admin } = fakeAdmin({});
    const r = await gateOutbound(admin, USER, { channel: "email", to: "a@b.co", now: zonedToUtc(2026, 3, 10, 3, 0, "America/New_York") });
    expect(r.proceed).toBe(false);
  });

  it("returns a jittered sendAt that is not before the window opens", async () => {
    const { admin } = fakeAdmin({ business_profile: [profile], customers: [] });
    const r = await gateOutbound(admin, USER, { channel: "email", to: "a@b.co", now: at(22), source: "x" });
    expect(r.proceed).toBe(false);
    if (!r.proceed) {
      const open = zonedToUtc(2026, 3, 11, 8, 0, "America/Chicago").getTime();
      expect(new Date(r.sendAt).getTime() >= open).toBe(true);
      expect(new Date(r.sendAt).getTime() - open < 20 * 60_000).toBe(true);
    }
  });
});

describe("gateAndDefer", () => {
  it("queues held messages with transport + timezone", async () => {
    const { admin, inserted } = fakeAdmin({ business_profile: [profile], customers: [] });
    const r = await gateAndDefer(admin, USER, { channel: "sms", to: "+12145550100", purpose: "marketing", now: at(22), source: "mkt" }, { bodyText: "hi", transport: "a2p", dedupeKey: "k1" });
    expect(r.proceed).toBe(false);
    expect(inserted.deferred_messages?.[0]).toMatchObject({ channel: "sms", transport: "a2p", purpose: "marketing", dedupe_key: "k1", timezone: "America/Chicago" });
    expect(inserted.messaging_gate_events?.[0]).toMatchObject({ decision: "deferred" });
  });

  it("reports an error (and does NOT proceed) when queueing fails", async () => {
    const { admin } = fakeAdmin({ business_profile: [profile], customers: [] }, { failInsert: "deferred_messages" });
    const r = await gateAndDefer(admin, USER, { channel: "email", to: "a@b.co", now: at(22) }, { bodyText: "x" });
    expect(r.proceed).toBe(false);
    if (!r.proceed) expect(r.result.queued).toBe(false);
  });
});
