// supabase/functions/_shared/consumer-agent/security.ts
//
// Pure (WebCrypto only) abuse-defence primitives for the public Consumer Agent surface:
//   * stateless proof-of-work challenge for UNKNOWN agents (HMAC-signed, expiring, single use via a DB counter)
//   * Ed25519 request signing for REGISTERED agents (Vireek-defined canonical string, NOT RFC 9421)
//   * salted IP hashing (we never store raw IPs)
//   * the rate-limit policy table
//
// A proof-of-work challenge is NOT a CAPTCHA and does not prove a human is present; it makes bulk automated
// writes cost real CPU. It is a deliberate choice because homeowner agents are software, so a visual CAPTCHA
// cannot work on this surface.

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const hex = (buf: ArrayBuffer | Uint8Array): string => Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

/** Constant-time string compare (equal length checked first; lengths are not secret here). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** Salted, truncated hash so abuse can be correlated per day without storing an IP address. */
export async function hashIp(ip: string, salt: string, now: Date = new Date()): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  return (await sha256Hex(`${salt}|${day}|${ip}`)).slice(0, 32);
}

// ------------------------------------------------------------------
// Rate-limit policy (enforced atomically in Postgres by consumer_agent_hit)
// ------------------------------------------------------------------

export interface Limit { key: string; windowSec: number; max: number }

export const POLICY = {
  anonymousReadPerMinute: 60,
  registeredReadPerMinute: 600,
  anonymousWritePerHour: 4,
  anonymousWritePerMinute: 2,
  registeredWritePerHour: 120,
  perBusinessAnonymousPerDay: 5,
  perBusinessAnonymousPerHourAll: 12,
  perBusinessRegisteredPerDay: 40,
  challengePerMinute: 20,
  invalidPerTenMinutes: 20,
  nonceWindowSec: 600,
  powTtlSec: 300,
  powBaseBits: 18,
  powHardBits: 22,
  maxSkewSec: 300,
  maxBodyBytes: 16 * 1024,
} as const;

export interface Principal {
  kind: "anonymous" | "registered";
  /** registered: agent row id; anonymous: salted IP hash */
  id: string;
  label: string;
}

export function limitsFor(p: Principal, slug: string, write: boolean, ipHash: string): Limit[] {
  const out: Limit[] = [];
  if (!write) {
    out.push({ key: `read:ip:${ipHash}`, windowSec: 60, max: p.kind === "registered" ? POLICY.registeredReadPerMinute : POLICY.anonymousReadPerMinute });
    if (p.kind === "registered") out.push({ key: `read:agent:${p.id}`, windowSec: 60, max: POLICY.registeredReadPerMinute });
    return out;
  }
  if (p.kind === "registered") {
    out.push({ key: `write:agent:${p.id}`, windowSec: 3600, max: POLICY.registeredWritePerHour });
    out.push({ key: `write:agent:${p.id}:${slug}`, windowSec: 86400, max: POLICY.perBusinessRegisteredPerDay });
  } else {
    out.push({ key: `write:ip:${ipHash}:m`, windowSec: 60, max: POLICY.anonymousWritePerMinute });
    out.push({ key: `write:ip:${ipHash}:h`, windowSec: 3600, max: POLICY.anonymousWritePerHour });
    out.push({ key: `write:ip:${ipHash}:${slug}`, windowSec: 86400, max: POLICY.perBusinessAnonymousPerDay });
    // Defence against rotating IPs: one business never takes more than this many UNSIGNED agent writes per hour in total.
    out.push({ key: `write:slug:${slug}:anon:h`, windowSec: 3600, max: POLICY.perBusinessAnonymousPerHourAll });
  }
  return out;
}

// ------------------------------------------------------------------
// Proof-of-work challenge for unknown agents
// ------------------------------------------------------------------

export interface ChallengePayload { v: 1; id: string; exp: number; bits: number }

export async function issueChallenge(secret: string, bits: number, now: Date = new Date()): Promise<{ token: string; bits: number; expires_at: string; algorithm: string; how_to_solve: string }> {
  const payload: ChallengePayload = { v: 1, id: crypto.randomUUID(), exp: Math.floor(now.getTime() / 1000) + POLICY.powTtlSec, bits };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = b64urlEncode(await hmac(secret, body));
  return {
    token: `${body}.${sig}`, bits, expires_at: new Date(payload.exp * 1000).toISOString(),
    algorithm: "sha256-leading-zero-bits",
    how_to_solve: `Find a nonce (1-64 chars of A-Za-z0-9_.-) so that SHA-256 of the UTF-8 string "<token>:<nonce>" has at least ${bits} leading zero bits. Send {token, nonce} as arguments.challenge. One solution works once.`,
  };
}

export function leadingZeroBits(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) { n += 8; continue; }
    n += Math.clz32(b) - 24;
    break;
  }
  return n;
}

export type ChallengeCheck = { ok: true; id: string; exp: number } | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "insufficient_work" };

