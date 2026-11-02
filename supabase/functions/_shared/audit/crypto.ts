// supabase/functions/_shared/audit/crypto.ts
// WebCrypto helpers (Deno + Node 20+). Secrets never appear in logs; callers pass them in.

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export async function hmacSha256Hex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** 32 random bytes => 43 URL-safe chars (256 bits). */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const isWellFormedToken = (v: unknown): v is string => typeof v === "string" && TOKEN_RE.test(v);

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Peppered identifier hash: a leaked table cannot be reversed by walking the 10-digit phone space. */
export const hashIdentifier = (pepper: string, kind: "phone" | "email" | "ip", value: string) =>
  hmacSha256Hex(pepper, `${kind}:${value}`);

/** Signed, stateless unsubscribe token: `<emailHash>.<auditId>.<mac>` (no PII inside). */
export async function signUnsubscribe(secret: string, emailHash: string, auditId: string): Promise<string> {
  const mac = await hmacSha256Hex(secret, `unsub|${emailHash}|${auditId}`);
  return `${emailHash}.${auditId}.${mac.slice(0, 32)}`;
}

export async function verifyUnsubscribe(secret: string, token: string): Promise<{ emailHash: string; auditId: string } | null> {
  const m = /^([0-9a-f]{64})\.([0-9a-f-]{36})\.([0-9a-f]{32})$/.exec(token);
  if (!m) return null;
  const expected = (await hmacSha256Hex(secret, `unsub|${m[1]}|${m[2]}`)).slice(0, 32);
  return timingSafeEqual(expected, m[3]) ? { emailHash: m[1], auditId: m[2] } : null;
}

export async function hmacSha256Bytes(secret: string, text: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}

/**
 * The owner's private report token is DERIVED (HMAC of the audit id under AUDIT_TOKEN_SECRET), so the report email can
 * be rebuilt later without ever storing the token; only its sha256 is in the database. 32 bytes => 43 url-safe chars.
 */
export async function deriveReportToken(secret: string, auditId: string): Promise<string> {
  return toBase64Url(await hmacSha256Bytes(secret, `report|${auditId}`));
}
