import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Crosshair,
  Loader2,
  PackageCheck,
  Plus,
  ShieldCheck,
  Stethoscope,
  UserCheck,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import type { Job } from '@/lib/supabase';
import {
  buildJobContext,
  computeCalibration,
  planAutofix,
  predict,
  rankTechnicians,
  type ActionKind,
  type AutofixStep,
  type AutopilotData,
  type Enforcement,
  type FactorStatus,
  type JobContext,
  type Prediction,
  type PredictionRecord,
  type Verdict,
} from '@/lib/firstTimeFixAutopilot';
import {
  DEFAULT_SETTINGS,
  addTechnicianTool,
  addToolRequirement,
  applyDuration,
  applyReassign,
  fetchPredictions,
  fetchSettings,
  loadAutopilotData,
  removeTechnicianTool,
  removeToolRequirement,
  savePredictions,
  saveSettings,
  type FtfSettings,
} from '@/lib/firstTimeFixAutopilotApi';

const VERDICT_META: Record<Verdict, { label: string; pill: string; text: string; bar: string }> = {
  go: { label: 'Ready to dispatch', pill: 'bg-success-500/10 text-success-500', text: 'text-success-500', bar: 'bg-success-500' },
  review: { label: 'Review first', pill: 'bg-warning-500/10 text-warning-500', text: 'text-warning-500', bar: 'bg-warning-500' },
  hold: { label: 'Fix before dispatch', pill: 'bg-danger/10 text-danger', text: 'text-danger', bar: 'bg-danger' },
};

const STATUS_STYLE: Record<FactorStatus, string> = {
  good: 'bg-success-500/10 text-success-500',
  watch: 'bg-warning-500/10 text-warning-500',
  risk: 'bg-danger/10 text-danger',
  unknown: 'bg-bg-tertiary text-text-secondary',
};

const ACTION_LINK: Partial<Record<ActionKind, { to: string; label: string }>> = {
  restock: { to: '/dashboard/inventory', label: 'Open Inventory' },
  order: { to: '/dashboard/inventory', label: 'Open Inventory' },
  diagnose: { to: '/dashboard/diagnosis-copilot', label: 'Open Diagnosis Copilot' },
};

interface Row {
  job: Job;
  ctx: JobContext;
  shown: Prediction;
  assigned: boolean;
  techName: string | null;
}

