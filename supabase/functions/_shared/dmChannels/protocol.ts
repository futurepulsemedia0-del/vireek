// supabase/functions/_shared/dmChannels/protocol.ts
//
// Pure protocol helpers for the Telegram and Facebook Messenger inbox channels.
// No I/O, no Deno APIs (only Web standards) so everything here is unit-tested.
// I/O lives in ./api.ts (HTTP to Telegram / Meta) and ./inbound.ts (database).

export type DmChannel = "telegram" | "messenger";

export const TELEGRAM_MAX_CHARS = 4096;
export const MESSENGER_MAX_CHARS = 2000;
/** Messenger "standard messaging" window: free-form replies only within 24h of the customer's last message. */
export const MESSENGER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Graph API version. v20.0 expired on 2026-09-24; override with the META_GRAPH_VERSION secret. */
export const DEFAULT_GRAPH_VERSION = "v25.0";

export interface InboundMessage {
  channel: DmChannel;
  /** Telegram bot id / Facebook Page id: identifies which tenant connection owns the message. */
  externalAccountId: string;
  /** Telegram chat id / Messenger page-scoped user id (PSID). */
  customerId: string;
  customerName: string | null;
  providerMessageId: string;
  text: string;
  /** ISO timestamp of when the customer sent it (never in the future). */
  sentAt: string;
}

export type SendFailureCode =
  | "blocked" | "unavailable" | "window_closed" | "rate_limited" | "unauthorized" | "failed";

export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; code: SendFailureCode; message: string };

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Constant-time string comparison (secrets, signatures). */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Meta signs the RAW request body: header `X-Hub-Signature-256: sha256=<hex hmac>` keyed with the App Secret. */
export async function verifyMetaSignature(rawBody: string, header: string | null, appSecret: string | undefined): Promise<boolean> {
  if (!appSecret || !header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return safeEqual(toHex(sig), header.slice("sha256=".length).toLowerCase());
}

function clampIso(ms: unknown, now: number): string {
  const t = typeof ms === "number" && Number.isFinite(ms) ? ms : now;
  return new Date(Math.min(t, now)).toISOString();
}

function cleanText(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** BotFather token shape: `<bot id>:<35-char secret>`. */
export function isTelegramToken(s: string): boolean {
  return /^\d{5,16}:[A-Za-z0-9_-]{30,60}$/.test(s);
}

export function isFacebookPageId(s: string): boolean {
  return /^\d{5,20}$/.test(s);
}

export function isPageAccessToken(s: string): boolean {
  return s.length >= 20 && s.length <= 1000 && !/\s/.test(s);
}

export function maxCharsFor(channel: DmChannel): number {
  return channel === "telegram" ? TELEGRAM_MAX_CHARS : MESSENGER_MAX_CHARS;
}

export function validateOutbound(
  channel: DmChannel, body: unknown,
): { ok: true; text: string } | { ok: false; code: "empty" | "too_long"; message: string } {
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) return { ok: false, code: "empty", message: "Message is empty." };
  const max = maxCharsFor(channel);
  if (text.length > max) {
    return { ok: false, code: "too_long", message: `Message is too long (max ${max} characters for this channel).` };
  }
  return { ok: true, text };
}

/** Messenger: free-form replies are allowed only within 24h of the customer's last inbound message. */
export function messengerWindowOpen(lastInboundAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastInboundAt) return false;
  const t = Date.parse(lastInboundAt);
  return Number.isFinite(t) && now - t < MESSENGER_WINDOW_MS;
}

/**
 * Consent keywords for chat channels. Deliberately narrower than SMS (no CANCEL / END):
 * "cancel my appointment" must never unsubscribe a customer from a conversation.
 */
