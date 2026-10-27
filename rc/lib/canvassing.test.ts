import { describe, it, expect } from 'vitest';
import {
  EMPTY_VISIT,
  addressKey,
  canManageCanvassing,
  canvassErrorMessage,
  chunk,
  computeBounds,
  countByStatus,
  coverage,
  doorsToGeoJSON,
  filterDoors,
  followUpBucket,
  formatAddress,
  haversineKm,
  isoToLocalInput,
  localInputToIso,
  normalizeZone,
  parseCoordinate,
  parseDoorsCsv,
  parseReport,
  parseZoneList,
  pct,
  quickFollowUp,
  sortByDistance,
  validateDoorDraft,
  validateVisit,
  type Door,
} from './canvassing';

const NOW = new Date('2027-03-10T12:00:00');
const known: { name: string | null; phone: string | null; email: string | null } = { name: null, phone: null, email: null };

function door(p: Partial<Door> = {}): Door {
  return {
    id: 'd1', user_id: 'o1', territory_id: 't1', line1: '100 Main St', line2: null, city: 'Austin', state: 'TX', zip: '78701', zone: '78701',
    lat: 30.27, lng: -97.74, status: 'new', visit_count: 0, last_visit_at: null, contact_name: null, contact_phone: null, contact_email: null,
    lead_id: null, follow_up_at: null, follow_up_task_id: null, created_at: '2027-03-01T00:00:00Z', ...p,
  };
}

describe('zones', () => {
  it('normalises US ZIPs and Canadian FSAs', () => {
    expect(normalizeZone('78701-1234')).toBe('78701');
    expect(normalizeZone(' m5v 3l9 ')).toBe('M5V');
    expect(normalizeZone('abc')).toBeNull();
    expect(normalizeZone('123')).toBeNull();
  });

  it('parses a pasted list, keeps full Canadian codes together, dedupes and reports invalid tokens', () => {
    const r = parseZoneList('78702, 78701 78701\nM5V 3L9; ABCDE');
    expect(r.zones).toEqual(['78701', '78702', 'M5V']);
    expect(r.invalid).toEqual(['ABCDE']);
  });

  it('builds the same address key the database does', () => {
    expect(addressKey('100 Main St.', 'Apt 2', '78701-0001')).toBe('100mainstapt2|78701');
    expect(addressKey('100 MAIN st', null, null)).toBe('100mainst|');
    expect(addressKey('100 Main St', '', '78701')).toBe(addressKey('100 main st', null, '78701'));
  });
});

describe('coordinates and map maths', () => {
  it('parses and range-checks coordinates', () => {
    expect(parseCoordinate('30.2672', 'lat')).toBe(30.2672);
    expect(parseCoordinate('-97.7', 'lng')).toBe(-97.7);
    expect(parseCoordinate('95', 'lat')).toBeNull();
    expect(parseCoordinate('1e3', 'lng')).toBeNull();
    expect(parseCoordinate('', 'lat')).toBeNull();
  });

  it('computes bounds and ignores nothing when empty', () => {
    expect(computeBounds([])).toBeNull();
    expect(computeBounds([{ lat: 1, lng: 2 }, { lat: 3, lng: -4 }])).toEqual([[-4, 1], [2, 3]]);
  });

  it('measures distance and sorts nearest first with unpinned doors last', () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(0);
    expect(haversineKm({ lat: 30.2672, lng: -97.7431 }, { lat: 29.7604, lng: -95.3698 })).toBeCloseTo(235, -1);
    const here = { lat: 30.27, lng: -97.74 };
    const rows = sortByDistance([
      door({ id: 'far', lat: 31, lng: -97 }),
      door({ id: 'none', lat: null, lng: null }),
      door({ id: 'near', lat: 30.2701, lng: -97.7401 }),
    ], here);
    expect(rows.map((r) => r.door.id)).toEqual(['near', 'far', 'none']);
    expect(rows[2].km).toBeNull();
  });

  it('only puts doors with a pin into GeoJSON', () => {
    const fc = doorsToGeoJSON([door(), door({ id: 'd2', lat: null, lng: null })]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry.coordinates).toEqual([-97.74, 30.27]);
    expect(fc.features[0].properties.status).toBe('new');
  });
});

