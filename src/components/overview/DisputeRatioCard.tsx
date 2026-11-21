import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Scale } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useDisputeRatioT } from '@/i18n/disputeRatioNamespace';
import { fetchTenantDisputeRatio } from '@/lib/disputeRatioApi';
import { formatMonth, formatRatio, latestMonths, levelTone, trend, type TenantMonthRow } from '@/lib/disputeRatio';

type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; rows: TenantMonthRow[] };

const TONE_TEXT = { success: 'text-success', warning: 'text-warning', danger: 'text-danger', neutral: 'text-text-secondary' } as const;
const TONE_BAR = { success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', neutral: 'bg-bg-tertiary' } as const;

/** Overview widget (billing permission): monthly dispute ratio with internal early-warning levels. */
export function DisputeRatioCard() {
  const { t, language } = useDisputeRatioT();
  const { user, teamMember, isOwner } = useAuth();
  const ownerId = isOwner ? user?.id : teamMember?.account_owner_id; // accountOwnerId scoping
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  const refresh = useCallback(async () => {
    if (!ownerId) return;
    setLoad({ status: 'loading' });
    try {
      setLoad({ status: 'ready', rows: await fetchTenantDisputeRatio(ownerId, 6) });
    } catch {
      setLoad({ status: 'error' });
    }
  }, [ownerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = load.status === 'ready' ? latestMonths(load.rows, 6) : [];
  const current = rows[0];
  const tone = current ? levelTone(current.level) : 'neutral';
  const dir = load.status === 'ready' ? trend(load.rows) : null;
  const maxPct = Math.max(0.0001, ...rows.map((r) => r.ratio_pct ?? 0), current?.critical_pct ?? 0);

  return (
    <div className="h-full rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-center justify-between gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-warning-subtle text-warning">
          <Scale size={20} aria-hidden="true" />
        </span>
        <Link to="/dashboard/disputes" className="focus-ring rounded-lg text-xs font-medium text-accent hover:underline">
          {t('viewDisputes')}
        </Link>
      </div>

      <p className="mt-4 text-sm font-medium text-text-primary">{t('title')}</p>
      <p className="text-xs text-text-secondary">{t('subtitle')}</p>

      {load.status === 'loading' && <div className="mt-3 h-9 w-28 animate-pulse rounded bg-bg-tertiary" role="status" aria-label={t('loading')} />}

      {load.status === 'error' && (
        <div className="mt-3 text-sm text-text-secondary" role="alert">
          {t('loadFailed')}{' '}
          <button type="button" onClick={() => void refresh()} className="focus-ring rounded font-medium text-accent hover:underline">
            {t('retry')}
          </button>
        </div>
      )}

      {load.status === 'ready' && !current && <p className="mt-3 text-sm text-text-secondary">{t('empty')}</p>}

      {load.status === 'ready' && current && (
        <>
          <p className={`mt-3 text-3xl font-bold ${TONE_TEXT[tone]}`} dir="ltr">{formatRatio(current.ratio_pct, language)}</p>
          <p className="text-xs text-text-secondary">
            {formatMonth(current.month, language)} · {t('disputesOf', { disputes: current.disputes_count, payments: current.txn_count })}
          </p>
          <p className={`mt-1 text-xs font-medium ${TONE_TEXT[tone]}`}>{t(`levels.${current.level}`)}</p>
          {dir && <p className="text-xs text-text-secondary">{t(`trend.${dir}`)}</p>}

          <div className="mt-4 border-t border-border pt-4">
            <p className="text-xs font-medium text-text-secondary">{t('history')}</p>
            <ul className="mt-2 space-y-1.5">
              {rows.map((r) => (
                <li key={r.month} className="flex items-center gap-2 text-xs">
                  <span className="w-20 shrink-0 text-text-secondary">{formatMonth(r.month, language)}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded bg-bg-tertiary" aria-hidden="true">
                    <span className={`block h-full rounded ${TONE_BAR[levelTone(r.level)]}`} style={{ width: `${Math.round(((r.ratio_pct ?? 0) / maxPct) * 100)}%` }} />
                  </span>
                  <span className="w-16 shrink-0 text-end text-text-primary" dir="ltr">{formatRatio(r.ratio_pct, language)}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-text-secondary">
            {t('thresholdNote', {
              warning: formatRatio(current.warning_pct, language),
              critical: formatRatio(current.critical_pct, language),
            })}
          </p>
        </>
      )}
    </div>
  );
}
