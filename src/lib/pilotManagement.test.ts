import { describe, expect, it } from 'vitest';
import {
  EMPTY_PILOT_FORM, METRICS, WEEKLY_CSV_COLUMNS, barWidth, buildCaseStudyMarkdown, buildMetricRows, canExport, caseStudyFilename, compareMetric,
  consentFormsEqual, consentToForm, describeAuditEntry, describeConsent, describeScope, exportBlockedReason, filterPilots, formatMoney, formatPct,
  formatWeekRange, hasBaseline, isValidIsoDate, liveDataState, maxWeeklyRevenue, numOrNull, parseConsentForm, parseDollarsToCents, parsePilotForm,
  pilotLabel, pilotToForm, summarisePilots, toCaseStudy, toPilot, toWeek, weekBookingRate, weekMissedPct,
  type CaseStudyExport, type Pilot, type PilotFormValues, type PilotWeek,
} from './pilotManagement';

const TODAY = new Date('2027-06-15T12:00:00Z');

const rawPilot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'p1', tenant_id: 't1', status: 'active', started_on: '2027-05-25', ended_on: null,
  tenant_email: 'acme@example.com', company_name: 'Acme HVAC', plan: 'professional',
  baseline_weekly_calls: 40, baseline_missed_call_pct: '35.00', baseline_booking_rate_pct: '50.00',
  baseline_avg_job_value_cents: 40000, baseline_weekly_revenue_cents: '900000', baseline_source: 'self_reported', baseline_notes: null,
  consent_status: 'not_requested', consent_scope: [], consent_evidence: null, consent_granted_at: null, notes: null,
  live_days: 21, weeks_elapsed: 3, live_weekly_calls: '45.5', live_missed_call_pct: '20.0', live_booking_rate_pct: '75.0',
  live_avg_job_value_cents: '42000', live_weekly_revenue_cents: '1200000', live_avg_call_score: '81.4',
  total_calls: 136, flagged_calls: 4, recovered_cents: '250000', recovered_count: 5, updated_at: '2027-06-14T10:00:00Z',
  ...over,
});
const pilot = (over: Record<string, unknown> = {}): Pilot => toPilot(rawPilot(over));

const week = (over: Partial<PilotWeek> = {}): PilotWeek => ({
  week_index: 1, week_start: '2027-05-25', week_end: '2027-05-31', is_complete: true, total_calls: 20, missed_calls: 4, booking_opportunities: 10,
  booked: 7, avg_call_score: 80, flagged_calls: 1, paid_jobs: 3, revenue_cents: 120000, recovered_count: 1, recovered_cents: 40000, ...over,
});

const form = (over: Partial<PilotFormValues> = {}): PilotFormValues => ({ ...EMPTY_PILOT_FORM, tenant_id: 't1', started_on: '2027-06-01', ...over });

describe('normalisers', () => {
  it('turns numeric strings into numbers and keeps nulls as null (never 0)', () => {
    const p = pilot({ baseline_missed_call_pct: null, live_booking_rate_pct: null });
    expect(p.baseline.weekly_revenue_cents).toBe(900000);
    expect(p.live.weekly_calls).toBe(45.5);
    expect(p.baseline.missed_call_pct).toBeNull();
    expect(p.live.booking_rate_pct).toBeNull();
    expect(p.live.recovered_cents).toBe(250000);
  });
  it('numOrNull rejects garbage', () => {
    expect(numOrNull('')).toBeNull();
    expect(numOrNull(undefined)).toBeNull();
    expect(numOrNull('abc')).toBeNull();
    expect(numOrNull('12.5')).toBe(12.5);
    expect(numOrNull(0)).toBe(0);
  });
  it('normalises weeks and trims timestamps to dates', () => {
    const w = toWeek({ week_index: 2, week_start: '2027-06-01T00:00:00.000Z', week_end: '2027-06-07', is_complete: true, total_calls: '5', revenue_cents: '12345', avg_call_score: null });
    expect(w.week_start).toBe('2027-06-01');
    expect(w.total_calls).toBe(5);
    expect(w.revenue_cents).toBe(12345);
    expect(w.avg_call_score).toBeNull();
  });
  it('labels pilots by company, then email', () => {
    expect(pilotLabel({ company_name: ' Acme ', tenant_email: 'a@b.co' })).toBe('Acme');
    expect(pilotLabel({ company_name: '', tenant_email: 'a@b.co' })).toBe('a@b.co');
    expect(pilotLabel({ company_name: null, tenant_email: null })).toBe('Unknown tenant');
  });
});

