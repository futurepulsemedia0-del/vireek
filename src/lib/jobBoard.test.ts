import { describe, it, expect } from 'vitest';
import {
  audienceCounts,
  buildVendorLink,
  compareOffers,
  describeJobBoardError,
  fairnessSpread,
  formatOpensIn,
  hasContactInfo,
  needsAttention,
  offerPhase,
  parseBlockers,
  sortBids,
  suggestTrade,
  validatePostForm,
  validateSettings,
  vendorMailto,
  DEFAULT_SETTINGS,
  type AudienceEntry,
  type JobBoardBid,
  type PostFormValues,
  type TechOffer,
} from './jobBoard';

const NOW = new Date('2026-11-02T12:00:00Z').getTime();
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const offer = (over: Partial<TechOffer> = {}): TechOffer => ({
  post_id: 'p1',
  title: 'No-heat call',
  summary: null,
  location_label: null,
  skill: 'hvac',
  starts_at: at(300),
  duration_minutes: 90,
  offer_cents: null,
  priority: 'normal',
  claim_mode: 'first_come',
  status: 'open',
  expires_at: at(60),
  opens_at: at(-1),
  wave: 1,
  declined: false,
  my_bid_status: null,
  awarded_to_me: false,
  ...over,
});

describe('offerPhase', () => {
  it('is claimable once the window opened and the post is live', () => {
    expect(offerPhase(offer(), NOW)).toBe('claimable');
  });
  it('is opens_soon while another technician has the head start', () => {
    expect(offerPhase(offer({ opens_at: at(8), wave: 2 }), NOW)).toBe('opens_soon');
  });
  it('reports a pending request, a win, a loss and closed states', () => {
    expect(offerPhase(offer({ my_bid_status: 'active', claim_mode: 'bidding' }), NOW)).toBe('requested');
    expect(offerPhase(offer({ status: 'awarded', awarded_to_me: true }), NOW)).toBe('won');
    expect(offerPhase(offer({ status: 'awarded' }), NOW)).toBe('lost');
    expect(offerPhase(offer({ status: 'escalated' }), NOW)).toBe('lost');
    expect(offerPhase(offer({ status: 'cancelled' }), NOW)).toBe('closed');
    expect(offerPhase(offer({ status: 'expired' }), NOW)).toBe('closed');
  });
  it('treats a past expiry as closed even if the row is still open', () => {
    expect(offerPhase(offer({ expires_at: at(-1) }), NOW)).toBe('closed');
  });
  it('respects a decline', () => {
    expect(offerPhase(offer({ declined: true }), NOW)).toBe('declined');
  });
});

describe('compareOffers', () => {
  it('orders claimable urgent first, then soonest expiry, then history newest-first', () => {
    const normalSoon = offer({ post_id: 'a', expires_at: at(10) });
    const normalLater = offer({ post_id: 'b', expires_at: at(90) });
    const urgent = offer({ post_id: 'c', priority: 'urgent', expires_at: at(120) });
    const soon = offer({ post_id: 'd', opens_at: at(5), wave: 2 });
    const wonOld = offer({ post_id: 'e', status: 'awarded', awarded_to_me: true, expires_at: at(-500) });
    const wonNew = offer({ post_id: 'f', status: 'awarded', awarded_to_me: true, expires_at: at(-50) });
    const sorted = [wonOld, soon, normalLater, wonNew, urgent, normalSoon]
      .sort((x, y) => compareOffers(x, y, NOW))
      .map((o) => o.post_id);
    expect(sorted).toEqual(['c', 'a', 'b', 'd', 'f', 'e']);
  });
});

describe('formatOpensIn', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatOpensIn(at(-1), NOW)).toBe('Open now');
    expect(formatOpensIn(new Date(NOW + 30_000).toISOString(), NOW)).toBe('Opens in 30s');
    expect(formatOpensIn(at(8), NOW)).toBe('Opens in 8m');
    expect(formatOpensIn(at(60), NOW)).toBe('Opens in 1h');
    expect(formatOpensIn(at(95), NOW)).toBe('Opens in 1h 35m');
    expect(formatOpensIn('not a date', NOW)).toBe('Open now');
  });
});

