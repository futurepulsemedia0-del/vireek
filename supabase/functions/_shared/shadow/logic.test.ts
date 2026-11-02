import { describe, it, expect } from 'vitest';
import {
  CLOSE_RATE_BAND, DEFAULT_CLOSE_RATE, ESTIMATE_LABEL, MAX_CLOSE_RATE, MIN_REVIEWED_FOR_READINESS, PIPELINE_VERSION,
  assertShadowSafe, buildShadowCard, clampRetentionDays, computeEstimate, computeReadiness, detectEmergencyFloor,
  diffAgainstActual, digestDue, evaluateConsent, idempotencyKey, isTrialExpired, normalizeAnalysis, purgeAfter,
  redactPii, trialDay,
  type ConsentConfig, type ShadowAnalysis, type ShadowCallInput, type ShadowPorts, type WouldBeAction,
} from './logic';

const START = '2028-04-01T09:00:00.000Z';
const at = (days: number, hours = 0) => new Date(Date.parse(START) + days * 86_400_000 + hours * 3_600_000).toISOString();

function input(over: Partial<ShadowCallInput> = {}): ShadowCallInput {
  return {
    accountId: 'acct-1', source: 'pbx_call', sourceId: 'call-1', callerPhone: '+15125550123',
    startedAt: START, answeredAt: null, status: 'missed', durationSeconds: 0,
    transcript: 'Hi, my AC stopped working, can someone come tomorrow? Call me at 512-555-0123.', isAfterHours: false, ...over,
  };
}
const analysis = (over: Partial<ShadowAnalysis> = {}): ShadowAnalysis => ({
  intent: 'booking', emergency: false, emergency_reason: null, greeting: 'Thanks for calling, this is Sarah.',
  triage_summary: 'AC not cooling.', would_book: true, slot_label: 'Tomorrow morning', service: 'AC repair',
  crm_entry: { name: null, phone_present: true, service: 'AC repair', notes: 'AC down' }, follow_up_sms: 'We have you down for tomorrow AM.',
  confidence: 0.8, ...over,
});
const stub = (a: unknown = analysis()): ShadowPorts => ({ analyze: async () => a });
const cfg = (over: Partial<ConsentConfig> = {}): ConsentConfig => ({
  replayAttested: true, callerDisclosureConfigured: true, staffNotified: true, telephonySupportsFork: true, counselClearedStates: [], ...over,
});

describe('trial clock', () => {
  it('computes day 1..7 and expiry', () => {
    expect(trialDay(START, START)).toBe(1);
    expect(trialDay(START, at(2, 1))).toBe(3);
    expect(trialDay(START, at(6, 23))).toBe(7);
    expect(isTrialExpired(START, at(6, 23))).toBe(false);
    expect(isTrialExpired(START, at(7, 0))).toBe(true);
    expect(trialDay(START, at(-1))).toBe(0);
    expect(trialDay('bad', START)).toBe(0);
  });
  it('digests are due on days 1, 3, 7 exactly once', () => {
    expect(digestDue(START, at(0, 1), [])).toBe(1);
    expect(digestDue(START, at(0, 1), [1])).toBeNull();
    expect(digestDue(START, at(1, 1), [1])).toBeNull();
    expect(digestDue(START, at(2, 1), [1])).toBe(3);
    expect(digestDue(START, at(9, 0), [1, 3])).toBe(7); // late tick still sends day-7 digest
    expect(digestDue(START, at(9, 0), [1, 3, 7])).toBeNull();
  });
});

describe('consent gating', () => {
  it('replay needs attestation, disclosure and staff notice', () => {
    expect(evaluateConsent('replay', '+15125550123', cfg()).allowed).toBe(true);
    expect(evaluateConsent('replay', '+15125550123', cfg({ replayAttested: false })).reason).toBe('replay_not_attested');
    expect(evaluateConsent('replay', '+15125550123', cfg({ callerDisclosureConfigured: false })).reason).toBe('disclosure_missing');
    expect(evaluateConsent('replay', '+15125550123', cfg({ staffNotified: false })).reason).toBe('staff_not_notified');
  });
  it('live-listen is blocked without fork support', () => {
    expect(evaluateConsent('live_listen', '+15125550123', cfg({ telephonySupportsFork: false })).reason).toBe('fork_unsupported');
  });
  it('live-listen is blocked for all-party states unless counsel-cleared', () => {
    const ca = '+14155550123';
    expect(evaluateConsent('live_listen', ca, cfg()).reason).toBe('all_party_state_not_cleared');
    expect(evaluateConsent('live_listen', ca, cfg()).needsLegalReview).toBe(true);
    expect(evaluateConsent('live_listen', ca, cfg({ counselClearedStates: ['CA'] })).allowed).toBe(true);
  });
  it('live-listen fails closed for unknown / non-NANP callers', () => {
    expect(evaluateConsent('live_listen', null, cfg()).reason).toBe('jurisdiction_unknown');
    expect(evaluateConsent('live_listen', '+442071234567', cfg()).allowed).toBe(false);
  });
  it('live-listen allowed for a one-party-state number with all prerequisites', () => {
    expect(evaluateConsent('live_listen', '+15125550123', cfg()).allowed).toBe(true);
  });
});

