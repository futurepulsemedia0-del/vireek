import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  describeEvent,
  describeStopReason,
  evaluateSla,
  filterCases,
  formatDuration,
  formatOffset,
  isResponseEvent,
  mapCaseRow,
  mapEventRow,
  mapSettingsRow,
  median,
  needsAttention,
  normalizeSlaLimit,
  parseSlaLimitInput,
  summarizeCases,
  DEFAULT_SLA_SETTINGS,
  type RescueCase,
  type RescueEvent,
  type SlaInput,
} from '@/lib/rescueLoop';

const T0 = new Date('2026-10-19T15:00:00Z').getTime();
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const sla = (over: Partial<SlaInput> = {}): SlaInput => ({
  clockStart: at(0),
  firstResponseAt: null,
  deferred: false,
  ledgerStatus: 'open',
  limitSeconds: 60,
  excuseQuietHours: true,
  now: T0,
  ...over,
});

let seq = 0;
function ev(over: Partial<RescueEvent> = {}): RescueEvent {
  seq += 1;
  return {
    callId: 'call-1',
    kind: 'text_sent',
    occurredAt: at(10),
    outcome: 'ok',
    channel: 'sms',
    automated: true,
    detail: null,
    amountCents: null,
    refTable: 't',
    refId: `id-${seq}`,
    ...over,
  };
}

function kase(over: Partial<RescueCase> = {}): RescueCase {
  seq += 1;
  return {
    callId: `call-${seq}`,
    ledgerId: `l-${seq}`,
    caseType: 'missed',
    callAt: at(0),
    clockStart: at(0),
    callerName: 'Dana',
    callerPhone: '+15551230000',
    valueCents: 20_000,
    ledgerStatus: 'open',
    firstResponseAt: null,
    firstResponseKind: null,
    responseSeconds: null,
    limitSeconds: 60,
    slaStatus: 'pending',
    deferred: false,
    bookedAt: null,
    paidAt: null,
    lastEventAt: null,
    eventCount: 1,
    ...over,
  };
}

describe('formatDuration / formatOffset', () => {
  it('matches the SQL rescue_fmt_seconds format', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(59.6)).toBe('1m 00s');
    expect(formatDuration(185)).toBe('3m 05s');
    expect(formatDuration(4200)).toBe('1h 10m');
    expect(formatDuration(2 * 86_400 + 4 * 3600 + 59)).toBe('2d 4h');
  });
  it('handles missing and negative input', () => {
    expect(formatDuration(null)).toBe('–');
    expect(formatDuration(undefined)).toBe('–');
    expect(formatDuration(Number.NaN)).toBe('–');
    expect(formatDuration(-5)).toBe('0s');
  });
  it('signs offsets', () => {
    expect(formatOffset(0)).toBe('0s');
    expect(formatOffset(42)).toBe('+42s');
    expect(formatOffset(-185)).toBe('−3m 05s');
  });
});

describe('SLA limit parsing', () => {
  it('parses seconds, minutes and hours', () => {
    expect(parseSlaLimitInput('90')).toBe(90);
    expect(parseSlaLimitInput('90s')).toBe(90);
    expect(parseSlaLimitInput('2m')).toBe(120);
    expect(parseSlaLimitInput('2 min')).toBe(120);
    expect(parseSlaLimitInput('1.5h')).toBe(5400);
  });
  it('rejects junk and out-of-range values', () => {
    expect(parseSlaLimitInput('')).toBeNull();
    expect(parseSlaLimitInput('abc')).toBeNull();
    expect(parseSlaLimitInput('5')).toBeNull();
    expect(parseSlaLimitInput('25h')).toBeNull();
    expect(parseSlaLimitInput('-3')).toBeNull();
  });
  it('clamps to the database range', () => {
    expect(normalizeSlaLimit(1)).toBe(10);
    expect(normalizeSlaLimit(999_999)).toBe(86_400);
    expect(normalizeSlaLimit(Number.NaN)).toBe(60);
    expect(normalizeSlaLimit(61.4)).toBe(61);
  });
});

