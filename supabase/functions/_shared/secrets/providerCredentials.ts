// supabase/functions/_shared/secrets/providerCredentials.ts
//
// Server-side access layer for the `provider_credentials` table (service role ONLY: RLS on, no policies, grants revoked).
// Replaces plaintext token columns (price_book_connections.*) and token JSON in integrations.config.
//
// REQUIRED SECRET:  PROVIDER_CREDENTIALS_KEY            $(openssl rand -base64 32)
// OPTIONAL (rotation): PROVIDER_CREDENTIALS_KEY_PREV    the old key while re-sealing
//
// Reader pattern for existing code:  row = await hydrateRow(admin, userId, row)
//   - vault value wins; if no vault row exists yet (pre-backfill) the legacy plaintext column is used unchanged.
// Writer pattern:                    await saveSecrets(admin, userId, provider, { access_token, refresh_token })

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildAad, openJson, parseKeyList, sealJson } from "./credentialVault.ts";

export type CredentialProvider =
  | "jobber"
  | "service_titan"
  | "housecall_pro"
  | "hubspot"
  | "google_calendar"
  | "google_business_profile";

export type SecretBag = Record<string, string>;

/** Secret columns that live on price_book_connections today; they are overlaid from the vault by hydrateRow. */
export const PRICE_BOOK_SECRET_COLUMNS = [
  "jobber_access_token",
  "jobber_refresh_token",
  "st_client_secret",
  "st_app_key",
  "hcp_api_key",
] as const;

const TABLE = "provider_credentials";

/** Reads the key(s) from the edge-function environment. Throws if none is configured (never falls back to plaintext). */
export function credentialKeysFromEnv(): string[] {
  const keys = parseKeyList(Deno.env.get("PROVIDER_CREDENTIALS_KEY"), Deno.env.get("PROVIDER_CREDENTIALS_KEY_PREV"));
  if (keys.length === 0) throw new Error("credential_key_missing");
  return keys;
}

export async function loadSecrets(
  admin: SupabaseClient,
  userId: string,
  provider: CredentialProvider,
  keys: string[] = credentialKeysFromEnv(),
): Promise<SecretBag | null> {
  const { data, error } = await admin.from(TABLE).select("ciphertext").eq("user_id", userId).eq("provider", provider).maybeSingle();
  if (error) throw new Error(`credential_read_failed`);
  if (!data) return null;
  return openJson((data as { ciphertext: string }).ciphertext, keys, buildAad(userId, provider));
}

export interface SaveOptions {
  /** Backfill mode: keep values already in the vault, only add missing keys. */
  preferExisting?: boolean;
  keys?: string[];
}

/** Merges `patch` into the stored bag (null/undefined/empty values are ignored) and re-seals with the current key. */
export async function saveSecrets(
  admin: SupabaseClient,
  userId: string,
  provider: CredentialProvider,
  patch: Record<string, string | null | undefined>,
  opts: SaveOptions = {},
): Promise<void> {
  const keys = opts.keys ?? credentialKeysFromEnv();
  const existing = (await loadSecrets(admin, userId, provider, keys)) ?? {};
  const merged: SecretBag = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v !== "string" || v.length === 0) continue;
    if (opts.preferExisting && typeof existing[k] === "string") continue;
    merged[k] = v;
  }
  if (Object.keys(merged).length === 0) return;
  const ciphertext = await sealJson(merged, keys[0], buildAad(userId, provider));
  const { error } = await admin
    .from(TABLE)
    .upsert({ user_id: userId, provider, ciphertext, key_version: 1, updated_at: new Date().toISOString() }, { onConflict: "user_id,provider" });
  if (error) throw new Error("credential_write_failed");
}

export async function deleteSecrets(admin: SupabaseClient, userId: string, provider: CredentialProvider): Promise<void> {
  const { error } = await admin.from(TABLE).delete().eq("user_id", userId).eq("provider", provider);
  if (error) throw new Error("credential_delete_failed");
}

/**
 * Overlays vault values onto a connection row (keys of the bag == column names). Rows without a vault entry are
 * returned unchanged so legacy plaintext keeps working until the backfill has run.
 */
export async function hydrateRow<T extends { provider: string }>(
  admin: SupabaseClient,
  userId: string,
  row: T,
  keys: string[] = credentialKeysFromEnv(),
): Promise<T> {
  const bag = await loadSecrets(admin, userId, row.provider as CredentialProvider, keys);
  return bag ? ({ ...row, ...bag } as T) : row;
}