describe('PII redaction & retention', () => {
  it('redacts email, phone, SSN, Luhn-valid card and street address', () => {
    const r = redactPii('Email me at bob@example.com or 512-555-0123. SSN 123-45-6789. Card 4242 4242 4242 4242. I live at 123 Main Street.');
    expect(r).not.toMatch(/bob@example\.com/);
    expect(r).not.toMatch(/512-555-0123/);
    expect(r).not.toMatch(/123-45-6789/);
    expect(r).not.toMatch(/4242 4242 4242 4242/);
    expect(r).not.toMatch(/123 Main Street/);
    expect(r).toContain('[EMAIL]'); expect(r).toContain('[PHONE]'); expect(r).toContain('[SSN]'); expect(r).toContain('[CARD]'); expect(r).toContain('[ADDRESS]');
  });
  it('leaves non-Luhn digit runs alone and handles null', () => {
    expect(redactPii('order 1234567890123456')).toContain('1234567890123456');
    expect(redactPii(null)).toBe('');
  });
  it('retention clamps to 1..90 with 30 default', () => {
    expect(clampRetentionDays(undefined)).toBe(30);
    expect(clampRetentionDays(0)).toBe(1);
    expect(clampRetentionDays(500)).toBe(90);
    expect(purgeAfter(START, 30)).toBe(at(30));
  });
});

describe('emergency floor', () => {
  it('catches hazards in English, Spanish and Persian', () => {
    expect(detectEmergencyFloor('I smell gas in the kitchen').emergency).toBe(true);
    expect(detectEmergencyFloor('hay una fuga de gas').emergency).toBe(true);
    expect(detectEmergencyFloor('بوی گاز می‌آید').emergency).toBe(true);
    expect(detectEmergencyFloor('we have no heat and a newborn in the house').emergency).toBe(true);
    expect(detectEmergencyFloor('want a quote for a new thermostat').emergency).toBe(false);
  });
  it('pipeline cannot let the model downgrade a floor-caught emergency', async () => {
    const card = await buildShadowCard(input({ transcript: 'There is a gas leak in my basement!' }), stub(analysis({ emergency: false, intent: 'quote' })));
    expect(card.analysis.emergency).toBe(true);
    expect(card.analysis.intent).toBe('emergency');
    expect(card.actions.some((a) => a.kind === 'flag_emergency')).toBe(true);
  });
});

describe('diff vs actual', () => {
  it('classifies outcomes', () => {
    expect(diffAgainstActual(input({ status: 'missed' }), analysis()).outcome).toBe('missed');
    expect(diffAgainstActual(input({ status: 'voicemail' }), analysis()).outcome).toBe('voicemail');
    expect(diffAgainstActual(input({ status: 'completed', answeredAt: at(0, 0) }), analysis()).outcome).toBe('answered_fast');
    const slow = diffAgainstActual(input({ status: 'completed', answeredAt: new Date(Date.parse(START) + 45_000).toISOString() }), analysis());
    expect(slow.outcome).toBe('answered_slow');
    expect(slow.answerSeconds).toBe(45);
  });
  it('only counts lead intents on unanswered/slow/after-hours calls as capturable', () => {
    expect(diffAgainstActual(input({ status: 'missed' }), analysis()).sarahWouldHaveCaptured).toBe(true);
    expect(diffAgainstActual(input({ status: 'missed' }), analysis({ intent: 'spam', would_book: false })).sarahWouldHaveCaptured).toBe(false);
    expect(diffAgainstActual(input({ status: 'completed', answeredAt: START }), analysis()).sarahWouldHaveCaptured).toBe(false);
    expect(diffAgainstActual(input({ status: 'completed', answeredAt: START, isAfterHours: true }), analysis()).sarahWouldHaveCaptured).toBe(true);
  });
});

