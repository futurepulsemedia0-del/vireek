import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { PORTAL_ROWS, PORTAL_TARGETS, portalI18n, portalLocale, pt } from '@/lib/portalI18n';

const ph = (s: string) =>
  (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((p) => p.replace(/\s/g, '')).sort();

describe('portal catalog', () => {
  it('has all 8 translations for every English key, with identical placeholders', () => {
    for (const row of PORTAL_ROWS) {
      expect(row, row[0]).toHaveLength(1 + PORTAL_TARGETS.length);
      row.forEach((cell, i) => {
        expect(cell.trim(), `${row[0]} #${i}`).not.toBe('');
        expect(ph(cell), `${row[0]} #${i}`).toEqual(ph(row[0]));
      });
    }
  });

  it('has no duplicate English keys', () => {
    const keys = PORTAL_ROWS.map((r) => r[0]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('pt()', () => {
  it('translates, interpolates, and falls back to the English source text', async () => {
    await portalI18n.changeLanguage('es');
    expect(pt('Reschedule')).toBe('Reprogramar');
    expect(pt('Hi {{name}},', { name: 'Ana' })).toBe('Hola Ana,');
    expect(pt('Text that is not in the catalog')).toBe('Text that is not in the catalog');
    await portalI18n.changeLanguage('fa');
    expect(pt('Paid')).toBe('پرداخت‌شده');
    await portalI18n.changeLanguage('en');
    expect(pt('Reschedule')).toBe('Reschedule');
    expect(pt('Covered until {{date}}', { date: 'Jan 1' })).toBe('Covered until Jan 1');
  });

  it('keeps names containing special characters intact (no HTML escaping)', async () => {
    await portalI18n.changeLanguage('de');
    expect(pt('Hi {{name}},', { name: "O'Brien & Sons" })).toBe("Hallo O'Brien & Sons,");
    await portalI18n.changeLanguage('en');
  });

  it('exposes a Gregorian/Latin-digit locale per language', async () => {
    await portalI18n.changeLanguage('fa');
    expect(portalLocale()).toBe('fa-IR-u-ca-gregory-nu-latn');
    await portalI18n.changeLanguage('en');
    expect(portalLocale()).toBe('en-US-u-ca-gregory-nu-latn');
  });
});