function formatTime(iso: string | null): string {
  if (!iso) return 'Unscheduled';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function Gauge({ value, low, high, verdict }: { value: number; low: number; high: number; verdict: Verdict }) {
  return (
    <div>
      <div className="flex items-end gap-2">
        <span className={`text-5xl font-bold tabular-nums ${VERDICT_META[verdict].text}`}>{value}%</span>
        <span className="pb-1.5 text-xs text-text-secondary">likely range {low}-{high}%</span>
      </div>
      <div
        className="relative mt-3 h-2.5 w-full overflow-hidden rounded-full bg-bg-tertiary"
        role="progressbar"
        aria-label="First-time-fix probability"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <div className="absolute inset-y-0 rounded-full bg-text-secondary/20" style={{ left: `${low}%`, width: `${Math.max(1, high - low)}%` }} />
        <div className={`h-full rounded-full transition-all duration-500 ${VERDICT_META[verdict].bar}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

export function FirstTimeFixAutopilotPage() {
  const { user, profile, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canManage = isOwner || permissions.can_view_billing;
  const ownerId = profile?.role === 'owner' ? (user?.id ?? null) : ((profile as { account_owner_id?: string | null } | null)?.account_owner_id ?? user?.id ?? null);

  const [data, setData] = useState<AutopilotData | null>(null);
  const [settings, setSettings] = useState<FtfSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState<PredictionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'attention'>('attention');
  const persisted = useRef<Set<string>>(new Set());
  const toolsRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [d, s, p] = await Promise.all([loadAutopilotData(), fetchSettings(), canManage ? fetchPredictions() : Promise.resolve([])]);
      setData(d);
      setSettings(s);
      setSaved(p);
    } catch {
      toast('Could not load First-Time-Fix Autopilot', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast, canManage]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const opts = useMemo(() => ({ threshold: settings.threshold }), [settings.threshold]);

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    return data.jobs
      .filter((j) => j.job_status === 'scheduled')
      .map((job) => {
        const ctx = buildJobContext(data, job);
        const assigned = !!job.assigned_technician_id;
        const best = rankTechnicians(ctx, opts)[0];
        const shown = assigned ? predict(ctx, job.assigned_technician_id, opts) : (best?.prediction ?? predict(ctx, null, opts));
        const tech = data.technicians.find((t) => t.id === job.assigned_technician_id);
        return { job, ctx, shown, assigned, techName: tech ? (tech.member_name ?? tech.member_email) : null };
      })
      .sort((a, b) => a.shown.probability - b.shown.probability);
  }, [data, opts]);

  // Snapshot predictions for assigned jobs so calibration can compare them with outcomes later.
  useEffect(() => {
    if (!canManage || !ownerId || rows.length === 0) return;
    const fresh = rows.filter((r) => r.assigned && !persisted.current.has(`${r.job.id}:${r.job.assigned_technician_id}:${r.shown.probability}`));
    if (fresh.length === 0) return;
    fresh.forEach((r) => persisted.current.add(`${r.job.id}:${r.job.assigned_technician_id}:${r.shown.probability}`));
    void savePredictions(
      ownerId,
      fresh.map((r) => ({ jobId: r.job.id, technicianId: r.job.assigned_technician_id as string, prediction: r.shown })),
    ).catch(() => undefined);
  }, [rows, canManage, ownerId]);

  const visible = filter === 'all' ? rows : rows.filter((r) => r.shown.probability < settings.threshold);
  const selected = rows.find((r) => r.job.id === selectedId) ?? visible[0] ?? rows[0] ?? null;

  const ranking = useMemo(() => (selected ? rankTechnicians(selected.ctx, opts) : []), [selected, opts]);
  const plan = useMemo(() => (selected ? planAutofix(selected.ctx, selected.job.assigned_technician_id, opts) : null), [selected, opts]);
  const calibration = useMemo(() => (data ? computeCalibration(saved, data.jobs, data.now) : null), [data, saved]);

  const summary = useMemo(() => {
    const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.shown.probability, 0) / rows.length) : null;
    return {
      total: rows.length,
      avg,
      attention: rows.filter((r) => r.shown.verdict !== 'go').length,
      hold: rows.filter((r) => r.shown.verdict === 'hold').length,
    };
  }, [rows]);

  const run = async (key: string, fn: () => Promise<void>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast(ok, 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Action failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const applyStep = (row: Row, step: AutofixStep) => {
    if (step.kind === 'reassign' && step.technicianId) return run(`step-${step.kind}`, () => applyReassign(row.job.id, step.technicianId as string), 'Technician assigned');
    if (step.kind === 'extend_duration' && step.minutes) return run(`step-${step.kind}`, () => applyDuration(row.job.id, step.minutes as number), 'Booked time updated');
    if (step.kind === 'equip') toolsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return Promise.resolve();
  };

  const applySafeSteps = async (row: Row, steps: AutofixStep[]) => {
    setBusy('all');
    try {
      for (const s of steps) {
        if (s.kind === 'reassign' && s.technicianId) await applyReassign(row.job.id, s.technicianId);
        if (s.kind === 'extend_duration' && s.minutes) await applyDuration(row.job.id, s.minutes);
      }
      toast('Autopilot fixes applied', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not apply all fixes', 'error');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const updateSettings = async (next: FtfSettings) => {
    if (!ownerId) return;
    const prev = settings;
    setSettings(next);
    try {
      await saveSettings(ownerId, next);
    } catch {
      setSettings(prev);
      toast('Could not save settings', 'error');
    }
  };

  if (loading) {
    return (
      <DashboardLayout activeLabel="First-Time-Fix Autopilot">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <SkeletonCardList count={3} />
        </div>
      </DashboardLayout>
    );
  }

  const safeSteps = plan?.steps.filter((s) => s.kind === 'reassign' || s.kind === 'extend_duration') ?? [];

  return (
    <DashboardLayout activeLabel="First-Time-Fix Autopilot">
      <FadeIn>
        <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
          <header className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Crosshair size={20} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">First-Time-Fix Autopilot</h1>
              <p className="mt-1 max-w-2xl text-sm text-text-secondary">
                Predicts the chance each job is fixed on the first visit, before it is dispatched, explains why, and fixes the plan when the odds are low.
              </p>
            </div>
          </header>

          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Summary">
            {[
              { label: 'Jobs awaiting dispatch', value: String(summary.total) },
              { label: 'Average FTF probability', value: summary.avg === null ? '-' : `${summary.avg}%` },
              { label: `Below ${settings.threshold}% target`, value: String(summary.attention) },
              { label: 'Fix before dispatch', value: String(summary.hold) },
            ].map((k) => (
              <Card key={k.label} className="!p-4">
                <p className="text-xs text-text-secondary">{k.label}</p>
                <p className="mt-1 text-2xl font-bold tabular-nums text-text-primary">{k.value}</p>
              </Card>
            ))}
          </section>

          {rows.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="No jobs awaiting dispatch" description="Scheduled jobs will be scored here automatically." />
          ) : (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
              <div className="space-y-3">
                <div className="flex gap-2" role="tablist" aria-label="Job filter">
                  {(['attention', 'all'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      role="tab"
                      aria-selected={filter === f}
                      onClick={() => setFilter(f)}
                      className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${filter === f ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary'}`}
                    >
                      {f === 'attention' ? 'Needs attention' : 'All jobs'}
                    </button>
                  ))}
                </div>
                {visible.length === 0 && <p className="rounded-xl bg-success-500/10 p-4 text-sm text-success-500">Every upcoming job meets your {settings.threshold}% target.</p>}
                {visible.map((r) => {
                  const m = VERDICT_META[r.shown.verdict];
                  const active = selected?.job.id === r.job.id;
                  return (
                    <button
                      key={r.job.id}
                      type="button"
                      onClick={() => setSelectedId(r.job.id)}
                      aria-pressed={active}
                      className={`focus-ring w-full rounded-2xl border p-4 text-left transition-colors ${active ? 'border-accent/50 bg-accent/5' : 'border-border/80 bg-bg-secondary hover:border-accent/30'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-text-primary">{r.job.customer_name}</p>
                          <p className="truncate text-xs text-text-secondary">{r.job.service_type ?? 'Unspecified service'} - {formatTime(r.job.scheduled_datetime)}</p>
                          <p className="mt-1 truncate text-xs text-text-secondary/80">{r.techName ? `Assigned: ${r.techName}` : 'Unassigned - best available shown'}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className={`text-xl font-bold tabular-nums ${m.text}`}>{r.shown.probability}%</p>
                          <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${m.pill}`}>{m.label}</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {selected && plan && (
                <div className="space-y-4">
                  <Card className="!p-6">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h2 className="text-lg font-semibold text-text-primary">{selected.job.customer_name}</h2>
                        <p className="text-sm text-text-secondary">{selected.job.service_type ?? 'Unspecified service'} - {formatTime(selected.job.scheduled_datetime)}</p>
                      </div>
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${VERDICT_META[selected.shown.verdict].pill}`}>{VERDICT_META[selected.shown.verdict].label}</span>
                    </div>
                    <div className="mt-5">
                      <Gauge value={selected.shown.probability} low={selected.shown.low} high={selected.shown.high} verdict={selected.shown.verdict} />
                      <p className="mt-3 text-xs text-text-secondary">
                        Starts from {selected.shown.priorProbability}% ({selected.shown.priorSource === 'history' ? `${selected.shown.priorSample} similar completed jobs` : selected.shown.priorSource === 'benchmark' ? 'trade benchmark' : 'default'}). Prediction confidence: <strong>{selected.shown.confidence}</strong>.
                        {!selected.assigned && ' No technician is assigned, so this is the best available technician.'}
                      </p>
                    </div>
                    <ul className="mt-5 space-y-2">
                      {selected.shown.factors.map((f) => (
                        <li key={f.key} className="flex items-start gap-3 rounded-xl bg-bg-primary p-3">
                          <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${STATUS_STYLE[f.status]}`}>{f.status}</span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-text-primary">{f.label}</p>
                            <p className="text-xs text-text-secondary">{f.detail}</p>
                          </div>
                          <span className={`shrink-0 text-sm font-semibold tabular-nums ${f.impactPts < 0 ? 'text-danger' : f.impactPts > 0 ? 'text-success-500' : 'text-text-secondary'}`}>
                            {f.impactPts > 0 ? '+' : ''}{f.impactPts} pts
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>

                  <Card className="!p-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary">
                        <CheckCircle2 size={16} className="text-accent" /> Autopilot fix plan
                      </h3>
                      {canManage && safeSteps.length > 0 && (
                        <Button type="button" size="sm" disabled={busy !== null} onClick={() => void applySafeSteps(selected, safeSteps)}>
                          {busy === 'all' ? <Loader2 size={14} className="animate-spin" /> : null} Apply {safeSteps.length} one-click fix{safeSteps.length === 1 ? '' : 'es'}
                        </Button>
                      )}
                    </div>
                    {plan.steps.length === 0 ? (
                      <p className="mt-3 text-sm text-text-secondary">
                        {plan.reachesThreshold ? 'This job already meets your target. Nothing to fix.' : 'No single change lifts this job further. Review the factors above.'}
                      </p>
                    ) : (
                      <>
                        <p className="mt-2 text-sm text-text-secondary">
                          {plan.startProbability}% to <strong className={VERDICT_META[plan.reachesThreshold ? 'go' : 'review'].text}>{plan.finalProbability}%</strong> after these steps
                          {plan.reachesThreshold ? '.' : `, still under the ${settings.threshold}% target.`}
                        </p>
                        <ol className="mt-4 space-y-2">
                          {plan.steps.map((s, i) => {
                            const link = ACTION_LINK[s.kind];
                            const oneClick = s.kind === 'reassign' || s.kind === 'extend_duration';
                            return (
                              <li key={`${s.kind}-${i}`} className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 p-3">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-bold text-accent">{i + 1}</span>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium text-text-primary">{s.title}{s.blocking && <span className="ml-2 text-[10px] font-semibold uppercase text-warning-500">hold dispatch</span>}</p>
                                  <p className="text-xs text-text-secondary">{s.detail}</p>
                                </div>
                                <span className="text-sm font-semibold tabular-nums text-success-500">+{s.upliftPts} pts</span>
                                {oneClick && canManage && (
                                  <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => void applyStep(selected, s)}>
                                    {busy === `step-${s.kind}` ? <Loader2 size={14} className="animate-spin" /> : 'Apply'}
                                  </Button>
                                )}
                                {link && (
                                  <Link to={link.to} className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-accent hover:underline">{link.label}</Link>
                                )}
                                {s.kind === 'equip' && (
                                  <button type="button" onClick={() => void applyStep(selected, s)} className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-accent hover:underline">Manage tools</button>
                                )}
                              </li>
                            );
                          })}
                        </ol>
                      </>
                    )}
                  </Card>

                  <Card className="!p-6">
                    <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary"><UserCheck size={16} className="text-accent" /> Technician ranking for this job</h3>
                    {ranking.length === 0 ? (
                      <p className="mt-3 text-sm text-text-secondary">No dispatch-enabled technicians on the team.</p>
                    ) : (
                      <ul className="mt-3 space-y-2">
                        {ranking.map((r) => {
                          const current = r.technician.id === selected.job.assigned_technician_id;
                          const m = VERDICT_META[r.prediction.verdict];
                          return (
                            <li key={r.technician.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-bg-primary p-3">
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-text-primary">{r.technician.member_name ?? r.technician.member_email}{current && <span className="ml-2 text-[10px] font-semibold uppercase text-accent">assigned</span>}</p>
                                <p className="text-xs text-text-secondary">{r.atCapacity ? `At capacity (${r.load}/${r.capacity} jobs that day)` : `${r.load}/${r.capacity} jobs that day`} - {r.prediction.confidence} confidence</p>
                              </div>
                              <span className={`text-lg font-bold tabular-nums ${m.text}`}>{r.prediction.probability}%</span>
                              {canManage && !current && (
                                <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(`assign-${r.technician.id}`, () => applyReassign(selected.job.id, r.technician.id), 'Technician assigned')}>Assign</Button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </Card>
                </div>
              )}
            </div>
          )}

          {calibration && (
            <Card className="!p-6">
              <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary"><ShieldCheck size={16} className="text-accent" /> Is the autopilot right?</h3>
              {calibration.n < 5 ? (
                <p className="mt-2 text-sm text-text-secondary">
                  Calibration appears once at least 5 predicted jobs have finished and passed the 14-day callback window ({calibration.n} so far). Predictions for assigned jobs are saved automatically.
                </p>
              ) : (
                <>
                  <p className="mt-2 text-sm text-text-secondary">
                    Across {calibration.n} finished jobs Vireek predicted {calibration.meanPredicted}% and {calibration.actualRate}% were actually fixed first time. Brier score {calibration.brier} (lower is better; 0.25 is a coin flip).
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {calibration.buckets.map((b) => (
                      <div key={b.label} className="rounded-xl bg-bg-primary p-3">
                        <p className="text-xs text-text-secondary">{b.label} ({b.n})</p>
                        <p className="mt-1 text-sm text-text-primary">{b.n ? `Predicted ${b.predicted}%` : '-'}</p>
                        <p className="text-sm font-semibold text-text-primary">{b.n ? `Actual ${b.actual}%` : ''}</p>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>
          )}

          {canManage && data && (
            <>
              <Card className="!p-6">
                <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary"><AlertTriangle size={16} className="text-accent" /> Dispatch guardrail</h3>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="text-sm text-text-secondary">
                    Target first-time-fix probability: <strong className="text-text-primary">{settings.threshold}%</strong>
                    <input
                      type="range"
                      min={40}
                      max={95}
                      step={5}
                      value={settings.threshold}
                      onChange={(e) => void updateSettings({ ...settings, threshold: Number(e.target.value) })}
                      className="mt-2 w-full accent-[var(--color-accent,#2563eb)]"
                    />
                  </label>
                  <label className="text-sm text-text-secondary">
                    When a dispatcher assigns a job below target
                    <select
                      value={settings.enforcement}
                      onChange={(e) => void updateSettings({ ...settings, enforcement: e.target.value as Enforcement })}
                      className="focus-ring mt-2 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                    >
                      <option value="off">Do nothing</option>
                      <option value="warn">Warn but allow</option>
                      <option value="hold">Block the riskiest jobs (managers can still assign here)</option>
                    </select>
                  </label>
                </div>
              </Card>

              <div ref={toolsRef}>
                <ToolsCard data={data} ownerId={ownerId} onChanged={load} />
              </div>
            </>
          )}
        </div>
      </FadeIn>
    </DashboardLayout>
  );
}

function ToolsCard({ data, ownerId, onChanged }: { data: AutopilotData; ownerId: string | null; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const serviceTypes = useMemo(() => [...new Set(data.jobs.map((j) => j.service_type).filter((s): s is string => !!s))].sort(), [data.jobs]);
  const [service, setService] = useState('');
  const [toolName, setToolName] = useState('');
  const [techId, setTechId] = useState('');
  const [techTool, setTechTool] = useState('');

  const act = async (fn: () => Promise<void>) => {
    try {
      await fn();
      await onChanged();
    } catch {
      toast('Could not save. A duplicate entry is ignored.', 'error');
    }
  };

  return (
    <Card className="!p-6">
      <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary"><Wrench size={16} className="text-accent" /> Special tools</h3>
      <p className="mt-1 text-sm text-text-secondary">Tell Vireek which service types need a special tool and who carries it. Missing tools lower the first-time-fix probability.</p>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase text-text-secondary">Required per service type</p>
          <ul className="mt-2 space-y-1">
            {data.toolRequirements.map((t) => (
              <li key={`${t.service_type}-${t.tool_name}`} className="flex items-center justify-between rounded-lg bg-bg-primary px-3 py-1.5 text-sm text-text-primary">
                <span>{t.service_type}: {t.tool_name}</span>
                <button type="button" aria-label={`Remove ${t.tool_name}`} onClick={() => void act(() => removeToolRequirement(t.service_type, t.tool_name))} className="focus-ring text-text-secondary hover:text-danger"><X size={14} /></button>
              </li>
            ))}
          </ul>
          <form
            className="mt-2 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!ownerId || !service.trim() || !toolName.trim()) return;
              void act(() => addToolRequirement(ownerId, service, toolName)).then(() => setToolName(''));
            }}
          >
            <input list="ftf-service-types" value={service} onChange={(e) => setService(e.target.value)} placeholder="Service type" className="focus-ring min-w-0 flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm" />
            <datalist id="ftf-service-types">{serviceTypes.map((s) => <option key={s} value={s} />)}</datalist>
            <input value={toolName} onChange={(e) => setToolName(e.target.value)} placeholder="Tool" className="focus-ring min-w-0 flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm" />
            <Button type="submit" size="sm" aria-label="Add requirement"><Plus size={14} /></Button>
          </form>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase text-text-secondary">Carried by technician</p>
          <ul className="mt-2 space-y-1">
            {data.technicianTools.map((t) => {
              const tech = data.technicians.find((x) => x.id === t.team_member_id);
              return (
                <li key={`${t.team_member_id}-${t.tool_name}`} className="flex items-center justify-between rounded-lg bg-bg-primary px-3 py-1.5 text-sm text-text-primary">
                  <span>{tech ? (tech.member_name ?? tech.member_email) : 'Unknown'}: {t.tool_name}</span>
                  <button type="button" aria-label={`Remove ${t.tool_name}`} onClick={() => void act(() => removeTechnicianTool(t.team_member_id, t.tool_name))} className="focus-ring text-text-secondary hover:text-danger"><X size={14} /></button>
                </li>
              );
            })}
          </ul>
          <form
            className="mt-2 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!ownerId || !techId || !techTool.trim()) return;
              void act(() => addTechnicianTool(ownerId, techId, techTool)).then(() => setTechTool(''));
            }}
          >
            <select value={techId} onChange={(e) => setTechId(e.target.value)} aria-label="Technician" className="focus-ring min-w-0 flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm">
              <option value="">Technician</option>
              {data.technicians.map((t) => <option key={t.id} value={t.id}>{t.member_name ?? t.member_email}</option>)}
            </select>
            <input value={techTool} onChange={(e) => setTechTool(e.target.value)} placeholder="Tool" className="focus-ring min-w-0 flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm" />
            <Button type="submit" size="sm" aria-label="Add tool"><Plus size={14} /></Button>
          </form>
        </div>
      </div>
      <p className="mt-4 flex items-center gap-2 text-xs text-text-secondary"><PackageCheck size={12} /> <Clock size={12} /> <Stethoscope size={12} /> Parts, time and diagnosis are read automatically from Inventory, the Dispatch Board and Diagnosis Copilot.</p>
    </Card>
  );
}
