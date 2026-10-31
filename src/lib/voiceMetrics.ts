/**
 * Voice AI report. Every number is computed from rows in the database (calls, jobs, invoices):
 * no LLM output, no extrapolation. Money is integer cents. Anything that cannot be computed
 * from real data is `null` (shown as "—"), never guessed.
 */

export interface VoiceCallRow {
  id: string;
  call_datetime: string;
  status: string | null;
  is_voicemail: boolean | null;
  is_emergency: boolean | null;
  duration_seconds: number | null;
  human_transfer_requested: boolean | null;
  escalated_to: string | null;
  vapi_call_id: string | null;
}
export interface VoiceJobRow { id: string; call_id: string | null }
export interface VoiceInvoiceRow { job_id: string | null; status: string; line_items: unknown }
export interface DayHours { open?: string; close?: string; closed?: boolean }
export type BusinessHours = Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', DayHours>>;

export interface VoiceReportInput {
  calls: VoiceCallRow[];
  jobs: VoiceJobRow[];
  invoices: VoiceInvoiceRow[];
  businessHours: BusinessHours | null;
  holidays: string[]; // YYYY-MM-DD
  timezone: string | null;
}

export interface VoiceReport {
  totalCalls: number;
  aiHandledCalls: number;
  answeredCalls: number;
  missedCalls: number;
  spamCalls: number;
  jobsBooked: number;
  bookedCalls: number;
  bookingRatePct: number | null;
  emergencyCalls: number;
  transfersToHuman: number;
  afterHoursCalls: number | null;
  afterHoursSharePct: number | null;
  avgHandleSeconds: number | null;
  handleTimeSamples: number;
  invoicedCents: number;
  paidCents: number;
  jobsWithPaidInvoice: number;
  avgPaidJobCents: number | null;
  malformedInvoices: number;
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const isMissed = (c: VoiceCallRow) => c.status === 'missed' || c.is_voicemail === true;
const isSpam = (c: VoiceCallRow) => c.status === 'spam';

export function invoiceSubtotalCents(lineItems: unknown): number | null {
  if (!Array.isArray(lineItems)) return null;
  let total = 0;
  for (const li of lineItems) {
    const q = (li as { quantity?: unknown })?.quantity;
    const p = (li as { unit_price_cents?: unknown })?.unit_price_cents;
    if (typeof q !== 'number' || typeof p !== 'number' || !Number.isFinite(q) || !Number.isFinite(p) || q < 0 || p < 0) return null;
    total += Math.round(q * p);
  }
  return total;
}

const minutes = (hhmm: string | undefined): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Local weekday / minutes / date for an instant in an IANA timezone; null if the timezone is invalid. */
function localParts(iso: string, tz: string): { day: (typeof DAY_KEYS)[number]; min: number; date: string } | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const day = get('weekday').slice(0, 3).toLowerCase() as (typeof DAY_KEYS)[number];
    if (!DAY_KEYS.includes(day)) return null;
    return { day, min: Number(get('hour')) * 60 + Number(get('minute')), date: `${get('year')}-${get('month')}-${get('day')}` };
  } catch {
    return null;
  }
}

/** true/false, or null when hours/timezone are not configured (never guessed). */
export function isAfterHours(iso: string, hours: BusinessHours | null, holidays: string[], tz: string | null): boolean | null {
  if (!hours || !tz) return null;
  const lp = localParts(iso, tz);
  if (!lp) return null;
  if (holidays.includes(lp.date)) return true;
  const h = hours[lp.day];
  if (!h || h.closed) return true;
  const open = minutes(h.open);
  const close = minutes(h.close);
  if (open === null || close === null) return null;
  return lp.min < open || lp.min >= close;
}

const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

