// src/pages/DurationIntelligencePage.tsx
//
// Job-duration prediction console: how accurate the model is, predicted vs actual,
// drift alerts, what it expects for the jobs on the board, what it has learned per
// job type / technician / equipment, and the switches that feed dispatch and booking.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Gauge, RefreshCcw, ShieldAlert, TrendingDown, TrendingUp } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard, SkeletonStatGrid } from '@/components/Skeleton';
import type { Job } from '@/lib/supabase';
import {
  DURATION_MODEL,
  equipmentTypeEffects,
  formatMinutes,
  formatRange,
  slotMinutesFor,
  summarizeBacktest,
  summarizeBy,
  technicianEffects,
  typeTable,
  type BacktestRecord,
  type DriftReport,
  type DurationPrediction,
  type SlotPolicy,
} from '@/lib/durationModel';
import {
  DEFAULT_DURATION_SETTINGS,
  evaluateDrift,
  fetchDriftAlerts,
  fetchScoredPredictions,
  fetchUpcomingJobs,
  loadDurationModel,
  predictForJobs,
  publishServiceStats,
  recordPredictions,
  saveDurationSettings,
  setDriftAlertStatus,
  syncDriftAlerts,
  type DriftAlertRow,
  type DurationSettings,
  type LoadedDurationModel,
  type StoredPredictionRow,
} from '@/lib/durationModelApi';

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-5';
const TH = 'px-3 py-2 text-left text-xs font-medium text-text-secondary';
const TD = 'px-3 py-2 text-sm tabular-nums text-text-primary';

const SEVERITY_STYLE: Record<'info' | 'warning' | 'critical', string> = {
  info: 'border-border bg-bg-primary text-text-primary',
  warning: 'border-amber-500/40 bg-amber-500/5 text-text-primary',
  critical: 'border-danger/40 bg-danger/5 text-text-primary',
};

const POLICY_COPY: Record<SlotPolicy, { title: string; body: string }> = {
  tight: { title: 'Tight (P50)', body: 'Reserve the typical time. Fits the most jobs, overruns about half the time.' },
  balanced: { title: 'Balanced (P75)', body: 'Reserve enough for three of four jobs. Recommended.' },
  safe: { title: 'Safe (P90)', body: 'Reserve for nine of ten jobs. Fewer overruns, fewer jobs per day.' },
};

