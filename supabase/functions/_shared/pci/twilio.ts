// supabase/functions/_shared/pci/twilio.ts
//
// Twilio helpers for pay-by-phone. Card digits are keyed on the caller's phone
// keypad into <Pay>, captured inside Twilio's PCI environment and tokenized by
// the Pay Connector (Stripe). Vireek only ever receives a token + masked metadata.
//
// NOT LIVE-VERIFIED against your Twilio account (same caveat as vapi-webhook):
// confirm the attribute names below against the current docs at
//   https://www.twilio.com/docs/voice/twiml/pay
//   https://www.twilio.com/docs/voice/api/recording  (pausing a call recording)
// on your first test call. Everything that decides what we store is the
// allowlist in parsePayCallback(), which does not depend on those details.

import { TWILIO_CALL_SID_RE, timingSafeEqual } from "./session.ts";
import { redactCardData } from "./cardData.ts";

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Request signature (X-Twilio-Signature)
// ---------------------------------------------------------------------------

export async function twilioSignature(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", enc.encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  header: string | null | undefined,
): Promise<boolean> {
  if (!authToken || !header) return false;
  return timingSafeEqual(await twilioSignature(authToken, url, params), header);
}

// ---------------------------------------------------------------------------
// Allowlist parser for <Pay> callbacks
// ---------------------------------------------------------------------------

export type PayResult =
  | "success"
  | "payment-connector-error"
  | "caller-interrupted"
  | "too-many-failed-attempts"
  | "input-timeout"
  | "invalid-card-number"
  | "invalid-card-type"
  | "invalid-date"
  | "invalid-security-code"
  | "invalid-postal-code"
  | "internal-error"
  | "unknown";

export interface PayCallback {
  callSid: string | null;
  result: PayResult | null;
  /** Provider token (Stripe tok_/pm_). A token is not card data. */
  token: string | null;
  cardBrand: string | null;
  /** Only ever set from an ALREADY-MASKED value ("************1111"). */
  cardLast4: string | null;
  /** Which field the provider is currently collecting (progress events). */
  capture: string | null;
  providerError: string | null;
  /** Number of provider params we deliberately ignored (kept for the audit trail; contents never stored). */
  ignoredParams: number;
}

const KNOWN_RESULTS = new Set<string>([
  "success", "payment-connector-error", "caller-interrupted", "too-many-failed-attempts", "input-timeout",
  "invalid-card-number", "invalid-card-type", "invalid-date", "invalid-security-code", "invalid-postal-code", "internal-error",
]);

const TOKEN_RE = /^(?:tok|pm)_[A-Za-z0-9]{8,64}$/;
const CAPTURE_FIELDS = new Set(["payment-card-number", "expiration-date", "security-code", "postal-code"]);

/**
 * Reads ONLY the fields listed here. Everything else Twilio sends (PaymentCardNumber, ExpirationDate,
 * SecurityCode, PostalCode, PartialResult, ...) is discarded unread — in particular the whole params
 * object must never be logged or persisted by callers.
 */
export function parsePayCallback(params: Record<string, string>): PayCallback {
  const read = new Set(["CallSid", "Result", "PaymentToken", "PaymentCardType", "PaymentCardNumber", "Capture", "PaymentError", "ErrorType"]);
  const ignoredParams = Object.keys(params).filter((k) => !read.has(k)).length;

  const rawResult = (params.Result ?? "").toLowerCase();
  const result: PayResult | null = rawResult ? ((KNOWN_RESULTS.has(rawResult) ? rawResult : "unknown") as PayResult) : null;

  const token = typeof params.PaymentToken === "string" && TOKEN_RE.test(params.PaymentToken) ? params.PaymentToken : null;

  const brandRaw = (params.PaymentCardType ?? "").toLowerCase();
  const cardBrand = /^[a-z-]{2,20}$/.test(brandRaw) ? brandRaw : null;

  // Twilio masks the number ("************1111"). If it is NOT in that exact masked shape, we discard it.
  const masked = params.PaymentCardNumber ?? "";
  const cardLast4 = /^[*xX•]{8,15}\d{4}$/.test(masked) ? masked.slice(-4) : null;

  const cap = (params.Capture ?? "").toLowerCase();
  const capture = CAPTURE_FIELDS.has(cap) ? cap : null;

  const callSid = TWILIO_CALL_SID_RE.test(params.CallSid ?? "") ? params.CallSid : null;
  const providerError = params.PaymentError ? redactCardData(String(params.PaymentError), { strict: true }).text.slice(0, 80).replace(/[^\w .:-]/g, "") : null;

  return { callSid, result, token, cardBrand, cardLast4, capture, providerError, ignoredParams };
}

// ---------------------------------------------------------------------------
// TwiML builders
// ---------------------------------------------------------------------------

export function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] as string));
}

export interface PayTwimlOptions {
  connector: string;
  actionUrl: string;
  statusCallbackUrl: string;
  tokenType?: "one-time" | "reusable" | "payment-method";
  language?: string;
  timeoutSeconds?: number;
  maxAttempts?: number;
}

