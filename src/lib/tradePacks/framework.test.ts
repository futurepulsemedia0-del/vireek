import { describe, it, expect } from 'vitest';
import {
  validateLogData, cleanLogData, checkLabelRate, reentryUntil, EPA_REG_RE, credentialCurrent, hasRequiredCredential,
  retentionUntil, tierPrice, quote, applyRateOverrides, visitsPerYear, jobMatchesPack, applySeason, weekdayOf,
  haversineKm, planRouteDay, groupAgreementsForRoutes, getLogType, PEST_CONTROL_PACK, POOL_SERVICE_PACK, TRADE_PACKS, getPack, packForIndustry,
  PEST_RESTRICTED_CREDENTIAL,
} from './index';

const chem = getLogType(PEST_CONTROL_PACK, 'chemical_application')!;
const stock = getLogType(PEST_CONTROL_PACK, 'regulated_product')!;
const reading = getLogType(POOL_SERVICE_PACK, 'chemistry_reading')!;

describe('validateLogData', () => {
  const ok = { amount: 2, amount_unit: 'fl_oz', method: 'Spray', application_site: 'Exterior', target_pests: ['Ants'], ppe_used: true };
  it('accepts a complete entry', () => expect(validateLogData(chem, ok)).toEqual([]));
  it('requires mandatory fields', () => {
    const e = validateLogData(chem, { amount: 2 });
    expect(e.some((m) => m.includes('Unit is required'))).toBe(true);
    expect(e.some((m) => m.includes('Target pests is required'))).toBe(true);
  });
  it('rejects unknown keys, bad types, bad choices and out-of-range numbers', () => {
    expect(validateLogData(chem, { ...ok, hack: 1 })).toContain('Unknown field "hack"');
    expect(validateLogData(chem, { ...ok, amount: 'x' })[0]).toContain('must be a number');
    expect(validateLogData(chem, { ...ok, method: 'Laser' })[0]).toContain('invalid choice');
    expect(validateLogData(chem, { ...ok, wind_mph: 400 })[0]).toContain('at most');
    expect(validateLogData(chem, { ...ok, target_pests: ['Dragons'] })[0]).toContain('invalid choice');
  });
  it('needs at least one chemistry reading', () => {
    expect(validateLogData(reading, {})).toContain('Enter at least one reading');
    expect(validateLogData(reading, { ph: 7.4 })).toEqual([]);
  });
  it('only a Count may be zero for regulated stock', () => {
    const base = { action: 'Received', unit: 'lb', quantity: 0 };
    expect(validateLogData(stock, base)).toContain('Quantity must be greater than 0');
    expect(validateLogData(stock, { ...base, action: 'Count' })).toEqual([]);
  });
  it('cleanLogData drops blanks and trims', () => {
    expect(cleanLogData({ a: ' x ', b: '', c: null, d: [], e: 0, f: false })).toEqual({ a: 'x', e: 0, f: false });
  });
});

describe('label rate + re-entry', () => {
  const p = { unit: 'fl_oz' as const, label_max_rate: 2 };
  it('passes within the label rate', () => expect(checkLabelRate(p, 3, 'fl_oz', 2000)).toMatchObject({ ok: true, rate: 1.5 }));
  it('fails above the label rate', () => expect(checkLabelRate(p, 6, 'fl_oz', 2000).ok).toBe(false));
  it('needs area and matching unit', () => {
    expect(checkLabelRate(p, 1, 'fl_oz', undefined).ok).toBe(false);
    expect(checkLabelRate(p, 1, 'oz', 1000).ok).toBe(false);
  });
  it('no limit = always ok', () => expect(checkLabelRate({ unit: 'oz', label_max_rate: null }, 99, 'oz', 1).ok).toBe(true));
  it('re-entry time', () => {
    expect(reentryUntil('2027-03-01T10:00:00.000Z', 4)).toBe('2027-03-01T14:00:00.000Z');
    expect(reentryUntil('2027-03-01T10:00:00.000Z', 0)).toBeNull();
  });
  it('EPA registration format', () => {
    expect(EPA_REG_RE.test('432-1217')).toBe(true);
    expect(EPA_REG_RE.test('432-1217-ZA')).toBe(false);
    expect(EPA_REG_RE.test('abc')).toBe(false);
  });
});

