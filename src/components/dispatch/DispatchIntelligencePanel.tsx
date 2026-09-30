import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Clock, Loader2, MapPin, RefreshCw, Route as RouteIcon, Sparkles } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { RiskChip } from '@/components/dispatch/RiskChip';
import { LiveEtaPanel } from '@/components/dispatch/LiveEtaPanel';
import type { Job, TeamMember } from '@/lib/supabase';
import type { RiskReport } from '@/lib/riskIntelligence';
import { optimizeRoute, type OptimizedRoute } from '@/lib/routing';
import {
  dateKeyOf,
  planDispatch,
  SCORE_LABELS,
  SCORE_MAX,
  type CandidateEval,
  type DispatchPlan,
  type JobPlan,
  type ScoreKey,
  type TechRoute,
} from '@/lib/dispatchIntelligence';
import {
  applyRecommendation,
  assessJobsRisk,
  countMissingLocations,
  fetchPlanContext,
  geocodeMissingLocations,
  toDispatchJobs,
  toDispatchTechs,
} from '@/lib/dispatchIntelligenceApi';

interface Props {
  jobs: Job[];
  technicians: TeamMember[];
  /** Risk scores for the jobs already on the board (from useJobRiskMap). */
  riskMap?: Record<string, RiskReport>;
  /** Reload the board after assignments / ETA / geocoding changes. */
  onChanged: () => void | Promise<void>;
}

const SCORE_KEYS = Object.keys(SCORE_MAX) as ScoreKey[];

