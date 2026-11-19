import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAIN,
  EMERGENCY_SERVICES_NOTICE,
  buildEscalationSms,
  duressDelay,
  evaluateSession,
  nextCheckinAfter,
  parseSmsReply,
  validateChain,
  type SessionAction,
  type SessionState,
  type TimerSettings,
} from './core';

const MIN = 60_000;
const T0 = new Date('2030-06-01T12:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * MIN);

const cfg: TimerSettings = { checkinGraceMin: 5, overrunPromptMin: 30, unreachableMin: 15, chain: DEFAULT_CHAIN };

/** A session that started at T0, with its first check-in due at +30 min and a 120 min expected end. */
function session(over: Partial<SessionState> = {}): SessionState {
  return {
    status: 'active',
    isDrill: false,
    startedAt: T0,
    expectedEndAt: at(120),
    nextCheckinDueAt: at(30),
    lastSeenAt: at(29),
    escalationAnchorAt: null,
    doneKeys: new Set<string>(),
    ...over,
  };
}
const kinds = (a: SessionAction[]) => a.map((x) => x.kind);
const steps = (a: SessionAction[]) => a.flatMap((x) => (x.kind === 'escalate' ? [x.step] : []));

describe('check-in timer', () => {
  it('does nothing before the check-in is due', () => {
    expect(evaluateSession(session(), cfg, at(29))).toEqual([]);
  });

  it('asks for a check-in exactly when it is due, and not yet escalating', () => {
    const a = evaluateSession(session(), cfg, at(30));
    expect(kinds(a)).toEqual(['prompt_checkin']);
  });

  it('is still only prompting one millisecond before the grace period ends', () => {
    const a = evaluateSession(session(), cfg, new Date(at(35).getTime() - 1));
    expect(kinds(a)).toEqual(['prompt_checkin']);
  });

  it('declares the check-in missed at due + grace and escalates to the dispatcher first', () => {
    const a = evaluateSession(session(), cfg, at(35));
    expect(kinds(a)).toContain('missed_checkin');
    expect(steps(a)).toEqual(['dispatcher']);
    const missed = a.find((x) => x.kind === 'missed_checkin');
    expect(missed && missed.kind === 'missed_checkin' && missed.anchor.getTime()).toBe(at(35).getTime());
  });

  it('does not notify the emergency contact before its delay has elapsed', () => {
    expect(steps(evaluateSession(session(), cfg, at(39)))).toEqual(['dispatcher']);
    expect(steps(evaluateSession(session(), cfg, at(40)))).toEqual(['dispatcher', 'emergency_contact']);
    expect(steps(evaluateSession(session(), cfg, at(45)))).toEqual(['dispatcher', 'emergency_contact', 'company_next']);
  });

  it('counts escalation delays from the missed time, not from the original due time', () => {
    // Due at +30, grace 5 => anchor +35. emergency_contact (delay 5) must fire at +40, never at +35.
    expect(steps(evaluateSession(session(), cfg, at(35)))).not.toContain('emergency_contact');
  });

  it('is idempotent: actions already recorded are never returned again', () => {
    const first = evaluateSession(session(), cfg, at(41));
    const done = new Set(first.map((x) => x.key));
    expect(evaluateSession(session({ doneKeys: done }), cfg, at(41))).toEqual([]);
  });

  it('only returns the newly due step when earlier ones are already recorded', () => {
    const first = evaluateSession(session(), cfg, at(36));
    const done = new Set(first.map((x) => x.key));
    const later = evaluateSession(session({ doneKeys: done }), cfg, at(41));
    expect(steps(later)).toEqual(['emergency_contact']);
  });

  it('returns nothing for an ended session, however late it is', () => {
    expect(evaluateSession(session({ status: 'ended' }), cfg, at(999))).toEqual([]);
  });

  it('prompts when the job runs past its expected end', () => {
    const s = session({ nextCheckinDueAt: at(500), lastSeenAt: at(149) });
    expect(kinds(evaluateSession(s, cfg, at(149)))).toEqual([]);
    expect(kinds(evaluateSession(s, cfg, at(150)))).toEqual(['overrun_prompt']);
  });

  it('prompts when the phone has not been heard from for the unreachable window', () => {
    const s = session({ nextCheckinDueAt: at(500), lastSeenAt: at(10) });
    expect(kinds(evaluateSession(s, cfg, at(24)))).toEqual([]);
    expect(kinds(evaluateSession(s, cfg, at(25)))).toEqual(['unreachable_prompt']);
  });

  it('survives a check-in that arrives late but inside the grace window (new due time clears the prompt)', () => {
    // Technician checks in at +33: the next due time moves on, and nothing is due at +36.
    const next = nextCheckinAfter(at(33), 30, at(120));
    const s = session({ nextCheckinDueAt: next, lastSeenAt: at(33) });
    expect(evaluateSession(s, cfg, at(36))).toEqual([]);
  });
});

describe('escalation chain', () => {
  it('marks drill steps beyond the dispatcher as simulated so no real contact is woken', () => {
    const a = evaluateSession(session({ isDrill: true }), cfg, at(46));
    const esc = a.filter((x): x is Extract<SessionAction, { kind: 'escalate' }> => x.kind === 'escalate');
    expect(esc.map((e) => [e.step, e.simulated])).toEqual([
      ['dispatcher', false],
      ['emergency_contact', true],
      ['company_next', true],
    ]);
  });

  it('real sessions are never simulated', () => {
    const a = evaluateSession(session(), cfg, at(46));
    expect(a.every((x) => x.kind !== 'escalate' || x.simulated === false)).toBe(true);
  });

  it('duress escalates the dispatcher immediately and compresses later steps to 2 minutes apart', () => {
    const slow = { ...cfg, chain: [{ step: 'dispatcher', delay_min: 0 }, { step: 'emergency_contact', delay_min: 20 }, { step: 'company_next', delay_min: 40 }] as const };
    const s = session({ status: 'duress', escalationAnchorAt: at(10), nextCheckinDueAt: at(500) });
    expect(steps(evaluateSession(s, { ...slow, chain: [...slow.chain] }, at(10)))).toEqual(['dispatcher']);
    expect(steps(evaluateSession(s, { ...slow, chain: [...slow.chain] }, at(12)))).toEqual(['dispatcher', 'emergency_contact']);
    expect(steps(evaluateSession(s, { ...slow, chain: [...slow.chain] }, at(14)))).toEqual(['dispatcher', 'emergency_contact', 'company_next']);
  });

  it('duressDelay never exceeds the configured delay', () => {
    expect(duressDelay(0, 3)).toBe(0);
    expect(duressDelay(1, 5)).toBe(1);
    expect(duressDelay(60, 0)).toBe(0);
    expect(duressDelay(60, 2)).toBe(4);
  });

  it('keeps escalating an already-escalating session on later ticks (restart-safe)', () => {
    const s = session({ status: 'escalating', escalationAnchorAt: at(35), nextCheckinDueAt: at(30) });
    expect(steps(evaluateSession(s, cfg, at(40)))).toEqual(['dispatcher', 'emergency_contact']);
  });

  it('uses distinct dedupe keys per anchor so a later missed check-in can escalate again', () => {
    const a = evaluateSession(session({ escalationAnchorAt: at(35), status: 'escalating' }), cfg, at(36));
    const b = evaluateSession(session({ escalationAnchorAt: at(95), status: 'escalating' }), cfg, at(96));
    expect(a[0]?.key).not.toBe(b[0]?.key);
  });

  it('validates the chain: ordered, bounded, known steps only', () => {
    expect(validateChain(DEFAULT_CHAIN)).toBe(true);
    expect(validateChain([])).toBe(false);
    expect(validateChain([{ step: 'dispatcher', delay_min: 10 }, { step: 'emergency_contact', delay_min: 5 }])).toBe(false);
    expect(validateChain([{ step: 'police', delay_min: 0 }])).toBe(false);
    expect(validateChain([{ step: 'dispatcher', delay_min: 121 }])).toBe(false);
    expect(validateChain([{ step: 'dispatcher', delay_min: 1.5 }])).toBe(false);
  });
});

describe('next check-in', () => {
  it('schedules one interval after the check-in', () => {
    expect(nextCheckinAfter(at(40), 30, at(300)).getTime()).toBe(at(70).getTime());
  });
  it('never schedules past one interval after the expected end', () => {
    // 125 + 30 = 155 would be past expected end (110) + one interval (30) = 140, so it is capped at 140.
    expect(nextCheckinAfter(at(125), 30, at(110)).getTime()).toBe(at(140).getTime());
  });
});

describe('SMS fallback and message wording', () => {
  it('accepts OK only together with the one-time code', () => {
    expect(parseSmsReply('OK 123456', '123456')).toEqual({ kind: 'ok' });
    expect(parseSmsReply('OK', '123456')).toEqual({ kind: 'unknown' });
    expect(parseSmsReply('ok 999999', '123456')).toEqual({ kind: 'unknown' });
    expect(parseSmsReply('ok 123456', null)).toEqual({ kind: 'unknown' });
  });
  it('always treats HELP as help, with or without a code', () => {
    expect(parseSmsReply('HELP', '123456')).toEqual({ kind: 'help' });
    expect(parseSmsReply('help!!! 000000', '123456')).toEqual({ kind: 'help' });
  });
  it('reads a duress phrase only when the code is present', () => {
    const isDuress = (n: string) => n.includes('pizza night');
    expect(parseSmsReply('ok 123456 pizza night', '123456', isDuress)).toEqual({ kind: 'duress' });
    expect(parseSmsReply('ok pizza night', '123456', isDuress)).toEqual({ kind: 'unknown' });
  });
  it('escalation texts never claim to reach emergency services and carry the notice', () => {
    for (const step of ['dispatcher', 'emergency_contact', 'company_next'] as const) {
      const sms = buildEscalationSms({ step, techName: 'Alex', drill: false, reason: 'missed_checkin', jobRef: 'J-1', companyName: 'Acme' });
      expect(sms).toContain(EMERGENCY_SERVICES_NOTICE.slice(0, 40));
      expect(sms.length).toBeLessThanOrEqual(480);
    }
  });
  it('tags drills so nobody mistakes a practice for a real alert', () => {
    expect(buildEscalationSms({ step: 'dispatcher', techName: 'Alex', drill: true, reason: 'duress', jobRef: 'J-1' })).toMatch(/^\[DRILL\]/);
  });
});
