import { describe, it, expect } from "vitest";
import {
  classifyDmKeyword, classifyMessengerError, classifyTelegramError, isFacebookPageId, isPageAccessToken,
  isTelegramToken, MESSENGER_MAX_CHARS, messengerWindowOpen, parseMessengerEvents, parseTelegramUpdate,
  safeEqual, TELEGRAM_MAX_CHARS, toHex, validateOutbound, verifyMetaSignature,
} from "./protocol.ts";

const NOW = Date.parse("2026-10-27T12:00:00Z");

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `sha256=${toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))}`;
}

describe("parseTelegramUpdate", () => {
  const base = { message_id: 7, date: NOW / 1000 - 5, chat: { id: 555, type: "private" }, from: { id: 555, first_name: "Ada", last_name: "Lovelace" }, text: "  Hi there  " };

  it("stores a private text message with name, chat id and trimmed body", () => {
    expect(parseTelegramUpdate({ update_id: 1, message: base }, "999", NOW)).toEqual({
      channel: "telegram", externalAccountId: "999", customerId: "555", customerName: "Ada Lovelace",
      providerMessageId: "7", text: "Hi there", sentAt: new Date(NOW - 5000).toISOString(),
    });
  });
  it("falls back to @username, then null, for the name", () => {
    expect(parseTelegramUpdate({ message: { ...base, from: { username: "ada" } } }, "9", NOW)?.customerName).toBe("@ada");
    expect(parseTelegramUpdate({ message: { ...base, from: {} } }, "9", NOW)?.customerName).toBeNull();
  });
  it("labels media instead of dropping it, and prefers captions", () => {
    expect(parseTelegramUpdate({ message: { ...base, text: undefined, photo: [{}] } }, "9", NOW)?.text).toBe("[Photo]");
    expect(parseTelegramUpdate({ message: { ...base, text: undefined, document: { file_name: "quote.pdf" } } }, "9", NOW)?.text).toBe("[File: quote.pdf]");
    expect(parseTelegramUpdate({ message: { ...base, text: undefined, photo: [{}], caption: "leak" } }, "9", NOW)?.text).toBe("leak");
    expect(parseTelegramUpdate({ message: { ...base, text: undefined } }, "9", NOW)?.text).toBe("[Unsupported message]");
  });
  it("ignores groups, bots, edits and malformed updates", () => {
    expect(parseTelegramUpdate({ message: { ...base, chat: { id: -1, type: "group" } } }, "9", NOW)).toBeNull();
    expect(parseTelegramUpdate({ message: { ...base, from: { is_bot: true } } }, "9", NOW)).toBeNull();
    expect(parseTelegramUpdate({ edited_message: base }, "9", NOW)).toBeNull();
    expect(parseTelegramUpdate({ message: { ...base, message_id: undefined } }, "9", NOW)).toBeNull();
    expect(parseTelegramUpdate(null, "9", NOW)).toBeNull();
  });
  it("never reports a timestamp in the future", () => {
    expect(parseTelegramUpdate({ message: { ...base, date: NOW / 1000 + 9999 } }, "9", NOW)?.sentAt).toBe(new Date(NOW).toISOString());
  });
  it("caps very long text at Telegram's limit", () => {
    expect(parseTelegramUpdate({ message: { ...base, text: "x".repeat(9000) } }, "9", NOW)?.text).toHaveLength(TELEGRAM_MAX_CHARS);
  });
});

describe("parseMessengerEvents", () => {
  const event = (over: Record<string, unknown> = {}) => ({
    sender: { id: "psid1" }, recipient: { id: "page1" }, timestamp: NOW - 1000, message: { mid: "m.1", text: "hello" }, ...over,
  });

  it("flattens batched entries and events", () => {
    const out = parseMessengerEvents({
      object: "page",
      entry: [{ id: "page1", messaging: [event(), event({ message: { mid: "m.2", text: "second" } })] }, { id: "page2", messaging: [event({ recipient: { id: "page2" }, message: { mid: "m.3", text: "other page" } })] }],
    }, NOW);
    expect(out.map((m) => [m.externalAccountId, m.providerMessageId, m.text])).toEqual([["page1", "m.1", "hello"], ["page1", "m.2", "second"], ["page2", "m.3", "other page"]]);
    expect(out[0]).toMatchObject({ channel: "messenger", customerId: "psid1", customerName: null, sentAt: new Date(NOW - 1000).toISOString() });
  });
  it("skips echoes, delivery / read / postback events and non-page objects", () => {
    expect(parseMessengerEvents({ object: "page", entry: [{ id: "p", messaging: [event({ message: { mid: "m", text: "x", is_echo: true } }), { sender: { id: "a" }, recipient: { id: "p" }, delivery: { mids: ["m"] } }, { sender: { id: "a" }, recipient: { id: "p" }, postback: { payload: "X" } }] }] }, NOW)).toEqual([]);
    expect(parseMessengerEvents({ object: "instagram", entry: [] }, NOW)).toEqual([]);
    expect(parseMessengerEvents(undefined, NOW)).toEqual([]);
  });
  it("labels attachments without text", () => {
    const one = (attachments: unknown[]) => parseMessengerEvents({ object: "page", entry: [{ id: "p", messaging: [event({ message: { mid: "m", attachments } })] }] }, NOW)[0]?.text;
    expect(one([{ type: "image" }])).toBe("[Photo]");
    expect(one([{ type: "audio" }])).toBe("[Voice message]");
    expect(one([{ type: "fallback" }])).toBe("[Attachment]");
    expect(one([])).toBe("[Unsupported message]");
  });
  it("falls back to entry.id when recipient is missing", () => {
    const [m] = parseMessengerEvents({ object: "page", entry: [{ id: "page9", messaging: [event({ recipient: undefined })] }] }, NOW);
    expect(m.externalAccountId).toBe("page9");
  });
});

