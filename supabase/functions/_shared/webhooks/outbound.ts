// supabase/functions/_shared/webhooks/outbound.ts
//
// Pure logic for the durable outbound webhook system (outbox + worker). No Deno/network.
//
// Wire format (v1, additive to the legacy X-Vireek-Signature header which stays unchanged):
//   X-Vireek-Timestamp:    unix seconds
//   X-Vireek-Signature-V1: "v1=" + hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`))   (one value per active secret)
//   X-Vireek-Delivery-Id:  stable id for de-duplication (same across retries and replays of one event)
//   X-Vireek-Event:        event name
//   X-Vireek-Event-Version: payload schema version
// During secret rotation both the primary and the previous secret sign, so receivers never drop events.

import { isBlockedHost } from "../siem/engine.ts";

export const EVENT_SCHEMA_VERSION = "2026-11-01";
export const MAX_ATTEMPTS = 8;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Delay before attempt N+1 (attempt is the number of attempts already made). Exponential, capped, full jitter. */
export function backoffSeconds(attempt: number, random: () => number = Math.random): number {
  const capped = Math.min(Math.max(1, attempt), 12);
  const ceiling = Math.min(30 * 2 ** (capped - 1), 6 * 3600); // 30s, 1m, 2m, 4m ... max 6h
  return Math.max(5, Math.floor(ceiling / 2 + random() * (ceiling / 2)));
}

export function retryAfterSeconds(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.ceil(n), 6 * 3600);
  const t = Date.parse(header);
  return Number.isNaN(t) ? null : Math.min(Math.max(0, Math.ceil((t - nowMs) / 1000)), 6 * 3600);
}

export type DeliveryClass = "delivered" | "retry" | "dead";

/** 2xx delivered; 408/425/429/5xx and network errors retry; every other 4xx and 3xx is permanent. */
export function classifyDelivery(status: number | undefined): DeliveryClass {
  if (status === undefined) return "retry";
  if (status >= 200 && status < 300) return "delivered";
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "retry";
  return "dead";
}

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/** Static checks (https only, no credentials, public-looking host, sane port). DNS is checked separately. */
export function validateDeliveryUrl(raw: string): UrlCheck {
  let u: URL;
  try { u = new URL((raw ?? "").trim()); } catch { return { ok: false, error: "invalid_url" }; }
  if (u.protocol !== "https:") return { ok: false, error: "https_required" };
  if (u.username || u.password) return { ok: false, error: "credentials_not_allowed" };
  if (isBlockedHost(u.hostname)) return { ok: false, error: "host_not_public" };
  const port = u.port ? Number(u.port) : 443;
  if (!(port === 443 || (port >= 1024 && port <= 65535))) return { ok: false, error: "port_not_allowed" };
  u.hash = "";
  return { ok: true, url: u.toString() };
}

export function isPublicIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  if (v.includes(":")) {
    if (v === "::" || v === "::1") return false;
    if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return false; // link-local
    if (v.startsWith("fc") || v.startsWith("fd")) return false; // unique local
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? isPublicIp(mapped[1]) : true;
  }
  return !isBlockedHost(v) && /^\d+\.\d+\.\d+\.\d+$/.test(v);
}

/** Every resolved address must be public; an empty answer is a failure (fail closed). */
export function resolvedAddressesSafe(ips: readonly string[]): boolean {
  return ips.length > 0 && ips.every(isPublicIp);
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SignedDelivery { headers: Record<string, string>; body: string }

export async function signDelivery(o: {
  secrets: readonly string[]; // [primary, previous?]
  body: string; deliveryId: string; event: string; timestamp: number;
}): Promise<SignedDelivery> {
  const secrets = o.secrets.filter((s) => s && s.length > 0);
  if (secrets.length === 0) throw new Error("no_signing_secret");
  const sigs = await Promise.all(secrets.map(async (s) => `v1=${await hmacHex(s, `${o.timestamp}.${o.body}`)}`));
  return {
    body: o.body,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Vireek-Webhooks/1",
      "X-Vireek-Delivery-Id": o.deliveryId,
      "X-Vireek-Event": o.event,
      "X-Vireek-Event-Version": EVENT_SCHEMA_VERSION,
      "X-Vireek-Timestamp": String(o.timestamp),
      "X-Vireek-Signature-V1": sigs.join(","),
      // Legacy header (HMAC of the body only) so existing receivers keep working.
      "X-Vireek-Signature": await hmacHex(secrets[0], o.body),
    },
  };
}

function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Reference receiver: this is what customers (and our own tests) run to verify a delivery. */
export async function verifyDelivery(o: {
  secret: string; body: string; timestampHeader: string | null; signatureHeader: string | null;
  nowMs?: number; toleranceSeconds?: number;
}): Promise<{ ok: true } | { ok: false; reason: "missing" | "stale" | "bad_signature" }> {
  if (!o.timestampHeader || !o.signatureHeader) return { ok: false, reason: "missing" };
  const ts = Number(o.timestampHeader);
  if (!Number.isFinite(ts)) return { ok: false, reason: "missing" };
  const now = (o.nowMs ?? Date.now()) / 1000;
  if (Math.abs(now - ts) > (o.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return { ok: false, reason: "stale" };
  const expected = `v1=${await hmacHex(o.secret, `${ts}.${o.body}`)}`;
  let ok = false;
  for (const candidate of o.signatureHeader.split(",")) ok = ctEqual(candidate.trim(), expected) || ok;
  return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
}

const PII_KEYS = /^(ssn|password|token|secret|api_key|card|cvv|pin)$/i;

/** Event payloads leave the tenant boundary: drop credential-like keys and cap size. */
export function buildEventPayload(o: {
  deliveryId: string; event: string; createdAt: string; data: Record<string, unknown> | null;
}): { ok: true; body: string } | { ok: false; error: "payload_too_large" } {
  const clean = (v: unknown, depth = 0): unknown => {
    if (depth > 6 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => clean(x, depth + 1));
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !PII_KEYS.test(k)).map(([k, x]) => [k, clean(x, depth + 1)]));
  };
  const body = JSON.stringify({
    id: o.deliveryId, event: o.event, version: EVENT_SCHEMA_VERSION, created_at: o.createdAt, data: clean(o.data),
  });
  return new TextEncoder().encode(body).length > MAX_PAYLOAD_BYTES ? { ok: false, error: "payload_too_large" } : { ok: true, body };
}
