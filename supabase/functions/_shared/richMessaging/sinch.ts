// supabase/functions/_shared/richMessaging/sinch.ts
//
// Sinch Conversation API adapter (RCS + Apple Messages for Business through one aggregator).
// This is the ONLY file that knows Sinch's wire format; swap it (Infobip, Twilio RCS, ...)
// by implementing RichProvider + parseEvents + verifySignature.
//
// NOT LIVE-VERIFIED against a Sinch project. Verified from Sinch docs: regional base URLs,
// OAuth2 client-credentials + Bearer auth, messages:send / capability:query paths, webhook
// signature scheme (HMAC-SHA256 over `body.nonce.timestamp`), delivery statuses.
// Re-check against a real test webhook BEFORE production (list in docs/RICH_MESSAGING.md):
//   channel ids "RCS" / "APPLEBC", the capability_notification + opt_out payload shapes,
//   the `ttl` send field and the echo of `correlation_id` in MESSAGE_DELIVERY.
// Everything is parsed defensively so an unexpected field is ignored, not a crash.

import type {
  CapabilityStatus, DeliveryEvent, ProviderSendRequest, ProviderSendResult, RichAccount, RichChannel,
  RichContent, RichEvent, RichProvider,
} from "./types.ts";

export const SINCH_CHANNEL: Record<RichChannel, string> = { rcs: "RCS", amb: "APPLEBC" };

export function richChannelFromSinch(value: unknown): RichChannel | null {
  const v = String(value ?? "").toUpperCase();
  if (v === "RCS") return "rcs";
  if (v === "APPLEBC" || v === "APPLE_BC" || v === "APPLEMESSAGESFORBUSINESS") return "amb";
  return null;
}

/** RCS identities are phone numbers; Sinch takes them without the leading '+'. Apple ids pass through. */
export function toSinchIdentity(channel: RichChannel, identity: string): string {
  return channel === "rcs" ? identity.replace(/\D/g, "") : identity;
}

// ---- outbound ---------------------------------------------------------------------

export function toSinchMessage(content: RichContent): Record<string, unknown> {
  if (content.kind === "text") return { text_message: { text: content.text } };
  const { card } = content;
  return {
    card_message: {
      title: card.title,
      ...(card.description ? { description: card.description } : {}),
      ...(card.imageUrl ? { media_message: { url: card.imageUrl } } : {}),
      choices: card.actions.map((a) => {
        if (a.type === "url") return { url_message: { title: a.label, url: a.value } };
        if (a.type === "call") return { call_message: { title: a.label, phone_number: a.value } };
        return { text_message: { text: a.label }, postback_data: a.value };
      }),
    },
  };
}

export function buildSendBody(p: {
  appId: string; channel: RichChannel; identity: string; content: RichContent; correlationId: string; ttlSeconds?: number;
}): Record<string, unknown> {
  const channel = SINCH_CHANNEL[p.channel];
  return {
    app_id: p.appId,
    recipient: { identified_by: { channel_identities: [{ channel, identity: toSinchIdentity(p.channel, p.identity) }] } },
    message: toSinchMessage(p.content),
    // Only the rich channel: SMS fallback is done by US through sendCompliantSms (A2P + STOP + quiet hours).
    channel_priority_order: [channel],
    correlation_id: p.correlationId,
    ...(p.ttlSeconds ? { ttl: `${Math.max(1, Math.floor(p.ttlSeconds))}s` } : {}),
  };
}

// ---- webhook signature ------------------------------------------------------------

export interface HeaderReader {
  get(name: string): string | null;
}

