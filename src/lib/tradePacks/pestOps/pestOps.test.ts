import { describe, it, expect } from 'vitest';
import {
  planVisits, validateSchedule, expectedVisitsPerTerm, inSeason, PEST_CADENCES,
  assessCallback, guaranteeWindow, daysBetween, localDateOf, normalizeTerms, pickOriginalService, DEFAULT_TERMS,
  convertQuantity, planUsageDeduction, planVoidReversal, replayMovements, unitFamily, usageKey, voidKey,
  REGION_PRESETS, validateRegionProfile, checkRecord, summarizeCompleteness, RECORD_FIELDS,
  buildTreatmentReport, buildPreVisitNotice, noticeSendAt, noticeIdempotencyKey, escapeHtml,
  assessRenewal, nextTerm, termMonths, cancellationEffectiveOn,
  MockNotifier, retryDelayMinutes,
  type ScheduleInput, type RecordSource, type PriorService,
} from './index';

const base: ScheduleInput = { startDate: '2027-01-31', cadence: 'monthly', timeZone: 'UTC', localTime: '09:00', limit: 5 };
const dates = (i: Partial<ScheduleInput>) => planVisits({ ...base, ...i }).map((v) => v.date);

describe('cadence — month ends', () => {
  it('monthly from Jan 31 clamps to the last day and never drifts', () => {
    expect(dates({})).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  });
  it('honours leap years', () => {
    expect(dates({ startDate: '2028-01-31', limit: 3 })).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
  });
  it('quarterly from Nov 30 stays anchored', () => {
    expect(dates({ startDate: '2027-11-30', cadence: 'quarterly', limit: 4 })).toEqual(['2027-11-30', '2028-02-29', '2028-05-30', '2028-08-30']);
  });
  it('bimonthly and annual use the right interval', () => {
    expect(dates({ startDate: '2027-03-15', cadence: 'bimonthly', limit: 3 })).toEqual(['2027-03-15', '2027-05-15', '2027-07-15']);
    expect(dates({ startDate: '2028-02-29', cadence: 'annual', limit: 3 })).toEqual(['2028-02-29', '2029-02-28', '2030-02-28']);
  });
  it('fromN and limit page through the same series', () => {
    const all = dates({ limit: 6 });
    expect(dates({ fromN: 3, limit: 3 })).toEqual(all.slice(3, 6));
  });
});

describe('cadence — DST keeps the wall-clock time', () => {
  const utc = (i: Partial<ScheduleInput>) => planVisits({ ...base, ...i }).map((v) => v.startsAtUtc);
  it('New York spring forward (2027-03-14)', () => {
    expect(utc({ startDate: '2027-02-14', timeZone: 'America/New_York', limit: 2 })).toEqual(['2027-02-14T14:00:00.000Z', '2027-03-14T13:00:00.000Z']);
  });
  it('New York fall back (2027-11-07)', () => {
    expect(utc({ startDate: '2027-10-07', timeZone: 'America/New_York', limit: 2 })).toEqual(['2027-10-07T13:00:00.000Z', '2027-11-07T14:00:00.000Z']);
  });
  it('Berlin spring forward (2027-03-28)', () => {
    expect(utc({ startDate: '2027-02-28', timeZone: 'Europe/Berlin', limit: 2 })).toEqual(['2027-02-28T08:00:00.000Z', '2027-03-28T07:00:00.000Z']);
  });
  it('Sydney DST ends in April (southern hemisphere)', () => {
    const v = utc({ startDate: '2027-03-04', timeZone: 'Australia/Sydney', limit: 2 });
    expect(v[0]).toBe('2027-03-03T22:00:00.000Z'); // AEDT +11
    expect(v[1]).toBe('2027-04-03T23:00:00.000Z'); // AEST +10
  });
  it('a time inside the spring-forward gap still yields a valid instant', () => {
    const v = planVisits({ ...base, startDate: '2027-03-14', timeZone: 'America/New_York', localTime: '02:30', limit: 1 })[0];
    expect(Number.isNaN(new Date(v.startsAtUtc).getTime())).toBe(false);
    expect(v.date).toBe('2027-03-14');
  });
});

