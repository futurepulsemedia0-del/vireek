// @vitest-environment node
// Pure-logic tests for the Home Inventory reader: file sniffing, path guard, money/date maths, normalisation and the
// item-form prefill. No Deno, network or database.
import { describe, expect, it } from 'vitest';
import {
  categoryForKind, currencyExponent, deriveWarrantyEnd, isOwnStoragePath, normalizeHomeDocument, readerFor,
  readFromDocument, readFromLabel, sanitizeFileName, sha256Hex, sniffMime, suggestFromDocument, suggestFromLabel, toMinorUnits,
} from './ocr.ts';
import { normalizeNameplate } from '../property-vision/nameplate.ts';

const NOW = new Date('2026-10-23T12:00:00Z');
const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(Math.max(0, 16 - b.length)).fill(0)]);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

const OWNER = '11111111-1111-4111-8111-111111111111';
const CUST = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';

describe('sniffMime', () => {
  it('recognises the allowed types from their first bytes', () => {
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffMime(bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')))).toBe('image/webp');
    expect(sniffMime(bytes(...ascii('%PDF-1.7')))).toBe('application/pdf');
    expect(sniffMime(bytes(0, 0, 0, 24, ...ascii('ftypheic')))).toBe('image/heic');
  });
  it('rejects scripts, html, executables, truncated and empty input', () => {
    expect(sniffMime(bytes(...ascii('<html><script>alert(1)</script>')))).toBeNull();
    expect(sniffMime(bytes(...ascii('MZ'), 0x90, 0x00))).toBeNull();
    expect(sniffMime(bytes(0, 0, 0, 24, ...ascii('ftypmp42')))).toBeNull(); // a video, not a HEIC photo
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffMime(new Uint8Array())).toBeNull();
  });
});

