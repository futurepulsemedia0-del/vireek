import { supabase } from '@/lib/supabase';

/**
 * Real, self-serve API key management — key generation + hashing happens
 * entirely client-side with the Web Crypto API (same primitive the
 * `api-v1` edge function uses to verify keys server-side). Only the hash
 * and a short display prefix are ever written to the database; the raw
 * key is returned ONCE, at creation, and never again.
 */

export const API_SCOPES = ['calls:read', 'leads:read', 'jobs:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_LABELS: Record<ApiScope, string> = {
  'calls:read': 'Read calls (recordings, transcripts, summaries)',
  'leads:read': 'Read leads',
  'jobs:read': 'Read jobs',
};

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: ApiScope[];
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

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
    .select('id, name, key_prefix, scopes, last_used_at, created_at, revoked_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ApiKeyRow[];
}

/** Creates a key and returns the ONE-TIME raw value the user must copy now. */
export async function createApiKey(name: string, scopes: ApiScope[], userId: string): Promise<{ row: ApiKeyRow; rawKey: string }> {
  const secret = randomToken(24); // 48 hex chars of entropy
  const rawKey = `vrk_live_${secret}`;
  const key_prefix = rawKey.slice(0, 14); // "vrk_live_" + 5 chars, safe to display forever
  const key_hash = await sha256Hex(rawKey);

  const { data, error } = await supabase
    .from('api_keys')
    .insert({ user_id: userId, name, scopes, key_prefix, key_hash })
    .select('id, name, key_prefix, scopes, last_used_at, created_at, revoked_at')
    .single();
  if (error) throw error;
  return { row: data as ApiKeyRow, rawKey };
}

export async function revokeApiKey(id: string): Promise<void> {
  const { error } = await supabase.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

/** Rotation = revoke the old key + issue a brand new one under the same name. */
export async function rotateApiKey(id: string, name: string, scopes: ApiScope[], userId: string): Promise<{ row: ApiKeyRow; rawKey: string }> {
  await revokeApiKey(id);
  return createApiKey(`${name} (rotated)`, scopes, userId);
}
