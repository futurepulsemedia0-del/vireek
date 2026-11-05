import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMS,
  LIMITS,
  NATIONAL_EMERGENCY_NUMBER,
  buildBroadcastText,
  buildGuidance,
  classifySymptom,
  computeScope,
  convexHull,
  decideCluster,
  extractPostal,
  incidentTitle,
  looksGeocodable,
  buildBookingNote,
  buildSmsAutoReplyText,
  isOpenStatus,
  removeById,
  sortIncidentRows,
  upsertById,
  indicatesOwnSide,
  inferCause,
  inScope,
  isDirectoryEntryUsable,
  nextStatusByInactivity,
  normalizePostal,
  pairAffinity,
  pickDirectoryEntry,
  scoreIncident,
  statusForNewScore,
  symptomSimilarity,
  triageContact,
  type DirectoryEntry,
  type ExternalSignal,
  type IncidentContact,
  type IncidentForTriage,
  type IncidentSnapshot,
} from '../../supabase/functions/_shared/mass-incident/core';

const NOW = new Date('2026-11-03T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

let seq = 0;
function contact(over: Partial<IncidentContact> = {}): IncidentContact {
  seq += 1;
  const text = over.symptomText ?? 'no water at all';
  return {
    id: `c${seq}`,
    source: 'call',
    contactAt: minutesAgo(10),
    postalCode: '78701',
    lat: 30.2672,
    lng: -97.7431,
    geoPrecision: 'address',
    symptomClass: classifySymptom(text).symptomClass,
    symptomText: text,
    isEmergency: false,
    hazards: [],
    embedding: null,
    incidentId: null,
    ...over,
  };
}

const signal = (over: Partial<ExternalSignal> = {}): ExternalSignal => ({
  id: 's1', kind: 'municipal_notice', headline: 'Water main repair', postalCodes: ['78701'], lat: null, lng: null, radiusMiles: null,
  verified: true, effectiveAt: minutesAgo(60), expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(), corroborates: ['water_supply_issue'], ...over,
});

const dirEntry = (over: Partial<DirectoryEntry> = {}): DirectoryEntry => ({
  id: 'd1', userId: null, country: 'US', region: 'TX', postalPrefix: null, service: 'water', name: 'City Water Utility',
  phone: '+15125550100', website: 'https://example.org', sourceUrl: 'https://example.org/contact', verifiedAt: '2026-09-01T00:00:00Z', status: 'verified', ...over,
});

describe('classifySymptom', () => {
  it.each([
    ['we have no water since morning', 'no_water'],
    ['water pressure is very low, barely a trickle from the faucet', 'low_water_pressure'],
    ['brown water coming from the tap', 'discolored_water'],
    ['power is out on our whole street', 'no_power'],
    ['our AC stopped working and it is too hot', 'no_cooling'],
    ['the furnace is not working', 'no_heat'],
    ['I smell gas in the kitchen', 'gas_odor'],
    ['sewage is backing up, drains backed up', 'sewer_backup'],
    ['a tree fell on the roof', 'storm_damage'],
    ['sin agua desde la mañana', 'no_water'],
  ])('%s -> %s', (text, cls) => {
    expect(classifySymptom(text).symptomClass).toBe(cls);
  });
  it('does not treat a negated hazard as the symptom', () => {
    expect(classifySymptom('there is no gas smell, just no water').symptomClass).toBe('no_water');
    expect(classifySymptom("I don't smell gas but the power is out").symptomClass).toBe('no_power');
  });
  it('returns other with zero confidence for empty or unrelated text', () => {
    expect(classifySymptom('').confidence).toBe(0);
    expect(classifySymptom('I want a quote for a new deck').symptomClass).toBe('other');
  });
  it('treats very long input safely', () => {
    expect(() => classifySymptom('x'.repeat(100_000))).not.toThrow();
  });
});

describe('postal helpers', () => {
  it('normalizes US and Canadian codes and rejects junk', () => {
    expect(normalizePostal('78701-1234')).toBe('78701');
    expect(normalizePostal('m5v 2t6')).toBe('M5V');
    expect(normalizePostal('hello')).toBeNull();
    expect(normalizePostal(null)).toBeNull();
  });
  it('extracts a postal code from an address or SMS', () => {
    expect(extractPostal('123 Main St, Austin TX 78701')).toBe('78701');
    expect(extractPostal('we are at 55 King St W, Toronto M5H 1J9')).toBe('M5H');
    expect(extractPostal('no code here')).toBeNull();
  });
});

describe('symptomSimilarity + pairAffinity', () => {
  it('same class = 1, related = 0.6, unrelated is low', () => {
    const a = contact({ symptomText: 'no water' });
    expect(symptomSimilarity(a, contact({ symptomText: 'no water here' }))).toBe(1);
    expect(symptomSimilarity(a, contact({ symptomText: 'low pressure' }))).toBe(0.6);
    expect(symptomSimilarity(a, contact({ symptomText: 'power is out' }))).toBeLessThan(0.5);
  });
  it('uses embeddings when both exist but keeps a floor for identical classes', () => {
    const a = contact({ embedding: [1, 0, 0] });
    const b = contact({ embedding: [0, 1, 0] });
    expect(symptomSimilarity(a, b)).toBe(0.8);
  });
  it('requires geo, time and symptom together', () => {
    const a = contact();
    expect(pairAffinity(a, contact(), DEFAULT_PARAMS)).toBeGreaterThan(0.8);
    expect(pairAffinity(a, contact({ lat: 31.5, lng: -97.7, postalCode: '76701' }), DEFAULT_PARAMS)).toBe(0);
    expect(pairAffinity(a, contact({ contactAt: minutesAgo(600) }), DEFAULT_PARAMS)).toBe(0);
    expect(pairAffinity(a, contact({ symptomText: 'power is out' }), DEFAULT_PARAMS)).toBe(0);
  });
  it('never merges unlocated contacts geographically', () => {
    const a = contact();
    const b = contact({ lat: null, lng: null, postalCode: null, geoPrecision: 'none' });
    expect(pairAffinity(a, b, DEFAULT_PARAMS)).toBe(0);
  });
  it('postal-only contacts in the same ZIP still link', () => {
    const a = contact({ lat: null, lng: null, geoPrecision: 'postal' });
    const b = contact({ lat: null, lng: null, geoPrecision: 'postal' });
    expect(pairAffinity(a, b, DEFAULT_PARAMS)).toBeGreaterThanOrEqual(DEFAULT_PARAMS.linkThreshold);
  });
});

describe('decideCluster', () => {
  it('stays loose until minContacts are linked, then creates', () => {
    const pool: IncidentContact[] = [contact(), contact()];
    const fresh = contact();
    const d = decideCluster(fresh, [], pool);
    expect(d.action).toBe('create');
    if (d.action === 'create') expect(d.candidateIds).toHaveLength(2);
    expect(decideCluster(fresh, [], [pool[0]]).action).toBe('none');
  });
  it('attaches to an open incident whose scope and symptom fit', () => {
    const c = contact();
    const open: IncidentSnapshot = {
      id: 'inc1', status: 'active', symptomClass: 'no_water', firstContactAt: minutesAgo(60), lastContactAt: minutesAgo(5), memberCount: 4,
      scope: { kind: 'postal', postalCodes: ['78701'], center: null, radiusMiles: null, polygon: null },
    };
    const d = decideCluster(c, [open], []);
    expect(d).toMatchObject({ action: 'attach', incidentId: 'inc1' });
  });
  it('does not attach to resolved or dismissed incidents, or a different symptom', () => {
    const open = (status: IncidentSnapshot['status'], symptomClass: IncidentSnapshot['symptomClass'] = 'no_water'): IncidentSnapshot => ({
      id: 'x', status, symptomClass, firstContactAt: minutesAgo(60), lastContactAt: minutesAgo(5), memberCount: 4,
      scope: { kind: 'postal', postalCodes: ['78701'], center: null, radiusMiles: null, polygon: null },
    });
    expect(decideCluster(contact(), [open('resolved')], []).action).toBe('none');
    expect(decideCluster(contact(), [open('dismissed')], []).action).toBe('none');
    expect(decideCluster(contact(), [open('active', 'no_power')], []).action).toBe('none');
  });
  it('does not attach when the incident has been quiet for more than 2x the window', () => {
    const stale: IncidentSnapshot = {
      id: 'x', status: 'monitoring', symptomClass: 'no_water', firstContactAt: minutesAgo(900), lastContactAt: minutesAgo(600), memberCount: 4,
      scope: { kind: 'postal', postalCodes: ['78701'], center: null, radiusMiles: null, polygon: null },
    };
    expect(decideCluster(contact(), [stale], []).action).toBe('none');
  });
  it('emergencies never open an incident and never pull others in', () => {
    const emergency = contact({ symptomText: 'I smell gas', isEmergency: true, hazards: ['gas'] });
    const pool = [contact({ symptomText: 'I smell gas' }), contact({ symptomText: 'I smell gas' })];
    expect(decideCluster(emergency, [], pool).action).toBe('none');
  });
  it('emergency pool members are excluded from new incidents', () => {
    const pool = [contact({ isEmergency: true, hazards: ['gas'] }), contact({ hazards: ['gas'] })];
    expect(decideCluster(contact(), [], pool).action).toBe('none');
  });
  it('ignores contacts that are already attached to another incident', () => {
    const pool = [contact({ incidentId: 'other' }), contact({ incidentId: 'other' })];
    expect(decideCluster(contact(), [], pool).action).toBe('none');
  });
  it('unlocated contacts are never clustered but are reported as such', () => {
    const c = contact({ lat: null, lng: null, postalCode: null, geoPrecision: 'none' });
    expect(decideCluster(c, [], [contact(), contact()])).toEqual({ action: 'none', reason: 'unlocated' });
  });
});

describe('scope', () => {
  it('builds a polygon for 3+ located contacts and a radius for fewer', () => {
    const pts = [contact({ lat: 30.26, lng: -97.74 }), contact({ lat: 30.28, lng: -97.74 }), contact({ lat: 30.27, lng: -97.72 }), contact({ lat: 30.27, lng: -97.745 })];
    const s = computeScope(pts);
    expect(s.kind).toBe('polygon');
    expect(s.polygon!.length).toBeGreaterThanOrEqual(3);
    expect(s.radiusMiles!).toBeGreaterThanOrEqual(LIMITS.minRadiusMiles);
    expect(computeScope(pts.slice(0, 2)).kind).toBe('radius');
  });
  it('falls back to postal codes without coordinates and caps the list', () => {
    const many = Array.from({ length: 30 }, (_, i) => contact({ lat: null, lng: null, postalCode: String(70000 + i) }));
    const s = computeScope(many);
    expect(s.kind).toBe('postal');
    expect(s.postalCodes.length).toBeLessThanOrEqual(LIMITS.maxPostalCodesInScope);
  });
  it('convexHull handles degenerate input', () => {
    expect(convexHull([[1, 1]])).toHaveLength(1);
    expect(convexHull([[0, 0], [1, 1], [0, 0]])).toHaveLength(2);
  });
  it('inScope uses polygon, radius or postal', () => {
    const s = computeScope([contact({ lat: 30.26, lng: -97.74 }), contact({ lat: 30.28, lng: -97.74 }), contact({ lat: 30.27, lng: -97.72 })]);
    expect(inScope(s, { postalCode: null, lat: 30.27, lng: -97.735 })).toBe(true);
    expect(inScope(s, { postalCode: null, lat: 40.0, lng: -80.0 })).toBe(false);
    expect(inScope(s, { postalCode: '78701', lat: null, lng: null })).toBe(true);
    expect(inScope(s, { postalCode: '99999', lat: null, lng: null })).toBe(false);
  });
});

describe('inferCause + scoreIncident', () => {
  const group = [contact(), contact(), contact({ symptomText: 'low pressure' })];
  it('without an official signal the cause stays "suspected" with explicit uncertainty', () => {
    const c = inferCause(group, [], NOW);
    expect(c.cause).toBe('water_supply_issue');
    expect(c.status).toBe('suspected');
    expect(c.uncertainty).toMatch(/may be wrong/);
  });
  it('a verified, active, matching signal corroborates; an unverified one does not', () => {
    expect(inferCause(group, [signal()], NOW).status).toBe('corroborated');
    expect(inferCause(group, [signal({ verified: false })], NOW).status).toBe('suspected');
    expect(inferCause(group, [signal({ expiresAt: minutesAgo(5) })], NOW).status).toBe('suspected');
    expect(inferCause(group, [signal({ corroborates: ['power_grid_outage'] })], NOW).status).toBe('suspected');
  });
  it('owner confirmation wins', () => {
    expect(inferCause(group, [], NOW, 'power_grid_outage')).toMatchObject({ cause: 'power_grid_outage', status: 'owner_confirmed' });
  });
  it('mixed symptoms produce alternatives and lower confidence', () => {
    const mixed = [contact(), contact({ symptomText: 'power is out' }), contact({ symptomText: 'power is out' }), contact({ symptomText: 'the furnace is not working' })];
    const c = inferCause(mixed, [], NOW);
    expect(c.alternatives.length).toBeGreaterThan(0);
  });
  it('confidence is capped without corroboration and below the minimum contact count', () => {
    const scope = computeScope(group);
    const sus = scoreIncident(group, scope, inferCause(group, [], NOW), DEFAULT_PARAMS);
    const cor = scoreIncident(group, scope, inferCause(group, [signal()], NOW), DEFAULT_PARAMS);
    expect(sus.value).toBeLessThanOrEqual(0.85);
    expect(cor.value).toBeGreaterThan(sus.value);
    const two = group.slice(0, 2);
    expect(scoreIncident(two, computeScope(two), inferCause(two, [], NOW), DEFAULT_PARAMS).value).toBeLessThanOrEqual(0.45);
    expect(cor.value).toBeLessThan(1);
  });
  it('more agreeing contacts never lower the score', () => {
    const base = Array.from({ length: 3 }, () => contact());
    const more = Array.from({ length: 8 }, () => contact());
    const s = (cs: IncidentContact[]) => scoreIncident(cs, computeScope(cs), inferCause(cs, [], NOW), DEFAULT_PARAMS).value;
    expect(s(more)).toBeGreaterThanOrEqual(s(base));
  });
});

describe('verified directory', () => {
  it('rejects unverified, stale, retired and empty entries', () => {
    expect(isDirectoryEntryUsable(dirEntry(), NOW)).toBe(true);
    expect(isDirectoryEntryUsable(dirEntry({ status: 'stale' }), NOW)).toBe(false);
    expect(isDirectoryEntryUsable(dirEntry({ status: 'retired' }), NOW)).toBe(false);
    expect(isDirectoryEntryUsable(dirEntry({ verifiedAt: null }), NOW)).toBe(false);
    expect(isDirectoryEntryUsable(dirEntry({ verifiedAt: '2024-01-01T00:00:00Z' }), NOW)).toBe(false);
    expect(isDirectoryEntryUsable(dirEntry({ sourceUrl: '' }), NOW)).toBe(false);
    expect(isDirectoryEntryUsable(dirEntry({ phone: null, website: null }), NOW)).toBe(false);
  });
  it('picks the most specific entry: tenant override > postal prefix > region > country', () => {
    const where = { country: 'us', region: 'tx', postalCode: '78701', service: 'water' as const, userId: 'u1' };
    const country = dirEntry({ id: 'country', region: null });
    const region = dirEntry({ id: 'region' });
    const prefix = dirEntry({ id: 'prefix', postalPrefix: '787' });
    const own = dirEntry({ id: 'own', userId: 'u1' });
    expect(pickDirectoryEntry([country, region], where, NOW)?.id).toBe('region');
    expect(pickDirectoryEntry([country, region, prefix], where, NOW)?.id).toBe('prefix');
    expect(pickDirectoryEntry([country, region, prefix, own], where, NOW)?.id).toBe('own');
  });
  it('never returns another tenant override, another region, another service or another country', () => {
    const where = { country: 'US', region: 'TX', postalCode: '78701', service: 'water' as const, userId: 'u1' };
    expect(pickDirectoryEntry([dirEntry({ userId: 'u2' })], where, NOW)).toBeNull();
    expect(pickDirectoryEntry([dirEntry({ region: 'CA' })], where, NOW)).toBeNull();
    expect(pickDirectoryEntry([dirEntry({ service: 'power' })], where, NOW)).toBeNull();
    expect(pickDirectoryEntry([dirEntry({ country: 'CA' })], where, NOW)).toBeNull();
    expect(pickDirectoryEntry([dirEntry({ postalPrefix: '900' })], where, NOW)).toBeNull();
  });
});

const incident = (over: Partial<IncidentForTriage> = {}): IncidentForTriage => ({
  id: 'inc1', status: 'active', symptomClass: 'no_water',
  scope: { kind: 'postal', postalCodes: ['78701'], center: null, radiusMiles: null, polygon: null },
  confidence: 0.8, cause: 'water_supply_issue', causeStatus: 'suspected', causeConfidence: 0.6, memberCount: 5, firstContactAt: minutesAgo(60), ...over,
});
const caller = (text: string, over: Partial<Parameters<typeof triageContact>[0]> = {}) => ({
  symptomText: text, hazards: [], isEmergency: false, postalCode: '78701', lat: null, lng: null, ...over,
});

describe('triageContact (honesty + safety)', () => {
  it('upstream-likely callers are told, still offered a booking, and the truck roll is held', () => {
    const r = triageContact(caller('we have no water'), [incident()]);
    expect(r.decision).toBe('upstream_likely');
    expect(r.offerBooking).toBe(true);
    expect(r.suggestHoldTruckRoll).toBe(true);
    expect(r.safetySteps.length).toBeGreaterThan(0);
  });
  it('a safety hazard is ALWAYS escalated, even inside a matching incident', () => {
    const r = triageContact(caller('no water and I smell gas'), [incident()]);
    expect(r.decision).toBe('escalate_emergency');
    expect(r.offerBooking).toBe(false);
    expect(r.incidentId).toBeNull();
  });
  it('an emergency flag alone also escalates', () => {
    expect(triageContact(caller('no water', { isEmergency: true }), [incident()]).decision).toBe('escalate_emergency');
  });
  it('detects hazards in free text via the shared safety screen', () => {
    expect(triageContact(caller('there are sparks coming from the outlet'), [incident()]).decision).toBe('escalate_emergency');
    expect(triageContact(caller('there is no gas smell, just no water'), [incident()]).decision).toBe('upstream_likely');
  });
  it('own-side evidence overrides the incident', () => {
    const r = triageContact(caller('no water but neighbors have water, only my house'), [incident()]);
    expect(r.decision).toBe('book_normally');
    expect(indicatesOwnSide('only my kitchen sink')).toBe(true);
    expect(indicatesOwnSide('no water on the whole street')).toBe(false);
  });
  it('low-confidence, out-of-scope, wrong-symptom and resolved incidents are not shared with callers', () => {
    expect(triageContact(caller('no water'), [incident({ confidence: 0.4 })]).decision).toBe('book_normally');
    expect(triageContact(caller('no water', { postalCode: '99999' }), [incident()]).decision).toBe('book_normally');
    expect(triageContact(caller('power is out'), [incident()]).decision).toBe('book_normally');
    expect(triageContact(caller('no water'), [incident({ status: 'resolved' })]).decision).toBe('book_normally');
    expect(triageContact(caller('no water'), [incident({ status: 'watching' })]).decision).toBe('book_normally');
  });
});

describe('buildGuidance (what Sarah is told)', () => {
  const inc = incident();
  const triage = triageContact(caller('no water'), [inc]);
  it('hedges, never asserts a cause, and still offers booking', () => {
    const text = buildGuidance({ triage, incident: inc, country: 'US', directoryEntry: null, brandName: 'Acme Plumbing' });
    expect(text).toMatch(/hedged/i);
    expect(text).toMatch(/NOT confirmed|have NOT confirmed/i);
    expect(text).toMatch(/STILL offer to book/);
  });
  it('with a verified entry it passes the exact number and verification date', () => {
    const text = buildGuidance({ triage, incident: inc, country: 'US', directoryEntry: dirEntry(), brandName: 'Acme' });
    expect(text).toContain('+15125550100');
    expect(text).toContain('2026-09-01');
  });
  it('without a verified entry it forbids inventing a number', () => {
    const text = buildGuidance({ triage, incident: inc, country: 'US', directoryEntry: null, brandName: 'Acme' });
    expect(text).toMatch(/do NOT have a verified contact/);
    expect(text).toMatch(/NEVER invent/);
    expect(text).not.toMatch(/\+1\d{10}/);
  });
  it('emergency guidance never mentions the incident and uses the national emergency number', () => {
    const t = triageContact(caller('smell gas'), [inc]);
    const text = buildGuidance({ triage: t, incident: inc, country: 'GB', directoryEntry: dirEntry(), brandName: 'Acme' });
    expect(text).toMatch(/Do NOT mention any area incident/);
    expect(text).toContain(NATIONAL_EMERGENCY_NUMBER.GB);
    expect(text).not.toContain('City Water Utility');
  });
  it('book_normally carries no incident language', () => {
    const t = triageContact(caller('no water', { postalCode: '99999' }), [inc]);
    expect(buildGuidance({ triage: t, incident: null, country: 'US', directoryEntry: null, brandName: 'Acme' })).toMatch(/book the visit/);
  });
});

describe('broadcast text', () => {
  it('is hedged, states no restoration time, carries STOP language', () => {
    const t = buildBroadcastText({ brandName: 'Acme', cause: 'power_grid_outage', causeStatus: 'suspected', directoryEntry: null, kind: 'update' });
    expect(t).toMatch(/may be/);
    expect(t).toMatch(/haven't confirmed/);
    expect(t).toMatch(/STOP/);
    expect(t.length).toBeLessThan(480);
  });
  it('resolved text does not claim the problem is fixed for everyone', () => {
    expect(buildBroadcastText({ brandName: 'Acme', cause: 'unknown', causeStatus: 'suspected', directoryEntry: null, kind: 'resolved' })).toMatch(/no longer seeing reports/);
  });
});

describe('lifecycle', () => {
  it('moves active -> monitoring -> resolved by inactivity and never resurrects closed incidents', () => {
    expect(nextStatusByInactivity('active', minutesAgo(30), NOW, 120)).toBe('active');
    expect(nextStatusByInactivity('active', minutesAgo(200), NOW, 120)).toBe('monitoring');
    expect(nextStatusByInactivity('monitoring', minutesAgo(60 * 25), NOW, 120)).toBe('resolved');
    expect(nextStatusByInactivity('dismissed', minutesAgo(5000), NOW, 120)).toBe('dismissed');
  });
  it('statusForNewScore needs members and confidence', () => {
    expect(statusForNewScore('watching', 0.9, 2, DEFAULT_PARAMS)).toBe('watching');
    expect(statusForNewScore('watching', 0.6, 3, DEFAULT_PARAMS)).toBe('active');
    expect(statusForNewScore('resolved', 0.99, 9, DEFAULT_PARAMS)).toBe('resolved');
  });
  it('titles never state a cause as fact', () => {
    expect(incidentTitle('water_supply_issue', { kind: 'postal', postalCodes: ['78701'], center: null, radiusMiles: null, polygon: null })).toMatch(/^Possible /);
    expect(incidentTitle('unknown', { kind: 'postal', postalCodes: [], center: null, radiusMiles: null, polygon: null })).toMatch(/Cluster/);
  });
});

describe('dashboard helpers', () => {
  it('upsertById inserts new rows first and replaces existing ones in place', () => {
    const rows = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
    expect(upsertById(rows, { id: 'c', v: 3 }).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(upsertById(rows, { id: 'b', v: 9 })).toEqual([{ id: 'a', v: 1 }, { id: 'b', v: 9 }]);
    expect(rows[1].v).toBe(2);
  });
  it('removeById and isOpenStatus', () => {
    expect(removeById([{ id: 'a' }, { id: 'b' }], 'a')).toEqual([{ id: 'b' }]);
    expect(isOpenStatus('active')).toBe(true);
    expect(isOpenStatus('resolved')).toBe(false);
  });
  it('sorts active first, then most recent', () => {
    const r = sortIncidentRows([
      { id: '1', status: 'resolved' as const, last_contact_at: '2026-11-03T10:00:00Z' },
      { id: '2', status: 'active' as const, last_contact_at: '2026-11-03T08:00:00Z' },
      { id: '3', status: 'active' as const, last_contact_at: '2026-11-03T09:00:00Z' },
    ]);
    expect(r.map((x) => x.id)).toEqual(['3', '2', '1']);
  });
});

describe('phase 2 helpers', () => {
  it('looksGeocodable needs a number and letters and a sane length', () => {
    expect(looksGeocodable('123 Main St, Austin TX')).toBe(true);
    expect(looksGeocodable('Main Street')).toBe(false);
    expect(looksGeocodable('12')).toBe(false);
    expect(looksGeocodable(null)).toBe(false);
    expect(looksGeocodable('1'.repeat(400) + ' Main')).toBe(false);
  });
  it('dispatcher note is informational and bounded', () => {
    const n = buildBookingNote('Possible water supply issue — 78701');
    expect(n).toMatch(/Re-check status before rolling a truck/);
    expect(buildBookingNote('x'.repeat(500)).length).toBeLessThan(260);
  });
  it('SMS auto-reply is hedged, offers a booking, carries STOP and never invents a number', () => {
    const t = buildSmsAutoReplyText({ brandName: 'Acme', cause: 'power_grid_outage', causeStatus: 'suspected', directoryEntry: null });
    expect(t).toMatch(/may be/);
    expect(t).toMatch(/haven't confirmed/);
    expect(t).toMatch(/reply BOOK/);
    expect(t).toMatch(/STOP/);
    expect(t).not.toMatch(/\+\d{8,}/);
    expect(t.length).toBeLessThan(520);
    const withEntry = buildSmsAutoReplyText({ brandName: 'Acme', cause: 'water_supply_issue', causeStatus: 'corroborated', directoryEntry: dirEntry() });
    expect(withEntry).toContain('+15125550100');
    expect(withEntry).toMatch(/appears to be/);
  });
});
