import { describe, it, expect, vi } from "vitest";
import {
  buildSendBody, eventKey, parseSinchEvents, richChannelFromSinch, SinchClient, sinchConfigFromEnv, signSinchBody,
  toSinchIdentity, toSinchMessage, verifySinchSignature,
} from "./sinch.ts";
import { account } from "./testkit.ts";
import type { RichContent } from "./types.ts";

const SECRET = "whsec_test";
const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

async function signed(body: string, over: { ts?: number; nonce?: string; sig?: string; alg?: string } = {}) {
  const ts = String(over.ts ?? Math.floor(Date.now() / 1000));
  const nonce = over.nonce ?? "n-1";
  return headers({
    "x-sinch-webhook-signature": over.sig ?? (await signSinchBody(SECRET, body, nonce, ts)),
    "x-sinch-webhook-signature-nonce": nonce,
    "x-sinch-webhook-signature-timestamp": ts,
    "x-sinch-webhook-signature-algorithm": over.alg ?? "HmacSHA256",
  });
}

describe("webhook signature", () => {
  const body = '{"app_id":"a"}';

  it("accepts a correctly signed, fresh request", async () => {
    expect(await verifySinchSignature({ rawBody: body, headers: await signed(body), secret: SECRET })).toEqual({ ok: true });
  });

  it("matches the documented scheme: base64(HMAC_SHA256(secret, body.nonce.timestamp))", async () => {
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha256", SECRET).update(`${body}.n-1.1700000000`).digest("base64");
    expect(await signSinchBody(SECRET, body, "n-1", "1700000000")).toBe(expected);
  });

  it.each([
    ["tampered body", async () => verifySinchSignature({ rawBody: body + " ", headers: await signed(body), secret: SECRET }), "bad_signature"],
    ["wrong secret", async () => verifySinchSignature({ rawBody: body, headers: await signed(body), secret: "other" }), "bad_signature"],
    ["bad signature", async () => verifySinchSignature({ rawBody: body, headers: await signed(body, { sig: "AAAA" }), secret: SECRET }), "bad_signature"],
    ["stale timestamp (replay)", async () => verifySinchSignature({ rawBody: body, headers: await signed(body, { ts: 1000 }), secret: SECRET }), "stale_timestamp"],
    ["future timestamp", async () => verifySinchSignature({ rawBody: body, headers: await signed(body, { ts: Math.floor(Date.now() / 1000) + 3600 }), secret: SECRET }), "stale_timestamp"],
    ["missing headers", async () => verifySinchSignature({ rawBody: body, headers: headers({}), secret: SECRET }), "missing_headers"],
    ["unsupported algorithm", async () => verifySinchSignature({ rawBody: body, headers: await signed(body, { alg: "HmacSHA1" }), secret: SECRET }), "unsupported_algorithm"],
    ["secret not configured (fail closed)", async () => verifySinchSignature({ rawBody: body, headers: await signed(body), secret: undefined }), "secret_not_configured"],
  ])("rejects %s", async (_n, run, reason) => {
    expect(await run()).toEqual({ ok: false, reason });
  });
});

describe("outbound mapping", () => {
  const content: RichContent = {
    kind: "card", fallbackText: "x",
    card: {
      title: "Invoice", description: "Due soon", imageUrl: "https://cdn.example.com/logo.png",
      actions: [
        { type: "url", label: "Pay now", value: "https://pay.example.com/1" },
        { type: "call", label: "Call us", value: "+15559998888" },
        { type: "reply", label: "Reschedule", value: "act:reschedule:j1", keyword: "RESCHEDULE" },
      ],
    },
  };

  it("maps a card to card_message with url/call/reply choices", () => {
    expect(toSinchMessage(content)).toEqual({
      card_message: {
        title: "Invoice", description: "Due soon", media_message: { url: "https://cdn.example.com/logo.png" },
        choices: [
          { url_message: { title: "Pay now", url: "https://pay.example.com/1" } },
          { call_message: { title: "Call us", phone_number: "+15559998888" } },
          { text_message: { text: "Reschedule" }, postback_data: "act:reschedule:j1" },
        ],
      },
    });
    expect(toSinchMessage({ kind: "text", text: "hi" })).toEqual({ text_message: { text: "hi" } });
  });

  it("send body targets ONLY the rich channel (SMS fallback is ours, not the aggregator's)", () => {
    const b = buildSendBody({ appId: "app", channel: "rcs", identity: "+15551230001", content: { kind: "text", text: "hi" }, correlationId: "c-1", ttlSeconds: 45 });
    expect(b).toMatchObject({
      app_id: "app", channel_priority_order: ["RCS"], correlation_id: "c-1", ttl: "45s",
      recipient: { identified_by: { channel_identities: [{ channel: "RCS", identity: "15551230001" }] } },
    });
    const amb = buildSendBody({ appId: "app", channel: "amb", identity: "urn:mbid:x", content: { kind: "text", text: "hi" }, correlationId: "c-2" });
    expect(amb).toMatchObject({ channel_priority_order: ["APPLEBC"], recipient: { identified_by: { channel_identities: [{ channel: "APPLEBC", identity: "urn:mbid:x" }] } } });
    expect(amb).not.toHaveProperty("ttl");
  });

  it("channel + identity helpers", () => {
    expect(richChannelFromSinch("rcs")).toBe("rcs");
    expect(richChannelFromSinch("APPLEBC")).toBe("amb");
    expect(richChannelFromSinch("SMS")).toBeNull();
    expect(toSinchIdentity("rcs", "+1 (555) 123-0001")).toBe("15551230001");
    expect(toSinchIdentity("amb", "urn:mbid:x")).toBe("urn:mbid:x");
  });
});

