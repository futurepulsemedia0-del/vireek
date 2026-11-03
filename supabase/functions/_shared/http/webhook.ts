// _shared/http/webhook.ts — signature verification + replay protection for inbound webhooks.
// Pure Web Crypto (Deno and Node >= 20). Provider-agnostic; providers differ only in how the signed
// payload is built, so that is a callback.

import { constantTimeEqual, HttpError } from "./core.ts";

export type Encoding = "hex" | "base64";

const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const toBase64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

export async function hmacSha256(secret: string, data: string, enc: Encoding = "hex"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return enc === "hex" ? toHex(sig) : toBase64(sig);
}

export interface ReplayStore {
  /** Returns true the FIRST time (provider,eventId) is seen, false on replay. Must be atomic. */
  claim(provider: string, eventId: string): Promise<boolean>;
}

export interface WebhookVerifyOptions {
  provider: string;
  /** Secret from env. Empty/undefined => reject (fail closed). Pass several to support rotation. */
  secrets: ReadonlyArray<string | null | undefined>;
  /** Signature as sent by the provider (header value, already extracted). */
  signature: string | null;
  encoding?: Encoding;
  /** Unix SECONDS the provider signed (from the header/payload). Required: replay protection needs it. */
  timestamp: number | string | null;
  /** String that was signed, e.g. `${timestamp}.${rawBody}` (Stripe) or rawBody. */
  signedPayload: (timestamp: number) => string;
  toleranceSeconds?: number;
  now?: () => number;
  /** Provider event id for nonce tracking. Omit only if the provider has none (then tolerance alone limits replay). */
  eventId?: string | null;
  replay?: ReplayStore;
}

/** Throws HttpError (401) on any failure; returns when the request is authentic, fresh and not replayed. */
export async function verifyWebhook(o: WebhookVerifyOptions): Promise<void> {
  const deny = (why: string) => new HttpError("unauthorized", `Webhook rejected: ${why}.`);
  const secrets = o.secrets.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (secrets.length === 0) throw deny("no secret configured");
  if (!o.signature) throw deny("missing signature");
  const ts = Number(o.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) throw deny("missing timestamp");
  const now = (o.now ?? (() => Date.now()))() / 1000;
  const tol = o.toleranceSeconds ?? 300;
  if (Math.abs(now - ts) > tol) throw deny("timestamp outside tolerance");

  const payload = o.signedPayload(ts);
  const sig = o.signature.trim();
  let ok = false;
  for (const secret of secrets) {
    const expected = await hmacSha256(secret, payload, o.encoding ?? "hex");
    ok = constantTimeEqual(sig, expected) || ok; // no early exit: keep timing uniform across rotated secrets
  }
  if (!ok) throw deny("bad signature");

  if (o.eventId) {
    if (!o.replay) throw new HttpError("internal", "Replay store not configured.");
    const first = await o.replay.claim(o.provider, o.eventId);
    if (!first) throw new HttpError("conflict", "Duplicate event.", null, { "X-Webhook-Replay": "1" });
  }
}
