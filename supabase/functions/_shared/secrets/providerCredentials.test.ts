import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { deleteSecrets, hydrateRow, loadSecrets, saveSecrets } from './providerCredentials';

const KEYS = [Buffer.alloc(32, 7).toString('base64')];

// Minimal in-memory stand-in for the three Supabase call shapes the module uses.
function fakeAdmin() {
  const rows = new Map<string, { user_id: string; provider: string; ciphertext: string }>();
  const k = (u: string, p: string) => `${u}|${p}`;
  const admin = {
    from(_table: string) {
      return {
        select: () => ({
          eq: (_c1: string, u: string) => ({
            eq: (_c2: string, p: string) => ({ maybeSingle: async () => ({ data: rows.get(k(u, p)) ?? null, error: null }) }),
          }),
        }),
        upsert: async (row: { user_id: string; provider: string; ciphertext: string }) => {
          rows.set(k(row.user_id, row.provider), row);
          return { error: null };
        },
        delete: () => ({
          eq: (_c1: string, u: string) => ({
            eq: async (_c2: string, p: string) => {
              rows.delete(k(u, p));
              return { error: null };
            },
          }),
        }),
      };
    },
  };
  return { admin: admin as unknown as SupabaseClient, rows };
}

describe('providerCredentials', () => {
  it('stores ciphertext only and merges patches', async () => {
    const { admin, rows } = fakeAdmin();
    await saveSecrets(admin, 'u1', 'jobber', { jobber_access_token: 'AT1', jobber_refresh_token: 'RT1' }, { keys: KEYS });
    await saveSecrets(admin, 'u1', 'jobber', { jobber_access_token: 'AT2', jobber_refresh_token: null }, { keys: KEYS });
    const stored = rows.get('u1|jobber')!.ciphertext;
    expect(stored).not.toContain('AT');
    expect(await loadSecrets(admin, 'u1', 'jobber', KEYS)).toEqual({ jobber_access_token: 'AT2', jobber_refresh_token: 'RT1' });
  });
  it('preferExisting keeps vault values (backfill never overwrites newer tokens)', async () => {
    const { admin } = fakeAdmin();
    await saveSecrets(admin, 'u1', 'jobber', { jobber_access_token: 'NEW' }, { keys: KEYS });
    await saveSecrets(admin, 'u1', 'jobber', { jobber_access_token: 'STALE', jobber_refresh_token: 'R' }, { keys: KEYS, preferExisting: true });
    expect(await loadSecrets(admin, 'u1', 'jobber', KEYS)).toEqual({ jobber_access_token: 'NEW', jobber_refresh_token: 'R' });
  });
  it('is tenant isolated: another user gets nothing and a swapped row cannot be decrypted', async () => {
    const { admin, rows } = fakeAdmin();
    await saveSecrets(admin, 'u1', 'jobber', { jobber_access_token: 'AT' }, { keys: KEYS });
    expect(await loadSecrets(admin, 'u2', 'jobber', KEYS)).toBeNull();
    rows.set('u2|jobber', { ...rows.get('u1|jobber')!, user_id: 'u2' });
    await expect(loadSecrets(admin, 'u2', 'jobber', KEYS)).rejects.toThrow('credential_decrypt_failed');
  });
  it('hydrateRow overlays vault values and leaves legacy rows untouched', async () => {
    const { admin } = fakeAdmin();
    const legacy = { provider: 'jobber', jobber_access_token: 'LEGACY' };
    expect(await hydrateRow(admin, 'u1', legacy, KEYS)).toBe(legacy);
    await saveSecrets(admin, 'u1', 'jobber', { jobber_access_token: 'VAULT' }, { keys: KEYS });
    expect((await hydrateRow(admin, 'u1', legacy, KEYS)).jobber_access_token).toBe('VAULT');
  });
  it('deleteSecrets removes the row', async () => {
    const { admin } = fakeAdmin();
    await saveSecrets(admin, 'u1', 'hubspot', { access_token: 'x' }, { keys: KEYS });
    await deleteSecrets(admin, 'u1', 'hubspot');
    expect(await loadSecrets(admin, 'u1', 'hubspot', KEYS)).toBeNull();
  });
});
