// Pure pilot-management logic: types, normalisers, baseline-vs-live comparison,
// form parsing, consent rules and case-study export builders. No React and no
// network here, so everything is unit-tested in pilotManagement.test.ts.
// Data access lives in pilotManagementApi.ts; the staff UI in
// pages/admin/PilotManagementPage.tsx and components/staff/Pilot*.tsx.
//
// The metric definitions (what counts as "missed", "booked", "revenue", the
// week buckets and the quality flags) are defined once, in the SQL migration
// 20270610000000_pilot_management.sql. This file only presents them.

export type PilotStatus = 'onboarding' | 'active' | 'completed' | 'churned';
export type ConsentStatus = 'not_requested' | 'requested' | 'granted' | 'declined' | 'revoked';
export type ConsentScope = 'company_name' | 'metrics' | 'quote' | 'logo';
export type BaselineSource = 'self_reported' | 'pre_pilot_data' | 'estimated';
export type CallFlag = 'low_score' | 'negative_sentiment' | 'price_mismatch' | 'emergency_not_booked' | 'objection_unresolved';
export type ExportFormat = 'markdown' | 'csv' | 'json';

export const PILOT_STATUSES: readonly PilotStatus[] = ['onboarding', 'active', 'completed', 'churned'];
export const CONSENT_STATUSES: readonly ConsentStatus[] = ['not_requested', 'requested', 'granted', 'declined', 'revoked'];
export const CONSENT_SCOPES: readonly ConsentScope[] = ['company_name', 'metrics', 'quote', 'logo'];
export const BASELINE_SOURCES: readonly BaselineSource[] = ['self_reported', 'pre_pilot_data', 'estimated'];

export const PILOT_STATUS_LABEL: Record<PilotStatus, string> = {
  onboarding: 'Onboarding', active: 'Active', completed: 'Completed', churned: 'Churned',
};
export const CONSENT_STATUS_LABEL: Record<ConsentStatus, string> = {
  not_requested: 'Consent not requested', requested: 'Consent requested', granted: 'Consent granted', declined: 'Consent declined', revoked: 'Consent revoked',
};
export const CONSENT_SCOPE_LABEL: Record<ConsentScope, string> = {
  company_name: 'Use company name', metrics: 'Share metrics', quote: 'Use a quote', logo: 'Use logo',
};
export const BASELINE_SOURCE_LABEL: Record<BaselineSource, string> = {
  self_reported: 'Self-reported by the customer', pre_pilot_data: 'Measured from pre-pilot data', estimated: 'Estimated by Vireek',
};
export const CALL_FLAG_LABEL: Record<CallFlag, string> = {
  low_score: 'Low call score', negative_sentiment: 'Negative sentiment', price_mismatch: 'Price mismatch',
  emergency_not_booked: 'Emergency not booked', objection_unresolved: 'Objection unresolved',
};

/** Flags that can cost the customer money or trust right now. */
export const HIGH_SEVERITY_FLAGS: readonly CallFlag[] = ['price_mismatch', 'emergency_not_booked'];

// ---------------------------------------------------------------------------
// Row types (what the RPCs return, after normalisation)
// ---------------------------------------------------------------------------

export interface Pilot {
  id: string;
  tenant_id: string;
  status: PilotStatus;
  started_on: string;
  ended_on: string | null;
  tenant_email: string | null;
  company_name: string | null;
  plan: string | null;
  baseline: {
    weekly_calls: number | null;
    missed_call_pct: number | null;
    booking_rate_pct: number | null;
    avg_job_value_cents: number | null;
    weekly_revenue_cents: number | null;
    source: BaselineSource;
    notes: string | null;
  };
  consent: {
    status: ConsentStatus;
    scope: ConsentScope[];
    evidence: string | null;
    granted_at: string | null;
  };
  notes: string | null;
  live: {
    days: number;
    weeks_elapsed: number;
    weekly_calls: number | null;
    missed_call_pct: number | null;
    booking_rate_pct: number | null;
    avg_job_value_cents: number | null;
    weekly_revenue_cents: number | null;
    avg_call_score: number | null;
    total_calls: number;
    flagged_calls: number;
    recovered_cents: number;
    recovered_count: number;
  };
  updated_at: string;
}

export interface PilotWeek {
  week_index: number;
  week_start: string;
  week_end: string;
  is_complete: boolean;
  total_calls: number;
  missed_calls: number;
  booking_opportunities: number;
  booked: number;
  avg_call_score: number | null;
  flagged_calls: number;
  paid_jobs: number;
  revenue_cents: number;
  recovered_count: number;
  recovered_cents: number;
}