describe('evaluateSla (mirrors rescue_classify_sla)', () => {
  it('met when the response lands exactly on the limit', () => {
    const r = evaluateSla(sla({ firstResponseAt: at(60), now: T0 + 500_000 }));
    expect(r.status).toBe('met');
    expect(r.responseSeconds).toBe(60);
  });
  it('late one second past the limit', () => {
    const r = evaluateSla(sla({ firstResponseAt: at(61), now: T0 + 500_000 }));
    expect(r.status).toBe('late');
    expect(r.responseSeconds).toBe(61);
  });
  it('a response before the clock start counts as 0s and met', () => {
    const r = evaluateSla(sla({ firstResponseAt: at(-5) }));
    expect(r.status).toBe('met');
    expect(r.responseSeconds).toBe(0);
  });
  it('pending inside the limit with a countdown', () => {
    const r = evaluateSla(sla({ now: T0 + 20_000 }));
    expect(r.status).toBe('pending');
    expect(r.remainingSeconds).toBe(40);
  });
  it('exactly at the limit is still pending; one ms later is breached', () => {
    expect(evaluateSla(sla({ now: T0 + 60_000 })).status).toBe('pending');
    const r = evaluateSla(sla({ now: T0 + 90_000 }));
    expect(r.status).toBe('breached');
    expect(r.overdueSeconds).toBe(30);
  });
  it('closed beats breached for written-off and recovered entries', () => {
    expect(evaluateSla(sla({ ledgerStatus: 'written_off', now: T0 + 900_000 })).status).toBe('closed');
    expect(evaluateSla(sla({ ledgerStatus: 'recovered', now: T0 + 900_000 })).status).toBe('closed');
  });
  it('a response wins over closed', () => {
    expect(evaluateSla(sla({ ledgerStatus: 'written_off', firstResponseAt: at(5) })).status).toBe('met');
  });
  it('quiet-hours deferral is excused only when the account allows it', () => {
    expect(evaluateSla(sla({ deferred: true, now: T0 + 900_000 })).status).toBe('excused');
    expect(evaluateSla(sla({ deferred: true, excuseQuietHours: false, now: T0 + 900_000 })).status).toBe('breached');
  });
});

describe('isResponseEvent', () => {
  it('counts successful or unanswered attempts only', () => {
    expect(isResponseEvent({ kind: 'text_sent', outcome: 'ok' })).toBe(true);
    expect(isResponseEvent({ kind: 'callback_attempt', outcome: 'no_answer' })).toBe(true);
    expect(isResponseEvent({ kind: 'text_sent', outcome: 'failed' })).toBe(false);
    expect(isResponseEvent({ kind: 'text_sent', outcome: 'pending' })).toBe(false);
    expect(isResponseEvent({ kind: 'text_sent', outcome: 'deferred' })).toBe(false);
    expect(isResponseEvent({ kind: 'text_sent', outcome: 'info' })).toBe(false);
    expect(isResponseEvent({ kind: 'customer_reply', outcome: 'ok' })).toBe(false);
    expect(isResponseEvent({ kind: 'link_click', outcome: 'ok' })).toBe(false);
  });
});

describe('describeEvent', () => {
  it('prettifies workflow stop reasons', () => {
    expect(describeStopReason('customer_opted_out')).toContain('opted out');
    expect(describeStopReason('step_3_failed')).toContain('step 3');
    expect(describeStopReason('condition_failed:lead_not_progressed')).toContain('moved forward');
    expect(describeStopReason('condition_failed:some_new_check')).toContain('some new check');
    expect(describeStopReason(null)).toBe('The automation stopped.');
  });
  it('maps Call Queue outcome keys to their labels', () => {
    const d = describeEvent(ev({ kind: 'human_followup', detail: 'reached_booked', automated: false }));
    expect(d.detail).toBe('Reached — booked');
    expect(describeEvent(ev({ kind: 'human_followup', detail: 'weird_key' })).detail).toBe('Attempt logged in the Call Queue');
  });
  it('adds the amount to payments and tones outcomes', () => {
    const pay = describeEvent(ev({ kind: 'payment_received', detail: 'Invoice 7 paid', amountCents: 123_456 }));
    expect(pay.detail).toBe('Invoice 7 paid · $1,234.56');
    expect(pay.tone).toBe('good');
    expect(describeEvent(ev({ outcome: 'failed' })).tone).toBe('bad');
    expect(describeEvent(ev({ outcome: 'deferred' })).tone).toBe('warn');
    expect(describeEvent(ev({ outcome: 'pending' })).tone).toBe('pending');
  });
});

