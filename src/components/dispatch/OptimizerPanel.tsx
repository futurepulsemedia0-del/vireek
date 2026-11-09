import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, ChevronDown, Check, RefreshCw, AlertTriangle, Clock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import type { Job, TeamMember } from '@/lib/supabase';
import type { MovePatch } from '@/lib/scheduleDnd';
import type { Suggestion } from '@/lib/dispatchOptimizer/suggestions';
import type { Metrics } from '@/lib/dispatchOptimizer/types';
import type { WhatIfResult } from '@/lib/dispatchOptimizer/whatif';
import type { EmergencyResult } from '@/lib/dispatchOptimizer/emergency';
import {
  fetchOptimizerAccess,
  loadOptimizerInput,
  logSuggestionApplied,
  runEmergency,
  runOptimizer,
  runWhatIf,
  type OptimizeResponse,
  type OptimizerAccess,
} from '@/lib/dispatchOptimizerApi';
import type { OptInput } from '@/lib/dispatchOptimizer/types';

interface Props {
  jobs: Job[];
  technicians: TeamMember[];
  /** Applies a patch through the board's own conflict check + Undo. Resolves true when saved. */
  onApply: (jobId: string, patch: MovePatch, successMessage: string) => Promise<boolean>;
}

const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const money = (c: number) => `$${Math.round(c / 100).toLocaleString('en-US')}`;

function MetricRow({ label, a, b, unit = '', lowerIsBetter = true }: { label: string; a: number; b: number; unit?: string; lowerIsBetter?: boolean }) {
  const d = b - a;
  const good = d === 0 ? null : lowerIsBetter ? d < 0 : d > 0;
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-text-muted">{label}</span>
      <span className="tabular-nums text-text-primary">
        {Math.round(a * 10) / 10}
        {unit} → {Math.round(b * 10) / 10}
        {unit}
        {good !== null && <span className={good ? ' ml-1 text-success' : ' ml-1 text-warning'}>{good ? '▲' : '▼'}</span>}
      </span>
    </div>
  );
}

function Comparison({ before, after }: { before: Metrics; after: Metrics }) {
  return (
    <div className="grid gap-1.5 rounded-xl border border-border bg-bg-primary p-3 sm:grid-cols-2">
      <MetricRow label="Unscheduled jobs" a={before.unassigned} b={after.unassigned} />
      <MetricRow label="Driving" a={before.travelMin} b={after.travelMin} unit=" min" />
      <MetricRow label="SLA misses" a={before.slaMisses} b={after.slaMisses} />
      <MetricRow label="Overtime" a={before.overtimeMin} b={after.overtimeMin} unit=" min" />
      <MetricRow label="Rule violations" a={before.hardViolations} b={after.hardViolations} />
    </div>
  );
}

