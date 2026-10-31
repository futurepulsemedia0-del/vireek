import { describe, expect, it } from 'vitest';
import {
  ESTIMATE_LABEL, computeVoiceReport, invoiceSubtotalCents, isAfterHours, monthlySummary, monthlySummaryCsvRows,
  type BusinessHours, type VoiceCallRow, type VoiceReportInput,
} from './voiceMetrics';

const HOURS: BusinessHours = {
  mon: { open: '08:00', close: '17:00' }, tue: { open: '08:00', close: '17:00' }, wed: { open: '08:00', close: '17:00' },
  thu: { open: '08:00', close: '17:00' }, fri: { open: '08:00', close: '17:00' }, sat: { closed: true }, sun: { closed: true },
};
const TZ = 'America/Chicago'; // CST (UTC-6) in January 2027

const call = (id: string, iso: string, over: Partial<VoiceCallRow> = {}): VoiceCallRow => ({
  id, call_datetime: iso, status: 'new_lead', is_voicemail: false, is_emergency: false, duration_seconds: 120,
  human_transfer_requested: false, escalated_to: null, vapi_call_id: `v-${id}`, ...over,
});

// Seeded fixture. Local (Chicago) times: Mon 2027-01-11 09:00 in-hours; Mon 19:00 after; Sat 10:00 after; Tue 08:00 boundary in-hours; Mon 17:00 boundary after.
const calls: VoiceCallRow[] = [
  call('c1', '2027-01-11T15:00:00Z'),                                            // Mon 09:00 answered, booked
  call('c2', '2027-01-12T01:00:00Z', { duration_seconds: 240, is_emergency: true, human_transfer_requested: true }), // Mon 19:00 after-hours, emergency, transfer
  call('c3', '2027-01-16T16:00:00Z', { duration_seconds: 60 }),                    // Sat 10:00 after-hours, booked
  call('c4', '2027-01-12T14:00:00Z', { status: 'missed', duration_seconds: null, vapi_call_id: null }), // Tue 08:00 missed
  call('c5', '2027-01-11T23:00:00Z', { is_voicemail: true }),                       // Mon 17:00 voicemail -> missed
  call('c6', '2027-01-13T15:00:00Z', { status: 'spam' }),
  call('c7', '2027-02-02T16:00:00Z', { escalated_to: '+15550001111', duration_seconds: null }), // Feb, answered, transferred, no duration
];
const jobs = [{ id: 'j1', call_id: 'c1' }, { id: 'j2', call_id: 'c3' }, { id: 'j3', call_id: 'c3' }, { id: 'jx', call_id: 'other-tenant-call' }, { id: 'jn', call_id: null }];
const invoices = [
  { job_id: 'j1', status: 'paid', line_items: [{ quantity: 2, unit_price_cents: 5000 }, { quantity: 1, unit_price_cents: 2500 }] }, // 12500
  { job_id: 'j2', status: 'paid', line_items: [{ quantity: 1, unit_price_cents: 30000 }] },                                          // 30000
  { job_id: 'j3', status: 'sent', line_items: [{ quantity: 1, unit_price_cents: 10000 }] },                                          // invoiced only
  { job_id: 'j3', status: 'void', line_items: [{ quantity: 1, unit_price_cents: 99999 }] },                                          // ignored
  { job_id: 'jx', status: 'paid', line_items: [{ quantity: 1, unit_price_cents: 77777 }] },                                          // not in this call set
  { job_id: 'j1', status: 'paid', line_items: 'garbage' },                                                                            // malformed
];
const input: VoiceReportInput = { calls, jobs, invoices, businessHours: HOURS, holidays: [], timezone: TZ };