describe('cadence — seasons', () => {
  it('Apr–Oct monthly starts at the season opening and stops at its end', () => {
    const v = planVisits({ ...base, startDate: '2027-01-15', cadence: 'seasonal', season: { fromMonth: 4, toMonth: 10 }, limit: 20 });
    expect(v.map((x) => x.date)).toEqual(['2027-04-01', '2027-05-01', '2027-06-01', '2027-07-01', '2027-08-01', '2027-09-01', '2027-10-01']);
  });
  it('a window that wraps the new year (Nov–Mar)', () => {
    const v = planVisits({ ...base, startDate: '2027-06-10', cadence: 'seasonal', season: { fromMonth: 11, toMonth: 3 }, limit: 20 });
    expect(v.map((x) => x.date)).toEqual(['2027-11-01', '2027-12-01', '2028-01-01', '2028-02-01', '2028-03-01']);
  });
  it('inSeason handles both window shapes', () => {
    expect(inSeason(4, { fromMonth: 4, toMonth: 10 })).toBe(true);
    expect(inSeason(11, { fromMonth: 4, toMonth: 10 })).toBe(false);
    expect(inSeason(1, { fromMonth: 11, toMonth: 3 })).toBe(true);
    expect(inSeason(7, { fromMonth: 11, toMonth: 3 })).toBe(false);
  });
  it('a shift never pushes a visit out of season', () => {
    const v = planVisits({ ...base, startDate: '2027-10-31', cadence: 'seasonal', season: { fromMonth: 4, toMonth: 10 }, routeWeekdays: [1, 2, 3, 4, 5], limit: 1 })[0];
    expect(v.anchorDate).toBe('2027-10-31'); // a Sunday
    expect(v.date).toBe('2027-10-29'); // Friday, still October
    expect(v.status).toBe('shifted');
    expect(v.shiftedDays).toBe(-2);
  });
  it('expectedVisitsPerTerm', () => {
    expect(expectedVisitsPerTerm('quarterly', null)).toBe(4);
    expect(expectedVisitsPerTerm('bimonthly', null)).toBe(6);
    expect(expectedVisitsPerTerm('annual', null)).toBe(1);
    expect(expectedVisitsPerTerm('seasonal', { fromMonth: 4, toMonth: 10 })).toBe(7);
    expect(expectedVisitsPerTerm('seasonal', { fromMonth: 11, toMonth: 3 })).toBe(5);
  });
});

describe('cadence — route rules', () => {
  it('shifts to the next allowed weekday without moving the anchor', () => {
    const v = planVisits({ ...base, startDate: '2027-05-01', routeWeekdays: [1, 2, 3, 4, 5], limit: 3 });
    expect(v[0]).toMatchObject({ anchorDate: '2027-05-01', date: '2027-05-03', status: 'shifted', shiftedDays: 2 });
    expect(v[1]).toMatchObject({ anchorDate: '2027-06-01', date: '2027-06-01', status: 'ok' });
    expect(v[2].anchorDate).toBe('2027-07-01');
  });
  it('skips closed dates', () => {
    const v = planVisits({ ...base, startDate: '2027-05-04', closedDates: ['2027-05-04'], limit: 1 })[0];
    expect(v.date).toBe('2027-05-05');
  });
  it('flags needs_attention when no allowed day is close enough', () => {
    const v = planVisits({ ...base, startDate: '2027-05-01', routeWeekdays: [3], maxShiftDays: 1, limit: 1 })[0];
    expect(v.status).toBe('needs_attention');
    expect(v.date).toBe('2027-05-01');
  });
});

