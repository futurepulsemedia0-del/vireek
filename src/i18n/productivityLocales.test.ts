import { describe, it, expect } from 'vitest';
import { SHORTCUT_DEFS } from '@/lib/shortcuts/definitions';

type Json = { [k: string]: string | Json };
const files = import.meta.glob('../locales/*/productivity.json', { eager: true, import: 'default' }) as Record<string, Json>;

function flatten(obj: Json, prefix = ''): Record<string, string> {
  return Object.entries(obj).reduce<Record<string, string>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') acc[key] = v;
    else Object.assign(acc, flatten(v, key));
    return acc;
  }, {});
}
const placeholders = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((p) => p.replace(/\s/g, '')).sort();

const en = flatten(files['../locales/en/productivity.json']);

describe('productivity namespace', () => {
  it('English labels every registered shortcut', () => {
    for (const d of SHORTCUT_DEFS) expect(en[`shortcuts.items.${d.id}`], d.id).toBeTruthy();
  });

  for (const [path, json] of Object.entries(files).filter(([p]) => !p.includes('/en/'))) {
    const code = path.split('/')[2];
    it(`${code} has exactly English's keys, no empty values and the same {{placeholders}}`, () => {
      const other = flatten(json);
      expect(Object.keys(other).filter((k) => !(k in en))).toEqual([]);
      expect(Object.keys(en).filter((k) => !(k in other))).toEqual([]);
      for (const [key, value] of Object.entries(other)) {
        expect(value.trim(), `${code}:${key}`).not.toBe('');
        expect(placeholders(value), `${code}:${key}`).toEqual(placeholders(en[key]));
      }
    });
  }
});