describe("verifyMetaSignature / safeEqual", () => {
  it("accepts only the exact HMAC of the raw body", async () => {
    const body = '{"object":"page"}';
    const good = await sign(body, "s3cret");
    expect(await verifyMetaSignature(body, good, "s3cret")).toBe(true);
    expect(await verifyMetaSignature(body + " ", good, "s3cret")).toBe(false);
    expect(await verifyMetaSignature(body, good, "other")).toBe(false);
  });
  it("fails closed on a missing secret, header or prefix", async () => {
    const good = await sign("x", "k");
    expect(await verifyMetaSignature("x", good, undefined)).toBe(false);
    expect(await verifyMetaSignature("x", null, "k")).toBe(false);
    expect(await verifyMetaSignature("x", good.replace("sha256=", "sha1="), "k")).toBe(false);
  });
  it("compares in constant time semantics (length mismatch is false)", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("messengerWindowOpen", () => {
  it("is open for under 24h and closed at 24h, unknown or invalid", () => {
    expect(messengerWindowOpen(new Date(NOW - 23 * 3600_000).toISOString(), NOW)).toBe(true);
    expect(messengerWindowOpen(new Date(NOW - 24 * 3600_000).toISOString(), NOW)).toBe(false);
    expect(messengerWindowOpen(null, NOW)).toBe(false);
    expect(messengerWindowOpen("not a date", NOW)).toBe(false);
  });
});

describe("validateOutbound", () => {
  it("trims, rejects empty and enforces per-channel limits", () => {
    expect(validateOutbound("telegram", "  hi  ")).toEqual({ ok: true, text: "hi" });
    expect(validateOutbound("messenger", "   ")).toMatchObject({ ok: false, code: "empty" });
    expect(validateOutbound("messenger", 42)).toMatchObject({ ok: false, code: "empty" });
    expect(validateOutbound("messenger", "x".repeat(MESSENGER_MAX_CHARS))).toMatchObject({ ok: true });
    expect(validateOutbound("messenger", "x".repeat(MESSENGER_MAX_CHARS + 1))).toMatchObject({ ok: false, code: "too_long" });
    expect(validateOutbound("telegram", "x".repeat(MESSENGER_MAX_CHARS + 1))).toMatchObject({ ok: true });
  });
});

describe("classifyDmKeyword", () => {
  it("handles STOP / START case-, space- and punctuation-insensitively", () => {
    for (const w of ["stop", " STOP. ", "Unsubscribe", "stopall!"]) expect(classifyDmKeyword(w)).toBe("stop");
    for (const w of ["start", "Unstop", "subscribe"]) expect(classifyDmKeyword(w)).toBe("start");
  });
  it("never treats ordinary sentences or CANCEL / END as consent keywords", () => {
    for (const w of ["cancel", "end", "please stop calling", "stop it now", "", null, undefined]) expect(classifyDmKeyword(w as string)).toBeNull();
  });
});

describe("validators and error classification", () => {
  it("validates credential shapes", () => {
    expect(isTelegramToken("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw")).toBe(true);
    expect(isTelegramToken("abc:def")).toBe(false);
    expect(isFacebookPageId("104857341234567")).toBe(true);
    expect(isFacebookPageId("12a")).toBe(false);
    expect(isPageAccessToken("EAAB" + "x".repeat(40))).toBe(true);
    expect(isPageAccessToken("short")).toBe(false);
    expect(isPageAccessToken("EAAB with space " + "x".repeat(20))).toBe(false);
  });
  it("maps provider errors to actionable codes", () => {
    expect(classifyTelegramError(403, "Forbidden: bot was blocked by the user").code).toBe("blocked");
    expect(classifyTelegramError(401, "Unauthorized").code).toBe("unauthorized");
    expect(classifyTelegramError(429, "Too Many Requests").code).toBe("rate_limited");
    expect(classifyTelegramError(400, "Bad Request: chat not found").code).toBe("unavailable");
    expect(classifyTelegramError(500, undefined).code).toBe("failed");
    expect(classifyMessengerError(190, undefined).code).toBe("unauthorized");
    expect(classifyMessengerError(10, 2018278).code).toBe("window_closed");
    expect(classifyMessengerError(551, undefined).code).toBe("unavailable");
    expect(classifyMessengerError(613, undefined).code).toBe("rate_limited");
    expect(classifyMessengerError(undefined, undefined).code).toBe("failed");
  });
});