describe('estimate math', () => {
  const cards = (n: number) => Array.from({ length: n }, () => ({ wouldBook: true, capturable: true }));
  it('point = captured × close rate × ticket, labeled as an estimate', () => {
    const e = computeEstimate({ avgTicketCents: 40_000, closeRate: 0.25, cards: cards(20) });
    expect(e.isEstimate).toBe(true);
    expect(e.label).toBe(ESTIMATE_LABEL);
    expect(e.pointCents).toBe(20 * 0.25 * 40_000);
    expect(e.expectedBookings).toBe(5);
    expect(e.reason).toBe('ok');
    expect(e.formula).toMatch(/close rate/);
  });
  it('range brackets the point and low <= point <= high', () => {
    const e = computeEstimate({ avgTicketCents: 40_000, closeRate: 0.25, cards: cards(20) });
    expect(e.lowCents!).toBeLessThanOrEqual(e.pointCents!);
    expect(e.highCents!).toBeGreaterThanOrEqual(e.pointCents!);
    expect(e.lowCents!).toBe(Math.round(20 * 0.25 * CLOSE_RATE_BAND.low * 40_000 * 0.8));
  });
  it('never exceeds captured calls × avg ticket (cap) even with absurd inputs', () => {
    const e = computeEstimate({ avgTicketCents: 100_000, closeRate: 99, cards: cards(10) });
    expect(e.closeRate).toBe(MAX_CLOSE_RATE);
    expect(e.highCents!).toBeLessThanOrEqual(10 * 100_000);
  });
  it('falls back to default close rate and ignores non-capturable / non-booking cards', () => {
    const e = computeEstimate({ avgTicketCents: 10_000, closeRate: null, cards: [...cards(4), { wouldBook: true, capturable: false }, { wouldBook: false, capturable: true }] });
    expect(e.closeRate).toBe(DEFAULT_CLOSE_RATE);
    expect(e.capturableCalls).toBe(4);
  });
  it('returns null money (not zero) when there is no average ticket', () => {
    const e = computeEstimate({ avgTicketCents: null, closeRate: 0.25, cards: cards(5) });
    expect(e.pointCents).toBeNull();
    expect(e.reason).toBe('no_avg_ticket');
  });
  it('is zero with reason when nothing was capturable', () => {
    const e = computeEstimate({ avgTicketCents: 10_000, closeRate: 0.25, cards: [] });
    expect(e.pointCents).toBe(0);
    expect(e.reason).toBe('no_capturable_calls');
  });
});

describe('replay pipeline', () => {
  it('is deterministic for identical input and analysis', async () => {
    const a = await buildShadowCard(input(), stub());
    const b = await buildShadowCard(input(), stub());
    expect(b).toEqual(a);
    expect(a.idempotencyKey).toBe(idempotencyKey('acct-1', 'pbx_call', 'call-1'));
    expect(a.idempotencyKey.endsWith(PIPELINE_VERSION)).toBe(true);
  });
  it('stores only the redacted transcript', async () => {
    const card = await buildShadowCard(input(), stub());
    expect(card.transcriptRedacted).not.toMatch(/512-555-0123/);
    expect(card.transcriptRedacted).toContain('[PHONE]');
  });
  it('SHADOW SAFETY: the only capability used is analyze(); every action is executed:false', async () => {
    const calls: string[] = [];
    // Anything other than `analyze` throws if touched — sms/booking/transfer/dial must be unreachable.
    const ports = new Proxy({ analyze: async () => { calls.push('analyze'); return analysis(); } }, {
      get(target, prop) {
        if (prop === 'analyze') return target.analyze;
        throw new Error(`FORBIDDEN_SIDE_EFFECT_PORT:${String(prop)}`);
      },
    }) as unknown as ShadowPorts;
    const card = await buildShadowCard(input(), ports);
    expect(calls).toEqual(['analyze']);
    expect(card.actions.length).toBeGreaterThan(0);
    for (const a of card.actions) expect(a.executed).toBe(false);
  });
  it('assertShadowSafe rejects an executed action', () => {
    const bad = [{ kind: 'send_follow_up_sms', description: 'x', executed: true }] as unknown as WouldBeAction[];
    expect(() => assertShadowSafe(bad)).toThrow(/SHADOW_SAFETY_VIOLATION/);
  });
  it('handles no transcript, model failure, and garbage output without throwing', async () => {
    const empty = await buildShadowCard(input({ transcript: '   ' }), stub());
    const failed = await buildShadowCard(input(), { analyze: async () => { throw new Error('boom'); } });
    const garbage = await buildShadowCard(input(), stub('not json'));
    expect(empty.status).toBe('no_transcript');
    expect(failed.status).toBe('analysis_failed');
    expect(garbage.status).toBe('analysis_failed');
    // regression: non-analysed cards must not emit phantom would-be actions
    expect(empty.actions.length + failed.actions.length + garbage.actions.length).toBe(0);
    expect(empty.capturable || failed.capturable || garbage.capturable).toBe(false);
  });
  it('normalizeAnalysis clamps and defaults untrusted model output', () => {
    const n = normalizeAnalysis({ intent: 'hack', confidence: 7, greeting: 'x'.repeat(5000), would_book: 'yes' })!;
    expect(n.intent).toBe('other');
    expect(n.confidence).toBe(1);
    expect(n.greeting.length).toBe(400);
    expect(n.would_book).toBe(false);
  });
  it('consent-blocked calls are counted but store no transcript and never reach the model', async () => {
    let touched = false;
    const ports: ShadowPorts = { analyze: async () => { touched = true; return analysis(); } };
    const card = await buildShadowCard(input(), ports, { blocked: 'disclosure_missing' });
    expect(touched).toBe(false);
    expect(card.status).toBe('blocked_consent');
    expect(card.blockReason).toBe('disclosure_missing');
    expect(card.transcriptRedacted).toBe('');
    expect(card.actions.length).toBe(0);
  });
  it('does not create a lead record for spam', async () => {
    const card = await buildShadowCard(input(), stub(analysis({ intent: 'spam', would_book: false, follow_up_sms: null })));
    expect(card.actions.some((a) => a.kind === 'create_crm_entry')).toBe(false);
  });
});

