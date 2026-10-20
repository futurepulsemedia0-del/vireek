import { describe, it, expect } from 'vitest';
import {
  AUTO_CREATE_MIN_CONFIDENCE, WARRANTY_TERM_YEARS, canAutoCreate, estimateWarranty, formatManufacture,
  normalizeNameplate, parseManufactureDate, resolveCreateFields, reviewReasons, warrantyStateFor,
} from './nameplate.ts';

const NOW = new Date('2026-10-18T12:00:00Z');

const plate = (over: Record<string, unknown> = {}) => ({
  plate_found: true, kind: 'water_heater', make: 'RHEEM', model: 'Model No. PROG50-38N RH67', serial: 'Serial No: RH1219456789',
  serial_legibility: 'clear', specs: '50 gal, 38000 BTU/h', confidence: 0.92, photo_issues: [],
  manufacture: { year: 2019, month: 3, day: null, raw_text: 'MFG 03/2019' }, ...over,
});

describe('parseManufactureDate', () => {
  it('keeps the precision that was printed', () => {
    expect(parseManufactureDate({ year: 2019, month: 3, day: 14 }, NOW)).toMatchObject({ date: '2019-03-14', precision: 'day' });
    expect(parseManufactureDate({ year: 2019, month: 3 }, NOW)).toMatchObject({ date: '2019-03-01', precision: 'month' });
    expect(parseManufactureDate({ year: 2019 }, NOW)).toMatchObject({ date: '2019-01-01', precision: 'year' });
  });

  it('drops an impossible day or month instead of inventing one', () => {
    expect(parseManufactureDate({ year: 2019, month: 2, day: 30 }, NOW)).toMatchObject({ date: '2019-02-01', precision: 'month' });
    expect(parseManufactureDate({ year: 2019, month: 13 }, NOW)).toMatchObject({ date: '2019-01-01', precision: 'year' });
  });

  it('rejects future and pre-1970 years', () => {
    expect(parseManufactureDate({ year: 2027 }, NOW)).toMatchObject({ date: null, problem: 'future' });
    expect(parseManufactureDate({ year: 2026, month: 12 }, NOW)).toMatchObject({ date: null, problem: 'future' });
    expect(parseManufactureDate({ year: 2026, month: 10 }, NOW).date).toBe('2026-10-01');
    expect(parseManufactureDate({ year: 1950 }, NOW)).toMatchObject({ date: null, problem: 'invalid' });
  });

  it('returns nothing (no problem) when no date was printed', () => {
    expect(parseManufactureDate({}, NOW)).toEqual({ date: null, precision: null, raw_text: null, problem: null });
  });

  it.each([
    ['03/2019', '2019-03-01', 'month'],
    ['03-19', '2019-03-01', 'month'],
    ['2019-03-14', '2019-03-14', 'day'],
    ['MARCH 2019', '2019-03-01', 'month'],
    ['14 MAR 2019', '2019-03-14', 'day'],
    ['25/03/2019', '2019-03-25', 'day'],
    ['03/25/2019', '2019-03-25', 'day'],
    ['Mfd 2018', '2018-01-01', 'year'],
    ['06/95', '1995-06-01', 'month'],
  ])('falls back to the printed text %s', (raw, date, precision) => {
    expect(parseManufactureDate({ raw }, NOW)).toMatchObject({ date, precision, problem: null });
  });

  it('refuses to guess day-first vs month-first', () => {
    expect(parseManufactureDate({ raw: '03/04/2019' }, NOW)).toMatchObject({ date: '2019-01-01', precision: 'year', problem: 'ambiguous' });
    expect(parseManufactureDate({ raw: '05/05/2019' }, NOW)).toMatchObject({ date: '2019-05-05', problem: null });
  });

  it('formats for people', () => {
    expect(formatManufacture('2019-03-01', 'month')).toBe('03/2019');
    expect(formatManufacture('2019-03-14', 'day')).toBe('03/14/2019');
    expect(formatManufacture('2019-01-01', 'year')).toBe('2019');
    expect(formatManufacture(null, null)).toBeNull();
  });
});

