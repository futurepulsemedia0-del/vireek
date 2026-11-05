// supabase/functions/_shared/secrets/credentialVault.ts
//
// Application-level envelope for third-party credentials (Jobber, ServiceTitan, Housecall Pro, HubSpot, Google).
// AES-256-GCM with a random 96-bit IV per seal and ASSOCIATED DATA bound to (user, provider): a ciphertext copied
// into another tenant's row (or another provider's) fails authentication instead of decrypting.
//
// Token format:  v2.<iv b64url>.<ciphertext+tag b64url>
// Keys: base64 / base64url of exactly 32 random bytes  ->  openssl rand -base64 32
// Rotation: seal with keys[0]; open tries every key in order (current first, then previous).
// This module is pure (no network, no Deno globals) so it is unit-testable in Vitest.

const VERSION = "v2";

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = b64urlDecode(keyB64.trim());
  } catch {
    throw new Error("credential_key_invalid");
  }
  if (raw.length !== 32) throw new Error("credential_key_invalid");
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Associated data that pins a ciphertext to one tenant + one provider. */
export function buildAad(userId: string, provider: string): string {
  return `vireek:provider-credentials:${VERSION}:${userId}:${provider}`;
}

/** Current key first, previous key (during rotation) second. Empty values are ignored. */
export function parseKeyList(current: string | undefined | null, previous: string | undefined | null): string[] {
  return [current, previous].map((k) => (k ?? "").trim()).filter((k) => k.length > 0);
}

export async function sealJson(value: Record<string, string>, keyB64: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
      await importKey(keyB64),
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );
  return `${VERSION}.${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}

export async function openJson(token: string, keys: string[], aad: string): Promise<Record<string, string>> {
  const [v, iv, ct] = token.split(".");
  if (v !== VERSION || !iv || !ct) throw new Error("credential_format_unrecognised");
  if (keys.length === 0) throw new Error("credential_key_missing");
  let lastErr: unknown = null;
  for (const keyB64 of keys) {
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64urlDecode(iv) as BufferSource, additionalData: new TextEncoder().encode(aad) },
        await importKey(keyB64),
        b64urlDecode(ct) as BufferSource,
      );
      const parsed: unknown = JSON.parse(new TextDecoder().decode(pt));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("credential_payload_invalid");
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof val === "string") out[k] = val;
      }
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(lastErr instanceof Error && lastErr.message === "credential_key_invalid" ? "credential_key_invalid" : "credential_decrypt_failed");
}