function b64(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signSinchBody(secret: string, rawBody: string, nonce: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${rawBody}.${nonce}.${timestamp}`));
  return b64(sig);
}

export async function verifySinchSignature(p: {
  rawBody: string; headers: HeaderReader; secret: string | null | undefined; nowMs?: number; toleranceSec?: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!p.secret) return { ok: false, reason: "secret_not_configured" };
  const signature = p.headers.get("x-sinch-webhook-signature");
  const nonce = p.headers.get("x-sinch-webhook-signature-nonce");
  const timestamp = p.headers.get("x-sinch-webhook-signature-timestamp");
  const algorithm = p.headers.get("x-sinch-webhook-signature-algorithm");
  if (!signature || !nonce || !timestamp) return { ok: false, reason: "missing_headers" };
  if (algorithm && algorithm !== "HmacSHA256") return { ok: false, reason: "unsupported_algorithm" };

  const ts = Number(timestamp);
  const nowSec = (p.nowMs ?? Date.now()) / 1000;
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > (p.toleranceSec ?? 300)) return { ok: false, reason: "stale_timestamp" };

  const expected = await signSinchBody(p.secret, p.rawBody, nonce, timestamp);
  return safeEqual(expected, signature) ? { ok: true } : { ok: false, reason: "bad_signature" };
}

// ---- inbound event parsing ----------------------------------------------------------

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function capabilityFrom(v: unknown): CapabilityStatus {
  const s = String(v ?? "").toUpperCase();
  if (s === "CAPABILITY_FULL" || s === "CAPABILITY_PARTIAL" || s === "FULL" || s === "PARTIAL") return "capable";
  if (s === "NO_CAPABILITY" || s === "NONE") return "not_capable";
  return "unknown";
}

function deliveryStatus(v: unknown): DeliveryEvent["status"] {
  const s = String(v ?? "").toUpperCase();
  if (s === "DELIVERED") return "delivered";
  if (s === "READ") return "read";
  if (s === "FAILED") return "failed";
  return "pending";
}

/** Normalises one Sinch webhook body into zero or more provider-neutral events. Never throws. */
export function parseSinchEvents(payload: unknown): RichEvent[] {
  const p = obj(payload);
  if (!p) return [];
  const out: RichEvent[] = [];
  const appIdTop = str(p.app_id);

  const msg = obj(p.message);
  if (msg && String(msg.direction ?? "TO_APP").toUpperCase() !== "TO_CONTACT") {
    const ci = obj(msg.channel_identity);
    const channel = richChannelFromSinch(ci?.channel);
    const identity = str(ci?.identity);
    const id = str(msg.id);
    const appId = appIdTop ?? str(ci?.app_id);
    if (channel && identity && id && appId) {
      const cm = obj(msg.contact_message);
      out.push({
        type: "inbound",
        appId,
        channel,
        identity,
        providerMessageId: id,
        providerConversationId: str(msg.conversation_id),
        contactId: str(msg.contact_id),
        text: str(obj(cm?.text_message)?.text),
        postback: str(obj(cm?.choice_response_message)?.postback_data),
        mediaUrl: str(obj(cm?.media_message)?.url) ?? str(obj(cm?.media_card_message)?.url),
        receivedAt: str(msg.accept_time) ?? str(p.accepted_time) ?? new Date().toISOString(),
      });
    }
  }

  const rep = obj(p.message_delivery_report);
  if (rep) {
    const ci = obj(rep.channel_identity);
    const appId = appIdTop ?? str(ci?.app_id);
    const messageId = str(rep.message_id);
    if (appId && messageId) {
      const reason = obj(rep.reason);
      out.push({
        type: "delivery",
        appId,
        providerMessageId: messageId,
        correlationId: str(p.correlation_id),
        status: deliveryStatus(rep.status),
        reasonCode: str(reason?.code),
        reasonText: str(reason?.description),
        channel: richChannelFromSinch(ci?.channel),
        identity: str(ci?.identity),
      });
    }
  }

  const cap = obj(p.capability_notification);
  if (cap && appIdTop) {
    const channel = richChannelFromSinch(cap.channel);
    const identity = str(cap.identity);
    if (channel && identity) {
      out.push({ type: "capability", appId: appIdTop, channel, identity, status: capabilityFrom(cap.capability_status), features: cap.channel_capabilities ?? null });
    }
  }

  const opt = obj(p.opt_out_notification) ?? obj(p.opt_out);
  if (opt) {
    const ci = obj(opt.channel_identity);
    const channel = richChannelFromSinch(opt.channel ?? ci?.channel);
    const identity = str(opt.identity) ?? str(ci?.identity);
    const appId = appIdTop ?? str(opt.app_id);
    if (channel && identity && appId) out.push({ type: "opt_out", appId, channel, identity });
  }

  const ev = obj(p.event);
  if (ev && JSON.stringify(ev.contact_event ?? {}).toLowerCase().includes("conversation_deleted")) {
    const ci = obj(ev.channel_identity);
    const channel = richChannelFromSinch(ci?.channel);
    const identity = str(ci?.identity);
    const appId = appIdTop ?? str(ci?.app_id);
    if (channel && identity && appId) out.push({ type: "conversation_deleted", appId, channel, identity });
  }

  return out;
}

/** Stable key used to de-duplicate provider retries. */
export function eventKey(e: RichEvent): string {
  switch (e.type) {
    case "inbound": return `in:${e.providerMessageId}`;
    case "delivery": return `dr:${e.providerMessageId}:${e.status}`;
    case "capability": return `cap:${e.channel}:${e.identity}:${e.status}:${Math.floor(Date.now() / 60_000)}`;
    case "opt_out": return `oo:${e.channel}:${e.identity}:${Math.floor(Date.now() / 60_000)}`;
    case "conversation_deleted": return `del:${e.channel}:${e.identity}:${Math.floor(Date.now() / 60_000)}`;
  }
}

// ---- API client ------------------------------------------------------------------------

export interface SinchConfig {
  projectId: string;
  keyId: string;
  keySecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function sinchConfigFromEnv(get: (k: string) => string | undefined): SinchConfig | null {
  const projectId = get("SINCH_PROJECT_ID");
  const keyId = get("SINCH_KEY_ID");
  const keySecret = get("SINCH_KEY_SECRET");
  return projectId && keyId && keySecret ? { projectId, keyId, keySecret } : null;
}

const TOKEN_URL = "https://auth.sinch.com/oauth2/token";

export function baseUrl(region: RichAccount["providerRegion"]): string {
  return `https://${region}.conversation.api.sinch.com`;
}

export class SinchClient implements RichProvider {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly f: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly cfg: SinchConfig) {
    this.f = cfg.fetchImpl ?? fetch.bind(globalThis);
    this.now = cfg.now ?? Date.now;
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > this.now() + 60_000) return this.token.value;
    const res = await this.f(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${this.cfg.keyId}:${this.cfg.keySecret}`)}`,
      },
      body: "grant_type=client_credentials",
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.access_token) throw new Error(`Sinch auth failed (HTTP ${res.status})`);
    this.token = { value: json.access_token as string, expiresAt: this.now() + Number(json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async post(account: RichAccount, path: string, body: unknown, retried = false): Promise<Response> {
    const token = await this.accessToken(retried);
    const res = await this.f(`${baseUrl(account.providerRegion)}/v1/projects/${this.cfg.projectId}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (res.status === 401 && !retried) return this.post(account, path, body, true);
    return res;
  }

  async send(req: ProviderSendRequest): Promise<ProviderSendResult> {
    if (!req.account.providerAppId) return { ok: false, error: "No provider app configured", code: "NOT_CONFIGURED", retryable: false };
    try {
      const res = await this.post(req.account, "messages:send", buildSendBody({
        appId: req.account.providerAppId, channel: req.channel, identity: req.identity,
        content: req.content, correlationId: req.correlationId, ttlSeconds: req.ttlSeconds,
      }));
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const detail = json?.error?.message ?? `HTTP ${res.status}`;
        return { ok: false, error: String(detail), code: String(json?.error?.status ?? res.status), retryable: res.status === 429 || res.status >= 500 };
      }
      const id = str(json?.message_id);
      return id ? { ok: true, providerMessageId: id } : { ok: false, error: "Provider returned no message_id", retryable: false };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), code: "NETWORK", retryable: true };
    }
  }

  /** Fire-and-forget: the answer arrives later as a CAPABILITY webhook. Returns whether the query was accepted. */
  async queryCapability(account: RichAccount, channel: RichChannel, identity: string): Promise<boolean> {
    if (!account.providerAppId) return false;
    try {
      const res = await this.post(account, "capability:query", {
        app_id: account.providerAppId,
        recipient: { identified_by: { channel_identities: [{ channel: SINCH_CHANNEL[channel], identity: toSinchIdentity(channel, identity) }] } },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
