import { describe, it, expect } from 'vitest';
import { convert, formatPrice, CURRENCIES } from './currency';

describe('convert', () => {
  it('is a no-op for USD', () => {
    expect(convert(199, 'USD')).toBe(199);
  });

  it('applies the stored FX rate', () => {
    expect(convert(100, 'EUR')).toBeCloseTo(100 * CURRENCIES.EUR.rate);
  });
});

describe('formatPrice', () => {
  it('rounds to a whole number (no FX-ticker decimals)', () => {
    expect(formatPrice(199, 'EUR')).not.toMatch(/\.\d/);
  });

  it('uses the right currency symbol/code', () => {
    expect(formatPrice(100, 'GBP')).toContain('£');
  });
});
