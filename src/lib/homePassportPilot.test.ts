import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));

import {
  findForbiddenKeys,
  formatRange,
  formatWindow,
  isRenderableRange,
  mapPilotError,
  shareStateLabel,
  shareUrl,
} from './homePassportPilot';

describe('findForbiddenKeys (redaction defence in depth)', () => {
  it('finds nested forbidden keys but ignores values', () => {
    expect(findForbiddenKeys({ a: { price: 1, list: [{ customer_email: 'x' }] } })).toEqual(['customer_email', 'price']);
    expect(findForbiddenKeys({ title: 'price list', detail: 'email me' })).toEqual([]);
  });
  it('accepts a clean passport-shaped payload', () => {
    expect(findForbiddenKeys({
      property: { city: 'Austin' },
      equipment: [{ label: 'Furnace', warranty_notes: 'x', verification: 'contractor_recorded' }],
      owner_added_items: [{ name: 'Dishwasher', verification: 'owner_added' }],
    })).toEqual([]);
  });
  it('is safe on primitives and null', () => {
    expect(findForbiddenKeys(null)).toEqual([]);
    expect(findForbiddenKeys('price')).toEqual([]);
  });
});

describe('isRenderableRange', () => {
  const ok = {
    annual_range: { low: 400, high: 1000 },
    five_year_range: { low: 2100, high: 5200 },
    confidence: 'medium',
    assumptions: ['Typical service lives'],
    disclaimer: 'Estimates only.',
  };
  it('requires width, assumptions and a disclaimer', () => {
    expect(isRenderableRange(ok)).toBe(true);
    expect(isRenderableRange(null)).toBe(false);
    expect(isRenderableRange({ ...ok, assumptions: [] })).toBe(false);
    expect(isRenderableRange({ ...ok, disclaimer: '' })).toBe(false);
    expect(isRenderableRange({ ...ok, annual_range: { low: 500, high: 500 } })).toBe(false);
  });
});

describe('mapPilotError', () => {
  it('maps known codes', () => {
    expect(mapPilotError({ message: 'HPP_DISABLED' })).toMatch(/not enabled/);
    expect(mapPilotError({ message: 'HPP_CONSENT_REQUIRED' })).toMatch(/consent/i);
    expect(mapPilotError({ message: 'HPP_EXPIRED' })).toMatch(/expired/);
  });
  it('includes short server detail for conflicts', () => {
    expect(mapPilotError({ message: 'HPP_CONFLICT: a transfer is already pending for this property' })).toMatch(/already pending/);
  });
  it('never leaks unknown errors', () => {
    expect(mapPilotError({ message: 'relation "x" does not exist at secret_table' })).toBe('Something went wrong. Please try again.');
    expect(mapPilotError(undefined)).toBe('Something went wrong. Please try again.');
  });
});

describe('formatting', () => {
  it('builds share urls without double slashes', () => {
    expect(shareUrl('https://app.example.com/', 'abc')).toBe('https://app.example.com/passport/share/abc');
  });
  it('formats ranges and windows', () => {
    expect(formatRange(400, 1000)).toBe('$400 – $1,000');
    expect(formatWindow('2027-01-05', '2027-03-20')).toBe('Jan 2027 – Mar 2027');
    expect(formatWindow('2027-01-05', '2027-01-30')).toBe('Jan 2027');
    expect(formatWindow(null, '2027-01-30')).toBeNull();
  });
  it('labels share states', () => {
    expect(shareStateLabel('exhausted')).toBe('View limit reached');
  });
});
