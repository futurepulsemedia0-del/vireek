// Transparency report: pure types and helpers (no React, no Supabase).
// Figures are compiled and frozen by the database (supabase/migrations/20290312000000_transparency_report.sql);
// nothing here computes a statistic. This file only shapes, labels and formats what the database returned.

export type ReportStatus = 'draft' | 'approved' | 'published' | 'unpublished';
export type EntryStatus = ReportStatus;

export const SECTIONS = ['ai_incidents', 'takedowns', 'legal_requests', 'data_requests', 'outages'] as const;
export type Section = (typeof SECTIONS)[number];

/** One figure. dimension === '' means a total. count is null when the public rule suppressed a small number. */
export interface MetricRow {
  section: string;
  metric: string;
  dimension: string;
  key: string;
  count: number | null;
  suppressed?: boolean;
}

export interface StaffReport {
  id: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  status: ReportStatus;
  suppressBelow: number | null;
  metrics: MetricRow[];
  compiledAt: string | null;
  introText: string;
  reportingRulesText: string;
  correctionsText: string;
  counselApprovedOn: string | null;
  publishedAt: string | null;
}

export interface PublicReport {
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  publishedAt: string;
  counselApprovedOn: string | null;
  suppressBelow: number | null;
  introText: string;
  reportingRulesText: string;
  correctionsText: string | null;
  metrics: MetricRow[];
}

export interface PublicIncident {
  publicRef: string;
  incidentType: string;
  severity: string;
  occurredOn: string;
  title: string;
  whatHappened: string;
  impact: string;
  whatWeDid: string;
  correctionNote: string | null;
  publishedAt: string;
}

const PERIOD_RE = /^([0-9]{4})-H([12])$/;

export function isPeriodLabel(v: string): boolean {
  const m = PERIOD_RE.exec(v);
  return !!m && Number(m[1]) >= 2020;
}

/** Inclusive UTC bounds of a half-year label, as YYYY-MM-DD. Same derivation as transparency_report_create(). */
export function periodBounds(label: string): { start: string; end: string } | null {
  const m = PERIOD_RE.exec(label);
  if (!m || Number(m[1]) < 2020) return null;
  return m[2] === '1' ? { start: `${m[1]}-01-01`, end: `${m[1]}-06-30` } : { start: `${m[1]}-07-01`, end: `${m[1]}-12-31` };
}

/** Most recent half-year that has already ended (UTC). Before 1 July that is the previous year's H2. */
export function lastClosedPeriod(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? `${y}-H1` : `${y - 1}-H2`;
}

export function periodHasEnded(label: string, now: Date = new Date()): boolean {
  const b = periodBounds(label);
  return !!b && b.end < now.toISOString().slice(0, 10);
}

/** Looks up one figure. Returns undefined when the row does not exist (never 0), so a gap cannot pass for a zero. */
export function findMetric(rows: readonly MetricRow[], section: string, metric: string, dimension = '', key = ''): MetricRow | undefined {
  return rows.find((r) => r.section === section && r.metric === metric && r.dimension === dimension && r.key === key);
}

/** Rows of one metric split by one dimension, in the order the database returned them. */
export function dimensionRows(rows: readonly MetricRow[], section: string, metric: string, dimension: string): MetricRow[] {
  return rows.filter((r) => r.section === section && r.metric === metric && r.dimension === dimension);
}

/** Text for one figure. A suppressed small number reads "fewer than k"; k comes from the report, never from the UI. */
export function formatCount(row: MetricRow | undefined, suppressBelow: number | null, locale = 'en'): string {
  if (!row) return '—';
  if (row.count === null || row.suppressed) return suppressBelow ? `< ${suppressBelow}` : '—';
  return new Intl.NumberFormat(locale).format(row.count);
}

/** Minutes as "2 h 5 min" / "45 min". */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** Fields a report needs before it can be sent for approval. Mirrors transparency_reports_guard(). */
export function approvalBlockers(r: Pick<StaffReport, 'introText' | 'reportingRulesText' | 'metrics'>): Array<'intro' | 'rules' | 'metrics'> {
  const out: Array<'intro' | 'rules' | 'metrics'> = [];
  if (!r.introText.trim()) out.push('intro');
  if (!r.reportingRulesText.trim()) out.push('rules');
  if (r.metrics.length === 0) out.push('metrics');
  return out;
}

export function publishBlocker(r: Pick<StaffReport, 'status' | 'periodLabel'>, now: Date = new Date()): 'notApproved' | 'periodOpen' | null {
  if (r.status !== 'approved') return 'notApproved';
  return periodHasEnded(r.periodLabel, now) ? null : 'periodOpen';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function toMetricRows(raw: unknown): MetricRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): MetricRow[] => {
    const o = r as Record<string, unknown>;
    if (!o || typeof o !== 'object' || !str(o.section) || !str(o.metric)) return [];
    return [{ section: str(o.section), metric: str(o.metric), dimension: str(o.dimension), key: str(o.key), count: num(o.count), suppressed: o.suppressed === true }];
  });
}

