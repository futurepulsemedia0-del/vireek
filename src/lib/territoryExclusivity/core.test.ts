import { describe, expect, it } from 'vitest';
import {
  activationVerdict, blockedMarketingZips, findConflicts, leadDecision, normalizeZip, parseZipList, planWaitlistOffers, polygonError,
  polygonsOverlap, segmentsIntersect, termsOverlap, validateTerms, zipOverlap, type LatLng, type TerritoryLike, type WaitEntry,
} from './core';

const sq = (lat: number, lng: number, size: number): LatLng[] => [[lat, lng], [lat, lng + size], [lat + size, lng + size], [lat + size, lng]];
const zipGrant = (id: string, accountId: string, zips: string[], over: Partial<TerritoryLike> = {}): TerritoryLike => ({
  id, accountId, trade: 'hvac', zoneType: 'zip', zipCodes: zips, polygon: null, status: 'active', termStart: '2026-01-01', termEnd: '2026-12-31', ...over,
});
const polyGrant = (id: string, accountId: string, polygon: LatLng[], over: Partial<TerritoryLike> = {}): TerritoryLike => ({
  id, accountId, trade: 'hvac', zoneType: 'polygon', zipCodes: [], polygon, status: 'active', termStart: '2026-01-01', termEnd: '2026-12-31', ...over,
});
const cand = (zips: string[], over = {}) => ({ trade: 'hvac', zoneType: 'zip' as const, zipCodes: zips, polygon: null, termStart: '2026-06-01', termEnd: '2027-05-31', ...over });

describe('postal codes', () => {
  it('normalises US and Canadian codes', () => {
    expect(normalizeZip(' 10001-1234 ')).toBe('10001');
    expect(normalizeZip('k1a 0b1')).toBe('K1A0B1');
    expect(normalizeZip('K1A')).toBe('K1A');
    expect(normalizeZip('1234')).toBeNull();
    expect(normalizeZip('ABCDE')).toBeNull();
  });
  it('parses lists and reports invalid tokens', () => {
    expect(parseZipList('10002, 10001\n10001, K1A 0B1; zzz')).toEqual({ codes: ['10001', '10002', 'K1A0B1'], invalid: ['zzz'] });
  });
  it('treats an FSA as covering every code under it', () => {
    expect(zipOverlap('K1A', 'K1A0B1')).toBe(true);
    expect(zipOverlap('K1A0B1', 'K1A')).toBe(true);
    expect(zipOverlap('K1A', 'K2A0B1')).toBe(false);
    expect(zipOverlap('10001', '10002')).toBe(false);
  });
});

describe('overlap detection - ZIP', () => {
  const existing = [zipGrant('g1', 'A', ['10001', '10002', 'K1A'])];
  it('detects a shared ZIP and lists it', () => {
    const c = findConflicts(cand(['10002', '10003']), existing);
    expect(c).toHaveLength(1);
    expect(c[0]).toEqual({ id: 'g1', accountId: 'A', kind: 'zip_overlap', sharedZips: ['10002'] });
  });
  it('detects FSA-vs-full-code overlap', () => {
    expect(findConflicts(cand(['K1A0B1']), existing)).toHaveLength(1);
  });
  it('ignores other trades, draft and ended grants, and disjoint ZIPs', () => {
    expect(findConflicts(cand(['10001'], { trade: 'plumbing' }), existing)).toHaveLength(0);
    expect(findConflicts(cand(['10001']), [zipGrant('d', 'A', ['10001'], { status: 'draft' })])).toHaveLength(0);
    expect(findConflicts(cand(['10001']), [zipGrant('e', 'A', ['10001'], { status: 'ended' })])).toHaveLength(0);
    expect(findConflicts(cand(['90210']), existing)).toHaveLength(0);
  });
  it('a SUSPENDED grant still blocks (paused, not released)', () => {
    expect(findConflicts(cand(['10001']), [zipGrant('s', 'A', ['10001'], { status: 'suspended' })])).toHaveLength(1);
  });
  it('time overlap is inclusive; back-to-back terms do not conflict', () => {
    expect(termsOverlap('2026-01-01', '2026-12-31', '2026-12-31', '2027-12-30')).toBe(true);
    expect(termsOverlap('2026-01-01', '2026-12-31', '2027-01-01', '2027-12-31')).toBe(false);
    expect(findConflicts(cand(['10001'], { termStart: '2027-01-01', termEnd: '2027-12-31' }), existing)).toHaveLength(0);
  });
  it('can exclude itself when editing', () => {
    expect(findConflicts(cand(['10001'], { excludeId: 'g1' }), existing)).toHaveLength(0);
  });
  it('also conflicts with the same account (no duplicate grants)', () => {
    expect(findConflicts(cand(['10001']), [zipGrant('same', 'A', ['10001'])])[0].accountId).toBe('A');
  });
});

