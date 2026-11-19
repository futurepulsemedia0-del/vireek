import { describe, expect, it } from 'vitest';
import { LOCATION_READ_MASK, parseLocation, parseMediaCount, revalidateFacts, type GbpFacts, type GbpResult } from './gbp.ts';
import { failureFor, readLocation, refreshAccessToken, type GbpFetch } from './gbpClient.ts';
import { FAILURE_TTL_MS, OK_TTL_MS, STALE_MAX_MS, getGbpResult, type GbpCacheRow, type GbpContext, type GbpStore, type TokenResult } from './gbpProvider.ts';
import { buildFixes, gbpCheck, scoreAccount, type Snapshot } from './engine.ts';
import { summarizeGbp } from './runScan.ts';

// ---- fixtures (shapes follow Google's Business Information API v1 Location resource) ----
const LOCATION_FIXTURE = {
  name: 'locations/123456789', title: 'Acme Plumbing',
  phoneNumbers: { primaryPhone: '(512) 555-0100', additionalPhones: ['(512) 555-0111'] },
  categories: { primaryCategory: { name: 'categories/gcid:plumber', displayName: 'Plumber' }, additionalCategories: [{ name: 'categories/gcid:water_heater_installation_service', displayName: 'Water heater installation service' }] },
  storefrontAddress: { regionCode: 'US', administrativeArea: 'TX', locality: 'Austin', postalCode: '78701', addressLines: ['1 Main St'] },
  websiteUri: 'https://acme-plumbing.com',
  regularHours: { periods: [{ openDay: 'MONDAY' }, { openDay: 'MONDAY' }, { openDay: 'TUESDAY' }, { openDay: 'FRIDAY' }] },
  specialHours: { specialHourPeriods: [{}, {}] },
  serviceItems: [{}, {}, {}],
  profile: { description: 'x'.repeat(300) },
  openInfo: { status: 'OPEN' },
  metadata: { hasVoiceOfMerchant: true },
};
const MEDIA_FIXTURE = { totalMediaItemCount: 12, mediaItems: [{}] };

const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const bad = (status: number) => ({ ok: false, status, text: async () => '{"error":"x"}' });
interface Call { url: string; method: string; auth: string | undefined }

function fakeFetch(handler: (url: string) => ReturnType<GbpFetch> | Awaited<ReturnType<GbpFetch>>): { fetch: GbpFetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => { calls.push({ url, method: init.method, auth: init.headers.Authorization }); return handler(url); },
  };
}
const routes = (over: Partial<Record<'info' | 'media', unknown>> = {}) => (url: string) => {
  if (url.includes('mybusinessbusinessinformation')) return over.info === undefined ? ok(LOCATION_FIXTURE) : (over.info as Awaited<ReturnType<GbpFetch>>);
  return over.media === undefined ? ok(MEDIA_FIXTURE) : (over.media as Awaited<ReturnType<GbpFetch>>);
};

