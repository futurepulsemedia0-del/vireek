import { describe, expect, it } from "vitest";
import { selectProvider, type SelectInput } from "./providers.ts";
import { sendWithFailover, telnyxSms, twilioSms, mapVapiCall, vapiEngine } from "./adapters.ts";

const base: SelectInput = {
  capability: "sms", callKey: "c1", now: 1000,
  providers: [
    { id: "twilio", capability: "sms", priority: 10, enabled: true },
    { id: "telnyx", capability: "sms", priority: 20, enabled: true },
    { id: "vapi", capability: "voice_engine", priority: 10, enabled: true },
  ],
  health: [],
};

describe("selectProvider", () => {
  it("uses the healthy primary", () => expect(selectProvider(base)).toMatchObject({ providerId: "twilio", reason: "healthy_primary", fallbacks: ["telnyx"] }));
  it("fails over when the primary breaker is open", () => {
    const r = selectProvider({ ...base, health: [{ providerId: "twilio", capability: "sms", state: "open", score: 0 }] });
    expect(r).toMatchObject({ providerId: "telnyx", reason: "failover" });
  });
  it("returns to the primary only via a canary slice while half-open", () => {
    const hs = [{ providerId: "twilio", capability: "sms" as const, state: "half_open" as const, score: 30 }];
    const picks = Array.from({ length: 500 }, (_, i) => selectProvider({ ...base, callKey: `k${i}`, health: hs, canaryPercent: 10 }));
    const canary = picks.filter((p) => p.providerId === "twilio");
    expect(canary.length).toBeGreaterThan(20); expect(canary.length).toBeLessThan(90);
    expect(canary.every((p) => p.reason === "canary_switch_back" && p.usedCanary)).toBe(true);
    expect(picks.filter((p) => p.providerId === "telnyx").every((p) => p.reason === "failover")).toBe(true);
  });
  it("last resort tries the first provider when everything is open (never 'no provider')", () => {
    const hs = ["twilio", "telnyx"].map((id) => ({ providerId: id, capability: "sms" as const, state: "open" as const, score: 0 }));
    expect(selectProvider({ ...base, health: hs }).providerId).toBe("twilio");
  });
  it("ignores disabled providers", () => {
    const r = selectProvider({ ...base, providers: base.providers.map((p) => (p.id === "twilio" ? { ...p, enabled: false } : p)) });
    expect(r.providerId).toBe("telnyx");
  });
  it("org pin wins even over an open breaker; block is respected", () => {
    const open = [{ providerId: "telnyx", capability: "sms" as const, state: "open" as const, score: 0 }];
    expect(selectProvider({ ...base, health: open, orgOverrides: [{ capability: "sms", mode: "pin", providerId: "telnyx" }] })).toMatchObject({ providerId: "telnyx", reason: "org_pin" });
    expect(selectProvider({ ...base, orgOverrides: [{ capability: "sms", mode: "block", providerId: "twilio" }] }).providerId).toBe("telnyx");
    expect(selectProvider({ ...base, orgOverrides: [{ capability: "sms", mode: "prefer", providerId: "telnyx" }] }).providerId).toBe("telnyx");
  });
  it("platform switch applies until it expires", () => {
    const sw = { capability: "sms" as const, forceProviderId: "telnyx", until: 5000 };
    expect(selectProvider({ ...base, platformSwitch: sw }).reason).toBe("platform_switch");
    expect(selectProvider({ ...base, now: 6000, platformSwitch: sw }).reason).toBe("healthy_primary");
  });
  it("a pin to a provider that is not registered is ignored", () => {
    expect(selectProvider({ ...base, orgOverrides: [{ capability: "sms", mode: "pin", providerId: "nope" }] }).providerId).toBe("twilio");
  });
  it("no providers for a capability -> none_available", () => expect(selectProvider({ ...base, capability: "tts" }).reason).toBe("none_available"));
});

const okRes = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
describe("adapters (fake fetch; NOT live-verified)", () => {
  it("twilioSms builds a form POST with basic auth", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const p = twilioSms({ accountSid: "AC1", authToken: "t", from: "+1555", fetch: async (url, init) => { seen = { url, init }; return okRes({ sid: "SM1" }); } });
    expect(await p.send({ to: "+1666", body: "hi" })).toEqual({ providerMessageId: "SM1" });
    expect(seen!.url).toContain("/Accounts/AC1/Messages.json");
    expect(String(seen!.init!.body)).toContain("Body=hi");
  });
  it("telnyxSms builds a JSON POST with bearer auth", async () => {
    let body = "";
    const p = telnyxSms({ apiKey: "k", from: "+1555", messagingProfileId: "mp", fetch: async (_u, init) => { body = String(init!.body); expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer k"); return okRes({ data: { id: "m1" } }); } });
    expect((await p.send({ to: "+1666", body: "hi" })).providerMessageId).toBe("m1");
    expect(JSON.parse(body)).toMatchObject({ to: "+1666", text: "hi", messaging_profile_id: "mp" });
  });
  it("sendWithFailover falls through to the secondary and reports outcomes", async () => {
    const bad = twilioSms({ accountSid: "A", authToken: "t", from: "+1", fetch: async () => new Response("no", { status: 503 }) });
    const good = telnyxSms({ apiKey: "k", from: "+1", fetch: async () => okRes({ data: { id: "x" } }) });
    const log: string[] = [];
    const r = await sendWithFailover([bad, good], { to: "+1", body: "b" }, (id, ok) => log.push(`${id}:${ok}`));
    expect(r).toEqual({ ok: true, providerId: "telnyx" }); expect(log).toEqual(["twilio:false", "telnyx:true"]);
  });
  it("sendWithFailover reports failure when every provider fails", async () => {
    const bad = twilioSms({ accountSid: "A", authToken: "t", from: "+1", fetch: async () => { throw new Error("down"); } });
    expect((await sendWithFailover([bad], { to: "+1", body: "b" })).ok).toBe(false);
    expect((await sendWithFailover([], { to: "+1", body: "b" })).ok).toBe(false);
  });
  it("mapVapiCall keeps only inbound phone calls and computes duration", () => {
    expect(mapVapiCall({ id: "v1", type: "inboundPhoneCall", status: "ended", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:30Z", customer: { number: "+1" }, phoneNumber: { number: "+2" } })).toMatchObject({ providerCallId: "v1", durationSeconds: 90, status: "ended", to: "+2" });
    expect(mapVapiCall({ id: "v2", type: "outboundPhoneCall" })).toBeNull();
    expect(mapVapiCall({})).toBeNull();
  });
  it("vapiEngine.listCalls surfaces HTTP failures instead of returning an empty (false-clean) list", async () => {
    const e = vapiEngine({ privateKey: "k", fetch: async () => new Response("x", { status: 500 }) });
    await expect(e.listCalls({ since: new Date(0), until: new Date(), limit: 10 })).rejects.toThrow(/500/);
  });
});