describe('formatting', () => {
  it('formats money, percent and missing values', () => {
    expect(formatMoney(123456)).toBe('$1,235');
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(-5000)).toBe('−$50');
    expect(formatMoney(null)).toBe('—');
    expect(formatPct(12.345)).toBe('12.3%');
    expect(formatPct(null)).toBe('—');
  });
});

describe('compareMetric', () => {
  const def = (key: string) => METRICS.find((m) => m.key === key)!;
  it('measures percent metrics in points and judges direction per metric', () => {
    expect(compareMetric(def('missed_call_pct'), 35, 20)).toMatchObject({ change: '−15.0 pts', verdict: 'better' });
    expect(compareMetric(def('missed_call_pct'), 20, 35)).toMatchObject({ change: '+15.0 pts', verdict: 'worse' });
    expect(compareMetric(def('booking_rate_pct'), 50, 75)).toMatchObject({ change: '+25.0 pts', verdict: 'better' });
    expect(compareMetric(def('booking_rate_pct'), 75, 50)).toMatchObject({ verdict: 'worse' });
  });
  it('measures money and counts as relative percent', () => {
    expect(compareMetric(def('weekly_revenue_cents'), 900000, 1200000)).toMatchObject({ change: '+33%', verdict: 'better' });
    expect(compareMetric(def('avg_job_value_cents'), 40000, 30000)).toMatchObject({ change: '−25%', verdict: 'worse' });
  });
  it('never calls call volume better or worse', () => {
    expect(compareMetric(def('weekly_calls'), 40, 30)).toMatchObject({ change: '−25%', verdict: 'neutral' });
  });
  it('treats tiny movements as flat', () => {
    expect(compareMetric(def('missed_call_pct'), 20, 20.3)).toMatchObject({ change: '0.0 pts', verdict: 'flat' });
    expect(compareMetric(def('avg_job_value_cents'), 40000, 40025)).toMatchObject({ change: '0%', verdict: 'flat' });
  });
  it('is unknown, not zero, when a side is missing', () => {
    expect(compareMetric(def('booking_rate_pct'), null, 60)).toMatchObject({ baseline: '—', change: '—', verdict: 'unknown' });
    expect(compareMetric(def('booking_rate_pct'), 60, null)).toMatchObject({ live: '—', verdict: 'unknown' });
  });
  it('handles a zero baseline without dividing by zero', () => {
    expect(compareMetric(def('weekly_revenue_cents'), 0, 5000)).toMatchObject({ change: 'from 0', verdict: 'better' });
    expect(compareMetric(def('weekly_revenue_cents'), 0, 0)).toMatchObject({ change: '0%', verdict: 'flat' });
  });
  it('builds one row per metric from a pilot', () => {
    const rows = buildMetricRows(pilot());
    expect(rows.map((r) => r.key)).toEqual(METRICS.map((m) => m.key));
    expect(rows.find((r) => r.key === 'missed_call_pct')).toMatchObject({ baseline: '35.0%', live: '20.0%', verdict: 'better' });
  });
});

describe('live data state and baseline', () => {
  it('flags not-started and early pilots', () => {
    expect(liveDataState(pilot({ live_days: 0 }))).toBe('not_started');
    expect(liveDataState(pilot({ live_days: 6 }))).toBe('early');
    expect(liveDataState(pilot({ live_days: 7 }))).toBe('ready');
  });
  it('detects a missing baseline', () => {
    const none = pilot({ baseline_weekly_calls: null, baseline_missed_call_pct: null, baseline_booking_rate_pct: null, baseline_avg_job_value_cents: null, baseline_weekly_revenue_cents: null });
    expect(hasBaseline(none)).toBe(false);
    expect(hasBaseline(pilot())).toBe(true);
  });
});