describe('buildTimeline', () => {
  const opts = { clockStart: at(0), limitSeconds: 60, now: T0 + 3600_000 };

  it('orders events, offsets them from the miss and inserts the SLA marker', () => {
    const items = buildTimeline(
      [
        ev({ kind: 'booked', occurredAt: at(900), channel: 'web', automated: false }),
        ev({ kind: 'text_sent', occurredAt: at(42) }),
        ev({ kind: 'call_missed', occurredAt: at(0), automated: false, outcome: 'info', channel: 'call' }),
        ev({ kind: 'link_click', occurredAt: at(300), channel: 'web', automated: false }),
      ],
      opts,
    );
    expect(items.map((i) => i.kind)).toEqual(['call_missed', 'text_sent', 'sla_limit', 'link_click', 'booked']);
    expect(items.map((i) => i.offsetLabel)).toEqual(['0s', '+42s', '+1m 00s', '+5m 00s', '+15m 00s']);
    expect(items[2].passed).toBe(true);
  });

  it('puts the miss first and the marker after a real event at the same instant', () => {
    const items = buildTimeline(
      [ev({ kind: 'text_sent', occurredAt: at(60) }), ev({ kind: 'call_missed', occurredAt: at(0), outcome: 'info' })],
      opts,
    );
    expect(items.map((i) => i.kind)).toEqual(['call_missed', 'text_sent', 'sla_limit']);
  });

  it('marks pending steps whose time has long passed as overdue, and keeps the marker upcoming', () => {
    const items = buildTimeline([ev({ outcome: 'pending', occurredAt: at(10) })], { ...opts, now: T0 + 30_000 });
    expect(items.find((i) => i.kind === 'text_sent')?.overdue).toBe(false);
    expect(items.find((i) => i.kind === 'sla_limit')?.passed).toBe(false);
    const late = buildTimeline([ev({ outcome: 'pending', occurredAt: at(10) })], opts);
    expect(late.find((i) => i.kind === 'text_sent')?.overdue).toBe(true);
  });

  it('drops events with unparseable timestamps instead of crashing', () => {
    const items = buildTimeline([ev({ occurredAt: 'garbage' })], opts);
    expect(items.map((i) => i.kind)).toEqual(['sla_limit']);
  });

  it('gives events before the clock start (abandoned calls) a negative offset', () => {
    const items = buildTimeline([ev({ kind: 'call_missed', occurredAt: at(-120), outcome: 'info' })], opts);
    expect(items[0].offsetLabel).toBe('−2m 00s');
  });
});

