/**
 * Revenue Radar — /dashboard/revenue-radar
 * Revenue Realization: how much achievable revenue was captured and exactly where money leaks.
 * Ranked in dollars with confidence, evidence, owner and a governed fix (approve → draft → undo).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Download, Radar, RefreshCw } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';
import { useRealizationT } from '@/i18n/revenueRealizationNamespace';
import { formatCents } from '@/lib/quotes';
import {
  DETECTORS, DETECTOR_WIRED, FORMULA, breakdown, buildDigest, confidenceBand, downloadCsv, evidenceHref, fetchRadar, leakAction,
  liveRealization, rankLeaks, refreshRadar, splitEstimatedRealized, weighted,
  type ActionRow, type Band, type DetectorId, type LeakRow, type RadarData,
} from '@/lib/revenueRealization';

const BAND_STYLE: Record<Band, string> = {
  high: 'bg-success-500/15 text-success-500',
  medium: 'bg-warning-500/15 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};
const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint ? <p className="mt-1 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

export function RevenueRadarPage() {
  const { t } = useRealizationT();
  const { toast } = useToast();
  const { isOwner, permissions } = useAuth();
  const canView = isOwner || Boolean(permissions?.can_view_billing);

  const [data, setData] = useState<RadarData | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<DetectorId | 'all'>('all');
  const [confirm, setConfirm] = useState<LeakRow | null>(null);

  const load = useCallback(async () => {
    try { setData(await fetchRadar()); setError(false); } catch { setError(true); }
  }, []);
  useEffect(() => { if (canView) void load(); }, [canView, load]);

  const errMsg = (e: unknown) => t(`errors.${(e as Error).message}`, { defaultValue: t('errors.failed') });

  const refresh = async () => {
    setRefreshing(true);
    try { await refreshRadar(); await load(); toast(t('page.refreshed'), 'success'); }
    catch { toast(t('page.refreshFailed'), 'error'); }
    finally { setRefreshing(false); }
  };

  const run = async (leak: LeakRow, fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(leak.id);
    try { await fn(); await load(); toast(okMsg, 'success'); }
    catch (e) { toast(errMsg(e), 'error'); }
    finally { setBusy(null); }
  };

  const leaks = useMemo(() => rankLeaks(data?.leaks ?? []), [data]);
  const open = useMemo(() => leaks.filter((l) => l.status === 'open' || l.status === 'in_progress'), [leaks]);
  const shown = useMemo(() => open.filter((l) => filter === 'all' || l.detector === filter), [open, filter]);
  const month = data?.snapshots[0];
  const prev = data?.snapshots[1];
  const live = useMemo(() => liveRealization(leaks, month?.captured_cents ?? 0), [leaks, month]);
  const split = useMemo(() => splitEstimatedRealized(leaks), [leaks]);
  const digest = useMemo(() => buildDigest(leaks, new Date(Date.now() - 7 * 86_400_000).toISOString(), live, prev?.realization_pct != null ? { ...live, pct: prev.realization_pct } : null), [leaks, live, prev]);

  const ownerLabel = (l: LeakRow) => (l.ownerId ? data?.members[l.ownerId] ?? t('owner.unassigned') : t('owner.unassigned'));
  const whyText = (l: LeakRow) => {
    const p = { ...l.whyParams } as Record<string, string | number>;
    for (const k of ['policy', 'billed', 'book', 'invoiced']) if (typeof p[k] === 'number') p[k] = formatCents(p[k] as number);
    return t(`why.${l.whyKey}`, p);
  };
  const detectorName = (d: string) => t(`detector.${d}`, { defaultValue: d });
  const bdLabel = (k: string) => (k === 'unassigned' ? t('owner.unassigned') : data?.members[k] ?? k);

  const onFix = (l: LeakRow) => setConfirm(l);
  const confirmFix = async () => {
    const l = confirm;
    if (!l) return;
    setConfirm(null);
    const existing = data?.actions[l.id];
    await run(l, async () => {
      if (!existing) await leakAction('propose', l.id);
      if (isOwner) { await leakAction('approve', l.id); await leakAction('execute', l.id); }
    }, isOwner ? t('actions.done') : t('actions.sentForApproval'));
  };

  if (!canView) {
    return <DashboardLayout><div className="mx-auto max-w-3xl px-4 py-8"><EmptyState icon={Radar} title={t('forbidden.title')} description={t('forbidden.body')} /></div></DashboardLayout>;
  }

  const renderActions = (l: LeakRow) => {
    const a: ActionRow | undefined = data?.actions[l.id];
    const disabled = busy === l.id;
    if (!l.fix) return <p className="text-xs text-text-secondary">{t('actions.preventive')}</p>;
    if (a?.status === 'executed') {
      const r = a.result ?? {};
      const link = typeof r.quoteId === 'string' ? `/dashboard/quotes/${r.quoteId}` : typeof r.invoiceId === 'string' ? `/dashboard/invoicing/${r.invoiceId}` : null;
      return (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-text-secondary">{t(`actions.executed.${a.kind}`)}</span>
          {link ? <Link className="focus-ring text-xs font-semibold text-accent underline" to={link}>{t('actions.open')}</Link> : null}
          {isOwner ? <Button size="xs" variant="secondary" disabled={disabled} loading={disabled} onClick={() => run(l, () => leakAction('undo', l.id), t('actions.undone'))}>{t('actions.undo')}</Button> : null}
        </div>
      );
    }
    if (a?.status === 'proposed' || a?.status === 'approved') {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-text-secondary">{t('actions.awaiting')}</span>
          {isOwner ? <Button size="xs" disabled={disabled} loading={disabled} onClick={() => onFix(l)}>{t('actions.approveRun')}</Button> : null}
          {isOwner ? <Button size="xs" variant="ghost" disabled={disabled} onClick={() => run(l, () => leakAction('reject', l.id), t('actions.rejected'))}>{t('actions.reject')}</Button> : null}
        </div>
      );
    }
    return <Button size="xs" disabled={disabled} loading={disabled} onClick={() => onFix(l)}>{isOwner ? t(`fix.${l.fix}`) : t('actions.requestApproval')}</Button>;
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent" aria-hidden="true"><Radar className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-text-primary">{t('page.title')}</h1>
            <p className="text-sm text-text-secondary">{t('page.subtitle')}</p>
          </div>
          <Button variant="secondary" size="sm" disabled={!open.length} onClick={() => downloadCsv(leaks, 'revenue-leaks.csv')}><Download className="h-4 w-4" aria-hidden="true" />{t('page.export')}</Button>
          <Button size="sm" loading={refreshing} loadingLabel={t('page.refreshing')} onClick={refresh}><RefreshCw className="h-4 w-4" aria-hidden="true" />{t('page.refresh')}</Button>
        </div>

        {error ? (
          <div role="alert" className="flex items-center gap-2 rounded-2xl border border-border bg-bg-secondary p-4 text-sm text-danger-500"><AlertTriangle className="h-4 w-4" aria-hidden="true" />{t('page.loadFailed')}<Button size="xs" variant="secondary" onClick={() => void load()}>{t('page.retry')}</Button></div>
        ) : !data ? (
          <SkeletonCardList count={3} />
        ) : (
          <>
            <section aria-labelledby="rr-kpis" className="mb-6">
              <h2 id="rr-kpis" className="sr-only">{t('kpi.heading')}</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Kpi label={t('kpi.realization')} value={pct(month?.realization_pct ?? null)} hint={month ? t('kpi.range', { low: pct(month.realization_pct_low), high: pct(month.realization_pct_high) }) : t('kpi.noSnapshot')} />
                <Kpi label={t('kpi.captured')} value={formatCents(month?.captured_cents ?? 0)} hint={t('kpi.capturedHint')} />
                <Kpi label={t('kpi.estimatedOpen')} value={formatCents(split.estimatedOpenCents)} hint={t('kpi.estimatedHint')} />
                <Kpi label={t('kpi.realized')} value={formatCents(split.realizedCents)} hint={t('kpi.realizedHint')} />
              </div>
            </section>

            <details open className="mb-6 rounded-2xl border border-border bg-bg-secondary p-4">
              <summary className="focus-ring cursor-pointer text-sm font-semibold text-text-primary">{t('formula.title')} <span className="font-normal text-text-secondary">· {FORMULA.version}</span></summary>
              <p className="mt-3 text-sm text-text-primary">{t('formula.expression')}</p>
              <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-text-secondary">
                <li>{t('formula.low')}</li><li>{t('formula.high')}</li><li>{t('formula.confidence')}</li><li>{t('formula.pools')}</li><li>{t('formula.realized')}</li>
              </ul>
            </details>

            <section aria-labelledby="rr-radar" className="mb-8">
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <h2 id="rr-radar" className="text-lg font-semibold text-text-primary">{t('radar.title')}</h2>
                <label className="ms-auto flex items-center gap-2 text-sm text-text-secondary">
                  {t('radar.filter')}
                  <select className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary" value={filter} onChange={(e) => setFilter(e.target.value as DetectorId | 'all')}>
                    <option value="all">{t('radar.all')}</option>
                    {DETECTORS.map((d) => <option key={d} value={d}>{detectorName(d)}</option>)}
                  </select>
                </label>
              </div>
              <p role="status" className="sr-only">{t('radar.count', { count: shown.length })}</p>
              {shown.length === 0 ? (
                <EmptyState icon={Radar} title={t('radar.emptyTitle')} description={t('radar.emptyBody')} action={{ label: t('page.refresh'), onClick: () => void refresh() }} />
              ) : (
                <ol className="space-y-3">
                  {shown.map((l, i) => {
                    const band = confidenceBand(l.confidence);
                    return (
                      <li key={l.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                        <div className="flex flex-wrap items-start gap-3">
                          <span className="w-6 text-sm font-semibold text-text-secondary" aria-label={t('radar.rank', { n: i + 1 })}>{i + 1}</span>
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-text-primary">{detectorName(l.detector)}{l.customerName ? <span className="font-normal text-text-secondary"> · {l.customerName}</span> : null}</p>
                            <p className="mt-0.5 text-xs text-text-secondary">{t('radar.owner')}: {ownerLabel(l)}</p>
                          </div>
                          <div className="text-end">
                            <p className="text-lg font-bold text-text-primary">{formatCents(l.amountCents)}</p>
                            <p className="text-xs text-text-secondary">{t('radar.weighted', { amount: formatCents(weighted(l)) })}</p>
                          </div>
                          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${BAND_STYLE[band]}`}>{t(`conf.${band}`)} · {Math.round(l.confidence * 100)}%{l.lowSample ? ` · ${t('conf.lowSample')}` : ''}</span>
                        </div>
                        <details className="mt-3 text-sm">
                          <summary className="focus-ring cursor-pointer font-medium text-accent">{t('radar.why')}</summary>
                          <p className="mt-2 text-text-primary">{whyText(l)}</p>
                          <p className="mt-2 text-xs font-medium text-text-secondary">{t('radar.evidence')}</p>
                          <ul className="mt-1 flex flex-wrap gap-2">
                            {l.evidence.map((e) => {
                              const href = evidenceHref(e);
                              const label = `${t(`evidence.${e.table}`, { defaultValue: e.table })} ${e.id.slice(0, 8)}`;
                              return <li key={`${e.table}:${e.id}`}>{href ? <Link to={href} className="focus-ring rounded-lg bg-bg-tertiary px-2 py-1 text-xs text-accent underline">{label}</Link> : <span className="rounded-lg bg-bg-tertiary px-2 py-1 text-xs text-text-secondary">{label}</span>}</li>;
                            })}
                          </ul>
                          {data.actions[l.id]?.status === 'executed' && data.actions[l.id].kind === 'draft_followup' ? (
                            <div className="mt-3 rounded-xl bg-bg-tertiary p-3">
                              <p className="text-xs font-medium text-text-secondary">{t('actions.draftLabel')}</p>
                              <p className="mt-1 whitespace-pre-wrap text-sm text-text-primary">{t(`draft.${l.detector}`, { name: l.customerName ?? '', defaultValue: t('draft.generic', { name: l.customerName ?? '' }) })}</p>
                              <Button size="xs" variant="secondary" className="mt-2" onClick={() => { void navigator.clipboard?.writeText(t(`draft.${l.detector}`, { name: l.customerName ?? '', defaultValue: t('draft.generic', { name: l.customerName ?? '' }) })).then(() => toast(t('actions.copied'), 'success')); }}>{t('actions.copy')}</Button>
                            </div>
                          ) : null}
                        </details>
                        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                          {renderActions(l)}
                          <span className="ms-auto flex gap-2">
                            <Button size="xs" variant="ghost" disabled={busy === l.id} onClick={() => run(l, () => leakAction('feedback', l.id, { verdict: 'false_positive' }), t('actions.markedFalse'))}>{t('actions.falsePositive')}</Button>
                            <Button size="xs" variant="ghost" disabled={busy === l.id} onClick={() => run(l, () => leakAction('dismiss', l.id), t('actions.dismissed'))}>{t('actions.dismiss')}</Button>
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {(['detector', 'technicianId', 'source'] as const).map((k) => {
                const rows = breakdown(leaks, k).slice(0, 8);
                return (
                  <section key={k} aria-labelledby={`rr-bd-${k}`} className="rounded-2xl border border-border bg-bg-secondary p-4">
                    <h2 id={`rr-bd-${k}`} className="mb-2 text-sm font-semibold text-text-primary">{t(`breakdown.${k}`)}</h2>
                    {rows.length === 0 ? <p className="text-sm text-text-secondary">{t('breakdown.empty')}</p> : (
                      <table className="w-full text-sm"><caption className="sr-only">{t(`breakdown.${k}`)}</caption>
                        <thead><tr className="text-start text-xs text-text-secondary"><th scope="col" className="py-1 text-start">{t('breakdown.group')}</th><th scope="col" className="py-1 text-end">{t('breakdown.count')}</th><th scope="col" className="py-1 text-end">{t('breakdown.weighted')}</th></tr></thead>
                        <tbody>{rows.map((r) => <tr key={r.key} className="border-t border-border"><th scope="row" className="py-1.5 text-start font-normal text-text-primary">{k === 'detector' ? detectorName(r.key) : bdLabel(r.key)}</th><td className="py-1.5 text-end text-text-secondary">{r.count}</td><td className="py-1.5 text-end font-medium text-text-primary">{formatCents(r.weightedCents)}</td></tr>)}</tbody>
                      </table>
                    )}
                  </section>
                );
              })}

              <section aria-labelledby="rr-trend" className="rounded-2xl border border-border bg-bg-secondary p-4">
                <h2 id="rr-trend" className="mb-2 text-sm font-semibold text-text-primary">{t('trend.title')}</h2>
                {data.snapshots.length === 0 ? <p className="text-sm text-text-secondary">{t('trend.empty')}</p> : (
                  <table className="w-full text-sm"><caption className="sr-only">{t('trend.title')}</caption>
                    <thead><tr className="text-xs text-text-secondary"><th scope="col" className="py-1 text-start">{t('trend.month')}</th><th scope="col" className="py-1 text-end">{t('trend.pct')}</th><th scope="col" className="py-1 text-end">{t('trend.captured')}</th><th scope="col" className="py-1 text-end">{t('trend.leaked')}</th></tr></thead>
                    <tbody>{data.snapshots.map((s) => <tr key={s.period_month} className="border-t border-border"><th scope="row" className="py-1.5 text-start font-normal text-text-primary">{s.period_month.slice(0, 7)}</th><td className="py-1.5 text-end font-medium text-text-primary">{pct(s.realization_pct)}</td><td className="py-1.5 text-end text-text-secondary">{formatCents(s.captured_cents)}</td><td className="py-1.5 text-end text-text-secondary">{formatCents(s.leaked_weighted_cents)}</td></tr>)}</tbody>
                  </table>
                )}
              </section>

              <section aria-labelledby="rr-digest" className="rounded-2xl border border-border bg-bg-secondary p-4">
                <h2 id="rr-digest" className="mb-2 text-sm font-semibold text-text-primary">{t('digest.title')}</h2>
                <p className="text-sm text-text-secondary">{t('digest.summary', { count: digest.newCount, amount: formatCents(digest.weightedCents) })}{digest.deltaPctPoints !== null ? ` ${t('digest.delta', { points: digest.deltaPctPoints })}` : ''}</p>
                <ul className="mt-2 space-y-1 text-sm">{digest.topLeaks.map((l) => <li key={l.id} className="flex justify-between gap-2"><span className="text-text-primary">{detectorName(l.detector)}</span><span className="font-medium text-text-primary">{formatCents(weighted(l))}</span></li>)}</ul>
                <p className="mt-3 text-xs text-text-secondary">{t('digest.notEmailed')}</p>
              </section>

              <section aria-labelledby="rr-cov" className="rounded-2xl border border-border bg-bg-secondary p-4 lg:col-span-2">
                <h2 id="rr-cov" className="mb-2 text-sm font-semibold text-text-primary">{t('coverage.title')}</h2>
                <p className="mb-2 text-xs text-text-secondary">{t('coverage.body')}</p>
                <ul className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  {DETECTORS.map((d) => <li key={d} className="flex items-center justify-between gap-2"><span className="text-text-primary">{detectorName(d)}</span><span className={DETECTOR_WIRED[d] ? 'text-success-500' : 'text-text-secondary'}>{DETECTOR_WIRED[d] ? t('coverage.connected') : t('coverage.notConnected')}</span></li>)}
                </ul>
              </section>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={t('confirm.title')}
        description={confirm?.fix ? `${t(`confirm.${confirm.fix}`)} ${isOwner ? '' : t('confirm.needsOwner')}`.trim() : ''}
        confirmLabel={isOwner ? t('confirm.approve') : t('confirm.request')}
        onConfirm={confirmFix}
        onCancel={() => setConfirm(null)}
      />
    </DashboardLayout>
  );
}

export default RevenueRadarPage;
