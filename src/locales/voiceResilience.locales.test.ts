import { describe, expect, it } from 'vitest';
import en from './en/voiceResilience.json';
import es from './es/voiceResilience.json';
import fa from './fa/voiceResilience.json';
import { OUTCOME_KEY, wizardView, type CheckKind, type CheckStatus } from '@/lib/voiceResilience';

type Tree = { [k: string]: string | Tree };
const flat = (o: Tree, p = ''): Record<string, string> =>
  Object.entries(o).reduce<Record<string, string>>((a, [k, v]) => (typeof v === 'string' ? { ...a, [`${p}${k}`]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
const E = flat(en as Tree);
const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');

describe('voiceResilience locales', () => {
  for (const [name, bundle] of [['es', es], ['fa', fa]] as const) {
    const L = flat(bundle as Tree);
    it(`${name}: same keys as en`, () => {
      expect(Object.keys(L).sort()).toEqual(Object.keys(E).sort());
    });
    it(`${name}: no empty values and identical {{placeholders}}`, () => {
      for (const k of Object.keys(E)) {
        expect(L[k]?.trim().length, k).toBeGreaterThan(0);
        expect(placeholders(L[k]), k).toBe(placeholders(E[k]));
      }
    });
  }
  it('every key the code can request exists', () => {
    const keys = new Set<string>(Object.values(OUTCOME_KEY));
    for (const k of ['forward_on', 'forward_off'] as CheckKind[])
      for (const s of ['pending', 'passed', 'failed', 'answered_by_human', 'expired', 'error'] as CheckStatus[]) {
        const v = wizardView(s, k); keys.add(v.titleKey); keys.add(v.bodyKey);
      }
    for (const l of [0, 1, 2, 3, 4]) { keys.add(`status.levels.${l}.name`); keys.add(`status.levels.${l}.desc`); }
    for (const k of ['ok', 'warn', 'critical']) keys.add(`status.tone.${k}`);
    for (const f of ['gsm_standard', 'verizon', 'landline_voip_pbx']) keys.add(`wizard.family.${f}`);
    for (const f of ['no_answer', 'unreachable', 'busy']) keys.add(`wizard.kind.${f}`);
    for (const f of ['standard', 'commonly_documented', 'ask_carrier']) keys.add(`wizard.confidence.${f}`);
    for (const f of ['activate', 'cancel', 'status']) keys.add(`wizard.code.${f}`);
    for (const f of ['forwardInvalid', 'forwardTooMany', 'staticTooLong', 'assistantInvalid']) keys.add(`settings.errors.${f}`);
    for (const f of ['generic', 'tooMany', 'forbidden', 'notConfigured']) keys.add(`errors.${f}`);
    for (const k of keys) expect(E[k], k).toBeTruthy();
  });
});