describe('summaries and filters', () => {
  const settings = DEFAULT_SLA_SETTINGS;
  const now = T0 + 10 * 60_000;
  const cases = [
    kase({ firstResponseAt: at(20), bookedAt: at(600) }), // met
    kase({ firstResponseAt: at(40) }), // met
    kase({ firstResponseAt: at(300) }), // late
    kase({ valueCents: 50_000 }), // breached (no response, 10 min)
    kase({ ledgerStatus: 'written_off' }), // closed
    kase({ deferred: true }), // excused
    kase({ clockStart: at(10 * 60 - 20) }), // pending (20 s old)
  ];

  it('counts every status and computes compliance', () => {
    const s = summarizeCases(cases, settings, now);
    expect(s).toMatchObject({ total: 7, met: 2, late: 1, breached: 1, pending: 1, excused: 1, closed: 1, bookedCount: 1 });
    expect(s.complianceRate).toBeCloseTo(2 / 4);
    expect(s.atRiskValueCents).toBe(50_000);
    expect(s.medianResponseSeconds).toBe(40);
  });

  it('returns null rates when nothing is measurable', () => {
    const s = summarizeCases([kase({ ledgerStatus: 'written_off' })], settings, now);
    expect(s.complianceRate).toBeNull();
    expect(s.medianResponseSeconds).toBeNull();
    expect(summarizeCases([], settings, now).total).toBe(0);
  });

  it('filters', () => {
    expect(filterCases(cases, 'all', settings, now)).toHaveLength(7);
    expect(filterCases(cases, 'attention', settings, now)).toHaveLength(2);
    expect(filterCases(cases, 'pending', settings, now)).toHaveLength(1);
    expect(filterCases(cases, 'met', settings, now)).toHaveLength(2);
    expect(filterCases(cases, 'excused', settings, now)).toHaveLength(2);
  });

  it('turns pending into breached live as time passes', () => {
    const c = kase({ clockStart: at(0) });
    expect(summarizeCases([c], settings, T0 + 30_000).pending).toBe(1);
    expect(summarizeCases([c], settings, T0 + 61_000).breached).toBe(1);
  });

  it('median handles even, odd and empty lists', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 9, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(3);
  });

  it('needsAttention', () => {
    expect(needsAttention('late')).toBe(true);
    expect(needsAttention('breached')).toBe(true);
    expect(needsAttention('met')).toBe(false);
  });
});

describe('row mappers', () => {
  it('maps a case row and normalises bad values', () => {
    const c = mapCaseRow({
      rc_call_id: 'c1',
      rc_ledger_id: 'l1',
      rc_case_type: 'voicemail',
      rc_call_at: at(0),
      rc_clock_start: at(0),
      rc_caller_name: null,
      rc_caller_phone: '+1555',
      rc_value_cents: '25000',
      rc_ledger_status: 'open',
      rc_first_response_at: at(30),
      rc_first_response_kind: 'text_sent',
      rc_response_seconds: 30,
      rc_limit_seconds: 5,
      rc_sla_status: 'bogus',
      rc_deferred: false,
      rc_event_count: 3,
    });
    expect(c).toMatchObject({
      callerName: 'Unknown caller',
      caseType: 'voicemail',
      valueCents: 25_000,
      limitSeconds: 10,
      slaStatus: 'pending',
      firstResponseKind: 'text_sent',
      responseSeconds: 30,
      eventCount: 3,
    });
    expect(mapCaseRow({ rc_call_id: 'x' })).toBeNull();
  });

  it('maps events and rejects unknown kinds', () => {
    const e = mapEventRow({ ev_call_id: 'c', ev_kind: 'booked', ev_at: at(5), ev_outcome: 'ok', ev_channel: 'web', ev_automated: false, ev_amount_cents: null });
    expect(e).toMatchObject({ kind: 'booked', channel: 'web', automated: false, amountCents: null });
    expect(mapEventRow({ ev_call_id: 'c', ev_kind: 'nope', ev_at: at(5) })).toBeNull();
    expect(mapEventRow({ ev_call_id: 'c', ev_kind: 'booked', ev_at: 'bad' })).toBeNull();
    expect(mapEventRow({ ev_call_id: 'c', ev_kind: 'booked', ev_at: at(1), ev_outcome: 'weird' })?.outcome).toBe('info');
  });

  it('maps settings with defaults', () => {
    expect(mapSettingsRow(null)).toEqual(DEFAULT_SLA_SETTINGS);
    expect(mapSettingsRow({ first_response_limit_seconds: 120, alerts_enabled: false, excuse_quiet_hours: false })).toEqual({
      firstResponseLimitSeconds: 120,
      alertsEnabled: false,
      excuseQuietHours: false,
    });
  });
});
