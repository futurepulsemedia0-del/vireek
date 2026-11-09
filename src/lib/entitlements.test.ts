import { describe, expect, it } from 'vitest';
import {
  EMPTY_ENTITLEMENT_FORM, createEntitlementStore, describeEntitlement, isEntitled, isValidModuleId, parseEntitlementForm,
  passesModuleGate, resolveEntitlement, type Entitlement, type EntitlementSnapshot,
} from './entitlements';

const NOW = Date.parse('2030-01-10T12:00:00Z');
const DAY = 86_400_000;
const row = (o: Partial<Entitlement> & { module_id: string }): Entitlement => ({ state: 'on', source: 'manual', expires_at: null, active: true, ...o });
const snapOf = (rows: Entitlement[], userId: string | null = 'u1', fetchedAt = 1): EntitlementSnapshot =>
  ({ userId, status: 'ready', rows: new Map(rows.map((r) => [r.module_id, r])), fetchedAt });

describe('isEntitled (allow / deny / expiry / default deny)', () => {
  it('allows on and trial, with or without a future expiry', () => {
    expect(isEntitled(row({ module_id: 'pay' }), NOW)).toBe(true);
    expect(isEntitled(row({ module_id: 'pay', state: 'trial', expires_at: new Date(NOW + DAY).toISOString() }), NOW)).toBe(true);
  });
  it('denies missing rows, off rows and rows the server marked inactive', () => {
    expect(isEntitled(undefined, NOW)).toBe(false);
    expect(isEntitled(row({ module_id: 'pay', state: 'off', active: false }), NOW)).toBe(false);
    expect(isEntitled(row({ module_id: 'pay', active: false }), NOW)).toBe(false);
  });
  it('denies once expired, including when the cache is older than the expiry', () => {
    const r = row({ module_id: 'pay', state: 'trial', expires_at: new Date(NOW + 1000).toISOString() });
    expect(isEntitled(r, NOW)).toBe(true);
    expect(isEntitled(r, NOW + 1000)).toBe(false);
    expect(isEntitled(r, NOW + DAY)).toBe(false);
  });
  it('denies a garbage expiry instead of allowing it', () => {
    expect(isEntitled(row({ module_id: 'pay', expires_at: 'not-a-date' }), NOW)).toBe(false);
  });
});

describe('resolveEntitlement', () => {
  it('is denied + loading before the first fetch, for signed-out users and for another user', () => {
    const idle: EntitlementSnapshot = { userId: null, status: 'idle', rows: new Map(), fetchedAt: 0 };
    expect(resolveEntitlement(idle, 'u1', 'pay', NOW)).toMatchObject({ allowed: false, status: 'loading' });
    expect(resolveEntitlement(snapOf([row({ module_id: 'pay' })]), null, 'pay', NOW).allowed).toBe(false);
    expect(resolveEntitlement(snapOf([row({ module_id: 'pay' })], 'u1'), 'u2', 'pay', NOW).allowed).toBe(false);
  });
  it('reports error (denied) when the first load failed', () => {
    const s: EntitlementSnapshot = { userId: 'u1', status: 'error', rows: new Map(), fetchedAt: 0 };
    expect(resolveEntitlement(s, 'u1', 'pay', NOW)).toMatchObject({ allowed: false, status: 'error' });
  });
  it('returns trial details and days left', () => {
    const r = resolveEntitlement(snapOf([row({ module_id: 'ai', state: 'trial', expires_at: new Date(NOW + 2.5 * DAY).toISOString() })]), 'u1', 'ai', NOW);
    expect(r).toMatchObject({ allowed: true, state: 'trial', daysLeft: 3, expired: false, status: 'ready' });
  });
  it('flags expired rows as expired + denied; unknown modules are simply denied', () => {
    const s = snapOf([row({ module_id: 'ai', expires_at: new Date(NOW - 1).toISOString() })]);
    expect(resolveEntitlement(s, 'u1', 'ai', NOW)).toMatchObject({ allowed: false, expired: true, state: 'off' });
    expect(resolveEntitlement(s, 'u1', 'pay', NOW)).toMatchObject({ allowed: false, expired: false });
  });
});

describe('passesModuleGate (nav)', () => {
  it('never affects items without requiresModule', () => {
    expect(passesModuleGate(undefined, undefined)).toBe(true);
    expect(passesModuleGate(undefined, () => false)).toBe(true);
  });
  it('hides gated items when not entitled or when no checker is supplied', () => {
    expect(passesModuleGate('pay', () => false)).toBe(false);
    expect(passesModuleGate('pay', undefined)).toBe(false);
    expect(passesModuleGate('pay', (id) => id === 'pay')).toBe(true);
  });
});