describe('filters and summaries', () => {
  const doors = [
    door({ id: 'a', status: 'sold', territory_id: 't1' }),
    door({ id: 'b', status: 'new', territory_id: 't2', line1: '7 Elm Ave', contact_name: 'Sam' }),
    door({ id: 'c', status: 'no_answer', territory_id: null }),
  ];

  it('filters by territory, unassigned, status and text', () => {
    const base = { territory: 'all', statuses: [] as Door['status'][], query: '' };
    expect(filterDoors(doors, base)).toHaveLength(3);
    expect(filterDoors(doors, { ...base, territory: 't1' }).map((d) => d.id)).toEqual(['a']);
    expect(filterDoors(doors, { ...base, territory: 'none' }).map((d) => d.id)).toEqual(['c']);
    expect(filterDoors(doors, { ...base, statuses: ['sold', 'new'] }).map((d) => d.id)).toEqual(['a', 'b']);
    expect(filterDoors(doors, { ...base, query: 'sam' }).map((d) => d.id)).toEqual(['b']);
    expect(filterDoors(doors, { ...base, query: 'elm' }).map((d) => d.id)).toEqual(['b']);
  });

  it('counts statuses and coverage', () => {
    const counts = countByStatus(doors);
    expect(counts.sold).toBe(1);
    expect(counts.new).toBe(1);
    expect(counts.do_not_knock).toBe(0);
    expect(coverage(doors)).toEqual({ total: 3, knocked: 2, pct: 67 });
    expect(coverage([])).toEqual({ total: 0, knocked: 0, pct: 0 });
  });

  it('formats addresses and small helpers', () => {
    expect(formatAddress(door({ line2: 'Apt 4' }))).toBe('100 Main St Apt 4, Austin, TX 78701');
    expect(formatAddress(door({ city: null, state: null, zip: null }))).toBe('100 Main St');
    expect(pct(1, 0)).toBe(0);
    expect(pct(1, 3)).toBe(33);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(canManageCanvassing(true, {})).toBe(true);
    expect(canManageCanvassing(false, { can_manage_team: true })).toBe(true);
    expect(canManageCanvassing(false, { can_view_billing: true })).toBe(false);
  });
});

describe('follow-ups', () => {
  it('buckets overdue / today / upcoming', () => {
    expect(followUpBucket('2027-03-10T09:00:00', NOW)).toBe('overdue');
    expect(followUpBucket('2027-03-10T18:00:00', NOW)).toBe('today');
    expect(followUpBucket('2027-03-11T09:00:00', NOW)).toBe('upcoming');
  });

  it('round-trips datetime-local values and builds quick follow-ups at 10:00', () => {
    const iso = localInputToIso('2027-03-12T10:30');
    expect(iso).toBeTruthy();
    expect(isoToLocalInput(iso as string)).toBe('2027-03-12T10:30');
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('tomorrow')).toBeNull();
    expect(quickFollowUp('tomorrow', NOW)).toBe('2027-03-11T10:00');
    expect(quickFollowUp('nextWeek', NOW)).toBe('2027-03-17T10:00');
  });
});

describe('validateVisit (mirrors canvass_visit_log)', () => {
  const v = (p: Partial<typeof EMPTY_VISIT>, k = known) => validateVisit({ ...EMPTY_VISIT, ...p }, k, NOW);

  it('needs an outcome', () => {
    expect(v({}).outcome).toBeTruthy();
  });

  it('lets a plain no-answer through with nothing else', () => {
    expect(v({ outcome: 'no_answer' })).toEqual({});
    expect(v({ outcome: 'not_interested' })).toEqual({});
  });

  it('requires a name and a phone or email for lead-creating outcomes', () => {
    expect(v({ outcome: 'interested' }).contactName).toBeTruthy();
    expect(v({ outcome: 'interested', contactName: 'Jane' }).contactPhone).toBeTruthy();
    expect(v({ outcome: 'interested', contactName: 'Jane', contactEmail: 'jane@x.com' })).toEqual({});
    expect(v({ outcome: 'sold', contactName: 'Jane', contactPhone: '(512) 555-0100' })).toEqual({});
  });

  it('reuses contact details already stored on the door', () => {
    expect(v({ outcome: 'interested' }, { name: 'Jane', phone: '5125550100', email: null })).toEqual({});
  });

  it('validates phone and email formats', () => {
    expect(v({ outcome: 'callback', contactPhone: '12', followUp: '2027-03-11T10:00' }).contactPhone).toBeTruthy();
    expect(v({ outcome: 'callback', contactEmail: 'nope', followUp: '2027-03-11T10:00' }).contactEmail).toBeTruthy();
  });

  it('requires a future follow-up for callback and appointment_set', () => {
    expect(v({ outcome: 'callback' }).followUp).toBeTruthy();
    expect(v({ outcome: 'callback', followUp: '2027-03-09T10:00' }).followUp).toBeTruthy();
    expect(v({ outcome: 'callback', followUp: '2027-03-11T10:00' })).toEqual({});
    expect(v({ outcome: 'callback', followUp: '2029-01-01T10:00' }).followUp).toBeTruthy();
    expect(v({ outcome: 'appointment_set', contactName: 'J', contactPhone: '5125550100' }).followUp).toBeTruthy();
  });

  it('ignores the follow-up for outcomes that close it', () => {
    expect(v({ outcome: 'sold', contactName: 'J', contactPhone: '5125550100', followUp: 'garbage' })).toEqual({});
    expect(v({ outcome: 'do_not_knock', followUp: 'garbage' })).toEqual({});
  });

  it('caps the note length', () => {
    expect(v({ outcome: 'no_answer', note: 'x'.repeat(1001) }).note).toBeTruthy();
  });
});