describe('errors', () => {
  it('explains eligibility blockers carried in the message', () => {
    expect(parseBlockers('NOT_ELIGIBLE:SKILL,CONFLICT')).toEqual(['SKILL', 'CONFLICT']);
    expect(parseBlockers('NOT_ELIGIBLE')).toEqual([]);
    const text = describeJobBoardError(new Error('NOT_ELIGIBLE:CAPACITY,ZONE'));
    expect(text).toContain('daily job limit');
    expect(text).toContain('service zone');
  });
  it('maps codes to copy and does not let a short code shadow a longer one', () => {
    expect(describeJobBoardError(new Error('NOT_OPEN_YET'))).toContain('head start');
    expect(describeJobBoardError(new Error('NOT_ELIGIBLE'))).toContain('no longer qualify');
    expect(describeJobBoardError({ message: 'PRICE_ABOVE_MAX' })).toContain('above what this job can pay');
  });
  it('falls back to the contractor-network copy, then to a generic message', () => {
    expect(describeJobBoardError(new Error('NOT_A_MEMBER'))).toContain('Join the Contractor Network');
    expect(describeJobBoardError(new Error('boom'))).toBe('Something went wrong. Please try again.');
    expect(describeJobBoardError(undefined)).toBe('Something went wrong. Please try again.');
  });
});

describe('sortBids', () => {
  const bid = (over: Partial<JobBoardBid>): JobBoardBid => ({
    id: 'b',
    post_id: 'p',
    bidder_type: 'vendor',
    technician_id: null,
    vendor_id: 'v',
    label: 'x',
    price_cents: 1000,
    note: null,
    status: 'active',
    created_at: at(0),
    ...over,
  });
  it('puts technicians first, then vendors by lowest price, and drops inactive bids', () => {
    const out = sortBids([
      bid({ id: 'v-high', price_cents: 90000 }),
      bid({ id: 'v-low', price_cents: 50000 }),
      bid({ id: 'tech-late', bidder_type: 'technician', technician_id: 't', vendor_id: null, price_cents: null, created_at: at(5) }),
      bid({ id: 'tech-early', bidder_type: 'technician', technician_id: 't2', vendor_id: null, price_cents: null, created_at: at(1) }),
      bid({ id: 'gone', status: 'withdrawn' }),
    ]).map((b) => b.id);
    expect(out).toEqual(['tech-early', 'tech-late', 'v-low', 'v-high']);
  });
  it('sorts a vendor bid without a price last', () => {
    const out = sortBids([bid({ id: 'none', price_cents: null }), bid({ id: 'p', price_cents: 1 })]).map((b) => b.id);
    expect(out).toEqual(['p', 'none']);
  });
});

describe('audienceCounts / fairnessSpread / needsAttention', () => {
  const e = (over: Partial<AudienceEntry>): AudienceEntry => ({
    recipient_type: 'technician',
    technician_id: 't',
    vendor_id: null,
    label: 'x',
    wave: 1,
    rank: 1,
    awards: 0,
    opens_in_minutes: 0,
    blockers: [],
    ...over,
  });
  it('counts eligible and blocked per audience, and the first-look group', () => {
    const c = audienceCounts([
      e({ wave: 1 }),
      e({ wave: 2 }),
      e({ blockers: ['SKILL'] }),
      e({ recipient_type: 'vendor', technician_id: null, vendor_id: 'v' }),
      e({ recipient_type: 'vendor', technician_id: null, vendor_id: 'v2', blockers: ['DOCS'] }),
    ]);
    expect(c).toEqual({ techEligible: 2, techBlocked: 1, vendorEligible: 1, vendorBlocked: 1, firstLook: 1 });
  });
  it('flags an unbalanced rotation at a spread of 3+', () => {
    const row = (awards: number) => ({ technician_id: 't', name: 'n', awards, last_awarded_at: null, open_offers: 0 });
    expect(fairnessSpread([])).toEqual({ min: 0, max: 0, spread: 0, unbalanced: false });
    expect(fairnessSpread([row(1), row(2)]).unbalanced).toBe(false);
    expect(fairnessSpread([row(0), row(3)])).toEqual({ min: 0, max: 3, spread: 3, unbalanced: true });
  });
  it('needs attention when expired, or open with bids waiting', () => {
    expect(needsAttention({ status: 'expired' }, 0)).toBe(true);
    expect(needsAttention({ status: 'open' }, 2)).toBe(true);
    expect(needsAttention({ status: 'open' }, 0)).toBe(false);
    expect(needsAttention({ status: 'awarded' }, 3)).toBe(false);
  });
});

