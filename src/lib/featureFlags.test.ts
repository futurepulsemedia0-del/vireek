import { describe, it, expect } from 'vitest';
import {
  EMPTY_FLAG_FORM, FLAG_CACHE_TTL_MS, createFlagStore, describeAuditEntry, describeFlag, describeReach, parseFlagForm, parseOverrideNote,
  suggestFlagKey, tenantLabel, type FlagFormValues,
} from './featureFlags';

const form = (over: Partial<FlagFormValues> = {}): FlagFormValues => ({ ...EMPTY_FLAG_FORM, key: 'new_dashboard', name: 'New dashboard', ...over });

describe('parseFlagForm', () => {
  it('accepts a valid flag and normalises optional fields', () => {
    const r = parseFlagForm(form({ description: '  Redesigned home  ', enabled: true, rollout_pct: '25' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ key: 'new_dashboard', name: 'New dashboard', description: 'Redesigned home', enabled: true, rollout_pct: 25 });
  });
  it('stores an empty description as null', () => {
    const r = parseFlagForm(form());
    if (r.ok) expect(r.value.description).toBeNull(); else throw new Error('expected ok');
  });
  it('requires a name and a key', () => {
    const r = parseFlagForm(form({ key: '', name: ' ' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['key', 'name']);
  });
  it('rejects malformed keys', () => {
    for (const key of ['Bad_Key', '1abc', 'ab', 'trailing_', 'has-dash', 'has space', 'a'.repeat(65)]) {
      expect(parseFlagForm(form({ key })).ok).toBe(false);
    }
    expect(parseFlagForm(form({ key: 'abc' })).ok).toBe(true);
    expect(parseFlagForm(form({ key: 'a' + 'b'.repeat(62) + 'c' })).ok).toBe(true);
  });
  it('rejects rollout outside 0-100 or non-integers', () => {
    for (const rollout_pct of ['-1', '101', '12.5', '', 'abc']) expect(parseFlagForm(form({ rollout_pct })).ok).toBe(false);
    expect(parseFlagForm(form({ rollout_pct: '0' })).ok).toBe(true);
    expect(parseFlagForm(form({ rollout_pct: '100' })).ok).toBe(true);
  });
});

describe('helpers', () => {
  it('suggests valid keys from names', () => {
    expect(suggestFlagKey('New Dashboard!')).toBe('new_dashboard');
    expect(suggestFlagKey('  Évolution  v2 ')).toBe('evolution_v2');
    expect(suggestFlagKey('2026 pricing')).toBe('f_2026_pricing');
    expect(suggestFlagKey('!!!')).toBe('');
    expect(suggestFlagKey('x'.repeat(100)).length).toBeLessThanOrEqual(64);
  });
  it('describes flag state', () => {
    expect(describeFlag({ enabled: false, rollout_pct: 80 }).label).toBe('Off');
    expect(describeFlag({ enabled: true, rollout_pct: 0 }).label).toBe('Overrides only');
    expect(describeFlag({ enabled: true, rollout_pct: 100 }).label).toBe('Fully on');
    expect(describeFlag({ enabled: true, rollout_pct: 30 }).label).toBe('30% rollout');
  });
  it('describes real reach and handles zero tenants', () => {
    expect(describeReach({ reach_tenants: 40, total_tenants: 100 })).toBe('40 of 100 tenants (40%)');
    expect(describeReach({ reach_tenants: 0, total_tenants: 0 })).toBe('No tenants yet');
  });
  it('labels tenants by company, then name, then email', () => {
    expect(tenantLabel({ email: 'a@b.co', company_name: ' Acme HVAC ', full_name: 'Al' })).toBe('Acme HVAC');
    expect(tenantLabel({ email: 'a@b.co', company_name: null, full_name: 'Al' })).toBe('Al');
    expect(tenantLabel({ email: 'a@b.co', company_name: '', full_name: null })).toBe('a@b.co');
  });
  it('validates override notes', () => {
    expect(parseOverrideNote('  hi ')).toEqual({ ok: true, value: 'hi' });
    expect(parseOverrideNote('   ')).toEqual({ ok: true, value: null });
    expect(parseOverrideNote('x'.repeat(301)).ok).toBe(false);
  });
});

describe('describeAuditEntry', () => {
  it('describes flag lifecycle events', () => {
    expect(describeAuditEntry({ action: 'create', before: null, after: { enabled: false, rollout_pct: 0 }, tenant_email: null })).toBe('Created (master switch off, 0% rollout)');
    expect(describeAuditEntry({ action: 'delete', before: {}, after: null, tenant_email: null })).toBe('Deleted');
  });
  it('lists what changed on update, capitalised', () => {
    const e = describeAuditEntry({ action: 'update', before: { enabled: false, rollout_pct: 10, name: 'A', description: null }, after: { enabled: true, rollout_pct: 25, name: 'A', description: null }, tenant_email: null });
    expect(e).toBe('Master switch off → on, rollout 10% → 25%');
    expect(describeAuditEntry({ action: 'update', before: { rollout_pct: 5, name: 'A' }, after: { rollout_pct: 5, name: 'B' }, tenant_email: null })).toBe('Renamed');
  });
  it('describes overrides with the tenant', () => {
    expect(describeAuditEntry({ action: 'override_set', before: null, after: { state: 'on' }, tenant_email: 'a@b.co' })).toBe('Override for a@b.co: on');
    expect(describeAuditEntry({ action: 'override_set', before: { state: 'on' }, after: { state: 'off' }, tenant_email: 'a@b.co' })).toBe('Override for a@b.co: on → off');
    expect(describeAuditEntry({ action: 'override_clear', before: { state: 'off' }, after: null, tenant_email: null })).toBe('Override removed for a tenant (was off)');
  });
});

function harness(keysFor: (call: number) => string[] | Error) {
  let t = 1_000;
  let calls = 0;
  const resolvers: (() => void)[] = [];
  const store = createFlagStore({
    now: () => t,
    fetchKeys: () => {
      const n = ++calls;
      return new Promise<string[]>((resolve, reject) => {
        resolvers.push(() => {
          const r = keysFor(n);
          if (r instanceof Error) reject(r); else resolve(r);
        });
      });
    },
  });
  return {
    store,
    calls: () => calls,
    advance: (ms: number) => { t += ms; },
    flush: async () => { while (resolvers.length) resolvers.shift()!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); },
  };
}

describe('createFlagStore', () => {
  it('loads keys for a user and reports ready', async () => {
    const h = harness(() => ['a', 'b']);
    const p = h.store.refresh('u1');
    expect(h.store.getSnapshot().status).toBe('loading');
    await h.flush(); await p;
    const s = h.store.getSnapshot();
    expect(s.status).toBe('ready');
    expect(s.userId).toBe('u1');
    expect(s.keys.has('a')).toBe(true);
    expect(s.keys.has('z')).toBe(false);
  });
  it('shares one request between concurrent refreshes', async () => {
    const h = harness(() => ['a']);
    const p1 = h.store.refresh('u1');
    const p2 = h.store.refresh('u1');
    await h.flush(); await Promise.all([p1, p2]);
    expect(h.calls()).toBe(1);
  });
  it('serves from cache inside the TTL and refetches after it, without flicker', async () => {
    const h = harness((n) => (n === 1 ? ['a'] : ['b']));
    const p1 = h.store.refresh('u1'); await h.flush(); await p1;
    await h.store.refresh('u1');
    expect(h.calls()).toBe(1);
    h.advance(FLAG_CACHE_TTL_MS + 1);
    const p2 = h.store.refresh('u1');
    expect(h.store.getSnapshot().status).toBe('ready'); // stale-while-revalidate
    expect(h.store.getSnapshot().keys.has('a')).toBe(true);
    await h.flush(); await p2;
    expect(h.calls()).toBe(2);
    expect(h.store.getSnapshot().keys.has('b')).toBe(true);
  });
  it('force bypasses the TTL', async () => {
    const h = harness(() => ['a']);
    const p1 = h.store.refresh('u1'); await h.flush(); await p1;
    const p2 = h.store.refresh('u1', true); await h.flush(); await p2;
    expect(h.calls()).toBe(2);
  });
  it('never leaks one user\'s flags to the next user', async () => {
    const h = harness((n) => (n === 1 ? ['secret'] : ['other']));
    const p1 = h.store.refresh('u1'); await h.flush(); await p1;
    const p2 = h.store.refresh('u2');
    const s = h.store.getSnapshot();
    expect(s.userId).toBe('u2');
    expect(s.keys.size).toBe(0);
    await h.flush(); await p2;
    expect(h.store.getSnapshot().keys.has('secret')).toBe(false);
    expect(h.store.getSnapshot().keys.has('other')).toBe(true);
  });
  it('ignores a slow response for a user who has since changed', async () => {
    const h = harness((n) => (n === 1 ? ['late'] : ['fresh']));
    const p1 = h.store.refresh('u1');
    const p2 = h.store.refresh('u2');
    await h.flush(); await Promise.all([p1, p2]);
    const s = h.store.getSnapshot();
    expect(s.userId).toBe('u2');
    expect(s.keys.has('late')).toBe(false);
    expect(s.keys.has('fresh')).toBe(true);
  });
  it('clears everything on sign-out', async () => {
    const h = harness(() => ['a']);
    const p = h.store.refresh('u1'); await h.flush(); await p;
    await h.store.refresh(null);
    const s = h.store.getSnapshot();
    expect(s.status).toBe('idle');
    expect(s.userId).toBeNull();
    expect(s.keys.size).toBe(0);
  });
  it('keeps last known keys when a refetch fails, but gives a new user none', async () => {
    const h = harness((n) => (n === 1 ? ['a'] : new Error('network')));
    const p1 = h.store.refresh('u1'); await h.flush(); await p1;
    h.advance(FLAG_CACHE_TTL_MS + 1);
    const p2 = h.store.refresh('u1'); await h.flush(); await p2;
    expect(h.store.getSnapshot().status).toBe('error');
    expect(h.store.getSnapshot().keys.has('a')).toBe(true);

    const p3 = h.store.refresh('u2'); await h.flush(); await p3;
    expect(h.store.getSnapshot().status).toBe('error');
    expect(h.store.getSnapshot().keys.size).toBe(0);
  });
  it('retries after an error on the next refresh', async () => {
    const h = harness((n) => (n === 1 ? new Error('boom') : ['a']));
    const p1 = h.store.refresh('u1'); await h.flush(); await p1;
    expect(h.store.getSnapshot().status).toBe('error');
    const p2 = h.store.refresh('u1'); await h.flush(); await p2;
    expect(h.store.getSnapshot().status).toBe('ready');
  });
  it('notifies subscribers and stops after unsubscribe', async () => {
    const h = harness(() => ['a']);
    let n = 0;
    const off = h.store.subscribe(() => { n += 1; });
    const p = h.store.refresh('u1'); await h.flush(); await p;
    expect(n).toBeGreaterThanOrEqual(2); // loading + ready
    off();
    const before = n;
    await h.store.refresh(null);
    expect(n).toBe(before);
  });
});
