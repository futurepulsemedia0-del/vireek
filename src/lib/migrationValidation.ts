// src/lib/migrationValidation.ts
//
// Pure post-import validation for competitor-switching migrations. No React, no Supabase.
// The server aggregates (RPC migration_validation_snapshot) and the account's import history are
// the only inputs; this module turns them into pass / warn / fail checks. All money is integer cents —
// control totals are compared with ZERO tolerance on purpose: a migration that is "off by a few dollars"
// is a migration nobody has reconciled yet.

export type MigrationSource = 'service_titan' | 'jobber' | 'housecall_pro' | 'csv';
export const MIGRATION_SOURCES: readonly MigrationSource[] = ['service_titan', 'jobber', 'housecall_pro', 'csv'];
export const isMigrationSource = (v: unknown): v is MigrationSource => (MIGRATION_SOURCES as readonly unknown[]).includes(v);

export type MigrationEntity = 'customers' | 'jobs' | 'invoices' | 'line_items' | 'payments' | 'equipment';
export const MIGRATION_ENTITIES: readonly MigrationEntity[] = ['customers', 'jobs', 'invoices', 'line_items', 'payments', 'equipment'];

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info' | 'na';
export type Verdict = 'not_started' | 'ready' | 'review' | 'blocked';

/** Shape returned by the SQL function migration_validation_snapshot(p_source). Counts are bigint → number. */
export interface DuplicateGroup {
  kind: 'email' | 'phone' | 'name_address';
  size: number;
  members: { id: string; name: string; imported: boolean }[];
}

export interface MigrationSnapshot {
  source: MigrationSource;
  customers: { imported: number; duplicate_groups_total: number; duplicate_groups: DuplicateGroup[] };
  jobs: { imported: number; unlinked_customer: number; without_amount: number; revenue_cents: number };
  invoices: { count: number; unlinked_customer: number; unlinked_job: number; total_cents: number; balance_cents: number; totals_unverified: number };
  line_items: { count: number };
  payments: { count: number; sum_cents: number; unlinked_invoice: number };
  equipment: { count: number };
}

/** The slice of data_import_jobs this module needs (subset of ImportJobRecord). */
export interface ImportJobLite {
  id: string;
  source: string;
  import_type: string;
  status: string;
  total_rows: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  warning_count: number;
  created_at: string;
}

/** Numbers the customer reads off a report in the OLD system. Every field is optional. */
export interface ControlTotals {
  rows?: Partial<Record<MigrationEntity, number>>;
  jobRevenueCents?: number;
  invoiceTotalCents?: number;
  paymentsTotalCents?: number;
  openBalanceCents?: number;
}

export interface Check {
  id: string;
  group: 'counts' | 'unmatched' | 'duplicates' | 'money';
  entity?: MigrationEntity;
  status: CheckStatus;
  /** Numbers/strings for the UI to render through i18n; never pre-formatted prose. */
  expected?: number;
  actual?: number;
  diff?: number;
  isMoney?: boolean;
}

export interface ValidationReport {
  source: MigrationSource;
  verdict: Verdict;
  checks: Check[];
  summary: { pass: number; warn: number; fail: number; info: number; na: number };
  duplicateGroups: DuplicateGroup[];
  duplicateGroupsTotal: number;
}

// ------------------------------------------------------------------ money

/**
 * Parses what a person types from an old-system report ("$12,345.60", "(1,200.00)", "-50", "1234.5") into cents.
 * US number format only. Returns null for anything ambiguous (3+ decimals, letters, "1.234,56").
 */