/** chargeAmount="0" => TOKENIZE only. Vireek creates the charge itself so it stays on the Stripe Connect destination. */
export function buildPayTwiml(o: PayTwimlOptions): string {
  const attrs = [
    `input="dtmf"`,
    `paymentConnector="${xmlEscape(o.connector)}"`,
    `paymentMethod="credit-card"`,
    `chargeAmount="0"`,
    `currency="usd"`,
    `tokenType="${o.tokenType ?? "one-time"}"`,
    `securityCode="true"`,
    `postalCode="true"`,
    `validCardTypes="visa mastercard amex discover"`,
    `timeout="${o.timeoutSeconds ?? 15}"`,
    `maxAttempts="${o.maxAttempts ?? 3}"`,
    `language="${xmlEscape(o.language ?? "en-US")}"`,
    `action="${xmlEscape(o.actionUrl)}"`,
    `statusCallback="${xmlEscape(o.statusCallbackUrl)}"`,
  ].join(" ");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Say>You are now on our secure payment line. Please enter your card details using your phone keypad. ` +
    `Our team and our assistant cannot hear or see what you enter.</Say>` +
    `<Pay ${attrs}/>` +
    `</Response>`
  );
}

export type ResultTwimlKind = "approved" | "declined" | "failed" | "cancelled";

export function buildResultTwiml(kind: ResultTwimlKind, opts: { returnToNumber?: string | null } = {}): string {
  const say: Record<ResultTwimlKind, string> = {
    approved: "Thank you. Your payment was approved. A receipt is on its way. Goodbye.",
    declined: "We could not complete that payment because the card was declined. Our team will follow up with another way to pay. Goodbye.",
    failed: "We could not complete the payment on this call. Our team will follow up with a secure payment link. Goodbye.",
    cancelled: "This payment was cancelled. Goodbye.",
  };
  const dial = opts.returnToNumber && /^\+[1-9]\d{6,14}$/.test(opts.returnToNumber) ? `<Dial>${xmlEscape(opts.returnToNumber)}</Dial>` : "<Hangup/>";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xmlEscape(say[kind])}</Say>${dial}</Response>`;
}

// ---------------------------------------------------------------------------
// REST: pause/resume recording, redirect the call leg
// ---------------------------------------------------------------------------

export class RecordingControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordingControlError";
  }
}

export interface TwilioRestConfig {
  accountSid: string;
  authToken: string;
  fetchImpl?: typeof fetch;
}

function basicAuth(c: TwilioRestConfig): string {
  return "Basic " + btoa(`${c.accountSid}:${c.authToken}`);
}

function base(c: TwilioRestConfig): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}`;
}

async function listRecordings(c: TwilioRestConfig, callSid: string): Promise<Array<{ sid: string; status: string }>> {
  const f = c.fetchImpl ?? fetch;
  const res = await f(`${base(c)}/Calls/${callSid}/Recordings.json?PageSize=50`, { headers: { Authorization: basicAuth(c) }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new RecordingControlError(`Could not list recordings (${res.status}).`);
  const body = (await res.json()) as { recordings?: Array<{ sid?: string; status?: string }> };
  return (body.recordings ?? []).filter((r) => typeof r.sid === "string").map((r) => ({ sid: r.sid as string, status: String(r.status ?? "") }));
}

async function setRecordingStatus(c: TwilioRestConfig, callSid: string, recordingSid: string, status: "paused" | "in-progress"): Promise<string> {
  const f = c.fetchImpl ?? fetch;
  const form = new URLSearchParams({ Status: status });
  if (status === "paused") form.set("PauseBehavior", "skip");
  const res = await f(`${base(c)}/Calls/${callSid}/Recordings/${recordingSid}.json`, {
    method: "POST",
    headers: { Authorization: basicAuth(c), "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new RecordingControlError(`Could not set recording ${status} (${res.status}).`);
  const body = (await res.json()) as { status?: string };
  return String(body.status ?? "");
}

/**
 * Pauses every in-progress Twilio recording on the call leg and VERIFIES it. Throws (fail closed) if any
 * recording could not be confirmed paused. Returns how many recordings were paused (0 is valid: the call
 * is not being recorded by Twilio — e.g. recording happens in Vapi, which the redirect detaches from).
 */
export async function pauseCallRecordings(c: TwilioRestConfig, callSid: string): Promise<{ paused: number }> {
  if (!TWILIO_CALL_SID_RE.test(callSid)) throw new RecordingControlError("Invalid call SID.");
  const active = (await listRecordings(c, callSid)).filter((r) => r.status === "in-progress");
  for (const r of active) {
    const status = await setRecordingStatus(c, callSid, r.sid, "paused");
    if (status !== "paused") throw new RecordingControlError("A recording did not confirm paused.");
  }
  const still = (await listRecordings(c, callSid)).filter((r) => r.status === "in-progress");
  if (still.length > 0) throw new RecordingControlError("A recording is still in progress after pause.");
  return { paused: active.length };
}

export async function resumeCallRecordings(c: TwilioRestConfig, callSid: string): Promise<{ resumed: number }> {
  if (!TWILIO_CALL_SID_RE.test(callSid)) throw new RecordingControlError("Invalid call SID.");
  const paused = (await listRecordings(c, callSid)).filter((r) => r.status === "paused");
  for (const r of paused) await setRecordingStatus(c, callSid, r.sid, "in-progress");
  return { resumed: paused.length };
}

export async function redirectCallToTwiml(c: TwilioRestConfig, callSid: string, twiml: string): Promise<void> {
  if (!TWILIO_CALL_SID_RE.test(callSid)) throw new Error("Invalid call SID.");
  const f = c.fetchImpl ?? fetch;
  const res = await f(`${base(c)}/Calls/${callSid}.json`, {
    method: "POST",
    headers: { Authorization: basicAuth(c), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Twiml: twiml }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Twilio call update failed (${res.status}).`);
}
