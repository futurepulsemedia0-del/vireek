// supabase/functions/_shared/bank/crypto.ts
// AES-256-GCM encryption for provider access tokens at rest.
// Required secret: supabase secrets set BANK_TOKEN_KEY=$(openssl rand -base64 32)

async function key(): Promise<CryptoKey> {
  const raw = Deno.env.get("BANK_TOKEN_KEY");
  if (!raw) throw new Error("BANK_TOKEN_KEY is not configured.");
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("BANK_TOKEN_KEY must be 32 bytes, base64 encoded.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptToken(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(plain)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function decryptToken(enc: string): Promise<string> {
  const [v, iv, ct] = enc.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Unsupported token format.");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(), unb64(ct));
  return new TextDecoder().decode(pt);
}