export async function verifyChallenge(secret: string, token: string, nonce: string, minBits: number, now: Date = new Date()): Promise<ChallengeCheck> {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, sig] = parts;
  const expected = b64urlEncode(await hmac(secret, body));
  if (!timingSafeEqual(sig, expected)) return { ok: false, reason: "bad_signature" };
  const raw = b64urlDecode(body);
  let p: ChallengePayload;
  try {
    p = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array())) as ChallengePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (p?.v !== 1 || typeof p.id !== "string" || typeof p.exp !== "number" || typeof p.bits !== "number") return { ok: false, reason: "malformed" };
  if (p.exp * 1000 < now.getTime()) return { ok: false, reason: "expired" };
  // The server decides the difficulty it requires NOW; a token issued at a lower difficulty cannot be reused to dodge escalation.
  const required = Math.max(p.bits, minBits);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`${token}:${nonce}`)));
  if (leadingZeroBits(digest) < required) return { ok: false, reason: "insufficient_work" };
  return { ok: true, id: p.id, exp: p.exp };
}

/** Reference solver (used by tests, the sandbox docs and the sample client). */
export async function solveChallenge(token: string, bits: number, maxIterations = 50_000_000): Promise<string | null> {
  for (let i = 0; i < maxIterations; i++) {
    const nonce = i.toString(36);
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`${token}:${nonce}`)));
    if (leadingZeroBits(d) >= bits) return nonce;
  }
  return null;
}

// ------------------------------------------------------------------
// Request signing for registered agents (Ed25519)
// ------------------------------------------------------------------
// Headers:  Vireek-Key-Id, Vireek-Timestamp (unix seconds), Vireek-Nonce (16-64 chars), Vireek-Signature (base64url)
// Signed:   "vireek-sig-v1\n" + METHOD + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256hex(body)

export async function canonicalString(method: string, path: string, timestamp: string, nonce: string, body: string): Promise<string> {
  return ["vireek-sig-v1", method.toUpperCase(), path, timestamp, nonce, await sha256Hex(body)].join("\n");
}

export interface SignatureHeaders { keyId: string; timestamp: string; nonce: string; signature: string }

export function readSignatureHeaders(h: Headers): SignatureHeaders | "absent" | "malformed" {
  const keyId = h.get("vireek-key-id");
  const sig = h.get("vireek-signature");
  if (!keyId && !sig && !h.get("vireek-timestamp") && !h.get("vireek-nonce")) return "absent";
  const timestamp = h.get("vireek-timestamp") ?? "";
  const nonce = h.get("vireek-nonce") ?? "";
  if (!keyId || !sig || !/^[A-Za-z0-9_.:-]{3,64}$/.test(keyId) || !/^\d{10}$/.test(timestamp) || !/^[A-Za-z0-9_.:-]{16,64}$/.test(nonce) || sig.length > 200) return "malformed";
  return { keyId, timestamp, nonce, signature: sig };
}

export type SignatureCheck = { ok: true } | { ok: false; reason: "stale" | "bad_signature" | "bad_key" };

/** publicKeyB64u: 32-byte raw Ed25519 public key, base64url. */
export async function verifySignature(
  publicKeyB64u: string, sig: SignatureHeaders, method: string, path: string, body: string, now: Date = new Date(),
): Promise<SignatureCheck> {
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - Number(sig.timestamp));
  if (!Number.isFinite(skew) || skew > POLICY.maxSkewSec) return { ok: false, reason: "stale" };
  const raw = b64urlDecode(publicKeyB64u);
  const signature = b64urlDecode(sig.signature);
  if (!raw || raw.length !== 32 || !signature || signature.length !== 64) return { ok: false, reason: "bad_key" };
  try {
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, enc.encode(await canonicalString(method, path, sig.timestamp, sig.nonce, body)));
    return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_key" };
  }
}

// ------------------------------------------------------------------
// Anomaly assessment (pure; the edge function feeds it counts from consumer_agent_principal_stats)
// ------------------------------------------------------------------

export interface PrincipalStats {
  requests_1h: number;
  distinct_contacts_1h: number;
  flagged_1h: number;
  invalid_10m: number;
  declined_24h: number;
  total_24h: number;
}
export type Assessment = { action: "allow" | "harder_challenge" | "throttle" | "block"; reasons: string[] };

export function assessPrincipal(s: PrincipalStats, kind: Principal["kind"]): Assessment {
  const reasons: string[] = [];
  if (s.flagged_1h >= 3) reasons.push("repeated_injection_or_payment_language");
  if (s.distinct_contacts_1h >= 4) reasons.push("many_distinct_contacts");
  if (s.invalid_10m >= POLICY.invalidPerTenMinutes) reasons.push("many_invalid_calls");
  if (s.total_24h >= 6 && s.declined_24h / s.total_24h >= 0.8) reasons.push("mostly_declined");
  if (s.flagged_1h >= 5 || s.distinct_contacts_1h >= 8 || s.invalid_10m >= POLICY.invalidPerTenMinutes * 3) return { action: "block", reasons };
  if (reasons.length >= 2) return { action: "block", reasons };
  if (reasons.length === 1) return { action: kind === "registered" ? "throttle" : "harder_challenge", reasons };
  if (s.requests_1h >= 3) return { action: "harder_challenge", reasons: ["elevated_write_rate"] };
  return { action: "allow", reasons };
}