function fmtTime(ms: number | string | null, todayKey: string): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return dateKeyOf(d.getTime()) === todayKey ? t : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${t}`;
}

function scoreTone(score: number): string {
  if (score >= 75) return 'text-success-500';
  if (score >= 50) return 'text-accent';
  return 'text-warning-500';
}

function Breakdown({ c }: { c: CandidateEval }) {
  return (
    <ul className="space-y-1.5">
      {SCORE_KEYS.map((k) => {
        const v = c.breakdown[k];
        const pct = Math.max(0, Math.min(100, (v / SCORE_MAX[k]) * 100));
        return (
          <li key={k} className="text-[11px]">
            <div className="flex justify-between text-text-secondary">
              <span>{SCORE_LABELS[k]}</span>
              <span className={v < 0 ? 'text-danger' : ''}>
                {v} / {SCORE_MAX[k]}
              </span>
            </div>
            <div className="mt-0.5 h-1 rounded-full bg-bg-tertiary">
              <div className={`h-full rounded-full ${v < 0 ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function DispatchIntelligencePanel({ jobs, technicians, riskMap, onChanged }: Props) {
  const { isOwner, profile, teamMember } = useAuth();
  const { toast } = useToast();
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const [plan, setPlan] = useState<DispatchPlan | null>(null);
  const [planRisk, setPlanRisk] = useState<Record<string, RiskReport>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [geoBusy, setGeoBusy] = useState(false);
  const [routesOpen, setRoutesOpen] = useState(false);
  const [road, setRoad] = useState<Record<string, OptimizedRoute | 'loading' | 'error'>>({});

  const techs = useMemo(() => technicians.filter((t) => t.role === 'technician'), [technicians]);
  const jobById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const runId = useRef(0);
  const todayKey = dateKeyOf(Date.now());
  const missingGeo = useMemo(() => countMissingLocations(jobs, techs), [jobs, techs]);

  const load = useCallback(async () => {
    if (!ownerId) return;
    const id = ++runId.current;
    setLoading(true);
    setFailed(false);
    try {
      const ctx = await fetchPlanContext(ownerId, jobs, techs);
      const p = planDispatch({
        nowMs: Date.now(),
        technicians: toDispatchTechs(techs, ctx.firstTimeFix),
        jobs: toDispatchJobs(jobs),
        stockFit: ctx.stockFit,
        blockingGaps: ctx.blockingGaps,
      });
      const overrides: Record<string, string | null> = {};
      for (const jp of p.jobs) overrides[jp.jobId] = jp.recommended?.technicianId ?? null;
      const planned = jobs.filter((j) => j.id in overrides);
      const risks = planned.length > 0 ? await assessJobsRisk(planned, ownerId, overrides).catch(() => ({})) : {};
      if (id !== runId.current) return;
      setPlan(p);
      setPlanRisk(risks);
      setNotes(ctx.unavailable);
    } catch {
      if (id === runId.current) setFailed(true);
    } finally {
      if (id === runId.current) setLoading(false);
    }
  }, [ownerId, jobs, techs]);

  useEffect(() => {
    void load();
  }, [load]);

  const sequenceOf = (jp: JobPlan, techId: string): number | null => {
    const route = plan?.routes.find((r) => r.technicianId === techId && r.dateKey === jp.dateKey);
    const idx = route ? route.stops.findIndex((s) => s.jobId === jp.jobId) : -1;
    return idx >= 0 ? idx + 1 : null;
  };

  const apply = async (jp: JobPlan, cand: CandidateEval, source: 'ai_plan' | 'ai_plan_bulk'): Promise<boolean> => {
    const job = jobById.get(jp.jobId);
    if (!job || !ownerId || !plan) return false;
    const res = await applyRecommendation({
      ownerId,
      job,
      candidate: cand,
      routeSequence: sequenceOf(jp, cand.technicianId),
      risk: jp.recommended && cand.technicianId === jp.recommended.technicianId ? (planRisk[jp.jobId] ?? null) : null,
      engineVersion: plan.engineVersion,
      source,
    });
    if (!res.ok) toast(res.message, 'error');
    return res.ok;
  };

  const applyOne = async (jp: JobPlan, cand: CandidateEval) => {
    setBusy(`${jp.jobId}:${cand.technicianId}`);
    const ok = await apply(jp, cand, 'ai_plan');
    setBusy(null);
    if (ok) {
      toast(`Assigned to ${cand.technicianName}.`, 'success');
      await onChanged();
    }
  };

  // Bulk apply skips anything that needs a human risk acknowledgement.
  const safeJobs = useMemo(
    () => (plan ? plan.jobs.filter((jp) => jp.recommended && !planRisk[jp.jobId]?.coverage.requiresAck) : []),
    [plan, planRisk],
  );
  const heldForReview = plan ? plan.summary.assignable - safeJobs.length : 0;

  const applyAll = async () => {
    setConfirmBulk(false);
    setBulkBusy(true);
    let done = 0;
    for (const jp of safeJobs) {
      if (jp.recommended && (await apply(jp, jp.recommended, 'ai_plan_bulk'))) done += 1;
    }
    setBulkBusy(false);
    toast(`Assigned ${done} of ${safeJobs.length} jobs.`, done === safeJobs.length ? 'success' : 'info');
    await onChanged();
  };

  const geocodeNow = async () => {
    setGeoBusy(true);
    try {
      const r = await geocodeMissingLocations(jobs, techs);
      toast(`Located ${r.geocoded} of ${r.total} addresses.`, r.geocoded > 0 ? 'success' : 'info');
      await onChanged();
    } catch {
      toast('Could not look up addresses right now.', 'error');
    } finally {
      setGeoBusy(false);
    }
  };

  const loadRoad = async (route: TechRoute) => {
    const key = `${route.technicianId}|${route.dateKey}`;
    setRoad((r) => ({ ...r, [key]: 'loading' }));
    try {
      const res = await optimizeRoute(route.technicianId, route.dateKey);
      setRoad((r) => ({ ...r, [key]: res }));
    } catch {
      setRoad((r) => ({ ...r, [key]: 'error' }));
    }
  };

  const bestRisk = (jobId: string): RiskReport | undefined => planRisk[jobId] ?? riskMap?.[jobId];

  return (
    <section className="mb-8 rounded-2xl border border-accent/20 bg-bg-secondary p-5" aria-label="AI Dispatch plan">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Sparkles size={16} className="text-accent" /> AI Dispatch plan
          </h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Best technician, arrival time and route for every unassigned job — from skills, distance, capacity, SLA, parts, credentials and risk.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Recompute plan"
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg border border-border text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={() => setConfirmBulk(true)}
            disabled={bulkBusy || safeJobs.length === 0}
            className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {bulkBusy && <Loader2 size={12} className="animate-spin" />}
            Apply {safeJobs.length} safe assignment{safeJobs.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>

      {plan && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: 'Unassigned', value: plan.summary.unassigned },
            { label: 'Assignable now', value: plan.summary.assignable },
            { label: 'SLA at risk', value: plan.summary.slaAtRisk },
            { label: 'Avg added drive', value: plan.summary.avgTravelMinutes === null ? '—' : `${plan.summary.avgTravelMinutes} min` },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-border bg-bg-primary px-3 py-2">
              <p className="text-lg font-bold text-text-primary">{s.value}</p>
              <p className="text-[11px] text-text-secondary">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {missingGeo > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning-500/30 bg-warning-500/5 px-3 py-2 text-xs text-text-primary">
          <span className="flex items-center gap-1.5">
            <MapPin size={13} className="text-warning-500" />
            {missingGeo} address{missingGeo === 1 ? '' : 'es'} have no coordinates yet, so travel time is not scored for them.
          </span>
          <button
            type="button"
            onClick={() => void geocodeNow()}
            disabled={geoBusy}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 font-medium hover:border-accent/40 hover:text-accent disabled:opacity-50"
          >
            {geoBusy && <Loader2 size={12} className="animate-spin" />}
            Locate addresses
          </button>
        </div>
      )}

      {notes.length > 0 && <p className="mt-2 text-[11px] text-text-secondary">Some data could not be read ({notes.join(', ')}); the plan is less certain.</p>}
      {heldForReview > 0 && (
        <p className="mt-2 text-[11px] text-text-secondary">
          {heldForReview} recommendation{heldForReview === 1 ? ' needs' : 's need'} a manager decision because of risk and {heldForReview === 1 ? 'is' : 'are'} excluded from bulk apply.
        </p>
      )}

      <div className="mt-4">
        {loading && !plan ? (
          <div className="flex items-center gap-2 py-6 text-xs text-text-secondary">
            <Loader2 size={14} className="animate-spin" /> Planning…
          </div>
        ) : failed && !plan ? (
          <p className="py-4 text-xs text-text-secondary">
            The plan could not be computed.{' '}
            <button type="button" className="text-accent hover:underline" onClick={() => void load()}>
              Retry
            </button>
          </p>
        ) : plan && plan.jobs.length === 0 ? (
          <p className="py-4 text-xs text-text-secondary">Every open job already has a technician.</p>
        ) : (
          <ul className="space-y-3">
            {plan?.jobs.map((jp) => {
              const job = jobById.get(jp.jobId);
              if (!job) return null;
              const rec = jp.recommended;
              const risk = bestRisk(jp.jobId);
              const expanded = open === jp.jobId;
              return (
                <li key={jp.jobId} className="rounded-xl border border-border bg-bg-primary p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-text-primary">
                        {job.customer_name}
                        {jp.emergency && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-semibold text-danger">Emergency</span>}
                        {rec?.slaBreach && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-semibold text-danger">SLA breach</span>}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {job.service_type ?? 'Unspecified service'} · {job.scheduled_datetime ? fmtTime(job.scheduled_datetime, todayKey) : 'Flexible time'}
                        {jp.slaDeadlineMs !== null ? ` · SLA by ${fmtTime(jp.slaDeadlineMs, todayKey)}` : ''}
                      </p>
                    </div>
                    <RiskChip report={risk} />
                  </div>

                  {rec ? (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className={`text-2xl font-bold ${scoreTone(rec.score)}`} aria-label={`Score ${rec.score} out of 100`}>
                          {rec.score}
                        </span>
                        <div className="text-xs">
                          <p className="font-medium text-text-primary">{rec.technicianName}</p>
                          <p className="flex flex-wrap items-center gap-x-2 text-text-secondary">
                            <span className="flex items-center gap-1">
                              <Clock size={11} /> arrives {fmtTime(rec.plannedArrivalMs, todayKey)}
                            </span>
                            <span>{rec.travelMinutes === null ? 'travel unknown' : `+${Math.round(rec.travelMinutes)} min drive`}</span>
                            <span>{Math.round(rec.confidence * 100)}% confidence</span>
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={busy !== null || bulkBusy}
                        onClick={() => void applyOne(jp, rec)}
                        className={`focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                          planRisk[jp.jobId]?.coverage.requiresAck ? 'border border-warning-500/50 text-warning-500' : 'bg-accent text-white hover:opacity-90'
                        }`}
                      >
                        {busy === `${jp.jobId}:${rec.technicianId}` && <Loader2 size={12} className="animate-spin" />}
                        {planRisk[jp.jobId]?.coverage.requiresAck ? 'Assign anyway' : 'Assign'}
                      </button>
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-text-secondary">No technician can take this job right now. See why below.</p>
                  )}

                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : jp.jobId)}
                    aria-expanded={expanded}
                    className="focus-ring mt-2 flex items-center gap-1 text-xs font-medium text-accent"
                  >
                    Why this choice
                    <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
                  </button>

                  {expanded && (
                    <div className="mt-2 space-y-3 border-t border-border/60 pt-3">
                      {rec && (
                        <div className="grid gap-4 sm:grid-cols-2">
                          <Breakdown c={rec} />
                          <ul className="list-disc space-y-1 pl-4 text-xs text-text-primary">
                            {rec.reasons.map((r) => (
                              <li key={r}>{r}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {planRisk[jp.jobId] && planRisk[jp.jobId].flags.length > 0 && (
                        <div>
                          <p className="mb-1 text-[11px] font-medium text-text-secondary">Risk findings with this technician</p>
                          <ul className="space-y-0.5 text-xs text-text-primary">
                            {planRisk[jp.jobId].flags.slice(0, 4).map((f, i) => (
                              <li key={`${f.code}-${i}`}>• {f.title}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {jp.alternatives.length > 0 && (
                        <div>
                          <p className="mb-1 text-[11px] font-medium text-text-secondary">Alternatives</p>
                          <ul className="space-y-1">
                            {jp.alternatives.map((a) => (
                              <li key={a.technicianId} className="flex items-center justify-between gap-2 text-xs">
                                <span className="text-text-primary">
                                  {a.technicianName} <span className="text-text-secondary">· score {a.score} · arrives {fmtTime(a.plannedArrivalMs, todayKey)}</span>
                                </span>
                                <button
                                  type="button"
                                  disabled={busy !== null || bulkBusy}
                                  onClick={() => void applyOne(jp, a)}
                                  className="focus-ring rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50"
                                >
                                  Assign
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {jp.blocked.length > 0 && (
                        <div>
                          <p className="mb-1 text-[11px] font-medium text-text-secondary">Not available</p>
                          <ul className="space-y-0.5 text-xs text-text-secondary">
                            {jp.blocked.map((b) => (
                              <li key={b.technicianId}>
                                {b.technicianName}: {b.blockers.join('; ')}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {plan && plan.routes.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setRoutesOpen((v) => !v)}
            aria-expanded={routesOpen}
            className="focus-ring flex items-center gap-1.5 text-xs font-medium text-accent"
          >
            <RouteIcon size={13} /> Technician routes ({plan.routes.length})
            <ChevronDown size={12} className={`transition-transform ${routesOpen ? 'rotate-180' : ''}`} />
          </button>
          {routesOpen && (
            <div className="mt-3 space-y-3">
              {plan.routes.map((route) => {
                const key = `${route.technicianId}|${route.dateKey}`;
                const r = road[key];
                return (
                  <div key={key} className="rounded-xl border border-border bg-bg-primary p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-text-primary">
                        {route.technicianName} <span className="font-normal text-text-secondary">· {route.dateKey === todayKey ? 'Today' : route.dateKey}</span>
                      </p>
                      <p className="text-[11px] text-text-secondary">
                        ~{route.totalDriveMinutes} min · {route.totalMiles} mi driving (estimate)
                      </p>
                    </div>
                    <ol className="mt-2 space-y-1">
                      {route.stops.map((s, i) => {
                        const sj = jobById.get(s.jobId);
                        return (
                          <li key={s.jobId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                            <span className="w-4 text-text-secondary">{i + 1}.</span>
                            <span className="font-medium text-text-primary">{fmtTime(s.arrivalMs, todayKey)}</span>
                            <span className="text-text-primary">{sj?.customer_name ?? 'Job'}</span>
                            {s.planned && <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">AI plan</span>}
                            {s.travelMinFromPrev !== null && s.travelMinFromPrev > 0 && <span className="text-text-secondary">{s.travelMinFromPrev} min drive</span>}
                            <RiskChip report={bestRisk(s.jobId)} />
                          </li>
                        );
                      })}
                    </ol>
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => void loadRoad(route)}
                        disabled={r === 'loading'}
                        className="focus-ring text-[11px] font-medium text-accent hover:underline disabled:opacity-50"
                      >
                        {r === 'loading' ? 'Checking road network…' : 'Check real road ETAs (assigned jobs)'}
                      </button>
                      {r === 'error' && <span className="ml-2 text-[11px] text-danger">Route service unavailable.</span>}
                      {r && r !== 'loading' && r !== 'error' && (
                        <div className="mt-1.5 text-[11px] text-text-secondary">
                          <p>
                            Source: {r.etaSource === 'google_traffic' ? 'Google with live traffic' : r.etaSource === 'osrm_road_network' ? 'road network' : r.etaSource === 'estimated' ? 'straight-line estimate' : 'n/a'}
                            {' · '}
                            {Math.round(r.totalDriveMinutes)} min · {r.totalDistanceMiles} mi
                            {r.unrouted.length > 0 ? ` · ${r.unrouted.length} job(s) not located` : ''}
                          </p>
                          <ol className="mt-1 space-y-0.5">
                            {r.stops.map((s) => (
                              <li key={s.jobId}>
                                {s.order}. {fmtTime(s.etaArrival, todayKey)} · {s.address} · {Math.round(s.travelMinutesFromPrev)} min
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <LiveEtaPanel jobs={jobs} technicians={techs} onChanged={onChanged} />

      <ConfirmDialog
        open={confirmBulk}
        title={`Apply ${safeJobs.length} AI assignment${safeJobs.length === 1 ? '' : 's'}?`}
        description="Each job is assigned through the normal dispatch rules (capacity and compliance are re-checked on the server). Jobs that need a manager risk decision are not included."
        confirmLabel="Apply"
        onConfirm={applyAll}
        onCancel={() => setConfirmBulk(false)}
      />
    </section>
  );
}
