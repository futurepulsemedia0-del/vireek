import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity, AlertTriangle, Loader2, Radar } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { TwinMetrics, TwinStatusBadge } from '@/components/jobs/ServiceTwinPanel';
import { useToast } from '@/contexts/ToastContext';
import {
  INTERVENTION_LABELS,
  formatCents,
  formatMinutes,
  setInterventionStatus,
  useServiceTwinPortfolio,
  type ServiceTwin,
} from '@/lib/serviceTwin';

function StatTile({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'warning' }) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning-500' : 'text-text-primary';
  return (
    <div className="rounded-xl border border-border bg-bg-secondary px-4 py-3">
      <p className="text-[11px] uppercase text-text-secondary">{label}</p>
      <p className={`mt-0.5 text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

export function ServiceTwinPage() {
  const { twins, interventions, loading, error, reload } = useServiceTwinPortfolio();
  const [params] = useSearchParams();
  const focusJob = params.get('job');
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const stats = useMemo(() => {
    const live = twins.filter((t) => t.phase === 'live');
    const offPlan = live.filter((t) => t.status === 'off_plan' || t.status === 'critical');
    const critical = live.filter((t) => t.status === 'critical');
    const costAtRisk = live.reduce((sum, t) => sum + Math.max(0, t.projected.cost_cents - t.expected.cost_cents), 0);
    return { live: live.length, offPlan: offPlan.length, critical: critical.length, costAtRisk };
  }, [twins]);

  const acknowledge = async (twin: ServiceTwin, kind: string) => {
    const row = interventions.find((i) => i.job_id === twin.job_id && i.kind === kind && i.status === 'open');
    if (!row) return;
    setBusyId(row.id);
    try {
      await setInterventionStatus(row.id, 'acknowledged');
      await reload();
    } catch {
      toast('Could not acknowledge this alert.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <DashboardLayout activeLabel="Live Service Twins">
      <div className="mb-8">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
          <Activity size={22} /> Live Service Twins
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-text-secondary">
          Every active job runs against its own plan — time, cost and first-time-fix probability. When a job leaves the plan, Vireek
          tells you while the technician is still on site, not after the job closes.
        </p>
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={4} />
      ) : error ? (
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger" role="alert">
          {error}
        </div>
      ) : twins.length === 0 ? (
        <EmptyState
          icon={Radar}
          title="No jobs in the field right now"
          description="A Service Twin starts tracking the moment a job goes en route, and compares it to plan until it closes."
        />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Jobs in progress" value={String(stats.live)} />
            <StatTile label="Off plan" value={String(stats.offPlan)} tone={stats.offPlan > 0 ? 'warning' : undefined} />
            <StatTile label="Critical" value={String(stats.critical)} tone={stats.critical > 0 ? 'danger' : undefined} />
            <StatTile label="Projected extra cost" value={formatCents(stats.costAtRisk)} tone={stats.costAtRisk > 0 ? 'warning' : undefined} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {twins.map((t) => (
              <Card
                key={t.job_id}
                id={`twin-${t.job_id}`}
                className={`!p-5 ${focusJob === t.job_id ? 'ring-2 ring-accent/50' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">{t.job.customer_name}</p>
                    <p className="truncate text-xs text-text-secondary">
                      {t.job.service_type ?? 'Service'} · {t.phase === 'live' ? `${formatMinutes(t.actual.elapsed_minutes)} elapsed` : 'en route'}
                    </p>
                  </div>
                  {t.phase === 'live' ? <TwinStatusBadge status={t.status} /> : <span className="text-[11px] uppercase text-text-secondary">Waiting to start</span>}
                </div>

                <div className="mt-4">
                  <TwinMetrics twin={t} />
                </div>

                {t.interventions.length > 0 && (
                  <ul className="mt-4 space-y-2">
                    {t.interventions.map((iv) => {
                      const persisted = interventions.find((i) => i.job_id === t.job_id && i.kind === iv.kind);
                      return (
                        <li key={iv.kind} className="rounded-lg border border-border bg-bg-primary p-3">
                          <p className="flex items-start gap-1.5 text-xs font-semibold text-text-primary">
                            <AlertTriangle size={12} className={`mt-0.5 shrink-0 ${iv.severity === 'critical' ? 'text-danger' : 'text-warning-500'}`} />
                            {INTERVENTION_LABELS[iv.kind]} — {iv.headline}
                          </p>
                          <p className="mt-1 text-xs text-text-secondary">{iv.action}</p>
                          {persisted?.status === 'open' && (
                            <button
                              type="button"
                              onClick={() => acknowledge(t, iv.kind)}
                              disabled={busyId === persisted.id}
                              className="focus-ring mt-2 flex items-center gap-1 text-[11px] font-medium text-accent hover:underline disabled:opacity-50"
                            >
                              {busyId === persisted.id && <Loader2 size={11} className="animate-spin" />} I'm on it
                            </button>
                          )}
                          {persisted?.status === 'acknowledged' && (
                            <p className="mt-2 text-[11px] text-text-secondary">Acknowledged — still monitoring.</p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}

                <p className="mt-4 text-right text-[11px]">
                  <Link to="/dashboard/jobs" className="focus-ring text-accent hover:underline">
                    Open jobs →
                  </Link>
                </p>
              </Card>
            ))}
          </div>
        </>
      )}
    </DashboardLayout>
  );
}
