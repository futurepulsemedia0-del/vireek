import { describe, it, expect } from "vitest";
import {
  EMERGENCY_BLOCK_MESSAGE,
  EMERGENCY_CALLING_SUPPORTED,
  detectEmergencyDestination,
  emergencyDestinationDecision,
  isEmergencyDialBlocked,
  normalizeDialed,
} from "./emergencyNumbers";
import { evaluateDestination } from "../fraud/destinationPolicy";
import { guardDestination, guardOutbound, type FraudDb } from "../fraud/guard";
import { gateCustomerOutbound } from "../fraud/outboundGate";
import { parseDialString } from "../pbx/logic";

const CTX = { internationalUnlocked: true, allowedCountries: ["GB"] };

type Ctx = Record<string, unknown>;
function fakeDb(ctx: Ctx | null) {
  const calls: Array<{ fn: string; args?: Record<string, unknown> }> = [];
  const events: Array<Record<string, unknown>> = [];
  const db: FraudDb = {
    rpc(fn, args) {
      calls.push({ fn, args });
      if (fn === "fraud_guard_context") return Promise.resolve(ctx ? { data: ctx, error: null } : { data: null, error: { message: "down" } });
      return Promise.resolve({ data: null, error: null });
    },
    from() {
      return { insert: (row: Record<string, unknown>) => { events.push(row); return Promise.resolve({ error: null }); } };
    },
  };
  return { db, calls, events };
}
const healthy: Ctx = {
  enforce: true, outbound_guard_mode: "enforce", kill_outbound_calls: false, kill_sms: false, kill_international: false,
  status: "active", outbound_unlocked: true, international_unlocked: true, voice_clone_unlocked: false,
  allowed_countries: [], plan: "business", account_age_days: 400,
};
const shadow: Ctx = { ...healthy, outbound_guard_mode: "shadow" };
const shadowGlobal: Ctx = { ...healthy, enforce: false };

const EMERGENCY_FORMS: Array<[string, string]> = [
  ["911", "911"], [" 911 ", "911"], ["9-1-1", "911"], ["9 1 1", "911"], ["(911)", "911"], ["9.1.1", "911"],
  ["+911", "911"], ["1911", "911"], ["1-911", "911"], ["+1911", "911"], ["+1 911", "911"], ["9911", "911"],
  ["9-911", "911"], ["00911", "911"], ["001911", "911"], ["911#", "911"], ["911,,", "911"], ["*911", "911"],
  ["tel:911", "911"], ["TEL:+1-911", "911"], ["sip:911@pbx.example.com", "911"], ["sips:911@example.com;user=phone", "911"],
  ["tel:911;phone-context=example.com", "911"],
  ["９１１", "911"], // full-width digits
  ["٩١١", "911"], // Arabic-Indic digits
  ["۹۱۱", "911"], // Persian digits
  ["112", "112"], ["1-1-2", "112"], ["+112", "112"], ["00112", "112"], ["tel:112", "112"], ["۱۱۲", "112"],
  ["999", "999"], ["9 9 9", "999"], ["+999", "999"], ["00999", "999"], ["sip:999@example.org", "999"], ["۹۹۹", "999"],
];

const NOT_EMERGENCY = [
  "+12025550123", "2025550123", "(202) 555-0123", "+442071234567", "204", "1000", "9112", "1112", "9999", "0911",
  "9110", "9119", "+19115550123x", "", "   ", "hello", "911abc", "+15551234567,,,911", "12345", "91", "11",
];

describe("emergency calling switch", () => {
  it("is OFF: Vireek provides no emergency calling (flip only with docs/compliance/telecom-status.md section 5 signed off)", () => {
    expect(EMERGENCY_CALLING_SUPPORTED).toBe(false);
  });
});

describe("normalizeDialed", () => {
  it("returns null for anything that is not digits and cosmetic separators", () => {
    expect(normalizeDialed(undefined)).toBeNull();
    expect(normalizeDialed(911)).toBeNull();
    expect(normalizeDialed("a911")).toBeNull();
    expect(normalizeDialed("9".repeat(65))).toBeNull();
  });
});

describe("detectEmergencyDestination across number formats", () => {
  it.each(EMERGENCY_FORMS)("treats %j as emergency service %s", (raw, code) => {
    expect(detectEmergencyDestination(raw)).toBe(code);
    expect(isEmergencyDialBlocked(raw)).toBe(true);
  });

  it.each(NOT_EMERGENCY)("does not treat %j as an emergency number", (raw) => {
    expect(detectEmergencyDestination(raw)).toBeNull();
    expect(isEmergencyDialBlocked(raw)).toBe(false);
  });

  it("does not collide with plausible four-digit internal extensions", () => {
    for (const ext of ["9112", "1112", "9999", "1911x", "2911", "3112"]) expect(isEmergencyDialBlocked(ext)).toBe(false);
  });
});

