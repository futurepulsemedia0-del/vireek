import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Download, Info, Loader2, RotateCcw, Undo2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SkeletonStatGrid, SkeletonCardList } from '@/components/Skeleton';
import type { ImportType } from '@/lib/importPresets';
import {
  STRATEGY_OPTIONS, type DedupeStrategy, type RunResult, type ValidateResult, type ValidateRow,
} from '@/lib/importWizard';

export type RowFilter = 'attention' | 'error' | 'warning' | 'skip' | 'create' | 'update' | 'all';

const money = (v: string) => (v === '' || Number.isNaN(Number(v)) ? '' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(Number(v)));
const when = (iso: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

const hasWarning = (r: ValidateRow) => r.issues.some((i) => i.severity === 'warning');

function matchesFilter(r: ValidateRow, f: RowFilter): boolean {
  switch (f) {
    case 'all': return true;
    case 'attention': return r.action === 'error' || hasWarning(r);
    case 'error': return r.action === 'error';
    case 'warning': return hasWarning(r);
    default: return r.action === f;
  }
}

export function defaultFilter(v: ValidateResult): RowFilter {
  if (v.summary.error > 0) return 'error';
  if (v.summary.warnings > 0) return 'warning';
  return 'all';
}

function ActionBadge({ row }: { row: ValidateRow }) {
  const tone =
    row.action === 'create' ? 'bg-success/10 text-success'
    : row.action === 'update' ? 'bg-accent/10 text-accent'
    : row.action === 'error' ? 'bg-danger/10 text-danger'
    : 'bg-bg-tertiary text-text-secondary';
  const label =
    row.action === 'create' ? 'New'
    : row.action === 'update' ? 'Update'
    : row.action === 'error' ? 'Error'
    : row.matched_by === 'in_file' ? 'Duplicate in file'
    : row.matched_by ? 'Already in Vireek'
    : 'Skipped';
  return <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${tone}`}>{label}</span>;
}

function detailLine(row: ValidateRow, type: ImportType): string {
  const d = row.display;
  const parts = type === 'customers' ? [d.phone, d.email, d.address] : [d.service, when(d.date), money(d.amount)];
  return parts.filter(Boolean).join(' · ');
}

// ===================================================================== review

interface ReviewProps {
  importType: ImportType;
  validation: ValidateResult | null;
  validating: boolean;
  error: string | null;
  dedupe: DedupeStrategy;
  onDedupe: (s: DedupeStrategy) => void;
  filter: RowFilter;
  onFilter: (f: RowFilter) => void;
  onRetry: () => void;
}

export function ImportReviewStep({ importType, validation, validating, error, dedupe, onDedupe, filter, onFilter, onRetry }: ReviewProps) {
  const visible = useMemo(() => (validation ? validation.rows.filter((r) => matchesFilter(r, filter)) : []), [validation, filter]);
  const s = validation?.summary;

  const chips: { id: RowFilter; label: string; count: number }[] = s
    ? [
        { id: 'error', label: 'Errors', count: s.error },
        { id: 'warning', label: 'Warnings', count: s.warnings },
        { id: 'skip', label: 'Skipped', count: s.skip },
        { id: 'update', label: 'Updates', count: s.update },
        { id: 'create', label: 'New', count: s.create },
        { id: 'all', label: 'All', count: s.total },
      ]
    : [];
  const filterTotal = chips.find((c) => c.id === filter)?.count ?? 0;

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-text-primary">When a record already exists in Vireek</legend>
        <div className="grid gap-2 md:grid-cols-3" role="radiogroup">
          {STRATEGY_OPTIONS.map((o) => (
            <label key={o.value} className={`focus-within:ring-2 focus-within:ring-accent/40 cursor-pointer rounded-xl border p-3 text-sm transition-colors ${dedupe === o.value ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/40'}`}>
              <input type="radio" name="dedupe" value={o.value} checked={dedupe === o.value} onChange={() => onDedupe(o.value)} disabled={validating} className="sr-only" />
              <span className="block font-semibold text-text-primary">{o.label}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-text-secondary">{o.description}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {error ? (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-danger/30 bg-danger/5 p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-danger"><XCircle size={18} /> We couldn’t check your file</p>
          <p className="text-sm text-text-secondary">{error}</p>
          <Button size="sm" variant="secondary" onClick={onRetry}><RotateCcw size={16} /> Try again</Button>
        </div>
      ) : validating || !validation || !s ? (
        <div aria-busy="true" aria-live="polite" className="space-y-4">
          <p className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={16} className="animate-spin" /> Checking every row against your existing records…</p>
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={3} rows={2} />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Import summary">
            {[
              ['Will be added', s.create, 'text-success'],
              ['Will be updated', s.update, 'text-accent'],
              ['Skipped', s.skip, 'text-text-primary'],
              ['Rows with errors', s.error, s.error > 0 ? 'text-danger' : 'text-text-primary'],
            ].map(([label, n, tone]) => (
              <div key={label as string} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <p className={`text-2xl font-bold tabular-nums ${tone}`}>{(n as number).toLocaleString()}</p>
                <p className="text-xs text-text-secondary">{label}</p>
              </div>
            ))}
          </div>

          {!validation.can_import && (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-text-primary">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" /> {validation.blocking_reason}
            </div>
          )}
          {validation.can_import && s.error > 0 && (
            <p className="flex items-start gap-2 text-sm text-text-secondary"><Info size={16} className="mt-0.5 shrink-0" /> {s.error.toLocaleString()} row{s.error === 1 ? '' : 's'} with errors will be skipped and saved, so you can download them, fix them and import again.</p>
          )}

          <div role="tablist" aria-label="Filter rows" className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <button key={c.id} role="tab" aria-selected={filter === c.id} onClick={() => onFilter(c.id)} className={`focus-ring rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${filter === c.id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>
                {c.label} <span className="tabular-nums">{c.count.toLocaleString()}</span>
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">
              {filterTotal === 0 ? 'Nothing in this category — that’s good news.' : 'Those rows are outside the preview sample, but they are all included in the import.'}
            </div>
          ) : (
            <ul className="space-y-2" aria-label="Row preview">
              {visible.map((r) => (
                <li key={r.row_number} className="rounded-xl border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs tabular-nums text-text-secondary">Row {r.row_number}</span>
                    <ActionBadge row={r} />
                    <span className="min-w-0 truncate text-sm font-semibold text-text-primary">{r.label}</span>
                  </div>
                  {detailLine(r, importType) && <p className="mt-1 break-words text-xs text-text-secondary">{detailLine(r, importType)}</p>}
                  {r.issues.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {r.issues.map((i, idx) => (
                        <li key={idx} className={`flex items-start gap-1.5 text-xs ${i.severity === 'error' ? 'text-danger' : i.severity === 'warning' ? 'text-amber-600' : 'text-text-secondary'}`}>
                          {i.severity === 'info' ? <Info size={13} className="mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0" />} {i.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          {validation.rows_truncated && (
            <p className="text-xs text-text-secondary">Showing a sample of the most important rows. The counts above cover your whole file.</p>
          )}
        </>
      )}
    </div>
  );
}

// ======================================================================= done

interface DoneProps {
  result: RunResult;
  importType: ImportType;
  busy: boolean;
  onDownloadErrors: () => void;
  onUndo: () => void;
  onAnother: () => void;
}

export function ImportDoneStep({ result, importType, busy, onDownloadErrors, onUndo, onAnother }: DoneProps) {
  const failed = result.status === 'failed';
  const stats: [string, number][] = [
    ['Added', result.created_count], ['Updated', result.updated_count], ['Skipped', result.skipped_count], ['Errors', result.error_count],
  ];
  return (
    <div className="space-y-5" aria-live="polite">
      <div className="flex items-start gap-3">
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${failed ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success'}`}>
          {failed ? <XCircle size={22} /> : <CheckCircle2 size={22} />}
        </span>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">{failed ? 'Nothing could be imported' : result.status === 'completed' ? 'Import complete' : 'Import finished with some errors'}</h2>
          <p className="text-sm text-text-secondary">
            {result.total_rows.toLocaleString()} rows processed{result.warning_count > 0 ? ` · ${result.warning_count.toLocaleString()} with warnings` : ''}. {failed ? 'Check the column mapping and the file, then try again.' : 'You can undo this import from the history below.'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map(([label, n]) => (
          <div key={label} className="rounded-2xl border border-border bg-bg-secondary p-4">
            <p className={`text-2xl font-bold tabular-nums ${label === 'Errors' && n > 0 ? 'text-danger' : 'text-text-primary'}`}>{n.toLocaleString()}</p>
            <p className="text-xs text-text-secondary">{label}</p>
          </div>
        ))}
      </div>

      {result.errors.length > 0 && (
        <div className="rounded-2xl border border-border p-4">
          <p className="mb-2 text-sm font-semibold text-text-primary">Rows that need attention</p>
          <ul className="max-h-56 space-y-1 overflow-y-auto text-sm">
            {result.errors.map((e) => (
              <li key={e.row_number} className="flex gap-2 text-text-secondary"><span className="shrink-0 tabular-nums text-text-primary">Row {e.row_number}</span> {e.error_message}</li>
            ))}
          </ul>
          {result.error_count > result.errors.length && <p className="mt-2 text-xs text-text-secondary">+ {(result.error_count - result.errors.length).toLocaleString()} more — download them all to fix.</p>}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {result.error_count > 0 && <Button variant="secondary" size="sm" onClick={onDownloadErrors} disabled={busy}><Download size={16} /> Download failed rows</Button>}
        {!failed && importType === 'customers' && <Link to="/dashboard/customers" className="focus-ring inline-flex min-h-[40px] items-center justify-center rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary hover:border-accent/40">View customers</Link>}
        {!failed && importType === 'jobs' && <Link to="/dashboard/jobs" className="focus-ring inline-flex min-h-[40px] items-center justify-center rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary hover:border-accent/40">View jobs</Link>}
        {!failed && <Button variant="ghost" size="sm" onClick={onUndo} disabled={busy}><Undo2 size={16} /> Undo this import</Button>}
        <Button size="sm" onClick={onAnother}>Import another file</Button>
      </div>
    </div>
  );
}
