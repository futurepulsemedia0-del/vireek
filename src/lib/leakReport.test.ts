import { describe, expect, it } from 'vitest';
import {
  computeLeakReport,
  isAfterHours,
  mergeObservations,
  normalizeEvent,
  normalizePhoneKey,
  parseCallLogCsv,
  reportPhase,
  type CallObservation,
} from '../../supabase/functions/_shared/leak-report/core';
import { buildLeakReportPdf, leakReportFileName } from '@/lib/leakReportPdf';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const ev = (id: string, iso: string, direction: 'inbound' | 'outbound', answered: boolean, phoneKey: string | null, ringSeconds: number | null = null): CallObservation => ({
  id, startedAt: iso, direction, answered, isVoicemail: false, ringSeconds, durationSeconds: null, phoneKey,
});

const events = [
  ev('1', '2026-10-20T14:00:00Z', 'inbound', true, '4155550001', 8),
  ev('2', '2026-10-20T15:00:00Z', 'inbound', false, '4155550002'),
  ev('3', '2026-10-20T15:10:00Z', 'outbound', true, '4155550002'),
  ev('4', '2026-10-21T03:00:00Z', 'inbound', false, '4155550003'),
  ev('5', '2026-10-21T03:05:00Z', 'inbound', false, '4155550003'),
  ev('6', '2026-10-22T16:00:00Z', 'inbound', false, '4155550004'),
  ev('7', '2026-10-22T18:00:00Z', 'inbound', true, '4155550004', 5),
];
const base = {
  windowStart: new Date('2026-10-19T00:00:00Z'),
  windowEnd: new Date('2026-10-26T00:00:00Z'),
  timeZone: 'America/New_York',
  businessHours: null,
  nowMs: NOW,
};

describe('computeLeakReport', () => {
  const r = computeLeakReport({ ...base, events, avgTicketCents: 45000 });

  it('counts answered, missed and answer rate', () => {
    expect(r.inboundTotal).toBe(6);
    expect(r.answered).toBe(2);
    expect(r.missed).toBe(4);
    expect(r.answerRate).toBe(33);
  });
  it('treats callbacks, caller retries and never-reached callers separately (unique callers)', () => {
    expect(r.calledBack).toBe(1);
    expect(r.recoveredByCaller).toBe(1);
    expect(r.lostCallers).toBe(1);
    expect(r.medianCallbackSeconds).toBe(600);
    expect(r.neverCalledBackRate).toBe(33);
  });
  it('counts after-hours calls in the business time zone', () => {
    expect(r.afterHoursTotal).toBe(2);
    expect(r.afterHoursMissed).toBe(2);
  });
  it('prices the leak with the average ticket and close rate, never inventing a number', () => {
    expect(r.estimatedLostCents).toBe(13500);
    expect(r.ceilingLostCents).toBe(45000);
    expect(r.annualizedLostCents).not.toBeNull();
    const none = computeLeakReport({ ...base, events, avgTicketCents: null });
    expect(none.estimatedLostCents).toBeNull();
    expect(none.lostCallers).toBe(1);
  });
  it('handles zero calls', () => {
    const empty = computeLeakReport({ ...base, events: [], avgTicketCents: 10000 });
    expect(empty.answerRate).toBeNull();
    expect(empty.estimatedLostCents).toBe(0);
  });
});

