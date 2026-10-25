// supabase/functions/_shared/data-platform/secrets.ts
//
// Envelope for every credential the Data Platform stores (warehouse passwords, service-account
// keys, API keys, embed signing secrets): AES-256-GCM with a random 96-bit IV, and the row it
// belongs to bound in as additional authenticated data. A ciphertext copied onto another row
// (or another destination) fails to decrypt instead of silently working.
//
// Required secret (never in the database, never in the browser):
//   supabase secrets set DATA_PLATFORM_ENCRYPTION_KEY=$(openssl rand -base64 32)
//
// Pure: WebCrypto only (Deno, browsers, Node 20+).

const VERSION = "v1";

export const b64url = (u: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const b64urlDecode = (s: string): Uint8Array => {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
};

async function aesKey(keyB64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = b64urlDecode(keyB64.trim());
  } catch {
    throw new Error("DATA_PLATFORM_ENCRYPTION_KEY is not valid base64.");
  }
  if (raw.length !== 32) throw new Error("DATA_PLATFORM_ENCRYPTION_KEY must be 32 bytes (openssl rand -base64 32).");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts `plain`, binding it to `aad` (e.g. "dp_destination:<uuid>"). */
export async function sealSecret(plain: string, keyB64: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
      await aesKey(keyB64),
      new TextEncoder().encode(plain),
    ),
  );
  return `${VERSION}.${b64url(iv)}.${b64url(ct)}`;
}

export async function openSecret(token: string, keyB64: string, aad: string): Promise<string> {
  const [v, iv, ct] = token.split(".");
  if (v !== VERSION || !iv || !ct) throw new Error("Unrecognised secret format.");
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(iv), additionalData: new TextEncoder().encode(aad) },
      await aesKey(keyB64),
      b64urlDecode(ct),
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error("Could not decrypt the stored credential (wrong key or tampered data). Re-enter it.");
  }
}

/** Random URL-safe secret, e.g. an embed signing secret. */
export function randomSecret(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
