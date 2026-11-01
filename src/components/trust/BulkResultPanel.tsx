import { useState } from 'react';
import { CircleAlert, Download, RefreshCw, X } from 'lucide-react';
import { useTrustT } from '@/hooks/useTrustT';
import type { BulkResult } from '@/lib/bulk/engine';
import { failuresToCsv, reasonRows, summarizePartial } from '@/lib/trust/partialResults';

interface Props {
  result: BulkResult;
  /** Human label for an id (e.g. job title). Falls back to the id. */
  labelOf?: (id: string) => string;
  /** Re-runs ONLY the failed ids. Omit to hide the button. */
  onRetryFailed?: () => Promise<void>;
  onDismiss: () => void;
  className?: string;
}

/** "47 succeeded, 3 failed" with an expandable reason list, CSV download and "Retry failed only". */
export function BulkResultPanel({ result, labelOf, onRetryFailed, onDismiss, className = '' }: Props) {
  const { t } = useTrustT();
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const s = summarizePartial(result);
  const rows = reasonRows(result, labelOf);

  const headline =
    s.outcome === 'none' ? t('bulk.none') : s.skipped ? t('bulk.partialSkipped', { succeeded: s.succeeded, failed: s.failed, skipped: s.skipped }) : t('bulk.partial', { succeeded: s.succeeded, failed: s.failed });

  const download = () => {
    const csv = failuresToCsv(
      result,
      {
        id: t('bulk.colId'), name: t('bulk.colName'), status: t('bulk.colStatus'), reason: t('bulk.colReason'),
        failed: t('bulk.failed'), skipped: t('bulk.skipped'),
        reasonFor: (kind) => `${t(`error.${kind}.title`)} — ${t(`error.${kind}.body`)}`,
      },
      labelOf,
    );
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `vireek-bulk-report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const retry = async () => {
    if (!onRetryFailed || retrying) return;
    setRetrying(true);
    try {
      await onRetryFailed();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <section role="status" aria-live="polite" className={`rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark ${className}`}>
      <div className="flex items-start gap-3">
        <CircleAlert size={20} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">{headline}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {onRetryFailed && s.failed > 0 && (
              <button type="button" onClick={retry} disabled={retrying} className="focus-ring inline-flex items-center gap-1.5 rounded-lg bg-cta px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-60">
                <RefreshCw size={13} className={retrying ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />
                {retrying ? t('bulk.retrying') : t('bulk.retryFailed')}
              </button>
            )}
            <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
              {open ? t('bulk.hideReasons') : t('bulk.showReasons')}
            </button>
            <button type="button" onClick={download} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
              <Download size={13} aria-hidden="true" />
              {t('bulk.download')}
            </button>
          </div>
          {open && (
            <ul className="mt-3 max-h-56 space-y-1.5 overflow-auto text-xs">
              {rows.map((r) => (
                <li key={`${r.status}-${r.id}`} className="rounded-lg bg-bg-primary px-3 py-2">
                  <span className="font-medium text-text-primary">{r.label}</span>
                  <span className="text-text-secondary"> — {r.status === 'skipped' ? r.rule : t(`error.${r.kind}.title`)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="button" onClick={onDismiss} aria-label={t('bulk.dismiss')} className="focus-ring shrink-0 rounded p-1 text-text-secondary hover:text-text-primary">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