export function computeVoiceReport(input: VoiceReportInput): VoiceReport {
  const calls = input.calls;
  const callIds = new Set(calls.map((c) => c.id));
  const spam = calls.filter(isSpam);
  const missed = calls.filter((c) => !isSpam(c) && isMissed(c));
  const answered = calls.filter((c) => !isSpam(c) && !isMissed(c));

  const jobs = input.jobs.filter((j) => j.call_id && callIds.has(j.call_id));
  const jobIds = new Set(jobs.map((j) => j.id));
  const bookedCallIds = new Set(jobs.map((j) => j.call_id as string));

  const ah = answered.map((c) => isAfterHours(c.call_datetime, input.businessHours, input.holidays, input.timezone));
  const configured = ah.length > 0 && ah.every((v) => v !== null);
  const afterHoursCalls = input.businessHours && input.timezone && (configured || answered.length === 0) ? ah.filter((v) => v === true).length : null;

  const durations = answered.map((c) => c.duration_seconds).filter((d): d is number => typeof d === 'number' && d > 0);

  let invoicedCents = 0;
  let paidCents = 0;
  let malformed = 0;
  const paidJobs = new Set<string>();
  for (const inv of input.invoices) {
    if (!inv.job_id || !jobIds.has(inv.job_id)) continue;
    if (inv.status !== 'sent' && inv.status !== 'viewed' && inv.status !== 'paid') continue;
    const sub = invoiceSubtotalCents(inv.line_items);
    if (sub === null) { malformed++; continue; }
    invoicedCents += sub;
    if (inv.status === 'paid') { paidCents += sub; paidJobs.add(inv.job_id); }
  }

  return {
    totalCalls: calls.length,
    aiHandledCalls: calls.filter((c) => !!c.vapi_call_id).length,
    answeredCalls: answered.length,
    missedCalls: missed.length,
    spamCalls: spam.length,
    jobsBooked: jobs.length,
    bookedCalls: bookedCallIds.size,
    bookingRatePct: pct(bookedCallIds.size, answered.length),
    emergencyCalls: calls.filter((c) => c.is_emergency === true).length,
    transfersToHuman: calls.filter((c) => c.human_transfer_requested === true || !!c.escalated_to).length,
    afterHoursCalls,
    afterHoursSharePct: afterHoursCalls === null ? null : pct(afterHoursCalls, answered.length),
    avgHandleSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    handleTimeSamples: durations.length,
    invoicedCents,
    paidCents,
    jobsWithPaidInvoice: paidJobs.size,
    avgPaidJobCents: paidJobs.size ? Math.round(paidCents / paidJobs.size) : null,
    malformedInvoices: malformed,
  };
}

// ---- Monthly pricing-test summary -----------------------------------------------------------------

export const ESTIMATE_LABEL =
  'ESTIMATE (not booked revenue): jobs booked x average paid-invoice subtotal (pre-tax) of voice-booked jobs in the selected period.';

export interface MonthlySummaryRow {
  month: string; // YYYY-MM
  callsAnswered: number;
  jobsBooked: number;
  estimatedCents: number | null;
}

export function monthlySummary(input: VoiceReportInput): { rows: MonthlySummaryRow[]; avgPaidJobCents: number | null } {
  const avg = computeVoiceReport(input).avgPaidJobCents;
  const monthOf = (iso: string): string | null => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    if (input.timezone) {
      const lp = localParts(iso, input.timezone);
      if (lp) return lp.date.slice(0, 7);
    }
    return new Date(ms).toISOString().slice(0, 7);
  };
  const byCall = new Map(input.calls.map((c) => [c.id, c]));
  const months = new Map<string, { answered: number; jobs: number }>();
  const bump = (m: string) => months.get(m) ?? (months.set(m, { answered: 0, jobs: 0 }), months.get(m)!);
  for (const c of input.calls) {
    if (isSpam(c) || isMissed(c)) continue;
    const m = monthOf(c.call_datetime);
    if (m) bump(m).answered++;
  }
  for (const j of input.jobs) {
    const c = j.call_id ? byCall.get(j.call_id) : undefined;
    const m = c ? monthOf(c.call_datetime) : null;
    if (m) bump(m).jobs++;
  }
  const rows = [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, callsAnswered: v.answered, jobsBooked: v.jobs, estimatedCents: avg === null ? null : v.jobs * avg }));
  return { rows, avgPaidJobCents: avg };
}

/** Rows for exportToCsv: header columns are fixed; the estimate column is labeled in its own header. */
export function monthlySummaryCsvRows(rows: MonthlySummaryRow[]): Array<Record<string, string | number>> {
  return rows.map((r) => ({
    month: r.month,
    calls_answered: r.callsAnswered,
    jobs_booked: r.jobsBooked,
    'ESTIMATED_value_cents (estimate, see label)': r.estimatedCents ?? '',
    estimate_label: ESTIMATE_LABEL,
  }));
}
