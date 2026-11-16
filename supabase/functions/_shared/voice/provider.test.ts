import { describe, expect, it } from "vitest";
import { VapiProvider, isVapiProviderFailure } from "./vapiProvider.ts";
import { MockProvider, NullProvider } from "./mockProvider.ts";
import { LiveKitProvider } from "./livekitProvider.ts";
import { resolveVoiceProvider } from "./registry.ts";
import { VapiEngine } from "../voice-engine/vapiEngine.ts";
import type { VoiceEvent } from "./provider.ts";

const CTX = { tenantId: "11111111-1111-1111-1111-111111111111", correlationId: "corr-1" };
const J = (o: unknown) => JSON.stringify(o);

interface Seen { url: string; init?: RequestInit }
function fakeFetch(handler: (u: string, i?: RequestInit) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const f = async (u: string, i?: RequestInit) => { seen.push({ url: u, init: i }); return handler(u, i); };
  return { f, seen };
}
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const eoc = (extra: Record<string, unknown> = {}) =>
  J({ message: { type: "end-of-call-report", endedReason: "customer-ended-call", durationSeconds: 42, call: { id: "call_1" }, artifact: { transcript: "hi", recordingUrl: "https://r/x.mp3" }, analysis: { summary: "s" }, ...extra } });

describe("VapiProvider.parseWebhook", () => {
  const p = new VapiProvider({ apiKey: "k", webhookSecret: "s" });

  it("maps end-of-call-report to call.ended with a stable dedupeKey (redelivery => same key)", () => {
    const a = p.parseWebhook(eoc());
    const b = p.parseWebhook(eoc());
    expect(a.ok).toBe(true);
    if (!a.ok || !b.ok || a.event.type !== "call.ended" || b.event.type !== "call.ended") throw new Error("shape");
    expect(a.event.dedupeKey).toBe("call_1:ended");
    expect(a.event.dedupeKey).toBe(b.event.dedupeKey);
    expect(a.event.durationSeconds).toBe(42);
    expect(a.event.transcript).toBe("hi");
    expect(a.event.providerFailure).toBe(false);
  });

  it("flags provider-side failures (pipeline errors) but not a normal hang-up", () => {
    expect(isVapiProviderFailure("pipeline-error-openai-llm-failed")).toBe(true);
    expect(isVapiProviderFailure("assistant-error")).toBe(true);
    expect(isVapiProviderFailure("customer-ended-call")).toBe(false);
    expect(isVapiProviderFailure(null)).toBe(false);
    const r = p.parseWebhook(eoc({ endedReason: "pipeline-error-eleven-labs-failed" }));
    if (!r.ok || r.event.type !== "call.ended") throw new Error("shape");
    expect(r.event.providerFailure).toBe(true);
  });

  it("maps status-update in-progress to call.started; status ended has a DIFFERENT key than the report (thin event must not shadow the rich one)", () => {
    const s = p.parseWebhook(J({ message: { type: "status-update", status: "in-progress", call: { id: "call_2", type: "inboundPhoneCall" } } }));
    if (!s.ok || s.event.type !== "call.started") throw new Error("shape");
    expect(s.event.direction).toBe("inbound");
    const e = p.parseWebhook(J({ message: { type: "status-update", status: "ended", endedReason: "customer-ended-call", call: { id: "call_2" } } }));
    if (!e.ok || e.event.type !== "call.ended") throw new Error("shape");
    expect(e.event.dedupeKey).toBe("call_2:status:ended");
    expect(e.event.dedupeKey === "call_2:ended").toBe(false);
  });

  it("parses tool-calls (JSON-string and object arguments, both list field names)", () => {
    const r = p.parseWebhook(J({ message: { type: "tool-calls", call: { id: "c3" }, toolCallList: [
      { id: "t1", function: { name: "book_appointment", arguments: '{"slot":"9am"}' } },
      { toolCallId: "t2", function: { name: "check_availability", arguments: { day: "mon" } } },
      { id: "t3", function: { name: "x", arguments: "not json" } },
    ] } }));
    if (!r.ok || r.event.type !== "call.tool_call") throw new Error("shape");
    expect(r.event.toolCalls.map((t) => t.name)).toEqual(["book_appointment", "check_availability", "x"]);
    expect(r.event.toolCalls[0].args).toEqual({ slot: "9am" });
    expect(r.event.toolCalls[1].args).toEqual({ day: "mon" });
    expect(r.event.toolCalls[2].args).toEqual({});
    expect(r.event.dedupeKey).toBe("c3:tools:t1,t2,t3");
  });

  it("maps transcript, ignores unmodelled types, and rejects bad bodies without throwing", () => {
    const t = p.parseWebhook(J({ message: { type: "transcript", role: "user", transcriptType: "final", transcript: "hello", call: { id: "c4" } } }));
    if (!t.ok || t.event.type !== "call.transcript") throw new Error("shape");
    expect(t.event.final).toBe(true);
    expect(t.event.role).toBe("user");
    const ig = p.parseWebhook(J({ message: { type: "speech-update", call: { id: "c4" } } }));
    expect(ig.ok && ig.event.type).toBe("ignored");
    const bad = p.parseWebhook("{nope");
    expect(bad.ok).toBe(false);
    const big = p.parseWebhook("x".repeat(2_000_001));
    expect(!big.ok && big.status).toBe(413);
  });
});

