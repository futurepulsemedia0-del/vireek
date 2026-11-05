/**
 * Exit-Ready — lineage, reconciliation, readiness checklist, multiple tables, run-to-run changelog.
 *
 * Pure functions only (no I/O): everything here is unit-tested. The numbers come from the database
 * (20281115000000_exit_ready_lineage.sql); this module parses, explains and compares them.
 * Every output is a SCREENING ESTIMATE, not a valuation, appraisal, QoE, tax or legal advice.
 */

import type { DriverStatus, ExitMetrics, ExitSettings, IndustryKey, MultipleRange, SnapshotLite } from '@/lib/exitReadiness';
import { INDUSTRY_PRESETS, clamp, lin, validateMultiple } from '@/lib/exitReadiness';

// ------------------------------------------------------------------ small helpers

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read a number from a fact value by key; returns null when missing or not numeric. */
export function factNum(fact: LineageFact | undefined, key: string): number | null {
  if (!fact) return null;
  const v = fact.value[key];
  if (isNum(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export const shortHash = (hash: string): string => (hash.length >= 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash);

// ------------------------------------------------------------------ lineage types + parsing

export interface LineageFact {
  id: string;
  metricKey: string;
  label: string;
  value: Record<string, unknown>;
  asOf: string;
  logicVersion: string;
  logicText: string;
  sourceTable: string;
  sourceCount: number;
  contentHash: string;
}

export type ReconStatus = 'match' | 'difference' | 'unavailable';

export interface ReconItem {
  key: string;
  label: string;
  leftLabel: string;
  leftCents: number | null;
  rightLabel: string;
  rightCents: number | null;
  diffCents: number | null;
  toleranceCents: number;
  status: ReconStatus;
  note: string;
}

export interface LineageRun {
  id: string;
  asOf: string;
  logicVersion: string;
  runHash: string | null;
  createdAt: string;
  reconciliation: ReconItem[];
  facts: LineageFact[];
}

export interface FactRow {
  id: string;
  metric_key: string;
  label: string;
  value: unknown;
  as_of: string;
  logic_version: string;
  logic_text: string;
  source_table: string;
  source_count: number | string;
  content_hash: string;
}

export interface RunRow {
  id: string;
  as_of: string;
  logic_version: string;
  run_hash: string | null;
  created_at: string;
  reconciliation: unknown;
}

const RECON_STATUS = new Set<ReconStatus>(['match', 'difference', 'unavailable']);

export function parseRecon(raw: unknown): ReconItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ReconItem[] = [];
  for (const r of raw) {
    if (!isRec(r) || typeof r.key !== 'string') continue;
    const status = RECON_STATUS.has(r.status as ReconStatus) ? (r.status as ReconStatus) : 'unavailable';
    const n = (v: unknown): number | null => (isNum(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    out.push({
      key: r.key,
      label: typeof r.label === 'string' ? r.label : r.key,
      leftLabel: typeof r.leftLabel === 'string' ? r.leftLabel : '',
      leftCents: n(r.leftCents),
      rightLabel: typeof r.rightLabel === 'string' ? r.rightLabel : '',
      rightCents: n(r.rightCents),
      diffCents: n(r.diffCents),
      toleranceCents: n(r.toleranceCents) ?? 0,
      status,
      note: typeof r.note === 'string' ? r.note : '',
    });
  }
  return out;
}

export function parseFact(r: FactRow): LineageFact {
  return {
    id: r.id,
    metricKey: r.metric_key,
    label: r.label,
    value: isRec(r.value) ? r.value : {},
    asOf: r.as_of,
    logicVersion: r.logic_version,
    logicText: r.logic_text,
    sourceTable: r.source_table,
    sourceCount: Number(r.source_count) || 0,
    contentHash: r.content_hash,
  };
}

export function parseRun(run: RunRow, facts: FactRow[]): LineageRun {
  return {
    id: run.id,
    asOf: run.as_of,
    logicVersion: run.logic_version,
    runHash: run.run_hash,
    createdAt: run.created_at,
    reconciliation: parseRecon(run.reconciliation),
    facts: facts.map(parseFact).sort((a, b) => a.metricKey.localeCompare(b.metricKey)),
  };
}

export const factMap = (run: LineageRun | null): Record<string, LineageFact> =>
  Object.fromEntries((run?.facts ?? []).map((f) => [f.metricKey, f]));

// ------------------------------------------------------------------ multiple tables (inputs, never facts)

export type SizeBand = 'under_1m' | '1m_to_5m' | '5m_to_20m' | 'over_20m';
export const SIZE_BANDS: readonly SizeBand[] = ['under_1m', '1m_to_5m', '5m_to_20m', 'over_20m'];
export const SIZE_BAND_LABELS: Record<SizeBand, string> = {
  under_1m: 'Under $1M revenue',
  '1m_to_5m': '$1M–$5M revenue',
  '5m_to_20m': '$5M–$20M revenue',
  over_20m: 'Over $20M revenue',
};

/** Size band from trailing-12-month revenue in cents. Boundaries: <$1M, <$5M, <$20M, otherwise over. */
export function sizeBandFor(revenueCents: number | null | undefined): SizeBand | null {
  if (!isNum(revenueCents) || revenueCents <= 0) return null;
  if (revenueCents < 100_000_000) return 'under_1m';
  if (revenueCents < 500_000_000) return '1m_to_5m';
  if (revenueCents < 2_000_000_000) return '5m_to_20m';
  return 'over_20m';
}

export interface MultipleRow {
  id?: string;
  industryKey: IndustryKey;
  sizeBand: SizeBand;
  basis: 'sde' | 'ebitda';
  low: number;
  mid: number;
  high: number;
  source: string;
  /** ISO date (YYYY-MM-DD). */
  sourceDate: string;
  isIllustrative: boolean;
}

export function validateMultipleRow(d: { low: string; mid: string; high: string; source: string; sourceDate: string }, today = new Date()): Record<string, string> {
  const e: Record<string, string> = {};
  const range: MultipleRange = { low: Number(d.low), mid: Number(d.mid), high: Number(d.high) };
  if (d.low.trim() === '' || d.mid.trim() === '' || d.high.trim() === '') e.range = 'Enter low, mid and high multiples.';
  else {
    const msg = validateMultiple(range);
    if (msg) e.range = msg;
    else if (range.high > 20) e.range = 'Multiples above 20× are not supported.';
  }
  if (d.source.trim().length < 3) e.source = 'Name the source (a broker report, an advisor, a transaction database).';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.sourceDate) || Number.isNaN(Date.parse(d.sourceDate))) e.sourceDate = 'Enter the date the figure was published.';
  else if (Date.parse(d.sourceDate) > today.getTime() + 86_400_000) e.sourceDate = 'The source date cannot be in the future.';
  return e;
}

export function pickMultipleRow(rows: MultipleRow[], industry: IndustryKey, band: SizeBand | null, basis: 'sde' | 'ebitda'): MultipleRow | null {
  if (!band) return null;
  return rows.find((r) => r.industryKey === industry && r.sizeBand === band && r.basis === basis) ?? null;
}

export interface MultipleProvenance {
  origin: 'manual' | 'table' | 'builtin';
  source: string;
  sourceDate: string | null;
  illustrative: boolean;
}

export interface EffectiveMultiples {
  settings: ExitSettings;
  sizeBand: SizeBand | null;
  sde: MultipleProvenance;
  ebitda: MultipleProvenance;
}

const BUILTIN: MultipleProvenance = {
  origin: 'builtin',
  source: 'Built-in placeholder with no source. Replace it with a figure from your broker or advisor.',
  sourceDate: null,
  illustrative: true,
};

/**
 * Resolution order per basis: (1) the owner's manual override in settings, (2) a configured table row for
 * trade × size band, (3) the built-in placeholder. The result carries provenance so the UI can always show
 * where a multiple came from and that it is illustrative.
 */
export function resolveEffectiveMultiples(settings: ExitSettings, rows: MultipleRow[], revenueCents: number | null): EffectiveMultiples {
  const band = sizeBandFor(revenueCents);
  const one = (basis: 'sde' | 'ebitda'): { range: MultipleRange | null; prov: MultipleProvenance } => {
    const manual = basis === 'sde' ? settings.sdeMultiple : settings.ebitdaMultiple;
    if (manual && !validateMultiple(manual)) {
      return { range: manual, prov: { origin: 'manual', source: 'Entered by you in Assumptions', sourceDate: null, illustrative: false } };
    }
    const row = pickMultipleRow(rows, settings.industryKey, band, basis);
    if (row) {
      return { range: { low: row.low, mid: row.mid, high: row.high }, prov: { origin: 'table', source: row.source, sourceDate: row.sourceDate, illustrative: row.isIllustrative } };
    }
    return { range: null, prov: BUILTIN };
  };
  const sde = one('sde');
  const ebitda = one('ebitda');
  return {
    settings: { ...settings, sdeMultiple: sde.range ?? settings.sdeMultiple, ebitdaMultiple: ebitda.range ?? settings.ebitdaMultiple },
    sizeBand: band,
    sde: sde.prov,
    ebitda: ebitda.prov,
  };
}

/** Trailing revenue scaled to 12 months from the ledger window; null when the ledger has no months. */
export function annualRevenueCents(metrics: Pick<ExitMetrics, 'ledgerMonths' | 'financials'>): number | null {
  const months = metrics.ledgerMonths;
  if (!isNum(months) || months <= 0 || !isNum(metrics.financials.revenueCents) || metrics.financials.revenueCents <= 0) return null;
  return Math.round((metrics.financials.revenueCents * 12) / Math.min(months, 12));
}

export const builtinRange = (industry: IndustryKey, basis: 'sde' | 'ebitda'): MultipleRange =>
  (INDUSTRY_PRESETS[industry] ?? INDUSTRY_PRESETS.general_trades)[basis];

// ------------------------------------------------------------------ additional value signals (from lineage facts)

export interface Signal {
  key: 'growth' | 'booking_rate' | 'membership_renewal' | 'backlog';
  label: string;
  /** 0–100; null when there is not enough data or the signal is informational only. */
  score: number | null;
  status: DriverStatus;
  display: string;
  detail: string;
  sourceFactKey: string;
}

const statusFor = (s: number | null): DriverStatus => (s === null ? 'nodata' : s >= 75 ? 'strong' : s >= 45 ? 'ok' : 'weak');
const pct = (f: number, d = 0) => `${(f * 100).toFixed(d)}%`;

/**
 * Four signals the readiness score does not include yet. They are shown next to it with their own
 * thresholds and are NOT blended into the readiness score, so existing snapshots stay comparable.
 */
export function scoreSignals(run: LineageRun | null): Signal[] {
  const f = factMap(run);
  const out: Signal[] = [];

  const cur = factNum(f.revenue_invoiced_12m, 'subtotalCents');
  const prev = factNum(f.revenue_invoiced_prior_12m, 'subtotalCents');
  let growth: number | null = null;
  let growthRate: number | null = null;
  if (isNum(cur) && isNum(prev) && prev > 0) {
    growthRate = (cur - prev) / prev;
    growth = lin(growthRate, -0.1, 0.15);
  }
  out.push({
    key: 'growth', label: 'Revenue growth', score: growth, status: statusFor(growth),
    display: growthRate === null ? 'Needs two full years of invoices' : `${growthRate >= 0 ? '+' : ''}${pct(growthRate, 1)} vs prior 12 months`,
    detail: 'Invoiced revenue (ex-tax), trailing 12 months vs the 12 months before. −10% scores 0, +15% scores 100.',
    sourceFactKey: 'revenue_invoiced_12m',
  });

  const calls = factNum(f.call_funnel_12m, 'calls');
  const rate = factNum(f.call_funnel_12m, 'bookingRate');
  const bookScore = isNum(calls) && calls >= 20 && isNum(rate) ? lin(rate, 0.3, 0.8) : null;
  out.push({
    key: 'booking_rate', label: 'Call-to-booking rate', score: bookScore, status: statusFor(bookScore),
    display: isNum(rate) && isNum(calls) ? `${pct(rate, 1)} of ${calls} calls became a job` : 'No calls recorded',
    detail: 'Share of calls with a linked job. Scored only with 20+ calls. 30% scores 0, 80% scores 100. Answered vs missed is not recorded, so answer rate is unavailable.',
    sourceFactKey: 'call_funnel_12m',
  });

  const cycles = factNum(f.membership_renewals_12m, 'cycles');
  const renewal = factNum(f.membership_renewals_12m, 'renewalRate');
  const renScore = isNum(cycles) && cycles >= 5 && isNum(renewal) ? lin(renewal, 0.5, 0.9) : null;
  out.push({
    key: 'membership_renewal', label: 'Membership renewal rate', score: renScore, status: statusFor(renScore),
    display: isNum(renewal) ? `${pct(renewal, 1)} renewed (${cycles ?? 0} cycles)` : 'No renewal outcomes yet',
    detail: 'Renewed ÷ (renewed + lapsed) for cycles ending in the last 12 months. Scored only with 5+ cycles. 50% scores 0, 90% scores 100.',
    sourceFactKey: 'membership_renewals_12m',
  });

  const open = factNum(f.jobs_12m, 'scheduledOpen');
  const done = factNum(f.jobs_12m, 'completed');
  let weeks: number | null = null;
  if (isNum(open) && isNum(done) && done > 0) weeks = open / (done / 52);
  out.push({
    key: 'backlog', label: 'Scheduled backlog', score: null, status: 'nodata',
    display: weeks === null ? 'Not enough completed jobs' : `${open} scheduled jobs ≈ ${weeks.toFixed(1)} weeks of work`,
    detail: 'Informational only. Jobs still scheduled and not completed, divided by the weekly completion rate. Buyers read backlog differently, so it is not scored.',
    sourceFactKey: 'jobs_12m',
  });
  return out;
}

// ------------------------------------------------------------------ readiness checklist (B.6)

export type CheckSeverity = 'critical' | 'important' | 'minor';
export interface ChecklistItem {
  key: string;
  status: 'ok' | 'gap' | 'unknown';
  severity: CheckSeverity;
  title: string;
  detail: string;
  /** In-app route that fixes it; null when it cannot be fixed inside Vireek (e.g. not tracked). */
  fixPath: string | null;
  fixLabel: string | null;
}

const WEIGHT: Record<CheckSeverity, number> = { critical: 25, important: 12, minor: 5 };

export function buildReadinessChecklist(run: LineageRun | null, metrics: ExitMetrics | null): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const f = factMap(run);
  const recon = Object.fromEntries((run?.reconciliation ?? []).map((r) => [r.key, r]));
  const add = (i: ChecklistItem) => items.push(i);

  if (!run) {
    add({ key: 'no_run', status: 'unknown', severity: 'critical', title: 'Run the evidence check', detail: 'No lineage run exists yet. Run it to compute every figure with its source count and hash.', fixPath: null, fixLabel: null });
    return items;
  }

  const gl = recon.invoiced_vs_gl_revenue;
  if (!gl || gl.status === 'unavailable') {
    add({ key: 'no_ledger', status: 'gap', severity: 'critical', title: 'No ledger revenue to reconcile against', detail: 'Invoices cannot be tied to accounting because no posted revenue exists in the ledger for the last 12 months.', fixPath: '/dashboard/accounting', fixLabel: 'Open accounting' });
  } else if (gl.status === 'difference') {
    add({ key: 'gl_diff', status: 'gap', severity: 'critical', title: 'Invoiced revenue differs from ledger revenue', detail: `Difference of ${centsLabel(gl.diffCents)}. Buyers will ask for this reconciliation.`, fixPath: '/dashboard/accounting', fixLabel: 'Review accounting' });
  } else add({ key: 'gl_ok', status: 'ok', severity: 'critical', title: 'Invoices reconcile to the ledger', detail: 'Within tolerance.', fixPath: null, fixLabel: null });

  const pay = recon.invoice_paid_vs_job_payments;
  if (pay?.status === 'difference') {
    add({ key: 'pay_diff', status: 'gap', severity: 'important', title: 'Invoice cash differs from recorded job payments', detail: `Difference of ${centsLabel(pay.diffCents)}. ${pay.note}`, fixPath: '/dashboard/accounting', fixLabel: 'Review payments' });
  } else if (pay?.status === 'match') add({ key: 'pay_ok', status: 'ok', severity: 'important', title: 'Invoice cash matches recorded payments', detail: 'Within tolerance.', fixPath: null, fixLabel: null });

  const nj = recon.invoices_without_journal;
  if (nj?.status === 'difference') {
    add({ key: 'no_journal', status: 'gap', severity: 'important', title: 'Invoices missing a ledger entry', detail: `${centsLabel(nj.leftCents)} of invoices have no journal entry.`, fixPath: '/dashboard/accounting', fixLabel: 'Post to ledger' });
  }
  const over = recon.paid_exceeds_billed;
  if (over?.status === 'difference') {
    add({ key: 'overpaid', status: 'gap', severity: 'important', title: 'Invoices paid above their total', detail: `${centsLabel(over.leftCents)} of overpayment or misapplied credit.`, fixPath: '/dashboard/accounting', fixLabel: 'Fix applied payments' });
  }
  const q = recon.qbo_open_findings;
  if (q?.status === 'difference') {
    add({ key: 'qbo_open', status: 'gap', severity: 'important', title: 'Open QuickBooks reconciliation findings', detail: `${centsLabel(q.leftCents)} at stake across open findings.`, fixPath: '/dashboard/accounting', fixLabel: 'Resolve findings' });
  }

  const cov = metrics?.margin.coveragePct;
  if (typeof cov === 'number') {
    if (cov < 0.8) add({ key: 'job_costing', status: 'gap', severity: 'important', title: 'Job costing is incomplete', detail: `Only ${(cov * 100).toFixed(0)}% of completed jobs have cost entries, so gross margin is unreliable.`, fixPath: '/dashboard/jobs', fixLabel: 'Add job costs' });
    else add({ key: 'job_costing_ok', status: 'ok', severity: 'important', title: 'Job costing is mostly complete', detail: `${(cov * 100).toFixed(0)}% of completed jobs are costed.`, fixPath: null, fixLabel: null });
  } else add({ key: 'job_costing', status: 'unknown', severity: 'important', title: 'Job costing coverage unknown', detail: 'No completed jobs with cost data were found.', fixPath: '/dashboard/jobs', fixLabel: 'Add job costs' });

  const credExp = factNum(f.compliance, 'credentialsExpired') ?? 0;
  const docExp = factNum(f.compliance, 'documentsExpired') ?? 0;
  const permExp = factNum(f.compliance, 'permitsLapsed') ?? 0;
  if (credExp > 0) add({ key: 'cred_expired', status: 'gap', severity: 'critical', title: `${credExp} expired technician credential${credExp === 1 ? '' : 's'}`, detail: 'Expired licenses are a closing risk and a compliance finding.', fixPath: '/dashboard/compliance', fixLabel: 'Renew credentials' });
  if (docExp > 0) add({ key: 'doc_expired', status: 'gap', severity: 'important', title: `${docExp} expired document${docExp === 1 ? '' : 's'}`, detail: 'Expired insurance, license or contract documents in the vault.', fixPath: '/dashboard/documents', fixLabel: 'Update documents' });
  if (permExp > 0) add({ key: 'permit_lapsed', status: 'gap', severity: 'important', title: `${permExp} lapsed permit${permExp === 1 ? '' : 's'}`, detail: 'Permits that expired without being closed out.', fixPath: '/dashboard/permits', fixLabel: 'Review permits' });
  if (credExp + docExp + permExp === 0 && f.compliance) add({ key: 'compliance_ok', status: 'ok', severity: 'critical', title: 'No expired licenses, documents or permits', detail: 'Based on records in Vireek.', fixPath: null, fixLabel: null });

  if (f.compliance && f.compliance.value.rescissionTracked === false) {
    add({ key: 'rescission', status: 'unknown', severity: 'minor', title: 'Rescission records are not tracked', detail: 'Vireek has no rescission-record data, so this part of the compliance package is empty. Gather them outside Vireek if buyers ask.', fixPath: null, fixLabel: null });
  }
  const ar = f.call_funnel_12m;
  if (ar && ar.value.answerRate === null) {
    add({ key: 'answer_rate', status: 'unknown', severity: 'minor', title: 'Answer rate is not recorded', detail: 'Calls are not marked answered or missed, so only the booking rate is shown.', fixPath: null, fixLabel: null });
  }
  return items;
}

/** 0–100 evidence score: 100 minus weighted penalties for gaps; unknown items cost half. */
export function evidenceScore(items: ChecklistItem[]): number | null {
  if (!items.length || items.every((i) => i.key === 'no_run')) return null;
  let penalty = 0;
  for (const i of items) {
    if (i.status === 'gap') penalty += WEIGHT[i.severity];
    else if (i.status === 'unknown') penalty += WEIGHT[i.severity] / 2;
  }
  return Math.round(clamp(100 - penalty, 0, 100));
}

/** Deterministic en-US digit grouping (exports must read the same on every machine). */
export const groupDigits = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function centsLabel(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return '—';
  const abs = Math.round(Math.abs(cents));
  const sign = cents < 0 && abs > 0 ? '-' : '';
  return `${sign}$${groupDigits(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ levers that actually moved

export interface LeverMovement {
  driver: string;
  delta: number;
  direction: 'up' | 'down';
}

/** Drivers whose score moved by at least `minPoints` between the two most recent monthly snapshots. */
export function movedDrivers(snapshots: SnapshotLite[], minPoints = 3): LeverMovement[] {
  if (snapshots.length < 2) return [];
  const sorted = [...snapshots].sort((a, b) => a.periodMonth.localeCompare(b.periodMonth));
  const cur = sorted[sorted.length - 1].driverScores;
  const prev = sorted[sorted.length - 2].driverScores;
  const out: LeverMovement[] = [];
  for (const [k, v] of Object.entries(cur)) {
    const p = (prev as Record<string, number | null | undefined>)[k];
    if (isNum(v) && isNum(p)) {
      const d = Math.round((v - p) * 10) / 10;
      if (Math.abs(d) >= minPoints) out.push({ driver: k, delta: d, direction: d > 0 ? 'up' : 'down' });
    }
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// ------------------------------------------------------------------ changelog between runs

/** The single headline number of each fact used for run-to-run comparison and export. */
export const HEADLINES: Record<string, { field: string; unit: 'cents' | 'count' | 'ratio' }> = {
  revenue_invoiced_12m: { field: 'subtotalCents', unit: 'cents' },
  revenue_invoiced_prior_12m: { field: 'subtotalCents', unit: 'cents' },
  collected_12m: { field: 'paidCents', unit: 'cents' },
  ar_aging: { field: 'openCents', unit: 'cents' },
  customer_concentration: { field: 'top1Share', unit: 'ratio' },
  recurring_revenue: { field: 'annualCents', unit: 'cents' },
  membership_base: { field: 'retention12m', unit: 'ratio' },
  membership_renewals_12m: { field: 'renewalRate', unit: 'ratio' },
  call_funnel_12m: { field: 'bookingRate', unit: 'ratio' },
  jobs_12m: { field: 'completed', unit: 'count' },
  workforce: { field: 'activeShare', unit: 'ratio' },
  compliance: { field: 'credentialsExpired', unit: 'count' },
  gl_revenue_12m: { field: 'revenueCents', unit: 'cents' },
  owner_dependence: { field: 'ownerRevenueSharePct', unit: 'count' },
};

export function headline(fact: LineageFact | undefined): number | null {
  if (!fact) return null;
  const h = HEADLINES[fact.metricKey];
  return h ? factNum(fact, h.field) : null;
}

/** Headline number straight from a raw fact value (used by the buyer view, which has no LineageFact objects). */
export function headlineFromValue(metricKey: string, value: unknown): number | null {
  const h = HEADLINES[metricKey];
  if (!h || !isRec(value)) return null;
  const v = value[h.field];
  return isNum(v) ? v : null;
}

export function formatHeadline(metricKey: string, v: number | null): string {
  if (v === null) return '—';
  const u = HEADLINES[metricKey]?.unit;
  if (u === 'cents') return centsLabel(v);
  if (u === 'ratio') return pct(v, 1);
  return String(v);
}

export interface ChangeEntry {
  metricKey: string;
  label: string;
  change: 'added' | 'removed' | 'changed' | 'unchanged';
  before: number | null;
  after: number | null;
  /** Relative change; null when the baseline is missing or zero. */
  relative: number | null;
  hashBefore: string | null;
  hashAfter: string | null;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isRec(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** Two facts hold the same data when value and source count match (the content hash also covers the as-of time). */
export const sameData = (a: LineageFact, b: LineageFact): boolean => a.sourceCount === b.sourceCount && stable(a.value) === stable(b.value);

export function diffRuns(previous: LineageRun | null, current: LineageRun): ChangeEntry[] {
  const p = factMap(previous);
  const c = factMap(current);
  const keys = Array.from(new Set([...Object.keys(p), ...Object.keys(c)])).sort();
  return keys.map((k) => {
    const a = p[k];
    const b = c[k];
    const before = headline(a);
    const after = headline(b);
    const change: ChangeEntry['change'] = !a ? 'added' : !b ? 'removed' : sameData(a, b) ? 'unchanged' : 'changed';
    const relative = isNum(before) && isNum(after) && before !== 0 ? (after - before) / Math.abs(before) : null;
    return { metricKey: k, label: (b ?? a).label, change, before, after, relative, hashBefore: a?.contentHash ?? null, hashAfter: b?.contentHash ?? null };
  });
}
