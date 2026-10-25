import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, HeartHandshake, Lock, RefreshCw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid, FadeIn } from '@/components/Skeleton';
import { HowScoreWorks } from '@/components/retention/HowScoreWorks';
import { RetentionTechCard } from '@/components/retention/RetentionTechCard';
import { useRetentionT } from '@/i18n/retentionNamespace';
import {
  actionImpact, approveRetentionAction, canViewRetention, dismissRetentionAction, fetchRetentionSnapshot,
  filterByBand, formatUsd, liftRetentionFreeze, runRetentionEngine, sortScores, summarize,
  type RetentionAction, type RetentionFreeze, type RetentionSnapshot, type RiskBand, type SortMode,
} from '@/lib/technicianRetention';

type BandFilter = RiskBand | 'all';
const FILTERS: BandFilter[] = ['all', 'high', 'elevated', 'low', 'insufficient'];

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'danger' | 'warning' }) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning-500' : 'text-text-primary';
  return (
    <Card className="!p-4 sm:!p-5">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums sm:text-3xl ${color}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </Card>
  );
}

export function TechnicianRetentionPage() {
  const navigate = useNavigate();
  const { isOwner, teamMember, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();
  const { t, language } = useRetentionT();

  const allowed = canViewRetention(isOwner, teamMember?.role as string | undefined);
  const [snapshot, setSnapshot] = useState<RetentionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState<BandFilter>('all');
  const [sort, setSort] = useState<SortMode>('risk');
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError(false);
    try {
      setSnapshot(await fetchRetentionSnapshot());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!allowed) { setLoading(false); return; }
    void load();
  }, [allowed, authLoading, profileLoading, load]);

  const mark = (id: string, on: boolean) =>
    setBusy((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });

  const handleRun = async () => {
    setRunning(true);
    try {
      await runRetentionEngine();
      await load();
      toast(t('page.recalculated'), 'success');
    } catch {
      toast(t('page.recalcFailed'), 'error');
    } finally {
      setRunning(false);
    }
  };

  const settle = async (status: string, okMessage: string) => {
    if (status === 'applied') toast(okMessage, 'success');
    else if (status === 'forbidden') toast(t('toast.forbidden'), 'error');
    else toast(t('toast.stale'), 'error');
    await load();
  };

  const handleApprove = async (a: RetentionAction, title: string, detail: string) => {
    mark(a.id, true);
    try {
      const status = await approveRetentionAction(a.id, title, detail);
      await settle(status, a.action_type === 'freeze_schedule' ? t('toast.approvedFreeze') : t('toast.approved'));
    } catch {
      toast(t('toast.failed'), 'error');
    } finally {
      mark(a.id, false);
    }
  };

  const handleDismiss = async (a: RetentionAction) => {
    mark(a.id, true);
    try {
      await settle(await dismissRetentionAction(a.id), t('toast.dismissed'));
    } catch {
      toast(t('toast.failed'), 'error');
    } finally {
      mark(a.id, false);
    }
  };

  const handleLift = async (f: RetentionFreeze) => {
    mark(f.id, true);
    try {
      await settle(await liftRetentionFreeze(f.id), t('toast.lifted'));
    } catch {
      toast(t('toast.failed'), 'error');
    } finally {
      mark(f.id, false);
    }
  };

  const scores = useMemo(() => snapshot?.scores ?? [], [snapshot]);
  const summary = useMemo(() => summarize(scores), [scores]);
  const impact = useMemo(() => actionImpact(snapshot?.actions ?? []), [snapshot]);
  const visible = useMemo(() => sortScores(filterByBand(scores, filter), sort), [scores, filter, sort]);

  const actionsByTech = useMemo(() => {
    const map = new Map<string, RetentionAction[]>();
    for (const a of snapshot?.actions ?? []) {
      const list = map.get(a.tech_id);
      if (list) list.push(a); else map.set(a.tech_id, [a]);
    }
    return map;
  }, [snapshot]);
  const freezeByTech = useMemo(() => new Map((snapshot?.freezes ?? []).map((f) => [f.tech_id, f])), [snapshot]);

  const weekLabel = snapshot?.week
    ? new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(`${snapshot.week}T00:00:00Z`))
    : null;
  const stillLoading = authLoading || profileLoading || (allowed && loading);

  return (
    <DashboardLayout activeLabel="Retention Engine">
      <button type="button" onClick={() => navigate('/dashboard')} className="focus-ring mb-5 flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft size={16} className="rtl:rotate-180" /> {t('page.back')}
      </button>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent"><HeartHandshake size={24} /></span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">{t('page.title')}</h1>
            <p className="text-sm text-text-secondary">{t('page.subtitle')}</p>
            {weekLabel && <p className="mt-1 text-xs text-text-secondary">{t('page.lastComputed', { week: weekLabel })}</p>}
          </div>
        </div>
        {allowed && (
          <Button onClick={handleRun} disabled={running} className="self-start sm:self-auto">
            <RefreshCw size={16} className={running ? 'animate-spin' : ''} />
            {running ? t('page.recalculating') : t('page.recalculate')}
          </Button>
        )}
      </div>

      {stillLoading ? (
        <div className="space-y-6" aria-busy="true">
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={3} rows={3} />
        </div>
      ) : !allowed ? (
        <EmptyState icon={Lock} title={t('access.title')} description={t('access.description')} />
      ) : error ? (
        <EmptyState icon={HeartHandshake} title={t('page.loadFailed')} action={{ label: t('page.retry'), onClick: () => { setLoading(true); void load(); } }} />
      ) : scores.length === 0 ? (
        <div className="space-y-6">
          <EmptyState
            icon={HeartHandshake}
            title={t('empty.title')}
            description={t('empty.description')}
            action={{ label: running ? t('page.recalculating') : t('empty.cta'), onClick: () => { if (!running) void handleRun(); } }}
          />
          <HowScoreWorks />
        </div>
      ) : (
        <FadeIn className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t('summary.yearlyCost')} value={formatUsd(summary.yearlyAttritionCost, language)} hint={t('summary.yearlyCostHint')} />
            <Stat label={t('summary.high')} value={String(summary.high)} tone={summary.high > 0 ? 'danger' : undefined} hint={`${summary.total} ${t('summary.people')}`} />
            <Stat label={t('summary.costAtRisk')} value={formatUsd(summary.costAtRisk, language)} tone={summary.costAtRisk > 0 ? 'warning' : undefined} hint={t('summary.costAtRiskHint')} />
            <Stat
              label={t('summary.impact')}
              value={impact.measured > 0 ? t('summary.impactValue', { improved: impact.improved, measured: impact.measured }) : '—'}
              hint={impact.measured > 0 ? undefined : t('summary.impactNone')}
            />
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2" role="group" aria-label={t('filters.label')}>
              {FILTERS.map((f) => {
                const count = f === 'all' ? summary.total : summary[f];
                const active = filter === f;
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    aria-pressed={active}
                    className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${active ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
                  >
                    {f === 'all' ? t('filters.all') : t(`band.${f}`)} · {count}
                  </button>
                );
              })}
            </div>
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              {t('filters.sortLabel')}
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortMode)}
                className="focus-ring rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-xs text-text-primary"
              >
                <option value="risk">{t('filters.sortRisk')}</option>
                <option value="cost">{t('filters.sortCost')}</option>
              </select>
            </label>
          </div>

          {visible.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">{t('empty.noMatch')}</p>
          ) : (
            <ul className="space-y-3">
              {visible.map((s) => {
                const tech = snapshot?.techs[s.tech_id];
                if (!tech) return null;
                return (
                  <li key={s.id}>
                    <RetentionTechCard
                      score={s}
                      tech={tech}
                      history={snapshot?.history[s.tech_id] ?? []}
                      actions={actionsByTech.get(s.tech_id) ?? []}
                      freeze={freezeByTech.get(s.tech_id)}
                      busyIds={busy}
                      onApprove={handleApprove}
                      onDismiss={handleDismiss}
                      onLift={handleLift}
                    />
                  </li>
                );
              })}
            </ul>
          )}

          <HowScoreWorks />
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
