/** Staff — /staff/pmf (wrapped in <StaffRoute>): "how disappointed would you be" results and retention by segment. */
import { useCallback, useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { usePmfT } from '@/i18n/pmfNamespace';
import { formatNumber } from '@/lib/format';
import {
  PMF_DIMENSIONS, RETENTION_DIMENSIONS, overallPmf, pmfVerdict, retentionMatrix,
  type PmfDimension, type PmfSegmentRow, type RetentionDimension, type RetentionRow,
} from '@/lib/pmf';
import { fetchPmfSummary, fetchRetention } from '@/lib/pmfApi';

type Tab = 'survey' | 'retention';
type Load<T> = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: T };

const SELECT = 'focus-ring min-h-[44px] w-full rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary';
const DAY_OPTIONS = [90, 180, 365] as const;
const WEEK_OPTIONS = [8, 12, 26] as const;
const pct = (v: number) => formatNumber(v / 100, { style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: 1 });

export function StaffPmfPage() {
  const { t } = usePmfT();
  const [tab, setTab] = useState<Tab>('survey');
  const [days, setDays] = useState<number>(180);
  const [dim, setDim] = useState<PmfDimension>('plan');
  const [weeks, setWeeks] = useState<number>(12);
  const [rdim, setRdim] = useState<RetentionDimension>('plan');
  const [survey, setSurvey] = useState<Load<PmfSegmentRow[]>>({ kind: 'loading' });
  const [ret, setRet] = useState<Load<RetentionRow[]>>({ kind: 'loading' });

  const loadSurvey = useCallback(async () => {
    setSurvey({ kind: 'loading' });
    try { setSurvey({ kind: 'ready', data: await fetchPmfSummary(days, dim) }); } catch { setSurvey({ kind: 'error' }); }
  }, [days, dim]);
  const loadRet = useCallback(async () => {
    setRet({ kind: 'loading' });
    try { setRet({ kind: 'ready', data: await fetchRetention(weeks, rdim) }); } catch { setRet({ kind: 'error' }); }
  }, [weeks, rdim]);

  useEffect(() => { if (tab === 'survey') void loadSurvey(); }, [tab, loadSurvey]);
  useEffect(() => { if (tab === 'retention') void loadRet(); }, [tab, loadRet]);

  const segLabel = (s: string) => t(`staff.segment.${s}`, { defaultValue: s });
  const loading = (
    <div role="status" aria-live="polite">
      <span className="sr-only">…</span>
      <SkeletonCardList count={2} rows={3} />
    </div>
  );
  const failed = (retry: () => void) => (
    <EmptyStateError icon={WifiOff} title={t('staff.loadError')} description={t('staff.loadErrorHelp')} onRetry={retry} />
  );

  let body: React.ReactNode;
  if (tab === 'survey') {
    if (survey.kind === 'loading') body = loading;
    else if (survey.kind === 'error') body = failed(() => void loadSurvey());
    else if (survey.data.length === 0) body = <EmptyState icon={WifiOff} title={t('staff.empty.title')} description={t('staff.empty.text')} />;
    else {
      const total = overallPmf(survey.data);
      body = (
        <Card className="space-y-4 p-5 hover:translate-y-0">
          <p className="text-sm font-semibold text-text-primary">{t('staff.overall', { pct: formatNumber(total.pctVery, { maximumFractionDigits: 1 }), n: total.n })}</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <caption className="sr-only">{t('staff.title')}</caption>
              <thead>
                <tr className="text-start text-xs text-text-secondary">
                  {(['segment', 'n', 'very', 'somewhat', 'not', 'gone', 'pct', 'verdict'] as const).map((k) => (
                    <th key={k} scope="col" className="px-2 py-2 text-start font-medium">{t(`staff.table.${k}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {survey.data.map((r) => (
                  <tr key={r.segment} className="border-t border-border text-text-primary">
                    <th scope="row" className="px-2 py-2 text-start font-medium">{segLabel(r.segment)}</th>
                    <td className="px-2 py-2">{formatNumber(r.n)}</td>
                    <td className="px-2 py-2">{formatNumber(r.very)}</td>
                    <td className="px-2 py-2">{formatNumber(r.somewhat)}</td>
                    <td className="px-2 py-2">{formatNumber(r.notDisappointed)}</td>
                    <td className="px-2 py-2">{formatNumber(r.noLongerUse)}</td>
                    <td className="px-2 py-2 font-semibold">{pct(r.pctVery)}</td>
                    <td className="px-2 py-2 text-text-secondary">{t(`staff.verdict.${pmfVerdict(r)}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-text-secondary">{t('staff.note')}</p>
        </Card>
      );
    }
  } else if (ret.kind === 'loading') body = loading;
  else if (ret.kind === 'error') body = failed(() => void loadRet());
  else if (ret.data.length === 0) body = <EmptyState icon={WifiOff} title={t('staff.emptyRetention.title')} description={t('staff.emptyRetention.text')} />;
  else {
    const m = retentionMatrix(ret.data, weeks);
    body = (
      <Card className="space-y-3 p-5 hover:translate-y-0">
        <p className="text-sm text-text-secondary">{t('staff.retention.caption')}</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <caption className="sr-only">{t('staff.tabs.retention')}</caption>
            <thead>
              <tr className="text-xs text-text-secondary">
                <th scope="col" className="px-2 py-2 text-start font-medium">{t('staff.table.segment')}</th>
                {m.offsets.map((o) => <th key={o} scope="col" className="px-2 py-2 text-center font-medium">{t('staff.retention.week', { n: o })}</th>)}
              </tr>
            </thead>
            <tbody>
              {m.segments.map((s) => (
                <tr key={s} className="border-t border-border">
                  <th scope="row" className="px-2 py-2 text-start font-medium text-text-primary">{segLabel(s)}</th>
                  {m.offsets.map((o) => {
                    const c = m.cell(s, o);
                    return (
                      <td key={o} className="p-1 text-center">
                        {c ? (
                          <span className="relative block overflow-hidden rounded-md px-2 py-1.5" title={t('staff.retention.cohort', { active: c.activeAccounts, total: c.cohortAccounts })}>
                            <span aria-hidden="true" className="absolute inset-0 bg-accent" style={{ opacity: Math.min(c.retentionPct, 100) / 100 * 0.55 }} />
                            <span className="relative font-medium text-text-primary">{pct(c.retentionPct)}</span>
                          </span>
                        ) : <span className="text-text-secondary">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rdim !== 'all' && <p className="text-xs text-text-secondary">{t('staff.retention.planNote')}</p>}
      </Card>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold text-text-primary">{t('staff.title')}</h1>
      <p className="mb-6 mt-1 text-sm text-text-secondary">{t('staff.subtitle')}</p>

      <div role="tablist" aria-label={t('staff.title')} className="mb-4 flex gap-2">
        {(['survey', 'retention'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`focus-ring min-h-[44px] rounded-xl border px-4 text-sm font-semibold ${tab === k ? 'border-accent bg-accent text-on-accent' : 'border-border text-text-primary hover:bg-bg-tertiary'}`}
          >
            {t(`staff.tabs.${k}`)}
          </button>
        ))}
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        {tab === 'survey' ? (
          <>
            <div>
              <label htmlFor="pmf-dim" className="mb-1 block text-xs font-medium text-text-secondary">{t('staff.dimension')}</label>
              <select id="pmf-dim" className={SELECT} value={dim} onChange={(e) => setDim(e.target.value as PmfDimension)}>
                {PMF_DIMENSIONS.map((d) => <option key={d} value={d}>{t(`staff.dimensions.${d}`)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="pmf-days" className="mb-1 block text-xs font-medium text-text-secondary">{t('staff.days')}</label>
              <select id="pmf-days" className={SELECT} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {DAY_OPTIONS.map((d) => <option key={d} value={d}>{t('staff.daysOption', { count: d })}</option>)}
              </select>
            </div>
          </>
        ) : (
          <>
            <div>
              <label htmlFor="ret-dim" className="mb-1 block text-xs font-medium text-text-secondary">{t('staff.dimension')}</label>
              <select id="ret-dim" className={SELECT} value={rdim} onChange={(e) => setRdim(e.target.value as RetentionDimension)}>
                {RETENTION_DIMENSIONS.map((d) => <option key={d} value={d}>{t(`staff.dimensions.${d}`)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="ret-weeks" className="mb-1 block text-xs font-medium text-text-secondary">{t('staff.weeks')}</label>
              <select id="ret-weeks" className={SELECT} value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
                {WEEK_OPTIONS.map((w) => <option key={w} value={w}>{t('staff.weeksOption', { count: w })}</option>)}
              </select>
            </div>
          </>
        )}
      </div>

      {body}
    </main>
  );
}
