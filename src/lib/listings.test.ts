import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  buildLocationRows,
  canManageListings,
  describeEvent,
  overallHealth,
  syncSummary,
  timeAgo,
  type ListingLink,
  type ListingLocation,
} from './listings';
import {
  CHECK_INTERVAL_MS,
  REPUSH_COOLDOWN_MS,
  blockingIssues,
  buildCanonical,
  canManageListings as serverCan,
  canonicalHash,
  compareRemote,
  copyRecord,
  decideAction,
  listingHealth,
  manualState,
  normText,
  normalizeExternalId,
  normalizeFacebookPage,
  normalizePartnerRemote,
  normalizePhone,
  normalizeWebsite,
  normalizeYelpAlias,
  normalizeYelpBusiness,
  resolveMode,
  singleLineAddress,
  toFacebookHours,
  toFacebookPayload,
  validateCanonical,
  type Canonical,
} from '../../supabase/functions/_shared/listings/engine';

const NOW = new Date('2027-12-10T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const WEEK = {
  mon: { closed: false, open: '08:00', close: '17:00' },
  tue: { closed: false, open: '08:00', close: '17:00' },
  wed: { closed: false, open: '08:00', close: '17:00' },
  thu: { closed: false, open: '08:00', close: '17:00' },
  fri: { closed: false, open: '08:00', close: '17:00' },
  sat: { closed: true, open: '08:00', close: '17:00' },
  sun: { closed: true, open: '08:00', close: '17:00' },
};

const LOC = {
  name: '  Acme   HVAC ',
  status: 'active',
  phone: '(512) 555-0142',
  address_line1: '123 Main Street',
  address_line2: 'Suite 4',
  city: 'Austin',
  state: 'TX',
  postal_code: '78701',
  country: 'US',
  business_hours: WEEK,
};

const canonical = (over: Partial<typeof LOC> = {}, settings = { website_url: 'acme.com', description: 'Heating & cooling.' }): Canonical =>
  buildCanonical({ ...LOC, ...over }, settings, null);

describe('permission gate', () => {
  it('lets owners and business-profile editors in, nobody else', () => {
    expect(canManageListings(true, {} as never)).toBe(true);
    expect(canManageListings(false, { can_edit_business_profile: true } as never)).toBe(true);
    expect(canManageListings(false, { can_view_billing: true } as never)).toBe(false);
  });
  it('server rule: custom role overrides team permissions', () => {
    expect(serverCan({ role: 'owner' })).toBe(true);
    expect(serverCan({ role: 'member', teamPermissions: { can_edit_business_profile: true } })).toBe(true);
    expect(serverCan({ role: 'member', teamPermissions: { can_edit_business_profile: true }, customRolePermissions: { can_edit_business_profile: false } })).toBe(false);
    expect(serverCan({ role: null })).toBe(false);
  });
});

