// Agent Readiness — GBP read orchestration. Pure logic over an injected store, so it is unit-tested with a
// fake store and a fixture fetch. No Deno globals.
//
// Call budget (the point of the cache): a healthy account costs at most 2 Google calls (location + media) per
// OK_TTL_MS, however many manual scans or weekly runs happen. Failures are cached too, so a revoked token or an
// API-access refusal is not retried on every scan.
import { LOCATION_RE, revalidateFacts, type GbpFacts, type GbpResult, type GbpStatus } from './gbp.ts';
import { readLocation, type GbpFetch, type GbpReadFailure } from './gbpClient.ts';

export const OK_TTL_MS = 6 * 3600_000;
export const STALE_MAX_MS = 7 * 24 * 3600_000;
/** How long a failed attempt is remembered before Google is asked again. */
export const FAILURE_TTL_MS: Record<GbpReadFailure, number> = {
  forbidden: 6 * 3600_000, unauthorized: 30 * 60_000, not_found: 60 * 60_000, rate_limited: 15 * 60_000, unavailable: 5 * 60_000,
};

export interface GbpContext { connected: boolean; locationName: string | null; accountName: string | null }
export interface GbpCacheRow {
  locationName: string | null;
  /** Outcome of the LAST attempt. */
  status: GbpStatus;
  /** Facts from the last SUCCESSFUL read (kept across failures so a stale answer is possible). */
  facts: unknown;
  factsAt: string | null;
  fetchedAt: string;
}
export type TokenResult = { ok: true; token: string } | { ok: false; code: 'unauthorized' | 'unavailable' };

export interface GbpStore {
  /** Reads the integration row. Must also drop any cached facts when the integration is disconnected. */
  context(ownerId: string): Promise<GbpContext>;
  cacheGet(ownerId: string): Promise<GbpCacheRow | null>;
  cachePut(ownerId: string, row: { locationName: string; status: GbpStatus; facts: GbpFacts | null; factsAt: string | null }): Promise<void>;
  accessToken(ownerId: string): Promise<TokenResult>;
}
export interface GbpDeps { enabled: boolean; now: () => number; fetch: GbpFetch }

const none = (status: GbpStatus): GbpResult => ({ status, facts: null, stale: false, fetchedAt: null });
const ms = (iso: string | null): number => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : 0; };

export async function getGbpResult(store: GbpStore, ownerId: string, deps: GbpDeps): Promise<GbpResult> {
  if (!deps.enabled) return none('disabled');
  let ctx: GbpContext;
  try { ctx = await store.context(ownerId); } catch { return none('unavailable'); }
  if (!ctx.connected) return none('not_connected');
  if (!ctx.locationName || !LOCATION_RE.test(ctx.locationName)) return none('no_location');

  let cache: GbpCacheRow | null = null;
  try { cache = await store.cacheGet(ownerId); } catch { cache = null; }
  if (cache && cache.locationName !== ctx.locationName) cache = null; // a different location: never reuse
  const now = deps.now();
  const lastGood = cache ? revalidateFacts(cache.facts) : null;
  const goodAge = cache?.factsAt ? now - ms(cache.factsAt) : Infinity;
  const usableStale = lastGood !== null && goodAge <= STALE_MAX_MS;

  if (cache && lastGood && cache.status === 'ok' && goodAge < OK_TTL_MS) {
    return { status: 'ok', facts: lastGood, stale: false, fetchedAt: cache.factsAt };
  }
  if (cache && cache.status !== 'ok' && cache.status in FAILURE_TTL_MS && now - ms(cache.fetchedAt) < FAILURE_TTL_MS[cache.status as GbpReadFailure]) {
    // A recent failure: do not ask Google again yet. Deleted locations never fall back to old facts.
    const keep = usableStale && cache.status !== 'not_found';
    return { status: cache.status, facts: keep ? lastGood : null, stale: keep, fetchedAt: keep ? cache.factsAt : null };
  }

  const record = async (status: GbpStatus, facts: GbpFacts | null, factsAt: string | null): Promise<void> => {
    try { await store.cachePut(ownerId, { locationName: ctx.locationName as string, status, facts, factsAt }); } catch { /* best effort */ }
  };
  const fail = async (code: GbpReadFailure): Promise<GbpResult> => {
    const keep = usableStale && code !== 'not_found';
    await record(code, keep ? lastGood : null, keep ? (cache?.factsAt ?? null) : null);
    return { status: code, facts: keep ? lastGood : null, stale: keep, fetchedAt: keep ? (cache?.factsAt ?? null) : null };
  };

  const tok = await store.accessToken(ownerId).catch((): TokenResult => ({ ok: false, code: 'unavailable' }));
  if (!tok.ok) return fail(tok.code);
  const out = await readLocation(deps.fetch, tok.token, ctx.locationName, ctx.accountName);
  if (!out.ok) return fail(out.code);

  // A transient media failure must not erase a known photo count.
  const facts: GbpFacts = out.facts.photoCount === null && lastGood?.photoCount != null && ctx.accountName ? { ...out.facts, photoCount: lastGood.photoCount } : out.facts;
  const at = new Date(now).toISOString();
  await record('ok', facts, at);
  return { status: 'ok', facts, stale: false, fetchedAt: at };
}