describe('weekly helpers', () => {
  it('computes per-week rates and null without a denominator', () => {
    expect(weekMissedPct(week())).toBe(20);
    expect(weekBookingRate(week())).toBe(70);
    expect(weekMissedPct(week({ total_calls: 0, missed_calls: 0 }))).toBeNull();
    expect(weekBookingRate(week({ booking_opportunities: 0, booked: 0 }))).toBeNull();
  });
  it('sizes revenue bars', () => {
    expect(maxWeeklyRevenue([week({ revenue_cents: 5 }), week({ revenue_cents: 50 })])).toBe(50);
    expect(barWidth(50, 100)).toBe(50);
    expect(barWidth(0, 100)).toBe(0);
    expect(barWidth(1, 1000)).toBe(2); // visible sliver
    expect(barWidth(10, 0)).toBe(0);
    expect(barWidth(500, 100)).toBe(100);
  });
  it('formats week ranges in UTC', () => {
    expect(formatWeekRange({ week_start: '2027-05-25', week_end: '2027-05-31' })).toBe('May 25 – May 31');
  });
});

describe('portfolio summary and filters', () => {
  const list = [
    pilot({ id: 'a', status: 'active', flagged_calls: 3, recovered_cents: 1000, consent_status: 'granted', consent_scope: ['metrics'] }),
    pilot({ id: 'b', status: 'completed', flagged_calls: 9, recovered_cents: 500, company_name: 'Beta Plumbing', tenant_email: 'b@x.com', consent_status: 'granted', consent_scope: ['company_name'] }),
    pilot({ id: 'c', status: 'onboarding', flagged_calls: 1, recovered_cents: 0, company_name: null, tenant_email: 'c@x.com' }),
  ];
  it('summarises only what is open for flagged calls, and counts export-ready honestly', () => {
    expect(summarisePilots(list)).toEqual({ active: 1, total: 3, recovered_cents: 1500, flagged_calls: 4, consent_granted: 2, export_ready: 1 });
  });
  it('filters by status and by company or email', () => {
    expect(filterPilots(list, 'all', '').length).toBe(3);
    expect(filterPilots(list, 'completed', '').map((p) => p.id)).toEqual(['b']);
    expect(filterPilots(list, 'all', ' BETA ').map((p) => p.id)).toEqual(['b']);
    expect(filterPilots(list, 'all', 'c@x').map((p) => p.id)).toEqual(['c']);
    expect(filterPilots(list, 'active', 'beta')).toEqual([]);
  });
});