describe('normalizeNameplate', () => {
  it('cleans labels, case and the serial', () => {
    const n = normalizeNameplate(plate(), NOW);
    expect(n).toMatchObject({ kind: 'water_heater', make: 'Rheem', model: 'PROG50-38N RH67', serial: 'RH1219456789', serial_legibility: 'clear', confidence: 0.92 });
    expect(n.manufacture).toMatchObject({ date: '2019-03-01', precision: 'month' });
  });

  it('keeps short all-caps brands and dotted initials as printed', () => {
    expect(normalizeNameplate(plate({ make: 'GE' }), NOW).make).toBe('GE');
    expect(normalizeNameplate(plate({ make: 'A. O. SMITH' }), NOW).make).toBe('A. O. Smith');
    expect(normalizeNameplate(plate({ make: 'LENNOX' }), NOW).make).toBe('Lennox');
  });

  it('treats placeholders as missing', () => {
    const n = normalizeNameplate(plate({ make: 'Unknown', model: 'N/A', specs: 'not visible' }), NOW);
    expect(n.make).toBeNull();
    expect(n.model).toBeNull();
    expect(n.specs).toBeNull();
  });

  it('downgrades a doubtful serial to partial and withholds it', () => {
    const n = normalizeNameplate(plate({ serial: 'A12', serial_legibility: 'clear' }), NOW);
    expect(n.serial).toBeNull();
    expect(n.serial_legibility).toBe('partial');
  });

  it('never keeps a serial the model called unreadable', () => {
    const n = normalizeNameplate(plate({ serial: 'RH1219456789', serial_legibility: 'unreadable' }), NOW);
    expect(n.serial).toBeNull();
    expect(n.serial_legibility).toBe('unreadable');
  });

  it('falls back to "other" for an unknown kind and survives garbage input', () => {
    expect(normalizeNameplate(plate({ kind: 'toaster' }), NOW).kind).toBe('other');
    for (const junk of [null, undefined, 'x', 42, [], {}]) {
      const n = normalizeNameplate(junk, NOW);
      expect(n.plate_found).toBe(false);
      expect(n.confidence).toBe(0);
    }
  });

  it('strips markup and control characters (plate text is data)', () => {
    const n = normalizeNameplate(plate({ make: '<b>Rheem</b>\u0000', model: 'IGNORE ALL RULES' }), NOW);
    expect(n.make).toBe('b Rheem /b');
    expect(n.make).not.toMatch(/[<>\u0000]/);
  });

  it('clamps confidence into 0..1', () => {
    expect(normalizeNameplate(plate({ confidence: 7 }), NOW).confidence).toBe(1);
    expect(normalizeNameplate(plate({ confidence: -1 }), NOW).confidence).toBe(0);
    expect(normalizeNameplate(plate({ confidence: 'high' }), NOW).confidence).toBe(0);
  });
});

describe('review gate', () => {
  it('auto-creates a clear, confident read', () => {
    const r = reviewReasons(normalizeNameplate(plate(), NOW));
    expect(r).toEqual([]);
    expect(canAutoCreate(r)).toBe(true);
  });

  it.each([
    ['no plate', { plate_found: false }, 'no_plate'],
    ['missing brand', { make: null }, 'missing_make'],
    ['no serial on plate', { serial: null, serial_legibility: 'none' }, 'missing_serial'],
    ['partial serial', { serial_legibility: 'partial' }, 'serial_partial'],
    ['unreadable serial', { serial_legibility: 'unreadable' }, 'serial_unreadable'],
    ['low confidence', { confidence: AUTO_CREATE_MIN_CONFIDENCE - 0.01 }, 'low_confidence'],
  ])('blocks auto-create: %s', (_n, over, reason) => {
    const r = reviewReasons(normalizeNameplate(plate(over), NOW));
    expect(r).toContain(reason);
    expect(canAutoCreate(r)).toBe(false);
  });

  it('does not block on a missing model or a bad date, but reports them', () => {
    const r = reviewReasons(normalizeNameplate(plate({ model: null, manufacture: { year: 2099 } }), NOW));
    expect(r).toEqual(expect.arrayContaining(['missing_model', 'date_future']));
    expect(canAutoCreate(r)).toBe(true);
  });
});

