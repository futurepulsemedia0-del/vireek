/**
 * Continuous Improvement — /dashboard/continuous-improvement
 *
 * Vireek's closed loop: Prediction -> Decision -> Action -> Outcome -> Compare
 * expected vs actual -> Find error -> Learn -> Update model/workflow -> Repeat.
 * Every job outcome is compared with the prediction made before dispatch, the
 * miss is explained from recorded evidence, and corrections are learned,
 * backtested, and applied only after the owner approves them.
 * See src/lib/improvementLoop.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, RefreshCw, RotateCcw } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { formatDuration } from '@/lib/outcomeAssurance';
import {
  analyzeLoop,
  CAUSE_COLORS,
  CAUSE_LABELS,
  decideCorrection,
  fetchCorrections,
  gatherLoopData,
  humanizeKey,
  LOOP,
  persistLoopRun,
  type CauseShare,
  type CauseSummary,
  type CorrectionPerformance,
  type CorrectionRow,
  type DurationVariance,
  type FtfVariance,
  type LoopAnalysis,
  type TrendPoint,
} from '@/lib/improvementLoop';

type Tab = 'learning' | 'misses' | 'causes' | 'actions';

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-4';

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return 'Something went wrong';
}

const pct = (x: number | null, digits = 0) => (x === null ? '—' : `${(x * 100).toFixed(digits)}%`);
const signedPct = (ratio: number) => `${ratio >= 1 ? '+' : '−'}${Math.abs(Math.round((ratio - 1) * 100))}%`;
const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

// ============================================================
// SMALL PARTS
// ============================================================

function StatCard({ label, value, hint, valueClass = 'text-text-primary' }: { label: string; value: string; hint?: string; valueClass?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`text-lg font-semibold ${valueClass}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function Pipeline({ a, active }: { a: LoopAnalysis; active: number }) {
  const off = a.durationVariances.filter((v) => v.direction === 'over').length;
  const explained = a.durationVariances.filter((v) => v.primaryCause && v.primaryCause !== 'unexplained').length;
  const stages: Array<{ label: string; value: number }> = [
    { label: 'Predicted', value: a.totals.predicted },
    { label: 'Outcomes', value: a.totals.outcomes },
    { label: 'Ran over', value: off },
    { label: 'Explained', value: explained },
    { label: 'Learned', value: a.proposals.length },
    { label: 'Applied', value: active },
  ];
  return (
    <ol className="mb-5 flex flex-wrap items-center gap-1.5" aria-label="Improvement loop stages">
      {stages.map((s, i) => (
        <li key={s.label} className="flex items-center gap-1.5">
          <span className="rounded-xl bg-bg-secondary px-3 py-1.5 text-xs text-text-secondary">
            <span className="font-semibold text-text-primary">{s.value}</span> {s.label}
          </span>
          {i < stages.length - 1 && <ArrowRight size={12} className="text-text-secondary" aria-hidden="true" />}
        </li>
      ))}
      <li className="flex items-center gap-1.5 text-xs text-text-secondary">
        <RefreshCw size={12} aria-hidden="true" /> repeats with every job
      </li>
    </ol>
  );
}

function TrendChart({ points }: { points: TrendPoint[] }) {
  const hasData = points.some((p) => p.n > 0);
  return (
    <div className={CARD}>
      <p className="mb-1 text-sm font-medium text-text-primary">Duration accuracy by week</p>
      <p className="mb-3 text-xs text-text-secondary">Share of jobs finished within {Math.round(LOOP.durationTolerance * 100)}% of the prediction. Rising bars mean the loop is working.</p>
      {hasData ? (
        <div className="flex h-24 items-end gap-2" role="img" aria-label="Weekly duration accuracy">
          {points.map((p) => (
            <div key={p.weekStart} className="flex flex-1 flex-col items-center gap-1" title={`${shortDate(p.weekStart)}: ${p.n} jobs, ${pct(p.hitRate)} on target`}>
              <div className="flex h-16 w-full items-end rounded bg-bg-tertiary">
                <div className="w-full rounded bg-accent" style={{ height: `${Math.max(p.hitRate === null ? 0 : p.hitRate * 100, p.n > 0 ? 4 : 0)}%` }} />
              </div>
              <span className="text-[10px] text-text-secondary">{shortDate(p.weekStart)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="py-4 text-center text-xs text-text-secondary">Weekly accuracy appears once completed jobs have a recorded prediction.</p>
      )}
    </div>
  );
}

function CauseBar({ causes, total }: { causes: Array<{ key: CauseShare['key']; share: number }>; total?: number }) {
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label="Cause breakdown">
        {causes.map((c) => (
          <div key={c.key} className={CAUSE_COLORS[c.key]} style={{ width: `${c.share * 100}%` }} title={`${CAUSE_LABELS[c.key]} ${Math.round(c.share * 100)}%`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {causes.map((c) => (
          <span key={c.key} className="flex items-center gap-1.5 text-[11px] text-text-secondary">
            <span className={`h-2 w-2 rounded-full ${CAUSE_COLORS[c.key]}`} aria-hidden="true" />
            {CAUSE_LABELS[c.key]} {Math.round(c.share * 100)}%
          </span>
        ))}
        {total !== undefined && <span className="text-[11px] text-text-secondary">· {Math.round(total)} min over</span>}
      </div>
    </div>
  );
}

// ============================================================
// LEARNING TAB
// ============================================================

function correctionLabel(c: CorrectionRow, techNames: Map<string, string>): string {
  return c.scope === 'job_type' ? humanizeKey(c.job_type_key) : techNames.get(c.technician_id ?? '') ?? 'Technician';
}

function CorrectionCard({
  row,
  techNames,
  perf,
  isOwner,
  onDone,
}: {
  row: CorrectionRow;
  techNames: Map<string, string>;
  perf?: CorrectionPerformance;
  isOwner: boolean;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const proposed = row.status === 'proposed';
  const bt = row.backtest;

  const run = async (decision: 'approve' | 'dismiss' | 'revert') => {
    setBusy(true);
    try {
      await decideCorrection(row.id, decision);
      toast(decision === 'approve' ? 'Correction approved and now applied to predictions' : decision === 'revert' ? 'Correction reverted' : 'Proposal dismissed');
      onDone();
    } catch (e) {
      toast(errMessage(e), 'error');
      setBusy(false);
      setConfirmRevert(false);
    }
  };

  return (
    <div className={CARD}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">
            {correctionLabel(row, techNames)} <span className="ml-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-normal text-text-secondary">{row.scope === 'job_type' ? 'Job type' : 'Technician'}</span>
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            Predicted duration ×{row.factor.toFixed(2)} ({signedPct(row.factor)}): a {formatDuration(126)} prediction becomes {formatDuration(126 * row.factor)}.
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${proposed ? 'bg-warning-500/10 text-warning-500' : 'bg-success-500/10 text-success-500'}`}>
          {proposed ? 'Awaiting approval' : 'Active'}
        </span>
      </div>

      <p className="mt-2 text-xs text-text-secondary">
        Learned from {row.sample_size} jobs.
        {bt.nTest !== undefined && bt.maeBefore !== undefined && bt.maeAfter !== undefined && bt.improvementPct !== undefined && (
          <> Backtest on the newest {bt.nTest} jobs the fit never saw: average error {Math.round(bt.maeBefore)} → {Math.round(bt.maeAfter)} min ({bt.improvementPct}% better).</>
        )}
      </p>

      {perf && perf.n > 0 && (
        <p className={`mt-2 text-xs ${perf.underperforming ? 'text-danger' : 'text-text-secondary'}`}>
          {perf.underperforming && <AlertTriangle size={12} className="mr-1 inline" aria-hidden="true" />}
          Since activation ({perf.n} jobs): average error {perf.maeIssued} min with the correction vs {perf.maeBaseline} min without
          {perf.improvementPct !== null && ` (${perf.improvementPct >= 0 ? perf.improvementPct + '% better' : Math.abs(perf.improvementPct) + '% worse'})`}.
          {perf.underperforming && ' Consider reverting.'}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {proposed && isOwner && (
          <>
            <Button size="sm" onClick={() => void run('approve')} disabled={busy}>
              <CheckCircle2 size={14} /> Approve
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void run('dismiss')} disabled={busy}>
              Dismiss
            </Button>
          </>
        )}
        {!proposed && isOwner && !confirmRevert && (
          <Button size="sm" variant="secondary" onClick={() => setConfirmRevert(true)} disabled={busy}>
            <RotateCcw size={14} /> Revert
          </Button>
        )}
        {!proposed && isOwner && confirmRevert && (
          <>
            <span className="text-xs text-text-secondary">Predictions return to the uncorrected model.</span>
            <Button size="sm" variant="secondary" onClick={() => void run('revert')} disabled={busy}>
              Confirm revert
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirmRevert(false)} disabled={busy}>
              Cancel
            </Button>
          </>
        )}
        {!isOwner && <span className="text-xs text-text-secondary">Only the account owner can {proposed ? 'approve' : 'revert'} corrections.</span>}
      </div>
    </div>
  );
}

function LearningTab({ a, corrections, techNames, isOwner, onDone }: { a: LoopAnalysis; corrections: CorrectionRow[]; techNames: Map<string, string>; isOwner: boolean; onDone: () => void }) {
  const pending = corrections.filter((c) => c.status === 'proposed');
  const active = corrections.filter((c) => c.status === 'active');
  const perf = useMemo(() => new Map(a.performance.map((p) => [p.id, p])), [a.performance]);

  return (
    <div className="space-y-5">
      <section aria-label="Proposed corrections">
        <h2 className="mb-2 text-sm font-semibold text-text-primary">Awaiting your approval ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="rounded-2xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary">
            No validated corrections right now. Vireek only proposes a change when at least {LOOP.minGroupSamples} jobs show a consistent bias and a backtest proves it would have reduced error on newer jobs.
          </p>
        ) : (
          <div className="space-y-3">{pending.map((c) => <CorrectionCard key={c.id} row={c} techNames={techNames} isOwner={isOwner} onDone={onDone} />)}</div>
        )}
      </section>

      <section aria-label="Active corrections">
        <h2 className="mb-2 text-sm font-semibold text-text-primary">Active in predictions ({active.length})</h2>
        {active.length === 0 ? (
          <p className="text-sm text-text-secondary">Nothing applied yet. Approved corrections are used by Outcome Assurance from the next prediction on.</p>
        ) : (
          <div className="space-y-3">{active.map((c) => <CorrectionCard key={c.id} row={c} techNames={techNames} perf={perf.get(c.id)} isOwner={isOwner} onDone={onDone} />)}</div>
        )}
      </section>

      {a.watching.length > 0 && (
        <section aria-label="Watching">
          <h2 className="mb-2 text-sm font-semibold text-text-primary">Still collecting evidence</h2>
          <div className={`${CARD} space-y-2`}>
            {a.watching.slice(0, 8).map((w) => (
              <div key={`${w.scope}:${w.label}`} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-text-primary">{w.label}</span>
                <span className="shrink-0 text-xs text-text-secondary">
                  {w.reason === 'collecting' ? `${w.n}/${w.needed} jobs` : 'Bias not proven on newer jobs'}
                  {w.medianRatio !== null && ` · runs ${signedPct(w.medianRatio)} vs predicted`}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ============================================================
// MISSES TAB
// ============================================================

function CauseList({ causes }: { causes: CauseShare[] }) {
  if (causes.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1.5">
      {causes.map((c) => (
        <li key={c.key} className="text-xs text-text-secondary">
          <span className="font-medium text-text-primary">{CAUSE_LABELS[c.key]}</span> · {Math.round(c.share * 100)}%{c.minutes > 0 && ` · ${Math.round(c.minutes)} min`}
          <span className="ml-1 rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px]">{c.evidence === 'measured' ? 'Recorded evidence' : 'Inferred'}</span>
          <br />
          {c.detail}
        </li>
      ))}
    </ul>
  );
}

function DurationMiss({ v, techNames }: { v: DurationVariance; techNames: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  const over = v.direction === 'over';
  return (
    <div className={CARD}>
      <button type="button" onClick={() => setOpen((x) => !x)} aria-expanded={open} className="focus-ring flex w-full items-start justify-between gap-3 rounded-xl text-left">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">{v.customerName}</p>
          <p className="text-xs text-text-secondary">
            {humanizeKey(v.jobTypeKey)} · {shortDate(v.completedAt)}
            {v.technicianId && techNames.get(v.technicianId) ? ` · ${techNames.get(v.technicianId)}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="text-right">
            <p className="text-sm font-semibold text-text-primary">
              {formatDuration(v.issued)} → <span className={over ? 'text-danger' : 'text-success-500'}>{formatDuration(v.actual)}</span>
            </p>
            <p className="text-[11px] text-text-secondary">{over && v.primaryCause ? CAUSE_LABELS[v.primaryCause] : over ? 'Ran over' : 'Finished early'}</p>
          </div>
          <ChevronDown size={14} className={`text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </div>
      </button>
      {open && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-xs text-text-secondary">
            Predicted {formatDuration(v.issued)}, took {formatDuration(v.actual)} ({signedPct(v.ratio)}).
            {v.baseline !== v.issued && ` Without the active correction the model would have said ${formatDuration(v.baseline)}.`}
          </p>
          {over ? <CauseList causes={v.causes} /> : <p className="mt-2 text-xs text-text-secondary">Faster than predicted: this counts toward the job type's correction, so estimates get tighter.</p>}
        </div>
      )}
    </div>
  );
}

function FtfMiss({ v, techNames }: { v: FtfVariance; techNames: Map<string, string> }) {
  return (
    <div className={CARD}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">{v.customerName}</p>
          <p className="text-xs text-text-secondary">
            {humanizeKey(v.jobTypeKey)} · {shortDate(v.completedAt)}
            {v.technicianId && techNames.get(v.technicianId) ? ` · ${techNames.get(v.technicianId)}` : ''}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold text-danger">Not fixed first visit</p>
          <p className="text-[11px] text-text-secondary">Vireek predicted {Math.round(v.predicted)}%</p>
        </div>
      </div>
      <CauseList causes={v.causes} />
    </div>
  );
}

function MissesTab({ a, techNames }: { a: LoopAnalysis; techNames: Map<string, string> }) {
  const duration = a.durationVariances.filter((v) => v.direction !== 'on_target').slice(0, 20);
  const ftf = a.ftfVariances.filter((v) => v.direction === 'over').slice(0, 10);
  return (
    <div className="space-y-5">
      <section aria-label="Duration misses">
        <h2 className="mb-2 text-sm font-semibold text-text-primary">Duration: expected vs actual</h2>
        {duration.length === 0 ? (
          <p className="text-sm text-text-secondary">Every compared job finished within tolerance.</p>
        ) : (
          <div className="space-y-3">{duration.map((v) => <DurationMiss key={v.jobId} v={v} techNames={techNames} />)}</div>
        )}
      </section>
      {ftf.length > 0 && (
        <section aria-label="First-time-fix misses">
          <h2 className="mb-2 text-sm font-semibold text-text-primary">First-time-fix: confident predictions that missed</h2>
          <div className="space-y-3">{ftf.map((v) => <FtfMiss key={v.jobId} v={v} techNames={techNames} />)}</div>
        </section>
      )}
    </div>
  );
}

// ============================================================
// CAUSES + ACTIONS TABS
// ============================================================

function CausesTab({ a }: { a: LoopAnalysis }) {
  const { overall, byType } = a.causes;
  if (overall.overruns === 0) return <p className="text-sm text-text-secondary">No overruns to explain yet.</p>;
  const row = (s: CauseSummary, title: string) => (
    <div key={s.jobTypeKey} className={CARD}>
      <p className="mb-2 text-sm font-medium text-text-primary">
        {title} <span className="text-xs font-normal text-text-secondary">· {s.overruns} overruns</span>
      </p>
      <CauseBar causes={s.byCause} total={s.overrunMinutes} />
    </div>
  );
  return (
    <div className="space-y-3">
      {row(overall, 'All job types')}
      {byType.slice(0, 8).map((s) => row(s, humanizeKey(s.jobTypeKey)))}
    </div>
  );
}

function ActionsTab({ a }: { a: LoopAnalysis }) {
  if (a.actions.length === 0) {
    return <p className="text-sm text-text-secondary">No recurring cause is strong enough yet. Vireek suggests a workflow change once a cause explains at least {Math.round(LOOP.actionCauseShare * 100)}% of the overrun on a job type with {LOOP.actionMinOverruns}+ overruns.</p>;
  }
  return (
    <div className="space-y-3">
      {a.actions.map((x) => (
        <div key={x.id} className={CARD}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">{x.title}</p>
              <p className="mt-1 text-xs text-text-secondary">{x.detail}</p>
            </div>
            <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${x.severity === 'high' ? 'bg-danger/10 text-danger' : 'bg-bg-tertiary text-text-secondary'}`}>
              {x.minutes} min lost
            </span>
          </div>
          <Link to={x.href} className="focus-ring mt-3 inline-flex items-center gap-1 rounded text-xs font-medium text-accent">
            Open <ArrowRight size={12} aria-hidden="true" />
          </Link>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function ContinuousImprovementPage() {
  const { isOwner } = useAuth();
  const [analysis, setAnalysis] = useState<LoopAnalysis | null>(null);
  const [corrections, setCorrections] = useState<CorrectionRow[]>([]);
  const [techNames, setTechNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('learning');
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [data, rows] = await Promise.all([gatherLoopData(), fetchCorrections()]);
      const result = analyzeLoop(data.records, rows, data.techNames);
      if (!mounted.current) return;
      setAnalysis(result);
      setCorrections(rows);
      setTechNames(data.techNames);
      setFailed(false);
      setLoading(false);

      // LEARN: store new evidence + validated proposals. Never blocks or breaks the page.
      try {
        const written = await persistLoopRun(result);
        if (written.proposals > 0) {
          const fresh = await fetchCorrections();
          if (mounted.current) setCorrections(fresh);
        }
      } catch {
        /* migration not applied yet: analysis still shows, it just is not stored */
      }
    } catch {
      if (mounted.current) {
        setFailed(true);
        setLoading(false);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => {
    setRefreshing(true);
    void load();
  };

  const activeCount = corrections.filter((c) => c.status === 'active').length;
  const pendingCount = corrections.filter((c) => c.status === 'proposed').length;

  const tabs: Array<{ key: Tab; label: string; count?: number }> = [
    { key: 'learning', label: 'Learning', count: pendingCount },
    { key: 'misses', label: 'Misses' },
    { key: 'causes', label: 'Causes' },
    { key: 'actions', label: 'Actions', count: analysis?.actions.length },
  ];

  const bias = analysis?.duration.medianRatio ?? null;
  const gap = analysis?.ftf.gapPoints ?? null;

  return (
    <DashboardLayout activeLabel="Continuous Improvement">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <RefreshCw size={18} /> Continuous Improvement
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Every finished job is compared with the prediction made before dispatch. Vireek finds why it missed, learns a correction, and gets more accurate with real operations.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={refresh} disabled={refreshing || loading}>
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>

        {loading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </div>
        ) : failed || !analysis ? (
          <EmptyState
            icon={RefreshCw}
            title="Continuous Improvement unavailable"
            description="Job outcomes could not be loaded. Check your connection and try again."
            action={{ label: 'Reload', onClick: () => { setLoading(true); void load(); } }}
          />
        ) : analysis.totals.outcomes === 0 ? (
          <EmptyState
            icon={RefreshCw}
            title="No finished jobs to learn from yet"
            description="Once technicians record job outcomes, Vireek compares each one with its prediction and starts learning."
          />
        ) : (
          <>
            <Pipeline a={analysis} active={activeCount} />

            <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard
                label="Duration accuracy"
                value={pct(analysis.duration.hitRate)}
                hint={`${analysis.duration.n} jobs compared`}
                valueClass={analysis.duration.hitRate !== null && analysis.duration.hitRate >= 0.75 ? 'text-success-500' : 'text-text-primary'}
              />
              <StatCard
                label="Prediction bias"
                value={bias === null ? '—' : Math.abs(bias - 1) < 0.05 ? 'Balanced' : bias > 1 ? `${Math.round((bias - 1) * 100)}% longer` : `${Math.round((1 - bias) * 100)}% shorter`}
                hint="actual vs predicted (median)"
              />
              <StatCard
                label="First-time-fix calibration"
                value={gap === null ? '—' : Math.abs(gap) < 5 ? 'Well calibrated' : gap > 0 ? `${Math.round(gap)} pts over-confident` : `${Math.round(-gap)} pts under-confident`}
                hint={analysis.ftf.n > 0 ? `${analysis.ftf.n} matured jobs` : `judged after ${LOOP.maturityDays} days`}
              />
              <StatCard label="Corrections" value={`${activeCount} active`} hint={`${pendingCount} awaiting approval`} />
            </div>

            {analysis.totals.unpredicted > 0 && (
              <p className="mb-4 text-xs text-text-secondary">
                {analysis.totals.unpredicted} finished job{analysis.totals.unpredicted === 1 ? '' : 's'} had no prediction on record and cannot be compared. Predictions are stored when a job is scheduled and viewed in{' '}
                <Link to="/dashboard/outcome-assurance" className="text-accent underline">Outcome Assurance</Link>.
              </p>
            )}

            <div className="mb-5">
              <TrendChart points={analysis.trend} />
            </div>

            <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Improvement loop sections">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${tab === t.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
                >
                  {t.label}
                  {t.count !== undefined && t.count > 0 ? ` (${t.count})` : ''}
                </button>
              ))}
            </div>

            {tab === 'learning' && <LearningTab a={analysis} corrections={corrections} techNames={techNames} isOwner={isOwner} onDone={refresh} />}
            {tab === 'misses' && <MissesTab a={analysis} techNames={techNames} />}
            {tab === 'causes' && <CausesTab a={analysis} />}
            {tab === 'actions' && <ActionsTab a={analysis} />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