describe("emergencyDestinationDecision", () => {
  it("blocks by default and carries the user notice", () => {
    const d = emergencyDestinationDecision("911");
    expect(d.kind).toBe("blocked");
    if (d.kind === "blocked") {
      expect(d.code).toBe("911");
      expect(d.message).toBe(EMERGENCY_BLOCK_MESSAGE);
      expect(d.message).toMatch(/cannot place emergency calls/i);
    }
  });
  it("only allows when explicitly told real support exists (test seam)", () => {
    expect(emergencyDestinationDecision("112", true)).toEqual({ kind: "allowed", code: "112" });
    expect(emergencyDestinationDecision("+12025550123", true)).toEqual({ kind: "none" });
  });
});

describe("evaluateDestination (central destination policy)", () => {
  it.each(EMERGENCY_FORMS)("refuses %j with EMERGENCY_NUMBER_BLOCKED, not a generic error", (raw) => {
    const r = evaluateDestination(raw, CTX);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("EMERGENCY_NUMBER_BLOCKED");
  });
  it("still allows an ordinary domestic number and still rejects pause-character smuggling", () => {
    expect(evaluateDestination("+12025550123", CTX).allowed).toBe(true);
    const smuggle = evaluateDestination("+12025550123,,,911", CTX);
    expect(smuggle.allowed).toBe(false);
    if (!smuggle.allowed) expect(smuggle.reason).toBe("INVALID_NUMBER");
  });
});

describe("guardOutbound", () => {
  it.each(EMERGENCY_FORMS.slice(0, 12))("refuses %j for every purpose and kind", async (raw) => {
    for (const purpose of ["service", "marketing", "emergency"] as const) {
      for (const kind of ["call", "sms"] as const) {
        const { db } = fakeDb(healthy);
        const r = await guardOutbound(db, { userId: "u1", kind, to: raw, purpose, source: "test" });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.code).toBe("EMERGENCY_NUMBER_BLOCKED");
          expect(r.httpStatus).toBe(403);
          expect(r.message).toBe(EMERGENCY_BLOCK_MESSAGE);
        }
      }
    }
  });

  it("is never relaxed by shadow rollout or by enforce=false", async () => {
    for (const ctx of [shadow, shadowGlobal]) {
      const { db } = fakeDb(ctx);
      const r = await guardOutbound(db, { userId: "u1", kind: "call", to: "911", purpose: "service", source: "test", rollout: "outbound" });
      expect(r.ok).toBe(false);
    }
  });

  it("is refused with the right reason while the fraud store is down (not 'try again shortly')", async () => {
    const { db } = fakeDb(null);
    const r = await guardOutbound(db, { userId: "u1", kind: "call", to: "911", purpose: "emergency", source: "test" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("EMERGENCY_NUMBER_BLOCKED");
  });

  it("touches no ledger and never writes the dialled number to the event log", async () => {
    const { db, calls, events } = fakeDb(healthy);
    await guardOutbound(db, { userId: "u1", kind: "call", to: "9-1-1", purpose: "service", source: "test" });
    expect(calls.some((c) => c.fn === "fraud_reserve")).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/9-1-1|911/);
    expect(events[0]).toMatchObject({ kind: "denied", code: "EMERGENCY_NUMBER_BLOCKED" });
  });

  it("does not disturb the owner hand-off lane (purpose emergency to an ordinary number still passes)", async () => {
    const { db } = fakeDb(healthy);
    const r = await guardOutbound(db, { userId: "u1", kind: "call", to: "+12025550123", purpose: "emergency", source: "test" });
    expect(r.ok).toBe(true);
  });
});

describe("guardDestination", () => {
  it.each(["911", "+1 911", "tel:911", "۹۱۱"])("refuses %j even in shadow rollout", async (raw) => {
    for (const ctx of [healthy, shadow, null]) {
      const { db } = fakeDb(ctx);
      const r = await guardDestination(db, "u1", raw, { rollout: "outbound", source: "test" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("EMERGENCY_NUMBER_BLOCKED");
    }
  });
});

describe("gateCustomerOutbound (outbound-dialer path)", () => {
  it("returns a non-retryable block with the notice", async () => {
    const { db } = fakeDb(shadow);
    const g = await gateCustomerOutbound(db, { userId: "u1", kind: "call", to: "(911)", purpose: "marketing", source: "outbound-dialer", campaign: "quote_followup" });
    expect(g.allowed).toBe(false);
    if (!g.allowed) {
      expect(g.blocked.code).toBe("EMERGENCY_NUMBER_BLOCKED");
      expect(g.blocked.retryable).toBe(false);
      expect(g.blocked.retryAt).toBeNull();
      expect(g.blocked.message).toBe(EMERGENCY_BLOCK_MESSAGE);
    }
  });
});

describe("pbx parseDialString (softphone path)", () => {
  it.each(EMERGENCY_FORMS)("classifies %j as emergency, never as an extension or PSTN number", (raw) => {
    expect(parseDialString(raw)).toMatchObject({ kind: "emergency" });
  });
  it("keeps existing behaviour for extensions and ordinary numbers", () => {
    expect(parseDialString("204")).toEqual({ kind: "extension", extension: "204" });
    expect(parseDialString("9112")).toEqual({ kind: "extension", extension: "9112" });
    expect(parseDialString("(202) 555-0123")).toEqual({ kind: "pstn", e164: "+12025550123" });
    expect(parseDialString("+442071234567")).toEqual({ kind: "pstn", e164: "+442071234567" });
    expect(parseDialString("not a number")).toBeNull();
  });
});
