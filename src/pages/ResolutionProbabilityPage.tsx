import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Camera,
  CheckCircle2,
  Clock,
  Headphones,
  Loader2,
  PackageCheck,
  ShieldCheck,
  Stethoscope,
  Target,
  UserCheck,
  Wrench,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import type { Job } from '@/lib/supabase';
import { applyDuration, applyReassign } from '@/lib/firstTimeFixAutopilotApi';
import {
  DEFAULT_RPE_SETTINGS,
  assess,
  buildResolutionContext,
  computeCalibration,
  formatMoney,
  planResolution,
  rankCandidates,
  type Assessment,
  type DimensionStatus,
  type Lever,
  type LeverKind,
  type ResolutionContext,
  type ResolutionData,
  type ResolutionPlan,
  type RpeSettings,
  type Verdict,
  type AssessmentRecord,
} from '@/lib/resolutionProbability';
import { fetchAssessmentRecords, fetchRpeSettings, loadResolutionData, saveAssessments, saveRpeSettings } from '@/lib/resolutionProbabilityApi';

const VERDICT_META: Record<Verdict, { label: string; pill: string; text: string; bar: string }> = {
  dispatch: { label: 'Ready to dispatch', pill: 'bg-success-500/10 text-success-500', text: 'text-success-500', bar: 'bg-success-500' },
  improve: { label: 'Improve first', pill: 'bg-warning-500/10 text-warning-500', text: 'text-warning-500', bar: 'bg-warning-500' },
  hold: { label: 'Hold dispatch', pill: 'bg-danger/10 text-danger', text: 'text-danger', bar: 'bg-danger' },
};

const STATUS_STYLE: Record<DimensionStatus, string> = {
  good: 'bg-success-500/10 text-success-500',
  watch: 'bg-warning-500/10 text-warning-500',
  risk: 'bg-danger/10 text-danger',
  unknown: 'bg-bg-tertiary text-text-secondary',
};

const LEVER_ICON: Record<LeverKind, typeof Camera> = {
  reassign: UserCheck,
  gather_evidence: Camera,
  diagnose: Stethoscope,
  restock: PackageCheck,
  order: PackageCheck,
  load_tool: Wrench,
  extend_time: Clock,
  remote_expert: Headphones,
};

const LEVER_LINK: Partial<Record<LeverKind, { to: string; label: string }>> = {
  gather_evidence: { to: '/dashboard/jobs', label: 'Open Jobs' },
  diagnose: { to: '/dashboard/diagnosis-copilot', label: 'Open Diagnosis Copilot' },
  restock: { to: '/dashboard/inventory', label: 'Open Inventory' },
  order: { to: '/dashboard/inventory', label: 'Open Inventory' },
  load_tool: { to: '/dashboard/first-time-fix', label: 'Manage tools' },
  remote_expert: { to: '/dashboard/expert-assist', label: 'Open Expert Assist' },
};

interface Row {
  job: Job;
  rc: ResolutionContext;
  assessment: Assessment;
  plan: ResolutionPlan;
  techName: string | null;
}

