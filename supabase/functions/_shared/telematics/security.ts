// Crypto helpers for telematics credentials + webhook auth. Web Crypto only (Deno).
// Secret: TELEMATICS_ENCRYPTION_KEY = base64 of 32 random bytes  (openssl rand -base64 32)

const enc = new TextEncoder();
const toB64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

async function aesKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("TELEMATICS_ENCRYPTION_KEY");
  if (!raw) throw new Error("TELEMATICS_ENCRYPTION_KEY is not set.");
  const bytes = fromB64(raw.trim());
  if (bytes.length !== 32) throw new Error("TELEMATICS_ENCRYPTION_KEY must decode to 32 bytes.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson(value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), enc.encode(JSON.stringify(value)));
  return `v1:${toB64(iv)}:${toB64(new Uint8Array(ct))}`;
}

export async function decryptJson<T>(payload: string): Promise<T> {
  const [v, iv, ct] = payload.split(":");
  if (v !== "v1" || !iv || !ct) throw new Error("Unsupported credential format.");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, await aesKey(), fromB64(ct));
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export function randomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Samsara webhook signature: header X-Samsara-Signature = "v1=<hex>", where hex is
 * HMAC-SHA256(base64-decoded webhook secret, `v1:${X-Samsara-Timestamp}:${rawBody}`).
 */
export async function verifySamsaraSignature(rawBody: string, timestamp: string, header: string, secretB64: string, toleranceS = 300): Promise<boolean> {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceS) return false;
  try {
    const key = await crypto.subtle.importKey("raw", fromB64(secretB64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`v1:${timestamp}:${rawBody}`));
    return timingSafeEqualStr(`v1=${toHex(sig)}`, header.trim());
  } catch {
    return false;
  }
}

/** Optional HMAC for the generic webhook: header x-telematics-signature = hex(HMAC-SHA256(token, `${ts}.${body}`)). */
export async function verifyGenericSignature(rawBody: string, timestamp: string, header: string, token: string, toleranceS = 300): Promise<boolean> {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceS) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${rawBody}`));
  return timingSafeEqualStr(toHex(sig), header.trim().toLowerCase());
}

export function jsonResponse(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret, X-Telematics-Token, X-Telematics-Timestamp, X-Telematics-Signature",
      "Content-Type": "application/json",
      ...extra,
    },
  });
}

export const corsPreflight = () => jsonResponse(null, 200);
