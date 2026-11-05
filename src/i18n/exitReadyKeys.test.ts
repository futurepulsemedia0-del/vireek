import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/locales/exitReady/en.json';

const root = path.resolve(__dirname, '..');
const files = [
  'components/exit-readiness/EvidencePanel.tsx',
  'components/exit-readiness/MultiplesPanel.tsx',
  'components/exit-readiness/StagedRoomPanel.tsx',
  'components/exit-readiness/ExitReadyTabs.tsx',
  'components/exit-readiness/PublicStagedRoom.tsx',
];

function resolveKey(obj: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe('exitReady locale keys', () => {
  it('every static t(...) key used by the Exit-Ready components exists in en.json', () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(path.join(root, f), 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
        if (typeof resolveKey(en, m[1]) !== 'string') missing.push(`${f}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
  it('every dynamic key family used in templates has all its members', () => {
    const fam = { 'multiples.origin_': ['manual', 'table', 'builtin'], 'sharing.actor_': ['owner', 'recipient', 'system'], 'evidence.': ['gap', 'ok', 'unknown'] };
    for (const [prefix, members] of Object.entries(fam)) for (const m of members) expect(typeof resolveKey(en, `${prefix}${m}`)).toBe('string');
  });
  it('has no empty strings and keeps interpolation placeholders balanced', () => {
    const walk = (o: unknown, trail: string[] = []): string[] =>
      typeof o === 'string' ? (o.trim() === '' || (o.match(/{{/g) ?? []).length !== (o.match(/}}/g) ?? []).length ? [trail.join('.')] : [])
        : o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => walk(v, [...trail, k])) : [];
    expect(walk(en)).toEqual([]);
  });
  it('locale folder only contains json files', () => {
    expect(readdirSync(path.join(root, 'locales/exitReady')).every((f) => f.endsWith('.json'))).toBe(true);
  });
});
