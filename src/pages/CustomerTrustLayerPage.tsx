/**
 * Customer Trust Layer — /dashboard/trust-layer
 *
 * Measurable trust per job: a 0-100 Trust Score built from 10 weighted
 * signals, verifiable customer-facing badges, and the evidence ledger
 * behind every number. See src/lib/jobTrustLayer.ts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  ALL_SIGNALS,
  BADGE_DEFS,
  EVENT_LABELS,
  fetchPublicTrustEnabled,
  fetchTrustEvents,
  fetchTrustScores,
  getPublicTrustLink,
  isTrustedService,
  missingSignals,
  recordTrustEvent,
  refreshTrustScore,
  scoreBarClass,
  setPublicTrustEnabled,
  SIGNAL_FORMS,
  SIGNAL_LABELS,
  SIGNAL_SOURCES,
  summarizeTrust,
  TIER_COLORS,
  TIER_LABELS,
  type JobTrustEvent,
  type JobTrustScore,
  type ManualTrustSignal,
} from '@/lib/jobTrustLayer';

type Filter = 'all' | 'at_risk' | 'pending';

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

// ============================================================
// SMALL PARTS
// ============================================================

function ScoreChip({ row }: { row: JobTrustScore }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${TIER_COLORS[row.tier]}`}>
      {row.trust_score !== null ? Math.round(row.trust_score) : '—'} · {TIER_LABELS[row.tier]}
    </span>
  );
}

function BadgeDots({ badges }: { badges: JobTrustScore['badges'] }) {
  return (
    <span className="flex items-center gap-1" aria-label="Verification badges">
      {BADGE_DEFS.map((b) => (
        <span
          key={b.key}
          title={badges[b.key] ? b.label : b.pending}
          className={`flex h-5 w-5 items-center justify-center rounded-full ${badges[b.key] ? 'bg-success-500/15 text-success-500' : 'bg-bg-tertiary text-text-secondary/50'}`}
        >
          <Check size={11} />
        </span>
      ))}
    </span>
  );
}

// ============================================================
// RECORD SIGNAL FORM
// ============================================================

function RecordSignalForm({ jobId, onSaved }: { jobId: string; onSaved: () => void }) {
  const { toast } = useToast();
  const [signal, setSignal] = useState<ManualTrustSignal>('price_transparency');
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);
  const form = SIGNAL_FORMS[signal];

  const submit = async () => {
    const inputs: Record<string, number | boolean | string> = {};
    for (const f of form.fields) {
      const v = values[f.key];
      if (f.kind === 'boolean') {
        inputs[f.key] = v === true;
      } else if (f.kind === 'number') {
        if (v === undefined || v === '') {
          if (f.required) { toast(`${f.label} is required`, 'error'); return; }
          continue;
        }
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) { toast(`${f.label} must be a number, zero or more`, 'error'); return; }
        inputs[f.key] = n;
      } else {
        const t = typeof v === 'string' ? v.trim() : '';
        if (!t && f.required) { toast(`${f.label} is required`, 'error'); return; }
        if (t) inputs[f.key] = t;
      }
    }
    setSaving(true);
    try {
      await recordTrustEvent(jobId, signal, inputs);
      toast('Signal recorded');
      setValues({});
      onSaved();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <p className="mb-2 text-xs font-semibold text-text-primary">Record a signal</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(Object.keys(SIGNAL_FORMS) as ManualTrustSignal[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setSignal(s); setValues({}); }}
            className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${signal === s ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
          >
            {SIGNAL_FORMS[s].title}
          </button>
        ))}
      </div>
      <p className="mb-3 text-xs text-text-secondary">{form.hint}</p>
      <div className="space-y-3">
        {form.fields.map((f) =>
          f.kind === 'boolean' ? (
            <label key={f.key} className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={values[f.key] === true}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))}
                className="h-4 w-4 rounded border-border accent-accent"
              />
              {f.label}
            </label>
          ) : (
            <Input
              key={f.key}
              label={f.label}
              type={f.kind === 'number' ? 'number' : 'text'}
              min={f.kind === 'number' ? 0 : undefined}
              step={f.kind === 'number' ? 'any' : undefined}
              placeholder={f.placeholder}
              value={typeof values[f.key] === 'string' ? (values[f.key] as string) : ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          )
        )}
      </div>
      <div className="mt-3">
        <Button size="sm" onClick={() => void submit()} disabled={saving}>
          {saving ? 'Saving…' : 'Save signal'}
        </Button>
      </div>
    </div>
  );
}

// ============================================================
// JOB DETAIL
// ============================================================

function JobTrustDetail({ row, publicEnabled, onChanged }: { row: JobTrustScore; publicEnabled: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [events, setEvents] = useState<JobTrustEvent[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadEvents = useCallback(async () => {
    try {
      setEvents(await fetchTrustEvents(row.job_id));
    } catch {
      setEvents([]);
    }
  }, [row.job_id]);

  useEffect(() => { void loadEvents(); }, [loadEvents, row.updated_at]);

  const missing = useMemo(() => missingSignals(row.dimensions), [row.dimensions]);
  const byWeight = useMemo(() => new Map(ALL_SIGNALS.map((s) => [s.signal, s.weight])), []);
  const token = row.job?.reschedule_token ?? null;

  const copyLink = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(getPublicTrustLink(token));
      toast('Customer link copied');
    } catch {
      toast('Could not copy the link', 'error');
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshTrustScore(row.job_id);
      onChanged();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setRefreshing(false);
  };

  return (
    <div className="space-y-4 border-t border-border px-4 py-4">
      <div>
        <p className="mb-2 text-xs font-semibold text-text-primary">Score breakdown</p>
        <div className="space-y-2">
          {row.dimensions.map((d) => (
            <div key={d.signal}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-text-primary">
                  {SIGNAL_LABELS[d.signal]} <span className="text-text-secondary">· weight {byWeight.get(d.signal) ?? d.weight}</span>
                </span>
                <span className="flex items-center gap-1.5 font-medium text-text-primary">
                  {d.verified && <Check size={12} className="text-success-500" aria-label="Verified" />}
                  {Math.round(d.score)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                <div className={`h-full rounded-full ${scoreBarClass(d.score)}`} style={{ width: `${Math.min(100, Math.max(0, d.score))}%` }} />
              </div>
            </div>
          ))}
          {row.dimensions.length === 0 && <p className="text-xs text-text-secondary">No evidence recorded on this job yet.</p>}
        </div>
      </div>

      {missing.length > 0 && (
        <div className="rounded-xl bg-bg-tertiary p-3">
          <p className="mb-1.5 text-xs font-semibold text-text-primary">Missing evidence ({Math.round(100 - row.coverage)}% of the score is unmeasured)</p>
          <ul className="space-y-1">
            {missing.map((s) => (
              <li key={s} className="text-xs text-text-secondary">
                <span className="font-medium text-text-primary">{SIGNAL_LABELS[s]}:</span> {SIGNAL_SOURCES[s]}
              </li>
            ))}
          </ul>
        </div>
      )}

      <RecordSignalForm jobId={row.job_id} onSaved={onChanged} />

      <div>
        <p className="mb-2 text-xs font-semibold text-text-primary">Evidence ledger</p>
        {events === null ? (
          <div className="h-10 animate-pulse rounded-xl bg-bg-tertiary" />
        ) : events.length === 0 ? (
          <p className="text-xs text-text-secondary">Nothing recorded yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {events.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 rounded-lg bg-bg-primary px-3 py-2 text-xs">
                <span className="min-w-0">
                  <span className="font-medium text-text-primary">{EVENT_LABELS[e.signal] ?? e.signal}</span>
                  <span className="text-text-secondary"> · {e.source}{e.detail ? ` · ${e.detail}` : ''}</span>
                </span>
                <span className="shrink-0 text-text-secondary">
                  {Math.round(e.score)} · {new Date(e.created_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Recalculate
        </Button>
        {token && publicEnabled && (
          <>
            <Button size="sm" variant="secondary" onClick={() => void copyLink()}>
              <Copy size={14} /> Copy customer link
            </Button>
            <a href={getPublicTrustLink(token)} target="_blank" rel="noreferrer" className="focus-ring inline-flex min-h-[40px] items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-text-secondary hover:bg-bg-tertiary hover:text-text-primary">
              <ExternalLink size={14} /> Preview
            </a>
          </>
        )}
        {token && !publicEnabled && <p className="self-center text-xs text-text-secondary">Turn on the customer page above to share this score.</p>}
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function CustomerTrustLayerPage() {
  const { isOwner } = useAuth();
  const { toast } = useToast();
  const [rows, setRows] = useState<JobTrustScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [publicEnabled, setPublicEnabled] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [scores, enabled] = await Promise.all([fetchTrustScores(), fetchPublicTrustEnabled().catch(() => false)]);
      setRows(scores.filter((r) => r.job !== null && r.job.job_status !== 'cancelled'));
      setPublicEnabled(enabled);
      setFailed(false);
    } catch {
      setFailed(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => summarizeTrust(rows), [rows]);
  const visible = useMemo(() => {
    if (filter === 'at_risk') return rows.filter((r) => r.tier === 'at_risk');
    if (filter === 'pending') return rows.filter((r) => r.tier === 'pending');
    return rows;
  }, [rows, filter]);

  const togglePublic = async () => {
    try {
      await setPublicTrustEnabled(!publicEnabled);
      setPublicEnabled(!publicEnabled);
      toast(!publicEnabled ? 'Customers can now view their Trust Score' : 'Customer page turned off');
    } catch (e) {
      toast(errMessage(e), 'error');
    }
  };

  return (
    <DashboardLayout activeLabel="Customer Trust Layer">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
            <ShieldCheck size={18} /> Customer Trust Layer
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Measurable trust before, during and after every job: a 0-100 Trust Score built from 10 weighted signals, with verifiable badges customers can see.
          </p>
        </div>

        <div className="mb-5 flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
          <div>
            <p className="text-sm font-medium text-text-primary">Show customers their Trust Score</p>
            <p className="text-xs text-text-secondary">Adds a private verification page per job (Vireek Trusted Service™ seal when earned). Owner only.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={publicEnabled}
            aria-label="Show customers their Trust Score"
            disabled={!isOwner}
            onClick={() => void togglePublic()}
            className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${publicEnabled ? 'bg-accent' : 'bg-bg-tertiary'}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${publicEnabled ? 'left-[22px]' : 'left-0.5'}`} />
          </button>
        </div>

        {loading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </div>
        ) : failed ? (
          <EmptyState
            icon={ShieldCheck}
            title="Trust Layer unavailable"
            description="The Trust Layer tables were not found. Apply the 20261230000000_customer_trust_layer migration, then reload."
            action={{ label: 'Reload', onClick: () => { setLoading(true); void load(); } }}
          />
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-2xl border border-border bg-bg-secondary p-3">
                <p className="text-[11px] text-text-secondary">Average Trust Score</p>
                <p className="text-lg font-semibold text-text-primary">{summary.avgScore !== null ? Math.round(summary.avgScore) : '—'}</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-3">
                <p className="text-[11px] text-text-secondary">Jobs scored</p>
                <p className="text-lg font-semibold text-text-primary">{summary.scored}<span className="text-xs font-normal text-text-secondary"> / {summary.total}</span></p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-3">
                <p className="text-[11px] text-text-secondary">Trusted Service™</p>
                <p className="text-lg font-semibold text-success-500">{summary.trusted}</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-3">
                <p className="text-[11px] text-text-secondary">At risk</p>
                <p className="text-lg font-semibold text-danger">{summary.atRisk}</p>
              </div>
            </div>

            {summary.scored > 0 && (
              <div className="mb-5 rounded-2xl border border-border bg-bg-secondary p-4">
                <p className="mb-3 text-xs font-semibold text-text-primary">
                  Average by signal
                  {summary.weakest && <span className="font-normal text-text-secondary"> · weakest: {SIGNAL_LABELS[summary.weakest.signal]} ({Math.round(summary.weakest.avg)})</span>}
                </p>
                <div className="space-y-2">
                  {ALL_SIGNALS.map(({ signal }) => {
                    const avg = summary.signalAverages[signal];
                    return (
                      <div key={signal} className="flex items-center gap-3 text-xs">
                        <span className="w-40 shrink-0 text-text-secondary">{SIGNAL_LABELS[signal]}</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
                          {avg !== undefined && <div className={`h-full rounded-full ${scoreBarClass(avg)}`} style={{ width: `${Math.min(100, avg)}%` }} />}
                        </div>
                        <span className="w-8 text-right font-medium text-text-primary">{avg !== undefined ? Math.round(avg) : '—'}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="mb-3 flex gap-1.5">
              {([['all', 'All jobs'], ['at_risk', 'At risk'], ['pending', 'Needs evidence']] as [Filter, string][]).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${filter === key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {visible.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title={filter === 'all' ? 'No jobs to score' : 'Nothing in this view'}
                description={filter === 'all' ? 'Trust Scores appear here as jobs are created and progress.' : 'Switch the filter to see other jobs.'}
              />
            ) : (
              <div className="space-y-2">
                {visible.map((r) => {
                  const open = openId === r.job_id;
                  return (
                    <div key={r.job_id} className="overflow-hidden rounded-2xl border border-border bg-bg-secondary">
                      <button
                        type="button"
                        onClick={() => setOpenId(open ? null : r.job_id)}
                        aria-expanded={open}
                        className="focus-ring flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-text-primary">{r.job?.customer_name}</span>
                          <span className="block truncate text-xs text-text-secondary">
                            {r.job?.service_type ?? 'Service'}{r.job?.scheduled_datetime ? ` · ${new Date(r.job.scheduled_datetime).toLocaleDateString()}` : ''}
                            {isTrustedService(r) ? ' · Trusted Service™' : ''}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-3">
                          <span className="hidden sm:block"><BadgeDots badges={r.badges} /></span>
                          <ScoreChip row={r} />
                          <ChevronDown size={16} className={`text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
                        </span>
                      </button>
                      {open && <JobTrustDetail row={r} publicEnabled={publicEnabled} onChanged={() => void load()} />}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
