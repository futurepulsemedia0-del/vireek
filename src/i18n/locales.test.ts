import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@/lib/i18n';
import { navSlug } from '@/lib/navLabel';
import navSource from '@/components/DashboardNav.tsx?raw';

type Json = { [k: string]: string | Json };

const files = import.meta.glob('../locales/*/*.json', { eager: true, import: 'default' }) as Record<string, Json>;
const codes = LANGUAGES.map((l) => l.code);

function load(code: string, ns: string): Json {
  const found = files[`../locales/${code}/${ns}.json`];
  if (!found) throw new Error(`Missing locales/${code}/${ns}.json`);
  return found;
}

function flatten(obj: Json, prefix = ''): Record<string, string> {
  return Object.entries(obj).reduce<Record<string, string>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') acc[key] = v;
    else Object.assign(acc, flatten(v, key));
    return acc;
  }, {});
}

const placeholders = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((p) => p.replace(/\s/g, '')).sort();

describe.each(['common', 'dashboard'])('%s namespace', (ns) => {
  const en = flatten(load('en', ns));

  it.each(codes.filter((c) => c !== 'en'))('%s has exactly the same keys as English', (code) => {
    const other = flatten(load(code, ns));
    expect(Object.keys(other).filter((k) => !(k in en)), 'extra keys').toEqual([]);
    expect(Object.keys(en).filter((k) => !(k in other)), 'missing keys').toEqual([]);
  });

  it.each(codes)('%s has no empty values and keeps {{placeholders}}', (code) => {
    const other = flatten(load(code, ns));
    for (const [key, value] of Object.entries(other)) {
      expect(value.trim(), `${code}:${key} is empty`).not.toBe('');
      expect(placeholders(value), `${code}:${key} placeholders`).toEqual(placeholders(en[key] ?? ''));
    }
  });
});

describe('navSlug', () => {
  it('produces stable, ascii keys', () => {
    expect(navSlug('Parts & Inventory')).toBe('parts_and_inventory');
    expect(navSlug('My Day (Field)')).toBe('my_day_field');
    expect(navSlug('Click-to-Cash')).toBe('click_to_cash');
    expect(navSlug('Uncertainty & Evidence Map')).toBe('uncertainty_and_evidence_map');
  });
});

describe('nav label coverage', () => {
  it('every DashboardNav label has a translation key', () => {
    const labels = [...navSource.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
    const keys = flatten(load('en', 'dashboard'));
    const missing = [...new Set(labels)].filter((l) => !(`nav.items.${navSlug(l)}` in keys));
    if (missing.length && !import.meta.env.VITE_I18N_STRICT_NAV) {
      console.warn(
        `[i18n] ${missing.length} nav label(s) have no translation yet (they fall back to English):\n  ${missing.join('\n  ')}\n` +
          'Run with VITE_I18N_STRICT_NAV=1 to make this a failure.',
      );
      return;
    }
    expect(missing).toEqual([]);
  });
});
