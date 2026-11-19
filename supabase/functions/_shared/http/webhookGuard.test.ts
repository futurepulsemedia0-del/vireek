import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbWebhookEventStore, isFresh, parseStripeStyleHeader, runOnce, sha256Hex, verifyStripeStyleSignature,
  type ClaimOutcome, type WebhookEventStore,
} from "./webhookGuard.ts";
import { hmacSha256 } from "./webhook.ts";

// In-memory mirror of begin_webhook_event()/finish_webhook_event() (20290306000000_webhook_claims_processing_state.sql).
function memoryStore(clock: { t: number }, leaseDefault = 300) {
  const rows = new Map<string, { status: "processing" | "processed" | "failed"; claimedAt: number; attempts: number }>();
  const store: WebhookEventStore & { rows: typeof rows } = {
    rows,
    async begin(provider, eventId, lease = leaseDefault): Promise<ClaimOutcome> {
      const k = `${provider}|${eventId}`;
      const r = rows.get(k);
      if (!r) { rows.set(k, { status: "processing", claimedAt: clock.t, attempts: 1 }); return "new"; }
      if (r.status === "failed" || (r.status === "processing" && r.claimedAt < clock.t - lease * 1000)) {
        r.status = "processing"; r.claimedAt = clock.t; r.attempts++; return "retry";
      }
      return r.status === "processed" ? "duplicate" : "in_progress";
    },
    async finish(provider, eventId, error = null) {
      const r = rows.get(`${provider}|${eventId}`);
      if (r && r.status === "processing") r.status = error === null ? "processed" : "failed";
    },
  };
  return store;
}

const ok = () => new Response("ok", { status: 200 });