describe('parseLocation', () => {
  it('reduces a full Location to the facts the scorer needs', () => {
    const f = parseLocation(LOCATION_FIXTURE) as GbpFacts;
    expect(f.title).toBe('Acme Plumbing');
    expect(f.primaryCategory).toBe('Plumber');
    expect(f.additionalCategories).toBe(1);
    expect(f.phone).toBe('(512) 555-0100');
    expect(f.additionalPhones).toBe(1);
    expect(f.openDays).toBe(3); // MONDAY counted once
    expect(f.specialHoursPeriods).toBe(2);
    expect(f.serviceItems).toBe(3);
    expect(f.descriptionLength).toBe(300);
    expect(f.openStatus).toBe('OPEN');
    expect(f.voiceOfMerchant).toBe(true);
    expect(f.photoCount).toBeNull();
    expect(f.address).toEqual({ lines: ['1 Main St'], locality: 'Austin', region: 'TX', postalCode: '78701', country: 'US' });
  });
  it('never stores the raw payload (no unknown key survives)', () => {
    const f = parseLocation({ ...LOCATION_FIXTURE, secretNote: 'do-not-keep', latlng: { latitude: 1 } }) as unknown as Record<string, unknown>;
    expect(JSON.stringify(f)).not.toContain('do-not-keep');
    expect(Object.keys(f).sort()).toEqual(['additionalCategories', 'additionalPhones', 'address', 'descriptionLength', 'openDays', 'openStatus', 'phone', 'photoCount', 'primaryCategory', 'serviceItems', 'specialHoursPeriods', 'title', 'voiceOfMerchant', 'website']);
  });
  it('tolerates missing, empty and wrongly typed fields', () => {
    expect(parseLocation(null)).toBeNull();
    expect(parseLocation('x')).toBeNull();
    expect(parseLocation([])).toBeNull();
    const f = parseLocation({ categories: 'nope', phoneNumbers: 7, regularHours: { periods: 'x' }, serviceItems: {}, profile: { description: 9 }, metadata: { hasVoiceOfMerchant: 'yes' }, openInfo: { status: 'WEIRD' } }) as GbpFacts;
    expect(f.primaryCategory).toBeNull();
    expect(f.additionalCategories).toBe(0);
    expect(f.openDays).toBe(0);
    expect(f.serviceItems).toBe(0);
    expect(f.descriptionLength).toBe(0);
    expect(f.voiceOfMerchant).toBeNull();
    expect(f.openStatus).toBe('UNSPECIFIED');
  });
  it('truncates hostile oversized strings', () => {
    const f = parseLocation({ title: 'T'.repeat(10_000), profile: { description: 'd'.repeat(50_000) } }) as GbpFacts;
    expect((f.title ?? '').length).toBe(200);
    expect(f.descriptionLength).toBe(2000);
  });
  it('maps the unspecified open status and keeps closed statuses', () => {
    expect((parseLocation({ openInfo: { status: 'OPEN_FOR_BUSINESS_UNSPECIFIED' } }) as GbpFacts).openStatus).toBe('UNSPECIFIED');
    expect((parseLocation({ openInfo: { status: 'CLOSED_PERMANENTLY' } }) as GbpFacts).openStatus).toBe('CLOSED_PERMANENTLY');
    expect((parseLocation({}) as GbpFacts).openStatus).toBeNull();
  });
});

describe('parseMediaCount / revalidateFacts', () => {
  it('reads the media total, zero for an empty list, null for junk', () => {
    expect(parseMediaCount({ totalMediaItemCount: 7 })).toBe(7);
    expect(parseMediaCount({ mediaItems: [] })).toBe(0);
    expect(parseMediaCount({})).toBe(0);
    expect(parseMediaCount({ totalMediaItemCount: -1 })).toBeNull();
    expect(parseMediaCount({ totalMediaItemCount: '7' })).toBeNull();
    expect(parseMediaCount(null)).toBeNull();
  });
  it('round-trips facts through the cache shape and rejects junk', () => {
    const f = { ...(parseLocation(LOCATION_FIXTURE) as GbpFacts), photoCount: 3 };
    expect(revalidateFacts(JSON.parse(JSON.stringify(f)))).toEqual(f);
    expect(revalidateFacts(null)).toBeNull();
    const junk = revalidateFacts({ primaryCategory: 5, openDays: 99, photoCount: -4, openStatus: 'X', voiceOfMerchant: 'no' }) as GbpFacts;
    expect(junk.primaryCategory).toBeNull();
    expect(junk.openDays).toBe(7);
    expect(junk.photoCount).toBeNull();
    expect(junk.openStatus).toBeNull();
    expect(junk.voiceOfMerchant).toBeNull();
  });
});