export interface FlaggedCall {
  call_id: string;
  call_datetime: string;
  duration_seconds: number | null;
  call_score: number | null;
  sentiment: string | null;
  intent: string | null;
  booking_outcome: string | null;
  flags: CallFlag[];
}

export interface PilotAuditEntry {
  id: number;
  action: 'create' | 'update' | 'delete' | 'export';
  changes: Record<string, unknown> | null;
  created_at: string;
  actor_email: string | null;
}

export interface CaseStudyExport {
  generated_at: string;
  customer_name: string | null;
  pilot: { status: PilotStatus; started_on: string; ended_on: string | null; weeks_elapsed: number; live_days: number };
  baseline: {
    weekly_calls: number | null; missed_call_pct: number | null; booking_rate_pct: number | null;
    avg_job_value_cents: number | null; weekly_revenue_cents: number | null; source: BaselineSource;
  };
  live: {
    weekly_calls: number | null; missed_call_pct: number | null; booking_rate_pct: number | null;
    avg_job_value_cents: number | null; weekly_revenue_cents: number | null; avg_call_score: number | null;
    total_calls: number; recovered_cents: number; recovered_count: number;
  };
  weekly: PilotWeek[];
  consent: { scope: ConsentScope[]; granted_at: string | null; evidence: string | null };
}

// ---------------------------------------------------------------------------
// Normalisers: RPC JSON -> typed rows. numeric/bigint may arrive as strings.
// ---------------------------------------------------------------------------

/** number | numeric-string | null -> number | null (never NaN). */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
const num = (v: unknown): number => numOrNull(v) ?? 0;

type Raw = Record<string, unknown>;

export function toPilot(r: Raw): Pilot {
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    status: r.status as PilotStatus,
    started_on: String(r.started_on),
    ended_on: (r.ended_on as string | null) ?? null,
    tenant_email: (r.tenant_email as string | null) ?? null,
    company_name: (r.company_name as string | null) ?? null,
    plan: (r.plan as string | null) ?? null,
    baseline: {
      weekly_calls: numOrNull(r.baseline_weekly_calls),
      missed_call_pct: numOrNull(r.baseline_missed_call_pct),
      booking_rate_pct: numOrNull(r.baseline_booking_rate_pct),
      avg_job_value_cents: numOrNull(r.baseline_avg_job_value_cents),
      weekly_revenue_cents: numOrNull(r.baseline_weekly_revenue_cents),
      source: (r.baseline_source as BaselineSource) ?? 'self_reported',
      notes: (r.baseline_notes as string | null) ?? null,
    },
    consent: {
      status: (r.consent_status as ConsentStatus) ?? 'not_requested',
      scope: Array.isArray(r.consent_scope) ? (r.consent_scope as ConsentScope[]) : [],
      evidence: (r.consent_evidence as string | null) ?? null,
      granted_at: (r.consent_granted_at as string | null) ?? null,
    },
    notes: (r.notes as string | null) ?? null,
    live: {
      days: num(r.live_days),
      weeks_elapsed: num(r.weeks_elapsed),
      weekly_calls: numOrNull(r.live_weekly_calls),
      missed_call_pct: numOrNull(r.live_missed_call_pct),
      booking_rate_pct: numOrNull(r.live_booking_rate_pct),
      avg_job_value_cents: numOrNull(r.live_avg_job_value_cents),
      weekly_revenue_cents: numOrNull(r.live_weekly_revenue_cents),
      avg_call_score: numOrNull(r.live_avg_call_score),
      total_calls: num(r.total_calls),
      flagged_calls: num(r.flagged_calls),
      recovered_cents: num(r.recovered_cents),
      recovered_count: num(r.recovered_count),
    },
    updated_at: String(r.updated_at),
  };
}

export function toWeek(r: Raw): PilotWeek {
  return {
    week_index: num(r.week_index),
    week_start: String(r.week_start).slice(0, 10),
    week_end: String(r.week_end).slice(0, 10),
    is_complete: Boolean(r.is_complete),
    total_calls: num(r.total_calls),
    missed_calls: num(r.missed_calls),
    booking_opportunities: num(r.booking_opportunities),
    booked: num(r.booked),
    avg_call_score: numOrNull(r.avg_call_score),
    flagged_calls: num(r.flagged_calls),
    paid_jobs: num(r.paid_jobs),
    revenue_cents: num(r.revenue_cents),
    recovered_count: num(r.recovered_count),
    recovered_cents: num(r.recovered_cents),
  };
}

