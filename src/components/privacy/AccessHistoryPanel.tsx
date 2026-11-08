import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, ShieldCheck } from 'lucide-react';
import { ACCESS_LOG_NS } from '@/lib/privacy/i18n';
import { AccessLogError, fetchAccessHistory, type AccessHistoryRow } from '@/lib/privacy/accessLog';

interface Props {
  /** Table of the record, e.g. "calls". */
  targetTable: string;
  /** UUID of the record. */
  targetId: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; rows: AccessHistoryRow[] }
  | { kind: 'forbidden' }
  | { kind: 'error' };

export function AccessHistoryPanel({ targetTable, targetId }: Props) {
  const { t, i18n } = useTranslation(ACCESS_LOG_NS);
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'ready', rows: await fetchAccessHistory(targetTable, targetId) });
    } catch (e) {
      setState(e instanceof AccessLogError && e.kind === 'forbidden' ? { kind: 'forbidden' } : { kind: 'error' });
    }
  }, [targetTable, targetId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchAccessHistory(targetTable, targetId);
        if (!cancelled) setState({ kind: 'ready', rows });
      } catch (e) {
        if (!cancelled) setState(e instanceof AccessLogError && e.kind === 'forbidden' ? { kind: 'forbidden' } : { kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetTable, targetId]);

  // Forbidden = the viewer simply may not see this; render nothing instead of an error.
  if (state.kind === 'forbidden') return null;

  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const who = (r: AccessHistoryRow): string => {
    if (r.isYou) return t('history.you');
    switch (r.viewerKind) {
      case 'vireek_support': return t('history.support');
      case 'api_key': return t('history.apiKey');
      case 'system': return t('history.system');
      case 'public_link': return t('history.publicLink');
      default: return r.viewerEmail ?? t('history.unknownUser');
    }
  };

  return (
    <section aria-labelledby="access-history-title" className="rounded-2xl border border-border bg-bg-secondary p-4">
      <h2 id="access-history-title" className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
        <ShieldCheck size={16} aria-hidden="true" />
        {t('history.title')}
      </h2>

      {state.kind === 'loading' && (
        <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {t('history.loading')}
        </p>
      )}

      {state.kind === 'error' && (
        <div role="alert" className="flex items-center gap-2 text-sm text-text-secondary">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{t('history.error')}</span>
          <button type="button" onClick={() => void load()} className="font-medium text-accent underline focus:outline-none focus:ring-2 focus:ring-accent/40">
            {t('history.retry')}
          </button>
        </div>
      )}

      {state.kind === 'ready' && state.rows.length === 0 && <p className="text-sm text-text-secondary">{t('history.empty')}</p>}

      {state.kind === 'ready' && state.rows.length > 0 && (
        <ul className="divide-y divide-border">
          {state.rows.map((r, i) => (
            <li key={`${r.occurredAt}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 text-sm">
              <span className="text-text-primary">
                <span className="font-medium">{who(r)}</span>{' '}
                {t(`history.actions.${r.action}`, { defaultValue: r.action })}{' '}
                {t(`history.assets.${r.assetClass}`)}
                {r.recordCount > 1 ? ` · ${t('history.records', { count: r.recordCount })}` : ''}
              </span>
              <time dateTime={r.occurredAt} className="text-xs text-text-secondary">{fmt.format(new Date(r.occurredAt))}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
