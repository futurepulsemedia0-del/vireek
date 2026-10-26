import { describe, it, expect } from "vitest";
import { buildCard } from "./cards.ts";
import { applyDelivery, dispatchDeferred, nextDeliveryStatus, runTimeoutFallback, sendRich } from "./send.ts";
import { account, makeHarness, PHONE, USER } from "./testkit.ts";
import type { DeliveryEvent, RichContent } from "./types.ts";

const text: RichContent = { kind: "text", text: "Your technician is on the way." };
const card = (): RichContent => buildCard({ template: "pay_now", invoiceRef: "INV-7", amountCents: 12500, payUrl: "https://pay.example.com/i/7" }, { name: "Acme HVAC" });
const base = { userId: USER, phone: PHONE, source: "test" } as const;

function receipt(over: Partial<DeliveryEvent>): DeliveryEvent {
  return { type: "delivery", appId: "app-1", providerMessageId: "pm-0", correlationId: null, status: "delivered", reasonCode: null, reasonText: null, channel: "rcs", identity: PHONE, ...over };
}

describe("sendRich: validation + consent", () => {
  it("rejects invalid content before touching anything", async () => {
    const h = makeHarness();
    const r = await sendRich(h.deps, { ...base, content: { kind: "text", text: "  " } });
    expect(r).toMatchObject({ ok: false, reason: "INVALID_CONTENT" });
    expect(h.providerCalls).toHaveLength(0);
  });

  it("rejects marketing purpose (transactional-only)", async () => {
    const h = makeHarness();
    expect(await sendRich(h.deps, { ...base, content: text, purpose: "marketing" })).toMatchObject({ ok: false, reason: "MARKETING_NOT_SUPPORTED" });
  });

  it("requires a recipient", async () => {
    const h = makeHarness();
    expect(await sendRich(h.deps, { userId: USER, content: text, source: "t" })).toMatchObject({ ok: false, reason: "NO_RECIPIENT" });
  });

  it("blocks a suppressed number on every route (shared STOP list)", async () => {
    const h = makeHarness();
    h.suppressed.add(PHONE);
    expect(await sendRich(h.deps, { ...base, content: text })).toMatchObject({ ok: false, reason: "OPTED_OUT" });
    expect(h.providerCalls).toHaveLength(0);
    expect(h.smsSent).toHaveLength(0);
  });

  it("blocks a thread that opted out even when the number is not in dnc (Apple id)", async () => {
    const h = makeHarness();
    const conv = await h.deps.upsertConversation({ userId: USER, channel: "amb", identity: "urn:mbid:abc", phone: null, name: null });
    conv.optedOutAt = "2026-10-07T00:00:00Z";
    expect(await sendRich(h.deps, { userId: USER, conversation: conv, content: text, source: "t" })).toMatchObject({ ok: false, reason: "OPTED_OUT" });
  });

  it("refuses to message an Apple thread the customer deleted", async () => {
    const h = makeHarness();
    const conv = await h.deps.upsertConversation({ userId: USER, channel: "amb", identity: "urn:mbid:abc", phone: null, name: null });
    conv.customerClosedAt = "2026-10-07T00:00:00Z";
    expect(await sendRich(h.deps, { userId: USER, conversation: conv, content: text, source: "t" })).toMatchObject({ ok: false, reason: "CONVERSATION_CLOSED" });
  });
});

