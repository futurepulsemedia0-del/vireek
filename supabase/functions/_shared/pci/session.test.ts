import { describe, expect, it } from "vitest";
import { buildAuditEvent, canTransition, assertTransition, signSessionToken, verifySessionToken, TERMINAL_STATUSES, type PhonePaymentStatus } from "./session";
import { CardDataLeakError } from "./cardData";

describe("state machine", () => {
  it("allows only the forward path and never leaves a terminal state", () => {
    const path: PhonePaymentStatus[] = ["requested", "recording_paused", "capturing", "tokenized", "charging", "succeeded"];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
    expect(canTransition("requested", "capturing")).toBe(false); // cannot skip the recording pause
    expect(canTransition("requested", "charging")).toBe(false);
    expect(canTransition("capturing", "succeeded")).toBe(false);
    for (const t of TERMINAL_STATUSES) for (const n of path) expect(canTransition(t, n)).toBe(false);
    expect(() => assertTransition("requested", "capturing")).toThrow();
  });
});

describe("audit events", () => {
  it("keeps only allowlisted keys and drops everything else", () => {
    const e = buildAuditEvent("capture_completed", "provider", { card_brand: "visa", card_last4: "1111", expiration: "12/28", cvv: "123", note: "x" });
    expect(e.metadata).toEqual({ card_brand: "visa", card_last4: "1111" });
  });
  it("rejects a non-4-digit last4 and scrubs card-like strings", () => {
    expect(buildAuditEvent("capture_completed", "provider", { card_last4: "4111111111111111" }).metadata).toEqual({});
    const e = buildAuditEvent("capture_failed", "provider", { reason: "bad card 4111 1111 1111 1111" });
    expect(JSON.stringify(e)).not.toContain("4111");
  });
  it("bounds string length", () => {
    expect((buildAuditEvent("capture_failed", "system", { reason: "x".repeat(500) }).metadata.reason as string).length).toBe(120);
  });
  it("the guard type is exported for callers that need to catch it", () => {
    expect(new CardDataLeakError("x", ["pan"]).message).not.toMatch(/\d{4}/);
  });
});

describe("session token", () => {
  it("binds a callback to one session and one secret", async () => {
    const t = await signSessionToken("secret-a", "00000000-0000-4000-8000-000000000001");
    expect(await verifySessionToken("secret-a", "00000000-0000-4000-8000-000000000001", t)).toBe(true);
    expect(await verifySessionToken("secret-a", "00000000-0000-4000-8000-000000000002", t)).toBe(false);
    expect(await verifySessionToken("secret-b", "00000000-0000-4000-8000-000000000001", t)).toBe(false);
    expect(await verifySessionToken("secret-a", "00000000-0000-4000-8000-000000000001", "nope")).toBe(false);
    expect(await verifySessionToken("", "x", t)).toBe(false);
  });
});