export function toStaffReport(r: Record<string, unknown>): StaffReport {
  return {
    id: str(r.id), periodLabel: str(r.period_label), periodStart: str(r.period_start), periodEnd: str(r.period_end),
    status: str(r.status) as ReportStatus, suppressBelow: num(r.suppress_below), metrics: toMetricRows(r.metrics),
    compiledAt: (r.compiled_at as string | null) ?? null, introText: str(r.intro_text), reportingRulesText: str(r.reporting_rules_text),
    correctionsText: str(r.corrections_text), counselApprovedOn: (r.counsel_approved_on as string | null) ?? null,
    publishedAt: (r.published_at as string | null) ?? null,
  };
}

export function toPublicReport(r: Record<string, unknown>): PublicReport {
  return {
    periodLabel: str(r.period_label), periodStart: str(r.period_start), periodEnd: str(r.period_end), publishedAt: str(r.published_at),
    counselApprovedOn: (r.counsel_approved_on as string | null) ?? null, suppressBelow: num(r.suppress_below),
    introText: str(r.intro_text), reportingRulesText: str(r.reporting_rules_text),
    correctionsText: (r.corrections_text as string | null) ?? null, metrics: toMetricRows(r.metrics),
  };
}

export function toPublicIncident(r: Record<string, unknown>): PublicIncident {
  return {
    publicRef: str(r.public_ref), incidentType: str(r.incident_type), severity: str(r.severity), occurredOn: str(r.occurred_on),
    title: str(r.title), whatHappened: str(r.what_happened), impact: str(r.impact), whatWeDid: str(r.what_we_did),
    correctionNote: (r.correction_note as string | null) ?? null, publishedAt: str(r.published_at),
  };
}

/** Plain-language labels for keys the database returns. Unknown keys fall back to the raw key, never to a guess. */
export const LABELS: Readonly<Record<string, string>> = {
  wrong_diagnosis: 'Wrong diagnosis', wrong_price_commitment: 'Wrong price commitment', pii_leak_on_call: 'Personal data shared on a call',
  discriminatory_behavior: 'Discriminatory behavior', prompt_injection: 'Prompt injection', other: 'Other',
  low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical',
  takedown: 'Takedown notice', counter: 'Counter-notice',
  new: 'New', under_review: 'Under review', content_removed: 'Content removed', counter_pending: 'Counter-notice pending', restored: 'Restored', rejected: 'Rejected', closed: 'Closed',
  subpoena: 'Subpoena', court_order: 'Court order', search_warrant: 'Search warrant', preservation_request: 'Preservation request',
  emergency_disclosure: 'Emergency disclosure', regulator_inquiry: 'Regulator inquiry', civil_discovery: 'Civil discovery',
  pending: 'Pending', complied_in_full: 'Complied in full', complied_in_part: 'Complied in part', objected: 'Objected', challenged: 'Challenged',
  rejected_invalid: 'Rejected as invalid', no_data_found: 'No data found', withdrawn_by_requester: 'Withdrawn by requester',
  subscriber_info: 'Subscriber information', call_metadata: 'Call metadata', call_recordings: 'Call recordings', transcripts: 'Transcripts',
  messages: 'Messages', account_records: 'Account records', billing_records: 'Billing records', location_data: 'Location data',
  access: 'Access', delete: 'Deletion', correct: 'Correction', completed: 'Completed', cancelled: 'Cancelled', expired: 'Expired', open: 'Open',
  minor: 'Minor', major: 'Major', manual: 'Reported by staff', synthetic: 'Detected by monitoring',
};
export const labelFor = (key: string): string => LABELS[key] ?? key;

/** Markdown draft of a report (for counsel review or archiving). Staff view: pass the snapshot you want to print. */
export function reportToMarkdown(r: { periodLabel: string; periodStart: string; periodEnd: string; suppressBelow: number | null; introText: string; reportingRulesText: string; metrics: readonly MetricRow[] }): string {
  const L: string[] = [`# Vireek transparency report: ${r.periodLabel}`, '', `Covers ${r.periodStart} to ${r.periodEnd} (UTC).`, ''];
  if (r.introText.trim()) L.push(r.introText.trim(), '');
  const titles: Record<Section, string> = {
    ai_incidents: 'AI incidents', takedowns: 'Copyright takedown notices', legal_requests: 'Legal requests for customer data',
    data_requests: 'Data requests from individuals (verified)', outages: 'Service outages',
  };
  for (const s of SECTIONS) {
    const rows = r.metrics.filter((m) => m.section === s);
    if (rows.length === 0) continue;
    L.push(`## ${titles[s]}`, '', '| Measure | Breakdown | Count |', '|---|---|---|');
    for (const m of rows) L.push(`| ${m.metric.replace(/_/g, ' ')} | ${m.dimension ? `${m.dimension.replace(/_/g, ' ')}: ${labelFor(m.key)}` : 'total'} | ${formatCount(m, r.suppressBelow)} |`);
    L.push('');
  }
  if (r.reportingRulesText.trim()) L.push('## Reporting rules applied', '', r.reportingRulesText.trim(), '');
  return L.join('\n');
}