describe("sendRich: routing", () => {
  it("unknown capability -> attempts RCS, arms fallback, probes capability", async () => {
    const h = makeHarness();
    const r = await sendRich(h.deps, { ...base, content: card() });
    expect(r).toMatchObject({ ok: true, route: "rcs", status: "sent" });
    expect(h.providerCalls).toHaveLength(1);
    expect(h.providerCalls[0].identity).toBe(PHONE);
    expect(h.providerCalls[0].ttlSeconds).toBe(45);
    expect(h.probes).toEqual([PHONE]);
    const m = [...h.messages.values()][0];
    expect(m).toMatchObject({ status: "sent", fallbackState: "armed", fallbackPhone: PHONE, providerMessageId: "pm-0" });
    expect(m.fallbackText).toContain("Pay now: https://pay.example.com/i/7");
    expect(h.providerCalls[0].correlationId).toBe(m.id);
  });

  it("known not-capable -> plain SMS through the compliant path, no provider call", async () => {
    const h = makeHarness();
    await h.deps.putCapability(USER, "rcs", PHONE, "not_capable");
    const r = await sendRich(h.deps, { ...base, content: card() });
    expect(r).toMatchObject({ ok: true, route: "sms" });
    expect(h.providerCalls).toHaveLength(0);
    expect(h.smsSent).toHaveLength(1);
    expect(h.smsThread).toHaveLength(1);
    expect(h.probes).toHaveLength(0); // fresh answer: no re-probe
  });

  it("RCS not approved yet -> SMS", async () => {
    const h = makeHarness({ account: account({ rcsStatus: "in_review" }) });
    expect(await sendRich(h.deps, { ...base, content: text })).toMatchObject({ ok: true, route: "sms" });
    expect(h.providerCalls).toHaveLength(0);
  });

  it("no account at all -> SMS (feature is opt-in per tenant)", async () => {
    const h = makeHarness({ account: null });
    expect(await sendRich(h.deps, { ...base, content: text })).toMatchObject({ ok: true, route: "sms" });
  });

  it("SMS failure on the SMS route is surfaced (A2P not approved)", async () => {
    const h = makeHarness({ account: null });
    h.setSms(() => ({ ok: false, reason: "A2P_NOT_APPROVED", detail: "pending" }));
    const r = await sendRich(h.deps, { ...base, content: text });
    expect(r).toMatchObject({ ok: false, reason: "SMS_FAILED" });
    expect(h.smsThread).toHaveLength(0);
  });

  it("replying in an Apple thread goes to Apple, arms fallback only when a phone is linked", async () => {
    const h = makeHarness();
    const noPhone = await h.deps.upsertConversation({ userId: USER, channel: "amb", identity: "urn:mbid:a", phone: null, name: null });
    const r = await sendRich(h.deps, { userId: USER, conversation: noPhone, content: text, source: "t" });
    expect(r).toMatchObject({ ok: true, route: "amb" });
    expect(h.providerCalls[0]).toMatchObject({ channel: "amb", identity: "urn:mbid:a" });
    expect([...h.messages.values()][0].fallbackState).toBe("none");
    expect(h.probes).toHaveLength(0); // capability probing is RCS-only
  });
});

describe("sendRich: quiet hours, dedupe, provider errors", () => {
  it("holds the message during quiet hours and persists it as deferred", async () => {
    const h = makeHarness();
    h.setGate(() => ({ proceed: false, sendAt: "2026-10-08T12:00:00Z" }));
    const r = await sendRich(h.deps, { ...base, content: card() });
    expect(r).toMatchObject({ ok: true, route: "rcs", status: "deferred", sendAt: "2026-10-08T12:00:00Z" });
    expect(h.providerCalls).toHaveLength(0);
    const m = [...h.messages.values()][0];
    expect(m).toMatchObject({ status: "deferred", scheduledFor: "2026-10-08T12:00:00Z", fallbackState: "none" });
  });

  it("de-duplicates by dedupeKey (cron retries never double-send)", async () => {
    const h = makeHarness();
    const a = await sendRich(h.deps, { ...base, content: text, dedupeKey: "booking:1" });
    const b = await sendRich(h.deps, { ...base, content: text, dedupeKey: "booking:1" });
    expect(a).toMatchObject({ ok: true, route: "rcs" });
    expect(b).toMatchObject({ ok: true, duplicate: true });
    expect(h.providerCalls).toHaveLength(1);
  });

  it("provider refuses immediately -> SMS fallback right away, row ends fallback_sent", async () => {
    const h = makeHarness();
    h.setProvider(() => ({ ok: false, error: "HTTP 500", retryable: true }));
    const r = await sendRich(h.deps, { ...base, content: card() });
    expect(r).toMatchObject({ ok: true, route: "sms", viaFallback: true });
    expect(h.smsSent).toHaveLength(1);
    const m = [...h.messages.values()][0];
    expect(m).toMatchObject({ status: "fallback_sent", fallbackState: "sent" });
  });

  it("provider refuses and fallback is disabled -> failed, nothing texted", async () => {
    const h = makeHarness({ account: account({ fallbackToSms: false }) });
    h.setProvider(() => ({ ok: false, error: "bad", retryable: false }));
    const r = await sendRich(h.deps, { ...base, content: text });
    expect(r).toMatchObject({ ok: false, reason: "PROVIDER_ERROR" });
    expect(h.smsSent).toHaveLength(0);
    expect([...h.messages.values()][0].status).toBe("failed");
  });

  it("fallback honours a stop that arrived while the send was in flight", async () => {
    const h = makeHarness();
    h.setProvider(() => { h.suppressed.add(PHONE); return { ok: false, error: "x", retryable: false }; });
    const r = await sendRich(h.deps, { ...base, content: text });
    expect(r).toMatchObject({ ok: false, reason: "SMS_FAILED" });
    expect(h.smsSent).toHaveLength(0);
  });

  it("consent replies bypass suppression and quiet hours (STOP acknowledgement)", async () => {
    const h = makeHarness();
    h.suppressed.add(PHONE);
    h.setGate(() => ({ proceed: false, sendAt: "2026-10-08T12:00:00Z" }));
    const conv = await h.deps.upsertConversation({ userId: USER, channel: "rcs", identity: PHONE, phone: PHONE, name: null });
    conv.optedOutAt = "2026-10-07T00:00:00Z";
    const r = await sendRich(h.deps, { userId: USER, conversation: conv, phone: PHONE, content: text, source: "c", isConsentReply: true });
    expect(r).toMatchObject({ ok: true, route: "rcs", status: "sent" });
  });
});