describe('credentials + retention', () => {
  const d = new Date('2027-06-01T00:00:00Z');
  it('expired / revoked credentials do not count', () => {
    expect(credentialCurrent({ credential_type: 'x', status: 'active', expires_at: '2027-05-31' }, d)).toBe(false);
    expect(credentialCurrent({ credential_type: 'x', status: 'revoked', expires_at: null }, d)).toBe(false);
    expect(credentialCurrent({ credential_type: 'x', status: 'active', expires_at: null }, d)).toBe(true);
  });
  it('restricted products demand the restricted credential', () => {
    const creds = [{ credential_type: 'pesticide_applicator', status: 'active', expires_at: null }];
    expect(hasRequiredCredential(chem, false, creds, d)).toBe(true);
    expect(hasRequiredCredential(chem, true, creds, d)).toBe(false);
    expect(hasRequiredCredential(chem, true, [{ credential_type: PEST_RESTRICTED_CREDENTIAL, status: 'active', expires_at: null }], d)).toBe(true);
  });
  it('pool logs need no credential', () => expect(hasRequiredCredential(reading, false, [], d)).toBe(true));
  it('retention', () => expect(retentionUntil('2027-03-15T12:00:00Z', 3)).toBe('2030-03-15'));
});

describe('pricing', () => {
  const m = PEST_CONTROL_PACK.pricingModels[0];
  it('tiers', () => {
    expect(tierPrice([{ upTo: 100, price: 1 }, { upTo: null, price: 2 }], 100)).toBe(1);
    expect(tierPrice([{ upTo: 100, price: 1 }, { upTo: null, price: 2 }], 101)).toBe(2);
  });
  it('general pest quote', () => {
    const q = quote(m, { home_sqft: 2000 }, visitsPerYear('month', 3));
    expect(q.oneTime).toBe(159);
    expect(q.perVisit).toBe(99);
    expect(q.annualRecurring).toBe(396);
    expect(q.monthlyRecurring).toBe(33);
    expect(q.firstYearTotal).toBe(555);
  });
  it('per-unit minimum charge', () => {
    const t = PEST_CONTROL_PACK.pricingModels[1];
    expect(quote(t, { linear_feet: 20 }, 1).oneTime).toBe(650);
    expect(quote(t, { linear_feet: 200 }, 1).oneTime).toBe(2200);
  });
  it('cost-plus', () => {
    const q = quote(POOL_SERVICE_PACK.pricingModels[0], { gallons: 15000, chem_cost: 20 }, 52);
    expect(q.perVisit).toBe(85 + 27);
  });
  it('overrides', () => {
    const o = applyRateOverrides(POOL_SERVICE_PACK.pricingModels[0], { chemicals: 50, service: [{ upTo: null, price: 100 }] });
    expect(quote(o, { gallons: 1, chem_cost: 10 }, 1).perVisit).toBe(115);
    expect(applyRateOverrides(m, { initial: -5 })).toEqual(m);
  });
  it('visits per year', () => {
    expect(visitsPerYear('week', 2)).toBe(26);
    expect(visitsPerYear('month', 3)).toBe(4);
    expect(visitsPerYear('year', 1)).toBe(1);
  });
});

describe('pack matching + seasons', () => {
  it('matches service types', () => {
    expect(jobMatchesPack(PEST_CONTROL_PACK, 'Termite inspection')).toBe(true);
    expect(jobMatchesPack(POOL_SERVICE_PACK, 'Weekly Pool Service')).toBe(true);
    expect(jobMatchesPack(POOL_SERVICE_PACK, 'AC repair')).toBe(false);
    expect(jobMatchesPack(POOL_SERVICE_PACK, null)).toBe(false);
  });
  it('season clamps start and sets end', () => {
    const s = { fromMonth: 4, toMonth: 10 };
    expect(applySeason('2027-06-10', s)).toEqual({ start: '2027-06-10', end: '2027-10-31' });
    expect(applySeason('2027-11-05', s)).toEqual({ start: '2028-04-01', end: '2028-10-31' });
    expect(applySeason('2027-02-05', s)).toEqual({ start: '2027-04-01', end: '2027-10-31' });
    expect(applySeason('2027-02-05', undefined)).toEqual({ start: '2027-02-05', end: null });
  });
});

