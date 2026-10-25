import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Lock, Pencil, Target as TargetIcon } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { FadeIn, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { EscalateToIssueButton } from '@/components/cadence/EscalateToIssueButton';
import {
  CadenceModal,
  ErrorBlock,
  STATUS_PILL,
  Sparkline,
  cardClass,
  errMsg,
  labelClass,
  selectClass,
  type TabProps,
} from '@/components/cadence/shared';
import {
  METRIC_BY_KEY,
  buildScorecard,
  describeWeek,
  estimateMissImpactCents,
  formatMetric,
  kpiMissSourceRef,
  pastWeeks,
  previousValues,
  previousWeekStart,
  targetToDisplay,
  targetToStored,
  trendSeries,
  validateTarget,
  type Direction,
  type MetricValue,
  type ScorecardRow,
  type SnapshotRow,
  type Target,
} from '@/lib/cadence';
import { captureWeeks, deleteTarget, fetchScorecard, fetchSnapshots, fetchTargets, saveTarget } from '@/lib/cadenceApi';

const HISTORY_WEEKS = 13;

function deltaText(row: ScorecardRow): string | null {
  if (row.delta === null || row.delta === 0) return null;
  const sign = row.delta > 0 ? '+' : '−';
  const abs = formatMetric(row.def.key, Math.abs(row.delta));
  return `${sign}${abs} vs last week`;
}

export function ScorecardTab({ canManage, weekStart, canViewFinancials }: TabProps) {
  const { toast } = useToast();
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [metrics, setMetrics] = useState<MetricValue[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [snaps, setSnaps] = useState<SnapshotRow[]>([]);
  const [editing, setEditing] = useState<ScorecardRow | null>(null);

  const weeks = useMemo(() => pastWeeks(weekStart, HISTORY_WEEKS), [weekStart]);

  const load = useCallback(
    async (showSkeleton: boolean) => {
      if (showSkeleton) setState('loading');
      try {
        if (canManage) await captureWeeks(HISTORY_WEEKS).catch(() => 0); // best effort; never blocks the page
        const [m, t, s] = await Promise.all([fetchScorecard(weekStart), fetchTargets(), fetchSnapshots(weeks)]);
        setMetrics(m);
        setTargets(t);
        setSnaps(s);
        setState('ready');
      } catch (e) {
        setError(errMsg(e));
        setState('error');
      }
    },
    [canManage, weekStart, weeks],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const rows = useMemo(() => {
    const history: Record<string, (number | null)[]> = {};
    for (const m of metrics) history[m.metric_key] = trendSeries(snaps, m.metric_key, weeks);
    return buildScorecard({
      current: metrics,
      previous: previousValues(snaps, previousWeekStart(weekStart)),
      targets,
      history,
    });
  }, [metrics, snaps, targets, weeks, weekStart]);

  if (state === 'loading') return <SkeletonStatGrid count={6} />;
  if (state === 'error') return <ErrorBlock message={error} onRetry={() => void load(true)} />;

  const withTarget = rows.filter((r) => r.status !== 'none');
  const green = withTarget.filter((r) => r.status === 'green').length;
  const noData = rows.every((r) => r.value === null && !r.hidden);

  return (
    <FadeIn>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary" aria-live="polite">
          {describeWeek(weekStart)} ·{' '}
          {withTarget.length ? (
            <span className="font-semibold text-text-primary">
              {green} of {withTarget.length} on target
            </span>
          ) : (
            'No targets set yet'
          )}
        </p>
        {!canViewFinancials && (
          <p className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
            <Lock size={12} /> Financial metrics are limited to billing access
          </p>
        )}
      </div>

      {noData && targets.length === 0 ? (
        <EmptyState
          icon={TargetIcon}
          title="Your scorecard fills itself in"
          description="Numbers appear as calls, jobs and invoices come in. Set a target on any metric to get red/green status."
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => {
            const trend = trendSeries(snaps, r.def.key, weeks);
            const tone = r.status === 'green' ? 'success' : r.status === 'red' ? 'danger' : 'neutral';
            const dt = deltaText(r);
            const better = r.delta === null ? null : (r.delta > 0) === ((r.target?.direction ?? r.def.defaultDirection) === 'higher');
            return (
              <li key={r.def.key} className={cardClass} data-testid={`metric-${r.def.key}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-text-primary">{r.def.label}</h3>
                    <p className="mt-0.5 text-xs text-text-secondary">{r.def.hint}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_PILL[r.status]}`}>
                    {r.hidden ? 'Restricted' : r.status === 'green' ? 'On target' : r.status === 'red' ? 'Off target' : r.value === null ? 'No data' : 'No target'}
                  </span>
                </div>

                {r.hidden ? (
                  <p className="mt-4 inline-flex items-center gap-2 text-sm text-text-secondary">
                    <Lock size={14} /> Needs billing access
                  </p>
                ) : (
                  <>
                    <p className="mt-4 text-3xl font-bold tracking-tight text-text-primary">{formatMetric(r.def.key, r.value)}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                      <span>
                        Target:{' '}
                        {r.target ? `${r.target.direction === 'higher' ? '≥' : '≤'} ${formatMetric(r.def.key, r.target.target_value)}` : '—'}
                      </span>
                      {dt && (
                        <span className={`inline-flex items-center gap-0.5 font-medium ${better ? 'text-success-500' : 'text-danger-500'}`}>
                          {r.delta! > 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                          {dt}
                        </span>
                      )}
                      {r.redStreak > 1 && <span className="font-medium text-danger-500">{r.redStreak} weeks off target</span>}
                    </p>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <Sparkline values={[...trend, r.value]} tone={tone} label={r.def.label} />
                      <div className="flex items-center gap-1.5">
                        {r.status === 'red' && (
                          <EscalateToIssueButton
                            compact
                            title={`${r.def.label} missed target (${describeWeek(weekStart)})`}
                            description={`${formatMetric(r.def.key, r.value)} vs target ${formatMetric(r.def.key, r.target?.target_value ?? null)}.`}
                            sourceType="kpi_miss"
                            sourceRef={kpiMissSourceRef(r.def.key, weekStart)}
                            metricKey={r.def.key}
                            impactCents={estimateMissImpactCents(r)}
                          />
                        )}
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => setEditing(r)}
                            aria-label={`Set target for ${r.def.label}`}
                            title="Set target"
                            className="focus-ring rounded-lg border border-border p-1.5 text-text-secondary hover:text-text-primary"
                          >
                            <Pencil size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <TargetModal
        row={editing}
        onClose={() => setEditing(null)}
        onSaved={(msg) => {
          setEditing(null);
          toast(msg, 'success');
          void load(false);
        }}
      />
    </FadeIn>
  );
}

function TargetModal({ row, onClose, onSaved }: { row: ScorecardRow | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const { toast } = useToast();
  const [value, setValue] = useState('');
  const [direction, setDirection] = useState<Direction>('higher');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!row) return;
    setValue(row.target ? String(targetToDisplay(row.def.key, row.target.target_value)) : '');
    setDirection(row.target?.direction ?? row.def.defaultDirection);
    setError(undefined);
  }, [row]);

  const unit = row ? METRIC_BY_KEY[row.def.key].unit : 'count';
  const suffix = unit === 'cents' ? '(dollars)' : unit === 'percent' ? '(%)' : unit === 'days' ? '(days)' : unit === 'rating' ? '(1–5)' : '';

  const save = async () => {
    if (!row || busy) return;
    const err = validateTarget(row.def.key, value);
    if (err) return setError(err);
    setBusy(true);
    try {
      await saveTarget(row.def.key, targetToStored(row.def.key, Number(value)), direction);
      onSaved(`${row.def.label} target saved.`);
    } catch (e) {
      toast(errMsg(e, 'Could not save the target.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!row || busy) return;
    setBusy(true);
    try {
      await deleteTarget(row.def.key);
      onSaved(`${row.def.label} target removed.`);
    } catch (e) {
      toast(errMsg(e, 'Could not remove the target.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <CadenceModal open={row !== null} title={row ? `${row.def.label} target` : 'Target'} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <Input
          label={`Target ${suffix}`.trim()}
          inputMode="decimal"
          value={value}
          error={error}
          onChange={(e) => {
            setValue(e.target.value);
            setError(undefined);
          }}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
        />
        <div>
          <label htmlFor="cadence-direction" className={labelClass}>
            Green when the result is
          </label>
          <select id="cadence-direction" className={selectClass} value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
            <option value="higher">At or above the target</option>
            <option value="lower">At or below the target</option>
          </select>
        </div>
        <div className="flex flex-wrap justify-between gap-2 pt-1">
          {row?.target ? (
            <Button variant="ghost" size="sm" onClick={() => void clear()} disabled={busy}>
              Remove target
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save target'}
            </Button>
          </div>
        </div>
      </div>
    </CadenceModal>
  );
}
