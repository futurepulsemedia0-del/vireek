/**
 * Vireek Outcome Benchmark Network - /dashboard/outcome-benchmarks
 *
 * Your first-time-fix rate, response time and reservice rate next to
 * anonymized peers in the same trade and state (>= 5 businesses per
 * cohort, enforced in the database), plus an AI improvement plan.
 * No cross-tenant query exists on this page - see
 * src/lib/outcomeBenchmarkApi.ts and the migration header.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Info, Lock, RefreshCw, ShieldCheck, Sparkles, Target, Users } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  analyzeOutcomes,
  BUCKET_LABELS,
  formatGap,
  formatOutcomeValue,
  gapToTarget,
  getLever,
  leversFor,
  METRIC_META,
  outperformPct,
  scopeLabel,
  topQuartileValue,
  type OutcomeAdviceResponse,
  type OutcomeBenchmarkRow,
  type OutcomeBucket,
  type OutcomeDriver,
} from '@/lib/outcomeBenchmark';
import {
  fetchOutcomeBenchmark,
  fetchOutcomeDrivers,
  fetchParticipation,
  requestOutcomeAdvice,
  setParticipation,
  type WindowDays,
} from '@/lib/outcomeBenchmarkApi';

const BUCKET_STYLES: Record<OutcomeBucket, string> = {
  top10: 'bg-success-500/15 text-success-500',
  top25: 'bg-success-500/10 text-success-500',
  top50: 'bg-accent/10 text-accent',
  bottom50: 'bg-warning-500/10 text-warning-500',
  bottom25: 'bg-danger/10 text-danger',
};

function PositionBar({ row }: { row: OutcomeBenchmarkRow }) {
  if (row.p10 === null || row.p90 === null || row.p25 === null || row.p75 === null || row.p50 === null) return null;
  const lo = Math.min(row.p10, row.my_value);
  const hi = Math.max(row.p90, row.my_value);
  const span = hi - lo || 1;
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - lo) / span) * 100));
  return (
    <div className="relative mt-4 h-2 rounded-full bg-bg-tertiary" role="img" aria-label="Your position among peers">
      <div
        className="absolute top-0 h-2 rounded-full bg-accent/20"
        style={{ left: `${pct(row.p25)}%`, width: `${Math.max(2, pct(row.p75) - pct(row.p25))}%` }}
      />
      <div className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-text-secondary/40" style={{ left: `${pct(row.p50)}%` }} />
      <div
        className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent shadow"
        style={{ left: `${pct(row.my_value)}%` }}
        title="You"
      />
    </div>
  );
}

function MetricCard({ row }: { row: OutcomeBenchmarkRow }) {
  const meta = METRIC_META[row.metric];
  const topQ = topQuartileValue(row);
  const better = outperformPct(row);
  const toMedian = gapToTarget(row, 'median');
  const toTop = gapToTarget(row, 'top_quartile');
  return (
    <div className="rounded-2xl border border-border/80 bg-bg-secondary p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">{meta.label}</h3>
          <p className="mt-0.5 text-xs text-text-secondary">{meta.description}</p>
        </div>
        {row.percentile_bucket && (
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${BUCKET_STYLES[row.percentile_bucket]}`}>
            {BUCKET_LABELS[row.percentile_bucket]}
          </span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 text-center">
        <div>
          <p className="text-2xl font-bold text-text-primary">{formatOutcomeValue(row.my_value, row.unit)}</p>
          <p className="text-[11px] text-text-secondary">You</p>
        </div>
        <div>
          <p className="text-2xl font-bold text-text-secondary">{row.p50 !== null ? formatOutcomeValue(row.p50, row.unit) : '-'}</p>
          <p className="text-[11px] text-text-secondary">Peer median</p>
        </div>
        <div>
          <p className="text-2xl font-bold text-success-500">{topQ !== null ? formatOutcomeValue(topQ, row.unit) : '-'}</p>
          <p className="text-[11px] text-text-secondary">Top quartile</p>
        </div>
      </div>

      <PositionBar row={row} />

      <p className="mt-3 text-xs text-text-secondary">
        {better !== null && <>Better than about {better}% of peers. </>}
        {toMedian > 0 ? (
          <>
            Reaching the peer median means improving by <span className="font-semibold text-text-primary">{formatGap(toMedian, row.unit)}</span>
            {toTop > 0 && <>; top quartile is {formatGap(toTop, row.unit)} away.</>}
          </>
        ) : toTop > 0 ? (
          <>You beat the median; top quartile is {formatGap(toTop, row.unit)} away.</>
        ) : (
          <>You are in the top quartile.</>
        )}
      </p>
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-text-secondary/70">
        <Users size={11} /> {scopeLabel(row)} · based on {row.my_sample} of your jobs
      </p>
    </div>
  );
}

function DriversPanel({ drivers }: { drivers: OutcomeDriver[] }) {
  if (drivers.length === 0) return null;
  return (
    <div className="mt-4 rounded-2xl border border-border/80 bg-bg-secondary p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Target size={15} className="text-accent" /> Where your first-time-fix gap comes from
      </h3>
      <p className="mt-0.5 text-xs text-text-secondary">Your own service types with the lowest first-time-fix rate (at least 3 completed jobs).</p>
      <ul className="mt-3 divide-y divide-border/60">
        {drivers.map((d) => (
          <li key={d.service_type} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="text-text-primary">{d.service_type}</span>
            <span className="text-xs text-text-secondary">
              {d.job_count} jobs · {d.reworked_count} needed a return visit ·{' '}
              <span className="font-semibold text-text-primary">{d.ftf_rate.toFixed(d.ftf_rate < 10 ? 1 : 0)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OutcomeBenchmarkNetworkPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const canView = isOwner || permissions.can_view_billing;

  const [windowDays, setWindowDays] = useState<WindowDays>(30);
  const [rows, setRows] = useState<OutcomeBenchmarkRow[]>([]);
  const [drivers, setDrivers] = useState<OutcomeDriver[]>([]);
  const [participating, setParticipatingState] = useState(true);
  const [loading, setLoading] = useState(true);
  const [advice, setAdvice] = useState<OutcomeAdviceResponse | null>(null);
  const [adviceBusy, setAdviceBusy] = useState(false);
  const [showMethod, setShowMethod] = useState(false);
  const [savingPref, setSavingPref] = useState(false);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setAdvice(null);
    try {
      const part = await fetchParticipation();
      if (id !== reqId.current) return;
      setParticipatingState(part);
      if (!part) {
        setRows([]);
        setDrivers([]);
        return;
      }
      const [r, d] = await Promise.all([fetchOutcomeBenchmark(windowDays), fetchOutcomeDrivers(windowDays).catch(() => [])]);
      if (id !== reqId.current) return;
      setRows(r);
      setDrivers(d);
      if (r.some((x) => x.scope !== 'none')) {
        requestOutcomeAdvice(windowDays, 'cached')
          .then((res) => id === reqId.current && setAdvice(res))
          .catch(() => undefined);
      }
    } catch {
      if (id === reqId.current) toastRef.current('Could not load outcome benchmarks', 'error');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [windowDays]);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    void load();
  }, [canView, load]);

  const analysis = useMemo(() => analyzeOutcomes(rows), [rows]);
  const uncomparable = rows.filter((r) => r.scope === 'none');
  const worst = analysis.behind[0]?.row ?? null;

  const runAdvice = async (mode: 'generate' | 'refresh') => {
    setAdviceBusy(true);
    try {
      const res = await requestOutcomeAdvice(windowDays, mode);
      setAdvice(res);
      if (!res.advice && res.reason === 'ai_unavailable') toastRef.current('AI plan is unavailable right now. Try again shortly.', 'error');
    } catch {
      toastRef.current('Could not generate the plan', 'error');
    } finally {
      setAdviceBusy(false);
    }
  };

  const togglePrivacy = async () => {
    setSavingPref(true);
    try {
      await setParticipation(!participating);
      toastRef.current(!participating ? 'You are contributing to the network again' : 'You have left the network', 'success');
      await load();
    } catch {
      toastRef.current('Could not update your preference', 'error');
    } finally {
      setSavingPref(false);
    }
  };

  return (
    <DashboardLayout activeLabel="Outcome Benchmarks">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Target size={22} className="text-accent" /> Outcome Benchmark Network
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              How your first-time-fix rate, response time and reservice rate compare with similar businesses in your trade and state, with a
              plan to close the gap. Anonymized and only shown once at least 5 businesses share a group.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value) === 90 ? 90 : 30)}
              aria-label="Time window"
              className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary"
            >
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
            <button
              type="button"
              onClick={() => setShowMethod(true)}
              aria-label="How this works"
              className="focus-ring flex h-9 w-9 items-center justify-center rounded-xl border border-border text-text-secondary hover:text-accent"
            >
              <Info size={15} />
            </button>
          </div>
        </div>

        {!canView ? (
          <div className="rounded-2xl border border-dashed border-border py-12 text-center">
            <Lock className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">Outcome benchmarks are available to owners and users with billing access.</p>
          </div>
        ) : loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-44 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : !participating ? (
          <div className="rounded-2xl border border-dashed border-border py-12 text-center">
            <Users className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">
              You have opted out of the network. Benchmarks are a two-way exchange: rejoin to contribute anonymously and see how you compare.
            </p>
            <button
              type="button"
              onClick={togglePrivacy}
              disabled={savingPref}
              className="focus-ring mt-4 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Rejoin the network
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-12 text-center">
            <Users className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">
              Not enough completed jobs yet. You need at least 5 jobs in the period (first-time-fix also needs jobs completed more than 14 days
              ago).
            </p>
          </div>
        ) : (
          <>
            {worst && (
              <div className="mb-4 flex items-start gap-3 rounded-2xl border border-accent/25 bg-accent/5 px-4 py-3">
                <Target size={18} className="mt-0.5 shrink-0 text-accent" />
                <p className="text-sm text-text-primary">
                  Biggest opportunity: <span className="font-semibold">{METRIC_META[worst.metric].label}</span>. You are{' '}
                  {formatGap(gapToTarget(worst, 'median'), worst.unit)} from the peer median.
                </p>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {analysis.comparable.map((row) => (
                <MetricCard key={row.metric} row={row} />
              ))}
            </div>

            {uncomparable.length > 0 && (
              <p className="mt-4 rounded-2xl border border-dashed border-border p-4 text-xs text-text-secondary">
                Not enough peers yet for: {uncomparable.map((r) => METRIC_META[r.metric].label).join(', ')}. Comparisons appear automatically as
                more businesses join.
              </p>
            )}

            <DriversPanel drivers={drivers} />

            {analysis.comparable.length > 0 && (
              <div className="mt-4 rounded-2xl border border-border/80 bg-bg-secondary p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                    <Sparkles size={15} className="text-accent" /> AI improvement plan
                  </h3>
                  {advice?.advice ? (
                    <button
                      type="button"
                      onClick={() => runAdvice('refresh')}
                      disabled={adviceBusy}
                      className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:text-accent disabled:opacity-50"
                    >
                      <RefreshCw size={12} className={adviceBusy ? 'animate-spin' : ''} /> Refresh
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => runAdvice('generate')}
                      disabled={adviceBusy}
                      className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {adviceBusy ? 'Analyzing...' : 'Generate plan'}
                    </button>
                  )}
                </div>

                {advice?.advice ? (
                  <div className="mt-3 space-y-3">
                    <p className="text-sm leading-relaxed text-text-primary">{advice.advice.summary}</p>
                    <ol className="space-y-2">
                      {advice.advice.changes.map((c, i) => {
                        const lever = getLever(c.lever_id);
                        return (
                          <li key={`${c.title}-${i}`} className="rounded-xl border border-border/70 p-3">
                            <p className="text-sm font-semibold text-text-primary">
                              {i + 1}. {c.title}
                            </p>
                            <p className="mt-1 text-xs text-text-secondary">{c.why}</p>
                            <p className="mt-1 text-xs text-text-primary">{c.how}</p>
                            {lever && (
                              <Link to={lever.href} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                                Open {lever.title} <ArrowRight size={12} />
                              </Link>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                    <p className="text-[11px] text-text-secondary/70">
                      Estimates based on how peers perform, not guarantees. Gaps shown above are measured; the AI only suggests which actions to
                      try first.
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="mt-2 text-xs text-text-secondary">
                      {advice?.reason === 'ai_unavailable'
                        ? 'The AI plan is unavailable right now. Here are the Vireek tools that move these metrics:'
                        : 'Generate a prioritized plan from your gaps. Meanwhile, these Vireek tools move your weakest metrics:'}
                    </p>
                    <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                      {(worst ? leversFor(worst.metric) : []).slice(0, 4).map((l) => (
                        <li key={l.id}>
                          <Link to={l.href} className="block rounded-xl border border-border/70 p-3 hover:border-accent/40">
                            <p className="text-sm font-medium text-text-primary">{l.title}</p>
                            <p className="mt-0.5 text-xs text-text-secondary">{l.description}</p>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {canView && !loading && participating && (
          <div className="mt-6 flex flex-wrap items-start justify-between gap-3 text-xs text-text-secondary/70">
            <div className="flex max-w-xl items-start gap-2">
              <ShieldCheck size={13} className="mt-0.5 shrink-0" />
              <p>
                Every peer figure combines at least 5 businesses; no business's data is visible to another account. Your numbers contribute
                anonymously to peers' comparisons.
              </p>
            </div>
            <button
              type="button"
              onClick={togglePrivacy}
              disabled={savingPref}
              className="focus-ring rounded-lg border border-border px-2.5 py-1.5 text-text-secondary hover:text-text-primary disabled:opacity-50"
            >
              Leave the network
            </button>
          </div>
        )}
      </div>

      {showMethod && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm"
          onClick={() => setShowMethod(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-border bg-bg-secondary p-5 shadow-2xl"
          >
            <h4 className="text-sm font-semibold text-text-primary">How outcome benchmarks work</h4>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-xs leading-relaxed text-text-secondary">
              <li>First-time fix = completed jobs with no return visit within 14 days (only jobs completed over 14 days ago count).</li>
              <li>Response time = median minutes from job creation to a technician being dispatched or on the way.</li>
              <li>Reservice rate = share of all jobs that were repeat visits for a problem already worked on.</li>
              <li>
                Peers are businesses in your trade and state when at least 5 qualify; otherwise your trade nationwide, then all trades. Region
                comes from your Business Profile service area.
              </li>
              <li>Peer figures are recomputed nightly, lightly noised, and never include any single business's numbers.</li>
            </ol>
            <button
              type="button"
              onClick={() => setShowMethod(false)}
              className="focus-ring mt-4 w-full rounded-xl border border-border py-2 text-sm text-text-secondary hover:text-text-primary"
            >
              Close
            </button>
          </motion.div>
        </div>
      )}
    </DashboardLayout>
  );
}
