// /staff/nexus — sales-tax / VAT nexus tracker (Vireek employees only).
// Data: staff_nexus_revenue() RPC (20290304000000_nexus_tracker.sql), which re-checks is_vireek_staff server-side and
// audit-logs the read; this page sits behind <StaffRoute> as well. Thresholds come from config/nexus-thresholds.json
// ([COUNSEL][VERIFY], none invented). Internal early-warning aid, not a legal determination.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Globe2, Loader2, RefreshCw, TriangleAlert as AlertTriangle } from 'lucide-react';
import { Header } from '@/components/Header';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { useSEO } from '@/lib/seo';
import { useNexusT } from '@/i18n/nexusNamespace';
import { fetchNexusRevenue, logNexusExport } from '@/lib/nexus/nexusApi';
import {
  buildTracker,
  coverageGap,
  formatMoney,
  formatPct,
  parseNexusConfig,
  summarize,
  trackerToCsv,
  type NexusStatus,
  type RevenueReport,
  type TrackerRow,
} from '@/lib/nexus/nexusTracker';
import rawConfig from '../../../config/nexus-thresholds.json';

const { config: NEXUS_CONFIG, problems: CONFIG_PROBLEMS } = parseNexusConfig(rawConfig);

const STATUS_STYLE: Record<NexusStatus, string> = {
  exceeded: 'bg-danger/10 text-danger',
  approaching: 'bg-warning-500/10 text-warning-500',
  below: 'bg-success-500/10 text-success-500',
  not_configured: 'bg-bg-tertiary text-text-secondary',
  currency_mismatch: 'bg-warning-500/10 text-warning-500',
};
const STATUS_ORDER: NexusStatus[] = ['exceeded', 'approaching', 'below', 'currency_mismatch', 'not_configured'];

type LoadState = 'loading' | 'ready' | 'error' | 'forbidden';

function SEO() {
  const { t } = useNexusT();
  useSEO({ title: t('seo.title'), description: t('seo.description'), canonical: 'https://vireek.com/staff/nexus' });
  return null;
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'bad' | 'warn' | 'good' }) {
  const color = tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warning-500' : tone === 'good' ? 'text-success-500' : 'text-text-primary';
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <p className="text-sm font-medium text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function isForbidden(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '42501';
}