describe('readLocation (fixture fetch, read-only)', () => {
  it('reads location + media with GET and a bearer token only', async () => {
    const { fetch, calls } = fakeFetch(routes());
    const out = await readLocation(fetch, 'tok', 'locations/123', 'accounts/9');
    expect(out.ok).toBe(true);
    if (out.ok) { expect(out.facts.primaryCategory).toBe('Plumber'); expect(out.facts.photoCount).toBe(12); }
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.method === 'GET' && c.auth === 'Bearer tok')).toBe(true);
    expect(calls[0].url).toContain(`readMask=${encodeURIComponent(LOCATION_READ_MASK)}`);
    expect(calls[1].url).toContain('/accounts/9/locations/123/media');
  });
  it('skips the media call without an account id and leaves photoCount null', async () => {
    const { fetch, calls } = fakeFetch(routes());
    const out = await readLocation(fetch, 'tok', 'locations/123', null);
    expect(calls).toHaveLength(1);
    expect(out.ok && out.facts.photoCount).toBeNull();
  });
  it('a failing media call never fails the read', async () => {
    const { fetch } = fakeFetch(routes({ media: bad(500) }));
    const out = await readLocation(fetch, 'tok', 'locations/123', 'accounts/9');
    expect(out.ok && out.facts.photoCount).toBeNull();
  });
  it('rejects malformed location and account names before any network call', async () => {
    const { fetch, calls } = fakeFetch(routes());
    for (const bad of ['locations/../x', 'accounts/1', 'locations/12a', '', 'locations/1?x=y']) {
      expect(await readLocation(fetch, 'tok', bad, null)).toEqual({ ok: false, code: 'not_found' });
    }
    await readLocation(fetch, 'tok', 'locations/123', 'accounts/1/../2');
    expect(calls).toHaveLength(1); // the bad account name only skipped the media call
  });
  it('maps HTTP statuses to stable failure codes', async () => {
    expect(failureFor(401)).toBe('unauthorized');
    expect(failureFor(403)).toBe('forbidden');
    expect(failureFor(404)).toBe('not_found');
    expect(failureFor(429)).toBe('rate_limited');
    expect(failureFor(503)).toBe('unavailable');
    for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'], [429, 'rate_limited'], [500, 'unavailable']] as const) {
      const { fetch } = fakeFetch(routes({ info: bad(status) }));
      expect(await readLocation(fetch, 't', 'locations/1', 'accounts/1')).toEqual({ ok: false, code });
    }
  });
  it('survives network errors, invalid JSON and oversized bodies', async () => {
    const boom: GbpFetch = async () => { throw new Error('socket'); };
    expect(await readLocation(boom, 't', 'locations/1', null)).toEqual({ ok: false, code: 'unavailable' });
    const garbage = fakeFetch(() => ({ ok: true, status: 200, text: async () => '<html>' }));
    expect(await readLocation(garbage.fetch, 't', 'locations/1', null)).toEqual({ ok: false, code: 'unavailable' });
    const huge = fakeFetch(() => ({ ok: true, status: 200, text: async () => 'x'.repeat(700_000) }));
    expect(await readLocation(huge.fetch, 't', 'locations/1', null)).toEqual({ ok: false, code: 'unavailable' });
  });
});

describe('refreshAccessToken', () => {
  const now = () => Date.parse('2026-11-19T10:00:00Z');
  it('returns a capped expiry and sends the refresh grant as a form body', async () => {
    let body = '';
    const f: GbpFetch = async (_u, init) => { body = init.body ?? ''; return ok({ access_token: 'new', expires_in: 99999 }); };
    const out = await refreshAccessToken(f, 'cid', 'sec', 'rt', now);
    expect(out).toEqual({ ok: true, accessToken: 'new', expiresAt: '2026-11-19T11:00:00.000Z' });
    expect(body).toContain('grant_type=refresh_token');
  });
  it('maps a revoked grant to unauthorized and server trouble to unavailable', async () => {
    expect(await refreshAccessToken(async () => bad(400), 'c', 's', 'r', now)).toEqual({ ok: false, code: 'unauthorized' });
    expect(await refreshAccessToken(async () => bad(401), 'c', 's', 'r', now)).toEqual({ ok: false, code: 'unauthorized' });
    expect(await refreshAccessToken(async () => bad(503), 'c', 's', 'r', now)).toEqual({ ok: false, code: 'unavailable' });
    expect(await refreshAccessToken(async () => { throw new Error('x'); }, 'c', 's', 'r', now)).toEqual({ ok: false, code: 'unavailable' });
    expect(await refreshAccessToken(async () => ok({ nope: 1 }), 'c', 's', 'r', now)).toEqual({ ok: false, code: 'unavailable' });
  });
});

