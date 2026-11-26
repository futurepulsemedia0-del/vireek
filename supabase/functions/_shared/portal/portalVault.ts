// supabase/functions/_shared/portal/portalVault.ts
// Portal credentials reuse the existing AES-256-GCM envelope (../secrets/credentialVault.ts) with a NEW AAD that binds the
// ciphertext to (account, profile). The key comes from PROVIDER_CREDENTIALS_KEY(/_PREV) - the existing secret mechanism - so there is
// no new key to manage; a dedicated PORTAL_CREDENTIALS_KEY is used when set (recommended: separate blast radius). [VERIFY] key present.
import { openJson, parseKeyList, sealJson } from "../secrets/credentialVault.ts";

export const PORTAL_SECRET_FIELDS = ["username", "password", "api_key", "shared_secret"] as const;
export type PortalSecretField = (typeof PORTAL_SECRET_FIELDS)[number];

export function portalAad(userId: string, profileId: string): string {
  return `vireek:portal-credentials:v1:${userId}:${profileId}`;
}
export function portalKeys(env: (k: string) => string | undefined): string[] {
  const dedicated = parseKeyList(env("PORTAL_CREDENTIALS_KEY"), env("PORTAL_CREDENTIALS_KEY_PREV"));
  return dedicated.length ? dedicated : parseKeyList(env("PROVIDER_CREDENTIALS_KEY"), env("PROVIDER_CREDENTIALS_KEY_PREV"));
}

/** Validates + trims a write-only payload. Unknown fields are rejected; empty values are dropped. */
export function sanitizeSecretInput(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!(PORTAL_SECRET_FIELDS as readonly string[]).includes(k)) throw new Error("secret_field_not_allowed");
    if (typeof v !== "string") throw new Error("secret_value_invalid");
    const t = v.trim();
    if (t.length === 0) continue;
    if (t.length > 512) throw new Error("secret_value_too_long");
    out[k] = t;
  }
  if (Object.keys(out).length === 0) throw new Error("secret_empty");
  return out;
}

export const sealPortalSecrets = (bag: Record<string, string>, key: string, userId: string, profileId: string) => sealJson(bag, key, portalAad(userId, profileId));
export const openPortalSecrets = (token: string, keys: string[], userId: string, profileId: string) => openJson(token, keys, portalAad(userId, profileId));

/** The ONLY shape the API may return about stored credentials. Values never leave the server. */
export interface CredentialMeta { has_secret: boolean; fields: string[]; updated_at: string | null; rotated_at: string | null }