const fmtPct = (v: number, digits = 0) => `${v.toFixed(digits)}%`;
const fmtSigned = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v)}%`;
const fmtDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-amber-500' : 'text-text-primary';
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${color}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

// ------------------------------------------------------------
// Predicted vs actual (scatter + P10–P90 whiskers)
// ------------------------------------------------------------

interface Point {
  predicted: number;
  actual: number;
  low: number;
  high: number;
  within: boolean;
}

function PredictedActualChart({ points }: { points: Point[] }) {
  const W = 560;
  const H = 320;
  const pad = { l: 44, r: 12, t: 12, b: 36 };
  const shown = points.slice(-120);
  if (shown.length === 0) return null;
  const vals = shown.flatMap((p) => [p.predicted, p.actual, p.high]).sort((a, b) => a - b);
  const max = Math.max(30, Math.ceil(vals[Math.floor(vals.length * 0.97)] / 30) * 30);
  const x = (v: number) => pad.l + (Math.min(v, max) / max) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (Math.min(v, max) / max) * (H - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round((max * f) / 5) * 5);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Predicted versus actual job duration in minutes">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="currentColor" className="text-border" strokeWidth={1} />
          <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="fill-text-secondary" fontSize={10}>{t}</text>
          <text x={x(t)} y={H - pad.b + 14} textAnchor="middle" className="fill-text-secondary" fontSize={10}>{t}</text>
        </g>
      ))}
      <line x1={x(0)} y1={y(0)} x2={x(max)} y2={y(max)} stroke="currentColor" className="text-text-secondary" strokeDasharray="4 4" strokeWidth={1} />
      {shown.map((p, i) => (
        <g key={i}>
          <line x1={x(p.predicted)} x2={x(p.predicted)} y1={y(p.low)} y2={y(p.high)} stroke="currentColor" className={p.within ? 'text-success' : 'text-amber-500'} strokeOpacity={0.35} strokeWidth={2} />
          <circle cx={x(p.predicted)} cy={y(p.actual)} r={3.2} className={p.within ? 'fill-success' : 'fill-amber-500'} />
        </g>
      ))}
      <text x={(W + pad.l) / 2} y={H - 4} textAnchor="middle" className="fill-text-secondary" fontSize={11}>Predicted minutes (P50)</text>
      <text x={12} y={H / 2} textAnchor="middle" className="fill-text-secondary" fontSize={11} transform={`rotate(-90 12 ${H / 2})`}>Actual minutes</text>
    </svg>
  );
}

// ------------------------------------------------------------
// Page
// ------------------------------------------------------------

type View = 'asMade' | 'backtest';

export function DurationIntelligencePage() {
  const { profile, teamMember, isOwner } = useAuth();
  const { toast } = useToast();
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState<LoadedDurationModel | null>(null);
  const [settings, setSettings] = useState<DurationSettings>(DEFAULT_DURATION_SETTINGS);
  const [report, setReport] = useState<DriftReport | null>(null);
  const [alerts, setAlerts] = useState<DriftAlertRow[]>([]);
  const [stored, setStored] = useState<StoredPredictionRow[]>([]);
  const [upcoming, setUpcoming] = useState<{ job: Job; prediction: DurationPrediction }[]>([]);
  const [view, setView] = useState<View>('backtest');
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (force = false) => {
      if (!ownerId) return;
      setLoading(true);
      try {
        const l = await loadDurationModel(ownerId, { force });
        setLoaded(l);
        setSettings(l.settings);
        const r = evaluateDrift(l);
        setReport(r);
        if (l.settings.driftAlertsEnabled) await syncDriftAlerts(r);
        const [alertRows, scored, jobs] = await Promise.all([fetchDriftAlerts(ownerId), fetchScoredPredictions(ownerId), fetchUpcomingJobs(ownerId)]);
        setAlerts(alertRows);
        setStored(scored);
        if (scored.length >= 10) setView('asMade');
        if (jobs.length > 0) {
          const { predictions } = await predictForJobs(ownerId, jobs);
          setUpcoming(jobs.filter((j) => predictions[j.id]).map((j) => ({ job: j, prediction: predictions[j.id] })));
          void recordPredictions(jobs, predictions, l.settings.slotPolicy).catch(() => 0);
        } else {
          setUpcoming([]);
        }
        if (l.settings.feedBooking) void publishServiceStats(l.model).catch(() => 0);
      } catch {
        toast('Could not load duration predictions. Is the job duration migration applied?', 'error');
      } finally {
        setLoading(false);
      }
    },
    [ownerId, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const model = loaded?.model ?? null;
  const techNames = loaded?.techNames ?? {};

  // --- scorecard data ---------------------------------------------------
  const backtest: BacktestRecord[] = useMemo(() => (model ? model.records.slice(-300) : []), [model]);

  const storedRecords: BacktestRecord[] = useMemo(
    () =>
      stored.map((s) => ({
        jobId: s.job_id,
        completedAtMs: Date.parse(s.predicted_at),
        jobTypeKey: s.job_type_key,
        technicianId: s.technician_id,
        predicted: s.p50,
        low: s.p10,
        high: s.p90,
        actual: s.actual_minutes,
        logError: Math.log(s.actual_minutes / s.p50),
        withinRange: s.within_range ?? (s.actual_minutes >= s.p10 && s.actual_minutes <= s.p90),
        baselineMinutes: s.existing_minutes,
        source: 'model' as const,
      })),
    [stored],
  );

  const active = view === 'asMade' && storedRecords.length >= 10 ? storedRecords : backtest;
  const summary = useMemo(() => summarizeBacktest(active), [active]);
  const points: Point[] = useMemo(() => active.map((r) => ({ predicted: r.predicted, actual: r.actual, low: r.low, high: r.high, within: r.withinRange })), [active]);

  const byType = useMemo(() => (model ? summarizeBy(backtest, (r) => r.jobTypeKey, 3) : []), [model, backtest]);
  const types = useMemo(() => (model ? typeTable(model) : []), [model]);
  const techRows = useMemo(() => (model ? technicianEffects(model) : []), [model]);
  const eqRows = useMemo(() => (model ? equipmentTypeEffects(model) : []), [model]);
  const typeStats = useMemo(() => new Map(byType.map((b) => [b.key, b])), [byType]);

  const levelPct = Math.round(DURATION_MODEL.intervalLevel * 100);
  const coveragePct = summary.coverage * 100;
  const coverageTone = summary.n < 10 ? undefined : Math.abs(coveragePct - levelPct) <= 8 ? 'ok' : Math.abs(coveragePct - levelPct) <= 15 ? 'warn' : 'bad';

  // --- actions ----------------------------------------------------------
  const acknowledge = async (a: DriftAlertRow) => {
    const ok = await setDriftAlertStatus(a.id, 'acknowledged');
    if (ok) setAlerts((rows) => rows.map((r) => (r.id === a.id ? { ...r, status: 'acknowledged' } : r)));
    else toast('Could not acknowledge this alert.', 'error');
  };

  const persistSettings = async (next: DurationSettings) => {
    setSettings(next);
    setSaving(true);
    const ok = await saveDurationSettings(ownerId as string, next);
    setSaving(false);
    if (!ok) {
      toast('Only the account owner can change these settings.', 'error');
      if (loaded) setSettings(loaded.settings);
      return;
    }
    toast('Duration settings saved.', 'success');
    void load(true);
  };

  const noData = !loading && (!model || model.trainedOn === 0);

  return (
    <DashboardLayout activeLabel="Duration Intelligence">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Gauge size={24} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold text-text-primary">Duration Intelligence</h1>
          <p className="text-sm text-text-secondary">
            Learns how long each job really takes — by job type, technician, equipment and customer — and tells you how sure it is.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load(true)} disabled={loading}>
          <RefreshCcw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>

      {loading && !loaded ? (
        <div className="space-y-4">
          <SkeletonStatGrid count={4} />
          <SkeletonCard rows={4} />
        </div>
      ) : noData ? (
        <EmptyState
          icon={Gauge}
          title="Nothing to learn from yet"
          description="Predictions start once technicians have started and completed jobs on site. Until then, your existing estimates stay in charge."
        />
      ) : (
        <div className="space-y-6">
          {/* KPIs */}
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label="Model accuracy">
            <Stat label="Jobs learned from" value={(model?.trainedOn ?? 0).toLocaleString()} hint={model && model.dropped > 0 ? `${model.dropped} unusable timings skipped` : 'Timed on site'} />
            <Stat label="Typical miss" value={summary.n ? fmtPct(summary.medianApe * 100) : '—'} hint={summary.n ? `Median error · avg ${formatMinutes(summary.mae)} off` : undefined} />
            <Stat label={`${levelPct}% range holds`} value={summary.n ? fmtPct(coveragePct) : '—'} hint={`Target ${levelPct}% — actuals inside P10–P90`} tone={coverageTone} />
            <Stat
              label="Bias"
              value={summary.n ? fmtSigned(summary.biasPct) : '—'}
              hint={summary.n ? (summary.biasPct > 3 ? 'Jobs run longer than predicted' : summary.biasPct < -3 ? 'Jobs run shorter than predicted' : 'Well centered') : undefined}
              tone={Math.abs(summary.biasPct) > 12 ? 'bad' : Math.abs(summary.biasPct) > 6 ? 'warn' : undefined}
            />
            <Stat
              label="vs your estimates"
              value={summary.baseline ? fmtSigned(summary.baseline.improvementPct) : '—'}
              hint={summary.baseline ? `Error ${summary.baseline.improvementPct >= 0 ? 'down' : 'up'} across ${summary.baseline.n} jobs` : 'Needs jobs with a planned duration'}
              tone={summary.baseline && summary.baseline.improvementPct < 0 ? 'warn' : undefined}
            />
          </section>

          {/* Drift */}
          <section className={CARD} aria-label="Drift alerts">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {report?.status === 'drifting' ? (
                <ShieldAlert size={18} className="text-danger" aria-hidden="true" />
              ) : report?.status === 'watch' ? (
                <AlertTriangle size={18} className="text-amber-500" aria-hidden="true" />
              ) : (
                <CheckCircle2 size={18} className="text-success" aria-hidden="true" />
              )}
              <h2 className="text-base font-semibold text-text-primary">Drift monitor</h2>
              <span className="text-xs text-text-secondary">
                {report?.status === 'insufficient_data'
                  ? 'Needs about 25 timed jobs to judge drift.'
                  : report?.status === 'stable'
                    ? `Stable — last ${report.recentN} jobs match the model.`
                    : report?.status === 'watch'
                      ? 'Something is moving. Worth a look.'
                      : 'Predictions are drifting from reality.'}
              </span>
            </div>

            {alerts.length === 0 && (report?.alerts.length ?? 0) === 0 ? (
              report?.status !== 'insufficient_data' && <p className="text-sm text-text-secondary">No open alerts. The model is tracking reality.</p>
            ) : (
              <ul className="space-y-2">
                {(alerts.length > 0
                  ? alerts.map((a) => ({ id: a.id, severity: a.severity, message: a.message, direction: a.direction, status: a.status, when: a.last_detected_at, row: a as DriftAlertRow | null }))
                  : (report?.alerts ?? []).map((a) => ({ id: a.key, severity: a.severity, message: a.message, direction: a.direction, status: 'open' as const, when: new Date(a.sinceMs ?? Date.now()).toISOString(), row: null as DriftAlertRow | null }))
                ).map((a) => (
                  <li key={a.id} className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 ${SEVERITY_STYLE[a.severity]}`}>
                    {a.direction === 'longer' ? <TrendingUp size={16} aria-hidden="true" /> : a.direction === 'shorter' ? <TrendingDown size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{a.message}</p>
                      <p className="text-xs text-text-secondary">
                        {a.severity} · {a.status} · updated {fmtDateTime(a.when)}
                      </p>
                    </div>
                    {a.row && a.status === 'open' && (
                      <Button variant="secondary" size="sm" onClick={() => void acknowledge(a.row as DriftAlertRow)}>
                        Acknowledge
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-text-secondary">
              The model re-learns from every completed job and favors recent work, so small shifts correct themselves. An alert means reality is moving faster than it can adapt.
            </p>
          </section>

          {/* Predicted vs actual */}
          <section className={CARD} aria-label="Predicted versus actual">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="flex-1 text-base font-semibold text-text-primary">Predicted vs actual</h2>
              <div className="inline-flex rounded-xl border border-border bg-bg-primary p-1" role="group" aria-label="Data source">
                <button
                  type="button"
                  aria-pressed={view === 'asMade'}
                  disabled={storedRecords.length < 10}
                  onClick={() => setView('asMade')}
                  className={`focus-ring rounded-lg px-3 py-1 text-xs font-medium disabled:opacity-40 ${view === 'asMade' && storedRecords.length >= 10 ? 'bg-accent text-white' : 'text-text-secondary'}`}
                >
                  As predicted at the time ({storedRecords.length})
                </button>
                <button
                  type="button"
                  aria-pressed={view === 'backtest'}
                  onClick={() => setView('backtest')}
                  className={`focus-ring rounded-lg px-3 py-1 text-xs font-medium ${view === 'backtest' || storedRecords.length < 10 ? 'bg-accent text-white' : 'text-text-secondary'}`}
                >
                  Walk-forward backtest ({backtest.length})
                </button>
              </div>
            </div>
            <PredictedActualChart points={points} />
            <p className="mt-2 text-xs text-text-secondary">
              Each dot is a finished job; the line shows the {levelPct}% range. Green means the actual landed inside it. The backtest predicts every job using only the jobs that finished before it, so it can't flatter itself. “As predicted at the time” fills in as scheduled jobs complete.
            </p>
          </section>

          {/* Upcoming */}
          <section className={CARD} aria-label="Upcoming jobs">
            <h2 className="mb-3 text-base font-semibold text-text-primary">Upcoming jobs</h2>
            {upcoming.length === 0 ? (
              <p className="text-sm text-text-secondary">No open jobs scheduled in the next two weeks.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr>
                      <th className={TH}>When</th>
                      <th className={TH}>Job</th>
                      <th className={TH}>Technician</th>
                      <th className={TH}>Booked</th>
                      <th className={TH}>Predicted ({levelPct}%)</th>
                      <th className={TH}>Reserve</th>
                      <th className={TH}>Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {upcoming.map(({ job, prediction: p }) => {
                      const reserve = slotMinutesFor(p, settings.slotPolicy);
                      const booked = job.duration_minutes ?? null;
                      const short = booked !== null && reserve !== null && reserve - booked >= 15;
                      return (
                        <tr key={job.id} className="border-t border-border">
                          <td className={TD}>{fmtDateTime(job.scheduled_datetime)}</td>
                          <td className="px-3 py-2 text-sm text-text-primary">
                            {job.customer_name}
                            <span className="block text-xs text-text-secondary">{job.service_type ?? 'Unspecified'}</span>
                          </td>
                          <td className="px-3 py-2 text-sm text-text-primary">{job.assigned_technician_id ? (techNames[job.assigned_technician_id] ?? 'Technician') : 'Unassigned'}</td>
                          <td className={`${TD} ${short ? 'text-amber-500' : ''}`}>{booked !== null ? formatMinutes(booked) : '—'}</td>
                          <td className={TD}>
                            {p.source === 'prior' ? <span className="text-text-secondary">Learning · {formatMinutes(p.existing.minutes)}</span> : `${formatMinutes(p.minutes)} (${formatRange(p.low, p.high)})`}
                          </td>
                          <td className={TD}>{reserve !== null ? formatMinutes(reserve) : '—'}</td>
                          <td className="px-3 py-2 text-sm capitalize text-text-secondary">{p.confidence}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs text-text-secondary">Amber means the booked slot is shorter than what the model recommends reserving. Change it from the schedule drawer.</p>
          </section>

          {/* Learned */}
          <section className="grid gap-4 lg:grid-cols-2" aria-label="What it has learned">
            <div className={`${CARD} lg:col-span-2`}>
              <h2 className="mb-3 text-base font-semibold text-text-primary">By job type</h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px]">
                  <thead>
                    <tr>
                      <th className={TH}>Job type</th>
                      <th className={TH}>Jobs</th>
                      <th className={TH}>Typical</th>
                      <th className={TH}>P10–P90 (actual)</th>
                      <th className={TH}>Typical miss</th>
                      <th className={TH}>Bias</th>
                    </tr>
                  </thead>
                  <tbody>
                    {types.slice(0, 15).map((t) => {
                      const s = typeStats.get(t.key);
                      return (
                        <tr key={t.key} className="border-t border-border">
                          <td className="px-3 py-2 text-sm capitalize text-text-primary">{t.key}</td>
                          <td className={TD}>{t.n}</td>
                          <td className={TD}>{formatMinutes(t.medianMinutes)}</td>
                          <td className={TD}>{formatRange(t.p10Minutes, t.p90Minutes)}</td>
                          <td className={TD}>{s ? fmtPct(s.medianApe * 100) : '—'}</td>
                          <td className={TD}>{s ? fmtSigned(s.biasPct) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className={CARD}>
              <h2 className="mb-1 text-base font-semibold text-text-primary">Technician effect</h2>
              <p className="mb-3 text-xs text-text-secondary">How much longer (+) or shorter (−) than the type average, after accounting for the jobs they get.</p>
              {techRows.length === 0 ? (
                <p className="text-sm text-text-secondary">Needs at least 3 timed jobs per technician.</p>
              ) : (
                <ul className="space-y-1.5">
                  {techRows.slice(0, 10).map((t) => (
                    <li key={t.id} className="flex items-center justify-between text-sm">
                      <span className="text-text-primary">{techNames[t.id] ?? 'Technician'}</span>
                      <span className="tabular-nums text-text-secondary">
                        <span className={Math.abs(t.effectPct) >= 10 ? 'font-semibold text-text-primary' : ''}>{fmtSigned(t.effectPct)}</span> · {t.n} jobs
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className={CARD}>
              <h2 className="mb-1 text-base font-semibold text-text-primary">Equipment effect</h2>
              <p className="mb-3 text-xs text-text-secondary">Equipment types that make a job take longer or shorter than usual.</p>
              {eqRows.length === 0 ? (
                <p className="text-sm text-text-secondary">Link equipment to jobs to learn this.</p>
              ) : (
                <ul className="space-y-1.5">
                  {eqRows.slice(0, 10).map((e) => (
                    <li key={e.id} className="flex items-center justify-between text-sm">
                      <span className="capitalize text-text-primary">{e.id}</span>
                      <span className="tabular-nums text-text-secondary">
                        <span className={Math.abs(e.effectPct) >= 10 ? 'font-semibold text-text-primary' : ''}>{fmtSigned(e.effectPct)}</span> · {e.n} jobs
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* Settings */}
          <section className={CARD} aria-label="Settings">
            <h2 className="mb-1 text-base font-semibold text-text-primary">How predictions are used</h2>
            <p className="mb-4 text-xs text-text-secondary">
              {isOwner ? 'These switches decide where the model is allowed to change what your team and customers see.' : 'Only the account owner can change these.'}
            </p>

            <fieldset disabled={!isOwner || saving} className="space-y-4">
              <legend className="sr-only">Slot policy</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {(Object.keys(POLICY_COPY) as SlotPolicy[]).map((p) => (
                  <label key={p} className={`cursor-pointer rounded-xl border p-3 ${settings.slotPolicy === p ? 'border-accent bg-accent/5' : 'border-border bg-bg-primary'}`}>
                    <input type="radio" name="slot-policy" className="sr-only" checked={settings.slotPolicy === p} onChange={() => void persistSettings({ ...settings, slotPolicy: p })} />
                    <span className="block text-sm font-semibold text-text-primary">{POLICY_COPY[p].title}</span>
                    <span className="mt-0.5 block text-xs text-text-secondary">{POLICY_COPY[p].body}</span>
                  </label>
                ))}
              </div>

              {(
                [
                  ['feedDispatch', 'Feed dispatch', 'Dispatch scoring and conflict checks use the recommended slot length instead of the booked default.'],
                  ['feedBooking', 'Feed online booking', 'Customer-facing: the booking page reserves the learned time for each service. Only services with 8+ timed jobs are used.'],
                  ['driftAlertsEnabled', 'Drift alerts', 'Raise an alert when predictions stop matching reality.'],
                ] as const
              ).map(([key, title, body]) => (
                <label key={key} className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" className="mt-1 h-4 w-4 accent-accent" checked={settings[key]} onChange={(e) => void persistSettings({ ...settings, [key]: e.target.checked })} />
                  <span>
                    <span className="block text-sm font-medium text-text-primary">{title}</span>
                    <span className="block text-xs text-text-secondary">{body}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </section>
        </div>
      )}
    </DashboardLayout>
  );
}
