/**
 * Event Prediction Mesh — /dashboard/event-prediction-mesh
 *
 * The Event Bus reports what happened. This page forecasts which events are
 * likely to happen next, shows why, shows how one event cascades into the
 * next, and lets a human approve preemptive actions before it happens.
 *   - src/lib/eventPredictionMesh.ts       pure forecasting engine
 *   - src/lib/eventPredictionMeshApi.ts    signals, persistence, calibration
 *   - supabase/migrations/20270215000000_event_prediction_mesh.sql
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Radar,
  RefreshCw,
  Target,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import {
  DRIVER_LABELS,
  EVENT_DESCRIPTIONS,
  EVENT_IMPACT,
  EVENT_LABELS,
  LEVEL_COLORS,
  LEVEL_LABELS,
  MESH_EDGES,
  MESH_EVENT_ORDER,
  URGENCY_LABELS,
  brierScore,
  calibrationBuckets,
  type MeshLevel,
  type ResolvedPrediction,
} from '@/lib/eventPredictionMesh';
import {
  HORIZON_OPTIONS,
  decideAction,
  fetchLatestRun,
  fetchOpenActions,
  fetchResolvedPredictions,
  fetchRunHistory,
  resolveDuePredictions,
  runMeshForecast,
  type MeshHorizon,
  type StoredAction,
  type StoredPrediction,
  type StoredRun,
} from '@/lib/eventPredictionMeshApi';

const BAR_COLORS: Record<MeshLevel, string> = {
  low: 'bg-success-500',
  elevated: 'bg-accent',
  high: 'bg-warning-500',
  critical: 'bg-danger',
};

const horizonLabel = (h: number): string =>
  h % 24 === 0 ? (h === 24 ? '24 hours' : `${h / 24} days`) : `${h} hours`;
const pctText = (p: number): string => `${Math.round(p * 100)}%`;

function relativeTime(isoString: string): string {
  const minutes = Math.round((Date.now() - new Date(isoString).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function ProbabilityBar({
  value,
  level,
  label,
}: {
  value: number;
  level: MeshLevel;
  label: string;
}) {
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className="h-2 w-full overflow-hidden rounded-full bg-bg-tertiary"
    >
      <div
        className={`h-full rounded-full transition-all duration-500 ${BAR_COLORS[level]}`}
        style={{ width: `${Math.max(2, value * 100)}%` }}
      />
    </div>
  );
}

function PredictionCard({ prediction }: { prediction: StoredPrediction }) {
  const [open, setOpen] = useState(false);
  const probability = Number(prediction.probability);
  const base = Number(prediction.base_probability);
  const confidence = Number(prediction.confidence);
  const lifted = probability - base > 0.02;
  const drivers = prediction.drivers ?? [];
  const cascade = prediction.cascade ?? [];

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-text-primary">
            {EVENT_LABELS[prediction.event_kind]}
          </h3>
          <p className="mt-0.5 text-xs text-text-secondary">
            {EVENT_DESCRIPTIONS[prediction.event_kind]}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${LEVEL_COLORS[prediction.level]}`}
        >
          {LEVEL_LABELS[prediction.level]}
        </span>
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <span className="text-3xl font-bold text-text-primary">{pctText(probability)}</span>
        <span className="text-xs text-text-secondary">
          likelihood · {pctText(confidence)} data confidence
          {lifted ? ` · ${pctText(base)} from own signals` : ''}
        </span>
      </div>
      <div className="mt-2">
        <ProbabilityBar
          value={probability}
          level={prediction.level}
          label={`${EVENT_LABELS[prediction.event_kind]} likelihood`}
        />
      </div>

      {(drivers.length > 0 || cascade.length > 0) && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="focus-ring mt-4 inline-flex items-center gap-1 rounded-lg text-xs font-medium text-accent"
          >
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            Why this forecast
          </button>
          {open && (
            <div className="mt-3 space-y-3">
              {drivers.length > 0 && (
                <ul className="space-y-2">
                  {drivers.map((d) => (
                    <li key={d.key} className="text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-text-primary">
                          {DRIVER_LABELS[d.key]}
                        </span>
                        <span className="text-text-secondary">{pctText(d.value)} pressure</span>
                      </div>
                      <p className="mt-0.5 text-text-secondary">{d.detail}</p>
                    </li>
                  ))}
                </ul>
              )}
              {cascade.length > 0 && (
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs font-semibold text-text-primary">
                    Pushed up by upstream events
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {cascade.map((c) => (
                      <li key={c.from} className="text-xs text-text-secondary">
                        <span className="font-medium text-text-primary">
                          {EVENT_LABELS[c.from]}
                        </span>{' '}
                        (+{Math.round(c.lift * 100)} pts) — {c.why}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function MeshStrip({ predictions }: { predictions: StoredPrediction[] }) {
  const byKind = new Map(predictions.map((p) => [p.event_kind, p]));
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-text-primary">How events cascade</h2>
      <p className="mt-0.5 text-xs text-text-secondary">
        Each arrow shows how strongly one event raises the likelihood of the next.
      </p>
      <ol className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-5">
        {MESH_EVENT_ORDER.map((kind) => {
          const p = byKind.get(kind);
          const children = MESH_EDGES.filter((e) => e.from === kind);
          return (
            <li key={kind} className="rounded-xl border border-border p-3">
              <p className="text-xs font-semibold text-text-primary">{EVENT_LABELS[kind]}</p>
              <p className="mt-1 text-xl font-bold text-text-primary">
                {p ? pctText(Number(p.probability)) : '—'}
              </p>
              {children.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {children.map((e) => (
                    <li
                      key={e.to}
                      className="flex items-center gap-1 text-[11px] text-text-secondary"
                    >
                      <ArrowRight size={11} aria-hidden="true" />
                      {EVENT_LABELS[e.to]} <span className="text-text-primary">×{e.strength}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function ActionRow({
  action,
  busy,
  onDecide,
}: {
  action: StoredAction;
  busy: boolean;
  onDecide: (a: StoredAction, d: 'approved' | 'dismissed' | 'completed') => void;
}) {
  const approved = action.status === 'approved';
  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
              {URGENCY_LABELS[action.urgency]}
            </span>
            <span className="text-[11px] text-text-secondary">
              {EVENT_LABELS[action.event_kind]} · {pctText(Number(action.probability))} likely
            </span>
            {approved && (
              <span className="rounded-full bg-success-500/10 px-2 py-0.5 text-[11px] font-semibold text-success-500">
                Approved
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm font-semibold text-text-primary">{action.title}</p>
          <p className="mt-0.5 text-xs text-text-secondary">{action.detail}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Link
            to={action.href}
            className="focus-ring rounded-lg px-2 py-1.5 text-xs font-medium text-accent hover:underline"
          >
            Open
          </Link>
          {approved ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onDecide(action, 'completed')}
            >
              <CheckCircle2 size={14} /> Mark done
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onDecide(action, 'dismissed')}
                aria-label={`Dismiss: ${action.title}`}
              >
                <X size={14} /> Dismiss
              </Button>
              <Button size="sm" disabled={busy} onClick={() => onDecide(action, 'approved')}>
                <CheckCircle2 size={14} /> Approve
              </Button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

export function EventPredictionMeshPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [horizon, setHorizon] = useState<MeshHorizon>(72);
  const [run, setRun] = useState<StoredRun | null>(null);
  const [predictions, setPredictions] = useState<StoredPrediction[]>([]);
  const [actions, setActions] = useState<StoredAction[]>([]);
  const [history, setHistory] = useState<StoredRun[]>([]);
  const [resolved, setResolved] = useState<ResolvedPrediction[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Score any forecast whose window has closed before reading the calibration numbers.
      await resolveDuePredictions().catch(() => 0);
      const [latest, openActions, runs, scored] = await Promise.all([
        fetchLatestRun(),
        fetchOpenActions(),
        fetchRunHistory(8),
        fetchResolvedPredictions(),
      ]);
      setRun(latest?.run ?? null);
      setPredictions(latest?.predictions ?? []);
      if (latest)
        setHorizon(
          (HORIZON_OPTIONS as readonly number[]).includes(latest.run.horizon_hours)
            ? (latest.run.horizon_hours as MeshHorizon)
            : 72,
        );
      setActions(openActions);
      setHistory(runs);
      setResolved(scored);
    } catch {
      toast('Failed to load the prediction mesh', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const runForecast = useCallback(async () => {
    setRunning(true);
    try {
      await runMeshForecast(horizon);
      await load();
      toast('Forecast updated', 'success');
    } catch {
      toast('Could not run the forecast', 'error');
    } finally {
      setRunning(false);
    }
  }, [horizon, load, toast]);

  const decide = useCallback(
    async (action: StoredAction, decision: 'approved' | 'dismissed' | 'completed') => {
      setBusyAction(action.id);
      try {
        await decideAction(action.id, decision);
        setActions((prev) =>
          decision === 'approved'
            ? prev.map((a) => (a.id === action.id ? { ...a, status: 'approved' } : a))
            : prev.filter((a) => a.id !== action.id),
        );
        toast(
          decision === 'approved'
            ? 'Action approved'
            : decision === 'completed'
              ? 'Marked as done'
              : 'Action dismissed',
          'success',
        );
      } catch {
        toast('Could not save that decision', 'error');
        void load();
      } finally {
        setBusyAction(null);
      }
    },
    [load, toast],
  );

  const orderedPredictions = useMemo(
    () =>
      [...predictions].sort(
        (x, y) =>
          Number(y.probability) * EVENT_IMPACT[y.event_kind] -
          Number(x.probability) * EVENT_IMPACT[x.event_kind],
      ),
    [predictions],
  );

  const brier = useMemo(() => brierScore(resolved), [resolved]);
  const buckets = useMemo(
    () => calibrationBuckets(resolved).filter((b) => b.count > 0),
    [resolved],
  );
  const stale = run ? Date.now() - new Date(run.created_at).getTime() > 6 * 3_600_000 : false;

  return (
    <DashboardLayout activeLabel="Event Prediction Mesh">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Radar size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Event Prediction Mesh</h1>
            <p className="mt-1 text-sm text-text-secondary">
              The Event Bus tells you what happened. The Mesh forecasts what happens next — and lets
              you act before it does.
            </p>
          </div>
        </div>

        <Card className="mb-6 p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs text-text-secondary">Forecast window</p>
              <div
                className="mt-1.5 inline-flex rounded-xl border border-border p-1"
                role="group"
                aria-label="Forecast window"
              >
                {HORIZON_OPTIONS.map((h) => (
                  <button
                    key={h}
                    type="button"
                    aria-pressed={horizon === h}
                    onClick={() => setHorizon(h)}
                    className={`focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                      horizon === h
                        ? 'bg-accent text-white'
                        : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {horizonLabel(h)}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {run && (
                <p className={`text-xs ${stale ? 'text-warning-500' : 'text-text-secondary'}`}>
                  Last run {relativeTime(run.created_at)} · {pctText(Number(run.data_coverage))} of
                  data sources available
                </p>
              )}
              <Button onClick={runForecast} disabled={running}>
                <RefreshCw size={14} className={running ? 'animate-spin' : ''} />
                {running ? 'Forecasting…' : 'Run forecast'}
              </Button>
            </div>
          </div>
          {run && run.unavailable_sources.length > 0 && (
            <p className="mt-3 text-xs text-text-secondary">
              Not enough data from: {run.unavailable_sources.join(', ')}. Those signals lower
              confidence instead of counting as “safe”.
            </p>
          )}
        </Card>

        {loading ? (
          <SkeletonCardList count={3} rows={3} />
        ) : !run ? (
          <EmptyState
            icon={Radar}
            title="No forecast yet"
            description="Run your first forecast to see which events are likely over the next few days and what to do about them."
            action={{ label: 'Run forecast', onClick: () => void runForecast() }}
          />
        ) : (
          <div className="space-y-8">
            <section aria-labelledby="mesh-predictions">
              <h2 id="mesh-predictions" className="mb-3 text-lg font-semibold text-text-primary">
                Expected events · next {horizonLabel(run.horizon_hours)}
              </h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {orderedPredictions.map((p) => (
                  <PredictionCard key={p.id} prediction={p} />
                ))}
              </div>
            </section>

            <MeshStrip predictions={predictions} />

            <section aria-labelledby="mesh-actions">
              <h2 id="mesh-actions" className="mb-3 text-lg font-semibold text-text-primary">
                Preemptive actions
              </h2>
              {actions.length === 0 ? (
                <EmptyState
                  icon={Target}
                  title="Nothing to do right now"
                  description="No forecast event is likely enough to need action. New proposals appear here when risk rises."
                />
              ) : (
                <ul className="space-y-3">
                  {actions.map((a) => (
                    <ActionRow key={a.id} action={a} busy={busyAction === a.id} onDecide={decide} />
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-text-secondary">
                Nothing runs automatically — approving records the decision and notifies you; each
                action opens the page where you carry it out.
              </p>
            </section>

            <section aria-labelledby="mesh-accuracy">
              <h2 id="mesh-accuracy" className="mb-3 text-lg font-semibold text-text-primary">
                Forecast accuracy
              </h2>
              <Card className="p-5">
                {resolved.length === 0 ? (
                  <p className="text-sm text-text-secondary">
                    Accuracy appears once your first forecast window closes and the Mesh can compare
                    each prediction with what actually happened.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
                    <div>
                      <p className="text-xs text-text-secondary">Brier score (lower is better)</p>
                      <p className="text-3xl font-bold text-text-primary">{brier?.toFixed(3)}</p>
                      <p className="mt-1 text-xs text-text-secondary">
                        {resolved.length} scored predictions · 0.250 equals guessing 50/50
                      </p>
                    </div>
                    <div className="md:col-span-2">
                      <p className="mb-2 text-xs text-text-secondary">
                        When we said X%, how often did it happen?
                      </p>
                      <ul className="space-y-2">
                        {buckets.map((b) => (
                          <li key={b.label} className="flex items-center gap-3 text-xs">
                            <span className="w-16 shrink-0 text-text-secondary">{b.label}</span>
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
                              <div
                                className="h-full rounded-full bg-accent"
                                style={{ width: `${b.observedRate * 100}%` }}
                              />
                            </div>
                            <span className="w-28 shrink-0 text-right text-text-secondary">
                              {pctText(b.observedRate)} happened · n={b.count}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </Card>
            </section>

            {history.length > 1 && (
              <section aria-labelledby="mesh-history">
                <h2 id="mesh-history" className="mb-3 text-lg font-semibold text-text-primary">
                  Recent runs
                </h2>
                <Card className="overflow-x-auto p-0">
                  <table className="w-full min-w-[640px] text-left text-xs">
                    <thead>
                      <tr className="border-b border-border text-text-secondary">
                        <th scope="col" className="px-4 py-3 font-medium">
                          When
                        </th>
                        <th scope="col" className="px-4 py-3 font-medium">
                          Window
                        </th>
                        {MESH_EVENT_ORDER.map((k) => (
                          <th key={k} scope="col" className="px-4 py-3 font-medium">
                            {EVENT_LABELS[k]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((r) => {
                        const byKind = new Map(
                          (r.prediction_mesh_predictions ?? []).map((p) => [p.event_kind, p]),
                        );
                        return (
                          <tr key={r.id} className="border-b border-border/60 last:border-0">
                            <td className="px-4 py-3 text-text-primary">
                              {relativeTime(r.created_at)}
                            </td>
                            <td className="px-4 py-3 text-text-secondary">
                              {horizonLabel(r.horizon_hours)}
                            </td>
                            {MESH_EVENT_ORDER.map((k) => {
                              const p = byKind.get(k);
                              return (
                                <td key={k} className="px-4 py-3">
                                  {p ? (
                                    <span
                                      className={`rounded-full px-2 py-0.5 font-semibold ${LEVEL_COLORS[p.level]}`}
                                    >
                                      {pctText(Number(p.probability))}
                                    </span>
                                  ) : (
                                    '—'
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Card>
              </section>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