describe('sanitizeFileName / isOwnStoragePath', () => {
  it('keeps a readable display name and drops paths, markup and control characters', () => {
    expect(sanitizeFileName('C:\\Users\\ana\\Receipt 2024 (1).pdf')).toBe('Receipt 2024 (1).pdf');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('<img src=x onerror=alert(1)>.jpg')).toBe('img srcx onerroralert(1).jpg');
    expect(sanitizeFileName('....')).toBeNull();
    expect(sanitizeFileName(42 as unknown as string)).toBe('42');
    expect(sanitizeFileName(undefined)).toBeNull();
  });
  it('only accepts <owner>/<customer>/<uuid>.<ext> inside the customer’s own folder', () => {
    expect(isOwnStoragePath(`${OWNER}/${CUST}/${FILE}.jpg`, OWNER, CUST)).toBe(true);
    expect(isOwnStoragePath(`${OWNER}/${CUST}/${FILE}.pdf`, OWNER, CUST)).toBe(true);
    // another customer's folder, another tenant, traversal, wrong extension, extra depth, non-string
    expect(isOwnStoragePath(`${OWNER}/${FILE}/${FILE}.jpg`, OWNER, CUST)).toBe(false);
    expect(isOwnStoragePath(`${FILE}/${CUST}/${FILE}.jpg`, OWNER, CUST)).toBe(false);
    expect(isOwnStoragePath(`${OWNER}/${CUST}/../${FILE}.jpg`, OWNER, CUST)).toBe(false);
    expect(isOwnStoragePath(`${OWNER}/${CUST}/${FILE}.exe`, OWNER, CUST)).toBe(false);
    expect(isOwnStoragePath(`${OWNER}/${CUST}/x/${FILE}.jpg`, OWNER, CUST)).toBe(false);
    expect(isOwnStoragePath(null, OWNER, CUST)).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('matches the known digest of "abc"', async () => {
    expect(await sha256Hex(new Uint8Array(ascii('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('deriveWarrantyEnd', () => {
  it('adds months and clamps to the end of a shorter month', () => {
    expect(deriveWarrantyEnd('2024-03-14', 24)).toBe('2026-03-14');
    expect(deriveWarrantyEnd('2024-01-31', 1)).toBe('2024-02-29'); // leap year
    expect(deriveWarrantyEnd('2023-01-31', 1)).toBe('2023-02-28');
    expect(deriveWarrantyEnd('2024-11-30', 3)).toBe('2025-02-28');
    expect(deriveWarrantyEnd('2024-12-15', 1)).toBe('2025-01-15'); // year rollover
    expect(deriveWarrantyEnd('2024-02-29', 12)).toBe('2025-02-28');
  });
  it('returns null for anything it cannot derive safely', () => {
    expect(deriveWarrantyEnd(null, 12)).toBeNull();
    expect(deriveWarrantyEnd('2024-03-14', null)).toBeNull();
    expect(deriveWarrantyEnd('2024-03-14', 0)).toBeNull();
    expect(deriveWarrantyEnd('2024-03-14', 601)).toBeNull();
    expect(deriveWarrantyEnd('2024-03-14', 1.5)).toBeNull();
    expect(deriveWarrantyEnd('14/03/2024', 12)).toBeNull();
    expect(deriveWarrantyEnd('2024-13-01', 12)).toBeNull();
  });
});

describe('money', () => {
  it('uses the real minor-unit exponent of the currency', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('usd')).toBeNull();
    expect(currencyExponent('ZZZZ')).toBeNull();
  });
  it('converts to minor units and rejects junk and absurd amounts', () => {
    expect(toMinorUnits(12.5, 'USD')).toBe(1250);
    expect(toMinorUnits('1,299.99', 'USD')).toBe(129999);
    expect(toMinorUnits(1200, 'JPY')).toBe(1200);
    expect(toMinorUnits(1.5, 'KWD')).toBe(1500);
    expect(toMinorUnits(0.1 + 0.2, 'USD')).toBe(30); // float noise rounds away
    expect(toMinorUnits(0, 'USD')).toBeNull();
    expect(toMinorUnits(-5, 'USD')).toBeNull();
    expect(toMinorUnits('abc', 'USD')).toBeNull();
    expect(toMinorUnits(99_999_999, 'USD')).toBeNull();
    expect(toMinorUnits(10, 'XXXX')).toBeNull();
  });
});

const RECEIPT = {
  doc_found: true, doc_type: 'receipt', product_name: 'Carrier 24ACC636 central air conditioner', category: 'hvac',
  brand: 'Carrier', model: '24ACC636', serial: 'W 1234 5678', retailer: 'Home Depot',
  purchase_date: { year: 2024, month: 3, day: 14, raw_text: '03/14/2024' },
  total_amount: 4999.99, currency: 'usd', warranty_months: 120, confidence: 0.91, issues: [],
};

describe('normalizeHomeDocument', () => {
  it('normalises a clean receipt', () => {
    const d = normalizeHomeDocument(RECEIPT, NOW);
    expect(d).toMatchObject({
      doc_found: true, doc_type: 'receipt', category: 'hvac', brand: 'Carrier', model: '24ACC636', serial: 'W12345678',
      retailer: 'Home Depot', purchase_date: '2024-03-14', purchase_date_problem: null, total_cents: 499999, currency: 'USD',
      warranty_months: 120, confidence: 0.91,
    });
  });
  it('drops placeholders, bad currencies, absurd values and unknown vocabulary instead of trusting them', () => {
    const d = normalizeHomeDocument({
      doc_found: true, doc_type: 'spaceship', product_name: 'N/A', category: 'weapons', brand: 'unknown', model: '???',
      serial: 'SERIAL', retailer: 'none', purchase_date: { year: 3024, month: 1, day: 1 }, total_amount: 5, currency: 'ZZZZ',
      warranty_months: 9999, confidence: 7, issues: ['glare', '', 'x'.repeat(200)],
    }, NOW);
    expect(d).toMatchObject({
      doc_type: 'other', product_name: null, category: 'other', brand: null, model: null, serial: null, retailer: null,
      purchase_date: null, purchase_date_problem: 'future', total_cents: null, currency: null, warranty_months: null, confidence: 1,
    });
    expect(d.issues).toHaveLength(2);
    expect(d.issues[1].length).toBeLessThanOrEqual(80);
  });
  it('never accepts a future or ambiguous purchase date', () => {
    expect(normalizeHomeDocument({ ...RECEIPT, purchase_date: { year: 2027, month: 1, day: 5 } }, NOW).purchase_date).toBeNull();
    const amb = normalizeHomeDocument({ ...RECEIPT, purchase_date: { year: null, month: null, day: null, raw_text: '03/04/2024' } }, NOW);
    expect(amb.purchase_date_problem).toBe('ambiguous');
  });
  it('strips markup and control characters from every text field', () => {
    const d = normalizeHomeDocument({ ...RECEIPT, product_name: '<script>x</script>\u0000Heater', retailer: 'A\nB' }, NOW);
    expect(d.product_name).toBe('script x /script Heater');
    expect(d.retailer).toBe('A B');
  });
  it('survives garbage input', () => {
    for (const bad of [null, undefined, 'text', 42, [], {}]) {
      const d = normalizeHomeDocument(bad, NOW);
      expect(d.doc_found).toBe(false);
      expect(d.category).toBe('other');
      expect(d.total_cents).toBeNull();
    }
  });
});

describe('suggestions', () => {
  it('turns a receipt into a form prefill with a derived warranty end', () => {
    const s = suggestFromDocument(normalizeHomeDocument(RECEIPT, NOW));
    expect(s).toMatchObject({
      name: 'Carrier 24ACC636 central air conditioner', category: 'hvac', brand: 'Carrier', model: '24ACC636',
      purchase_date: '2024-03-14', purchase_price_cents: 499999, currency: 'USD', warranty_months: 120, warranty_expires_at: '2034-03-14',
    });
  });
  it('falls back to "brand model" for the name and leaves warranty empty without a printed term', () => {
    const s = suggestFromDocument(normalizeHomeDocument({ ...RECEIPT, product_name: null, warranty_months: null }, NOW));
    expect(s.name).toBe('Carrier 24ACC636');
    expect(s.warranty_months).toBeNull();
    expect(s.warranty_expires_at).toBeNull();
  });
  it('suggests nothing when no document was found', () => {
    expect(suggestFromDocument(normalizeHomeDocument({ ...RECEIPT, doc_found: false }, NOW)).name).toBeNull();
  });
  it('a label gives identity only: never a purchase date or price, serial only when clearly legible', () => {
    const plate = (legibility: string) => normalizeNameplate({
      plate_found: true, kind: 'water_heater', make: 'RHEEM', model: 'XE40M06', serial: 'RHLN1234567', serial_legibility: legibility,
      specs: '40 gal', manufacture: { year: 2020, month: 5, day: null, raw_text: '05/2020' }, confidence: 0.9, photo_issues: [],
    }, NOW);
    const clear = suggestFromLabel(plate('clear'));
    expect(clear).toMatchObject({ category: 'water_heating', brand: 'Rheem', model: 'XE40M06', serial_number: 'RHLN1234567', purchase_date: null, purchase_price_cents: null });
    expect(clear.name).toBe('Rheem Water heater');
    expect(suggestFromLabel(plate('partial')).serial_number).toBeNull();
    expect(readFromLabel(plate('clear')).manufacture_date).toBe('2020-05-01');
  });
  it('flags low-confidence reads so the UI asks the customer to double-check', () => {
    expect(readFromDocument(normalizeHomeDocument({ ...RECEIPT, confidence: 0.4 }, NOW)).low_confidence).toBe(true);
    expect(readFromDocument(normalizeHomeDocument(RECEIPT, NOW)).low_confidence).toBe(false);
    expect(readFromDocument(normalizeHomeDocument({ ...RECEIPT, doc_found: false }, NOW)).low_confidence).toBe(true);
  });
});

describe('routing helpers', () => {
  it('maps equipment kinds to inventory categories', () => {
    expect(categoryForKind('water_heater')).toBe('water_heating');
    expect(categoryForKind('heat_pump')).toBe('hvac');
    expect(categoryForKind('sump_pump')).toBe('plumbing');
    expect(categoryForKind('generator')).toBe('electrical');
    expect(categoryForKind('other')).toBe('other');
    expect(categoryForKind('banana')).toBe('other');
  });
  it('uses the plate reader for labels and photos, the document reader for the rest', () => {
    expect(readerFor('label')).toBe('label');
    expect(readerFor('appliance_photo')).toBe('label');
    expect(readerFor('receipt')).toBe('document');
    expect(readerFor('warranty_card')).toBe('document');
    expect(readerFor('manual')).toBe('document');
    expect(readerFor('other')).toBe('document');
  });
});