describe('consent rules', () => {
  it('only allows export when granted AND metrics are in scope', () => {
    expect(canExport(pilot({ consent_status: 'granted', consent_scope: ['metrics'] }))).toBe(true);
    expect(canExport(pilot({ consent_status: 'granted', consent_scope: ['company_name'] }))).toBe(false);
    for (const s of ['not_requested', 'requested', 'declined', 'revoked']) expect(canExport(pilot({ consent_status: s, consent_scope: ['metrics'] }))).toBe(false);
  });
  it('explains why export is blocked', () => {
    expect(exportBlockedReason(pilot({ consent_status: 'granted', consent_scope: ['metrics'] }))).toBeNull();
    expect(exportBlockedReason(pilot({ consent_status: 'granted', consent_scope: ['logo'] }))).toMatch(/Share metrics/);
    expect(exportBlockedReason(pilot({ consent_status: 'revoked' }))).toMatch(/revoked/);
    expect(exportBlockedReason(pilot({ consent_status: 'declined' }))).toMatch(/declined/);
    expect(exportBlockedReason(pilot())).toMatch(/Record the customer/);
  });
  it('describes consent and scope', () => {
    expect(describeConsent('granted')).toEqual({ label: 'Consent granted', tone: 'success' });
    expect(describeConsent('revoked').tone).toBe('danger');
    expect(describeScope([])).toBe('No scope recorded');
    expect(describeScope(['metrics', 'company_name'])).toBe('Use company name, Share metrics');
  });
  it('requires scope and evidence when granting', () => {
    const r = parseConsentForm({ status: 'granted', scope: [], evidence: '  ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['evidence', 'scope']);
  });
  it('accepts a complete grant and normalises it', () => {
    const r = parseConsentForm({ status: 'granted', scope: ['metrics', 'company_name', 'metrics'], evidence: ' Email 12 Jun ' });
    expect(r).toEqual({ ok: true, value: { consent_status: 'granted', consent_scope: ['company_name', 'metrics'], consent_evidence: 'Email 12 Jun' } });
  });
  it('lets non-grant statuses save without evidence, and caps evidence length', () => {
    expect(parseConsentForm({ status: 'declined', scope: [], evidence: '' })).toEqual({ ok: true, value: { consent_status: 'declined', consent_scope: [], consent_evidence: null } });
    expect(parseConsentForm({ status: 'requested', scope: [], evidence: 'x'.repeat(501) }).ok).toBe(false);
  });
  it('compares consent forms ignoring order and edge whitespace', () => {
    const base = { status: 'granted' as const, scope: ['metrics' as const, 'logo' as const], evidence: 'a' };
    expect(consentFormsEqual(base, { ...base, scope: ['logo', 'metrics'], evidence: ' a ' })).toBe(true);
    expect(consentFormsEqual(base, { ...base, scope: ['metrics'] })).toBe(false);
    expect(consentFormsEqual(base, { ...base, status: 'revoked' })).toBe(false);
  });
});

describe('parseDollarsToCents and dates', () => {
  it('parses dollars to integer cents', () => {
    expect(parseDollarsToCents('450')).toBe(45000);
    expect(parseDollarsToCents('$1,234.50')).toBe(123450);
    expect(parseDollarsToCents('0.1')).toBe(10);
    expect(parseDollarsToCents('19.99')).toBe(1999);
    expect(parseDollarsToCents('  ')).toBeNull();
  });
  it('rejects bad money', () => {
    for (const bad of ['-5', '1.234', 'abc', '1e3', '12,,', '1,2,3', '12,34', '1000000000']) expect(parseDollarsToCents(bad)).toBeUndefined();
  });
  it('validates real calendar dates', () => {
    expect(isValidIsoDate('2027-02-28')).toBe(true);
    expect(isValidIsoDate('2027-02-30')).toBe(false);
    expect(isValidIsoDate('2027-2-3')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
  });
});

describe('parsePilotForm', () => {
  it('accepts a minimal pilot (no baseline) and nulls the empty fields', () => {
    const r = parsePilotForm(form(), 'create', TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ tenant_id: 't1', started_on: '2027-06-01', status: 'onboarding', baseline_weekly_calls: null, baseline_avg_job_value_cents: null, baseline_notes: null, notes: null });
  });
  it('converts dollars to cents and keeps percents as entered', () => {
    const r = parsePilotForm(form({ baseline_weekly_calls: '40', baseline_missed_call_pct: '35.5', baseline_booking_rate_pct: '50', baseline_avg_job_value: '$400.25', baseline_weekly_revenue: '9,000' }), 'create', TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ baseline_weekly_calls: 40, baseline_missed_call_pct: 35.5, baseline_booking_rate_pct: 50, baseline_avg_job_value_cents: 40025, baseline_weekly_revenue_cents: 900000 });
  });
  it('requires a tenant only when creating, and never sends it when editing', () => {
    expect(parsePilotForm(form({ tenant_id: '' }), 'create', TODAY).ok).toBe(false);
    const r = parsePilotForm(form({ tenant_id: '' }), 'edit', TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) expect('tenant_id' in r.value).toBe(false);
    const withTenant = parsePilotForm(form({ tenant_id: 't9' }), 'edit', TODAY);
    if (withTenant.ok) expect('tenant_id' in withTenant.value).toBe(false);
  });
  it('rejects bad dates and out-of-range starts', () => {
    expect(parsePilotForm(form({ started_on: '' }), 'create', TODAY).ok).toBe(false);
    expect(parsePilotForm(form({ started_on: '2027-02-30' }), 'create', TODAY).ok).toBe(false);
    expect(parsePilotForm(form({ started_on: '2023-12-31' }), 'create', TODAY).ok).toBe(false);
    expect(parsePilotForm(form({ started_on: '2029-01-01' }), 'create', TODAY).ok).toBe(false);
    expect(parsePilotForm(form({ started_on: '2027-06-20' }), 'create', TODAY).ok).toBe(true); // a pilot may be scheduled ahead
  });
  it('rejects out-of-range baseline values with field-level errors', () => {
    const r = parsePilotForm(form({ baseline_weekly_calls: '12.5', baseline_missed_call_pct: '101', baseline_booking_rate_pct: '-1', baseline_avg_job_value: 'abc', baseline_weekly_revenue: '1.234' }), 'create', TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['baseline_avg_job_value', 'baseline_booking_rate_pct', 'baseline_missed_call_pct', 'baseline_weekly_calls', 'baseline_weekly_revenue']);
  });
  it('rejects percentages with more than two decimals and over-long notes', () => {
    expect(parsePilotForm(form({ baseline_missed_call_pct: '12.345' }), 'create', TODAY).ok).toBe(false);
    expect(parsePilotForm(form({ baseline_notes: 'x'.repeat(1001) }), 'create', TODAY).ok).toBe(false);
    expect(parsePilotForm(form({ notes: 'x'.repeat(2001) }), 'create', TODAY).ok).toBe(false);
  });
  it('round-trips a saved pilot through the edit form', () => {
    const f = pilotToForm(pilot());
    expect(f).toMatchObject({ baseline_avg_job_value: '400', baseline_weekly_revenue: '9000', baseline_missed_call_pct: '35', started_on: '2027-05-25' });
    const r = parsePilotForm(f, 'edit', TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ baseline_avg_job_value_cents: 40000, baseline_weekly_revenue_cents: 900000 });
  });
  it('consentToForm copies the scope (no shared reference)', () => {
    const p = pilot({ consent_status: 'granted', consent_scope: ['metrics'], consent_evidence: 'e' });
    const c = consentToForm(p);
    c.scope.push('logo');
    expect(p.consent.scope).toEqual(['metrics']);
  });
});