export function parseMoneyToCents(input: string): number | null {
  let s = input.trim();
  if (!s) return null;
  const paren = /^\(.*\)$/.test(s);
  if (paren) s = s.slice(1, -1).trim();
  const minus = /^[-−]/.test(s);
  if (minus) s = s.slice(1).trim();
  if (paren && minus) return null;
  s = s.replace(/^\$/, '').trim();
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.replace(/,/g, '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return paren || minus ? -cents : cents;
}

export function parseCountInput(input: string): number | null {
  const s = input.trim().replace(/,/g, '');
  if (!/^\d{1,9}$/.test(s)) return null;
  return Number(s);
}

export function formatCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${neg ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ import history

/** Latest non-rolled-back finished job per entity for one source. Rolled-back and failed runs never count. */
export function latestJobsByEntity(jobs: ImportJobLite[], source: MigrationSource): Partial<Record<MigrationEntity, ImportJobLite>> {
  const out: Partial<Record<MigrationEntity, ImportJobLite>> = {};
  for (const j of jobs) {
    if (j.source !== source) continue;
    if (j.status !== 'completed' && j.status !== 'completed_with_errors') continue;
    if (!(MIGRATION_ENTITIES as readonly string[]).includes(j.import_type)) continue;
    const key = j.import_type as MigrationEntity;
    const cur = out[key];
    if (!cur || Date.parse(j.created_at) > Date.parse(cur.created_at)) out[key] = j;
  }
  return out;
}

// ------------------------------------------------------------------ report

const SNAPSHOT_COUNT: Record<MigrationEntity, (s: MigrationSnapshot) => number> = {
  customers: (s) => s.customers.imported,
  jobs: (s) => s.jobs.imported,
  invoices: (s) => s.invoices.count,
  line_items: (s) => s.line_items.count,
  payments: (s) => s.payments.count,
  equipment: (s) => s.equipment.count,
};

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function moneyCheck(id: string, actual: number, expected: number | undefined): Check {
  if (!isInt(expected)) return { id, group: 'money', status: 'info', actual, isMoney: true };
  const diff = actual - expected;
  return { id, group: 'money', status: diff === 0 ? 'pass' : 'fail', expected, actual, diff, isMoney: true };
}

function problemCheck(id: string, group: Check['group'], count: number, entity?: MigrationEntity): Check {
  return { id, group, ...(entity ? { entity } : {}), status: count > 0 ? 'warn' : 'pass', actual: count };
}

export function buildValidationReport(snapshot: MigrationSnapshot, jobs: ImportJobLite[], control: ControlTotals = {}): ValidationReport {
  const latest = latestJobsByEntity(jobs, snapshot.source);
  const checks: Check[] = [];

  for (const entity of MIGRATION_ENTITIES) {
    const job = latest[entity];
    const inDb = SNAPSHOT_COUNT[entity](snapshot);
    const expected = control.rows?.[entity];

    if (!job) {
      // Nothing finished for this entity. If rows exist anyway (older import, other path) say so; otherwise not applicable.
      checks.push({ id: `rows_accounted.${entity}`, group: 'counts', entity, status: inDb > 0 ? 'info' : 'na', actual: inDb });
      if (isInt(expected)) checks.push({ id: `matches_source.${entity}`, group: 'counts', entity, status: 'fail', expected, actual: 0, diff: -expected });
      continue;
    }

    const accounted = job.created_count + job.updated_count + job.skipped_count + job.error_count;
    checks.push({
      id: `rows_accounted.${entity}`, group: 'counts', entity,
      status: accounted === job.total_rows ? 'pass' : 'fail',
      expected: job.total_rows, actual: accounted, diff: accounted - job.total_rows,
    });
    if (isInt(expected)) {
      checks.push({
        id: `matches_source.${entity}`, group: 'counts', entity,
        status: job.total_rows === expected ? 'pass' : 'fail',
        expected, actual: job.total_rows, diff: job.total_rows - expected,
      });
    }
    checks.push(problemCheck(`row_errors.${entity}`, 'counts', job.error_count, entity));
    // Every created/updated row must be findable in the account afterwards. Fewer than created ⇒ something deleted it.
    checks.push({
      id: `present_in_account.${entity}`, group: 'counts', entity,
      status: inDb >= job.created_count ? 'pass' : 'fail',
      expected: job.created_count, actual: inDb, diff: inDb - job.created_count,
    });
  }

  checks.push(problemCheck('unmatched.jobs_without_customer', 'unmatched', snapshot.jobs.unlinked_customer, 'jobs'));
  checks.push(problemCheck('unmatched.invoices_without_customer', 'unmatched', snapshot.invoices.unlinked_customer, 'invoices'));
  checks.push(problemCheck('unmatched.invoices_without_job', 'unmatched', snapshot.invoices.unlinked_job, 'invoices'));
  checks.push(problemCheck('unmatched.payments_without_invoice', 'unmatched', snapshot.payments.unlinked_invoice, 'payments'));
  checks.push(problemCheck('unmatched.jobs_without_amount', 'unmatched', snapshot.jobs.without_amount, 'jobs'));

  checks.push({
    id: 'duplicates.customer_groups', group: 'duplicates', entity: 'customers',
    status: snapshot.customers.duplicate_groups_total > 0 ? 'warn' : 'pass', actual: snapshot.customers.duplicate_groups_total,
  });

  checks.push(moneyCheck('money.job_revenue', snapshot.jobs.revenue_cents, control.jobRevenueCents));
  checks.push(moneyCheck('money.invoice_total', snapshot.invoices.total_cents, control.invoiceTotalCents));
  checks.push(moneyCheck('money.payments_total', snapshot.payments.sum_cents, control.paymentsTotalCents));
  checks.push(moneyCheck('money.open_balance', snapshot.invoices.balance_cents, control.openBalanceCents));
  checks.push(problemCheck('money.invoice_lines_dont_add_up', 'money', snapshot.invoices.totals_unverified, 'invoices'));

  const summary = { pass: 0, warn: 0, fail: 0, info: 0, na: 0 };
  for (const c of checks) summary[c.status]++;

  const anyImported = MIGRATION_ENTITIES.some((e) => latest[e] || SNAPSHOT_COUNT[e](snapshot) > 0);
  const verdict: Verdict = !anyImported ? 'not_started' : summary.fail > 0 ? 'blocked' : summary.warn > 0 ? 'review' : 'ready';

  return {
    source: snapshot.source, verdict, checks, summary,
    duplicateGroups: snapshot.customers.duplicate_groups,
    duplicateGroupsTotal: snapshot.customers.duplicate_groups_total,
  };
}

// ------------------------------------------------------------------ CSV export (no customer PII)

const csvCell = (v: string | number | undefined): string => {
  let s = v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // formula-injection guard; plain negative numbers are safe
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function reportToCsv(report: ValidationReport): string {
  const rows = [['check', 'group', 'entity', 'status', 'expected', 'actual', 'difference', 'unit']];
  for (const c of report.checks) {
    const cents = Boolean(c.isMoney);
    const fmt = (n: number | undefined) => (n === undefined ? '' : cents ? (n / 100).toFixed(2) : String(n));
    rows.push([c.id, c.group, c.entity ?? '', c.status, fmt(c.expected), fmt(c.actual), fmt(c.diff), cents ? 'usd' : 'count']);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ------------------------------------------------------------------ untrusted-input normalisers

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const DUP_KINDS = ['email', 'phone', 'name_address'] as const;
const isDupKind = (v: unknown): v is DuplicateGroup['kind'] => (DUP_KINDS as readonly unknown[]).includes(v);

/** The RPC result crosses a network boundary: coerce everything, never trust the shape. */
export function normalizeSnapshot(raw: unknown, source: MigrationSource): MigrationSnapshot {
  const r = rec(raw), c = rec(r.customers), j = rec(r.jobs), i = rec(r.invoices), l = rec(r.line_items), p = rec(r.payments), e = rec(r.equipment);
  const groups: DuplicateGroup[] = (Array.isArray(c.duplicate_groups) ? c.duplicate_groups : []).flatMap((g): DuplicateGroup[] => {
    const o = rec(g);
    if (!isDupKind(o.kind)) return [];
    const members = (Array.isArray(o.members) ? o.members : []).map((m) => {
      const mm = rec(m);
      return { id: String(mm.id ?? ''), name: String(mm.name ?? ''), imported: mm.imported === true };
    });
    return [{ kind: o.kind, size: num(o.size), members }];
  });
  return {
    source,
    customers: { imported: num(c.imported), duplicate_groups_total: num(c.duplicate_groups_total), duplicate_groups: groups },
    jobs: { imported: num(j.imported), unlinked_customer: num(j.unlinked_customer), without_amount: num(j.without_amount), revenue_cents: num(j.revenue_cents) },
    invoices: { count: num(i.count), unlinked_customer: num(i.unlinked_customer), unlinked_job: num(i.unlinked_job), total_cents: num(i.total_cents), balance_cents: num(i.balance_cents), totals_unverified: num(i.totals_unverified) },
    line_items: { count: num(l.count) },
    payments: { count: num(p.count), sum_cents: num(p.sum_cents), unlinked_invoice: num(p.unlinked_invoice) },
    equipment: { count: num(e.count) },
  };
}

const optInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);

export function normalizeControlTotals(raw: unknown): ControlTotals {
  const r = rec(raw), rows = rec(r.rows);
  const out: ControlTotals = {};
  const outRows: Partial<Record<MigrationEntity, number>> = {};
  for (const e of MIGRATION_ENTITIES) { const n = optInt(rows[e]); if (n !== undefined && n >= 0) outRows[e] = n; }
  if (Object.keys(outRows).length) out.rows = outRows;
  for (const k of ['jobRevenueCents', 'invoiceTotalCents', 'paymentsTotalCents', 'openBalanceCents'] as const) {
    const n = optInt(r[k]);
    if (n !== undefined) out[k] = n;
  }
  return out;
}
