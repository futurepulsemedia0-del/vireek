/**
 * Outcome Assurance — /dashboard/outcome-assurance
 *
 * Service Outcome Guarantee Engine: before dispatch, Vireek estimates the
 * probability that each upcoming job is resolved on the first visit, shows
 * exactly why, and prepares (or applies, with one click) an intervention when
 * confidence is low. See src/lib/outcomeAssurance.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, ChevronDown, RefreshCw, Settings2, ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  DEFAULT_SETTINGS,
  RISK_COLORS,
  RISK_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  applyReassignment,
  computeCalibration,
  evaluateAll,
  fetchAssuranceSettings,
  fetchLatestSnapshots,
  fetchRecentInterventions,
  formatDuration,
  gatherAssuranceContext,
  persistSnapshots,
  recordIntervention,
  saveAssuranceSettings,
  summarizeAssurance,
  type AssuranceContext,
  type AssuranceJob,
  type AssuranceSettings,
  type AssuranceStatus,
  type Evidence,
  type Intervention,
  type InterventionRow,
  type JobAssurance,
  type SnapshotRow,
} from '@/lib/outcomeAssurance';

type Filter = 'all' | 'action' | 'assured';
type Row = { job: AssuranceJob; result: JobAssurance };

const REFRESH_MS = 90_000;

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

function barClass(score: number): string {
  if (score >= 85) return 'bg-success-500';
  if (score >= 70) return 'bg-warning-500';
  return 'bg-danger';
}

const EVIDENCE_LABELS: Record<Evidence, string> = {
  measured: 'Measured',
  estimated: 'Estimated',
  missing: 'No data',
};

const SEVERITY_COLORS: Record<Intervention['severity'], string> = {
  critical: 'bg-danger/10 text-danger',
  high: 'bg-warning-500/10 text-warning-500',
  medium: 'bg-bg-tertiary text-text-secondary',
};

function formatWhen(iso: string | null): string {
  if (!iso) return 'Not scheduled';
  return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ============================================================
// SMALL PARTS
// ============================================================

function Metric({ label, value, valueClass = 'text-text-primary' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-xl bg-bg-primary px-3 py-2">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`text-sm font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}

function StatCard({ label, value, valueClass = 'text-text-primary' }: { label: string; value: string | number; valueClass?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`text-lg font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}

// ============================================================
// INTERVENTION ROW
// ============================================================

function InterventionItem({
  item,
  job,
  result,
  techNames,
  onDone,
}: {
  item: Intervention;
  job: AssuranceJob;
  result: JobAssurance;
  techNames: Map<string, string>;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    setBusy(true);
    try {
      await applyReassignment(job, result, item);
      toast(`Reassigned to ${item.reassignTo?.technicianName ?? 'technician'}`);
      onDone();
    } catch (e) {
      toast(errMessage(e), 'error');
      setBusy(false);
      setConfirming(false);
    }
  };

  const dismiss = async () => {
    setBusy(true);
    try {
      await recordIntervention({ jobId: job.id, intervention: item, outcome: 'dismissed', probabilityBefore: result.probability });
      onDone();
    } catch (e) {
      toast(errMessage(e), 'error');
      setBusy(false);
    }
  };

  const from = job.assigned_technician_id ? techNames.get(job.assigned_technician_id) : null;

  return (
    <li className="rounded-xl border border-border bg-bg-primary p-3">
      <div className="mb-1 flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-text-primary">{item.title}</p>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${SEVERITY_COLORS[item.severity]}`}>{item.severity}</span>
      </div>
      <p className="text-xs text-text-secondary">{item.detail}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {item.reassignTo &&
          (confirming ? (
            <>
              <Button size="sm" onClick={() => void apply()} disabled={busy}>
                Confirm: {from ? `${from} → ` : ''}
                {item.reassignTo.technicianName}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setConfirming(true)} disabled={busy}>
              Reassign to {item.reassignTo.technicianName} · {Math.round(result.probability)}% → {Math.round(item.reassignTo.expectedProbability)}%
            </Button>
          ))}
        {item.href && !confirming && (
          <Link
            to={item.href}
            className="focus-ring inline-flex min-h-[36px] items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          >
            Open <ArrowRight size={12} />
          </Link>
        )}
        {!confirming && (
          <button
            type="button"
            onClick={() => void dismiss()}
            disabled={busy}
            className="focus-ring ml-auto rounded-lg px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            Dismiss
          </button>
        )}
      </div>
    </li>
  );
}

// ============================================================
// JOB CARD
// ============================================================

function JobCard({
  row,
  techNames,
  open,
  onToggle,
  onChanged,
}: {
  row: Row;
  techNames: Map<string, string>;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const { job, result } = row;
  const techName = job.assigned_technician_id ? techNames.get(job.assigned_technician_id) ?? 'Technician' : 'Unassigned';
  const insufficient = result.status === 'insufficient';

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="focus-ring flex w-full items-start justify-between gap-3 p-4 text-left"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-text-primary">{job.customer_name}</span>
          <span className="block truncate text-xs text-text-secondary">
            {job.service_type ?? 'Service'} · {formatWhen(job.scheduled_datetime)} · {techName}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_COLORS[result.status]}`}>
            {insufficient ? 'Not enough evidence' : `${Math.round(result.probability)}% · ${STATUS_LABELS[result.status]}`}
          </span>
          <ChevronDown size={16} className={`text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      <div className="grid grid-cols-2 gap-2 px-4 pb-4 sm:grid-cols-4">
        <Metric label="Expected resolution" value={formatDuration(result.expectedResolutionMinutes)} />
        <Metric label="Parts readiness" value={result.partsReadiness === null ? 'Unknown' : `${result.partsReadiness}%`} />
        <Metric label="Technician fit" value={result.technicianFit === null ? 'Unassigned' : `${result.technicianFit}%`} />
        <Metric label="Customer disruption risk" value={RISK_LABELS[result.disruptionRisk]} valueClass={RISK_COLORS[result.disruptionRisk]} />
      </div>

      {open && (
        <div className="space-y-4 border-t border-border px-4 py-4">
          {result.blockers.length > 0 && (
            <div className="flex items-start gap-2 rounded-xl bg-danger/10 p-3 text-xs text-danger">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{result.blockers.join('; ')}. Dispatch is blocked until this is resolved.</span>
            </div>
          )}

          {result.interventions.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold text-text-primary">Recommended interventions</p>
              <ul className="space-y-2">
                {result.interventions.map((i) => (
                  <InterventionItem key={i.id} item={i} job={job} result={result} techNames={techNames} onDone={onChanged} />
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="mb-2 text-xs font-semibold text-text-primary">
              Why this number <span className="font-normal text-text-secondary">· {Math.round(result.coverage)}% of the model is backed by evidence</span>
            </p>
            <div className="space-y-3">
              {result.factors.map((f) => (
                <div key={f.key}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                    <span className="text-text-primary">
                      {f.label} <span className="text-text-secondary">· weight {f.weight}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-secondary">{EVIDENCE_LABELS[f.evidence]}</span>
                      <span className="w-8 text-right font-medium text-text-primary">{f.score === null ? '—' : Math.round(f.score)}</span>
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                    {f.score !== null && <div className={`h-full rounded-full ${barClass(f.score)}`} style={{ width: `${Math.min(100, Math.max(0, f.score))}%` }} />}
                  </div>
                  <p className="mt-1 text-[11px] text-text-secondary">{f.detail}</p>
                  {f.issues.length > 0 && (
                    <ul className="mt-0.5 list-disc pl-4 text-[11px] text-warning-500">
                      {f.issues.map((iss) => (
                        <li key={iss}>{iss}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// SETTINGS PANEL
// ============================================================

function SettingsPanel({ settings, isOwner, onSaved }: { settings: AssuranceSettings; isOwner: boolean; onSaved: () => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const valid = draft.intervene_below < draft.assured_threshold && draft.assured_threshold <= 99 && draft.intervene_below >= 30 && draft.assured_threshold >= 50;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const save = async () => {
    setSaving(true);
    try {
      await saveAssuranceSettings(draft);
      toast('Guarantee thresholds saved');
      onSaved();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setSaving(false);
  };

  const field = 'focus-ring w-20 rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary disabled:opacity-60';

  return (
    <div className="mb-5 rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="mb-3 flex items-center gap-2 text-sm font-medium text-text-primary">
        <Settings2 size={15} /> Guarantee thresholds
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-xs text-text-secondary">
          Assured at or above (%)
          <input
            type="number"
            min={50}
            max={99}
            value={draft.assured_threshold}
            disabled={!isOwner}
            onChange={(e) => setDraft({ ...draft, assured_threshold: Number(e.target.value) })}
            className={`${field} mt-1 block`}
          />
        </label>
        <label className="text-xs text-text-secondary">
          Intervene below (%)
          <input
            type="number"
            min={30}
            max={95}
            value={draft.intervene_below}
            disabled={!isOwner}
            onChange={(e) => setDraft({ ...draft, intervene_below: Number(e.target.value) })}
            className={`${field} mt-1 block`}
          />
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={draft.notify_on_intervene}
            disabled={!isOwner}
            onChange={(e) => setDraft({ ...draft, notify_on_intervene: e.target.checked })}
          />
          Alert me when a job drops into Intervene
        </label>
        {isOwner && (
          <Button size="sm" onClick={() => void save()} disabled={!dirty || !valid || saving}>
            Save
          </Button>
        )}
      </div>
      {!valid && <p className="mt-2 text-xs text-danger">Intervene-below must be lower than assured (assured 50-99, intervene 30-95).</p>}
      {!isOwner && <p className="mt-2 text-xs text-text-secondary">Only the account owner can change thresholds.</p>}
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function OutcomeAssurancePage() {
  const { isOwner } = useAuth();
  const [ctx, setCtx] = useState<AssuranceContext | null>(null);
  const [settings, setSettings] = useState<AssuranceSettings>(DEFAULT_SETTINGS);
  const [rows, setRows] = useState<Row[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [interventions, setInterventions] = useState<InterventionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
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
      const [context, cfg] = await Promise.all([gatherAssuranceContext(), fetchAssuranceSettings()]);
      const evaluated = evaluateAll(context, cfg);
      if (!mounted.current) return;
      setCtx(context);
      setSettings(cfg);
      setRows(evaluated);
      setFailed(false);
      setLoading(false);

      // History + automatic alerts. Never blocks or breaks the page.
      try {
        await persistSnapshots(evaluated.map((e) => e.result));
      } catch {
        /* migration not applied yet: predictions still show, just not stored */
      }
      const [snaps, recent] = await Promise.all([fetchLatestSnapshots(), fetchRecentInterventions()]);
      if (!mounted.current) return;
      setSnapshots(snaps);
      setInterventions(recent);
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

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const refresh = () => {
    setRefreshing(true);
    void load();
  };

  const techNames = useMemo(() => new Map((ctx?.technicians ?? []).map((t) => [t.id, t.name])), [ctx]);
  const summary = useMemo(() => summarizeAssurance(rows.map((r) => r.result)), [rows]);
  const calibration = useMemo(() => computeCalibration(snapshots, ctx?.outcomes ?? []), [snapshots, ctx]);

  const visible = useMemo(() => {
    if (filter === 'action') return rows.filter((r) => r.result.status !== 'assured');
    if (filter === 'assured') return rows.filter((r) => r.result.status === 'assured');
    return rows;
  }, [rows, filter]);

  const filters: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'all', label: 'All', count: rows.length },
    { key: 'action', label: 'Needs action', count: rows.length - summary.assured },
    { key: 'assured', label: 'Assured', count: summary.assured },
  ];

  const countBy = (s: AssuranceStatus) => rows.filter((r) => r.result.status === s).length;

  return (
    <DashboardLayout activeLabel="Outcome Assurance">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <ShieldCheck size={18} /> Outcome Assurance
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Before dispatch, Vireek calculates the probability that each job is resolved on the first visit, explains why, and intervenes when confidence is low.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>
              <Settings2 size={14} /> Thresholds
            </Button>
            <Button size="sm" variant="secondary" onClick={refresh} disabled={refreshing || loading}>
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
        </div>

        {showSettings && <SettingsPanel settings={settings} isOwner={isOwner} onSaved={refresh} />}

        {loading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </div>
        ) : failed ? (
          <EmptyState
            icon={ShieldCheck}
            title="Outcome Assurance unavailable"
            description="Jobs or team data could not be loaded. Check your connection and try again."
            action={{ label: 'Reload', onClick: () => { setLoading(true); void load(); } }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No upcoming jobs to assure"
            description="Scheduled and en-route jobs appear here with their success probability as soon as they are booked."
          />
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard label="Avg success probability" value={summary.avgProbability !== null ? `${Math.round(summary.avgProbability)}%` : '—'} />
              <StatCard label="Assured" value={countBy('assured')} valueClass="text-success-500" />
              <StatCard label="Watch" value={countBy('watch')} valueClass="text-warning-500" />
              <StatCard label="Intervene" value={countBy('intervene')} valueClass="text-danger" />
            </div>
            {summary.insufficient > 0 && (
              <p className="mb-4 text-xs text-text-secondary">
                {summary.insufficient} job{summary.insufficient === 1 ? '' : 's'} without enough evidence to promise an outcome. Vireek will not guess: add required parts and mission briefs to raise coverage.
              </p>
            )}

            <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Filter jobs">
              {filters.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.key}
                  onClick={() => setFilter(f.key)}
                  className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
                >
                  {f.label} ({f.count})
                </button>
              ))}
            </div>

            <div className="space-y-3">
              {visible.map((r) => (
                <JobCard
                  key={r.job.id}
                  row={r}
                  techNames={techNames}
                  open={openId === r.job.id}
                  onToggle={() => setOpenId(openId === r.job.id ? null : r.job.id)}
                  onChanged={refresh}
                />
              ))}
              {visible.length === 0 && <p className="py-6 text-center text-sm text-text-secondary">Nothing in this view.</p>}
            </div>

            <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-4">
              <p className="mb-1 text-sm font-semibold text-text-primary">How accurate has Vireek been?</p>
              {calibration.n === 0 ? (
                <p className="text-xs text-text-secondary">
                  Once jobs that Vireek scored are completed with a recorded outcome, predicted vs actual first-visit resolution appears here.
                </p>
              ) : (
                <>
                  <p className="mb-3 text-xs text-text-secondary">
                    {calibration.n} completed job{calibration.n === 1 ? '' : 's'} compared · Brier score {calibration.brier?.toFixed(3)} (lower is better)
                    {calibration.n < 20 && ' · too few jobs to judge accuracy yet'}
                  </p>
                  <div className="space-y-2">
                    {calibration.buckets.map((b) => (
                      <div key={b.label} className="flex items-center gap-3 text-xs">
                        <span className="w-20 shrink-0 text-text-secondary">{b.label}</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
                          <div className={`h-full rounded-full ${barClass(b.actual)}`} style={{ width: `${Math.min(100, b.actual)}%` }} />
                        </div>
                        <span className="w-44 shrink-0 text-right text-text-primary">
                          predicted {Math.round(b.predicted)}% · actual {Math.round(b.actual)}% ({b.n})
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {interventions.length > 0 && (
              <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-4">
                <p className="mb-2 text-sm font-semibold text-text-primary">Recent interventions</p>
                <ul className="space-y-1.5">
                  {interventions.map((i) => (
                    <li key={i.id} className="flex items-start justify-between gap-3 rounded-lg bg-bg-primary px-3 py-2 text-xs">
                      <span className="min-w-0 text-text-primary">
                        {i.title} <span className="text-text-secondary">· {i.outcome}</span>
                      </span>
                      <span className="shrink-0 text-text-secondary">
                        {i.probability_before !== null && i.probability_after !== null ? `${Math.round(i.probability_before)}% → ${Math.round(i.probability_after)}% · ` : ''}
                        {new Date(i.created_at).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