describe("VapiProvider.verifyWebhookSignature (fail closed)", () => {
  it("rejects when no secret is configured, header missing/empty/wrong; accepts exact match", () => {
    expect(new VapiProvider({ apiKey: "k", webhookSecret: null }).verifyWebhookSignature({ headers: { "x-vapi-secret": "anything" } })).toBe(false);
    const p = new VapiProvider({ apiKey: "k", webhookSecret: "s3cret" });
    expect(p.verifyWebhookSignature({ headers: {} })).toBe(false);
    expect(p.verifyWebhookSignature({ headers: { "x-vapi-secret": "" } })).toBe(false);
    expect(p.verifyWebhookSignature({ headers: { "x-vapi-secret": "wrong!" } })).toBe(false);
    expect(p.verifyWebhookSignature({ headers: { "x-vapi-secret": "s3cret" } })).toBe(true);
  });
});

describe("VapiProvider operations", () => {
  it("startOutboundCall sends a request byte-identical to the existing VapiEngine (zero-regression check)", async () => {
    const input = { assistantId: "a1", phoneNumberId: "pn1", customerNumber: "+15551234567", variableValues: { b: "2", a: "1" } };
    const viaEngine = fakeFetch(() => jsonRes({ id: "call_x" }));
    await new VapiEngine({ apiKey: "k", fetchImpl: viaEngine.f }).startCall({ ownerId: CTX.tenantId, ...input });
    const viaProvider = fakeFetch(() => jsonRes({ id: "call_x" }));
    const r = await new VapiProvider({ apiKey: "k", webhookSecret: "s", fetchImpl: viaProvider.f }).startOutboundCall(CTX, input);
    expect(r.ok && r.value.callId).toBe("call_x");
    expect(viaProvider.seen[0].url).toBe(viaEngine.seen[0].url);
    expect(viaProvider.seen[0].init?.body).toBe(viaEngine.seen[0].init?.body);
    expect(J(viaProvider.seen[0].init?.headers)).toBe(J(viaEngine.seen[0].init?.headers));
  });

  it("classifies failures: 5xx retryable, 401 not, thrown timeout retryable, missing key never calls the network", async () => {
    const e5 = fakeFetch(() => new Response("boom", { status: 503 }));
    const r5 = await new VapiProvider({ apiKey: "k", webhookSecret: "s", fetchImpl: e5.f }).startOutboundCall(CTX, { assistantId: "a", phoneNumberId: "p", customerNumber: "+1", variableValues: {} });
    expect(!r5.ok && r5.error.kind).toBe("provider_5xx");
    expect(!r5.ok && r5.error.retryable).toBe(true);
    expect(!r5.ok && r5.error.message.includes("boom")).toBe(false); // body never leaks into the message

    const e401 = fakeFetch(() => new Response("no", { status: 401 }));
    const r401 = await new VapiProvider({ apiKey: "k", webhookSecret: "s", fetchImpl: e401.f }).fetchCall(CTX, "c");
    expect(!r401.ok && r401.error.kind).toBe("auth");
    expect(!r401.ok && r401.error.retryable).toBe(false);

    const to = fakeFetch(() => { const e = new Error("t"); e.name = "TimeoutError"; throw e; });
    const rt = await new VapiProvider({ apiKey: "k", webhookSecret: "s", fetchImpl: to.f }).fetchCall(CTX, "c");
    expect(!rt.ok && rt.error.kind).toBe("timeout");

    const none = fakeFetch(() => jsonRes({}));
    const rn = await new VapiProvider({ apiKey: null, webhookSecret: "s", fetchImpl: none.f }).fetchCall(CTX, "c");
    expect(!rn.ok && rn.error.kind).toBe("not_configured");
    expect(none.seen.length).toBe(0);
  });

  it("fetchCall maps 404, snapshot and listPhoneNumbers", async () => {
    const nf = fakeFetch(() => new Response("", { status: 404 }));
    const r = await new VapiProvider({ apiKey: "k", webhookSecret: "s", fetchImpl: nf.f }).fetchCall(CTX, "gone");
    expect(!r.ok && r.error.kind).toBe("not_found");

    const ok = fakeFetch((u) => u.endsWith("/phone-number")
      ? jsonRes([{ id: "pn1", number: "+15550001111", assistantId: "a1" }, { number: "no id" }])
      : jsonRes({ id: "c1", status: "ended", endedReason: "customer-ended-call", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:00Z", artifact: { transcript: "t" } }));
    const p = new VapiProvider({ apiKey: "k", webhookSecret: "s", fetchImpl: ok.f });
    const c = await p.fetchCall(CTX, "c1");
    expect(c.ok && c.value.status).toBe("ended");
    expect(c.ok && c.value.durationSeconds).toBe(60);
    const n = await p.listPhoneNumbers(CTX);
    expect(n.ok && n.value.length).toBe(1);
    expect(n.ok && n.value[0].id).toBe("pn1");
  });

  it("endCall only POSTs to a *.vapi.ai https control URL", async () => {
    const good = fakeFetch((u) => u.includes("/call/") ? jsonRes({ monitor: { controlUrl: "https://aws-us-west-2-production1-phone-call-websocket.vapi.ai/x/control" } }) : new Response("", { status: 200 }));
    const okR = await new VapiProvider({ apiKey: "k", webhookSecret: "s", fetchImpl: good.f }).endCall(CTX, "c1");
    expect(okR.ok).toBe(true);
    expect(good.seen[1].init?.body).toBe(J({ type: "end-call" }));

    const evil = fakeFetch(() => jsonRes({ monitor: { controlUrl: "https://evil.example.com/control" } }));
    const bad = await new VapiProvider({ apiKey: "k", webhookSecret: "s", fetchImpl: evil.f }).endCall(CTX, "c1");
    expect(!bad.ok && bad.error.kind).toBe("invalid_payload");
    expect(evil.seen.length).toBe(1); // never POSTed to the evil host
  });
});

describe("Null / Mock / LiveKit stub / registry", () => {
  it("stubs are never ready and fail closed", async () => {
    for (const p of [new NullProvider(), new LiveKitProvider()]) {
      expect(p.isReady()).toBe(false);
      expect(p.verifyWebhookSignature({ headers: { "x-vapi-secret": "x" } })).toBe(false);
      const r = await p.startOutboundCall(CTX, { assistantId: "a", phoneNumberId: "p", customerNumber: "+1", variableValues: {} });
      expect(!r.ok && r.error.kind).toBe("unsupported");
    }
  });

  it("registry never returns a stub and defaults to Vapi", () => {
    const vapi = new VapiProvider({ apiKey: "k", webhookSecret: "s" });
    const lk = new LiveKitProvider();
    expect(resolveVoiceProvider({ vapi, livekit: lk }, "livekit").provider.id).toBe("vapi");
    expect(resolveVoiceProvider({ vapi, livekit: lk }, "livekit").reason).toBe("requested_not_ready");
    expect(resolveVoiceProvider({ vapi }, undefined).reason).toBe("default_vapi");
    expect(resolveVoiceProvider({ vapi: new VapiProvider({ apiKey: null, webhookSecret: "s" }) }, null).provider.id).toBe("null");
  });

  it("MockProvider records calls and injects faults per operation", async () => {
    const m = new MockProvider();
    expect((await m.startOutboundCall(CTX, { assistantId: "a", phoneNumberId: "p", customerNumber: "+1", variableValues: {} })).ok).toBe(true);
    m.injectFault("5xx", ["startOutboundCall"]);
    const bad = await m.startOutboundCall(CTX, { assistantId: "a", phoneNumberId: "p", customerNumber: "+1", variableValues: {} });
    expect(!bad.ok && bad.error.retryable).toBe(true);
    expect((await m.fetchCall(CTX, "c")).ok).toBe(true); // fault scoped to one op
    expect(m.calls.length).toBe(3);
    const ev = m.parseWebhook(eoc());
    expect(ev.ok && ev.event.type === "call.ended" && (ev.event as VoiceEvent).provider).toBe("mock");
  });
});