describe('routes', () => {
  it('weekday', () => {
    expect(weekdayOf('2027-01-04')).toBe(1); // Monday
    expect(weekdayOf('2027-01-10')).toBe(0); // Sunday
  });
  it('haversine', () => expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111.19, 1));
  const stops = [
    { id: 'far', lat: 0, lng: 0.3, minutes: 30 },
    { id: 'near', lat: 0, lng: 0.01, minutes: 30 },
    { id: 'mid', lat: 0, lng: 0.1, minutes: 30 },
    { id: 'nogeo', lat: null, lng: null, minutes: 30 },
  ];
  it('orders nearest-first and keeps ungeocoded stops last', () => {
    const p = planRouteDay(stops, { start: { lat: 0, lng: 0 }, workdayMinutes: 480, speedKmh: 40 });
    expect(p.stops.map((s) => s.id)).toEqual(['near', 'mid', 'far', 'nogeo']);
    expect(p.overflow).toHaveLength(0);
    expect(p.stops[1].startOffsetMinutes).toBeGreaterThan(p.stops[0].startOffsetMinutes + 30);
  });
  it('moves stops that do not fit the workday to overflow', () => {
    const p = planRouteDay(stops, { start: { lat: 0, lng: 0 }, workdayMinutes: 70, speedKmh: 40 });
    expect(p.stops.length).toBe(2);
    expect(p.overflow.length).toBe(2);
  });
  it('groups only active weekly plans of the pack by technician + weekday', () => {
    const base = { interval_count: 1, preferred_technician_id: 't1', status: 'active' };
    const g = groupAgreementsForRoutes(POOL_SERVICE_PACK, [
      { ...base, id: 'a', service_type: 'Pool service', interval_unit: 'week' as const, start_date: '2027-01-04' },
      { ...base, id: 'b', service_type: 'Pool service', interval_unit: 'week' as const, start_date: '2027-01-11' },
      { ...base, id: 'c', service_type: 'Pool service', interval_unit: 'week' as const, start_date: '2027-01-05' },
      { ...base, id: 'd', service_type: 'Pool service', interval_unit: 'month' as const, start_date: '2027-01-04' },
      { ...base, id: 'e', service_type: 'HVAC tune-up', interval_unit: 'week' as const, start_date: '2027-01-04' },
      { ...base, id: 'f', service_type: 'Pool service', interval_unit: 'week' as const, start_date: '2027-01-04', status: 'paused' },
    ]);
    expect(g).toEqual([
      { technicianId: 't1', weekday: 1, agreementIds: ['a', 'b'] },
      { technicianId: 't1', weekday: 2, agreementIds: ['c'] },
    ]);
  });
});

describe('registry', () => {
  it('has unique pack keys, log keys and field keys', () => {
    expect(new Set(TRADE_PACKS.map((p) => p.key)).size).toBe(TRADE_PACKS.length);
    for (const p of TRADE_PACKS) {
      expect(new Set(p.logTypes.map((t) => t.key)).size).toBe(p.logTypes.length);
      for (const t of p.logTypes) {
        expect(new Set(t.fields.map((f) => f.key)).size).toBe(t.fields.length);
        for (const f of t.fields) if (f.type === 'select' || f.type === 'multiselect') expect(f.options!.length).toBeGreaterThan(0);
      }
    }
  });
  it('seeded custom fields fit the DB rules (key pattern, label length, select options)', () => {
    for (const p of TRADE_PACKS)
      for (const f of p.customFields) {
        expect(/^[a-z][a-z0-9_]{0,39}$/.test(f.key)).toBe(true);
        expect(f.label.length).toBeLessThanOrEqual(60);
        if (f.field_type === 'select') expect(f.options!.length).toBeGreaterThan(0);
      }
  });
  it('seeded forms fit the form-builder validator (unique ids, valid types, ≤100 fields)', () => {
    const types = ['text', 'textarea', 'number', 'checkbox', 'select', 'yes_no', 'pass_fail', 'photo', 'signature'];
    for (const p of TRADE_PACKS)
      for (const f of p.forms) {
        expect(/^[a-z0-9_]{2,60}$/.test(f.slug)).toBe(true);
        expect(new Set(f.fields.map((x) => x.id)).size).toBe(f.fields.length);
        for (const x of f.fields) {
          expect(/^[a-z0-9_]{1,40}$/.test(x.id)).toBe(true);
          expect(types).toContain(x.type);
          if (x.type === 'select') expect(x.options!.length).toBeGreaterThan(0);
        }
      }
  });
  it('seeded keys / slugs carry the pack prefix the install RPC enforces', () => {
    for (const p of TRADE_PACKS) {
      const prefix = p.key.split('_')[0] + '_';
      for (const f of p.customFields) expect(f.key.startsWith(prefix)).toBe(true);
      for (const f of p.forms) expect(f.slug.startsWith(prefix)).toBe(true);
      expect(p.customFields.length).toBeLessThanOrEqual(30);
    }
  });
  it('lookups', () => {
    expect(getPack('pool_service')?.name).toBe('Pool Service');
    expect(packForIndustry('pest-control')?.key).toBe('pest_control');
    expect(packForIndustry('hvac')).toBeUndefined();
  });
});