describe('suggestTrade', () => {
  it('maps service types to network trade slugs', () => {
    expect(suggestTrade('AC repair')).toBe('hvac');
    expect(suggestTrade('Water heater install')).toBe('plumbing');
    expect(suggestTrade('Panel upgrade')).toBe('electrical');
    expect(suggestTrade('Roof leak')).toBe('roofing');
    expect(suggestTrade('Lockout')).toBe('locksmith');
    expect(suggestTrade('Gutter cleaning')).toBe('general');
    expect(suggestTrade(null)).toBe('general');
  });
});

describe('vendor links', () => {
  it('builds a clean link and a mailto with the encoded link', () => {
    expect(buildVendorLink('https://app.vireek.com/', 'abc123')).toBe('https://app.vireek.com/job-board/offer/abc123');
    const mail = vendorMailto({ email: 'sub@x.com', company: 'Acme', title: 'No heat', link: 'https://x/y' });
    expect(mail).toContain('mailto:sub%40x.com?subject=');
    expect(decodeURIComponent(mail ?? '')).toContain('https://x/y');
    expect(vendorMailto({ email: null, company: 'Acme', title: 't', link: 'l' })).toBeNull();
  });
});

describe('contact-info detection (mirrors the SQL check)', () => {
  it('detects e-mails and long digit runs but allows ordinary text', () => {
    expect(hasContactInfo('mail me at a.b@c.io')).toBe(true);
    expect(hasContactInfo('call 512 555 0100')).toBe(true);
    expect(hasContactInfo('(512) 555-0100')).toBe(true);
    expect(hasContactInfo('Rooftop unit, 3 ton, floor 12')).toBe(false);
    expect(hasContactInfo('')).toBe(false);
  });
});

describe('validatePostForm', () => {
  const base: PostFormValues = {
    title: 'No-heat call',
    summary: '',
    locationLabel: 'North Austin',
    offer: '',
    maxBid: '',
    expiresMinutes: '',
    audience: 'both',
    claimMode: 'first_come',
    autoAward: false,
  };
  it('accepts a minimal valid form and converts money without float drift', () => {
    const r = validatePostForm({ ...base, offer: '19.99', maxBid: '$1,000', expiresMinutes: '90' });
    expect(r.errors).toEqual({});
    expect(r.offerCents).toBe(1999);
    expect(r.maxBidCents).toBe(100000);
    expect(r.expiresMinutes).toBe(90);
  });
  it('rejects short titles, contact details, bad money and bad expiry', () => {
    const r = validatePostForm({
      ...base,
      title: 'ab',
      summary: 'call 512 555 0100',
      locationLabel: 'x@y.com',
      offer: 'abc',
      maxBid: '-5',
      expiresMinutes: '3',
    });
    expect(Object.keys(r.errors).sort()).toEqual(['expiresMinutes', 'locationLabel', 'maxBid', 'offer', 'summary', 'title']);
    expect(validatePostForm({ ...base, expiresMinutes: '10081' }).errors.expiresMinutes).toBeTruthy();
    expect(validatePostForm({ ...base, expiresMinutes: '1.5' }).errors.expiresMinutes).toBeTruthy();
  });
  it('only allows auto-award on bidding posts', () => {
    expect(validatePostForm({ ...base, autoAward: true }).errors.autoAward).toBeTruthy();
    expect(validatePostForm({ ...base, autoAward: true, claimMode: 'bidding' }).errors.autoAward).toBeUndefined();
  });
});

describe('validateSettings', () => {
  it('accepts the defaults and rejects out-of-range rules', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toBeNull();
    expect(validateSettings({ ...DEFAULT_SETTINGS, first_look_size: 0 })).toBeTruthy();
    expect(validateSettings({ ...DEFAULT_SETTINGS, first_look_minutes: 241 })).toBeTruthy();
    expect(validateSettings({ ...DEFAULT_SETTINGS, default_expiry_minutes: 4 })).toBeTruthy();
    expect(validateSettings({ ...DEFAULT_SETTINGS, fairness_window_days: 366 })).toBeTruthy();
    expect(validateSettings({ ...DEFAULT_SETTINGS, max_active_bids_per_technician: 1.5 })).toBeTruthy();
  });
});
