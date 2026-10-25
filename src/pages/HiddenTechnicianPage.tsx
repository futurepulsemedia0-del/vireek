import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, FileUp, Gauge, Info, Lock, RefreshCw, Settings2, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonCard } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { decideFix, loadFixes, refreshSnapshot, saveSettings, type FixRecord, type Snapshot } from '@/lib/hiddenTech/api';
import { buildDemoSnapshot } from '@/lib/hiddenTech/demo';
import { HIDDEN_TECH_NS } from '@/lib/hiddenTech/i18n';
import { LEAK_CAUSES, type HtSettings, type LeakCause } from '@/lib/hiddenTech/leakEngine';

const NAV_LABEL = 'Hidden Technician';
const STATUS_FILTERS = ['suggested', 'approved', 'measured', 'dismissed'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const selectCls = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-sm text-text-primary focus-visible:border-accent';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

export function HiddenTechnicianPage() {
  const { t, i18n } = useTranslation(HIDDEN_TECH_NS);
  const { isOwner, permissions, profile, teamMember, loading, profileLoading } = useAuth();
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canAccess = isOwner || permissions.can_view_billing;

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [demo, setDemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyFix, setBusyFix] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('suggested');
  const [openTech, setOpenTech] = useState<string | null>(null);
  const [causeFilter, setCauseFilter] = useState<LeakCause | 'all'>('all');
  const [ledgerLimit, setLedgerLimit] = useState(40);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState<HtSettings | null>(null);

  const lang = i18n.language || 'en';
  const nf = useMemo(() => new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }), [lang]);
  const money = useMemo(() => new Intl.NumberFormat(lang, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }), [lang]);
  const hrs = useCallback((n: number) => t('units.hours', { value: nf.format(n) }), [nf, t]);

  const load = useCallback(async () => {
    if (!ownerId || !canAccess) return;
    setBusy(true);
    setError(null);
    try {
      const s = await refreshSnapshot(ownerId);
      setSnap(s);
      setDraft(s.settings);
      setDemo(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }, [ownerId, canAccess, t]);

  useEffect(() => { void load(); }, [load]);

  const startDemo = () => {
    const s = buildDemoSnapshot();
    setSnap(s); setDraft(s.settings); setDemo(true); setError(null); setNotice(null);
  };

  const onDecide = async (fix: FixRecord, decision: 'approve' | 'dismiss') => {
    if (demo || !ownerId) return;
    setBusyFix(fix.id); setError(null); setNotice(null);
    try {
      await decideFix(fix.id, decision);
      const fixes = await loadFixes(ownerId);
      setSnap((s) => (s ? { ...s, fixes } : s));
      setNotice(t(decision === 'approve' ? 'notice.approved' : 'notice.dismissed'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.generic'));
    } finally {
      setBusyFix(null);
    }
  };

  const onSaveSettings = async () => {
    if (!ownerId || !draft || demo) return;
    setBusy(true); setError(null);
    try {
      await saveSettings(ownerId, draft);
      setNotice(t('notice.saved'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.generic'));
      setBusy(false);
    }
  };

  const setNum = (k: keyof HtSettings, v: string) => setDraft((d) => (d ? { ...d, [k]: Number(v) } : d));

  if (loading || profileLoading) return <DashboardLayout activeLabel={NAV_LABEL}><SkeletonCard rows={4} /></DashboardLayout>;

  if (!canAccess || !ownerId) {
    return (
      <DashboardLayout activeLabel={NAV_LABEL}>
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">{t('access.title')}</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">{t('access.body')}</p>
        </div>
      </DashboardLayout>
    );
  }

  const fixesIn = (s: StatusFilter) => (snap?.fixes ?? []).filter((f) => (s === 'approved' ? f.status === 'approved' : f.status === s));
  const visibleFixes = fixesIn(filter).slice(0, 50);
  const openEstimate = fixesIn('suggested').reduce((a, f) => a + f.estimatedHours, 0);
  const a = snap?.actual;
  const rate = snap?.settings.hourlyCost ?? 0;
  const ledger = (a?.rows ?? []).filter((r) => causeFilter === 'all' || r.cause === causeFilter).sort((x, y) => y.startMs - x.startMs);
  const skipped = a?.skipped.filter((x) => x.code !== 'not_run' && x.code !== 'cancelled').length ?? 0;

  return (
    <DashboardLayout activeLabel={NAV_LABEL}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Gauge size={24} /></span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">{t('title')}</h1>
            <p className="text-sm text-text-secondary">{t('subtitle')}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/dashboard/hours-audit" className="focus-ring inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary hover:border-accent/40">
            <FileUp size={16} />{t('actions.freeAudit')}
          </Link>
          <Button size="sm" variant="secondary" onClick={startDemo}>{t('actions.demo')}</Button>
          <Button size="sm" onClick={() => void load()} disabled={busy}><RefreshCw size={16} className={busy ? 'animate-spin' : ''} />{t('actions.refresh')}</Button>
        </div>
      </div>

      {demo && <p role="status" className="mb-4 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-text-primary">{t('demoBanner')}</p>}
      {error && <p role="alert" className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-text-primary">{error}</p>}
      {notice && <p role="status" aria-live="polite" className="mb-4 rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm text-text-primary">{notice}</p>}

      {!snap && busy && <SkeletonCard rows={5} />}

      {snap && a && (
        <div className="space-y-6">
          <p className="flex items-start gap-2 text-xs text-text-secondary"><Info size={14} className="mt-0.5 shrink-0" />{t('honesty', { cost: money.format(rate) })}</p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t('kpi.utilization')} value={`${nf.format(a.totals.utilization)}%`} hint={t('kpi.utilizationHint', { billable: hrs(a.totals.billableHours), paid: hrs(a.totals.paidHours) })} />
            <Stat label={t('kpi.leaked')} value={hrs(a.totals.leakedHours)} hint={t('kpi.leakedHint', { value: money.format(a.totals.leakedCost) })} />
            <Stat label={t('kpi.recovered')} value={hrs(snap.recovered.hours)} hint={t('kpi.recoveredHint', { value: money.format(snap.recovered.cost) })} />
            <Stat label={t('kpi.potential')} value={hrs(openEstimate)} hint={t('kpi.potentialHint')} />
          </div>

          <Card className="!p-5">
            <h2 className="text-lg font-semibold text-text-primary">{t('top.title')}</h2>
            {a.topLeaks.length === 0 ? (
              <p className="mt-2 text-sm text-text-secondary">{t('empty.noLeaks')}</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {a.topLeaks.map((l) => {
                  const pct = a.totals.leakedHours > 0 ? Math.round((l.hours / a.totals.leakedHours) * 100) : 0;
                  return (
                    <li key={l.cause}>
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="font-medium text-text-primary">{t(`cause.${l.cause}`)}</span>
                        <span className="text-text-secondary">{hrs(l.hours)} · {money.format(l.cost)} · {pct}%</span>
                      </div>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label={`${t(`cause.${l.cause}`)} ${pct}%`}>
                        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-text-secondary">{t(`causeHelp.${l.cause}`)}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card className="!p-5">
            <h2 className="text-lg font-semibold text-text-primary">{t('fixes.title')}</h2>
            <p className="mt-1 text-sm text-text-secondary">{t('fixes.intro')}</p>
            <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label={t('fixes.title')}>
              {STATUS_FILTERS.map((s) => (
                <button key={s} type="button" role="tab" aria-selected={filter === s} onClick={() => setFilter(s)}
                  className={`focus-ring rounded-full border px-3 py-1.5 text-sm ${filter === s ? 'border-accent bg-accent/10 font-semibold text-text-primary' : 'border-border text-text-secondary'}`}>
                  {t(`status.${s}`)} ({fixesIn(s).length})
                </button>
              ))}
            </div>
            {visibleFixes.length === 0 ? (
              <p className="mt-4 text-sm text-text-secondary">{t('empty.fixes')}{snap.waitlistCount === 0 && filter === 'suggested' ? ` ${t('empty.noWaitlist')}` : ''}</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {visibleFixes.map((f) => (
                  <li key={f.id} className="rounded-xl border border-border bg-bg-primary p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-text-primary">{t(`fix.${f.kind}.title`, { ...f.detail, defaultValue: f.title })}</p>
                        <p className="mt-1 text-sm text-text-secondary">{t(`fix.${f.kind}.how`)}</p>
                        <p className="mt-2 text-xs text-text-secondary">
                          {t(`cause.${f.cause}`)} · {t('fixes.estimate', { value: hrs(f.estimatedHours) })}
                          {f.status === 'measured' && f.recoveredHours !== null && <> · <strong className="text-text-primary">{t('fixes.recovered', { value: hrs(f.recoveredHours) })}</strong>{f.measureMethod ? ` (${t(`method.${f.measureMethod}`)})` : ''}</>}
                          {f.status === 'approved' && ` · ${t('fixes.tracking')}`}
                        </p>
                      </div>
                      {f.status === 'suggested' && (
                        <div className="flex gap-2">
                          <Button size="sm" disabled={demo || busyFix === f.id} title={demo ? t('demoDisabled') : undefined} onClick={() => void onDecide(f, 'approve')}><Check size={16} />{t('actions.approve')}</Button>
                          <Button size="sm" variant="secondary" disabled={demo || busyFix === f.id} title={demo ? t('demoDisabled') : undefined} onClick={() => void onDecide(f, 'dismiss')}><X size={16} />{t('actions.dismiss')}</Button>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="!p-5">
            <h2 className="text-lg font-semibold text-text-primary">{t('pnl.title')}</h2>
            <p className="mt-1 text-sm text-text-secondary">{t('pnl.intro')}</p>
            {a.techs.length === 0 ? (
              <p className="mt-3 text-sm text-text-secondary">{t('empty.noData')}</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-start text-xs uppercase tracking-wide text-text-secondary">
                      <th className="py-2 pe-3 text-start font-medium">{t('pnl.tech')}</th>
                      <th className="py-2 pe-3 text-end font-medium">{t('pnl.paid')}</th>
                      <th className="py-2 pe-3 text-end font-medium">{t('pnl.billable')}</th>
                      <th className="py-2 pe-3 text-end font-medium">{t('pnl.leaked')}</th>
                      <th className="py-2 pe-3 text-end font-medium">{t('pnl.utilization')}</th>
                      <th className="py-2 text-end font-medium">{t('pnl.value')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.techs.map((tc) => {
                      const open = openTech === tc.techId;
                      return [
                        <tr key={tc.techId} className="border-b border-border/60">
                          <td className="py-2 pe-3">
                            <button type="button" aria-expanded={open} onClick={() => setOpenTech(open ? null : tc.techId)} className="focus-ring inline-flex items-center gap-1 rounded font-medium text-text-primary">
                              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} className="rtl:rotate-180" />}{tc.techName}
                            </button>
                          </td>
                          <td className="py-2 pe-3 text-end">{hrs(tc.paidHours)}</td>
                          <td className="py-2 pe-3 text-end">{hrs(tc.billableHours)}</td>
                          <td className="py-2 pe-3 text-end">{hrs(tc.leakedHours)}</td>
                          <td className="py-2 pe-3 text-end">{nf.format(tc.utilization)}%</td>
                          <td className="py-2 text-end">{money.format(tc.leakedCost)}</td>
                        </tr>,
                        open && (
                          <tr key={`${tc.techId}-days`} className="border-b border-border/60 bg-bg-primary">
                            <td colSpan={6} className="px-3 py-3">
                              <ul className="space-y-2">
                                {a.days.filter((d) => d.techId === tc.techId).slice(-14).reverse().map((d) => (
                                  <li key={d.day} className="text-xs text-text-secondary">
                                    <span className="font-medium text-text-primary">{d.day}</span> · {t('pnl.dayLine', { paid: hrs(d.paidHours), billable: hrs(d.billableHours), leaked: hrs(d.leakedHours) })}
                                    <span className="block">{LEAK_CAUSES.filter((c) => d.byCause[c] > 0).map((c) => `${t(`cause.${c}`)} ${hrs(d.byCause[c])}`).join(' · ')}</span>
                                  </li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        ),
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="!p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-text-primary">{t('ledger.title')}</h2>
              <label className="text-sm text-text-secondary">
                <span className="sr-only">{t('ledger.filter')}</span>
                <select className={selectCls} value={causeFilter} onChange={(e) => { setCauseFilter(e.target.value as LeakCause | 'all'); setLedgerLimit(40); }}>
                  <option value="all">{t('ledger.allCauses')}</option>
                  {LEAK_CAUSES.map((c) => <option key={c} value={c}>{t(`cause.${c}`)}</option>)}
                </select>
              </label>
            </div>
            {ledger.length === 0 ? (
              <p className="mt-3 text-sm text-text-secondary">{t('empty.noData')}</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-text-secondary">
                      <th className="py-2 pe-3 text-start font-medium">{t('ledger.day')}</th>
                      <th className="py-2 pe-3 text-start font-medium">{t('pnl.tech')}</th>
                      <th className="py-2 pe-3 text-start font-medium">{t('ledger.cause')}</th>
                      <th className="py-2 pe-3 text-end font-medium">{t('ledger.hours')}</th>
                      <th className="py-2 text-start font-medium">{t('ledger.why')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.slice(0, ledgerLimit).map((r, i) => (
                      <tr key={`${r.techId}-${r.startMs}-${r.cause}-${i}`} className="border-b border-border/60 align-top">
                        <td className="py-2 pe-3 whitespace-nowrap">{r.day}</td>
                        <td className="py-2 pe-3">{r.techName}</td>
                        <td className="py-2 pe-3">{t(`cause.${r.cause}`)}</td>
                        <td className="py-2 pe-3 text-end whitespace-nowrap">{hrs(r.hours)}</td>
                        <td className="py-2 text-xs text-text-secondary">{t(`rules.${r.rule.replace(/\./g, '_')}`, { defaultValue: r.rule })} · {t(`confidence.${r.confidence}`)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {ledger.length > ledgerLimit && <Button className="mt-3" size="sm" variant="secondary" onClick={() => setLedgerLimit((n) => n + 100)}>{t('ledger.more', { count: ledger.length - ledgerLimit })}</Button>}
          </Card>

          <Card className="!p-5">
            <button type="button" aria-expanded={showSettings} onClick={() => setShowSettings((v) => !v)} className="focus-ring flex w-full items-center justify-between rounded text-start">
              <span className="flex items-center gap-2 text-lg font-semibold text-text-primary"><Settings2 size={18} />{t('settings.title')}</span>
              {showSettings ? <ChevronDown size={16} /> : <ChevronRight size={16} className="rtl:rotate-180" />}
            </button>
            {showSettings && draft && (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {([['hourlyCost', 'settings.hourlyCost', 1], ['paidHoursPerDay', 'settings.paidHours', 0.5], ['driveGapCapMinutes', 'settings.driveCap', 5], ['paperworkAllowanceMinutes', 'settings.paperwork', 5]] as const).map(([k, label, step]) => (
                  <label key={k} className="block text-sm font-medium text-text-primary">
                    {t(label)}
                    <Input type="number" inputMode="decimal" step={step} min={0} className="mt-1.5" value={Number.isFinite(draft[k] as number) ? String(draft[k]) : ''} onChange={(e) => setNum(k, e.target.value)} disabled={demo} />
                  </label>
                ))}
                <div className="sm:col-span-2"><Button size="sm" onClick={() => void onSaveSettings()} disabled={demo || busy}>{t('settings.save')}</Button></div>
              </div>
            )}
          </Card>

          <Card className="!p-5">
            <details>
              <summary className="focus-ring cursor-pointer text-lg font-semibold text-text-primary">{t('how.title')}</summary>
              <ul className="mt-3 list-disc space-y-2 ps-5 text-sm text-text-secondary">
                {(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] as const).map((k) => <li key={k}>{t(`how.${k}`, { cost: money.format(rate) })}</li>)}
              </ul>
            </details>
            <p className="mt-3 text-xs text-text-secondary">{t('quality', { skipped, unassigned: snap.unassignedJobs })}</p>
          </Card>
        </div>
      )}
    </DashboardLayout>
  );
}