describe("event parsing", () => {
  it("inbound text message", () => {
    const evs = parseSinchEvents({
      app_id: "app-1", accepted_time: "2026-10-07T18:00:00Z",
      message: {
        id: "M1", direction: "TO_APP", conversation_id: "C1", contact_id: "K1", accept_time: "2026-10-07T18:00:01Z",
        channel_identity: { channel: "RCS", identity: "15551230001", app_id: "app-1" },
        contact_message: { text_message: { text: "hello" } },
      },
    });
    expect(evs).toEqual([{
      type: "inbound", appId: "app-1", channel: "rcs", identity: "15551230001", providerMessageId: "M1",
      providerConversationId: "C1", contactId: "K1", text: "hello", postback: null, mediaUrl: null, receivedAt: "2026-10-07T18:00:01Z",
    }]);
  });

  it("button tap and Apple identity", () => {
    const [e] = parseSinchEvents({
      app_id: "app-1",
      message: {
        id: "M2", direction: "TO_APP", channel_identity: { channel: "APPLEBC", identity: "urn:mbid:abc" },
        contact_message: { choice_response_message: { message_id: "M0", postback_data: "act:reschedule:j1" } },
      },
    });
    expect(e).toMatchObject({ type: "inbound", channel: "amb", identity: "urn:mbid:abc", postback: "act:reschedule:j1", text: null });
  });

  it("ignores our own outbound echo and unsupported channels", () => {
    expect(parseSinchEvents({ app_id: "a", message: { id: "x", direction: "TO_CONTACT", channel_identity: { channel: "RCS", identity: "1" } } })).toEqual([]);
    expect(parseSinchEvents({ app_id: "a", message: { id: "x", direction: "TO_APP", channel_identity: { channel: "SMS", identity: "1" } } })).toEqual([]);
  });

  it("delivery receipts: delivered / read / failed with reason, pending otherwise", () => {
    const mk = (status: string, reason?: object) => parseSinchEvents({
      app_id: "app-1", correlation_id: "corr-1",
      message_delivery_report: { message_id: "M1", status, channel_identity: { channel: "RCS", identity: "15551230001" }, ...(reason ? { reason } : {}) },
    })[0];
    expect(mk("DELIVERED")).toMatchObject({ type: "delivery", status: "delivered", correlationId: "corr-1", providerMessageId: "M1", channel: "rcs" });
    expect(mk("READ")).toMatchObject({ status: "read" });
    expect(mk("FAILED", { code: "RECIPIENT_NOT_REACHABLE", description: "no rcs" })).toMatchObject({ status: "failed", reasonCode: "RECIPIENT_NOT_REACHABLE", reasonText: "no rcs" });
    expect(mk("QUEUED_ON_CHANNEL")).toMatchObject({ status: "pending" });
  });

  it("capability notification", () => {
    const mk = (s: string) => parseSinchEvents({ app_id: "app-1", capability_notification: { channel: "RCS", identity: "15551230001", capability_status: s } })[0];
    expect(mk("CAPABILITY_FULL")).toMatchObject({ type: "capability", status: "capable" });
    expect(mk("CAPABILITY_PARTIAL")).toMatchObject({ status: "capable" });
    expect(mk("NO_CAPABILITY")).toMatchObject({ status: "not_capable" });
    expect(mk("CAPABILITY_UNKNOWN")).toMatchObject({ status: "unknown" });
  });

  it("opt-out and Apple conversation-deleted", () => {
    expect(parseSinchEvents({ app_id: "a", opt_out_notification: { channel: "RCS", identity: "15551230001" } })[0]).toMatchObject({ type: "opt_out", channel: "rcs" });
    expect(parseSinchEvents({
      app_id: "a", event: { contact_event: { conversation_deleted_event: {} }, channel_identity: { channel: "APPLEBC", identity: "urn:mbid:abc" } },
    })[0]).toMatchObject({ type: "conversation_deleted", channel: "amb", identity: "urn:mbid:abc" });
  });

  it("never throws on junk", () => {
    for (const junk of [null, undefined, 5, "x", [], {}, { message: 5 }, { message_delivery_report: [] }]) {
      expect(parseSinchEvents(junk)).toEqual([]);
    }
  });

  it("event keys are stable per logical event", () => {
    const [e] = parseSinchEvents({ app_id: "a", correlation_id: "c", message_delivery_report: { message_id: "M1", status: "READ", channel_identity: { channel: "RCS", identity: "1" } } });
    expect(eventKey(e)).toBe("dr:M1:read");
  });
});