describe("receipts", () => {
  async function sent() {
    const h = makeHarness();
    await sendRich(h.deps, { ...base, content: card() });
    return { h, msg: [...h.messages.values()][0] };
  }

  it("delivered -> status delivered, fallback cancelled, number learned as RCS capable", async () => {
    const { h, msg } = await sent();
    expect(await applyDelivery(h.deps, receipt({ providerMessageId: "pm-0" }))).toBe("applied");
    expect(msg).toMatchObject({ status: "delivered", fallbackState: "cancelled" });
    expect(msg.deliveredAt).toBeTruthy();
    expect(h.caps.get(`rcs:${PHONE}`)?.status).toBe("capable");
  });

  it("read after delivered upgrades; a late delivered never downgrades read", async () => {
    const { h, msg } = await sent();
    await applyDelivery(h.deps, receipt({ providerMessageId: "pm-0", status: "read" }));
    expect(msg.status).toBe("read");
    expect(msg.readAt).toBeTruthy();
    await applyDelivery(h.deps, receipt({ providerMessageId: "pm-0", status: "delivered" }));
    expect(msg.status).toBe("read");
  });

  it("matches by correlation id when the provider id was never stored", async () => {
    const { h, msg } = await sent();
    msg.providerMessageId = null;
    await applyDelivery(h.deps, receipt({ providerMessageId: "other", correlationId: msg.id }));
    expect(msg.status).toBe("delivered");
    expect(msg.providerMessageId).toBe("other");
  });

  it("FAILED (not reachable) -> marks number not capable and falls back to SMS exactly once", async () => {
    const { h, msg } = await sent();
    const ev = receipt({ providerMessageId: "pm-0", status: "failed", reasonCode: "RECIPIENT_NOT_REACHABLE" });
    expect(await applyDelivery(h.deps, ev)).toBe("fallback_triggered");
    expect(await applyDelivery(h.deps, ev)).not.toBe("fallback_triggered"); // provider retry
    expect(h.smsSent).toHaveLength(1);
    expect(msg).toMatchObject({ status: "fallback_sent", fallbackState: "sent" });
    expect(h.caps.get(`rcs:${PHONE}`)?.status).toBe("not_capable");
  });

  it("a FAILED receipt after delivery is ignored", async () => {
    const { h, msg } = await sent();
    await applyDelivery(h.deps, receipt({ providerMessageId: "pm-0" }));
    expect(await applyDelivery(h.deps, receipt({ providerMessageId: "pm-0", status: "failed" }))).toBe("ignored");
    expect(msg.status).toBe("delivered");
    expect(h.smsSent).toHaveLength(0);
  });

  it("unknown message and pending status are harmless", async () => {
    const { h } = await sent();
    expect(await applyDelivery(h.deps, receipt({ providerMessageId: "nope" }))).toBe("unknown_message");
    expect(await applyDelivery(h.deps, receipt({ providerMessageId: "pm-0", status: "pending" }))).toBe("ignored");
  });

  it("nextDeliveryStatus only moves forward", () => {
    expect(nextDeliveryStatus("sent", "delivered")).toBe("delivered");
    expect(nextDeliveryStatus("delivered", "read")).toBe("read");
    expect(nextDeliveryStatus("read", "delivered")).toBeNull();
    expect(nextDeliveryStatus("fallback_sent", "delivered")).toBeNull();
    expect(nextDeliveryStatus("failed", "delivered")).toBe("delivered");
  });
});

