import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  buildPayTwiml, buildResultTwiml, parsePayCallback, pauseCallRecordings, resumeCallRecordings, twilioSignature, validateTwilioSignature, xmlEscape,
} from "./twilio";

const SID = "CA" + "c".repeat(32);

describe("X-Twilio-Signature", () => {
  it("matches Twilio's algorithm (HMAC-SHA1 over url + sorted params, base64)", async () => {
    const url = "https://x.supabase.co/functions/v1/phone-payment-webhook?sid=1&t=2";
    const params = { Result: "success", CallSid: SID, A: "1" };
    const expected = createHmac("sha1", "tok").update(url + "A1" + `CallSid${SID}` + "Resultsuccess").digest("base64");
    expect(await twilioSignature("tok", url, params)).toBe(expected);
    expect(await validateTwilioSignature("tok", url, params, expected)).toBe(true);
    expect(await validateTwilioSignature("tok", url, { ...params, A: "2" }, expected)).toBe(false);
    expect(await validateTwilioSignature("tok", url, params, null)).toBe(false);
    expect(await validateTwilioSignature("", url, params, expected)).toBe(false);
  });
});

describe("parsePayCallback allowlist", () => {
  it("reads token + masked metadata only", () => {
    const cb = parsePayCallback({ CallSid: SID, Result: "success", PaymentToken: "tok_1Abc23DefGhi456Jkl", PaymentCardType: "Visa", PaymentCardNumber: "************1111", ExpirationDate: "1228", SecurityCode: "123", PostalCode: "94107" });
    expect(cb).toMatchObject({ callSid: SID, result: "success", token: "tok_1Abc23DefGhi456Jkl", cardBrand: "visa", cardLast4: "1111", ignoredParams: 3 });
    expect(JSON.stringify(cb)).not.toMatch(/1228|123\b|94107/);
  });
  it("drops an unmasked card number, junk tokens and unknown results", () => {
    const cb = parsePayCallback({ Result: "weird", PaymentToken: "4111111111111111", PaymentCardNumber: "4111111111111111", PaymentCardType: "<script>", CallSid: "nope" });
    expect(cb).toMatchObject({ result: "unknown", token: null, cardLast4: null, cardBrand: null, callSid: null });
  });
  it("scrubs card numbers out of provider error text", () => {
    expect(parsePayCallback({ PaymentError: "declined 4111 1111 1111 1111" }).providerError).not.toContain("4111");
  });
});

describe("TwiML", () => {
  it("tokenizes only (chargeAmount 0) over DTMF and escapes URLs", () => {
    const x = buildPayTwiml({ connector: "Vireek_Stripe", actionUrl: "https://a.test/f?sid=1&t=2", statusCallbackUrl: "https://a.test/f?sid=1&step=status" });
    expect(x).toContain('chargeAmount="0"');
    expect(x).toContain('input="dtmf"');
    expect(x).toContain('tokenType="one-time"');
    expect(x).toContain("sid=1&amp;t=2");
    expect(x).not.toMatch(/\d{13}/);
  });
  it("only dials back a valid E.164 number", () => {
    expect(buildResultTwiml("approved", { returnToNumber: "+15551239999" })).toContain("<Dial>+15551239999</Dial>");
    expect(buildResultTwiml("approved", { returnToNumber: "555; drop table" })).toContain("<Hangup/>");
    expect(xmlEscape(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });
});

// ---- REST (fake fetch) ----
function fakeFetch(script: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: String(init.body ?? "") });
    const step = script.shift();
    if (!step) throw new Error("unexpected request");
    return { ok: step.ok ?? true, status: step.status ?? 200, json: async () => step.body } as Response;
  }) as typeof fetch;
  return { f, calls };
}
const cfg = (f: typeof fetch) => ({ accountSid: "ACtest", authToken: "t", fetchImpl: f });

describe("pauseCallRecordings (fail closed)", () => {
  it("pauses in-progress recordings with PauseBehavior=skip and verifies", async () => {
    const { f, calls } = fakeFetch([
      { body: { recordings: [{ sid: "RE1", status: "in-progress" }] } },
      { body: { status: "paused" } },
      { body: { recordings: [{ sid: "RE1", status: "paused" }] } },
    ]);
    expect(await pauseCallRecordings(cfg(f), SID)).toEqual({ paused: 1 });
    expect(calls[1].body).toContain("Status=paused");
    expect(calls[1].body).toContain("PauseBehavior=skip");
  });
  it("returns 0 when nothing is recording on Twilio", async () => {
    const { f } = fakeFetch([{ body: { recordings: [] } }, { body: { recordings: [] } }]);
    expect(await pauseCallRecordings(cfg(f), SID)).toEqual({ paused: 0 });
  });
  it("throws when Twilio refuses, or a recording is still running afterwards", async () => {
    await expect(pauseCallRecordings(cfg(fakeFetch([{ ok: false, status: 500, body: {} }]).f), SID)).rejects.toThrow();
    const still = fakeFetch([
      { body: { recordings: [{ sid: "RE1", status: "in-progress" }] } }, { body: { status: "paused" } },
      { body: { recordings: [{ sid: "RE1", status: "in-progress" }] } },
    ]);
    await expect(pauseCallRecordings(cfg(still.f), SID)).rejects.toThrow(/still in progress/);
    const noConfirm = fakeFetch([{ body: { recordings: [{ sid: "RE1", status: "in-progress" }] } }, { body: { status: "in-progress" } }]);
    await expect(pauseCallRecordings(cfg(noConfirm.f), SID)).rejects.toThrow(/did not confirm/);
    await expect(pauseCallRecordings(cfg(fakeFetch([]).f), "not-a-sid")).rejects.toThrow();
  });
  it("resumes paused recordings", async () => {
    const { f, calls } = fakeFetch([{ body: { recordings: [{ sid: "RE1", status: "paused" }] } }, { body: { status: "in-progress" } }]);
    expect(await resumeCallRecordings(cfg(f), SID)).toEqual({ resumed: 1 });
    expect(calls[1].body).toContain("Status=in-progress");
  });
});
