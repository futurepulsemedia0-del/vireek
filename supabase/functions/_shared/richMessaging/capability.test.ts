import { describe, it, expect } from "vitest";
import { CAPABILITY_TTL_MS, expiryFor, isFresh, pickRoute } from "./capability.ts";
import { account } from "./testkit.ts";
import type { CapabilityRecord, RichConversationRef } from "./types.ts";

const now = new Date("2026-10-07T18:00:00Z");
const PHONE = "+15551230001";
const cap = (status: CapabilityRecord["status"], expiresInMs = 60_000): CapabilityRecord => ({
  status, checkedAt: now.toISOString(), expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
});
const conv = (over: Partial<RichConversationRef>): RichConversationRef => ({
  id: "c", userId: "u", channel: "rcs", identity: PHONE, phone: PHONE, name: null, optedOutAt: null, customerClosedAt: null, ...over,
});
const route = (over: Partial<Parameters<typeof pickRoute>[0]> = {}) =>
  pickRoute({ account: account(), conversation: null, phone: PHONE, capability: null, now, ...over });

describe("freshness", () => {
  it("expires by timestamp", () => {
    expect(isFresh(cap("capable"), now)).toBe(true);
    expect(isFresh(cap("capable", -1), now)).toBe(false);
    expect(isFresh(null, now)).toBe(false);
  });

  it("not-capable answers are re-checked sooner than capable ones, unknown soonest", () => {
    expect(CAPABILITY_TTL_MS.unknown).toBeLessThan(CAPABILITY_TTL_MS.not_capable);
    expect(CAPABILITY_TTL_MS.not_capable).toBeLessThan(CAPABILITY_TTL_MS.capable);
    expect(new Date(expiryFor("capable", now)).getTime() - now.getTime()).toBe(CAPABILITY_TTL_MS.capable);
  });
});

describe("pickRoute (RCS, phone based)", () => {
  it("fresh capable -> rcs, fallback armed, no probe", () => {
    expect(route({ capability: cap("capable") })).toEqual({ route: "rcs", reason: "rcs_capable", armFallback: true, probe: false });
  });

  it("fresh not capable -> sms, no probe", () => {
    expect(route({ capability: cap("not_capable") })).toEqual({ route: "sms", reason: "rcs_not_capable", armFallback: false, probe: false });
  });

  it("no answer yet -> attempt rcs with fallback and probe", () => {
    expect(route()).toEqual({ route: "rcs", reason: "rcs_unknown_attempt", armFallback: true, probe: true });
  });

  it("stale 'capable' is treated as unknown and re-probed", () => {
    expect(route({ capability: cap("capable", -1) })).toMatchObject({ route: "rcs", reason: "rcs_unknown_attempt", probe: true });
  });

  it("stale 'not capable' still re-probes but is retried over RCS only when attempt_on_unknown", () => {
    expect(route({ capability: cap("not_capable", -1) })).toMatchObject({ route: "rcs", probe: true });
    expect(route({ capability: cap("not_capable", -1), account: account({ attemptOnUnknown: false }) })).toMatchObject({ route: "sms", reason: "rcs_unknown_sms", probe: true });
  });

  it("tenant switched fallback off -> rcs without arming", () => {
    expect(route({ capability: cap("capable"), account: account({ fallbackToSms: false }) })).toMatchObject({ route: "rcs", armFallback: false });
  });

  it.each([
    ["not enabled", { rcsEnabled: false }],
    ["not approved", { rcsStatus: "in_review" as const }],
    ["suspended", { rcsStatus: "suspended" as const }],
    ["no provider app", { providerAppId: null }],
  ])("RCS %s -> sms", (_n, over) => {
    expect(route({ account: account(over), capability: cap("capable") })).toMatchObject({ route: "sms", reason: "rcs_unavailable" });
  });

  it("no account -> sms", () => {
    expect(route({ account: null })).toMatchObject({ route: "sms" });
  });
});

describe("pickRoute (Apple Messages thread)", () => {
  it("replies go to Apple; fallback armed only with a linked phone", () => {
    expect(route({ conversation: conv({ channel: "amb", identity: "urn:mbid:a", phone: null }), phone: null }))
      .toEqual({ route: "amb", reason: "amb_thread", armFallback: false, probe: false });
    expect(route({ conversation: conv({ channel: "amb", identity: "urn:mbid:a", phone: PHONE }) }))
      .toMatchObject({ route: "amb", armFallback: true });
  });

  it("closed or disabled Apple thread falls to SMS", () => {
    expect(route({ conversation: conv({ channel: "amb", customerClosedAt: "2026-10-01T00:00:00Z" }) })).toMatchObject({ route: "sms", reason: "amb_unavailable" });
    expect(route({ conversation: conv({ channel: "amb" }), account: account({ ambEnabled: false }) })).toMatchObject({ route: "sms" });
    expect(route({ conversation: conv({ channel: "amb" }), account: account({ ambStatus: "requested" }) })).toMatchObject({ route: "sms" });
  });
});
