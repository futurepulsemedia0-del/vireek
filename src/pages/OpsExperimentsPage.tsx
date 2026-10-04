import { useCallback, useEffect, useMemo, useState } from 'react';
import { Beaker, BookOpenCheck, Lock, Plus } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { ExperimentForm } from '@/components/experimentation/ExperimentForm';
import { ExperimentDetail } from '@/components/experimentation/ExperimentDetail';
import {
  CATEGORY_LABELS,
  METRICS,
  VERDICT_LABELS,
  formatEffect,
  type Assignment,
  type Decision,
  type ExpJob,
  type ExperimentCategory,
  type ResultSnapshot,
} from '@/lib/opsExperiments';
import {
  archiveExperiment,
  concludeExperiment,
  createExperiment,
  deleteDraft,
  enrollJobs,
  fetchAssignments,
  fetchJobsForAnalysis,
  fetchTechnicians,
  listExperiments,
  startExperiment,
  type ExperimentRow,
  type NewExperiment,
} from '@/lib/opsExperimentsApi';
import type { TechnicianOption } from '@/components/experimentation/ExperimentForm';

type View = 'experiments' | 'library' | 'new';
type Filter = 'active' | 'concluded' | 'archived';

const STATUS_DOT: Record<ExperimentRow['status'], string> = {
  draft: 'bg-text-secondary',
  running: 'bg-accent',
  concluded: 'bg-success-500',
  archived: 'bg-border',
};

const DECISION_STYLE: Record<Decision, string> = {
  adopt: 'bg-success-500/10 text-success-500',
  iterate: 'bg-warning-500/10 text-warning-500',
  reject: 'bg-bg-tertiary text-text-secondary',
};

const DECISION_SHORT: Record<Decision, string> = { adopt: 'Adopted', iterate: 'Redesign', reject: 'Stopped' };