describe("SinchClient", () => {
  const cfg = { projectId: "proj", keyId: "kid", keySecret: "ksecret" };
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("authenticates with client credentials, caches the token, and sends to the regional endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return url.includes("oauth2") ? res(200, { access_token: "tok", expires_in: 3600 }) : res(200, { message_id: "M99" });
    });
    const client = new SinchClient({ ...cfg, fetchImpl: fetchImpl as unknown as typeof fetch });
    const req = { account: account({ providerRegion: "eu" }), channel: "rcs" as const, identity: "+15551230001", content: { kind: "text", text: "hi" } as RichContent, correlationId: "c1" };

    expect(await client.send(req)).toEqual({ ok: true, providerMessageId: "M99" });
    await client.send(req);

    const tokenCalls = calls.filter((c) => c.url.includes("oauth2"));
    expect(tokenCalls).toHaveLength(1);
    expect((tokenCalls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("kid:ksecret")}`);
    const send = calls.find((c) => c.url.includes("messages:send"))!;
    expect(send.url).toBe("https://eu.conversation.api.sinch.com/v1/projects/proj/messages:send");
    expect((send.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(send.init.body as string)).toMatchObject({ app_id: "app-1", correlation_id: "c1" });
  });

  it("refreshes the token once on 401", async () => {
    let tokens = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("oauth2")) return res(200, { access_token: `tok${++tokens}`, expires_in: 3600 });
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === "Bearer tok1" ? res(401, { error: { message: "expired" } }) : res(200, { message_id: "M1" });
    });
    const client = new SinchClient({ ...cfg, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.send({ account: account(), channel: "rcs", identity: "+1", content: { kind: "text", text: "x" }, correlationId: "c" })).toEqual({ ok: true, providerMessageId: "M1" });
    expect(tokens).toBe(2);
  });

  it("classifies errors: 5xx/429 retryable, 4xx not, network errors retryable, missing app not sent", async () => {
    const mk = (status: number) => new SinchClient({
      ...cfg,
      fetchImpl: (async (url: string) => (url.includes("oauth2") ? res(200, { access_token: "t", expires_in: 3600 }) : res(status, { error: { message: "nope", status: "X" } }))) as unknown as typeof fetch,
    });
    const r = { account: account(), channel: "rcs" as const, identity: "+1", content: { kind: "text", text: "x" } as RichContent, correlationId: "c" };
    expect(await mk(503).send(r)).toMatchObject({ ok: false, retryable: true });
    expect(await mk(429).send(r)).toMatchObject({ ok: false, retryable: true });
    expect(await mk(400).send(r)).toMatchObject({ ok: false, retryable: false, error: "nope" });
    const net = new SinchClient({ ...cfg, fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch });
    expect(await net.send(r)).toMatchObject({ ok: false, retryable: true, code: "NETWORK" });
    const fetchSpy = vi.fn();
    const none = new SinchClient({ ...cfg, fetchImpl: fetchSpy as unknown as typeof fetch });
    expect(await none.send({ ...r, account: account({ providerAppId: null }) })).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("capability query posts to capability:query and reports acceptance", async () => {
    let body: Record<string, unknown> = {};
    const client = new SinchClient({
      ...cfg,
      fetchImpl: (async (url: string, init: RequestInit) => {
        if (url.includes("oauth2")) return res(200, { access_token: "t", expires_in: 3600 });
        expect(url).toContain("/capability:query");
        body = JSON.parse(init.body as string);
        return res(200, {});
      }) as unknown as typeof fetch,
    });
    expect(await client.queryCapability(account(), "rcs", "+15551230001")).toBe(true);
    expect(body).toMatchObject({ app_id: "app-1", recipient: { identified_by: { channel_identities: [{ channel: "RCS", identity: "15551230001" }] } } });
  });

  it("reads credentials from env, returns null when incomplete", () => {
    expect(sinchConfigFromEnv((k) => ({ SINCH_PROJECT_ID: "p", SINCH_KEY_ID: "k", SINCH_KEY_SECRET: "s" } as Record<string, string>)[k])).toEqual({ projectId: "p", keyId: "k", keySecret: "s" });
    expect(sinchConfigFromEnv(() => undefined)).toBeNull();
  });
});