describe('describeAuditEntry', () => {
  it('describes each action in one line', () => {
    expect(describeAuditEntry({ action: 'create', changes: null })).toBe('Pilot created');
    expect(describeAuditEntry({ action: 'delete', changes: null })).toBe('Pilot deleted');
    expect(describeAuditEntry({ action: 'export', changes: { format: 'csv', named: false } })).toBe('Case study exported (csv, anonymised)');
    expect(describeAuditEntry({ action: 'export', changes: { format: 'markdown', named: true } })).toBe('Case study exported (markdown, with company name)');
    expect(describeAuditEntry({ action: 'update', changes: { consent_status: { from: 'requested', to: 'granted' }, consent_scope: {} } })).toBe('Consent set to granted');
    expect(describeAuditEntry({ action: 'update', changes: { status: {}, baseline_notes: {} } })).toBe('Updated status, baseline notes');
    expect(describeAuditEntry({ action: 'update', changes: null })).toBe('Updated');
  });
});

describe('case study export', () => {
  const exportFixture = (over: Partial<CaseStudyExport> = {}): CaseStudyExport => ({
    generated_at: '2027-06-15T09:00:00Z', customer_name: 'Acme HVAC',
    pilot: { status: 'active', started_on: '2027-05-25', ended_on: null, weeks_elapsed: 3, live_days: 21 },
    baseline: { weekly_calls: 40, missed_call_pct: 35, booking_rate_pct: 50, avg_job_value_cents: 40000, weekly_revenue_cents: 900000, source: 'self_reported' },
    live: { weekly_calls: 45.5, missed_call_pct: 20, booking_rate_pct: 75, avg_job_value_cents: 42000, weekly_revenue_cents: 1200000, avg_call_score: 81, total_calls: 136, recovered_cents: 250000, recovered_count: 5 },
    weekly: [week({ week_index: 1 }), week({ week_index: 2, week_start: '2027-06-01', week_end: '2027-06-07', total_calls: 0, missed_calls: 0, booking_opportunities: 0, booked: 0 }), week({ week_index: 3, week_start: '2027-06-08', week_end: '2027-06-14', is_complete: false })],
    consent: { scope: ['company_name', 'metrics'], granted_at: '2027-06-12T08:00:00Z', evidence: 'Email from owner, 12 Jun' },
    ...over,
  });

  it('builds a markdown brief with headline, weekly table, method and an internal consent note', () => {
    const md = buildCaseStudyMarkdown(exportFixture());
    expect(md).toContain('# Acme HVAC: pilot results');
    expect(md).toContain('| Missed calls | 35.0% | 20.0% | −15.0 pts |');
    expect(md).toContain('| Booking rate | 50.0% | 75.0% | +25.0 pts |');
    expect(md).toContain('last 21 days');
    expect(md).toContain('**Revenue recovered:** $2,500 from 5 opportunities');
    expect(md).toContain('| 3 (in progress) |');
    expect(md).toContain('self-reported by the customer');
    expect(md).toContain('The pilot is still running');
    expect(md).toContain('<!-- INTERNAL. Remove before publishing.');
    expect(md).toContain('Evidence: Email from owner, 12 Jun');
  });
  it('shows a dash, not 0%, for a week with no calls', () => {
    const md = buildCaseStudyMarkdown(exportFixture());
    const row = md.split('\n').find((l) => l.startsWith('| 2 |'))!;
    expect(row).toContain('| 0 | — | — |');
  });
  it('is anonymous without a name and does not claim the pilot is running once ended', () => {
    const md = buildCaseStudyMarkdown(exportFixture({ customer_name: null, pilot: { status: 'completed', started_on: '2027-05-25', ended_on: '2027-06-14', weeks_elapsed: 3, live_days: 21 } }));
    expect(md).toContain('# Anonymous pilot customer: pilot results');
    expect(md).not.toContain('Acme');
    expect(md).not.toContain('still running');
    expect(md).toContain('2027-05-25 to 2027-06-14');
  });
  it('cannot be broken by pipes, newlines or an HTML-comment terminator in text fields', () => {
    const md = buildCaseStudyMarkdown(exportFixture({ customer_name: 'A|B\nCo', consent: { scope: ['metrics'], granted_at: null, evidence: 'x --> <script>\nmore' } }));
    expect(md).toContain('# A\\|B Co: pilot results');
    const internal = md.slice(md.indexOf('<!-- INTERNAL'));
    expect(internal.match(/-->/g)).toHaveLength(1); // only the real terminator
    expect(internal).toContain('Consent recorded: unknown');
  });
  it('singularises one week and one opportunity', () => {
    const md = buildCaseStudyMarkdown(exportFixture({ pilot: { status: 'active', started_on: '2027-06-08', ended_on: null, weeks_elapsed: 1, live_days: 7 }, live: { ...exportFixture().live, recovered_count: 1 } }));
    expect(md).toContain('· 1 week ·');
    expect(md).toContain('from 1 opportunity ');
  });
  it('handles an empty weekly series', () => {
    expect(buildCaseStudyMarkdown(exportFixture({ weekly: [] }))).toContain('No weekly data yet.');
  });
  it('builds safe filenames', () => {
    expect(caseStudyFilename({ customer_name: 'Acme & Sons, HVAC!', generated_at: '2027-06-15T09:00:00Z' }, 'md')).toBe('case-study-acme-sons-hvac-2027-06-15.md');
    expect(caseStudyFilename({ customer_name: null, generated_at: '2027-06-15T09:00:00Z' }, 'csv')).toBe('case-study-pilot-2027-06-15.csv');
    expect(caseStudyFilename({ customer_name: '!!!', generated_at: '2027-06-15T09:00:00Z' }, 'json')).toBe('case-study-pilot-2027-06-15.json');
  });
  it('maps weekly rows to CSV columns in dollars with rounded rates', () => {
    const cells = Object.fromEntries(WEEKLY_CSV_COLUMNS.map((c) => [c.header, c.accessor(week())]));
    expect(cells).toMatchObject({ Week: 1, Complete: 'yes', Calls: 20, 'Missed %': 20, 'Booking rate %': 70, 'Revenue USD': 1200, 'Recovered USD': 400 });
    const empty = Object.fromEntries(WEEKLY_CSV_COLUMNS.map((c) => [c.header, c.accessor(week({ total_calls: 0, missed_calls: 0, booking_opportunities: 0, booked: 0, avg_call_score: null }))]));
    expect(empty['Missed %']).toBeNull();
    expect(empty['Booking rate %']).toBeNull();
  });
  it('normalises the RPC payload', () => {
    const x = toCaseStudy({
      generated_at: '2027-06-15T09:00:00Z', customer_name: null,
      pilot: { status: 'active', started_on: '2027-05-25', ended_on: null, weeks_elapsed: 3, live_days: 21 },
      baseline: { weekly_calls: 40, missed_call_pct: '35.00', source: 'estimated' },
      live: { weekly_calls: '45.5', recovered_cents: '250000', recovered_count: 5, total_calls: 10 },
      weekly: [{ week_index: 1, week_start: '2027-05-25', week_end: '2027-05-31', is_complete: true }],
      consent: { scope: ['metrics'], granted_at: null, evidence: null },
    });
    expect(x.baseline).toMatchObject({ missed_call_pct: 35, booking_rate_pct: null, source: 'estimated' });
    expect(x.live).toMatchObject({ weekly_calls: 45.5, recovered_cents: 250000, avg_call_score: null });
    expect(x.weekly).toHaveLength(1);
    expect(toCaseStudy({}).weekly).toEqual([]);
  });
});
