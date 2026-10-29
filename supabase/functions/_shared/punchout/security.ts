// Crypto helpers for PunchOut shared secrets + one-time BuyerCookies. Web Crypto only (Deno).
// Secret: PUNCHOUT_ENCRYPTION_KEY = base64 of 32 random bytes   (openssl rand -base64 32)

const enc = new TextEncoder();
const toB64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toHex = (buf: ArrayBuffer | Uint8Array) => Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

async function aesKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("PUNCHOUT_ENCRYPTION_KEY");
  if (!raw) throw new Error("PUNCHOUT_ENCRYPTION_KEY is not set.");
  const bytes = fromB64(raw.trim());
  if (bytes.length !== 32) throw new Error("PUNCHOUT_ENCRYPTION_KEY must decode to 32 bytes.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), enc.encode(plain));
  return `v1:${toB64(iv)}:${toB64(new Uint8Array(ct))}`;
}

export async function decryptSecret(payload: string): Promise<string> {
  const [v, iv, ct] = payload.split(":");
  if (v !== "v1" || !iv || !ct) throw new Error("Unsupported secret format.");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, await aesKey(), fromB64(ct));
  return new TextDecoder().decode(pt);
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export function randomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}
