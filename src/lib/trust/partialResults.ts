/**
 * Partial-failure reporting for bulk actions. Builds on `lib/bulk/engine`
 * (BulkResult already carries per-id failed/skipped). Adds: honest counts,
 * human reasons (never raw DB text), "retry failed only", and a safe CSV.
 */
import type { BulkResult } from '@/lib/bulk/engine';
import { classifyError, type AppErrorKind } from './appError';

export interface PartialSummary {
  requested: number;
  succeeded: number;
  failed: number;
  skipped: number;
  outcome: 'all' | 'partial' | 'none';
}

export function summarizePartial(r: BulkResult): PartialSummary {
  const succeeded = r.succeeded.length;
  const failed = r.failed.length;
  const skipped = r.skipped.length;
  return { requested: r.requested, succeeded, failed, skipped, outcome: succeeded === 0 ? 'none' : failed + skipped === 0 ? 'all' : 'partial' };
}

export interface ReasonRow {
  id: string;
  label: string;
  status: 'failed' | 'skipped';
  /** i18n key, never raw text. Skipped rows carry a business rule (shown as-is: it is authored by us, not the DB). */
  kind: AppErrorKind;
  /** Business-rule text for skipped rows (our own copy), empty for failures. */
  rule: string;
  retryable: boolean;
}

export function reasonRows(r: BulkResult, labelOf: (id: string) => string = (id) => id): ReasonRow[] {
  const rows: ReasonRow[] = [];
  for (const f of r.failed) {
    const e = classifyError(f.reason, { referenceId: 'INC-0000-0000', offline: false });
    rows.push({ id: f.id, label: labelOf(f.id), status: 'failed', kind: e.kind, rule: '', retryable: e.retryable });
  }
  for (const s of r.skipped) rows.push({ id: s.id, label: labelOf(s.id), status: 'skipped', kind: 'validation', rule: s.reason, retryable: false });
  return rows;
}

/** Combine the first run with a retry of only its failed ids. Skipped rows stay skipped. */
export function mergeRetry(prev: BulkResult, retry: BulkResult): BulkResult {
  const done = new Set([...prev.succeeded, ...retry.succeeded]);
  return {
    requested: prev.requested,
    succeeded: [...done],
    failed: retry.failed,
    skipped: prev.skipped,
  };
}

export async function retryFailedOnly(prev: BulkResult, rerun: (ids: string[]) => Promise<BulkResult>): Promise<BulkResult> {
  const ids = Array.from(new Set(prev.failed.map((f) => f.id)));
  if (ids.length === 0) return prev;
  return mergeRetry(prev, await rerun(ids));
}

/** CSV cell with RFC-4180 quoting and spreadsheet-formula neutralisation (=,+,-,@,tab,CR). */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface CsvLabels {
  id: string;
  name: string;
  status: string;
  reason: string;
  /** Resolves kind → already-translated sentence. */
  reasonFor: (kind: AppErrorKind) => string;
  failed: string;
  skipped: string;
}

export function failuresToCsv(r: BulkResult, labels: CsvLabels, labelOf?: (id: string) => string): string {
  const head = [labels.id, labels.name, labels.status, labels.reason].map(csvCell).join(',');
  const lines = reasonRows(r, labelOf).map((row) =>
    [row.id, row.label, row.status === 'failed' ? labels.failed : labels.skipped, row.status === 'skipped' ? row.rule : labels.reasonFor(row.kind)].map(csvCell).join(','),
  );
  return `﻿${[head, ...lines].join('\r\n')}\r\n`; // BOM so Excel reads Persian/UTF-8 correctly
}