describe('overlap detection - polygons', () => {
  it('overlapping, contained and disjoint squares', () => {
    expect(polygonsOverlap(sq(0, 0, 2), sq(1, 1, 2))).toBe(true);
    expect(polygonsOverlap(sq(0, 0, 10), sq(4, 4, 1))).toBe(true); // contained, no edge crossing
    expect(polygonsOverlap(sq(0, 0, 1), sq(5, 5, 1))).toBe(false);
  });
  it('detects a "plus" crossing where NO vertex of either polygon is inside the other', () => {
    const horiz: LatLng[] = [[4, 0], [4, 10], [6, 10], [6, 0]];
    const vert: LatLng[] = [[0, 4], [0, 6], [10, 6], [10, 4]];
    expect(polygonsOverlap(horiz, vert)).toBe(true);
  });
  it('touching borders count as overlap (conservative)', () => {
    expect(polygonsOverlap(sq(0, 0, 1), sq(0, 1, 1))).toBe(true);
    expect(segmentsIntersect([0, 0], [1, 1], [1, 1], [2, 0])).toBe(true);
    expect(segmentsIntersect([0, 0], [1, 0], [0, 1], [1, 1])).toBe(false);
  });
  it('conflicts across polygon grants', () => {
    const existing = [polyGrant('p1', 'A', sq(0, 0, 2))];
    const c = findConflicts({ ...cand([]), zoneType: 'polygon', polygon: sq(1, 1, 2) }, existing);
    expect(c[0].kind).toBe('polygon_overlap');
    expect(findConflicts({ ...cand([]), zoneType: 'polygon', polygon: sq(10, 10, 1) }, existing)).toHaveLength(0);
  });
  it('validates polygons', () => {
    expect(polygonError(sq(0, 0, 1))).toBeNull();
    expect(polygonError([[0, 0], [1, 1]])).toMatch(/3 points/);
    expect(polygonError([[0, 0], [1, 1], [95, 0]])).toMatch(/Latitude/);
    expect(polygonError([[0, 0], [1, 1], ['a', 0]])).toMatch(/\[latitude/);
  });
});

describe('mixed ZIP / polygon', () => {
  it('is reported as unverifiable and needs explicit acknowledgement, not silent approval', () => {
    const c = findConflicts({ ...cand([]), zoneType: 'polygon', polygon: sq(0, 0, 1) }, [zipGrant('z', 'A', ['10001'])]);
    expect(c[0].kind).toBe('unverifiable_mixed');
    expect(activationVerdict(c)).toEqual({ ok: true, needsAcknowledgement: true });
  });
  it('a hard overlap can never be acknowledged away', () => {
    const c = findConflicts(cand(['10001']), [zipGrant('z', 'A', ['10001'])]);
    expect(activationVerdict(c)).toEqual({ ok: false, reason: 'overlap' });
    expect(activationVerdict([])).toEqual({ ok: true, needsAcknowledgement: false });
  });
});

describe('waiting list', () => {
  const w = (id: string, createdAt: string, zips: string[], over: Partial<WaitEntry> = {}): WaitEntry => ({ id, accountId: id, trade: 'hvac', zoneType: 'zip', zipCodes: zips, polygon: null, status: 'waiting', createdAt, ...over });
  const now = new Date('2026-07-01T00:00:00Z');
  it('offers nothing while the territory is still held', () => {
    expect(planWaitlistOffers('hvac', [w('w1', '2026-01-01', ['10001'])], [zipGrant('g', 'A', ['10001'])], now).offer).toEqual([]);
  });
  it('offers the first in line when it is free; the second overlapping request waits (area is reserved)', () => {
    const r = planWaitlistOffers('hvac', [w('w2', '2026-02-01', ['10001', '10005']), w('w1', '2026-01-01', ['10001'])], [], now);
    expect(r.offer).toEqual(['w1']);
  });
  it('non-overlapping requests are both offered', () => {
    expect(planWaitlistOffers('hvac', [w('w1', '2026-01-01', ['10001']), w('w2', '2026-02-01', ['20002'])], [], now).offer).toEqual(['w1', 'w2']);
  });
  it('skips a blocked head-of-line request without blocking later, unrelated ones', () => {
    const r = planWaitlistOffers('hvac', [w('w1', '2026-01-01', ['10001']), w('w2', '2026-02-01', ['20002'])], [zipGrant('g', 'A', ['10001'])], now);
    expect(r.offer).toEqual(['w2']);
  });
  it('expired offers lapse and release their reservation to the next in line', () => {
    const r = planWaitlistOffers('hvac', [w('w1', '2026-01-01', ['10001'], { status: 'offered', offerExpiresAt: '2026-06-30T00:00:00Z' }), w('w2', '2026-02-01', ['10001'])], [], now);
    expect(r.expire).toEqual(['w1']);
    expect(r.offer).toEqual(['w2']);
  });
  it('a live offer keeps its reservation', () => {
    const r = planWaitlistOffers('hvac', [w('w1', '2026-01-01', ['10001'], { status: 'offered', offerExpiresAt: '2026-07-02T00:00:00Z' }), w('w2', '2026-02-01', ['10001'])], [], now);
    expect(r).toEqual({ offer: [], expire: [] });
  });
  it('mixed ZIP/polygon requests are never auto-offered over a reservation', () => {
    const r = planWaitlistOffers('hvac', [w('w1', '2026-01-01', ['10001'], { status: 'accepted' }), w('w2', '2026-02-01', [], { zoneType: 'polygon', polygon: sq(0, 0, 1) })], [], now);
    expect(r.offer).toEqual([]);
  });
});

describe('lead routing / marketing effect', () => {
  const grants = [zipGrant('g1', 'A', ['10001']), zipGrant('g2', 'B', ['20002'], { status: 'suspended' }), polyGrant('p1', 'C', sq(0, 0, 2))];
  const on = '2026-07-01';
  it('allows when nobody holds the area', () => {
    expect(leadDecision('X', { trade: 'hvac', zip: '30003', on }, grants).decision).toBe('allow');
    expect(leadDecision('X', { trade: 'plumbing', zip: '10001', on }, grants).decision).toBe('allow');
  });
  it('blocks other accounts, favours the holder', () => {
    expect(leadDecision('X', { trade: 'hvac', zip: '10001-0001', on }, grants)).toEqual({ decision: 'blocked_other_holder', holderId: 'g1' });
    expect(leadDecision('A', { trade: 'hvac', zip: '10001', on }, grants).decision).toBe('allow_holder');
  });
  it('a suspended holder is held back and others stay blocked', () => {
    expect(leadDecision('B', { trade: 'hvac', zip: '20002', on }, grants).decision).toBe('hold_suspended_holder');
    expect(leadDecision('X', { trade: 'hvac', zip: '20002', on }, grants).decision).toBe('blocked_other_holder');
  });
  it('resolves by coordinates for polygon grants, and respects the term', () => {
    expect(leadDecision('X', { trade: 'hvac', lat: 1, lng: 1, on }, grants).decision).toBe('blocked_other_holder');
    expect(leadDecision('X', { trade: 'hvac', lat: 5, lng: 5, on }, grants).decision).toBe('allow');
    expect(leadDecision('X', { trade: 'hvac', zip: '10001', on: '2027-02-01' }, grants).decision).toBe('allow');
  });
  it('lists the marketing ZIPs an account must not target', () => {
    expect(blockedMarketingZips('X', 'hvac', ['10001', '20002', '30003', 'bad'], grants, on)).toEqual(['10001', '20002']);
    expect(blockedMarketingZips('A', 'hvac', ['10001'], grants, on)).toEqual([]);
  });
});

describe('contract term validation', () => {
  it('accepts a sane term and rejects bad ones', () => {
    expect(validateTerms({ termStart: '2026-01-01', termEnd: '2026-12-31', feeCents: 100000, feeCurrency: 'USD', renewalNoticeDays: 60 })).toBeNull();
    expect(validateTerms({ termStart: '2026-02-01', termEnd: '2026-01-01' })).toMatch(/before/);
    expect(validateTerms({ termStart: '2026-01-01', termEnd: '2040-01-01' })).toMatch(/10 years/);
    expect(validateTerms({ termStart: '2026-01-01', termEnd: '2026-12-31', feeCents: 5 })).toMatch(/both/);
    expect(validateTerms({ termStart: '2026-01-01', termEnd: '2026-12-31', feeCents: -1, feeCurrency: 'USD' })).toMatch(/non-negative/);
    expect(validateTerms({ termStart: '2026-01-01', termEnd: '2026-12-31', renewalNoticeDays: 400 })).toMatch(/0-365/);
  });
});
