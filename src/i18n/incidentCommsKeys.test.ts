import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/locales/en/incidentComms.json';
import { PHASES, SEVERITIES, AUDIENCES } from '@/lib/incidentComms';

const get = (path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);

describe('incidentComms i18n keys', () => {
  it('every static t("...") key used by the page exists', () => {
    const src = readFileSync('src/pages/StaffIncidentCommsPage.tsx', 'utf8');
    const missing = [...src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]).filter((k) => typeof get(k) !== 'string');
    expect(missing).toEqual([]);
  });
  it('labels every phase, severity, audience, state and impact', () => {
    for (const p of PHASES) expect(typeof get(`phase.${p}`), p).toBe('string');
    for (const s of SEVERITIES) expect(typeof get(`severity.${s}`), s).toBe('string');
    for (const a of AUDIENCES) expect(typeof get(`audience.${a}`), a).toBe('string');
    for (const s of ['draft', 'pending_approval', 'approved', 'rejected', 'sending', 'sent', 'send_failed']) expect(typeof get(`state.${s}`), s).toBe('string');
    for (const i of ['minor', 'major']) expect(typeof get(`impact.${i}`), i).toBe('string');
    for (const s of ['investigating', 'monitoring', 'resolved']) expect(typeof get(`status.${s}`), s).toBe('string');
  });
  it('has an error string for every error code the page maps', () => {
    for (const k of ['forbidden', 'conflict', 'lint_blocked', 'draft_stale', 'generic']) expect(typeof get(`errors.${k}`), k).toBe('string');
  });
});