function formatTime(iso: string | null): string {
  if (!iso) return 'Unscheduled';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatDelay(hours: number): string {
  if (hours <= 0) return 'No delay';
  if (hours < 1) return `~${Math.round(hours * 60)} min`;
  return hours >= 24 ? `~${Math.round(hours / 24)} day` : `~${Math.round(hours)} h`;
}

function Gauge({ a }: { a: Assessment }) {
  return (
    <div>
      <div className="flex items-end gap-2">
        <span className={`text-5xl font-bold tabular-nums ${VERDICT_META[a.verdict].text}`}>{a.probability}%</span>
        <span className="pb-1.5 text-xs text-text-secondary">likely range {a.low}-{a.high}%</span>
      </div>
      <div
        className="relative mt-3 h-2.5 w-full overflow-hidden rounded-full bg-bg-tertiary"
        role="progressbar"
        aria-label="Resolution probability"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={a.probability}
      >
        <div className="absolute inset-y-0 rounded-full bg-text-secondary/20" style={{ left: `${a.low}%`, width: `${Math.max(1, a.high - a.low)}%` }} />
        <div className={`h-full rounded-full transition-all duration-500 ${VERDICT_META[a.verdict].bar}`} style={{ width: `${a.probability}%` }} />
      </div>
    </div>
  );
}

function SettingsCard({ settings, canManage, onSave }: { settings: RpeSettings; canManage: boolean; onSave: (s: RpeSettings) => Promise<void> }) {
  const { toast } = useToast();
  const [target, setTarget] = useState(String(settings.threshold));
  const [floor, setFloor] = useState(String(settings.floor));
  const [cost, setCost] = useState(String(Math.round(settings.truckRollCostCents / 100)));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTarget(String(settings.threshold));
    setFloor(String(settings.floor));
    setCost(String(Math.round(settings.truckRollCostCents / 100)));
  }, [settings]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = Number(target);
    const f = Number(floor);
    const c = Number(cost);
    if (!Number.isInteger(t) || t < 50 || t > 95) return toast('Target must be a whole number from 50 to 95', 'error');
    if (!Number.isInteger(f) || f < 20 || f > 90 || f >= t) return toast('Hold floor must be from 20 to 90 and below the target', 'error');
    if (!Number.isFinite(c) || c < 0 || c > 100000) return toast('Failed-visit cost must be between 0 and 100,000', 'error');
    setSaving(true);
    try {
      await onSave({ threshold: t, floor: f, truckRollCostCents: Math.round(c * 100) });
    } finally {
      setSaving(false);
    }
  };

  const field = 'focus-ring mt-1 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary disabled:opacity-60';
  return (
    <Card className="!p-6">
      <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary"><ShieldCheck size={16} className="text-accent" /> Dispatch standards</h3>
      <p className="mt-1 text-sm text-text-secondary">Set the resolution probability you require before a truck rolls, and what a failed visit costs you.</p>
      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-4 sm:items-end">
        <label className="text-xs font-semibold uppercase text-text-secondary">
          Target %
          <input type="number" inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} disabled={!canManage} className={field} />
        </label>
        <label className="text-xs font-semibold uppercase text-text-secondary">
          Hold below %
          <input type="number" inputMode="numeric" value={floor} onChange={(e) => setFloor(e.target.value)} disabled={!canManage} className={field} />
        </label>
        <label className="text-xs font-semibold uppercase text-text-secondary">
          Failed visit cost (USD)
          <input type="number" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} disabled={!canManage} className={field} />
        </label>
        <Button type="submit" size="sm" disabled={!canManage || saving}>{saving ? 'Saving...' : 'Save'}</Button>
      </form>
      {!canManage && <p className="mt-3 text-xs text-text-secondary">Only owners, admins and billing managers can change these.</p>}
    </Card>
  );
}

