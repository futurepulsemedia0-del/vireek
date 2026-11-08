import { describe, expect, it } from 'vitest';
import { CANONICAL_STATUSES, STATUS_COLORS, TEAM_ROLES } from '@/lib/statusEngine';

type Json = { [k: string]: string | Json };
const files = import.meta.glob('../locales/*/statusEngine.json', { eager: true, import: 'default' }) as Record<string, Json>;

function flatten(obj: Json, prefix = ''): Record<string, string> {
  return Object.entries(obj).reduce<Record<string, string>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') acc[key] = v;
    else Object.assign(acc, flatten(v, key));
    return acc;
  }, {});
}
const placeholders = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((p) => p.replace(/\s/g, '')).sort();

const en = flatten(files['../locales/en/statusEngine.json'] as Json);

describe('statusEngine namespace', () => {
  it('English labels every canonical status, color and role', () => {
    for (const s of CANONICAL_STATUSES) expect(en[`canonical.${s}`], s).toBeTruthy();
    for (const c of STATUS_COLORS) expect(en[`colors.${c}`], c).toBeTruthy();
    for (const r of TEAM_ROLES) expect(en[`roles.${r}`], r).toBeTruthy();
  });

  it('ships all nine languages', () => {
    const codes = Object.keys(files).map((p) => p.split('/')[2]).sort();
    expect(codes).toEqual(['ar', 'de', 'en', 'es', 'fa', 'fr', 'hi', 'ja', 'zh']);
  });

  for (const [path, json] of Object.entries(files).filter(([p]) => !p.includes('/en/'))) {
    const code = path.split('/')[2];
    it(`${code} has exactly English's keys, no empty values and the same {{placeholders}}`, () => {
      const other = flatten(json);
      expect(Object.keys(other).filter((k) => !(k in en))).toEqual([]);
      expect(Object.keys(en).filter((k) => !(k in other))).toEqual([]);
      for (const [key, value] of Object.entries(other)) {
        expect(value.trim(), `${code}:${key}`).not.toBe('');
        expect(placeholders(value), `${code}:${key}`).toEqual(placeholders(en[key] as string));
      }
    });
  }
});
