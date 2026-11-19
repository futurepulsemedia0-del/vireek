// Agent Readiness — Supabase-backed GbpStore. Edge-function only (uses Deno.env + the shared credential vault).
// Tokens are read from the vault (`provider_credentials`, provider `google_business_profile`) and never leave this
// module: not into the cache table, not into logs, not into the scan payload.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { loadSecrets, saveSecrets } from '../secrets/providerCredentials.ts';
import { refreshAccessToken, type GbpFetch } from './gbpClient.ts';
import type { GbpCacheRow, GbpContext, GbpDeps, GbpStore, TokenResult } from './gbpProvider.ts';

interface CtxRow { connected?: boolean; location_name?: string | null; account_name?: string | null; expires_at?: string | null }

export function supabaseGbpStore(admin: SupabaseClient, doFetch: GbpFetch, now: () => number): GbpStore {
  const ctxByOwner = new Map<string, CtxRow>();
  return {
    async context(ownerId): Promise<GbpContext> {
      const { data, error } = await admin.rpc('agent_readiness_gbp_context', { p_user: ownerId });
      if (error) throw new Error('gbp_context_failed');
      const row = (data ?? {}) as CtxRow;
      ctxByOwner.set(ownerId, row);
      return { connected: row.connected === true, locationName: row.location_name ?? null, accountName: row.account_name ?? null };
    },
    async cacheGet(ownerId): Promise<GbpCacheRow | null> {
      const { data, error } = await admin.rpc('agent_readiness_gbp_cache_get', { p_user: ownerId });
      if (error || !data) return null;
      const r = data as { location_name?: string | null; status?: string; facts?: unknown; facts_at?: string | null; fetched_at?: string };
      if (!r.status || !r.fetched_at) return null;
      return { locationName: r.location_name ?? null, status: r.status as GbpCacheRow['status'], facts: r.facts ?? null, factsAt: r.facts_at ?? null, fetchedAt: r.fetched_at };
    },
    async cachePut(ownerId, row): Promise<void> {
      const { error } = await admin.rpc('agent_readiness_gbp_cache_put', {
        p_user: ownerId, p_location: row.locationName, p_status: row.status, p_facts: row.facts, p_facts_at: row.factsAt,
      });
      if (error) throw new Error('gbp_cache_put_failed');
    },
    async accessToken(ownerId): Promise<TokenResult> {
      let bag: Record<string, string> | null = null;
      try { bag = await loadSecrets(admin, ownerId, 'google_business_profile'); } catch { return { ok: false, code: 'unavailable' }; }
      const ctx = ctxByOwner.get(ownerId);
      const expiresAt = ctx?.expires_at ? Date.parse(ctx.expires_at) : 0;
      if (bag?.access_token && expiresAt > now() + 60_000) return { ok: true, token: bag.access_token };
      const clientId = Deno.env.get('GOOGLE_BUSINESS_CLIENT_ID') ?? '';
      const clientSecret = Deno.env.get('GOOGLE_BUSINESS_CLIENT_SECRET') ?? '';
      if (!bag?.refresh_token) return { ok: false, code: 'unauthorized' };
      if (!clientId || !clientSecret) return { ok: false, code: 'unavailable' };
      const tok = await refreshAccessToken(doFetch, clientId, clientSecret, bag.refresh_token, now);
      if (!tok.ok) return tok;
      try {
        await saveSecrets(admin, ownerId, 'google_business_profile', { access_token: tok.accessToken });
        await admin.rpc('agent_readiness_gbp_set_expiry', { p_user: ownerId, p_expires_at: tok.expiresAt });
      } catch (err) {
        console.error(JSON.stringify({ event: 'gbp_token_persist_failed', error: err instanceof Error ? err.message : 'unknown' }));
      }
      return { ok: true, token: tok.accessToken };
    },
  };
}

/** Production wiring: the read is off unless GBP_READ_ENABLED=true (set it only after Google approves API access). */
export function productionGbp(admin: SupabaseClient): { store: GbpStore; deps: GbpDeps } {
  const doFetch: GbpFetch = (url, init) => fetch(url, init);
  const now = (): number => Date.now();
  return { store: supabaseGbpStore(admin, doFetch, now), deps: { enabled: Deno.env.get('GBP_READ_ENABLED') === 'true', now, fetch: doFetch } };
}