export function OpsExperimentsPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canManage = isOwner || permissions.can_view_billing;

  const [experiments, setExperiments] = useState<ExperimentRow[]>([]);
  const [jobs, setJobs] = useState<ExpJob[]>([]);
  const [technicians, setTechnicians] = useState<TechnicianOption[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>('experiments');
  const [filter, setFilter] = useState<Filter>('active');
  const [category, setCategory] = useState<ExperimentCategory | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canManage) {
      setLoading(false);
      return;
    }
    try {
      const [exps, j, techs] = await Promise.all([listExperiments(), fetchJobsForAnalysis(), fetchTechnicians()]);
      setExperiments(exps);
      setJobs(j);
      setTechnicians(techs);
    } catch {
      toast('Could not load experiments. Make sure the latest database migration has been applied.', 'error');
    } finally {
      setLoading(false);
    }
  }, [canManage, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () =>
      experiments.filter((e) =>
        filter === 'active' ? e.status === 'draft' || e.status === 'running' : filter === 'concluded' ? e.status === 'concluded' : e.status === 'archived',
      ),
    [experiments, filter],
  );
  const selected = useMemo(() => experiments.find((e) => e.id === selectedId) ?? null, [experiments, selectedId]);

  useEffect(() => {
    if (selectedId && experiments.some((e) => e.id === selectedId)) return;
    setSelectedId(visible[0]?.id ?? null);
  }, [experiments, visible, selectedId]);

  const refreshAssignments = useCallback(async (id: string) => {
    try {
      setAssignments(await fetchAssignments(id));
    } catch {
      setAssignments([]);
      toast('Could not load this experiment\'s groups', 'error');
    }
  }, [toast]);

  const selectedKey = selected ? `${selected.id}:${selected.status}` : null;
  useEffect(() => {
    if (!selected) {
      setAssignments([]);
      return;
    }
    let cancelled = false;
    setAssignments([]);
    fetchAssignments(selected.id)
      .then((rows) => {
        if (!cancelled) setAssignments(rows);
      })
      .catch(() => {
        if (!cancelled) toast('Could not load this experiment\'s groups', 'error');
      });
    return () => {
      cancelled = true;
    };
    // Re-run when the selected experiment or its status changes, not on every object refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  async function run(key: string, action: () => Promise<void>, success: string, after?: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    try {
      await action();
      toast(success, 'success');
      await load();
      if (after) await after();
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : 'Something went wrong. Please try again.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate(input: NewExperiment) {
    try {
      const id = await createExperiment(input);
      toast('Experiment saved as a draft', 'success');
      await load();
      setFilter('active');
      setSelectedId(id);
      setView('experiments');
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : 'Could not save the experiment', 'error');
    }
  }

  const libraryItems = useMemo(
    () => experiments.filter((e) => e.result_snapshot && e.decision && (category === 'all' || e.category === category)),
    [experiments, category],
  );

  const summary = useMemo(() => {
    const concluded = experiments.filter((e) => e.result_snapshot && e.decision);
    return {
      running: experiments.filter((e) => e.status === 'running').length,
      concluded: concluded.length,
      adopted: concluded.filter((e) => e.decision === 'adopt').length,
      rigorous: concluded.filter((e) => e.result_snapshot?.evidence === 'A').length,
    };
  }, [experiments]);

  if (loading) {
    return (
      <DashboardLayout activeLabel="Experimentation">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <SkeletonCardList count={3} />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Experimentation">
      <FadeIn>
        <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Beaker size={20} />
              </span>
              <div>
                <h1 className="text-2xl font-bold text-text-primary">Experimentation</h1>
                <p className="mt-1 max-w-2xl text-sm text-text-secondary">
                  Turn any operational decision into a test: state the hypothesis, change one thing, compare against a control, measure the outcome, estimate the true effect and keep what was learned.
                </p>
              </div>
            </div>
            {canManage && view !== 'new' && (
              <Button type="button" onClick={() => setView('new')}>
                <Plus size={16} />
                New experiment
              </Button>
            )}
          </header>

          {!canManage ? (
            <EmptyState icon={Lock} title="Experiments are for owners and billing managers" description="Ask an account owner for access to see and run experiments." />
          ) : (
            <>
              <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Summary">
                {[
                  { label: 'Running now', value: summary.running },
                  { label: 'Concluded', value: summary.concluded },
                  { label: 'Adopted', value: summary.adopted },
                  { label: 'Fully powered, randomized', value: summary.rigorous },
                ].map((k) => (
                  <Card key={k.label} className="!p-4">
                    <p className="text-xs text-text-secondary">{k.label}</p>
                    <p className="mt-1 text-2xl font-bold tabular-nums text-text-primary">{k.value}</p>
                  </Card>
                ))}
              </section>

              {view === 'new' ? (
                <ExperimentForm jobs={jobs} technicians={technicians} onSubmit={handleCreate} onCancel={() => setView('experiments')} />
              ) : (
                <>
                  <div className="flex gap-2" role="tablist" aria-label="Experimentation views">
                    {(['experiments', 'library'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        role="tab"
                        aria-selected={view === v}
                        onClick={() => setView(v)}
                        className={`focus-ring rounded-xl px-4 py-2 text-sm font-medium ${view === v ? 'bg-accent text-white' : 'bg-bg-secondary text-text-secondary hover:text-text-primary'}`}
                      >
                        {v === 'experiments' ? 'Experiments' : 'Learning library'}
                      </button>
                    ))}
                  </div>

                  {view === 'experiments' ? (
                    experiments.length === 0 ? (
                      <EmptyState
                        icon={Beaker}
                        title="Run your first experiment"
                        description="Test a change on a fraction of your jobs, and know whether it really worked before rolling it out."
                        action={{ label: 'New experiment', onClick: () => setView('new') }}
                      />
                    ) : (
                      <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
                        <div className="space-y-3">
                          <div className="flex gap-2">
                            {(['active', 'concluded', 'archived'] as const).map((f) => (
                              <button
                                key={f}
                                type="button"
                                aria-pressed={filter === f}
                                onClick={() => setFilter(f)}
                                className={`focus-ring rounded-full px-3 py-1 text-xs font-medium capitalize ${filter === f ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
                              >
                                {f}
                              </button>
                            ))}
                          </div>
                          {visible.length === 0 ? (
                            <EmptyState icon={Beaker} title={`Nothing ${filter} here`} />
                          ) : (
                            <ul className="space-y-2">
                              {visible.map((e) => (
                                <li key={e.id}>
                                  <button
                                    type="button"
                                    onClick={() => setSelectedId(e.id)}
                                    aria-current={selectedId === e.id}
                                    className={`focus-ring w-full rounded-xl border p-3 text-left ${selectedId === e.id ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'}`}
                                  >
                                    <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                                      <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[e.status]}`} aria-hidden="true" />
                                      <span className="truncate">{e.title}</span>
                                    </span>
                                    <span className="mt-1 block text-xs text-text-secondary">
                                      {CATEGORY_LABELS[e.category]} · {METRICS[e.primary_metric].label}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div>
                          {selected ? (
                            <ExperimentDetail
                              key={selected.id}
                              experiment={selected}
                              jobs={jobs}
                              assignments={assignments}
                              canManage={canManage}
                              busy={busy}
                              onStart={() => void run('start', () => startExperiment(selected.id), 'Experiment started')}
                              onEnroll={(ids) => void run('enroll', () => enrollJobs(selected.id, ids), 'Jobs enrolled', () => refreshAssignments(selected.id))}
                              onConclude={(decision: Decision, learning: string, snapshot: ResultSnapshot) =>
                                void run('conclude', () => concludeExperiment(selected.id, decision, learning, snapshot), 'Experiment concluded and learning saved')
                              }
                              onArchive={() => void run('archive', () => archiveExperiment(selected.id, selected.status), 'Experiment archived')}
                              onDeleteDraft={() => void run('delete', () => deleteDraft(selected.id), 'Draft deleted')}
                            />
                          ) : (
                            <EmptyState icon={Beaker} title="Select an experiment" description="Pick one from the list to see its design and results." />
                          )}
                        </div>
                      </div>
                    )
                  ) : (
                    <section aria-label="Learning library" className="space-y-4">
                      <div className="flex flex-wrap items-center gap-3">
                        <label className="text-sm text-text-secondary" htmlFor="library-category">
                          Area
                        </label>
                        <select
                          id="library-category"
                          value={category}
                          onChange={(e) => setCategory(e.target.value as ExperimentCategory | 'all')}
                          className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm"
                        >
                          <option value="all">All areas</option>
                          {(Object.keys(CATEGORY_LABELS) as ExperimentCategory[]).map((c) => (
                            <option key={c} value={c}>
                              {CATEGORY_LABELS[c]}
                            </option>
                          ))}
                        </select>
                      </div>
                      {libraryItems.length === 0 ? (
                        <EmptyState icon={BookOpenCheck} title="No learnings recorded" description="Every concluded experiment adds a verified lesson here." />
                      ) : (
                        <ul className="grid gap-4 md:grid-cols-2">
                          {libraryItems.map((e) => {
                            const snap = e.result_snapshot as ResultSnapshot;
                            return (
                              <li key={e.id}>
                                <Card className="h-full !p-5">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${e.decision ? DECISION_STYLE[e.decision] : ''}`}>{e.decision ? DECISION_SHORT[e.decision] : ''}</span>
                                    <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs text-text-secondary">Evidence {snap.evidence}</span>
                                    <span className="text-xs text-text-secondary">{CATEGORY_LABELS[e.category]}</span>
                                  </div>
                                  <h3 className="mt-3 text-base font-semibold text-text-primary">{e.title}</h3>
                                  <p className="mt-1 text-sm text-text-secondary">{e.hypothesis}</p>
                                  <p className="mt-3 text-sm text-text-primary">
                                    <span className="font-semibold">{METRICS[snap.metric].label}:</span>{' '}
                                    {snap.effect === null ? 'no estimate' : formatEffect(snap.metric, snap.effect)} ({VERDICT_LABELS[snap.verdict].toLowerCase()})
                                  </p>
                                  {e.learning && <p className="mt-2 whitespace-pre-line text-sm text-text-primary">{e.learning}</p>}
                                </Card>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </FadeIn>
    </DashboardLayout>
  );
}
