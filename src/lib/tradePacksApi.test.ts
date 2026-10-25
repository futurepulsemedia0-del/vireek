import { describe, it, expect, vi } from 'vitest';

// Pure helpers only — keep the real Supabase client and auth context out of the test.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/customFieldsApi', () => ({ useAccountOwnerId: () => undefined }));

import { friendlyTradePackError, ledgerToCsv, productPayload, ratesFor, type PackInstall, type ProductInput, type TradeLogEntry } from './tradePacksApi';

describe('friendlyTradePackError', () => {
  it('keeps the message after the code for rule violations', () => {
    expect(friendlyTradePackError(new Error('trade_cert_required: Sam has no valid applicator licence on file for this work'))).toBe('Sam has no valid applicator licence on file for this work');
    expect(friendlyTradePackError({ message: 'trade_label_rate: applied rate 3 per 1,000 sq ft exceeds the label maximum of 2' })).toContain('exceeds the label maximum');
  });
  it('maps known codes and falls back for unknown ones', () => {
    expect(friendlyTradePackError(new Error('trade_pack_not_enabled: turn this pack on first'))).toBe('Turn this pack on first.');
    expect(friendlyTradePackError(new Error('duplicate key value violates unique constraint "uq_trade_routes_name"'))).toBe('A route with that name already exists.');
    expect(friendlyTradePackError(new Error('boom'), 'Nope')).toBe('Nope');
    expect(friendlyTradePackError(null, 'Nope')).toBe('Nope');
  });
});

describe('productPayload', () => {
  const base: ProductInput = {
    name: '  Talstar P  ', kind: 'insecticide', unit: 'fl_oz', epa_reg_number: ' 279-3206 ', epa_exempt_25b: false, active_ingredient: '',
    restricted_use: false, signal_word: '', label_max_rate: '0.5', reentry_hours: '', sds_url: '', notes: '',
  };
  it('trims, nulls blanks and parses numbers', () => {
    expect(productPayload(base)).toMatchObject({ name: 'Talstar P', epa_reg_number: '279-3206', active_ingredient: null, signal_word: null, label_max_rate: 0.5, reentry_hours: null, sds_url: null });
  });
  it('ignores non-numeric rates instead of sending NaN', () => {
    expect(productPayload({ ...base, label_max_rate: 'abc' }).label_max_rate).toBeNull();
  });
});

describe('ledgerToCsv', () => {
  it('escapes commas, quotes and newlines and flags voided rows', () => {
    const e = {
      performed_at: '2027-03-01T10:00:00Z', entry_type: 'treatment', site_address: '1 Main St, Apt "2"', technician_name: 'Sam', credential_type: null, credential_number: null,
      product_name: null, product_epa_reg: null, product_restricted: null, equipment_label: null, data: { a: 1 }, notes: 'line1\nline2', retain_until: '2030-03-01',
      voided_at: '2027-03-02T00:00:00Z', void_reason: 'typo',
    } as unknown as TradeLogEntry;
    const csv = ledgerToCsv([e]);
    const [head, row] = [csv.split('\n')[0], csv.slice(csv.indexOf('\n') + 1)];
    expect(head.startsWith('performed_at,entry_type')).toBe(true);
    expect(row).toContain('"1 Main St, Apt ""2"""');
    expect(row).toContain('"line1\nline2"');
    expect(row).toContain(',yes,typo');
  });
});

describe('ratesFor', () => {
  it('reads per-model overrides from the install config', () => {
    const install = { config: { rates: { general_pest: { initial: 150 } } } } as unknown as PackInstall;
    expect(ratesFor(install, 'general_pest')).toEqual({ initial: 150 });
    expect(ratesFor(install, 'other')).toBeUndefined();
    expect(ratesFor(undefined, 'x')).toBeUndefined();
  });
});