describe('readiness', () => {
  const base = { cardsTotal: 40, cardsReviewed: 30, approved: 28, emergencyCards: 3, emergencyApproved: 3, openCriticalMistakes: 0, setupItemsDone: 4 };
  it('refuses to score with too little review data', () => {
    const r = computeReadiness({ ...base, cardsReviewed: MIN_REVIEWED_FOR_READINESS - 1 });
    expect(r.state).toBe('insufficient_data');
    expect(r.score).toBeNull();
  });
  it('scores a healthy trial as ready', () => {
    const r = computeReadiness(base);
    expect(r.state).toBe('scored');
    expect(r.band).toBe('ready');
  });
  it('an open critical mistake caps the score below ready', () => {
    expect(computeReadiness({ ...base, openCriticalMistakes: 1 }).score!).toBeLessThanOrEqual(69);
  });
  it('a missed emergency caps the score below ready', () => {
    const r = computeReadiness({ ...base, emergencyApproved: 2 });
    expect(r.score!).toBeLessThanOrEqual(79);
    expect(r.band).not.toBe('ready');
  });
});

import { isAfterHoursIn, isValidTimeZone } from './logic';

describe('after-hours in the business time zone', () => {
  const hours = { mon: { open: '08:00', close: '17:00' }, tue: { open: '08:00', close: '17:00' }, sun: { closed: true } };
  it('judges in local time, not UTC', () => {
    // Mon 2028-04-03 21:30 UTC = 16:30 in Chicago (CDT) -> open; 23:00 UTC = 18:00 -> closed
    expect(isAfterHoursIn(hours, [], '2028-04-03T21:30:00Z', 'America/Chicago')).toBe(false);
    expect(isAfterHoursIn(hours, [], '2028-04-03T23:00:00Z', 'America/Chicago')).toBe(true);
    expect(isAfterHoursIn(hours, [], '2028-04-03T21:30:00Z', 'UTC')).toBe(true);
  });
  it('treats closed days, undefined days and holidays as after-hours', () => {
    expect(isAfterHoursIn(hours, [], '2028-04-02T15:00:00Z', 'America/Chicago')).toBe(true); // Sunday closed
    expect(isAfterHoursIn(hours, [], '2028-04-05T15:00:00Z', 'America/Chicago')).toBe(true); // Wed not configured
    expect(isAfterHoursIn(hours, ['2028-04-03'], '2028-04-03T15:00:00Z', 'America/Chicago')).toBe(true);
  });
  it('never claims after-hours when hours are unknown or the timestamp is bad', () => {
    expect(isAfterHoursIn(null, [], '2028-04-03T23:00:00Z', 'America/Chicago')).toBe(false);
    expect(isAfterHoursIn(hours, [], 'nope', 'America/Chicago')).toBe(false);
  });
  it('validates IANA zones', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});
