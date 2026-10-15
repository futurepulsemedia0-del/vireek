// Pure Web-Crypto helpers (Deno + Node 18+). No imports.

const enc = new TextEncoder();
const dec = new TextDecoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64decode(b64: string) {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Constant-time string comparison (length leak only). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------------- Slack request signing ----------------
const SLACK_MAX_SKEW_SECONDS = 60 * 5;

export async function computeSlackSignature(signingSecret: string, timestamp: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${rawBody}`));
  return `v0=${toHex(sig)}`;
}

export async function verifySlackSignature(
  signingSecret: string,
  timestamp: string | null,
  signature: string | null,
  rawBody: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!signingSecret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > SLACK_MAX_SKEW_SECONDS) return false;
  return timingSafeEqual(await computeSlackSignature(signingSecret, timestamp, rawBody), signature);
}

// ---------------- Token encryption at rest (AES-256-GCM) ----------------
async function importAesKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64decode(keyB64);
  if (raw.length !== 32) throw new Error("CHAT_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string, keyB64: string): Promise<string> {
  const key = await importAesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
  return `v1.${b64encode(iv)}.${b64encode(new Uint8Array(ct))}`;
}

export async function decryptSecret(blob: string, keyB64: string): Promise<string> {
  const [version, ivB64, ctB64] = blob.split(".");
  if (version !== "v1" || !ivB64 || !ctB64) throw new Error("Unsupported secret format.");
  const key = await importAesKey(keyB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(ivB64) }, key, b64decode(ctB64));
  return dec.decode(pt);
}

// ---------------- Teams helpers ----------------
/** The Bot Framework serviceUrl later receives our bot bearer token, so only Microsoft hosts are acceptable. */
export function isTrustedServiceUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /(^|\.)(trafficmanager\.net|botframework\.com|microsoft\.com|microsoft\.us|microsoftonline\.com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

export function normalizeServiceUrl(raw: string): string {
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/** Decodes (does NOT verify) a JWT payload. Only use for tokens received directly from the issuer's token endpoint. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(dec.decode(b64decode(b64))) as Record<string, unknown>;
  } catch {
    return null;
  }
}
