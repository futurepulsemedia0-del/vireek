/**
 * Autonomous Operations Loop — /dashboard/operations-loop
 *
 * The umbrella over every Vireek learning engine:
 * OBSERVE -> UNDERSTAND -> PREDICT -> DECIDE -> ACT -> MEASURE -> LEARN
 * -> UPDATE POLICY -> ACT BETTER. Every job is a training event; this page
 * shows how far each job travelled, where the loop leaks, and whether approved
 * policy updates really improved operations. See src/lib/operationsLoop.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CornerDownLeft, Infinity as InfinityIcon, RefreshCw } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import {
  closureRate,
  computeStageStatuses,
  fetchOperationsLoopSnapshot,
  findWeakestLink,
  HEALTH_STYLES,
  JOB_STAGE_KEYS,
  policyStageHealth,
  STAGES,
  summarizeImpact,
  syncOperationsLoop,
  VERDICT_STYLES,
  WINDOW_OPTIONS,
  type JobStageKey,
  type OpsLoopSnapshot,
  type StageStatus,
} from '@/lib/operationsLoop';

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-4';

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

function humanize(key: string | null): string {
  if (!key) return 'Job';
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ============================================================
// SMALL PARTS
// ============================================================

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={CARD}>
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-[11px] text-text-secondary/70">{hint}</p>}
    </div>
  );
}

function StageTile({ stage, index }: { stage: StageStatus; index: number }) {
  const h = HEALTH_STYLES[stage.health];
  return (
    <Link
      to={stage.href}
      className="group rounded-xl border border-border bg-bg-primary p-3 transition-colors hover:border-accent"
      aria-label={`${stage.label}: ${stage.coverage === null ? 'no data' : `${stage.coverage}% coverage`}. Open ${stage.engine}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
          {index + 1}. {stage.label}
        </span>
        <span className={`h-2 w-2 rounded-full ${h.dot}`} aria-hidden="true" />
      </div>
      <p className={`mt-2 text-xl font-semibold ${h.text}`}>{stage.coverage === null ? '—' : `${stage.coverage}%`}</p>
      <p className="text-[11px] text-text-secondary">
        {stage.of > 0 ? `${stage.count} of ${stage.of} jobs` : 'No applicable jobs'}
      </p>
      <p className="mt-2 flex items-center gap-1 text-[11px] text-text-secondary/80 group-hover:text-accent">
        {stage.engine} <ArrowRight size={10} />
      </p>
    </Link>
  );
}

function StageDots({ ev }: { ev: Record<JobStageKey, boolean> }) {
  return (
    <div className="flex items-center gap-1" role="img" aria-label={`${JOB_STAGE_KEYS.filter((k) => ev[k]).length} of 7 stages reached`}>
      {STAGES.map((s) => (
        <span
          key={s.key}
          title={`${s.label}: ${ev[s.key] ? 'reached' : 'missing'}`}
          className={`h-2.5 w-2.5 rounded-full ${ev[s.key] ? 'bg-accent' : 'bg-border'}`}
        />
      ))}
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function OperationsLoopPage() {
  const { toast } = useToast();
  const [days, setDays] = useState<number>(90);
  const [snapshot, setSnapshot] = useState<OpsLoopSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const reqId = useRef(0);

  const load = useCallback(
    async (window: number, forceSync: boolean) => {
      const id = ++reqId.current;
      try {
        let snap = await fetchOperationsLoopSnapshot(window);
        if (forceSync || snap.last_sync === null) {
          await syncOperationsLoop(window);
          snap = await fetchOperationsLoopSnapshot(window);
        }
        if (id !== reqId.current) return;
        setSnapshot(snap);
        setFailed(false);
      } catch (e) {
        if (id !== reqId.current) return;
        setFailed(true);
        if (forceSync) toast(errMessage(e), 'error');
      } finally {
        if (id === reqId.current) {
          setLoading(false);
          setSyncing(false);
        }
      }
    },
    [toast],
  );

  useEffect(() => {
    setLoading(true);
    void load(days, false);
  }, [days, load]);

  const onSync = () => {
    setSyncing(true);
    void load(days, true);
  };

  const view = useMemo(() => {
    if (!snapshot) return null;
    const stages = computeStageStatuses(snapshot.totals);
    const impact = summarizeImpact(snapshot.impact);
    return {
      stages,
      weakest: findWeakestLink(stages, snapshot.totals),
      closure: closureRate(snapshot.totals),
      impact,
      policyHealth: policyStageHealth(snapshot.policy, impact),
    };
  }, [snapshot]);

  const ph = view ? HEALTH_STYLES[view.policyHealth] : HEALTH_STYLES.idle;

  return (
    <DashboardLayout activeLabel="Operations Loop">
      <div className="mx-auto max-w-4xl px-4 py-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl">
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <InfinityIcon size={18} /> Autonomous Operations Loop
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Every job is a training event for your operating system. Vireek observes, predicts, acts, measures the result, learns,
              updates policy — and proves whether the update made operations better.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              aria-label="Time window"
              className="rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-sm text-text-primary"
            >
              {WINDOW_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  Last {d} days
                </option>
              ))}
            </select>
            <Button size="sm" variant="secondary" onClick={onSync} disabled={syncing || loading}>
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> Sync loop
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={2} />
          </div>
        ) : failed || !snapshot || !view ? (
          <EmptyState
            icon={InfinityIcon}
            title="Operations Loop unavailable"
            description="The loop could not be loaded. Check your connection and try again."
            action={{ label: 'Reload', onClick: () => { setLoading(true); void load(days, false); } }}
          />
        ) : snapshot.totals.jobs === 0 ? (
          <EmptyState
            icon={InfinityIcon}
            title="No jobs in this window yet"
            description="As jobs are dispatched and completed, each one becomes a training event and appears here."
          />
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard
                label="Loop closure"
                value={view.closure === null ? '—' : `${view.closure}%`}
                hint="Completed jobs that travelled all 7 stages"
              />
              <StatCard
                label="Training events"
                value={String(snapshot.totals.training_events)}
                hint="Jobs with prediction, outcome and explained gap"
              />
              <StatCard label="Avg training value" value={`${snapshot.totals.avg_training_value}/100`} hint="How much each job teaches" />
              <StatCard
                label="Policy updates"
                value={String(snapshot.policy.policy_changes_window)}
                hint={`${snapshot.policy.active_policies} active now`}
              />
            </div>

            <section className={`${CARD} mb-4`} aria-label="Loop stages">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-primary">The loop, stage by stage</h2>
                <span className="text-[11px] text-text-secondary">
                  {snapshot.last_sync ? `Synced ${shortDate(snapshot.last_sync)}` : 'Not synced yet'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {view.stages.map((s, i) => (
                  <StageTile key={s.key} stage={s} index={i} />
                ))}
                <div className="rounded-xl border border-border bg-bg-primary p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">8. Update policy</span>
                    <span className={`h-2 w-2 rounded-full ${ph.dot}`} aria-hidden="true" />
                  </div>
                  <p className={`mt-2 text-xl font-semibold ${ph.text}`}>{snapshot.policy.active_policies}</p>
                  <p className="text-[11px] text-text-secondary">
                    active · {snapshot.policy.pending_proposals} awaiting approval
                  </p>
                  <Link
                    to="/dashboard/continuous-improvement"
                    className="mt-2 flex items-center gap-1 text-[11px] text-text-secondary/80 hover:text-accent"
                  >
                    Review proposals <ArrowRight size={10} />
                  </Link>
                </div>
              </div>
              <p className="mt-3 flex items-center gap-1.5 text-[11px] text-text-secondary">
                <CornerDownLeft size={12} /> Stage 9, Act better: every update loops back into the next prediction and is judged below.
              </p>
            </section>

            {view.weakest ? (
              <div className="mb-4 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4" role="status">
                <p className="text-sm font-semibold text-text-primary">Weakest link: {view.weakest.label}</p>
                <p className="mt-1 text-sm text-text-secondary">
                  Only {view.weakest.coverage}% coverage ({view.weakest.count} of {view.weakest.of} jobs). Proof required: {view.weakest.proof}{' '}
                  <Link to={view.weakest.href} className="text-accent hover:underline">
                    Open {view.weakest.engine}
                  </Link>
                </p>
              </div>
            ) : (
              snapshot.totals.jobs >= 5 && (
                <div className="mb-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4" role="status">
                  <p className="text-sm text-text-primary">Every measurable stage is healthy. The loop is closing on your real jobs.</p>
                </div>
              )
            )}

            <section className={`${CARD} mb-4`} aria-label="Act better">
              <h2 className="text-sm font-semibold text-text-primary">Act better: did policy updates help?</h2>
              <p className="mt-1 text-sm text-text-secondary">{view.impact.headline}</p>
              {snapshot.impact.length > 0 && (
                <ul className="mt-3 divide-y divide-border">
                  {snapshot.impact.map((p) => {
                    const v = VERDICT_STYLES[p.verdict];
                    return (
                      <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-text-primary">{p.summary}</p>
                          <p className="text-[11px] text-text-secondary">
                            {shortDate(p.effective_at)} · {p.n_before} jobs before, {p.n_after} after
                            {p.mae_before !== null && p.mae_after !== null
                              ? ` · avg duration error ${p.mae_before} → ${p.mae_after} min`
                              : ''}
                          </p>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${v.className}`}>{v.label}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-3 text-[11px] text-text-secondary/70">
                Observational before/after comparison over 30 days each side, shown only with at least 8 measured jobs per side. It is
                evidence, not proof of cause.
              </p>
            </section>

            <section className={CARD} aria-label="Recent training events">
              <h2 className="mb-2 text-sm font-semibold text-text-primary">Recent training events</h2>
              {snapshot.recent.length === 0 ? (
                <p className="text-sm text-text-secondary">Sync the loop to build training events from your jobs.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {snapshot.recent.map((r) => (
                    <li key={r.job_id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-text-primary">{r.customer_name}</p>
                        <p className="text-[11px] text-text-secondary">
                          {humanize(r.job_type_key)} · {shortDate(r.created_at)}
                          {r.primary_cause && r.primary_cause !== 'unexplained' ? ` · cause: ${humanize(r.primary_cause)}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <StageDots
                          ev={{
                            observe: r.observed,
                            understand: r.understood,
                            predict: r.predicted,
                            decide: r.decided,
                            act: r.acted,
                            measure: r.measured,
                            learn: r.learned,
                          }}
                        />
                        <span className="w-14 text-right text-xs font-medium text-text-primary">{r.training_value}/100</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