describe("timeout fallback + deferred release", () => {
  it("timeout fallback texts the stored fallback copy once and mirrors it into the SMS thread", async () => {
    const h = makeHarness();
    await sendRich(h.deps, { ...base, content: card() });
    const msg = [...h.messages.values()][0];
    msg.fallbackState = "sending"; // as claim_rich_fallbacks would
    const res = await runTimeoutFallback(h.deps, msg);
    expect(res.ok).toBe(true);
    expect(h.smsSent[0].body).toBe(msg.fallbackText);
    expect(h.smsSent[0].opts).toMatchObject({ dedupeKey: `rich-fb:${msg.id}`, source: "rich-fallback:timeout" });
    expect(h.smsThread).toHaveLength(1);
    expect(msg).toMatchObject({ status: "fallback_sent", fallbackState: "sent" });
  });

  it("fallback is skipped (and recorded) when the recipient opted out meanwhile", async () => {
    const h = makeHarness();
    await sendRich(h.deps, { ...base, content: text });
    const msg = [...h.messages.values()][0];
    msg.fallbackState = "sending";
    h.suppressed.add(PHONE);
    expect(await runTimeoutFallback(h.deps, msg)).toMatchObject({ ok: false });
    expect(h.smsSent).toHaveLength(0);
    expect(msg).toMatchObject({ status: "failed", fallbackState: "failed" });
  });

  it("released deferred message re-runs the pipeline and is sent", async () => {
    const h = makeHarness();
    h.setGate(() => ({ proceed: false, sendAt: "2026-10-08T12:00:00Z" }));
    await sendRich(h.deps, { ...base, content: card() });
    const msg = [...h.messages.values()][0];
    msg.status = "queued"; // as claim_due_rich_deferred would
    h.setGate(() => ({ proceed: true }));
    const r = await dispatchDeferred(h.deps, msg);
    expect(r).toMatchObject({ ok: true, route: "rcs", status: "sent" });
    expect(h.messages.size).toBe(1); // resumed the same row, no duplicate
    expect(msg.status).toBe("sent");
    expect(msg.fallbackState).toBe("armed");
  });

  it("released deferred message is cancelled if the customer opted out while it waited", async () => {
    const h = makeHarness();
    h.setGate(() => ({ proceed: false, sendAt: "2026-10-08T12:00:00Z" }));
    await sendRich(h.deps, { ...base, content: text });
    const msg = [...h.messages.values()][0];
    msg.status = "queued";
    h.suppressed.add(PHONE);
    h.setGate(() => ({ proceed: true }));
    expect(await dispatchDeferred(h.deps, msg)).toMatchObject({ ok: false, reason: "OPTED_OUT" });
    expect(msg.status).toBe("failed");
    expect(h.providerCalls).toHaveLength(0);
  });

  it("released deferred message re-deferred when still inside quiet hours", async () => {
    const h = makeHarness();
    h.setGate(() => ({ proceed: false, sendAt: "2026-10-08T12:00:00Z" }));
    await sendRich(h.deps, { ...base, content: text });
    const msg = [...h.messages.values()][0];
    msg.status = "queued";
    h.setGate(() => ({ proceed: false, sendAt: "2026-10-08T13:00:00Z" }));
    expect(await dispatchDeferred(h.deps, msg)).toMatchObject({ ok: true, status: "deferred" });
    expect(msg).toMatchObject({ status: "deferred", scheduledFor: "2026-10-08T13:00:00Z" });
  });
});