describe("runOnce — replay / duplicate delivery", () => {
  let clock: { t: number };
  beforeEach(() => { clock = { t: 1_700_000_000_000 }; });

  it("runs the handler once and acknowledges the replay with 200 without re-running it", async () => {
    const store = memoryStore(clock);
    const handler = vi.fn(async () => ok());
    const first = await runOnce({ store, provider: "p", eventId: "evt_1" }, handler);
    const second = await runOnce({ store, provider: "p", eventId: "evt_1" }, handler);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("scopes ids per provider", async () => {
    const store = memoryStore(clock);
    const handler = vi.fn(async () => ok());
    await runOnce({ store, provider: "a", eventId: "evt_1" }, handler);
    await runOnce({ store, provider: "b", eventId: "evt_1" }, handler);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("concurrent duplicate delivery: only one runs, the other gets 409 + Retry-After", async () => {
    const store = memoryStore(clock);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const handler = vi.fn(async () => { await gate; return ok(); });
    const a = runOnce({ store, provider: "p", eventId: "evt_2" }, handler);
    await Promise.resolve();
    const b = await runOnce({ store, provider: "p", eventId: "evt_2" }, handler);
    expect(b.status).toBe(409);
    expect(b.headers.get("Retry-After")).toBe("5");
    release();
    expect((await a).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a handler that returns 5xx releases the event so the provider retry is processed", async () => {
    const store = memoryStore(clock);
    const handler = vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 })).mockResolvedValueOnce(ok());
    expect((await runOnce({ store, provider: "p", eventId: "evt_3" }, handler)).status).toBe(500);
    expect((await runOnce({ store, provider: "p", eventId: "evt_3" }, handler)).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
    expect((await runOnce({ store, provider: "p", eventId: "evt_3" }, handler)).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2); // now processed: replay is a no-op
  });

  it("a handler that throws becomes a 500 and the event stays retryable", async () => {
    const store = memoryStore(clock);
    const handler = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(ok());
    const res = await runOnce({ store, provider: "p", eventId: "evt_4" }, handler);
    expect(res.status).toBe(500);
    expect((await runOnce({ store, provider: "p", eventId: "evt_4" }, handler)).status).toBe(200);
  });

  it("a 4xx is a permanent rejection: not retried through the guard", async () => {
    const store = memoryStore(clock);
    const handler = vi.fn(async () => new Response("bad", { status: 400 }));
    await runOnce({ store, provider: "p", eventId: "evt_5" }, handler);
    const again = await runOnce({ store, provider: "p", eventId: "evt_5" }, handler);
    expect(again.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a crashed worker's claim is taken over only after the lease expires", async () => {
    const store = memoryStore(clock);
    await store.begin("p", "evt_6"); // claimed, never finished (crash)
    const handler = vi.fn(async () => ok());
    expect((await runOnce({ store, provider: "p", eventId: "evt_6" }, handler)).status).toBe(409);
    clock.t += 301_000;
    expect((await runOnce({ store, provider: "p", eventId: "evt_6" }, handler)).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("fails closed (503, handler not run) when the store is unavailable", async () => {
    const store: WebhookEventStore = { begin: async () => { throw new Error("x"); }, finish: async () => {} };
    const handler = vi.fn(async () => ok());
    const res = await runOnce({ store, provider: "p", eventId: "e", headers: { "X-Test": "1" } }, handler);
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Test")).toBe("1");
    expect(handler).not.toHaveBeenCalled();
  });

  it("still returns the handler response when finish() fails", async () => {
    const store: WebhookEventStore = { begin: async () => "new", finish: async () => { throw new Error("x"); } };
    expect((await runOnce({ store, provider: "p", eventId: "e" }, async () => ok())).status).toBe(200);
  });
});

describe("dbWebhookEventStore", () => {
  it("maps RPC results and fails closed on errors or unknown values", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: "new", error: null })
      .mockResolvedValueOnce({ data: "weird", error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } })
      .mockResolvedValueOnce({ data: null, error: null });
    const s = dbWebhookEventStore({ rpc });
    expect(await s.begin("p", "e", 60)).toBe("new");
    expect(rpc).toHaveBeenCalledWith("begin_webhook_event", { p_provider: "p", p_event_id: "e", p_lease_seconds: 60 });
    await expect(s.begin("p", "e")).rejects.toThrow();
    await expect(s.begin("p", "e")).rejects.toThrow();
    await s.finish("p", "e", null);
    expect(rpc).toHaveBeenLastCalledWith("finish_webhook_event", { p_provider: "p", p_event_id: "e", p_error: null });
  });
});

describe("isFresh — stale timestamp", () => {
  const now = () => 1_700_000_000_000;
  it("accepts within tolerance in both directions", () => {
    expect(isFresh(1_700_000_000, { now })).toBe(true);
    expect(isFresh(1_700_000_000 - 300, { now })).toBe(true);
    expect(isFresh(1_700_000_000 + 300, { now })).toBe(true);
  });
  it("rejects stale, future, zero, NaN", () => {
    expect(isFresh(1_700_000_000 - 301, { now })).toBe(false);
    expect(isFresh(1_700_000_000 + 301, { now })).toBe(false);
    expect(isFresh(0, { now })).toBe(false);
    expect(isFresh(Number.NaN, { now })).toBe(false);
  });
  it("honours a custom tolerance", () => {
    expect(isFresh(1_700_000_000 - 61, { now, toleranceSeconds: 60 })).toBe(false);
  });
});

describe("verifyStripeStyleSignature", () => {
  const now = () => 1_700_000_000_000;
  const ts = 1_700_000_000;
  const body = '{"id":"evt_1"}';
  const header = async (secret: string, t = ts, b = body) => `t=${t},v1=${await hmacSha256(secret, `${t}.${b}`, "hex")}`;

  it("accepts a valid, fresh signature", async () => {
    const r = await verifyStripeStyleSignature({ payload: body, header: await header("whsec"), secrets: ["whsec"], now });
    expect(r).toEqual({ ok: true, timestamp: ts });
  });
  it("rejects a stale timestamp even when the signature is correct", async () => {
    const t = ts - 3600;
    const r = await verifyStripeStyleSignature({ payload: body, header: await header("whsec", t), secrets: ["whsec"], now });
    expect(r).toEqual({ ok: false, reason: "stale_timestamp" });
  });
  it("rejects a far-future timestamp", async () => {
    const t = ts + 3600;
    expect((await verifyStripeStyleSignature({ payload: body, header: await header("whsec", t), secrets: ["whsec"], now })).ok).toBe(false);
  });
  it("rejects tampered body, wrong secret, malformed/missing header, no secret configured", async () => {
    const h = await header("whsec");
    expect(await verifyStripeStyleSignature({ payload: body + " ", header: h, secrets: ["whsec"], now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyStripeStyleSignature({ payload: body, header: h, secrets: ["other"], now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyStripeStyleSignature({ payload: body, header: "garbage", secrets: ["whsec"], now })).toEqual({ ok: false, reason: "bad_header" });
    expect(await verifyStripeStyleSignature({ payload: body, header: null, secrets: ["whsec"], now })).toEqual({ ok: false, reason: "bad_header" });
    expect(await verifyStripeStyleSignature({ payload: body, header: h, secrets: [undefined, ""], now })).toEqual({ ok: false, reason: "no_secret" });
  });
  it("supports secret rotation and multiple v1 values", async () => {
    const h = await header("new");
    expect((await verifyStripeStyleSignature({ payload: body, header: h, secrets: ["old", "new"], now })).ok).toBe(true);
    const multi = `${await header("old")},v1=${"0".repeat(64)}`;
    expect((await verifyStripeStyleSignature({ payload: body, header: multi, secrets: ["old"], now })).ok).toBe(true);
  });
  it("an exact captured request replays as a valid signature but is stopped by runOnce", async () => {
    const clock = { t: 0 };
    const store = memoryStore(clock);
    const h = await header("whsec");
    const handler = vi.fn(async () => ok());
    for (let i = 0; i < 3; i++) {
      const v = await verifyStripeStyleSignature({ payload: body, header: h, secrets: ["whsec"], now });
      expect(v.ok).toBe(true);
      await runOnce({ store, provider: "stripe-payment", eventId: JSON.parse(body).id }, handler);
    }
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("parseStripeStyleHeader / sha256Hex", () => {
  it("parses t and every v1, ignores v0 and junk, lowercases", () => {
    expect(parseStripeStyleHeader("t=10, v1=AB ,v0=zz,v1=cd,foo")).toEqual({ timestamp: 10, signatures: ["ab", "cd"] });
  });
  it("rejects missing parts and oversized headers", () => {
    expect(parseStripeStyleHeader("v1=ab")).toBeNull();
    expect(parseStripeStyleHeader("t=10")).toBeNull();
    expect(parseStripeStyleHeader("t=abc,v1=ab")).toBeNull();
    expect(parseStripeStyleHeader("t=1,v1=" + "a".repeat(3000))).toBeNull();
  });
  it("sha256Hex matches the known vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