describe('normalization', () => {
  it('normalizes phone numbers to digits', () => {
    expect(normalizePhoneKey('+1 (415) 555-0100')).toBe('4155550100');
    expect(normalizePhoneKey('123')).toBeNull();
  });
  it('maps a Twilio status callback', () => {
    const res = normalizeEvent({ CallSid: 'CA1', From: '+14155550100', Direction: 'inbound', CallStatus: 'no-answer', Timestamp: 'Tue, 20 Oct 2026 14:00:00 +0000' }, 's', NOW);
    expect(res.ok && res.event.answered).toBe(false);
    expect(res.ok && res.event.dedupeKey).toBe('s:CA1');
  });
  it('maps a CallRail-style payload and rejects bad timestamps', () => {
    const ok = normalizeEvent({ id: 9, customer_phone_number: '4155550100', answered: true, start_time: '2026-10-20T14:00:00Z', duration: 60 }, 's', NOW);
    expect(ok.ok && ok.event.answered).toBe(true);
    expect(normalizeEvent({ answered: true }, 's', NOW)).toEqual({ ok: false, reason: 'bad_start_time' });
    expect(normalizeEvent({ started_at: '2030-01-01T00:00:00Z' }, 's', NOW)).toEqual({ ok: false, reason: 'start_in_future' });
  });
  it('parses a CSV call log and skips bad rows', () => {
    const csv = 'Date,Time,From,Direction,Status,Duration\n2026-10-20,09:00,"(415) 555-0100",Inbound,Missed,0\n2026-10-20,09:30,415-555-0101,Outbound,Completed,45\nbad,row,,,,\n';
    const res = parseCallLogCsv(csv, NOW);
    expect(res.events).toHaveLength(2);
    expect(res.rejected).toBe(1);
    expect(res.events[1].direction).toBe('outbound');
  });
});

describe('helpers', () => {
  it('respects configured business hours and the default fallback', () => {
    const hours = { tue: { open: '09:00', close: '17:00' } };
    expect(isAfterHours('2026-10-20T17:00:00Z', 'America/New_York', hours)).toBe(false); // Tue 1pm
    expect(isAfterHours('2026-10-21T17:00:00Z', 'America/New_York', hours)).toBe(true); // Wed not listed
    expect(isAfterHours('2026-10-24T17:00:00Z', 'America/New_York', null)).toBe(true); // Saturday default
  });
  it('lets observed calls win over matching Vireek calls', () => {
    const merged = mergeObservations([ev('o', '2026-10-20T14:00:00Z', 'inbound', false, '4155550001')], [ev('v', '2026-10-20T14:01:00Z', 'inbound', true, '4155550001')]);
    expect(merged).toHaveLength(1);
  });
  it('derives the report phase', () => {
    const start = '2026-10-20T00:00:00Z';
    expect(reportPhase(false, null, 0, 7, NOW)).toBe('off');
    expect(reportPhase(true, start, 0, 7, NOW)).toBe('waiting');
    expect(reportPhase(true, start, 3, 7, NOW)).toBe('collecting');
    expect(reportPhase(true, '2026-10-01T00:00:00Z', 3, 7, NOW)).toBe('complete');
  });
});

describe('buildLeakReportPdf', () => {
  const meta = { businessName: 'Acme HVAC', periodStart: '2026-10-19T00:00:00Z', periodEnd: '2026-10-26T00:00:00Z', generatedAt: '2026-10-24T12:00:00Z', ticketLabel: 'from your invoiced jobs' };
  it('is always exactly one page, with data, without a ticket and with no calls', () => {
    const withData = computeLeakReport({ ...base, events, avgTicketCents: 45000 });
    const noTicket = computeLeakReport({ ...base, events, avgTicketCents: null });
    const empty = computeLeakReport({ ...base, events: [], avgTicketCents: null });
    for (const r of [withData, noTicket, empty]) {
      const doc = buildLeakReportPdf(meta, r);
      expect(doc.getNumberOfPages()).toBe(1);
      expect(doc.output('arraybuffer').byteLength).toBeGreaterThan(1000);
    }
  });
  it('survives a very long business name and builds a safe file name', () => {
    const r = computeLeakReport({ ...base, events, avgTicketCents: 45000 });
    expect(() => buildLeakReportPdf({ ...meta, businessName: 'x'.repeat(300) }, r)).not.toThrow();
    expect(leakReportFileName("Acme & Sons HVAC!", '2026-10-24T12:00:00Z')).toBe('leak-report-acme-sons-hvac-2026-10-24.pdf');
  });
});
