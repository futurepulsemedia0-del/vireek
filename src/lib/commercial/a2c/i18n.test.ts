import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '../../../locales/en/commercialA2c.json';
import fa from '../../../locales/fa/commercialA2c.json';
import { GATE_CODES, REJECTION_CODES, STAGES, PACKET_SECTIONS, ATTACHMENT_TYPES, GATE_MODES, SUBMISSION_CHANNELS, SOURCES } from './types';

type Json = { [k: string]: string | Json };
const flat = (o: Json, p = ''): Record<string, string> =>
  Object.entries(o).reduce<Record<string, string>>((a, [k, v]) => (typeof v === 'string' ? { ...a, [p + k]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
const E = flat(en as Json);
const F = flat(fa as Json);
const ph = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((x) => x.replace(/\s/g, '')).sort();

describe('commercialA2c locale files', () => {
  it('fa has exactly the keys of en, no empties, identical placeholders', () => {
    expect(Object.keys(F).sort()).toEqual(Object.keys(E).sort());
    for (const [k, v] of Object.entries(F)) {
      expect(v.trim(), k).not.toBe('');
      expect(ph(v), k).toEqual(ph(E[k]));
    }
  });
  it('every domain enum value has a label in both languages', () => {
    const need: string[] = [
      ...GATE_CODES.map((c) => `gate.codes.${c}`), ...REJECTION_CODES.map((c) => `rejection.code.${c}`),
      ...STAGES.map((s) => `stage.${s}`), ...PACKET_SECTIONS.map((s) => `packet.sections.${s}`),
      ...ATTACHMENT_TYPES.map((a) => `rules.attachment.${a}`), ...GATE_MODES.map((m) => `gate.mode.${m}`),
      ...SUBMISSION_CHANNELS.map((c) => `rules.channel.${c}`), ...SOURCES.map((s) => `timeline.source.${s}`),
    ];
    for (const k of need) { expect(E[k], `en ${k}`).toBeTruthy(); expect(F[k], `fa ${k}`).toBeTruthy(); }
  });
  it('Persian strings contain Persian letters (not copied English)', () => {
    const latinOnly = Object.entries(F).filter(([, v]) => !/[\u0600-\u06FF]/.test(v) && !/^[A-Za-z0-9 {}.\-_/()]+$/.test(v));
    expect(latinOnly).toEqual([]);
  });
  it('the rejection codes in the SQL CHECK equal REJECTION_CODES', () => {
    const sql = readFileSync('supabase/migrations/20290312000000_commercial_a2c_v2.sql', 'utf8');
    const m = sql.match(/rejection_code text CHECK \(rejection_code IS NULL OR rejection_code IN\s*\(([^)]*)\)\)/);
    const list = (m?.[1] ?? '').match(/'(\w+)'/g)?.map((x) => x.replace(/'/g, '')) ?? [];
    expect([...list].sort()).toEqual([...REJECTION_CODES].sort());
  });
});