export function StaffNexusPage() {
  const { t, language } = useNexusT();
  const { toast } = useToast();
  const [state, setState] = useState<LoadState>('loading');
  const [report, setReport] = useState<RevenueReport | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [asOf, setAsOf] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | NexusStatus>('all');
  const [showZero, setShowZero] = useState(false);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  const loadId = useRef(0);
  const load = useCallback(
    async (silent = false) => {
      const id = ++loadId.current;
      if (silent) setRefreshing(true);
      else setState('loading');
      try {
        const r = await fetchNexusRevenue(asOf || undefined);
        if (id !== loadId.current) return;
        setReport(r);
        setState('ready');
      } catch (e) {
        if (id !== loadId.current) return;
        if (isForbidden(e)) setState('forbidden');
        else {
          setErrorMsg(e instanceof Error ? e.message : '');
          setState('error');
        }
      } finally {
        if (id === loadId.current) setRefreshing(false);
      }
    },
    // `t` is deliberately not a dependency: its identity changes when a locale bundle loads, which would refetch
    // (and write a second audit row) for no reason.
    [asOf],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => (report ? buildTracker(report, NEXUS_CONFIG) : []), [report]);
  const summary = useMemo(() => summarize(rows, NEXUS_CONFIG), [rows]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== 'all' && r.status !== status) return false;
      if (!showZero && r.invoices === 0 && r.grossCents === 0) return false;
      return !q || r.key.toLowerCase().includes(q) || r.name.toLowerCase().includes(q);
    });
  }, [rows, query, status, showZero]);

  const exportCsv = async () => {
    if (!report || exporting) return;
    setExporting(true);
    try {
      const blob = new Blob(['\uFEFF' + trackerToCsv(filtered, report.asOf, NEXUS_CONFIG)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vireek-nexus-${report.asOf || new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      try {
        await logNexusExport(filtered.length);
        toast(t('page.exported'), 'success');
      } catch {
        toast(t('page.exportAuditFailed'), 'error');
      }
    } finally {
      setExporting(false);
    }
  };

  const gap = report ? coverageGap(report.coverage) : 0;
  const unattributed = Object.entries(summary.unattributedCents).filter(([, c]) => c > 0);

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary px-4 pb-20 pt-28 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Globe2 className="text-accent" size={22} aria-hidden="true" />
                <h1 className="text-2xl font-bold tracking-tight text-text-primary">{t('page.title')}</h1>
              </div>
              <p className="mt-1 text-sm text-text-secondary">{t('page.subtitle')}</p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col text-xs text-text-secondary">
                {t('page.asOf')}
                <input
                  type="date"
                  value={asOf}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setAsOf(e.target.value)}
                  className="focus-ring mt-1 min-h-[36px] rounded-lg border border-border bg-bg-secondary px-2 text-sm text-text-primary"
                />
              </label>
              <Button variant="secondary" size="sm" onClick={() => void load(true)} disabled={refreshing || state === 'loading'}>
                <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" /> {t('page.refresh')}
              </Button>
              <Button size="sm" onClick={() => void exportCsv()} disabled={state !== 'ready' || exporting || filtered.length === 0}>
                {exporting ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}{' '}
                {exporting ? t('page.exporting') : t('page.export')}
              </Button>
            </div>
          </div>

          <p role="note" className="mt-4 rounded-xl border border-border bg-bg-secondary p-3 text-xs text-text-secondary">{t('page.disclaimer')}</p>
          <p className="mt-2 text-xs text-text-secondary">{t('config.unreviewed', { status: NEXUS_CONFIG.reviewStatus })}</p>
          {CONFIG_PROBLEMS.length > 0 && (
            <div role="alert" className="mt-3 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              <p className="font-medium">{t('config.problems')}</p>
              <ul className="ms-5 mt-1 list-disc">
                {CONFIG_PROBLEMS.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}

          {state === 'loading' && (
            <div className="mt-8 space-y-6" role="status" aria-label={t('states.loading')}>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 rounded-2xl" />
                ))}
              </div>
              <Skeleton className="h-80 rounded-2xl" />
            </div>
          )}

          {state === 'forbidden' && (
            <div className="mt-8">
              <EmptyState icon={AlertTriangle} title={t('states.forbidden')} description="" />
            </div>
          )}

          {state === 'error' && (
            <div className="mt-8">
              <EmptyStateError icon={Globe2} title={t('states.error')} description={errorMsg} onRetry={() => void load()} />
            </div>
          )}

          {state === 'ready' && report && (
            <div className="mt-6 space-y-6">
              {gap > 0 && (
                <div role="alert" className="rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-warning-500">{t('coverage.gap', { count: gap })}</div>
              )}
              {summary.configuredCount === 0 && (
                <div role="note" className="rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-primary">{t('config.noneConfigured')}</div>
              )}

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                <Kpi label={t('kpi.exceeded')} value={String(summary.exceeded)} tone={summary.exceeded > 0 ? 'bad' : undefined} />
                <Kpi label={t('kpi.approaching')} value={String(summary.approaching)} tone={summary.approaching > 0 ? 'warn' : undefined} />
                <Kpi label={t('kpi.below')} value={String(summary.below)} tone={summary.below > 0 ? 'good' : undefined} />
                <Kpi label={t('kpi.notConfigured')} value={String(summary.notConfigured)} />
                <Kpi
                  label={t('kpi.unattributed')}
                  value={unattributed.length === 0 ? t('kpi.none') : unattributed.map(([cur, c]) => formatMoney(c, cur, language)).join(' · ')}
                  tone={unattributed.length > 0 ? 'warn' : undefined}
                />
              </div>

              <p className="text-xs text-text-secondary">
                {report.coverage.firstPaidAt && report.coverage.lastPaidAt
                  ? t('coverage.range', { from: report.coverage.firstPaidAt.slice(0, 10), to: report.coverage.lastPaidAt.slice(0, 10) })
                  : t('coverage.empty')}
              </p>

              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('filters.search')}
                  aria-label={t('filters.search')}
                  className="focus-ring min-h-[36px] w-full rounded-lg border border-border bg-bg-secondary px-3 text-sm text-text-primary sm:w-64"
                />
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as 'all' | NexusStatus)}
                  aria-label={t('filters.status')}
                  className="focus-ring min-h-[36px] rounded-lg border border-border bg-bg-secondary px-2 text-sm text-text-primary"
                >
                  <option value="all">{t('filters.all')}</option>
                  {STATUS_ORDER.map((s) => (
                    <option key={s} value={s}>{t(`status.${s}`)}</option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-sm text-text-secondary">
                  <input type="checkbox" checked={showZero} onChange={(e) => setShowZero(e.target.checked)} className="focus-ring" />
                  {t('filters.showZero')}
                </label>
              </div>

              {filtered.length === 0 ? (
                <EmptyState icon={Globe2} title={t('states.empty')} description="" />
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
                  <table className="w-full min-w-[860px] text-sm">
                    <caption className="sr-only">{t('table.caption')}</caption>
                    <thead className="text-xs uppercase tracking-wide text-text-secondary">
                      <tr>
                        <th scope="col" className="px-4 py-3 text-start">{t('table.jurisdiction')}</th>
                        <th scope="col" className="px-4 py-3 text-start">{t('table.status')}</th>
                        <th scope="col" className="px-4 py-3 text-start">{t('table.window')}</th>
                        <th scope="col" className="px-4 py-3 text-end">{t('table.revenue')}</th>
                        <th scope="col" className="px-4 py-3 text-end">{t('table.invoices')}</th>
                        <th scope="col" className="px-4 py-3 text-end">{t('table.threshold')}</th>
                        <th scope="col" className="px-4 py-3 text-end">{t('table.progress')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {filtered.map((r) => <Row key={`${r.key}|${r.currency}`} r={r} language={language} />)}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </>
  );
}

function Row({ r, language }: { r: TrackerRow; language: string }) {
  const { t } = useNexusT();
  return (
    <tr>
      <th scope="row" className="px-4 py-3 text-start font-medium text-text-primary">
        <span>{r.name}</span> <span className="text-xs text-text-secondary">{r.key} · {(r.currency ?? '').toUpperCase()}</span>
        {r.unresolved && <span className="block text-xs text-warning-500">{t('table.unresolved')}</span>}
        {r.revenueThresholdCents !== null || r.transactionThreshold !== null ? (!r.reviewed && <span className="block text-xs text-warning-500">{t('table.unreviewed')}</span>) : null}
      </th>
      <td className="px-4 py-3">
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status]}`} title={r.reason || undefined}>{t(`status.${r.status}`)}</span>
      </td>
      <td className="px-4 py-3 text-text-secondary">{r.window ? t(`window.${r.window}`) : '—'}</td>
      <td className="px-4 py-3 text-end tabular-nums text-text-primary">{formatMoney(r.revenueCents, r.currency, language)}</td>
      <td className="px-4 py-3 text-end tabular-nums text-text-primary">{r.invoices}</td>
      <td className="px-4 py-3 text-end tabular-nums text-text-secondary">{r.revenueThresholdCents === null ? '—' : formatMoney(r.revenueThresholdCents, r.currency, language)}</td>
      <td className="px-4 py-3 text-end tabular-nums text-text-primary">{[formatPct(r.revenuePct), formatPct(r.transactionPct)].filter(Boolean).join(' / ') || '—'}</td>
    </tr>
  );
}