describe('door drafts and CSV import', () => {
  it('validates a single door', () => {
    expect(validateDoorDraft({ line1: '', line2: '', city: '', state: '', zip: '' }).line1).toBeTruthy();
    expect(validateDoorDraft({ line1: '1 A St', line2: '', city: '', state: '', zip: '123' }).zip).toBeTruthy();
    expect(validateDoorDraft({ line1: '1 A St', line2: '', city: '', state: '', zip: 'M5V 3L9' })).toEqual({});
    expect(validateDoorDraft({ line1: '1 A St', line2: '', city: '', state: '', zip: '' })).toEqual({});
  });

  it('imports a CSV with flexible headers, quotes and coordinates', () => {
    const r = parseDoorsCsv('Street Address,City,State,Zip Code,Latitude,Longitude\n"100 Main St, Unit 2",Austin,TX,78701,30.27,-97.74\n7 Elm,Austin,TX,78702,,\n');
    expect(r.error).toBeNull();
    expect(r.doors).toHaveLength(2);
    expect(r.doors[0]).toMatchObject({ line1: '100 Main St, Unit 2', zip: '78701', lat: 30.27, lng: -97.74 });
    expect(r.doors[1].lat).toBeNull();
  });

  it('skips bad rows and explains empty input', () => {
    const r = parseDoorsCsv('address,zip,lat,lng\n,78701,,\n1 A St,123,,\n2 B St,78701,95,0\n3 C St,78701,30,\n4 D St,78701,30,-97\n');
    expect(r.doors.map((d) => d.line1)).toEqual(['4 D St']);
    expect(r.skipped).toBe(4);
    expect(parseDoorsCsv('').error).toBeTruthy();
    expect(parseDoorsCsv('city\nAustin').error).toMatch(/address/i);
  });

  it('supports tab-separated lists', () => {
    const r = parseDoorsCsv('address\tzip\n1 A St\t78701');
    expect(r.doors).toHaveLength(1);
  });
});

describe('report parsing and errors', () => {
  it('coerces the RPC payload defensively', () => {
    const r = parseReport({ days: 30, totals: { knocks: '5', doors: 4, contacts: 3, sold: 1 }, by_rep: [{ rep_user_id: 'u1', name: 'Rita', knocks: 5 }], by_territory: [{ territory_id: 't1', name: 'North', doors_total: 10 }] });
    expect(r.totals.knocks).toBe(5);
    expect(r.totals.leads).toBe(0);
    expect(r.by_rep[0]).toMatchObject({ name: 'Rita', knocks: 5, sold: 0 });
    expect(r.by_territory[0].color).toBe('#2563EB');
    expect(parseReport(null).by_rep).toEqual([]);
  });

  it('maps database error codes to friendly copy', () => {
    expect(canvassErrorMessage({ message: 'door_do_not_knock' }, 'x')).toMatch(/Do Not Knock/);
    expect(canvassErrorMessage({ message: 'territory_name_taken' }, 'x')).toMatch(/already uses/);
    expect(canvassErrorMessage({ code: '42501' }, 'x')).toMatch(/access/);
    expect(canvassErrorMessage({ message: 'weird' }, 'fallback')).toBe('fallback');
  });
});
