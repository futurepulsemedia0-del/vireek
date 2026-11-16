import { beforeEach, describe, expect, it } from "vitest";
import {
  BulkheadRejectedError, bulkheadEnabled, bulkheadGuard, createBulkhead, isBulkheadRejection, resetBulkheads, resolveConfig,
  type BulkheadClock, type EnvReader,
} from "./bulkhead.ts";
import { sendWithFailover, telnyxSms, twilioCarrier, twilioSms, vapiEngine } from "./adapters.ts";

/** Deterministic clock: timers only fire when advance() is called. */
function fakeClock() {
  let t = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: BulkheadClock = {
    now: () => t,
    setTimeout: (fn, ms) => { const k = ++id; timers.set(k, { at: t + ms, fn }); return k; },
    clearTimeout: (k) => { timers.delete(k as number); },
  };
  const advance = (ms: number) => {
    t += ms;
    for (const [k, v] of [...timers]) if (v.at <= t) { timers.delete(k); v.fn(); }
  };
  return { clock, advance, pending: () => timers.size };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const env = (o: Record<string, string>): EnvReader => ({ get: (k) => o[k] });

beforeEach(() => resetBulkheads());

describe("bulkhead core", () => {
  it("runs up to maxConcurrent at once and queues the rest in FIFO order", async () => {
    const { clock } = fakeClock();
    const b = createBulkhead("p", { maxConcurrent: 2, maxQueue: 2, queueTimeoutMs: 1000 }, { clock });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const order: number[] = [];
    const runs = gates.map((g, i) => b.run(async () => { order.push(i); await g.promise; return i; }));
    await flush();
    expect(order).toEqual([0, 1]);
    expect(b.metrics().inFlight).toBe(2);
    expect(b.metrics().queued).toBe(2);
    gates[0].resolve();
    await flush();
    expect(order).toEqual([0, 1, 2]);
    gates[1].resolve();
    await flush();
    expect(order).toEqual([0, 1, 2, 3]);
    gates[2].resolve(); gates[3].resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    const m = b.metrics();
    expect(m).toMatchObject({ inFlight: 0, queued: 0, completed: 4, failed: 0, peakInFlight: 2, peakQueued: 2, accepted: 4 });
  });

  it("SATURATION: rejects immediately with queue_full when slots and queue are full, and never runs the rejected fn", async () => {
    const { clock } = fakeClock();
    const b = createBulkhead("twilio:sms", { maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 1000 }, { clock });
    const hold = deferred();
    let ran = 0;
    const first = b.run(async () => { ran++; await hold.promise; });
    const second = b.run(async () => { ran++; });
    const third = b.run(async () => { ran++; });
    await expect(third).rejects.toMatchObject({ name: "BulkheadRejectedError", reason: "queue_full", provider: "twilio:sms" });
    expect(ran).toBe(1);
    hold.resolve();
    await first; await second;
    expect(ran).toBe(2);
    expect(b.metrics().rejectedQueueFull).toBe(1);
  });

  it("maxQueue 0 never queues", async () => {
    const { clock } = fakeClock();
    const b = createBulkhead("p", { maxConcurrent: 1, maxQueue: 0, queueTimeoutMs: 1000 }, { clock });
    const hold = deferred();
    const a = b.run(() => hold.promise);
    await expect(b.run(async () => 1)).rejects.toBeInstanceOf(BulkheadRejectedError);
    hold.resolve(); await a;
  });

  it("SATURATION: a queued call is rejected with queue_timeout after queueTimeoutMs and leaves the queue", async () => {
    const { clock, advance, pending } = fakeClock();
    const b = createBulkhead("p", { maxConcurrent: 1, maxQueue: 5, queueTimeoutMs: 500 }, { clock });
    const hold = deferred();
    const a = b.run(() => hold.promise);
    const waiter = b.run(async () => "late");
    const assertion = expect(waiter).rejects.toMatchObject({ reason: "queue_timeout" });
    advance(499);
    expect(b.metrics().queued).toBe(1);
    advance(1);
    await assertion;
    expect(b.metrics()).toMatchObject({ queued: 0, rejectedQueueTimeout: 1, inFlight: 1 });
    hold.resolve(); await a;
    expect(pending()).toBe(0);
  });

  it("releases the slot when fn throws, counts the failure, and rethrows the original error", async () => {
    const { clock } = fakeClock();
    const b = createBulkhead("p", { maxConcurrent: 1, maxQueue: 0, queueTimeoutMs: 100 }, { clock });
    await expect(b.run(async () => { throw new Error("vendor 500"); })).rejects.toThrow("vendor 500");
    expect(await b.run(async () => "ok")).toBe("ok");
    expect(b.metrics()).toMatchObject({ inFlight: 0, failed: 1, completed: 1 });
  });

  it("hands the slot to the oldest waiter so a new arrival cannot jump the queue", async () => {
    const { clock } = fakeClock();
    const b = createBulkhead("p", { maxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 1000 }, { clock });
    const g1 = deferred(); const order: string[] = [];
    const r1 = b.run(async () => { order.push("a"); await g1.promise; });
    const r2 = b.run(async () => { order.push("b"); });
    g1.resolve();
    const r3 = b.run(async () => { order.push("c"); }); // arrives while the slot is being handed to b
    await Promise.all([r1, r2, r3]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("records queue wait metrics and emits a rejection event without letting a throwing listener break the call path", async () => {
    const { clock, advance } = fakeClock();
    const events: string[] = [];
    const b = createBulkhead("p", { maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 1000 }, { clock, onEvent: (e) => { events.push(e.reason); throw new Error("listener bug"); } });
    const hold = deferred();
    const a = b.run(() => hold.promise);
    const w = b.run(async () => 1);
    advance(300);
    await expect(b.run(async () => 2)).rejects.toMatchObject({ reason: "queue_full" });
    hold.resolve(); await a; await w;
    expect(events).toEqual(["queue_full"]);
    expect(b.metrics().maxQueueWaitMs).toBe(300);
  });

  it("sanitises a bad config instead of deadlocking", async () => {
    const { clock } = fakeClock();
    const b = createBulkhead("p", { maxConcurrent: 0, maxQueue: -1, queueTimeoutMs: Number.NaN }, { clock });
    expect(await b.run(async () => "ran")).toBe("ran");
  });
});

describe("flag, config and registry", () => {
  it("is OFF by default and the guard is undefined (adapters keep their original path)", () => {
    expect(bulkheadEnabled(env({}))).toBe(false);
    expect(bulkheadEnabled(env({ VOICE_BULKHEAD_ENABLED: "1" }))).toBe(false);
    expect(bulkheadGuard("twilio:sms", env({}))).toBeUndefined();
    expect(bulkheadGuard("twilio:sms", env({ VOICE_BULKHEAD_ENABLED: "true" }))).toBeTypeOf("function");
  });
  it("applies per-key, per-field overrides and ignores invalid ones", () => {
    const e = env({ VOICE_BULKHEAD_CONFIG: JSON.stringify({ "twilio:sms": { maxConcurrent: 3, maxQueue: -5, queueTimeoutMs: "x" } }) });
    expect(resolveConfig("twilio:sms", e)).toEqual({ maxConcurrent: 3, maxQueue: 32, queueTimeoutMs: 3000 });
    expect(resolveConfig("twilio:carrier", e)).toEqual({ maxConcurrent: 8, maxQueue: 16, queueTimeoutMs: 2000 });
    expect(resolveConfig("unknown:x", e)).toEqual({ maxConcurrent: 5, maxQueue: 10, queueTimeoutMs: 2000 });
  });
  it("survives malformed JSON and non-object config", () => {
    for (const bad of ["{nope", "null", "[]", "42"]) expect(resolveConfig("twilio:sms", env({ VOICE_BULKHEAD_CONFIG: bad })).maxConcurrent).toBe(8);
  });
  it("isolates providers: saturating one never blocks another", async () => {
    const e = env({ VOICE_BULKHEAD_ENABLED: "true", VOICE_BULKHEAD_CONFIG: JSON.stringify({ "twilio:sms": { maxConcurrent: 1, maxQueue: 0 } }) });
    const sms = bulkheadGuard("twilio:sms", e)!;
    const vapi = bulkheadGuard("vapi:voice_engine", e)!;
    const hold = deferred();
    const busy = sms(() => hold.promise);
    await expect(sms(async () => 1)).rejects.toBeInstanceOf(BulkheadRejectedError);
    expect(await vapi(async () => "vapi still works")).toBe("vapi still works");
    hold.resolve(); await busy;
  });
  it("detects rejections across realms by name", () => {
    const e = new Error("x"); e.name = "BulkheadRejectedError";
    expect(isBulkheadRejection(e)).toBe(true);
    expect(isBulkheadRejection(new Error("x"))).toBe(false);
  });
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("adapter wiring + fallback", () => {
  it("no guard: adapters call the vendor exactly as before", async () => {
    const calls: string[] = [];
    const sms = twilioSms({ accountSid: "AC1", authToken: "t", from: "+15550000000", fetch: async (u) => { calls.push(u); return ok({ sid: "SM1" }); } });
    expect(await sms.send({ to: "+15551112222", body: "hi" })).toEqual({ providerMessageId: "SM1" });
    expect(calls).toHaveLength(1);
  });

  it("FALLBACK: saturated Twilio SMS is skipped without touching the vendor, Telnyx delivers, and the breaker is not fed a failure", async () => {
    const e = env({ VOICE_BULKHEAD_ENABLED: "true", VOICE_BULKHEAD_CONFIG: JSON.stringify({ "twilio:sms": { maxConcurrent: 1, maxQueue: 0 } }) });
    const hold = deferred<Response>();
    let twilioHits = 0, telnyxHits = 0;
    const twilio = twilioSms({ accountSid: "AC1", authToken: "t", from: "+1555", guard: bulkheadGuard("twilio:sms", e), fetch: () => { twilioHits++; return hold.promise; } });
    const telnyx = telnyxSms({ apiKey: "k", from: "+1555", guard: bulkheadGuard("telnyx:sms", e), fetch: async () => { telnyxHits++; return ok({ data: { id: "tx1" } }); } });
    const stuck = twilio.send({ to: "+15551112222", body: "first" }); // occupies the only Twilio slot
    await flush();
    const outcomes: [string, boolean][] = [];
    const r = await sendWithFailover([twilio, telnyx], { to: "+15551112222", body: "alert" }, (id, good) => outcomes.push([id, good]));
    expect(r).toEqual({ ok: true, providerId: "telnyx" });
    expect(twilioHits).toBe(1); // only the stuck one; the rejected send never reached the vendor
    expect(telnyxHits).toBe(1);
    expect(outcomes).toEqual([["telnyx", true]]); // no ["twilio", false]
    hold.resolve(ok({ sid: "SM1" })); await stuck;
  });

  it("when EVERY provider is saturated sendWithFailover returns ok:false with a bulkhead error (never throws)", async () => {
    const e = env({ VOICE_BULKHEAD_ENABLED: "true", VOICE_BULKHEAD_CONFIG: JSON.stringify({ "twilio:sms": { maxConcurrent: 1, maxQueue: 0 }, "telnyx:sms": { maxConcurrent: 1, maxQueue: 0 } }) });
    const h1 = deferred<Response>(), h2 = deferred<Response>();
    const twilio = twilioSms({ accountSid: "AC1", authToken: "t", from: "+1555", guard: bulkheadGuard("twilio:sms", e), fetch: () => h1.promise });
    const telnyx = telnyxSms({ apiKey: "k", from: "+1555", guard: bulkheadGuard("telnyx:sms", e), fetch: () => h2.promise });
    const s1 = twilio.send({ to: "+15551112222", body: "a" }); const s2 = telnyx.send({ to: "+15551112222", body: "b" });
    await flush();
    const r = await sendWithFailover([twilio, telnyx], { to: "+15551112222", body: "c" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bulkhead_saturated:telnyx:sms:queue_full/);
    h1.resolve(ok({})); h2.resolve(ok({})); await s1; await s2;
  });

  it("a real vendor failure is still reported to the breaker (only bulkhead rejections are exempt)", async () => {
    const t = twilioSms({ accountSid: "AC1", authToken: "t", from: "+1555", fetch: async () => new Response("no", { status: 500 }) });
    const outcomes: [string, boolean][] = [];
    const r = await sendWithFailover([t], { to: "+1", body: "x" }, (id, good) => outcomes.push([id, good]));
    expect(r.ok).toBe(false);
    expect(outcomes).toEqual([["twilio", false]]);
  });

  it("twilio placeCall and vapi getCall/listCalls go through the guard; health checks do not", async () => {
    const used: string[] = [];
    const guard = (<T,>(fn: () => Promise<T>) => { used.push("guard"); return fn(); });
    const fetchOk = async (u: string) => ok(u.includes("/Calls.json") && !u.includes("?") ? { sid: "CA1" } : u.includes("/call/") ? { id: "v1" } : []);
    const carrier = twilioCarrier({ accountSid: "AC1", authToken: "t", guard, fetch: fetchOk });
    const engine = vapiEngine({ privateKey: "k", guard, fetch: fetchOk });
    expect(await carrier.placeCall({ to: "+1", from: "+2", twiml: "<Response/>" })).toEqual({ callSid: "CA1" });
    await engine.getCall("v1");
    await engine.listCalls({ since: new Date(0), until: new Date(1), limit: 5 });
    expect(used).toHaveLength(3);
    await carrier.healthCheck(); await engine.healthCheck();
    expect(used).toHaveLength(3);
  });

  it("a saturated placeCall rejects with a typed error and never calls Twilio", async () => {
    const e = env({ VOICE_BULKHEAD_ENABLED: "true", VOICE_BULKHEAD_CONFIG: JSON.stringify({ "twilio:carrier": { maxConcurrent: 1, maxQueue: 0 } }) });
    const hold = deferred<Response>(); let hits = 0;
    const carrier = twilioCarrier({ accountSid: "AC1", authToken: "t", guard: bulkheadGuard("twilio:carrier", e), fetch: () => { hits++; return hold.promise; } });
    const first = carrier.placeCall({ to: "+1", from: "+2", twiml: "<Response/>" });
    await flush();
    await expect(carrier.placeCall({ to: "+1", from: "+2", twiml: "<Response/>" })).rejects.toMatchObject({ name: "BulkheadRejectedError", reason: "queue_full" });
    expect(hits).toBe(1);
    hold.resolve(ok({ sid: "CA1" })); await first;
  });
});