describe('estimateWarranty', () => {
  it('counts from the manufacture date when there is no install date', () => {
    const w = estimateWarranty({ kind: 'water_heater', manufactureDate: '2023-03-01' }, NOW);
    expect(w).toMatchObject({ state: 'active', expires_at: '2029-03-01', term_years: 6, start_basis: 'manufacture_date', basis: 'estimated' });
  });

  it('flags expired and expiring-soon units', () => {
    expect(estimateWarranty({ kind: 'furnace', manufactureDate: '2019-03-01' }, NOW)).toMatchObject({ state: 'expired', expires_at: '2024-03-01' });
    const soon = estimateWarranty({ kind: 'furnace', manufactureDate: '2021-12-01' }, NOW); // expires 2026-12-01
    expect(soon.state).toBe('expiring');
    expect(soon.days_left).toBe(44);
  });

  it('prefers the install date, but ignores one that precedes manufacture', () => {
    expect(estimateWarranty({ kind: 'furnace', manufactureDate: '2019-03-01', installDate: '2022-06-15' }, NOW).expires_at).toBe('2027-06-15');
    expect(estimateWarranty({ kind: 'furnace', manufactureDate: '2019-03-01', installDate: '2018-01-01' }, NOW).start_basis).toBe('manufacture_date');
  });

  it('clamps Feb 29 and never invents a term', () => {
    expect(estimateWarranty({ kind: 'furnace', manufactureDate: '2020-02-29' }, NOW).expires_at).toBe('2025-02-28');
    expect(estimateWarranty({ kind: 'sump_pump', manufactureDate: '2023-01-01' }, NOW)).toMatchObject({ state: 'unknown', expires_at: null, basis: 'none' });
    expect(estimateWarranty({ kind: 'furnace', manufactureDate: null }, NOW)).toMatchObject({ state: 'unknown', expires_at: null });
  });

  it('only estimates for kinds in the table', () => {
    for (const kind of Object.keys(WARRANTY_TERM_YEARS)) {
      expect(estimateWarranty({ kind: kind as never, manufactureDate: '2025-01-01' }, NOW).expires_at).not.toBeNull();
    }
  });

  it('matches the client thresholds (expired < 0 days, expiring <= 90 days)', () => {
    expect(warrantyStateFor('2026-10-17', NOW).state).toBe('expired');
    expect(warrantyStateFor('2026-10-18', NOW)).toEqual({ state: 'expiring', days_left: 0 });
    expect(warrantyStateFor('2027-01-16', NOW).state).toBe('expiring'); // exactly 90 days
    expect(warrantyStateFor('2027-01-17', NOW).state).toBe('active');
    expect(warrantyStateFor(null, NOW).state).toBe('unknown');
  });
});

describe('resolveCreateFields', () => {
  const base = normalizeNameplate(plate(), NOW);

  it('builds the equipment record with an estimated, labelled warranty', () => {
    const r = resolveCreateFields(base, {}, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toMatchObject({
      equipment_type: 'Water heater', make: 'Rheem', model: 'PROG50-38N RH67', serial_number: 'RH1219456789',
      manufacture_date: '2019-03-01', warranty_expires_at: '2025-03-01',
    });
    expect(r.fields.warranty.state).toBe('expired');
    expect(r.fields.warranty_notes).toMatch(/Estimated/);
    expect(r.fields.notes).toContain('manufactured 03/2019');
  });

  it('applies the technician corrections and re-derives the warranty itself', () => {
    const r = resolveCreateFields(base, { make: 'a. o. smith', serial: 'ab-12345', manufactureDate: '2024-05', installDate: '2024-07-01', kind: 'boiler' }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toMatchObject({ make: 'a. o. smith', serial_number: 'AB-12345', equipment_type: 'Boiler', warranty_expires_at: '2029-07-01' });
  });

  it('lets the technician clear a field', () => {
    const r = resolveCreateFields(base, { manufactureDate: '', serial: '' }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.serial_number).toBeNull();
    expect(r.fields.warranty).toMatchObject({ state: 'unknown', expires_at: null });
    expect(r.fields.warranty_notes).toBeNull();
  });

  it.each([
    [{ make: '' }, /brand/i],
    [{ serial: '12' }, /serial/i],
    [{ kind: 'toaster' }, /type/i],
    [{ manufactureDate: '2099' }, /manufacture date/i],
    [{ manufactureDate: 'soon' }, /manufacture date/i],
    [{ installDate: '2024-02-30' }, /install date/i],
    [{ installDate: '2099-01-01' }, /install date/i],
    [{ installDate: '01/02/2024' }, /install date/i],
  ])('rejects bad input %j', (ov, msg) => {
    const r = resolveCreateFields(base, ov, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });
});