export function toFlaggedCall(r: Raw): FlaggedCall {
  return {
    call_id: String(r.call_id),
    call_datetime: String(r.call_datetime),
    duration_seconds: numOrNull(r.duration_seconds),
    call_score: numOrNull(r.call_score),
    sentiment: (r.sentiment as string | null) ?? null,
    intent: (r.intent as string | null) ?? null,
    booking_outcome: (r.booking_outcome as string | null) ?? null,
    flags: Array.isArray(r.flags) ? (r.flags as CallFlag[]) : [],
  };
}

export function toCaseStudy(raw: Raw): CaseStudyExport {
  const b = (raw.baseline ?? {}) as Raw;
  const l = (raw.live ?? {}) as Raw;
  const p = (raw.pilot ?? {}) as Raw;
  const c = (raw.consent ?? {}) as Raw;
  return {
    generated_at: String(raw.generated_at),
    customer_name: (raw.customer_name as string | null) ?? null,
    pilot: {
      status: p.status as PilotStatus,
      started_on: String(p.started_on),
      ended_on: (p.ended_on as string | null) ?? null,
      weeks_elapsed: num(p.weeks_elapsed),
      live_days: num(p.live_days),
    },
    baseline: {
      weekly_calls: numOrNull(b.weekly_calls),
      missed_call_pct: numOrNull(b.missed_call_pct),
      booking_rate_pct: numOrNull(b.booking_rate_pct),
      avg_job_value_cents: numOrNull(b.avg_job_value_cents),
      weekly_revenue_cents: numOrNull(b.weekly_revenue_cents),
      source: (b.source as BaselineSource) ?? 'self_reported',
    },
    live: {
      weekly_calls: numOrNull(l.weekly_calls),
      missed_call_pct: numOrNull(l.missed_call_pct),
      booking_rate_pct: numOrNull(l.booking_rate_pct),
      avg_job_value_cents: numOrNull(l.avg_job_value_cents),
      weekly_revenue_cents: numOrNull(l.weekly_revenue_cents),
      avg_call_score: numOrNull(l.avg_call_score),
      total_calls: num(l.total_calls),
      recovered_cents: num(l.recovered_cents),
      recovered_count: num(l.recovered_count),
    },
    weekly: Array.isArray(raw.weekly) ? (raw.weekly as Raw[]).map(toWeek) : [],
    consent: {
      scope: Array.isArray(c.scope) ? (c.scope as ConsentScope[]) : [],
      granted_at: (c.granted_at as string | null) ?? null,
      evidence: (c.evidence as string | null) ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MINUS = '−';
const DASH = '—';

export function formatMoney(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return DASH;
  const dollars = Math.round(cents) / 100;
  const abs = Math.abs(dollars).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `${dollars < 0 ? MINUS : ''}$${abs}`;
}

export function formatPct(v: number | null): string {
  return v === null || !Number.isFinite(v) ? DASH : `${v.toFixed(1)}%`;
}

export function formatCount(v: number | null): string {
  return v === null || !Number.isFinite(v) ? DASH : v.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

export function pilotLabel(p: Pick<Pilot, 'company_name' | 'tenant_email'>): string {
  return p.company_name?.trim() || p.tenant_email || 'Unknown tenant';
}

// ---------------------------------------------------------------------------
// Baseline vs live
// ---------------------------------------------------------------------------

export type MetricKey = 'weekly_calls' | 'missed_call_pct' | 'booking_rate_pct' | 'avg_job_value_cents' | 'weekly_revenue_cents';
export type Verdict = 'better' | 'worse' | 'flat' | 'neutral' | 'unknown';

interface MetricDef { key: MetricKey; label: string; kind: 'count' | 'pct' | 'money'; better: 'higher' | 'lower' | 'neutral' }

export const METRICS: readonly MetricDef[] = [
  { key: 'weekly_calls', label: 'Calls per week', kind: 'count', better: 'neutral' },
  { key: 'missed_call_pct', label: 'Missed calls', kind: 'pct', better: 'lower' },
  { key: 'booking_rate_pct', label: 'Booking rate', kind: 'pct', better: 'higher' },
  { key: 'avg_job_value_cents', label: 'Average job value', kind: 'money', better: 'higher' },
  { key: 'weekly_revenue_cents', label: 'Revenue per week', kind: 'money', better: 'higher' },
];

export interface MetricComparison {
  key: MetricKey;
  label: string;
  baseline: string;
  live: string;
  change: string;
  verdict: Verdict;
}

function formatValue(kind: MetricDef['kind'], v: number | null): string {
  return kind === 'pct' ? formatPct(v) : kind === 'money' ? formatMoney(v) : formatCount(v);
}

/**
 * Compares one metric. Percent metrics change in percentage POINTS (50% -> 60%
 * is +10.0 pts); counts and money change in relative percent. A missing side,
 * or a relative change from a zero baseline, is "unknown": never a made-up 0.
 */
export function compareMetric(def: MetricDef, baseline: number | null, live: number | null): MetricComparison {
  const base = { key: def.key, label: def.label, baseline: formatValue(def.kind, baseline), live: formatValue(def.kind, live) };
  if (baseline === null || live === null) return { ...base, change: DASH, verdict: 'unknown' };

  let delta: number;
  let change: string;
  const sign = (n: number) => (n > 0 ? '+' : n < 0 ? MINUS : '');
  if (def.kind === 'pct') {
    delta = live - baseline;
    change = `${sign(delta)}${Math.abs(delta).toFixed(1)} pts`;
    if (Math.abs(delta) < 0.5) return { ...base, change: '0.0 pts', verdict: def.better === 'neutral' ? 'neutral' : 'flat' };
  } else {
    if (baseline === 0) {
      return { ...base, change: live === 0 ? '0%' : 'from 0', verdict: live === 0 ? (def.better === 'neutral' ? 'neutral' : 'flat') : verdictFor(def, 1) };
    }
    delta = ((live - baseline) / baseline) * 100;
    change = `${sign(delta)}${Math.abs(delta).toFixed(0)}%`;
    if (Math.abs(delta) < 1) return { ...base, change: '0%', verdict: def.better === 'neutral' ? 'neutral' : 'flat' };
  }
  return { ...base, change, verdict: verdictFor(def, delta) };
}

function verdictFor(def: MetricDef, delta: number): Verdict {
  if (def.better === 'neutral') return 'neutral';
  const improved = def.better === 'higher' ? delta > 0 : delta < 0;
  return improved ? 'better' : 'worse';
}

export function buildMetricRows(p: Pick<Pilot, 'baseline' | 'live'>): MetricComparison[] {
  return METRICS.map((def) => compareMetric(def, p.baseline[def.key], p.live[def.key]));
}

export type LiveDataState = 'not_started' | 'early' | 'ready';

/** Fewer than 7 live days is too little to compare against a weekly baseline. */
export function liveDataState(p: Pick<Pilot, 'live'>): LiveDataState {
  if (p.live.days <= 0) return 'not_started';
  return p.live.days < 7 ? 'early' : 'ready';
}

export function hasBaseline(p: Pick<Pilot, 'baseline'>): boolean {
  const b = p.baseline;
  return [b.weekly_calls, b.missed_call_pct, b.booking_rate_pct, b.avg_job_value_cents, b.weekly_revenue_cents].some((v) => v !== null);
}

// ---------------------------------------------------------------------------
// Weekly trend helpers
// ---------------------------------------------------------------------------

export const weekMissedPct = (w: PilotWeek): number | null => (w.total_calls > 0 ? (w.missed_calls / w.total_calls) * 100 : null);
export const weekBookingRate = (w: PilotWeek): number | null => (w.booking_opportunities > 0 ? (w.booked / w.booking_opportunities) * 100 : null);

export function formatWeekRange(w: Pick<PilotWeek, 'week_start' | 'week_end'>): string {
  const fmt = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  return `${fmt(w.week_start)} – ${fmt(w.week_end)}`;
}

export function maxWeeklyRevenue(weeks: PilotWeek[]): number {
  return weeks.reduce((m, w) => Math.max(m, w.revenue_cents), 0);
}

/** Bar width in percent (0-100) for a revenue cell. */
export function barWidth(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.max(2, Math.min(100, Math.round((value / max) * 100)));
}

// ---------------------------------------------------------------------------
// Portfolio summary (the tiles above the list)
// ---------------------------------------------------------------------------

export interface PortfolioSummary {
  active: number;
  total: number;
  recovered_cents: number;
  flagged_calls: number;
  consent_granted: number;
  export_ready: number;
}

export function summarisePilots(pilots: Pilot[]): PortfolioSummary {
  return {
    active: pilots.filter((p) => p.status === 'active').length,
    total: pilots.length,
    recovered_cents: pilots.reduce((s, p) => s + p.live.recovered_cents, 0),
    flagged_calls: pilots.filter((p) => p.status === 'active' || p.status === 'onboarding').reduce((s, p) => s + p.live.flagged_calls, 0),
    consent_granted: pilots.filter((p) => p.consent.status === 'granted').length,
    export_ready: pilots.filter(canExport).length,
  };
}

export function filterPilots(pilots: Pilot[], status: PilotStatus | 'all', query: string): Pilot[] {
  const q = query.trim().toLowerCase();
  return pilots.filter((p) => {
    if (status !== 'all' && p.status !== status) return false;
    if (!q) return true;
    return (p.company_name ?? '').toLowerCase().includes(q) || (p.tenant_email ?? '').toLowerCase().includes(q);
  });
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

export function describeConsent(status: ConsentStatus): { label: string; tone: Tone } {
  switch (status) {
    case 'granted': return { label: CONSENT_STATUS_LABEL.granted, tone: 'success' };
    case 'requested': return { label: CONSENT_STATUS_LABEL.requested, tone: 'info' };
    case 'declined': return { label: CONSENT_STATUS_LABEL.declined, tone: 'danger' };
    case 'revoked': return { label: CONSENT_STATUS_LABEL.revoked, tone: 'danger' };
    default: return { label: CONSENT_STATUS_LABEL.not_requested, tone: 'neutral' };
  }
}

/** Mirrors the server rule in staff_export_pilot_case_study. The server is the authority. */
export function canExport(p: Pick<Pilot, 'consent'>): boolean {
  return p.consent.status === 'granted' && p.consent.scope.includes('metrics');
}

export function exportBlockedReason(p: Pick<Pilot, 'consent'>): string | null {
  if (canExport(p)) return null;
  if (p.consent.status === 'granted') return 'Consent is recorded but does not include sharing metrics. Add “Share metrics” to the scope.';
  if (p.consent.status === 'revoked') return 'The customer revoked consent. Case-study export is disabled.';
  if (p.consent.status === 'declined') return 'The customer declined. Case-study export is disabled.';
  return 'Record the customer’s consent before exporting a case study.';
}

export function describeScope(scope: ConsentScope[]): string {
  return scope.length ? CONSENT_SCOPES.filter((s) => scope.includes(s)).map((s) => CONSENT_SCOPE_LABEL[s]).join(', ') : 'No scope recorded';
}

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

export type FieldErrors = Record<string, string>;
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

export interface PilotFormValues {
  tenant_id: string;
  started_on: string;
  status: PilotStatus;
  baseline_weekly_calls: string;
  baseline_missed_call_pct: string;
  baseline_booking_rate_pct: string;
  baseline_avg_job_value: string; // dollars
  baseline_weekly_revenue: string; // dollars
  baseline_source: BaselineSource;
  baseline_notes: string;
  notes: string;
}

export interface PilotPayload {
  tenant_id?: string;
  started_on: string;
  status: PilotStatus;
  baseline_weekly_calls: number | null;
  baseline_missed_call_pct: number | null;
  baseline_booking_rate_pct: number | null;
  baseline_avg_job_value_cents: number | null;
  baseline_weekly_revenue_cents: number | null;
  baseline_source: BaselineSource;
  baseline_notes: string | null;
  notes: string | null;
}

export const EMPTY_PILOT_FORM: PilotFormValues = {
  tenant_id: '', started_on: '', status: 'onboarding',
  baseline_weekly_calls: '', baseline_missed_call_pct: '', baseline_booking_rate_pct: '',
  baseline_avg_job_value: '', baseline_weekly_revenue: '',
  baseline_source: 'self_reported', baseline_notes: '', notes: '',
};

const centsToDollarString = (c: number | null) => (c === null ? '' : (c / 100).toFixed(2).replace(/\.00$/, ''));
const plain = (n: number | null) => (n === null ? '' : String(n));

export function pilotToForm(p: Pilot): PilotFormValues {
  return {
    tenant_id: p.tenant_id,
    started_on: p.started_on,
    status: p.status,
    baseline_weekly_calls: plain(p.baseline.weekly_calls),
    baseline_missed_call_pct: plain(p.baseline.missed_call_pct),
    baseline_booking_rate_pct: plain(p.baseline.booking_rate_pct),
    baseline_avg_job_value: centsToDollarString(p.baseline.avg_job_value_cents),
    baseline_weekly_revenue: centsToDollarString(p.baseline.weekly_revenue_cents),
    baseline_source: p.baseline.source,
    baseline_notes: p.baseline.notes ?? '',
    notes: p.notes ?? '',
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** "1,234.50" / "$1234" -> 123450 cents. null for empty. undefined when invalid. */
export function parseDollarsToCents(raw: string): number | null | undefined {
  let s = raw.trim().replace(/^\$/, '');
  if (s === '') return null;
  // Commas are accepted only as proper thousands separators ("1,234.50", never "1,2,3").
  if (s.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) return undefined;
    s = s.replace(/,/g, '');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const cents = Math.round(Number(s) * 100);
  return cents > 100_000_000_00 ? undefined : cents; // cap at $100M
}

function parseOptionalNumber(raw: string, opts: { min: number; max: number; integer: boolean; decimals?: number }): number | null | undefined {
  const s = raw.trim();
  if (s === '') return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  const n = Number(s);
  if (opts.integer && !Number.isInteger(n)) return undefined;
  if (!opts.integer && opts.decimals !== undefined && (s.split('.')[1]?.length ?? 0) > opts.decimals) return undefined;
  return n >= opts.min && n <= opts.max ? n : undefined;
}

/**
 * Validates the pilot form. In create mode a tenant is required; in edit mode
 * the tenant is immutable, so it is never sent. `today` is injectable for tests.
 */
export function parsePilotForm(f: PilotFormValues, mode: 'create' | 'edit', today: Date = new Date()): ParseResult<PilotPayload> {
  const errors: FieldErrors = {};

  if (mode === 'create' && !f.tenant_id) errors.tenant_id = 'Choose the customer account for this pilot.';

  const started = f.started_on.trim();
  if (!isValidIsoDate(started)) errors.started_on = 'Enter a valid start date.';
  else {
    const min = '2024-01-01';
    const maxDate = new Date(today.getTime() + 366 * 86_400_000).toISOString().slice(0, 10);
    if (started < min) errors.started_on = 'The start date cannot be before 2024.';
    else if (started > maxDate) errors.started_on = 'The start date cannot be more than a year ahead.';
  }

  if (!PILOT_STATUSES.includes(f.status)) errors.status = 'Choose a status.';

  const calls = parseOptionalNumber(f.baseline_weekly_calls, { min: 0, max: 100_000, integer: true });
  if (calls === undefined) errors.baseline_weekly_calls = 'Use a whole number from 0 to 100,000.';
  const missed = parseOptionalNumber(f.baseline_missed_call_pct, { min: 0, max: 100, integer: false, decimals: 2 });
  if (missed === undefined) errors.baseline_missed_call_pct = 'Use a percentage from 0 to 100 (up to 2 decimals).';
  const booking = parseOptionalNumber(f.baseline_booking_rate_pct, { min: 0, max: 100, integer: false, decimals: 2 });
  if (booking === undefined) errors.baseline_booking_rate_pct = 'Use a percentage from 0 to 100 (up to 2 decimals).';
  const jobValue = parseDollarsToCents(f.baseline_avg_job_value);
  if (jobValue === undefined) errors.baseline_avg_job_value = 'Use a dollar amount like 450 or 450.50.';
  const revenue = parseDollarsToCents(f.baseline_weekly_revenue);
  if (revenue === undefined) errors.baseline_weekly_revenue = 'Use a dollar amount like 9000 or 9000.50.';

  if (!BASELINE_SOURCES.includes(f.baseline_source)) errors.baseline_source = 'Choose where the baseline came from.';
  if (f.baseline_notes.length > 1000) errors.baseline_notes = 'Baseline notes must be 1,000 characters or fewer.';
  if (f.notes.length > 2000) errors.notes = 'Notes must be 2,000 characters or fewer.';

  if (Object.keys(errors).length) return { ok: false, errors };

  const value: PilotPayload = {
    started_on: started,
    status: f.status,
    baseline_weekly_calls: calls as number | null,
    baseline_missed_call_pct: missed as number | null,
    baseline_booking_rate_pct: booking as number | null,
    baseline_avg_job_value_cents: jobValue as number | null,
    baseline_weekly_revenue_cents: revenue as number | null,
    baseline_source: f.baseline_source,
    baseline_notes: f.baseline_notes.trim() || null,
    notes: f.notes.trim() || null,
  };
  if (mode === 'create') value.tenant_id = f.tenant_id;
  return { ok: true, value };
}

export interface ConsentFormValues { status: ConsentStatus; scope: ConsentScope[]; evidence: string }
export interface ConsentPayload { consent_status: ConsentStatus; consent_scope: ConsentScope[]; consent_evidence: string | null }

export function consentToForm(p: Pick<Pilot, 'consent'>): ConsentFormValues {
  return { status: p.consent.status, scope: [...p.consent.scope], evidence: p.consent.evidence ?? '' };
}

/** True when two consent forms mean the same thing (scope order and edge whitespace ignored). */
export function consentFormsEqual(a: ConsentFormValues, b: ConsentFormValues): boolean {
  const norm = (f: ConsentFormValues) => JSON.stringify([f.status, CONSENT_SCOPES.filter((s) => f.scope.includes(s)), f.evidence.trim()]);
  return norm(a) === norm(b);
}

export function parseConsentForm(f: ConsentFormValues): ParseResult<ConsentPayload> {
  const errors: FieldErrors = {};
  if (!CONSENT_STATUSES.includes(f.status)) errors.status = 'Choose a consent status.';
  const scope = CONSENT_SCOPES.filter((s) => f.scope.includes(s));
  const evidence = f.evidence.trim();
  if (evidence.length > 500) errors.evidence = 'Evidence must be 500 characters or fewer.';
  if (f.status === 'granted') {
    if (scope.length === 0) errors.scope = 'Choose what the customer agreed to.';
    if (!evidence) errors.evidence = 'Say where the written consent is (e.g. “Email from owner, 12 Jun 2027”).';
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { consent_status: f.status, consent_scope: scope, consent_evidence: evidence || null } };
}

// ---------------------------------------------------------------------------
// Audit history
// ---------------------------------------------------------------------------

const FIELD_LABEL: Record<string, string> = {
  status: 'status', started_on: 'start date', ended_on: 'end date', consent_status: 'consent', consent_scope: 'consent scope',
  consent_evidence: 'consent evidence', notes: 'notes', baseline_notes: 'baseline notes', baseline_source: 'baseline source',
  baseline_weekly_calls: 'baseline calls', baseline_missed_call_pct: 'baseline missed %', baseline_booking_rate_pct: 'baseline booking rate',
  baseline_avg_job_value_cents: 'baseline job value', baseline_weekly_revenue_cents: 'baseline revenue',
  consent_granted_at: 'consent date', consent_recorded_by: 'consent recorded by',
};

export function describeAuditEntry(e: Pick<PilotAuditEntry, 'action' | 'changes'>): string {
  const c = e.changes ?? {};
  switch (e.action) {
    case 'create': return 'Pilot created';
    case 'delete': return 'Pilot deleted';
    case 'export': return `Case study exported (${String(c.format ?? 'unknown')}${c.named ? ', with company name' : ', anonymised'})`;
    default: {
      const keys = Object.keys(c).filter((k) => k !== 'consent_granted_at' && k !== 'consent_recorded_by');
      if (keys.includes('consent_status')) {
        const to = (c.consent_status as { to?: ConsentStatus } | undefined)?.to;
        return `Consent set to ${to ? CONSENT_STATUS_LABEL[to].replace('Consent ', '').toLowerCase() : 'a new status'}`;
      }
      if (keys.length === 0) return 'Updated';
      const labels = keys.map((k) => FIELD_LABEL[k] ?? k);
      return `Updated ${labels.join(', ')}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Case-study export builders
// ---------------------------------------------------------------------------

const mdCell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
const dateOnly = (iso: string) => iso.slice(0, 10);

export function caseStudyTitle(x: Pick<CaseStudyExport, 'customer_name'>): string {
  return x.customer_name ? mdCell(x.customer_name) : 'Anonymous pilot customer';
}

export function caseStudyFilename(x: Pick<CaseStudyExport, 'customer_name' | 'generated_at'>, ext: 'md' | 'csv' | 'json'): string {
  const slug = (x.customer_name ?? 'pilot').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pilot';
  return `case-study-${slug}-${dateOnly(x.generated_at)}.${ext}`;
}

export function buildCaseStudyMarkdown(x: CaseStudyExport): string {
  const rows = buildMetricRows({
    baseline: { ...x.baseline, notes: null },
    live: { ...x.live, days: x.pilot.live_days, weeks_elapsed: x.pilot.weeks_elapsed, flagged_calls: 0 },
  });
  const ongoing = x.pilot.ended_on === null;
  const lines: string[] = [];

  lines.push(`# ${caseStudyTitle(x)}: pilot results`, '');
  lines.push(`Pilot ${x.pilot.started_on} to ${x.pilot.ended_on ?? 'present (ongoing)'} · ${x.pilot.weeks_elapsed} week${x.pilot.weeks_elapsed === 1 ? '' : 's'} · generated ${dateOnly(x.generated_at)}`, '');

  lines.push('## Headline results', '');
  lines.push(`| Metric | Before Vireek | With Vireek (last ${x.pilot.live_days} days) | Change |`, '| --- | --- | --- | --- |');
  for (const r of rows) lines.push(`| ${r.label} | ${r.baseline} | ${r.live} | ${r.change} |`);
  lines.push('');
  lines.push(`**Revenue recovered:** ${formatMoney(x.live.recovered_cents)} from ${x.live.recovered_count} opportunit${x.live.recovered_count === 1 ? 'y' : 'ies'} that would otherwise have been lost.`, '');
  lines.push(`**Calls handled during the pilot:** ${x.live.total_calls.toLocaleString('en-US')}`, '');

  lines.push('## Week by week', '');
  if (x.weekly.length === 0) {
    lines.push('No weekly data yet.', '');
  } else {
    lines.push('| Week | Dates | Calls | Missed | Booking rate | Revenue | Recovered |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const w of x.weekly) {
      lines.push(`| ${w.week_index}${w.is_complete ? '' : ' (in progress)'} | ${formatWeekRange(w)} | ${w.total_calls} | ${formatPct(weekMissedPct(w))} | ${formatPct(weekBookingRate(w))} | ${formatMoney(w.revenue_cents)} | ${formatMoney(w.recovered_cents)} |`);
    }
    lines.push('');
  }

  lines.push('## How these numbers were measured', '');
  lines.push(`- Before Vireek: ${BASELINE_SOURCE_LABEL[x.baseline.source].toLowerCase()}.`);
  lines.push('- With Vireek: calculated from the customer’s own calls, paid jobs and recovered opportunities in Vireek.');
  lines.push('- Missed calls include voicemails. Booking rate is booked calls out of calls where booking was possible.');
  lines.push('- Revenue counts paid, non-cancelled jobs. Weeks are 7-day periods counted from the pilot start (UTC).');
  if (ongoing) lines.push('- The pilot is still running, so the latest week is not complete.');
  lines.push('');

  // Internal block: HTML comments do not render, but remind the editor what was agreed.
  lines.push('<!-- INTERNAL. Remove before publishing.');
  lines.push(`Consent scope: ${describeScope(x.consent.scope)}`);
  lines.push(`Consent recorded: ${x.consent.granted_at ? dateOnly(x.consent.granted_at) : 'unknown'}`);
  lines.push(`Evidence: ${(x.consent.evidence ?? 'none').replace(/-->/g, '--').replace(/\r?\n/g, ' ')}`);
  lines.push('-->', '');
  return lines.join('\n');
}

export interface CsvColumnDef { header: string; accessor: (w: PilotWeek) => string | number | null }

export const WEEKLY_CSV_COLUMNS: CsvColumnDef[] = [
  { header: 'Week', accessor: (w) => w.week_index },
  { header: 'Start', accessor: (w) => w.week_start },
  { header: 'End', accessor: (w) => w.week_end },
  { header: 'Complete', accessor: (w) => (w.is_complete ? 'yes' : 'no') },
  { header: 'Calls', accessor: (w) => w.total_calls },
  { header: 'Missed calls', accessor: (w) => w.missed_calls },
  { header: 'Missed %', accessor: (w) => numRound(weekMissedPct(w), 1) },
  { header: 'Booking opportunities', accessor: (w) => w.booking_opportunities },
  { header: 'Booked', accessor: (w) => w.booked },
  { header: 'Booking rate %', accessor: (w) => numRound(weekBookingRate(w), 1) },
  { header: 'Avg call score', accessor: (w) => w.avg_call_score },
  { header: 'Flagged calls', accessor: (w) => w.flagged_calls },
  { header: 'Paid jobs', accessor: (w) => w.paid_jobs },
  { header: 'Revenue USD', accessor: (w) => w.revenue_cents / 100 },
  { header: 'Recovered opportunities', accessor: (w) => w.recovered_count },
  { header: 'Recovered USD', accessor: (w) => w.recovered_cents / 100 },
];

function numRound(v: number | null, d: number): number | null {
  return v === null ? null : Number(v.toFixed(d));
}

/** Triggers a browser download of a text file (CSV goes through exportToCsv, which adds the Excel BOM). */
export function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