export function OptimizerPanel({ jobs, technicians, onApply }: Props) {
  const { isOwner, profile, teamMember } = useAuth();
  const { toast } = useToast();
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const [access, setAccess] = useState<OptimizerAccess | null>(null);
  const [open, setOpen] = useState(false);
  const [rearrange, setRearrange] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<OptimizeResponse | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [whatIf, setWhatIf] = useState<WhatIfResult | null>(null);
  const [whatIfBusy, setWhatIfBusy] = useState(false);
  const [lateJobId, setLateJobId] = useState('');
  const [lateMin, setLateMin] = useState(30);
  const [emergency, setEmergency] = useState<EmergencyResult | null>(null);
  const inputRef = useRef<OptInput | null>(null);
  const runId = useRef(0);

  useEffect(() => {
    let live = true;
    void fetchOptimizerAccess().then((a) => live && setAccess(a));
    return () => {
      live = false;
    };
  }, []);

  const techName = useMemo(() => new Map(technicians.map((t) => [t.id, t.member_name ?? t.member_email])), [technicians]);
  const assignedJobs = useMemo(() => jobs.filter((j) => j.assigned_technician_id && j.scheduled_datetime && j.job_status === 'scheduled'), [jobs]);

  const run = useCallback(async () => {
    if (!ownerId || !access?.allowed) return;
    const id = ++runId.current;
    setLoading(true);
    setError(null);
    setEmergency(null);
    setWhatIf(null);
    try {
      const { input, unavailable } = await loadOptimizerInput({ ownerId, jobs, team: technicians, settings: access.settings, scope: rearrange ? 'all_unlocked' : 'unassigned_only' });
      inputRef.current = input;
      const r = await runOptimizer(input);
      if (id !== runId.current) return;
      setRes(r);
      setApplied(new Set());
      setNotes(unavailable.length ? [`Could not read: ${unavailable.join(', ')} — suggestions ignore it.`] : []);
    } catch (e) {
      if (id === runId.current) setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      if (id === runId.current) setLoading(false);
    }
  }, [ownerId, access, jobs, technicians, rearrange]);

  // Not entitled / flag off / no permission → render nothing at all (zero change for everyone else).
  if (!access?.allowed) return null;

  const apply = async (s: Suggestion) => {
    setBusy(s.id);
    const patch: MovePatch = { assigned_technician_id: s.techId, scheduled_datetime: new Date(s.startMs).toISOString() };
    const ok = await onApply(s.jobId, patch, `${s.jobLabel} → ${s.techName}, ${fmtTime(s.startMs)}.`);
    setBusy(null);
    if (ok) {
      setApplied((prev) => new Set(prev).add(s.id));
      void logSuggestionApplied(s);
    }
  };

  const simulate = async (scenarioKey: 'sick' | 'overtime') => {
    if (!inputRef.current) return;
    setWhatIfBusy(true);
    try {
      const input = inputRef.current;
      const first = input.techs.find((t) => t.shifts.length > 0);
      const scenario =
        scenarioKey === 'sick' && first
          ? ({ type: 'tech_unavailable', techId: first.id, dayKey: first.shifts[0]!.dayKey } as const)
          : ({ type: 'extend_overtime', maxOvertimeMin: 60 } as const);
      const r = await runWhatIf(input, scenario);
      setWhatIf({ ...r.whatIf });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Simulation failed', 'error');
    } finally {
      setWhatIfBusy(false);
    }
  };

  const reoptimize = async () => {
    if (!inputRef.current || !lateJobId) return;
    const job = jobs.find((j) => j.id === lateJobId);
    if (!job?.scheduled_datetime) return;
    setLoading(true);
    try {
      const planned = new Date(job.scheduled_datetime).getTime() + (job.duration_minutes ?? 60) * 60_000;
      const r = await runEmergency(inputRef.current, lateJobId, Math.max(Date.now(), planned) + lateMin * 60_000);
      setEmergency(r.emergency);
      if (!r.emergency.ok) toast(r.emergency.reason ?? 'Could not re-plan', 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Re-plan failed', 'error');
    } finally {
      setLoading(false);
    }
  };

  const list = emergency?.ok ? emergency.suggestions : res?.suggestions ?? [];

  return (
    <section className="mb-6 rounded-2xl border border-border bg-bg-secondary" aria-labelledby="optimizer-title">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (!open && !res) void run();
        }}
        aria-expanded={open}
        className="focus-ring flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2">
          <Sparkles size={16} aria-hidden="true" />
          <span id="optimizer-title" className="text-sm font-semibold text-text-primary">Smart schedule suggestions</span>
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">Beta</span>
        </span>
        <ChevronDown size={16} aria-hidden="true" className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
      </button>

      {open && (
        <div className="space-y-4 border-t border-border p-4">
          <p className="text-xs text-text-muted">Suggestions only — nothing changes until you apply a move. Every move goes through the usual conflict check and can be undone.</p>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-text-primary">
              <input type="checkbox" checked={rearrange} onChange={(e) => setRearrange(e.target.checked)} className="focus-ring" />
              Also re-arrange jobs that are already booked
            </label>
            <button type="button" onClick={() => void run()} disabled={loading} className="focus-ring flex min-h-[44px] items-center gap-1.5 rounded-xl border border-border px-3 text-xs font-medium disabled:opacity-50">
              <RefreshCw size={13} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
              {loading ? 'Working…' : 'Refresh suggestions'}
            </button>
          </div>

          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-error/30 bg-error/10 p-3 text-xs text-error">
              <AlertTriangle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>{error} Your schedule was not changed.</span>
            </div>
          )}
          {notes.map((n) => (
            <p key={n} className="text-xs text-warning">{n}</p>
          ))}

          {loading && !res && <p role="status" className="text-xs text-text-muted">Looking for better assignments…</p>}

          {res && !loading && (
            <>
              <Comparison before={emergency?.ok && emergency.doNothing ? emergency.doNothing : res.before} after={emergency?.ok && emergency.afterPlan ? emergency.afterPlan : res.after} />
              {res.truncatedByTime && <p className="text-xs text-warning">The server stopped early to stay fast, so these suggestions may be slightly less optimal.</p>}

              {emergency?.ok && (
                <div role="status" className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs">
                  {emergency.atRisk.length === 0
                    ? 'A delay of this size does not push other jobs back.'
                    : `${emergency.atRisk.length} later job${emergency.atRisk.length === 1 ? ' is' : 's are'} pushed back by this delay${emergency.atRisk.some((a) => a.slaMissed) ? ', some would miss their SLA' : ''}.`}
                </div>
              )}

              {list.length === 0 ? (
                <p className="rounded-xl border border-border p-4 text-center text-xs text-text-muted">
                  {res.unplaced.length ? `No safe one-step improvements. ${res.unplaced.length} job${res.unplaced.length === 1 ? ' cannot' : 's cannot'} be placed — see the reasons below.` : 'Your schedule already looks good — no improvements found.'}
                </p>
              ) : (
                <ol className="space-y-2" aria-label="Ranked suggestions">
                  {list.map((s) => {
                    const done = applied.has(s.id);
                    const isOpen = expanded === s.id;
                    return (
                      <li key={s.id} className="rounded-xl border border-border bg-bg-primary">
                        <div className="flex flex-wrap items-center gap-3 p-3">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent" aria-label={`Rank ${s.rank}`}>{s.rank}</span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-text-primary">{s.explanation.headline}</p>
                            <p className="flex flex-wrap gap-x-3 text-xs text-text-muted">
                              <span className="flex items-center gap-1"><Clock size={11} aria-hidden="true" />{fmtTime(s.startMs)}</span>
                              {s.kind === 'reassign' && s.fromTechId && <span>from {techName.get(s.fromTechId) ?? 'another technician'}</span>}
                              {s.impact.travelMin !== 0 && <span>{s.impact.travelMin > 0 ? '+' : ''}{s.impact.travelMin} min driving</span>}
                              {s.impact.slaMisses < 0 && <span>fixes {-s.impact.slaMisses} SLA miss</span>}
                              {s.impact.revenueRecoveredCents > 0 && <span>{money(s.impact.revenueRecoveredCents)} scheduled</span>}
                            </p>
                          </div>
                          <button type="button" onClick={() => setExpanded(isOpen ? null : s.id)} aria-expanded={isOpen} className="focus-ring min-h-[44px] rounded-lg px-2 text-xs text-accent">Why?</button>
                          <button
                            type="button"
                            onClick={() => void apply(s)}
                            disabled={done || busy !== null}
                            className="focus-ring flex min-h-[44px] items-center gap-1.5 rounded-xl bg-accent px-3 text-xs font-medium text-white disabled:opacity-50"
                          >
                            {done ? <><Check size={13} aria-hidden="true" />Applied</> : busy === s.id ? 'Applying…' : 'Apply'}
                          </button>
                        </div>
                        {isOpen && (
                          <div className="space-y-2 border-t border-border px-3 py-3 text-xs">
                            <ul className="list-disc space-y-0.5 pl-4 text-text-primary">{s.explanation.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                            {s.explanation.warnings.map((w) => <p key={w} className="text-warning">⚠ {w}</p>)}
                            {s.explanation.alternatives.length > 0 && (
                              <div>
                                <p className="mb-1 font-medium text-text-primary">Other options considered</p>
                                <ul className="space-y-0.5 text-text-muted">{s.explanation.alternatives.map((a) => <li key={a.techId}>{a.summary}</li>)}</ul>
                              </div>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}

              {res.bundleOnlyCount > 0 && <p className="text-xs text-text-muted">{res.bundleOnlyCount} more improvement{res.bundleOnlyCount === 1 ? '' : 's'} need several moves together. Apply the ones above, then refresh.</p>}

              {res.unplaced.length > 0 && (
                <details className="rounded-xl border border-border p-3 text-xs">
                  <summary className="cursor-pointer font-medium text-text-primary">{res.unplaced.length} job{res.unplaced.length === 1 ? '' : 's'} could not be placed</summary>
                  <ul className="mt-2 space-y-1 text-text-muted">
                    {res.unplaced.slice(0, 20).map((u) => (
                      <li key={u.jobId}>{jobs.find((j) => j.id === u.jobId)?.customer_name ?? 'Job'}: {u.reasons[0]}</li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="grid gap-3 border-t border-border pt-4 md:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-text-primary">What if…</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={whatIfBusy} onClick={() => void simulate('sick')} className="focus-ring min-h-[44px] rounded-xl border border-border px-3 text-xs disabled:opacity-50">A technician is out today</button>
                    <button type="button" disabled={whatIfBusy} onClick={() => void simulate('overtime')} className="focus-ring min-h-[44px] rounded-xl border border-border px-3 text-xs disabled:opacity-50">We allow 60 min overtime</button>
                  </div>
                  {whatIf && (
                    <ul role="status" className="list-disc space-y-0.5 pl-4 text-xs text-text-primary">{whatIf.summary.map((x) => <li key={x}>{x}</li>)}</ul>
                  )}
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-text-primary">A job is running late</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor="late-job">Job running late</label>
                    <select id="late-job" value={lateJobId} onChange={(e) => setLateJobId(e.target.value)} className="focus-ring min-h-[44px] rounded-xl border border-border bg-bg-primary px-2 text-xs">
                      <option value="">Choose a job…</option>
                      {assignedJobs.map((j) => <option key={j.id} value={j.id}>{j.customer_name}</option>)}
                    </select>
                    <label className="sr-only" htmlFor="late-min">Extra minutes needed</label>
                    <input id="late-min" type="number" min={5} max={480} step={5} value={lateMin} onChange={(e) => setLateMin(Math.max(5, Math.min(480, Number(e.target.value) || 30)))} className="focus-ring min-h-[44px] w-20 rounded-xl border border-border bg-bg-primary px-2 text-xs" />
                    <span className="text-xs text-text-muted">more min</span>
                    <button type="button" disabled={!lateJobId || loading} onClick={() => void reoptimize()} className="focus-ring min-h-[44px] rounded-xl bg-accent px-3 text-xs font-medium text-white disabled:opacity-50">Re-plan</button>
                  </div>
                </div>
              </div>
              <p className="text-[11px] text-text-muted">Drive times are straight-line estimates unless a routing provider is connected. Results can change if the board changes — refresh before applying.</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