export function classifyDmKeyword(body: string | null | undefined): "stop" | "start" | null {
  const word = (body ?? "")
    .normalize("NFKC")
    .replace(/[\s\u200b-\u200d\ufeff]+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .toUpperCase();
  if (!word || word.includes(" ")) return null;
  if (word === "STOP" || word === "STOPALL" || word === "UNSUBSCRIBE") return "stop";
  if (word === "START" || word === "UNSTOP" || word === "SUBSCRIBE") return "start";
  return null;
}

export function optOutAckText(brand: string): string {
  return `You're unsubscribed and won't receive more messages from ${brand}. Reply START to resubscribe.`;
}

export function optInAckText(brand: string): string {
  return `You're resubscribed to messages from ${brand}. Reply STOP at any time to opt out.`;
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

interface TgUser { id?: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
interface TgMessage {
  message_id?: number;
  date?: number;
  text?: string;
  caption?: string;
  from?: TgUser;
  chat?: { id?: number | string; type?: string };
  photo?: unknown; video?: unknown; video_note?: unknown; voice?: unknown; audio?: unknown;
  sticker?: unknown; location?: unknown; contact?: unknown; animation?: unknown;
  document?: { file_name?: string };
}

function telegramBody(m: TgMessage): string {
  const text = cleanText(m.text) || cleanText(m.caption);
  if (text) return text.slice(0, TELEGRAM_MAX_CHARS);
  if (m.photo) return "[Photo]";
  if (m.video || m.video_note || m.animation) return "[Video]";
  if (m.voice) return "[Voice message]";
  if (m.audio) return "[Audio]";
  if (m.document) return m.document.file_name ? `[File: ${m.document.file_name.slice(0, 120)}]` : "[File]";
  if (m.sticker) return "[Sticker]";
  if (m.location) return "[Location]";
  if (m.contact) return "[Contact]";
  return "[Unsupported message]";
}

/** Returns the inbound message of a Telegram update, or null for anything we don't store (groups, bots, edits, callbacks…). */
export function parseTelegramUpdate(update: unknown, botId: string, now: number = Date.now()): InboundMessage | null {
  const m = (update as { message?: TgMessage } | null)?.message;
  if (!m || typeof m !== "object") return null;
  if (m.chat?.type !== "private" || m.from?.is_bot === true) return null;
  const chatId = m.chat.id;
  if ((typeof chatId !== "number" && typeof chatId !== "string") || String(chatId) === "") return null;
  if (typeof m.message_id !== "number") return null;

  const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ").trim()
    || (m.from?.username ? `@${m.from.username}` : null);

  return {
    channel: "telegram",
    externalAccountId: botId,
    customerId: String(chatId),
    customerName: name,
    providerMessageId: String(m.message_id),
    text: telegramBody(m),
    sentAt: clampIso(typeof m.date === "number" ? m.date * 1000 : undefined, now),
  };
}

// ---------------------------------------------------------------------------
// Messenger
// ---------------------------------------------------------------------------

interface MsgrEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: Array<{ type?: string }>;
  };
}

const ATTACHMENT_LABEL: Record<string, string> = {
  image: "[Photo]", video: "[Video]", audio: "[Voice message]", file: "[File]", location: "[Location]",
};

/** Flattens a Messenger webhook payload (entries and events are batched) into inbound customer messages. */
export function parseMessengerEvents(payload: unknown, now: number = Date.now()): InboundMessage[] {
  const p = payload as { object?: string; entry?: Array<{ id?: string; messaging?: MsgrEvent[] }> } | null;
  if (p?.object !== "page" || !Array.isArray(p.entry)) return [];

  const out: InboundMessage[] = [];
  for (const entry of p.entry) {
    for (const ev of Array.isArray(entry?.messaging) ? entry.messaging : []) {
      const msg = ev?.message;
      // Echoes are our own outbound messages; delivery / read / postback events carry no `message`.
      if (!msg || msg.is_echo || typeof msg.mid !== "string") continue;
      const psid = ev.sender?.id;
      const pageId = ev.recipient?.id ?? entry.id;
      if (!psid || !pageId) continue;

      const text = cleanText(msg.text).slice(0, 4000)
        || (msg.attachments?.[0]?.type ? (ATTACHMENT_LABEL[msg.attachments[0].type] ?? "[Attachment]") : "[Unsupported message]");

      out.push({
        channel: "messenger",
        externalAccountId: String(pageId),
        customerId: String(psid),
        customerName: null, // resolved lazily via the User Profile API (see api.ts)
        providerMessageId: msg.mid,
        text,
        sentAt: clampIso(ev.timestamp, now),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider error classification (what to show the agent / what state to change)
// ---------------------------------------------------------------------------

export function classifyTelegramError(status: number, description: string | undefined): { code: SendFailureCode; message: string } {
  const d = description ?? "";
  if (status === 401) return { code: "unauthorized", message: "Telegram rejected the bot token. Reconnect the bot in Messaging channels settings." };
  if (status === 403 || /blocked by the user|user is deactivated|bot was kicked/i.test(d)) {
    return { code: "blocked", message: "This customer blocked the bot or deactivated their account, so no message can be delivered." };
  }
  if (status === 429) return { code: "rate_limited", message: "Telegram is rate limiting this bot. Try again in a moment." };
  if (/chat not found/i.test(d)) return { code: "unavailable", message: "Telegram can no longer reach this chat." };
  return { code: "failed", message: "Telegram could not deliver the message. Try again." };
}

export function classifyMessengerError(code: number | undefined, subcode: number | undefined): { code: SendFailureCode; message: string } {
  if (code === 190) return { code: "unauthorized", message: "Meta rejected the Page token (expired or revoked). Reconnect the Page in Messaging channels settings." };
  if (subcode === 2018278) return { code: "window_closed", message: "Outside Messenger's 24-hour reply window. The customer must message you again first." };
  if (code === 551 || subcode === 2018001) return { code: "unavailable", message: "This person is not available on Messenger right now." };
  if (code === 4 || code === 17 || code === 32 || code === 613) return { code: "rate_limited", message: "Meta is rate limiting this Page. Try again in a moment." };
  return { code: "failed", message: "Messenger could not deliver the message. Try again." };
}
