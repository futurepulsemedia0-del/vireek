import { supabase } from '@/lib/supabase';
import type { KeyMode } from '../../supabase/functions/api-v1/contract';

export type { KeyMode };

/**
 * Real, self-serve API key management — key generation + hashing happens
 * entirely client-side with the Web Crypto API (same primitive the
 * `api-v1` edge function uses to verify keys server-side). Only the hash
 * and a short display prefix are ever written to the database; the raw
 * key is returned ONCE, at creation, and never again.
 */

export const API_SCOPES = [
  'calls:read',
  'leads:read',
  'jobs:read',
  'verticals:read',
  'assistants:read',
  'assistants:write',
  'numbers:read',
  'numbers:write',
  'webhooks:read',
  'webhooks:write',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Pre-selected when creating a key. Write scopes are always an explicit opt-in. */
export const DEFAULT_API_SCOPES: ApiScope[] = ['calls:read', 'leads:read', 'jobs:read'];

export const SCOPE_LABELS: Record<ApiScope, string> = {
  'calls:read': 'Read calls (recordings, transcripts, summaries)',
  'leads:read': 'Read leads',
  'jobs:read': 'Read jobs',
  'verticals:read': 'Read industry template packs (Voice Platform)',
  'assistants:read': 'Read voice assistants (Voice Platform)',
  'assistants:write': 'Create, update and delete voice assistants (Voice Platform)',
  'numbers:read': 'Read voice numbers (Voice Platform)',
  'numbers:write': 'Buy and release phone numbers — billable (Voice Platform)',
  'webhooks:read': 'Read webhook endpoints',
  'webhooks:write': 'Create and delete webhook endpoints',
};

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: ApiScope[];
  last_used_at: string | null;
  last_used_ip: string | null;
  mode: KeyMode;
  /** Empty = any address. */
  ip_allowlist: string[];
  created_at: string;
  revoked_at: string | null;
}

const KEY_COLUMNS = 'id, name, key_prefix, scopes, last_used_at, last_used_ip, mode, ip_allowlist, created_at, revoked_at';

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes.buffer);
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(digest);
}

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  const { data, error } = await supabase
    .from('api_keys')
    .select(KEY_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ApiKeyRow[];
}

/** Creates a key and returns the ONE-TIME raw value the user must copy now. */
export async function createApiKey(
  name: string,
  scopes: ApiScope[],
  userId: string,
  opts: { mode?: KeyMode; ipAllowlist?: string[] } = {},
): Promise<{ row: ApiKeyRow; rawKey: string }> {
  const mode: KeyMode = opts.mode ?? 'live';
  const secret = randomToken(24); // 48 hex chars of entropy
  const rawKey = `vrk_${mode}_${secret}`;
  const key_prefix = rawKey.slice(0, 14); // "vrk_live_" / "vrk_test_" + 5 chars, safe to display forever
  const key_hash = await sha256Hex(rawKey);

  const { data, error } = await supabase
    .from('api_keys')
    .insert({ user_id: userId, name, scopes, key_prefix, key_hash, mode, ip_allowlist: opts.ipAllowlist ?? [] })
    .select(KEY_COLUMNS)
    .single();
  if (error) throw error;
  return { row: data as ApiKeyRow, rawKey };
}

export async function revokeApiKey(id: string): Promise<void> {
  const { error } = await supabase.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function updateIpAllowlist(id: string, list: string[]): Promise<void> {
  const { error } = await supabase.from('api_keys').update({ ip_allowlist: list }).eq('id', id);
  if (error) throw error;
}

/**
 * Rotation = issue the replacement FIRST, then revoke the old key, so a failure can never leave the
 * account without a working key. Mode and IP allowlist carry over. `oldRevoked: false` means the new key
 * exists but revoking the old one failed — tell the user to revoke it manually.
 */
export async function rotateApiKey(
  old: Pick<ApiKeyRow, 'id' | 'name' | 'scopes' | 'mode' | 'ip_allowlist'>,
  userId: string,
): Promise<{ row: ApiKeyRow; rawKey: string; oldRevoked: boolean }> {
  const created = await createApiKey(`${old.name} (rotated)`, old.scopes, userId, { mode: old.mode, ipAllowlist: old.ip_allowlist });
  try {
    await revokeApiKey(old.id);
    return { ...created, oldRevoked: true };
  } catch {
    return { ...created, oldRevoked: false };
  }
}
