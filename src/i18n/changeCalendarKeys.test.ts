import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/locales/en/changeCalendar.json';
import fa from '@/locales/fa/changeCalendar.json';
import { CATEGORIES, AUDIENCES, STATUSES, REMINDER_KINDS } from '@/lib/changeCalendar';

type Json = { [k: string]: string | Json };
const flat = (o: Json, p = ''): Record<string, string> =>
  Object.entries(o).reduce<Record<string, string>>((a, [k, v]) => (typeof v === 'string' ? { ...a, [p + k]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
const E = flat(en as Json);
const F = flat(fa as Json);
const ph = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((x) => x.replace(/\s/g, '')).sort();

describe('changeCalendar locale files', () => {
  it('fa has exactly the keys of en, no empties, same placeholders', () => {
    expect(Object.keys(F).sort()).toEqual(Object.keys(E).sort());
    for (const [k, v] of Object.entries(F)) {
      expect(v.trim(), k).not.toBe('');
      expect(ph(v), k).toEqual(ph(E[k] ?? ''));
    }
  });
  it('every static t() key used by the page exists', () => {
    const src = readFileSync('src/pages/StaffChangeCalendarPage.tsx', 'utf8');
    const used = new Set<string>();
    for (const m of src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1] as string);
    for (const m of src.matchAll(/'((?:toast|page|actions|form)\.[a-zA-Z0-9_.]+)'/g)) used.add(m[1] as string);
    const missing = [...used].filter((k) => !(k in E) && !Object.keys(E).some((e) => e.startsWith(`${k}_`)));
    expect(missing).toEqual([]);
  });
  it('every enum value used by dynamic keys has a label', () => {
    for (const c of CATEGORIES) expect(E[`category.${c}`], c).toBeTruthy();
    for (const a of AUDIENCES) expect(E[`audience.${a}`], a).toBeTruthy();
    for (const s of STATUSES) expect(E[`status.${s}`], s).toBeTruthy();
    for (const r of REMINDER_KINDS) expect(E[`reminder.${r}`], r).toBeTruthy();
    for (const ev of ['created', 'updated', 'reset_to_draft', 'submitted', 'approved', 'rejected', 'notice_sent', 'completed', 'cancelled']) expect(E[`event.${ev}`], ev).toBeTruthy();
  });
});