describe('cadence — validation', () => {
  it('reports bad input', () => {
    expect(validateSchedule({ ...base, startDate: '2027-02-30' })).toContain('Start date is not a valid date');
    expect(validateSchedule({ ...base, cadence: 'seasonal' })).toContain('A seasonal plan needs a season (from-month and to-month)');
    expect(validateSchedule({ ...base, localTime: '9am' })).toContain('Start time must be HH:MM');
    expect(validateSchedule({ ...base, timeZone: 'Mars/Base' })).toContain('Unknown time zone');
    expect(validateSchedule({ ...base, routeWeekdays: [7] })).toContain('Route weekdays must be 0-6');
    expect(validateSchedule({ ...base, endDate: '2026-01-01' })).toContain('End date is before the start date');
  });
  it('planVisits throws instead of guessing', () => {
    expect(() => planVisits({ ...base, startDate: 'nope' })).toThrow();
  });
  it('knows every cadence', () => {
    expect(Object.keys(PEST_CADENCES)).toHaveLength(5);
  });
});

describe('guarantee window', () => {
  const orig = { serviceDate: '2027-03-01', targets: ['Ants'], terms: DEFAULT_TERMS, coveredCallbacks: 0 };
  it('covers day 0 through day N inclusive, not N+1', () => {
    expect(guaranteeWindow('2027-03-01', 30).endsOn).toBe('2027-03-31');
    const last = assessCallback('2027-03-31', orig, ['Ants']);
    expect(last.covered).toBe(true);
    expect(last.daysRemaining).toBe(0);
    const after = assessCallback('2027-04-01', orig, ['Ants']);
    expect(after.outcome).toBe('out_of_window');
    expect(after.billable).toBe(true);
    expect(after.daysRemaining).toBe(-1);
  });
  it('crosses month ends and leap days correctly', () => {
    expect(guaranteeWindow('2028-02-15', 30).endsOn).toBe('2028-03-16');
    expect(guaranteeWindow('2027-02-15', 30).endsOn).toBe('2027-03-17');
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
  it('a zero-day guarantee covers only the service day', () => {
    const t = { ...orig, terms: normalizeTerms({ windowDays: 0 }) };
    expect(assessCallback('2027-03-01', t, ['Ants']).covered).toBe(true);
    expect(assessCallback('2027-03-02', t, ['Ants']).covered).toBe(false);
  });
  it('rejects a request dated before the service', () => {
    expect(assessCallback('2027-02-28', orig, ['Ants']).outcome).toBe('out_of_window');
  });
  it('same-target rule is case-insensitive and can be turned off', () => {
    expect(assessCallback('2027-03-10', orig, ['ants']).covered).toBe(true);
    expect(assessCallback('2027-03-10', orig, ['Rodents']).outcome).toBe('target_mismatch');
    const loose = { ...orig, terms: { ...DEFAULT_TERMS, sameTargetOnly: false } };
    expect(assessCallback('2027-03-10', loose, ['Rodents']).covered).toBe(true);
  });
  it('skips the same-target rule when the original recorded no targets, but a request with none cannot match', () => {
    const noTargets = { ...orig, targets: [] };
    expect(assessCallback('2027-03-10', noTargets, ['Rodents']).covered).toBe(true);
    expect(assessCallback('2027-03-10', orig, []).outcome).toBe('target_mismatch');
  });
  it('enforces the callback limit', () => {
    const limited = { ...orig, terms: { ...DEFAULT_TERMS, maxCallbacks: 2 }, coveredCallbacks: 2 };
    expect(assessCallback('2027-03-10', limited, ['Ants']).outcome).toBe('callback_limit');
    expect(assessCallback('2027-03-10', { ...limited, coveredCallbacks: 1 }, ['Ants']).covered).toBe(true);
  });
  it('normalizeTerms clamps and defaults', () => {
    expect(normalizeTerms({ windowDays: 9999 }).windowDays).toBe(365);
    expect(normalizeTerms({ windowDays: -4 }).windowDays).toBe(0);
    expect(normalizeTerms(null)).toEqual(DEFAULT_TERMS);
    expect(normalizeTerms({ maxCallbacks: -1 }).maxCallbacks).toBeNull();
  });
  it('uses the tenant-local date, not UTC, for the service day', () => {
    expect(localDateOf('2027-03-14T04:30:00Z', 'America/New_York')).toBe('2027-03-13');
    expect(localDateOf('2027-03-14T04:30:00Z', 'Europe/Berlin')).toBe('2027-03-14');
  });
  it('pickOriginalService prefers the latest covering non-callback service', () => {
    const mk = (id: string, serviceDate: string, isCallback = false): PriorService => ({ id, serviceDate, targets: ['Ants'], terms: DEFAULT_TERMS, coveredCallbacks: 0, isCallback });
    const pick = pickOriginalService('2027-04-10', ['Ants'], [mk('old', '2027-01-05'), mk('mid', '2027-03-20'), mk('cb', '2027-04-02', true)]);
    expect(pick?.service.id).toBe('mid');
    expect(pick?.assessment.covered).toBe(true);
    const none = pickOriginalService('2027-09-01', ['Ants'], [mk('old', '2027-01-05')]);
    expect(none?.assessment.outcome).toBe('out_of_window');
    expect(pickOriginalService('2027-01-01', ['Ants'], [mk('later', '2027-02-01')])).toBeNull();
  });
});

describe('inventory deduction', () => {
  it('converts inside a family and refuses across families', () => {
    expect(convertQuantity(1, 'gal', 'fl_oz')).toBe(128);
    expect(convertQuantity(1, 'lb', 'oz')).toBe(16);
    expect(convertQuantity(2, 'kg', 'g')).toBe(2000);
    expect(convertQuantity(1, 'l', 'ml')).toBe(1000);
    expect(convertQuantity(1, 'fl_oz', 'lb')).toBeNull();
    expect(convertQuantity(1, 'each', 'g')).toBeNull();
    expect(convertQuantity(1, 'bushel', 'g')).toBeNull();
    expect(unitFamily('oz')).toBe('mass');
    expect(unitFamily('fl_oz')).toBe('volume');
  });
  it('deducts converted usage from on-hand stock', () => {
    const p = planUsageDeduction({ onHand: 10, unit: 'gal', reorderPoint: 2 }, { ledgerEntryId: 'e1', amount: 32, unit: 'fl_oz' });
    expect(p.delta).toBe(-0.25);
    expect(p.newOnHand).toBe(9.75);
    expect(p.idempotencyKey).toBe('usage:e1');
    expect(p.lowStock).toBe(false);
  });
  it('flags low stock at the reorder point', () => {
    const p = planUsageDeduction({ onHand: 2.1, unit: 'gal', reorderPoint: 2 }, { ledgerEntryId: 'e2', amount: 16, unit: 'fl_oz' });
    expect(p.newOnHand).toBe(1.975);
    expect(p.lowStock).toBe(true);
  });
  it('goes negative instead of blocking the compliance record', () => {
    const p = planUsageDeduction({ onHand: 0.1, unit: 'gal', reorderPoint: null }, { ledgerEntryId: 'e3', amount: 1, unit: 'gal' });
    expect(p.ok).toBe(true);
    expect(p.negative).toBe(true);
    expect(p.newOnHand).toBe(-0.9);
  });
  it('records an unconvertible unit as a zero movement', () => {
    const p = planUsageDeduction({ onHand: 5, unit: 'gal', reorderPoint: null }, { ledgerEntryId: 'e4', amount: 2, unit: 'lb' });
    expect(p.unconvertible).toBe(true);
    expect(p.delta).toBe(0);
    expect(p.newOnHand).toBe(5);
  });
  it('ignores non-positive amounts', () => {
    expect(planUsageDeduction({ onHand: 5, unit: 'oz', reorderPoint: null }, { ledgerEntryId: 'e5', amount: 0, unit: 'oz' }).ok).toBe(false);
    expect(planUsageDeduction({ onHand: 5, unit: 'oz', reorderPoint: null }, { ledgerEntryId: 'e6', amount: Number.NaN, unit: 'oz' }).ok).toBe(false);
  });
  it('a void gives back exactly what the usage took', () => {
    const stock = { onHand: 10, unit: 'gal' as const, reorderPoint: null };
    const use = planUsageDeduction(stock, { ledgerEntryId: 'e7', amount: 40, unit: 'fl_oz' });
    const back = planVoidReversal({ ...stock, onHand: use.newOnHand }, { ledgerEntryId: 'e7', amount: 40, unit: 'fl_oz' });
    expect(back.newOnHand).toBe(10);
    expect(back.idempotencyKey).toBe(voidKey('e7'));
    expect(back.idempotencyKey).not.toBe(usageKey('e7'));
  });
  it('replaying the same ledger entry never double-deducts', () => {
    const m = { delta: -0.25, idempotencyKey: 'usage:e1' };
    expect(replayMovements(10, [m, m, m])).toBe(9.75);
    expect(replayMovements(10, [m, { delta: -1, idempotencyKey: 'usage:e2' }, m])).toBe(8.75);
  });
  it('does not accumulate float drift', () => {
    let on = 1;
    for (let i = 0; i < 10; i += 1) on = planUsageDeduction({ onHand: on, unit: 'gal', reorderPoint: null }, { ledgerEntryId: `d${i}`, amount: 0.1, unit: 'gal' }).newOnHand;
    expect(on).toBe(0);
  });
});

describe('region record requirements (REQUIRES COUNSEL)', () => {
  const rec: RecordSource = {
    performed_at: '2027-05-01T14:00:00Z', site_address: '1 Main St', technician_name: 'Pat Lee', credential_number: 'A-123',
    product_name: 'Bug-B-Gone', product_epa_reg: '1234-56', product_exempt: false, customer_name: 'Sam Jones',
    data: { amount: 2, amount_unit: 'fl_oz', target_pests: ['Ants'], application_site: 'Exterior', method: 'Spray', wind_mph: 4, customer_notified: true, dilution: '1 oz/gal' },
  };
  it('every preset is flagged REQUIRES COUNSEL and only uses known fields', () => {
    for (const p of REGION_PRESETS) {
      expect(p.requiresCounsel).toBe(true);
      expect(p.requiredFields.every((f) => (RECORD_FIELDS as readonly string[]).includes(f))).toBe(true);
    }
  });
  it('a complete record passes the extended preset', () => {
    const ext = REGION_PRESETS.find((p) => p.key === 'extended')!;
    expect(checkRecord(rec, ext.requiredFields)).toEqual({ complete: true, missing: [] });
  });
  it('lists exactly what is missing', () => {
    const r = { ...rec, credential_number: null, data: { ...rec.data, target_pests: [], wind_mph: undefined } };
    const c = checkRecord(r, ['applicator_license', 'target_pest', 'weather_conditions', 'product_name']);
    expect(c.missing).toEqual(['applicator_license', 'target_pest', 'weather_conditions']);
  });
  it('a registration-exempt product satisfies the registration field', () => {
    const r = { ...rec, product_epa_reg: null, product_exempt: true };
    expect(checkRecord(r, ['epa_reg_number']).complete).toBe(true);
    expect(checkRecord({ ...r, product_exempt: false }, ['epa_reg_number']).complete).toBe(false);
  });
  it('summarises completeness across records', () => {
    const s = summarizeCompleteness([rec, { ...rec, credential_number: null }, { ...rec, credential_number: ' ' }], ['applicator_license', 'product_name']);
    expect(s).toMatchObject({ total: 3, complete: 1, incomplete: 2 });
    expect(s.topMissing[0]).toEqual({ field: 'applicator_license', count: 2 });
  });
  it('validates a tenant profile', () => {
    expect(validateRegionProfile({ regionCode: 'US-TX', requiredFields: ['product_name'], retentionYears: 3 })).toEqual([]);
    expect(validateRegionProfile({ regionCode: 'Texas', requiredFields: ['product_name'], retentionYears: 3 })[0]).toContain('Region code');
    expect(validateRegionProfile({ regionCode: 'GB', requiredFields: [], retentionYears: 3 })).toContain('Choose at least one required field');
    expect(validateRegionProfile({ regionCode: 'GB', requiredFields: ['x'], retentionYears: 3 })).toContain('Unknown field: x');
    expect(validateRegionProfile({ regionCode: 'GB', requiredFields: ['product_name', 'product_name'], retentionYears: 3 })).toContain('Duplicate fields in the list');
    expect(validateRegionProfile({ regionCode: 'GB', requiredFields: ['product_name'], retentionYears: 40 })).toContain('Retention must be 1-15 years');
  });
});

describe('customer reports and notices', () => {
  const input = {
    businessName: 'Acme Pest', timeZone: 'America/New_York', customerName: 'Sam <b>Jones</b>', technicianName: 'Pat Lee',
    performedAtUtc: '2027-05-01T14:00:00Z', visitType: 'Recurring', activityLevel: 2, findings: 'Ants at the back door',
    recommendations: 'Trim shrubs', products: [{ name: 'Bug-B-Gone', registrationNumber: '1234-56', amount: 2, unit: 'fl_oz', targetPests: ['Ants'], area: 'Exterior', reentryUntilUtc: '2027-05-01T16:00:00Z' }],
    nextVisitDate: '2027-08-01', guaranteeUntil: '2027-05-31',
  };
  it('uses first names only and no street address', () => {
    const r = buildTreatmentReport({ ...input, customerName: 'Sam Jones' });
    expect(r.text).toContain('Hi Sam,');
    expect(r.text).toContain('Technician: Pat');
    expect(r.text).not.toContain('Lee');
    expect(r.text).not.toContain('Jones');
  });
  it('shows the licence only when the business opts in', () => {
    expect(buildTreatmentReport(input).text).not.toContain('A-123');
    expect(buildTreatmentReport({ ...input, applicatorLicense: 'A-123' }).text).toContain('Applicator licence: A-123');
  });
  it('states product, registration, quantity, targets, re-entry and guarantee', () => {
    const t = buildTreatmentReport(input).text;
    expect(t).toContain('Bug-B-Gone (Reg. 1234-56): 2 fl_oz for Ants — Exterior');
    expect(t).toContain('keep people and pets out of treated areas until');
    expect(t).toContain('Re-service guarantee runs through 2027-05-31');
    expect(t).toContain('Pest activity: Low');
  });
  it('escapes HTML in every interpolated value', () => {
    const r = buildTreatmentReport({ ...input, customerName: '<script>x</script> Bob', findings: '<img src=x onerror=1>' });
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('<img');
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
  it('handles a visit with no products', () => {
    expect(buildTreatmentReport({ ...input, products: [] }).text).toContain('No products were applied on this visit.');
  });
  it('pre-visit notice includes prep tips for the target pests', () => {
    const n = buildPreVisitNotice({ businessName: 'Acme Pest', customerName: 'Sam Jones', technicianName: 'Pat Lee', visitStartUtc: '2027-06-10T13:00:00Z', timeZone: 'America/New_York', targetPests: ['Ants', 'Mosquitoes'], channel: 'email', contact: '555-0100' });
    expect(n.text).toContain('Pat from Acme Pest');
    expect(n.text).toContain('Empty standing water');
    expect(n.text).toContain('555-0100');
  });
  it('noticeSendAt respects local quiet hours and DST', () => {
    const visit = '2027-06-10T13:00:00Z'; // 09:00 EDT
    expect(noticeSendAt(visit, 24, 'America/New_York')).toBe('2027-06-09T13:00:00.000Z');
    expect(noticeSendAt(visit, 10, 'America/New_York')).toBe('2027-06-09T23:00:00.000Z'); // 23:00 → 19:00 local
    expect(noticeSendAt(visit, 4, 'America/New_York')).toBe('2027-06-09T23:00:00.000Z'); // 05:00 → previous 19:00
    expect(noticeSendAt('2027-03-14T13:00:00Z', 12, 'America/New_York')).toBe('2027-03-14T00:00:00.000Z'); // 20:00 EST → 19:00 EST
  });
  it('builds a stable idempotency key', () => {
    expect(noticeIdempotencyKey('pre_visit', 'job1', 'sms')).toBe('notice:pre_visit:job1:sms');
  });
});

describe('notifier adapter', () => {
  const msg = { idempotencyKey: 'k1', channel: 'email' as const, to: 'a@b.co', subject: 's', body: 'b' };
  it('mock is idempotent per key', async () => {
    const n = new MockNotifier();
    const a = await n.send(msg);
    const b = await n.send(msg);
    expect(a).toEqual(b);
    expect(n.sent).toHaveLength(1);
  });
  it('mock can simulate failures', async () => {
    const n = new MockNotifier();
    n.failWith = { retryable: true, error: 'timeout' };
    expect(await n.send(msg)).toEqual({ ok: false, retryable: true, error: 'timeout' });
    expect(n.sent).toHaveLength(0);
  });
  it('back-off grows', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMinutes)).toEqual([5, 15, 45, 135, 405]);
  });
});

describe('renewals and cancellations', () => {
  it('assessRenewal walks through the states', () => {
    const i = { status: 'active' as const, termEnd: '2027-12-31', noticeDays: 30 };
    expect(assessRenewal({ ...i, today: '2027-10-01' }).state).toBe('not_due');
    expect(assessRenewal({ ...i, today: '2027-12-01' }).state).toBe('due');
    expect(assessRenewal({ ...i, today: '2027-12-31' }).state).toBe('overdue');
    expect(assessRenewal({ ...i, today: '2028-01-01' }).state).toBe('expired');
    expect(assessRenewal({ ...i, status: 'cancelled', today: '2027-12-01' }).state).toBe('closed');
    expect(assessRenewal({ ...i, today: '2027-10-01' }).dueFrom).toBe('2027-12-01');
  });
  it('year-round renewals keep the original anchor (no month-end drift)', () => {
    expect(nextTerm({ start: '2027-01-31', end: '2028-01-30' }, 'quarterly', null)).toEqual({ start: '2028-01-31', end: '2029-01-30' });
    const t1 = nextTerm({ start: '2027-01-31', end: '2027-02-27' }, 'monthly', null, '2027-01-31');
    expect(t1).toEqual({ start: '2027-02-28', end: '2027-03-30' });
    const t2 = nextTerm(t1, 'monthly', null, '2027-01-31');
    expect(t2).toEqual({ start: '2027-03-31', end: '2027-04-29' });
  });
  it('leap-day terms', () => {
    expect(termMonths({ start: '2027-03-01', end: '2028-02-29' })).toBe(12);
    expect(nextTerm({ start: '2027-03-01', end: '2028-02-29' }, 'annual', null)).toEqual({ start: '2028-03-01', end: '2029-02-28' });
  });
  it('seasonal renewals move to next year’s window', () => {
    expect(nextTerm({ start: '2027-04-01', end: '2027-10-31' }, 'seasonal', { fromMonth: 4, toMonth: 10 })).toEqual({ start: '2028-04-01', end: '2028-10-31' });
  });
  it('cancellation effective dates', () => {
    const c = { requestedOn: '2027-06-10', termEnd: '2027-12-31', noticeDays: 30 };
    expect(cancellationEffectiveOn({ ...c, policy: 'immediate' })).toBe('2027-06-10');
    expect(cancellationEffectiveOn({ ...c, policy: 'notice' })).toBe('2027-07-10');
    expect(cancellationEffectiveOn({ ...c, policy: 'term_end' })).toBe('2027-12-31');
    expect(cancellationEffectiveOn({ ...c, requestedOn: '2027-12-20', policy: 'notice' })).toBe('2027-12-31');
    expect(cancellationEffectiveOn({ ...c, requestedOn: '2028-01-05', policy: 'term_end' })).toBe('2028-01-05');
  });
});