export function ResolutionProbabilityPage() {
  const { user, profile, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canManage = isOwner || permissions.can_view_billing;
  const ownerId = profile?.role === 'owner' ? (user?.id ?? null) : ((profile as { account_owner_id?: string | null } | null)?.account_owner_id ?? user?.id ?? null);

  const [data, setData] = useState<ResolutionData | null>(null);
  const [settings, setSettings] = useState<RpeSettings>(DEFAULT_RPE_SETTINGS);
  const [saved, setSaved] = useState<AssessmentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<'attention' | 'all'>('attention');
  const persisted = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const [d, s, p] = await Promise.all([loadResolutionData(), fetchRpeSettings(), canManage ? fetchAssessmentRecords() : Promise.resolve([])]);
      setData(d);
      setSettings(s);
      setSaved(p);
    } catch {
      toast('Could not load Resolution Probability', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast, canManage]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    return data.base.jobs
      .filter((j) => j.job_status === 'scheduled')
      .map((job) => {
        const rc = buildResolutionContext(data, job);
        const techId = job.assigned_technician_id;
        const tech = data.base.technicians.find((t) => t.id === techId);
        return {
          job,
          rc,
          assessment: assess(rc, techId, settings),
          plan: planResolution(rc, techId, settings),
          techName: tech ? (tech.member_name ?? tech.member_email) : null,
        };
      })
      .sort((a, b) => a.assessment.probability - b.assessment.probability);
  }, [data, settings]);

  // Snapshot assessments for assigned jobs so calibration can compare them with real outcomes later.
  useEffect(() => {
    if (!canManage || !ownerId || rows.length === 0) return;
    const items = rows
      .filter((r) => r.job.assigned_technician_id)
      .map((r) => ({ key: `${r.job.id}:${r.job.assigned_technician_id}:${r.assessment.probability}`, row: r }))
      .filter(({ key }) => {
        if (persisted.current.has(key)) return false;
        persisted.current.add(key);
        return true;
      })
      .slice(0, 200)
      .map(({ row }) => ({
        jobId: row.job.id,
        technicianId: row.job.assigned_technician_id as string,
        assessment: row.assessment,
        recommendation: row.plan.recommendation,
      }));
    if (items.length) void saveAssessments(ownerId, items).catch(() => undefined);
  }, [rows, canManage, ownerId]);

  const visible = filter === 'all' ? rows : rows.filter((r) => r.assessment.verdict !== 'dispatch');
  const selected = rows.find((r) => r.job.id === selectedId) ?? visible[0] ?? rows[0] ?? null;

  const candidates = useMemo(() => {
    if (!selected) return [];
    return rankCandidates(selected.rc, settings)
      .slice(0, 5)
      .map((c) => ({ ...c, withExpert: assess(selected.rc, c.technician.id, settings, { remoteExpert: true }) }));
  }, [selected, settings]);

  const calibration = useMemo(() => (data ? computeCalibration(saved, data.base.jobs, data.base.now) : null), [data, saved]);

  const summary = useMemo(() => {
    const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.assessment.probability, 0) / rows.length) : null;
    const savedCents = rows.reduce((s, r) => s + Math.max(0, r.plan.startFailureCostCents - r.plan.finalFailureCostCents), 0);
    return {
      total: rows.length,
      avg,
      attention: rows.filter((r) => r.assessment.verdict !== 'dispatch').length,
      hold: rows.filter((r) => r.assessment.verdict === 'hold').length,
      savedCents,
    };
  }, [rows]);

  const apply = async (row: Row, lever: Lever) => {
    setBusy(lever.kind);
    try {
      if (lever.kind === 'reassign' && lever.technicianId) {
        await applyReassign(row.job.id, lever.technicianId);
        toast('Technician assigned', 'success');
      } else if (lever.kind === 'extend_time' && lever.minutes) {
        await applyDuration(row.job.id, lever.minutes);
        toast('Booked time updated', 'success');
      } else {
        return;
      }
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Action failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const updateSettings = async (next: RpeSettings) => {
    if (!ownerId) return;
    try {
      await saveRpeSettings(ownerId, next);
      setSettings(next);
      toast('Dispatch standards saved', 'success');
    } catch {
      toast('Could not save settings', 'error');
    }
  };

  if (loading) {
    return (
      <DashboardLayout activeLabel="Resolution Probability">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <SkeletonCardList count={3} />
        </div>
      </DashboardLayout>
    );
  }

  const rec = selected?.plan.recommendation;
  const recTone = rec?.action === 'dispatch_now' ? 'border-success-500/30 bg-success-500/5' : rec?.action === 'hold' ? 'border-danger/30 bg-danger/5' : 'border-warning-500/30 bg-warning-500/5';

  return (
    <DashboardLayout activeLabel="Resolution Probability">
      <FadeIn>
        <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
          <header className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Target size={20} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Resolution Probability Engine</h1>
              <p className="mt-1 max-w-2xl text-sm text-text-secondary">
                Before a truck rolls, Vireek weighs the customer, equipment, evidence, diagnosis, technician, parts, tools and travel to estimate the chance this problem is fully resolved on the visit, then picks the cheapest way to raise it.
              </p>
            </div>
          </header>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: 'Jobs awaiting visit', value: String(summary.total) },
              { label: 'Average probability', value: summary.avg === null ? '-' : `${summary.avg}%` },
              { label: 'Need attention', value: `${summary.attention}${summary.hold ? ` (${summary.hold} on hold)` : ''}` },
              { label: 'Failed-visit cost avoidable', value: formatMoney(summary.savedCents) },
            ].map((k) => (
              <Card key={k.label} className="!p-5">
                <p className="text-xs font-semibold uppercase text-text-secondary">{k.label}</p>
                <p className="mt-1 text-2xl font-bold tabular-nums text-text-primary">{k.value}</p>
              </Card>
            ))}
          </div>

          {rows.length === 0 || !selected ? (
            <EmptyState icon={Target} title="No scheduled jobs to assess" description="When jobs are scheduled, Vireek scores each one here before dispatch." />
          ) : (
            <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
              <div>
                <div className="mb-3 flex gap-2" role="group" aria-label="Filter jobs">
                  {(['attention', 'all'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFilter(f)}
                      aria-pressed={filter === f}
                      className={`focus-ring rounded-full px-3 py-1 text-xs font-semibold ${filter === f ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary'}`}
                    >
                      {f === 'attention' ? 'Needs attention' : 'All jobs'}
                    </button>
                  ))}
                </div>
                {visible.length === 0 ? (
                  <Card className="!p-5 text-sm text-text-secondary"><CheckCircle2 size={16} className="mb-1 text-success-500" /> Every scheduled job meets your target.</Card>
                ) : (
                  <ul className="space-y-2">
                    {visible.map((r) => (
                      <li key={r.job.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(r.job.id)}
                          aria-current={selected.job.id === r.job.id}
                          className={`focus-ring w-full rounded-xl border p-3 text-left transition ${selected.job.id === r.job.id ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-semibold text-text-primary">{r.job.customer_name}</span>
                            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${VERDICT_META[r.assessment.verdict].pill}`}>{r.assessment.probability}%</span>
                          </div>
                          <p className="mt-0.5 truncate text-xs text-text-secondary">{r.job.service_type ?? 'Service'} · {formatTime(r.job.scheduled_datetime)} · {r.techName ?? 'Unassigned'}</p>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="space-y-6">
                <Card className="!p-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold text-text-primary">{selected.job.customer_name}</h2>
                      <p className="text-sm text-text-secondary">{selected.job.service_type ?? 'Service'} · {formatTime(selected.job.scheduled_datetime)} · {selected.techName ?? 'No technician assigned'}</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${VERDICT_META[selected.assessment.verdict].pill}`}>{VERDICT_META[selected.assessment.verdict].label}</span>
                  </div>
                  <div className="mt-5"><Gauge a={selected.assessment} /></div>
                  <p className="mt-2 text-xs text-text-secondary">
                    {selected.assessment.confidence} confidence · baseline {selected.assessment.priorProbability}% from {selected.assessment.priorSource === 'history' ? `${selected.assessment.priorSample} similar jobs` : 'trade benchmark'}
                    {selected.assessment.etaMinutes !== null ? ` · ~${selected.assessment.etaMinutes} min drive` : ''}
                  </p>
                  {rec && (
                    <div className={`mt-5 rounded-xl border p-4 ${recTone}`}>
                      <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                        {rec.action === 'dispatch_now' ? <CheckCircle2 size={16} className="text-success-500" /> : <AlertTriangle size={16} className={rec.action === 'hold' ? 'text-danger' : 'text-warning-500'} />}
                        {rec.headline}
                      </p>
                      <p className="mt-1 text-sm text-text-secondary">{rec.reason}</p>
                      {selected.plan.levers.length > 0 && (
                        <p className="mt-2 text-xs text-text-secondary">
                          Plan: {selected.plan.startProbability}% to {selected.plan.finalProbability}% · expected failed-visit cost {formatMoney(selected.plan.startFailureCostCents)} to {formatMoney(selected.plan.finalFailureCostCents)}
                          {selected.plan.totalDelayHours > 0 ? ` · adds ${formatDelay(selected.plan.totalDelayHours)} before dispatch` : ''}
                        </p>
                      )}
                    </div>
                  )}
                </Card>

                {selected.plan.levers.length > 0 && (
                  <Card className="!p-6">
                    <h3 className="text-base font-semibold text-text-primary">Resolution plan</h3>
                    <p className="mt-1 text-sm text-text-secondary">Ordered by probability gained per hour of delay.</p>
                    <ol className="mt-4 space-y-3">
                      {selected.plan.levers.map((l, i) => {
                        const Icon = LEVER_ICON[l.kind];
                        const link = LEVER_LINK[l.kind];
                        const applicable = canManage && (l.kind === 'reassign' || l.kind === 'extend_time');
                        return (
                          <li key={`${l.kind}-${i}`} className="flex flex-wrap items-start gap-3 rounded-xl bg-bg-primary p-3">
                            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"><Icon size={16} /></span>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold text-text-primary">{l.title} <span className="ml-1 text-xs font-semibold text-success-500">+{l.upliftPts} pts</span></p>
                              <p className="text-xs text-text-secondary">{l.detail}</p>
                              <p className="mt-0.5 text-xs text-text-secondary">{formatDelay(l.delayHours)}{l.blocking ? ' · dispatch waits' : ''} · reaches {l.projectedProbability}%</p>
                            </div>
                            {applicable ? (
                              <Button size="sm" disabled={busy !== null} onClick={() => void apply(selected, l)}>
                                {busy === l.kind ? <Loader2 size={14} className="animate-spin" /> : 'Apply'}
                              </Button>
                            ) : link ? (
                              <Link to={link.to} className="focus-ring inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline">{link.label} <ArrowRight size={12} /></Link>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>
                  </Card>
                )}

                <Card className="!p-6">
                  <h3 className="text-base font-semibold text-text-primary">Why this number</h3>
                  <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                    {selected.assessment.dimensions.map((d) => (
                      <li key={d.key} className="rounded-xl bg-bg-primary p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-text-primary">{d.label}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${STATUS_STYLE[d.status]}`}>
                            {d.status === 'unknown' ? 'No data' : `${d.impactPts > 0 ? '+' : ''}${d.impactPts} pts`}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-text-secondary">{d.detail}</p>
                      </li>
                    ))}
                  </ul>
                </Card>

                <Card className="!p-6">
                  <h3 className="text-base font-semibold text-text-primary">Who should go</h3>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">Technician candidates ranked by resolution probability</caption>
                      <thead>
                        <tr className="text-xs uppercase text-text-secondary">
                          <th scope="col" className="py-2 pr-3 font-semibold">Technician</th>
                          <th scope="col" className="py-2 pr-3 font-semibold">Alone</th>
                          <th scope="col" className="py-2 pr-3 font-semibold">With remote expert</th>
                          <th scope="col" className="py-2 font-semibold">Load</th>
                        </tr>
                      </thead>
                      <tbody>
                        {candidates.map((c) => (
                          <tr key={c.technician.id} className="border-t border-border/60">
                            <td className="py-2 pr-3 text-text-primary">{c.technician.member_name ?? c.technician.member_email}{c.technician.id === selected.job.assigned_technician_id ? <span className="ml-2 text-xs text-text-secondary">(assigned)</span> : null}</td>
                            <td className={`py-2 pr-3 font-semibold tabular-nums ${VERDICT_META[c.assessment.verdict].text}`}>{c.assessment.probability}%</td>
                            <td className="py-2 pr-3 tabular-nums text-text-secondary">{c.withExpert.remoteExpert ? `${c.withExpert.probability}%` : 'No expert available'}</td>
                            <td className="py-2 tabular-nums text-text-secondary">{c.load}/{c.capacity}{c.atCapacity ? ' full' : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </div>
            </div>
          )}

          <SettingsCard settings={settings} canManage={canManage} onSave={updateSettings} />

          {canManage && calibration && (
            <Card className="!p-6">
              <h3 className="text-base font-semibold text-text-primary">Does the model match reality?</h3>
              {calibration.n < 5 ? (
                <p className="mt-2 text-sm text-text-secondary">Calibration appears after at least 5 completed visits with a saved assessment ({calibration.n} so far). Visits count as resolved when no callback follows within 14 days.</p>
              ) : (
                <>
                  <p className="mt-2 text-sm text-text-secondary">
                    Across {calibration.n} completed visits the engine predicted {calibration.meanPredicted}% and {calibration.actualRate}% were actually resolved (Brier score {calibration.brier}; lower is better).
                  </p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-4">
                    {calibration.buckets.map((b) => (
                      <div key={b.label} className="rounded-xl bg-bg-primary p-3">
                        <p className="text-xs font-semibold uppercase text-text-secondary">{b.label}</p>
                        <p className="mt-1 text-sm text-text-primary tabular-nums">{b.n === 0 ? 'No visits' : `${b.predicted}% predicted`}</p>
                        <p className="text-xs text-text-secondary tabular-nums">{b.n === 0 ? '' : `${b.actual}% resolved (${b.n})`}</p>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>
          )}
        </div>
      </FadeIn>
    </DashboardLayout>
  );
}
