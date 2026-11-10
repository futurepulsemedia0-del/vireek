// Reference connector: export completed/invoiced jobs as an accounting-import CSV
// (one invoice line per job). Works with any accounting package that imports a flat CSV.
// Input rows are `jobs` records exactly as the public API returns them; only the allowlisted
// fields are read, and no customer contact details (address, phone, e-mail, notes) are exported.

import { defineConnector, pickFields, type Connector, type ConnectorResult, type SkippedRecord } from './sdk';

export const ACCOUNTING_CSV_COLUMNS = ['InvoiceDate', 'Reference', 'Customer', 'Description', 'Amount', 'Status'] as const;

const READABLE_JOB_FIELDS = ['id', 'customer_name', 'service_type', 'invoice_amount', 'invoice_status', 'completed_at', 'created_at'] as const;

export interface AccountingCsvOutput {
  csv: string;
  filename: string;
}

/** Neutralises spreadsheet formula injection (=, +, -, @, tab, CR) and applies RFC 4180 quoting. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Exact 2-decimal amount via integer cents (no float drift). Returns null for non-finite or negative input. */
export function formatAmount(raw: unknown): string | null {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const cents = Math.round(n * 100);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function isoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

export const accountingCsvConnector: Connector<Record<string, unknown>[], AccountingCsvOutput> = defineConnector({
  manifest: {
    id: 'accounting-csv',
    name: 'Accounting CSV export',
    version: '1.0.0',
    direction: 'export',
    requiredScopes: ['jobs:read'],
    readableFields: { jobs: READABLE_JOB_FIELDS },
  },

  run(rows, ctx): ConnectorResult<AccountingCsvOutput> {
    const lines: string[] = [ACCOUNTING_CSV_COLUMNS.join(',')];
    const skipped: SkippedRecord[] = [];
    const seen = new Set<string>();

    for (const raw of rows) {
      const job = pickFields(raw, READABLE_JOB_FIELDS);
      const id = typeof job.id === 'string' ? job.id : '';
      if (!id) { skipped.push({ id: '(missing)', reason: 'missing_id' }); continue; }
      if (seen.has(id)) { skipped.push({ id, reason: 'duplicate_id' }); continue; }
      seen.add(id);

      const amount = formatAmount(job.invoice_amount);
      if (amount === null) { skipped.push({ id, reason: 'no_valid_invoice_amount' }); continue; }
      if (job.invoice_status === 'void' || job.invoice_status === 'cancelled') { skipped.push({ id, reason: 'invoice_not_billable' }); continue; }
      const date = isoDate(job.completed_at) ?? isoDate(job.created_at);
      if (!date) { skipped.push({ id, reason: 'no_valid_date' }); continue; }

      lines.push([date, id, job.customer_name, job.service_type, amount, job.invoice_status].map(csvCell).join(','));
    }

    return {
      output: { csv: lines.join('\r\n') + '\r\n', filename: `vireek-accounting-${ctx.now.toISOString().slice(0, 10)}.csv` },
      processed: lines.length - 1,
      skipped,
    };
  },
});