describe('computeVoiceReport (seeded)', () => {
  const r = computeVoiceReport(input);
  it('counts answered / missed / spam', () => {
    expect(r.totalCalls).toBe(7);
    expect(r.answeredCalls).toBe(4);
    expect(r.missedCalls).toBe(2);
    expect(r.spamCalls).toBe(1);
    expect(r.aiHandledCalls).toBe(6);
  });
  it('counts only jobs linked to calls in range', () => {
    expect(r.jobsBooked).toBe(3);
    expect(r.bookedCalls).toBe(2);
    expect(r.bookingRatePct).toBe(50);
  });
  it('transfers, emergencies, handle time (ignores null durations)', () => {
    expect(r.transfersToHuman).toBe(2);
    expect(r.emergencyCalls).toBe(1);
    expect(r.avgHandleSeconds).toBe(140); // (120+240+60)/3
    expect(r.handleTimeSamples).toBe(3);
  });
  it('after-hours share in the tenant timezone (weekend + evening count, 08:00 open boundary does not)', () => {
    expect(r.afterHoursCalls).toBe(2); // c2 Mon 19:00, c3 Sat; c7 Tue Feb 2 10:00 is in hours
    expect(r.afterHoursSharePct).toBe(50);
  });
  it('booking value: integer cents, void/other-tenant/malformed excluded, malformed counted', () => {
    expect(r.paidCents).toBe(42500);
    expect(r.invoicedCents).toBe(52500);
    expect(r.jobsWithPaidInvoice).toBe(2);
    expect(r.avgPaidJobCents).toBe(21250);
    expect(r.malformedInvoices).toBe(1);
    for (const v of [r.paidCents, r.invoicedCents, r.avgPaidJobCents!]) expect(Number.isInteger(v)).toBe(true);
  });
  it('empty data -> zeros and nulls, never NaN', () => {
    const e = computeVoiceReport({ calls: [], jobs: [], invoices: [], businessHours: HOURS, holidays: [], timezone: TZ });
    expect(e).toMatchObject({ totalCalls: 0, answeredCalls: 0, bookingRatePct: null, avgHandleSeconds: null, avgPaidJobCents: null, afterHoursSharePct: null, paidCents: 0 });
    expect(e.afterHoursCalls).toBe(0);
  });
  it('after-hours is null (not guessed) when hours or timezone are not configured', () => {
    expect(computeVoiceReport({ ...input, businessHours: null }).afterHoursSharePct).toBeNull();
    expect(computeVoiceReport({ ...input, timezone: null }).afterHoursSharePct).toBeNull();
    expect(computeVoiceReport({ ...input, timezone: 'Not/AZone' }).afterHoursSharePct).toBeNull();
  });
});

describe('isAfterHours / invoiceSubtotalCents', () => {
  it('holiday closes the day; closed day; boundaries', () => {
    expect(isAfterHours('2027-01-11T15:00:00Z', HOURS, ['2027-01-11'], TZ)).toBe(true);
    expect(isAfterHours('2027-01-12T14:00:00Z', HOURS, [], TZ)).toBe(false); // Tue 08:00 exactly
    expect(isAfterHours('2027-01-11T23:00:00Z', HOURS, [], TZ)).toBe(true); // Mon 17:00 exactly
    expect(isAfterHours('garbage', HOURS, [], TZ)).toBeNull();
  });
  it('rejects malformed line items', () => {
    expect(invoiceSubtotalCents([{ quantity: '2', unit_price_cents: 1 }])).toBeNull();
    expect(invoiceSubtotalCents([{ quantity: -1, unit_price_cents: 1 }])).toBeNull();
    expect(invoiceSubtotalCents(null)).toBeNull();
    expect(invoiceSubtotalCents([])).toBe(0);
    expect(invoiceSubtotalCents([{ quantity: 1.5, unit_price_cents: 333 }])).toBe(500);
  });
});

describe('monthlySummary (pricing-test export)', () => {
  const m = monthlySummary(input);
  it('groups by tenant-local month with labeled estimate = jobs x avg paid job', () => {
    expect(m.rows).toEqual([
      { month: '2027-01', callsAnswered: 3, jobsBooked: 3, estimatedCents: 63750 },
      { month: '2027-02', callsAnswered: 1, jobsBooked: 0, estimatedCents: 0 },
    ]);
  });
  it('estimate is null (not invented) when there is no paid-invoice evidence', () => {
    const none = monthlySummary({ ...input, invoices: [] });
    expect(none.rows.every((r) => r.estimatedCents === null)).toBe(true);
  });
  it('CSV rows carry the estimate label and integer cents', () => {
    const rows = monthlySummaryCsvRows(m.rows);
    expect(rows[0]).toMatchObject({ month: '2027-01', calls_answered: 3, jobs_booked: 3, estimate_label: ESTIMATE_LABEL });
    expect(Object.keys(rows[0]).join('|')).toContain('ESTIMATED');
  });
});