describe('createEntitlementStore', () => {
  function harness(results: Array<Entitlement[] | 'error'>) {
    let t = 1000;
    let calls = 0;
    const store = createEntitlementStore({
      fetchRows: async () => { const r = results[Math.min(calls, results.length - 1)]; calls += 1; if (r === 'error') throw new Error('x'); return r; },
      now: () => t, ttlMs: 1000,
    });
    return { store, calls: () => calls, advance: (ms: number) => { t += ms; } };
  }
  it('one request serves every module (no N+1) and is shared by concurrent refreshes', async () => {
    const h = harness([[row({ module_id: 'core' }), row({ module_id: 'pay' }), row({ module_id: 'ai' })]]);
    await Promise.all([h.store.refresh('u1'), h.store.refresh('u1'), h.store.refresh('u1')]);
    expect(h.calls()).toBe(1);
    expect(h.store.getSnapshot().rows.size).toBe(3);
  });
  it('respects the ttl, and force refetches', async () => {
    const h = harness([[row({ module_id: 'core' })]]);
    await h.store.refresh('u1'); await h.store.refresh('u1');
    expect(h.calls()).toBe(1);
    h.advance(1500); await h.store.refresh('u1');
    expect(h.calls()).toBe(2);
    await h.store.refresh('u1', true);
    expect(h.calls()).toBe(3);
  });
  it('never serves another user\'s rows after a user switch, and clears on sign-out', async () => {
    const h = harness([[row({ module_id: 'pay' })], [row({ module_id: 'core' })]]);
    await h.store.refresh('u1');
    const p = h.store.refresh('u2');
    expect(h.store.getSnapshot()).toMatchObject({ userId: 'u2', status: 'loading', fetchedAt: 0 });
    expect(resolveEntitlement(h.store.getSnapshot(), 'u2', 'pay', NOW).allowed).toBe(false);
    await p;
    expect(resolveEntitlement(h.store.getSnapshot(), 'u2', 'pay', NOW).allowed).toBe(false);
    await h.store.refresh(null);
    expect(h.store.getSnapshot().rows.size).toBe(0);
  });
  it('a failed first load stays denied; a failed refetch keeps last rows for the same user', async () => {
    const first = harness(['error']);
    await first.store.refresh('u1');
    expect(resolveEntitlement(first.store.getSnapshot(), 'u1', 'pay', NOW)).toMatchObject({ allowed: false, status: 'error' });

    const h = harness([[row({ module_id: 'pay' })], 'error']);
    await h.store.refresh('u1');
    await h.store.refresh('u1', true);
    expect(h.store.getSnapshot().status).toBe('error');
    expect(isEntitled(h.store.getSnapshot().rows.get('pay'), NOW)).toBe(true);
  });
  it('a stale cache cannot keep an expired trial alive', async () => {
    const h = harness([[row({ module_id: 'pay', state: 'trial', expires_at: new Date(NOW + 1000).toISOString() })]]);
    await h.store.refresh('u1');
    expect(resolveEntitlement(h.store.getSnapshot(), 'u1', 'pay', NOW).allowed).toBe(true);
    expect(resolveEntitlement(h.store.getSnapshot(), 'u1', 'pay', NOW + 5000).allowed).toBe(false);
  });
});

describe('parseEntitlementForm', () => {
  const ok = { ...EMPTY_ENTITLEMENT_FORM, module_id: 'pay', reason: 'Signed pilot agreement' };
  it('accepts a valid grant and normalizes it', () => {
    const r = parseEntitlementForm({ ...ok, module_id: ' PAY ' }, NOW);
    expect(r).toEqual({ ok: true, value: { module_id: 'pay', state: 'on', source: 'manual', expires_at: null, reason: 'Signed pilot agreement' } });
  });
  it('requires a reason of at least 5 characters', () => {
    expect(parseEntitlementForm({ ...ok, reason: '  hi ' }, NOW)).toMatchObject({ ok: false, errors: { reason: expect.any(String) } });
  });
  it('requires an expiry for a trial and a future expiry for any grant', () => {
    expect(parseEntitlementForm({ ...ok, state: 'trial' }, NOW)).toMatchObject({ ok: false, errors: { expires_local: expect.any(String) } });
    expect(parseEntitlementForm({ ...ok, expires_local: '2020-01-01T00:00' }, NOW)).toMatchObject({ ok: false, errors: { expires_local: expect.any(String) } });
    expect(parseEntitlementForm({ ...ok, state: 'trial', expires_local: '2030-02-01T00:00' }, NOW)).toMatchObject({ ok: true });
  });
  it('ignores the expiry when turning a module off', () => {
    const r = parseEntitlementForm({ ...ok, state: 'off', expires_local: '2020-01-01T00:00' }, NOW);
    expect(r).toMatchObject({ ok: true, value: { expires_at: null } });
  });
  it('validates module ids including packs:*', () => {
    expect(isValidModuleId('packs:hvac-2')).toBe(true);
    for (const bad of ['', 'Pay', 'packs:', 'packs:-x', 'packs:a b', 'billing', 'core ']) expect(isValidModuleId(bad)).toBe(false);
    expect(parseEntitlementForm({ ...ok, module_id: 'nope' }, NOW)).toMatchObject({ ok: false, errors: { module_id: expect.any(String) } });
  });
});

describe('describeEntitlement', () => {
  it('labels on, trial, off and expired', () => {
    expect(describeEntitlement(row({ module_id: 'x' }), NOW).label).toBe('On');
    expect(describeEntitlement(row({ module_id: 'x', state: 'trial', expires_at: new Date(NOW + DAY).toISOString() }), NOW).label).toBe('Trial');
    expect(describeEntitlement(row({ module_id: 'x', state: 'off', active: false }), NOW).label).toBe('Off');
    expect(describeEntitlement(row({ module_id: 'x', expires_at: new Date(NOW - DAY).toISOString(), active: false }), NOW).label).toBe('Expired');
  });
});
