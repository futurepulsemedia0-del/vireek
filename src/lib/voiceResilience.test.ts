import { describe, expect, it } from 'vitest';
import {
  buildSavePayload, draftFromSettings, effectiveLevelFor, errorKeyFor, forcedLevelActive, hasDialCode, levelTone, maskPhone, normalizePhone,
  parseNumberList, pollDelayMs, pollExpired, validateForcedLevel, validateSettings, wizardView, type CheckKind, type CheckStatus, type OrgSettings,
} from './voiceResilience';

const org = (o: Partial<OrgSettings> = {}): OrgSettings => ({
  user_id: 'u', forced_level: null, forced_until: null, reduced_assistant_id: null, static_message: null, language: 'en',
  forward_numbers: ['+15551234567'], front_door_enabled: false, alert_sms: true, ...o,
});

describe('phone parsing', () => {
  it('accepts valid NANP formats', () => {
    expect(normalizePhone('(415) 555-2671')).toBe('+14155552671');
    expect(normalizePhone('1 415 555 2671')).toBe('+14155552671');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('+0123456789')).toBeNull();
  });
  it('dedupes and reports invalid entries', () => {
    const r = parseNumberList('+14155552671, 415-555-2671\nabc;+442079460958');
    expect(r.numbers).toEqual(['+14155552671', '+442079460958']);
    expect(r.invalid).toEqual(['abc']);
  });
  it('masks numbers', () => {
    expect(maskPhone('+14155552671')).toBe('+141 ••• 2671');
    expect(maskPhone('garbage')).toBe('••••');
  });
});

describe('settings form', () => {
  it('validates', () => {
    const d = draftFromSettings(org());
    expect(validateSettings(d)).toEqual({});
    expect(validateSettings({ ...d, forwardNumbersText: 'nope' }).forwardNumbers?.key).toBe('forwardInvalid');
    const six = Array.from({ length: 6 }, (_, i) => `+1415555260${i}`).join('\n');
    expect(validateSettings({ ...d, forwardNumbersText: six }).forwardNumbers?.key).toBe('forwardTooMany');
    expect(validateSettings({ ...d, staticMessage: 'x'.repeat(501) }).staticMessage?.key).toBe('staticTooLong');
    expect(validateSettings({ ...d, reducedAssistantId: 'bad id!' }).reducedAssistantId?.key).toBe('assistantInvalid');
    expect(validateSettings({ ...d, reducedAssistantId: 'asst_12345678' })).toEqual({});
  });
  it('sends only changed fields', () => {
    const o = org();
    expect(buildSavePayload(draftFromSettings(o), o)).toBeNull();
    const d = { ...draftFromSettings(o), staticMessage: ' hi ', alertSms: false };
    expect(buildSavePayload(d, o)).toEqual({ static_message: 'hi', alert_sms: false });
    expect(buildSavePayload({ ...draftFromSettings(o), forwardNumbersText: '+15551234567\n' }, o)).toBeNull();
    expect(buildSavePayload({ ...draftFromSettings(o), staticMessage: '' }, org({ static_message: 'x' }))).toEqual({ static_message: null });
  });
  it('first save from no org record', () => {
    expect(buildSavePayload({ ...draftFromSettings(null), frontDoorEnabled: true }, null)).toEqual({ front_door_enabled: true });
  });
});

describe('override', () => {
  it('validates level and minutes', () => {
    expect(validateForcedLevel(3, 60)).toBe(true);
    expect(validateForcedLevel(5, 60)).toBe(false);
    expect(validateForcedLevel(2, 0)).toBe(false);
    expect(validateForcedLevel(2, 1441)).toBe(false);
    expect(validateForcedLevel(2, 1.5)).toBe(false);
  });
  it('expires and picks the effective level', () => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    const live = org({ forced_level: 3, forced_until: '2026-11-05T11:00:00Z' });
    const old = org({ forced_level: 3, forced_until: '2026-11-05T09:00:00Z' });
    expect(forcedLevelActive(live, now)).toBe(true);
    expect(forcedLevelActive(old, now)).toBe(false);
    expect(forcedLevelActive(null, now)).toBe(false);
    expect(effectiveLevelFor({ org: live, platform_level: 0 }, now)).toEqual({ level: 3, pinned: true });
    expect(effectiveLevelFor({ org: old, platform_level: 1 }, now)).toEqual({ level: 1, pinned: false });
    expect(effectiveLevelFor({ org: org({ forced_level: 0, forced_until: '2026-11-05T11:00:00Z' }), platform_level: 2 }, now).level).toBe(0);
  });
  it('tones', () => {
    expect([0, 1, 2, 3, 4].map((l) => levelTone(l as 0))).toEqual(['ok', 'warn', 'warn', 'critical', 'critical']);
  });
});

describe('wizard + polling', () => {
  const statuses: CheckStatus[] = ['pending', 'passed', 'failed', 'answered_by_human', 'expired', 'error'];
  it('every status maps to a view; only pending is non-terminal; retry only on non-ok terminal', () => {
    for (const k of ['forward_on', 'forward_off'] as CheckKind[]) {
      for (const s of statuses) {
        const v = wizardView(s, k);
        expect(v.titleKey.startsWith('wizard.result.')).toBe(true);
        expect(v.terminal).toBe(s !== 'pending');
        expect(v.canRetry).toBe(!['pending', 'passed'].includes(s));
      }
    }
    expect(wizardView('passed', 'forward_on').tone).toBe('ok');
    expect(wizardView('failed', 'forward_off').bodyKey).toBe('wizard.result.failedOff.body');
  });
  it('poll cadence', () => {
    expect(pollDelayMs(0)).toBe(3000);
    expect(pollDelayMs(30_000)).toBe(5000);
    expect(pollExpired(119_999)).toBe(false);
    expect(pollExpired(120_000)).toBe(true);
  });
  it('dial-code presence and error mapping', () => {
    const c = { kind: 'no_answer', activate: '', cancel: '', status: null, confidence: 'ask_carrier', note: '' } as const;
    expect(hasDialCode({ ...c })).toBe(false);
    expect(hasDialCode({ ...c, activate: '**61*+1555**20#' })).toBe(true);
    expect(errorKeyFor('Too many checks', 429)).toBe('errors.tooMany');
    expect(errorKeyFor('x', 403)).toBe('errors.forbidden');
    expect(errorKeyFor('not configured', 503)).toBe('errors.notConfigured');
    expect(errorKeyFor('boom <script>')).toBe('errors.generic');
  });
});
