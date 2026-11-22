import { describe, expect, it } from 'vitest';
import en from './en/voiceResilience.json';
import { MANUAL_DRILL_KINDS } from '@/lib/voiceDrills';

type Tree = { [k: string]: string | Tree };
const get = (k: string): unknown => k.split('.').reduce<unknown>((o, p) => (o as Tree | undefined)?.[p], en as Tree);

describe('drills i18n keys', () => {
  it('every key DrillEvidencePanel / the page can request exists in English (es/fa parity is covered by voiceResilience.locales.test.ts)', () => {
    const keys = ['page.tabs.drills', 'drills.runNow', 'drills.proofNote', 'settings.counter'];
    for (const s of ['never', 'ok', 'due_soon', 'overdue', 'disabled']) keys.push(`drills.state.${s}.title`, `drills.state.${s}.body`);
    for (const k of ['title', 'intro', 'enabled', 'interval', 'intervalHelp', 'save', 'saving', 'saved', 'invalid']) keys.push(`drills.schedule.${k}`);
    for (const k of ['title', 'intro', 'kind', 'outcome', 'note', 'save', 'saving', 'saved', 'errors.kindInvalid', 'errors.noteTooLong']) keys.push(`drills.manual.${k}`);
    for (const k of ['forward_on', 'forward_off', ...MANUAL_DRILL_KINDS]) keys.push(`drills.kind.${k}`);
    for (const k of ['passed', 'failed', 'inconclusive']) keys.push(`drills.outcome.${k}`);
    for (const k of ['system', 'manual']) keys.push(`drills.source.${k}`);
    for (const k of ['title', 'empty', 'when', 'what', 'result', 'source']) keys.push(`drills.log.${k}`);
    for (const k of keys) expect(typeof get(k), k).toBe('string');
  });
});
