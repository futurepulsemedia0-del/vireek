import { useCallback, useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { useTrustT } from '@/hooks/useTrustT';
import { describeEntry, fetchRecordHistory, type HistoryEntry, type HistoryTable } from '@/lib/trust/recordHistory';
import { formatAction } from '@/lib/auditLog';
import type { AppError } from '@/lib/trust/appError';

interface Props {
  table: HistoryTable;
  recordId: string;
  className?: string;
}

/** "History" tab body for any record: who changed what, when, from where. Owner-only (enforced by the RPC). */
export function RecordHistory({ table, recordId, className = '' }: Props) {
  const { t, language } = useTrustT();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const r = await fetchRecordHistory(table, recordId);
    if (r.ok) setEntries(r.entries);
    else setError(r.error);
  }, [table, recordId]);

  useEffect(() => {
    setEntries(null);
    void load();
  }, [load]);

  if (error) {
    return error.kind === 'permission' ? (
      <EmptyState icon={History} variant="no-permission" title={t('history.noAccess')} />
    ) : (
      <EmptyStateError icon={History} title={t('history.loadFailed')} onRetry={() => void load()} />
    );
  }
  if (entries === null) return <div role="status" aria-busy="true" className="h-24 animate-pulse rounded-xl bg-bg-secondary motion-reduce:animate-none" />;
  if (entries.length === 0) return <EmptyState icon={History} title={t('history.empty')} description={t('history.emptyHint')} />;

  const fmt = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <ol className={`space-y-3 ${className}`}>
      {entries.map((e) => {
        const d = describeEntry(e);
        return (
          <li key={e.id} className="rounded-xl border border-border bg-bg-secondary p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-text-primary">{formatAction(e.action)}</span>
              <time dateTime={e.created_at} className="text-xs text-text-secondary">{fmt.format(new Date(e.created_at))}</time>
            </div>
            <p className="mt-0.5 text-xs text-text-secondary">{t('history.by', { who: e.actor_email ?? t('history.system') })}</p>
            {d?.kind === 'diff' && (
              <ul className="mt-2 space-y-1 text-xs">
                {d.rows.map((r) => (
                  <li key={r.field} dir="auto">
                    <span className="font-medium text-text-primary">{r.field}</span>: <span className="text-text-secondary">{r.from}</span> → <span className="text-text-primary">{r.to}</span>
                  </li>
                ))}
              </ul>
            )}
            {(e.ip_address || e.user_agent) && (
              <p dir="ltr" className="mt-2 truncate text-[11px] text-text-secondary" title={e.user_agent ?? undefined}>
                {e.ip_address}{e.ip_address && e.user_agent ? ' · ' : ''}{e.user_agent}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
