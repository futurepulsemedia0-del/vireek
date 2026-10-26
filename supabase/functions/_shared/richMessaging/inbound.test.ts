import { describe, it, expect } from "vitest";
import { e164, handleCapability, handleConversationDeleted, handleInbound, handleProviderOptOut } from "./inbound.ts";
import { account, APP, makeHarness, PHONE } from "./testkit.ts";
import type { InboundEvent } from "./types.ts";

function inbound(over: Partial<InboundEvent> = {}): InboundEvent {
  return {
    type: "inbound", appId: APP, channel: "rcs", identity: "15551230001", providerMessageId: "m1",
    providerConversationId: "c1", contactId: "k1", text: "hello", postback: null, mediaUrl: null,
    receivedAt: "2026-10-07T18:00:00Z", ...over,
  };
}

describe("handleInbound", () => {
  it("stores an RCS message, normalises the phone and learns RCS capability", async () => {
    const h = makeHarness();
    expect(await handleInbound(h.deps, inbound())).toBe("stored");
    expect([...h.conversations.values()][0]).toMatchObject({ channel: "rcs", identity: PHONE, phone: PHONE });
    expect(h.inboundRows).toEqual([{ providerMessageId: "m1", body: "hello", kind: "text" }]);
    expect(h.caps.get(`rcs:${PHONE}`)?.status).toBe("capable");
    expect(h.languages).toEqual(["hello"]);
  });

  it("ignores events for apps no tenant owns", async () => {
    const h = makeHarness();
    expect(await handleInbound(h.deps, inbound({ appId: "other" }))).toBe("unknown_account");
    expect(h.inboundRows).toHaveLength(0);
  });

  it("is idempotent on provider retries", async () => {
    const h = makeHarness();
    await handleInbound(h.deps, inbound());
    expect(await handleInbound(h.deps, inbound())).toBe("duplicate");
    expect(h.inboundRows).toHaveLength(1);
    expect(h.languages).toHaveLength(1);
  });

  it("Apple Messages: opaque id kept as-is, no phone, no capability or language writes", async () => {
    const h = makeHarness();
    await handleInbound(h.deps, inbound({ channel: "amb", identity: "urn:mbid:abc123" }));
    expect([...h.conversations.values()][0]).toMatchObject({ channel: "amb", identity: "urn:mbid:abc123", phone: null });
    expect(h.caps.size).toBe(0);
    expect(h.languages).toHaveLength(0);
  });

  it("a button tap becomes a readable 'reply' message", async () => {
    const h = makeHarness();
    await handleInbound(h.deps, inbound({ text: null, postback: "act:reschedule:job_9" }));
    expect(h.inboundRows[0]).toMatchObject({ kind: "reply", body: "Tapped: reschedule (job_9)" });
  });

  it("media-only message is labelled", async () => {
    const h = makeHarness();
    await handleInbound(h.deps, inbound({ text: null, mediaUrl: "https://cdn.example.com/p.jpg" }));
    expect(h.inboundRows[0]).toMatchObject({ kind: "media", body: "(media attachment)" });
  });

  it("STOP: suppresses the number (shared dnc), stamps the thread, sends one acknowledgement", async () => {
    const h = makeHarness();
    expect(await handleInbound(h.deps, inbound({ text: " Stop. " }))).toBe("opt_out");
    expect(h.suppressed.has(PHONE)).toBe(true);
    expect(h.optOuts).toHaveLength(1);
    expect(h.consentReplies).toHaveLength(1);
    expect(h.consentReplies[0]).toContain("Acme HVAC");
    expect(h.languages).toHaveLength(0);
  });

  it("STOP retried by the provider still ends suppressed but acknowledges only once", async () => {
    const h = makeHarness();
    await handleInbound(h.deps, inbound({ text: "STOP" }));
    h.suppressed.delete(PHONE); // simulate the first attempt crashing before the write landed
    expect(await handleInbound(h.deps, inbound({ text: "STOP" }))).toBe("duplicate");
    expect(h.suppressed.has(PHONE)).toBe(true);
    expect(h.consentReplies).toHaveLength(1);
  });

  it("STOP on Apple Messages opts the thread out; no dnc row because no phone is known", async () => {
    const h = makeHarness();
    await handleInbound(h.deps, inbound({ channel: "amb", identity: "urn:mbid:z", text: "STOP" }));
    expect(h.suppressed.size).toBe(0);
    expect([...h.conversations.values()][0].optedOutAt).toBeTruthy();
  });

  it("START resubscribes and HELP answers without opting anyone out", async () => {
    const h = makeHarness();
    await handleInbound(h.deps, inbound({ providerMessageId: "a", text: "STOP" }));
    expect(await handleInbound(h.deps, inbound({ providerMessageId: "b", text: "start" }))).toBe("opt_in");
    expect(h.suppressed.has(PHONE)).toBe(false);
    expect(await handleInbound(h.deps, inbound({ providerMessageId: "c", text: "HELP" }))).toBe("help");
    expect(h.consentReplies).toHaveLength(3);
  });

  it("a sentence containing 'stop' is NOT an opt-out", async () => {
    const h = makeHarness();
    expect(await handleInbound(h.deps, inbound({ text: "please don't stop by before 9" }))).toBe("stored");
    expect(h.suppressed.size).toBe(0);
  });

  it("uses the verified sender name when no brand name is set", async () => {
    const h = makeHarness({ account: account({ brandName: null, verifiedSenderName: "Acme Heating & Air" }) });
    await handleInbound(h.deps, inbound({ text: "STOP" }));
    expect(h.consentReplies[0]).toContain("Acme Heating & Air");
  });
});

describe("other provider events", () => {
  it("capability answer updates the cache", async () => {
    const h = makeHarness();
    expect(await handleCapability(h.deps, { type: "capability", appId: APP, channel: "rcs", identity: "15551230001", status: "not_capable", features: null })).toBe(true);
    expect(h.caps.get(`rcs:${PHONE}`)?.status).toBe("not_capable");
  });

  it("provider opt-out suppresses the number", async () => {
    const h = makeHarness();
    await handleInbound(h.deps, inbound());
    expect(await handleProviderOptOut(h.deps, { type: "opt_out", appId: APP, channel: "rcs", identity: "15551230001" })).toBe(true);
    expect(h.suppressed.has(PHONE)).toBe(true);
  });

  it("deleted Apple conversation closes the thread; a new inbound reopens it", async () => {
    const h = makeHarness();
    await handleInbound(h.deps, inbound({ channel: "amb", identity: "urn:mbid:q" }));
    await handleConversationDeleted(h.deps, { type: "conversation_deleted", appId: APP, channel: "amb", identity: "urn:mbid:q" });
    const conv = [...h.conversations.values()][0];
    expect(conv.customerClosedAt).toBeTruthy();
    await handleInbound(h.deps, inbound({ channel: "amb", identity: "urn:mbid:q", providerMessageId: "m2" }));
    expect(conv.customerClosedAt).toBeNull();
  });

  it("e164 normalises provider identities", () => {
    expect(e164("15551230001")).toBe("+15551230001");
    expect(e164("+15551230001")).toBe("+15551230001");
    expect(e164("5551230001")).toBe("+15551230001");
    expect(e164("447911123456")).toBe("+447911123456");
  });
});