// ---- orchestration with a fake store ----
function fakeStore(over: Partial<{ ctx: GbpContext; cache: GbpCacheRow | null; token: TokenResult; ctxThrows: boolean; putThrows: boolean }> = {}) {
  const state = { ctx: over.ctx ?? { connected: true, locationName: 'locations/123', accountName: 'accounts/9' }, cache: over.cache ?? null, puts: [] as unknown[], tokenCalls: 0 };
  const store: GbpStore = {
    async context() { if (over.ctxThrows) throw new Error('db'); return state.ctx; },
    async cacheGet() { return state.cache; },
    async cachePut(_o, row) { if (over.putThrows) throw new Error('db'); state.puts.push(row); },
    async accessToken() { state.tokenCalls += 1; return over.token ?? { ok: true, token: 'tok' }; },
  };
  return { store, state };
}
const T0 = Date.parse('2026-11-19T10:00:00Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const goodFacts = { ...(parseLocation(LOCATION_FIXTURE) as GbpFacts), photoCount: 12 };
const cacheRow = (over: Partial<GbpCacheRow> = {}): GbpCacheRow => ({ locationName: 'locations/123', status: 'ok', facts: goodFacts, factsAt: iso(-60_000), fetchedAt: iso(-60_000), ...over });
const deps = (fetch: GbpFetch, enabled = true) => ({ enabled, now: () => T0, fetch });

describe('getGbpResult', () => {
  it('does nothing when the feature switch is off', async () => {
    const { store } = fakeStore(); const { fetch, calls } = fakeFetch(routes());
    expect((await getGbpResult(store, 'u', deps(fetch, false))).status).toBe('disabled');
    expect(calls).toHaveLength(0);
  });
  it('reports not_connected / no_location / unavailable without calling Google', async () => {
    const { fetch, calls } = fakeFetch(routes());
    expect((await getGbpResult(fakeStore({ ctx: { connected: false, locationName: null, accountName: null } }).store, 'u', deps(fetch))).status).toBe('not_connected');
    expect((await getGbpResult(fakeStore({ ctx: { connected: true, locationName: null, accountName: null } }).store, 'u', deps(fetch))).status).toBe('no_location');
    expect((await getGbpResult(fakeStore({ ctx: { connected: true, locationName: 'locations/../1', accountName: null } }).store, 'u', deps(fetch))).status).toBe('no_location');
    expect((await getGbpResult(fakeStore({ ctxThrows: true }).store, 'u', deps(fetch))).status).toBe('unavailable');
    expect(calls).toHaveLength(0);
  });
  it('reads, caches and returns fresh facts on a cold cache', async () => {
    const { store, state } = fakeStore(); const { fetch, calls } = fakeFetch(routes());
    const r = await getGbpResult(store, 'u', deps(fetch));
    expect(r.status).toBe('ok'); expect(r.stale).toBe(false); expect(r.facts?.photoCount).toBe(12);
    expect(calls).toHaveLength(2);
    expect(state.puts).toHaveLength(1);
    expect(JSON.stringify(state.puts)).not.toContain('tok'); // tokens never reach the cache
  });
  it('serves a fresh cache with zero Google calls and zero token use', async () => {
    const { store, state } = fakeStore({ cache: cacheRow() }); const { fetch, calls } = fakeFetch(routes());
    const r = await getGbpResult(store, 'u', deps(fetch));
    expect(r.status).toBe('ok'); expect(calls).toHaveLength(0); expect(state.tokenCalls).toBe(0);
  });
  it('refetches once the OK ttl has passed', async () => {
    const { store } = fakeStore({ cache: cacheRow({ factsAt: iso(-OK_TTL_MS - 1000), fetchedAt: iso(-OK_TTL_MS - 1000) }) }); const { fetch, calls } = fakeFetch(routes());
    await getGbpResult(store, 'u', deps(fetch));
    expect(calls).toHaveLength(2);
  });
  it('ignores a cache that belongs to a different location', async () => {
    const { store } = fakeStore({ cache: cacheRow({ locationName: 'locations/999' }) }); const { fetch, calls } = fakeFetch(routes());
    await getGbpResult(store, 'u', deps(fetch));
    expect(calls).toHaveLength(2);
  });
  it('remembers a failure and does not hammer Google, then retries after its ttl', async () => {
    const recent = cacheRow({ status: 'forbidden', facts: null, factsAt: null, fetchedAt: iso(-60_000) });
    const a = fakeStore({ cache: recent }); const fa = fakeFetch(routes());
    const r = await getGbpResult(a.store, 'u', deps(fa.fetch));
    expect(r.status).toBe('forbidden'); expect(r.facts).toBeNull(); expect(fa.calls).toHaveLength(0);
    const old = cacheRow({ status: 'forbidden', facts: null, factsAt: null, fetchedAt: iso(-FAILURE_TTL_MS.forbidden - 1000) });
    const b = fakeStore({ cache: old }); const fb = fakeFetch(routes());
    expect((await getGbpResult(b.store, 'u', deps(fb.fetch))).status).toBe('ok');
    expect(fb.calls).toHaveLength(2);
  });
  it('falls back to last-good facts, flagged stale, when the live read fails', async () => {
    const cache = cacheRow({ factsAt: iso(-OK_TTL_MS - 1000), fetchedAt: iso(-OK_TTL_MS - 1000) });
    const { store, state } = fakeStore({ cache }); const { fetch } = fakeFetch(routes({ info: bad(503) }));
    const r = await getGbpResult(store, 'u', deps(fetch));
    expect(r.status).toBe('unavailable'); expect(r.stale).toBe(true); expect(r.facts?.primaryCategory).toBe('Plumber');
    expect(state.puts).toHaveLength(1);
  });
  it('never serves facts older than the stale limit, nor for a deleted location', async () => {
    const tooOld = fakeStore({ cache: cacheRow({ factsAt: iso(-STALE_MAX_MS - 1000), fetchedAt: iso(-OK_TTL_MS - 1000) }) });
    const r1 = await getGbpResult(tooOld.store, 'u', deps(fakeFetch(routes({ info: bad(503) })).fetch));
    expect(r1.facts).toBeNull(); expect(r1.stale).toBe(false);
    const gone = fakeStore({ cache: cacheRow({ factsAt: iso(-OK_TTL_MS - 1000), fetchedAt: iso(-OK_TTL_MS - 1000) }) });
    const r2 = await getGbpResult(gone.store, 'u', deps(fakeFetch(routes({ info: bad(404) })).fetch));
    expect(r2.status).toBe('not_found'); expect(r2.facts).toBeNull();
  });
  it('turns a token failure into a result and does not call the API', async () => {
    const { store } = fakeStore({ token: { ok: false, code: 'unauthorized' } }); const { fetch, calls } = fakeFetch(routes());
    const r = await getGbpResult(store, 'u', deps(fetch));
    expect(r.status).toBe('unauthorized'); expect(calls).toHaveLength(0);
  });
  it('a broken cache write never fails the read', async () => {
    const { store } = fakeStore({ putThrows: true }); const { fetch } = fakeFetch(routes());
    expect((await getGbpResult(store, 'u', deps(fetch))).status).toBe('ok');
  });
  it('keeps a known photo count when only the media call fails', async () => {
    const cache = cacheRow({ factsAt: iso(-OK_TTL_MS - 1000), fetchedAt: iso(-OK_TTL_MS - 1000) });
    const { store } = fakeStore({ cache }); const { fetch } = fakeFetch(routes({ media: bad(500) }));
    expect((await getGbpResult(store, 'u', deps(fetch))).facts?.photoCount).toBe(12);
  });
});

// ---- scoring ----
const HOURS = { mon: { open: '08:00', close: '17:00' }, tue: { open: '08:00', close: '17:00' }, wed: { open: '08:00', close: '17:00' }, thu: { open: '08:00', close: '17:00' }, fri: { open: '08:00', close: '17:00' } };
const snap = (): Snapshot => ({
  business: { name: 'Acme', phone: '(512) 555-0100', address: '1 Main St', city: 'Austin', state: 'TX', website: 'https://acme-plumbing.com', country: 'US' },
  hours: HOURS, booking_hours: HOURS, holidays: 2, handles_emergency: 'yes_same_rate', after_hours_mode: 'ai_answer', currency: 'USD', timezone_valid: true,
  services_offered: ['Drain cleaning'], faqs: [], service_areas: ['Austin'], price_book: [],
  reviews: { connected: false, total: 0, last_90d: 0, due_total: 0, due_replied: 0 },
  booking: { enabled: true, feed_enabled: false, partner_status: 'not_applied' }, phone_ai_configured: true,
});
const res = (over: Partial<GbpResult> = {}): GbpResult => ({ status: 'ok', facts: goodFacts, stale: false, fetchedAt: iso(0), ...over });
const facts = (over: Partial<GbpFacts>): GbpFacts => ({ ...goodFacts, ...over });

describe('gbpCheck', () => {
  it('is not_measured with the legacy evidence when no read happened (back-compat)', () => {
    for (const g of [null, res({ status: 'disabled', facts: null })]) {
      const c = gbpCheck(g); expect(c.status).toBe('not_measured'); expect(c.evidence.k).toBe('needs_gbp_read');
    }
  });
  it('explains every no-data state and offers a reconnect only where it helps', () => {
    const cases: [GbpResult['status'], string, string][] = [
      ['not_connected', 'gbp_not_connected', 'gbp_connect'], ['no_location', 'gbp_no_location', 'gbp_connect'],
      ['unauthorized', 'gbp_token_invalid', 'gbp_connect'], ['not_found', 'gbp_location_missing', 'gbp_connect'],
      ['forbidden', 'gbp_no_access', 'gbp_manual_checks'], ['rate_limited', 'gbp_unavailable', 'gbp_manual_checks'], ['unavailable', 'gbp_unavailable', 'gbp_manual_checks'],
    ];
    for (const [status, k, fix] of cases) { const c = gbpCheck(res({ status, facts: null })); expect(c.status).toBe('not_measured'); expect(c.evidence.k).toBe(k); expect(c.fixKey).toBe(fix); }
  });
  it('passes a complete listing with no fix', () => {
    const c = gbpCheck(res()); expect(c.status).toBe('pass'); expect(c.points).toBe(c.max); expect(c.fixKey).toBeUndefined(); expect(c.evidence.k).toBe('gbp_read');
  });
  it('scores partial completeness by weight', () => {
    const c = gbpCheck(res({ facts: facts({ additionalCategories: 0, photoCount: 0, descriptionLength: 0 }) }));
    expect(c.status).toBe('partial'); expect(c.points).toBeCloseTo((4 / 10) * c.max, 1); expect(c.fixKey).toBe('gbp_manual_checks');
    expect(gbpCheck(res({ facts: facts({ primaryCategory: null }) })).points).toBeLessThan(c.max);
  });
  it('excludes photos from the score when the count is unknown and says so', () => {
    const c = gbpCheck(res({ facts: facts({ photoCount: null }) }));
    expect(c.evidence.k).toBe('gbp_read_no_photos'); expect(c.evidence.p).toEqual({ found: 3, total: 3 }); expect(c.status).toBe('pass');
  });
  it('fails closed and unmanageable listings outright', () => {
    expect(gbpCheck(res({ facts: facts({ openStatus: 'CLOSED_PERMANENTLY' }) })).evidence.k).toBe('gbp_closed');
    const nv = gbpCheck(res({ facts: facts({ voiceOfMerchant: false }) })); expect(nv.status).toBe('fail'); expect(nv.evidence.k).toBe('gbp_not_verified');
    expect(gbpCheck(res({ facts: facts({ openStatus: 'CLOSED_TEMPORARILY' }) })).status).toBe('pass');
  });
  it('uses stale facts but still measures', () => {
    expect(gbpCheck(res({ status: 'unavailable', stale: true })).status).toBe('pass');
  });
});

describe('scoreAccount + buildFixes with GBP', () => {
  it('leaves the default scan unchanged and measures the check when GBP data exists', () => {
    const base = scoreAccount(snap(), null);
    expect(base.checks.find((c) => c.ruleId === 'gbp_categories_photos')?.status).toBe('not_measured');
    const withGbp = scoreAccount(snap(), null, null, res());
    expect(withGbp.checks.find((c) => c.ruleId === 'gbp_categories_photos')?.status).toBe('pass');
    expect(withGbp.checks).toHaveLength(base.checks.length);
  });
  it('adds a connect fix only when a reconnect would help', () => {
    const fixKeys = (g: GbpResult | null) => buildFixes(snap(), scoreAccount(snap(), null, null, g).checks).map((f) => f.key);
    expect(fixKeys(res({ status: 'not_connected', facts: null }))).toContain('gbp_connect');
    expect(fixKeys(res({ status: 'unauthorized', facts: null }))).toContain('gbp_connect');
    expect(fixKeys(res({ status: 'forbidden', facts: null }))).not.toContain('gbp_connect');
    expect(fixKeys(res())).not.toContain('gbp_connect');
    expect(fixKeys(null)).not.toContain('gbp_connect');
    expect(fixKeys(res()).includes('gbp_manual_checks')).toBe(true); // directories still manual until NAP lands
  });
});

describe('summarizeGbp', () => {
  it('keeps no NAP fields and no tokens in the stored summary', () => {
    const s = summarizeGbp(res());
    expect(Object.keys(s).sort()).toEqual(['additional_categories', 'fetched_at', 'open_status', 'photos', 'primary_category', 'stale', 'status', 'voice_of_merchant']);
    expect(JSON.stringify(s)).not.toContain('555');
    expect(JSON.stringify(s)).not.toContain('acme-plumbing.com');
  });
});