describe('input normalizers', () => {
  it('phones become E.164, foreign numbers need a +', () => {
    expect(normalizePhone('(512) 555-0142')).toBe('+15125550142');
    expect(normalizePhone('1-512-555-0142')).toBe('+15125550142');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('020 7946 0958', 'GB')).toBeNull();
    expect(normalizePhone('555-0142')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
  it('websites are https-only plain addresses', () => {
    expect(normalizeWebsite('acme.com')).toBe('https://acme.com');
    expect(normalizeWebsite('http://www.acme.com/')).toBe('https://www.acme.com');
    expect(normalizeWebsite('javascript:alert(1)')).toBeNull();
    expect(normalizeWebsite('localhost')).toBeNull();
    expect(normalizeWebsite('')).toBeNull();
  });
  it('external ids are URL-safe, yelp aliases come from links', () => {
    expect(normalizeExternalId('4821937')).toBe('4821937');
    expect(normalizeExternalId('../../etc')).toBeNull();
    expect(normalizeExternalId('a b')).toBeNull();
    expect(normalizeYelpAlias('https://www.yelp.com/biz/acme-hvac-austin?osq=hvac')).toBe('acme-hvac-austin');
    expect(normalizeYelpAlias('acme-hvac-austin')).toBe('acme-hvac-austin');
    expect(normalizeYelpAlias('https://evil.com/biz/acme')).toBeNull();
  });
});

describe('canonical record + hash', () => {
  it('cleans whitespace and falls back to the brand website', () => {
    const c = buildCanonical(LOC, { website_url: null, description: null }, 'https://brand.example.com/');
    expect(c.name).toBe('Acme HVAC');
    expect(c.phone).toBe('+15125550142');
    expect(c.website).toBe('https://brand.example.com');
    expect(c.status).toBe('active');
  });
  it('hash is stable and changes only when the record changes', () => {
    expect(canonicalHash(canonical())).toBe(canonicalHash(canonical()));
    expect(canonicalHash(canonical({ phone: '512-555-0142' }))).toBe(canonicalHash(canonical()));
    expect(canonicalHash(canonical({ phone: '512-555-9999' }))).not.toBe(canonicalHash(canonical()));
    expect(canonicalHash(canonical({ business_hours: { ...WEEK, sat: { closed: false, open: '09:00', close: '12:00' } } }))).not.toBe(canonicalHash(canonical()));
  });
  it('copy record is human readable', () => {
    const text = copyRecord(canonical());
    expect(text).toContain('Business name: Acme HVAC');
    expect(text).toContain('Phone: +15125550142');
    expect(text).toContain('SAT: Closed');
    expect(singleLineAddress(canonical().address)).toBe('123 Main Street Suite 4, Austin, TX 78701');
  });
});

describe('readiness validation', () => {
  it('a complete location has no blocking issues', () => {
    expect(blockingIssues(validateCanonical(canonical()))).toHaveLength(0);
  });
  it('blocks on missing basics and bad hours, only warns on optional gaps', () => {
    const bad = canonical({ address_line1: '', phone: 'abc', business_hours: { ...WEEK, mon: { closed: false, open: '17:00', close: '08:00' } } }, { website_url: null, description: null });
    const codes = validateCanonical(bad).map((i) => i.code);
    expect(codes).toContain('address_line1_missing');
    expect(codes).toContain('phone_invalid');
    expect(codes).toContain('hours_invalid');
    expect(blockingIssues(validateCanonical(bad)).length).toBe(3);
    const warnOnly = validateCanonical(canonical({}, { website_url: null, description: null }));
    expect(warnOnly.map((i) => i.code)).toEqual(expect.arrayContaining(['website_missing', 'description_missing']));
    expect(blockingIssues(warnOnly)).toHaveLength(0);
  });
  it('flags a location that is closed every day as a warning', () => {
    const closed = Object.fromEntries(Object.keys(WEEK).map((k) => [k, { closed: true, open: '08:00', close: '17:00' }]));
    expect(validateCanonical(canonical({ business_hours: closed as never })).some((i) => i.code === 'hours_all_closed' && !i.blocking)).toBe(true);
  });
});

describe('drift detection', () => {
  const c = canonical();
  it('ignores case, punctuation and street abbreviations', () => {
    expect(normText('123 Main Street, Suite 4')).toBe(normText('123 main st ste 4'));
    expect(compareRemote(c, { name: 'ACME HVAC', phone: '(512) 555-0142', address: { line1: '123 Main St', line2: 'Ste 4', city: 'austin', region: 'tx', postalCode: '78701' }, website: 'http://www.acme.com/' })).toEqual([]);
  });
  it('reports each mismatching field', () => {
    const drift = compareRemote(c, { name: 'Acme Heating', phone: '+15125559999', address: { line1: '9 Oak Ave', city: 'Austin', region: 'TX', postalCode: '78701' }, website: 'https://other.com' });
    expect(drift).toEqual(['name', 'phone', 'address', 'website']);
  });
  it('never treats unreadable fields as drift', () => {
    expect(compareRemote(c, {})).toEqual([]);
  });
  it('compares hours day by day and flags a wrongly closed listing', () => {
    const remoteHours = { ...WEEK, mon: { closed: false, open: '09:00', close: '17:00' } };
    expect(compareRemote(c, { hours: remoteHours })).toEqual(['hours']);
    expect(compareRemote(c, { permanentlyClosed: true })).toEqual(['status']);
  });
});

describe('provider mapping', () => {
  it('maps hours and payload for Facebook (closed days omitted, name never pushed)', () => {
    const fb = toFacebookHours(canonical().hours);
    expect(fb.mon_1_open).toBe('08:00');
    expect(fb.fri_1_close).toBe('17:00');
    expect(fb.sat_1_open).toBeUndefined();
    const { fields, body } = toFacebookPayload(canonical());
    expect(fields).not.toContain('name');
    expect(body.phone).toBe('+15125550142');
    expect(body.website).toBe('https://acme.com');
    expect(JSON.parse(body.hours).mon_1_open).toBe('08:00');
  });
  it('reads a Facebook Page back into the same shape', () => {
    const remote = normalizeFacebookPage({
      name: 'Acme HVAC', phone: '+15125550142', website: 'https://acme.com',
      location: { street: '123 Main Street Suite 4', city: 'Austin', state: 'TX', zip: '78701', country: 'United States' },
      hours: toFacebookHours(canonical().hours),
    });
    expect(compareRemote(canonical(), remote)).toEqual([]);
  });
  it('reads Yelp Fusion details (day 0 = Monday, split shifts keep the widest span)', () => {
    const open = [0, 1, 2, 3, 4].flatMap((day) => [{ day, start: '0800', end: '1200' }, { day, start: '1300', end: '1700' }]);
    const remote = normalizeYelpBusiness({
      name: 'Acme HVAC', phone: '+15125550142', is_closed: false,
      location: { address1: '123 Main St', address2: 'Ste 4', city: 'Austin', state: 'TX', zip_code: '78701' },
      hours: [{ hours_type: 'REGULAR', open }],
    });
    expect(compareRemote(canonical(), remote)).toEqual([]);
    expect(compareRemote(canonical(), { ...remote, permanentlyClosed: true })).toEqual(['status']);
  });
  it('accepts the common aliases partner APIs use', () => {
    const remote = normalizePartnerRemote({ displayName: 'Acme HVAC', telephone: '+15125550142', url: 'https://acme.com', address: { addressLine1: '123 Main St', addressLine2: 'Ste 4', locality: 'Austin', administrativeArea: 'TX', zip: '78701' }, status: 'OPEN' });
    expect(compareRemote(canonical(), remote)).toEqual([]);
    expect(normalizePartnerRemote({ status: 'PERMANENTLY_CLOSED' }).permanentlyClosed).toBe(true);
  });
});

describe('sync planning', () => {
  const base = { mode: 'push' as const, state: 'synced' as const, hasBlocking: false, currentHash: 'h1', lastPushedHash: 'h1', lastPushedAt: hoursAgo(2), lastCheckedAt: hoursAgo(2), force: false, now: NOW };

  it('chooses the mode from what the server has enabled', () => {
    expect(resolveMode('facebook', { configured: false, pushEnabled: false })).toBe('manual');
    expect(resolveMode('facebook', { configured: true, pushEnabled: false })).toBe('monitor');
    expect(resolveMode('facebook', { configured: true, pushEnabled: true })).toBe('push');
    expect(resolveMode('yelp', { configured: true, pushEnabled: true })).toBe('monitor');
    expect(resolveMode('apple', { configured: true, pushEnabled: false })).toBe('monitor');
  });
  it('never syncs an incomplete record', () => {
    expect(decideAction({ ...base, hasBlocking: true })).toBe('blocked');
    expect(decideAction({ ...base, hasBlocking: true, mode: 'manual' })).toBe('blocked');
  });
  it('pushes when the record changed, a link is new or force is set', () => {
    expect(decideAction({ ...base, currentHash: 'h2' })).toBe('push');
    expect(decideAction({ ...base, state: 'pending' })).toBe('push');
    expect(decideAction({ ...base, force: true })).toBe('push');
    expect(decideAction({ ...base })).toBe('skip');
  });
  it('re-verifies daily and retries drift only after the cooldown', () => {
    expect(decideAction({ ...base, lastCheckedAt: new Date(NOW.getTime() - CHECK_INTERVAL_MS - 1000).toISOString() })).toBe('check');
    expect(decideAction({ ...base, state: 'drift', lastPushedAt: hoursAgo(1) })).toBe('skip');
    expect(decideAction({ ...base, state: 'drift', lastPushedAt: new Date(NOW.getTime() - REPUSH_COOLDOWN_MS - 1000).toISOString() })).toBe('push');
  });
  it('backs off after an error unless forced', () => {
    expect(decideAction({ ...base, state: 'error', lastCheckedAt: new Date(NOW.getTime() - 60_000).toISOString() })).toBe('skip');
    expect(decideAction({ ...base, state: 'error', lastCheckedAt: new Date(NOW.getTime() - 60_000).toISOString(), force: true })).toBe('push');
  });
  it('monitor mode only ever checks', () => {
    expect(decideAction({ ...base, mode: 'monitor', currentHash: 'h2' })).toBe('check');
    expect(decideAction({ ...base, mode: 'monitor', state: 'drift' })).toBe('skip');
  });
  it('manual links are in sync only while the confirmed record is current', () => {
    expect(decideAction({ ...base, mode: 'manual' })).toBe('manual');
    expect(manualState('h1', 'h1')).toBe('synced');
    expect(manualState('h2', 'h1')).toBe('pending');
    expect(manualState('h1', null)).toBe('pending');
  });
});

describe('dashboard helpers', () => {
  const location = (id: string, name: string, issues: ListingLocation['issues'] = []): ListingLocation => ({ id, name, status: 'active', is_primary: false, canonical: canonical(), hash: 'h', issues });
  const link = (over: Partial<ListingLink>): ListingLink => ({
    id: 'l', location_id: 'a', connection_id: null, platform: 'yelp', external_location_id: 'x', mode: 'monitor', state: 'synced',
    last_pushed_hash: null, last_pushed_at: null, last_checked_at: null, drift_fields: [], blocked_reason: null, last_error: null, ...over,
  });

  it('health never flatters an account with no links', () => {
    expect(listingHealth([])).toEqual({ total: 0, synced: 0, attention: 0, percent: 0 });
    expect(listingHealth(['synced', 'drift', 'synced', 'error'])).toEqual({ total: 4, synced: 2, attention: 2, percent: 50 });
    expect(overallHealth({ links: [link({}), link({ id: 'm', state: 'pending' })] }).percent).toBe(50);
  });
  it('orders locations: needs attention, then healthy, then unlinked', () => {
    const rows = buildLocationRows({
      locations: [location('c', 'Zeta'), location('b', 'Beta'), location('a', 'Alpha')],
      links: [link({ id: '1', location_id: 'b', state: 'synced' }), link({ id: '2', location_id: 'a', state: 'drift' })],
    });
    expect(rows.map((r) => r.location.id)).toEqual(['a', 'b', 'c']);
  });
  it('splits blocking issues from warnings', () => {
    const issues = [{ code: 'phone_invalid', field: 'phone' as const, message: 'x', blocking: true }, { code: 'website_missing', field: 'website' as const, message: 'y', blocking: false }];
    const [row] = buildLocationRows({ locations: [location('a', 'A', issues)], links: [] });
    expect(row.blocking).toHaveLength(1);
    expect(row.warnings).toHaveLength(1);
  });
  it('summarises a batch of sync outcomes', () => {
    expect(syncSummary([]).type).toBe('info');
    expect(syncSummary([{ state: 'synced', action: 'push', error: null }]).type).toBe('success');
    expect(syncSummary([{ state: 'drift', action: 'check', error: null }]).message).toContain('no longer matches');
    expect(syncSummary([{ state: 'error', action: 'check', error: 'boom' }, { state: 'synced', action: 'push', error: null }])).toEqual({ type: 'error', message: '1 listing failed: boom' });
    expect(syncSummary([{ state: 'blocked', action: 'blocked', error: null }]).message).toContain('needs more business details');
    expect(syncSummary([{ state: 'pending', action: 'manual', error: null }]).message).toContain('copy the record');
  });
  it('describes events and relative times', () => {
    expect(describeEvent({ kind: 'push', outcome: 'ok', fields: ['phone', 'hours'], detail: null })).toBe('Updated Phone, Opening hours');
    expect(describeEvent({ kind: 'check', outcome: 'drift', fields: ['address'], detail: null })).toBe('Found mismatch: Address');
    expect(describeEvent({ kind: 'push', outcome: 'error', fields: [], detail: 'nope' })).toBe('Failed: nope');
    expect(timeAgo(null)).toBe('Never');
    expect(timeAgo(hoursAgo(3), NOW)).toBe('3h ago');
  });
});
