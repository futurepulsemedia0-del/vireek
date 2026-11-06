/**
 * Workflow Health — /dashboard/workflow-health
 *
 * One list of stuck call-to-cash work (booked without technician, completed without invoice,
 * overdue invoice, no-show without rebook) with age, SLA, owner queue and suggested action,
 * plus operator takeover / resume controls. Data comes from c2c_workflow_health() and
 * job_automation_locks (see supabase/migrations/20281116000000_c2c_state_machine_foundation.sql).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, ShieldAlert, Hand, Play } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  STAGE_LABELS,
  formatAge,
  rowKey,
  summarizeHealth,
  validateTakeoverReason,
  type HealthRow,
} from '@/lib/c2cWorkflowHealth';
import { fetchLockedJobIds, fetchWorkflowHealth, releaseJob, takeoverJob } from '@/lib/c2cWorkflowHealthApi';

export function WorkflowHealthPage() {
  const [rows, setRows] = useState<HealthRow[]>([]);
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [takeoverFor, setTakeoverFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [health, lockedIds] = await Promise.all([fetchWorkflowHealth(), fetchLockedJobIds()]);
      setRows(health);
      setLocked(lockedIds);
    } catch {
      setLoadError('Could not load workflow health. Refresh to try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => summarizeHealth(rows), [rows]);

  const confirmTakeover = async (jobId: string) => {
    const invalid = validateTakeoverReason(reason);
    if (invalid) {
      setActionError(invalid);
      return;
    }
    setBusyJob(jobId);
    setActionError(null);
    const res = await takeoverJob(jobId, reason);
    setBusyJob(null);
    if (!res.ok) {
      setActionError(res.message ?? 'Takeover failed.');
      return;
    }
    setTakeoverFor(null);
    setReason('');
    await load();
  };

  const resume = async (jobId: string) => {
    setBusyJob(jobId);
    setActionError(null);
    const res = await releaseJob(jobId);
    setBusyJob(null);
    if (!res.ok) {
      setActionError(res.message ?? 'Could not resume automation.');
      return;
    }
    await load();
  };

  return (
    <DashboardLayout activeLabel="Workflow Health">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <ShieldAlert size={22} className="text-accent" /> Workflow Health
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Work that is stuck between call and cash, oldest and most overdue first. Take over a job to stop
              automation from touching it until you resume.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        <div className="mb-4 grid grid-cols-3 gap-3" aria-label="Summary">
          <div className="rounded-2xl border border-border bg-bg-secondary p-4">
            <p className="text-xs text-text-secondary">Stuck items</p>
            <p className="text-2xl font-bold text-text-primary">{summary.total}</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-4">
            <p className="text-xs text-text-secondary">Past SLA</p>
            <p className="text-2xl font-bold text-text-primary">{summary.breached}</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-4">
            <p className="text-xs text-text-secondary">Oldest</p>
            <p className="text-2xl font-bold text-text-primary">{summary.total ? formatAge(summary.oldestMinutes) : '—'}</p>
          </div>
        </div>

        <div aria-live="polite">
          {(loadError || actionError) && (
            <p role="alert" className="mb-3 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary">
              {loadError ?? actionError}
            </p>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-text-secondary">
            <Loader2 size={20} className="animate-spin" aria-label="Loading" />
          </div>
        ) : rows.length === 0 && !loadError ? (
          <p className="rounded-2xl border border-border bg-bg-secondary p-6 text-center text-sm text-text-secondary">
            Nothing is stuck right now.
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => {
              const key = rowKey(r);
              const jobId = r.job_id;
              const isLocked = jobId ? locked.has(jobId) : false;
              const busy = jobId !== null && busyJob === jobId;
              return (
                <li key={key} className="rounded-2xl border border-border bg-bg-secondary p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-text-primary">{STAGE_LABELS[r.stage]}</p>
                        {r.breached && (
                          <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-primary">
                            Past SLA
                          </span>
                        )}
                        {isLocked && (
                          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                            You have control
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-text-secondary">
                        {r.customer_name ?? 'Unknown customer'} · waiting {formatAge(r.age_minutes)} · queue: {r.owner_queue}
                      </p>
                      {r.suggested_action && <p className="mt-1 text-xs text-text-secondary">Suggested: {r.suggested_action}</p>}
                    </div>

                    {jobId && (
                      <div className="shrink-0">
                        {isLocked ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void resume(jobId)}
                            aria-label={`Resume automation for ${r.customer_name ?? 'this job'}`}
                            className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
                          >
                            <Play size={13} /> Resume automation
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setTakeoverFor(takeoverFor === key ? null : key);
                              setReason('');
                              setActionError(null);
                            }}
                            aria-expanded={takeoverFor === key}
                            aria-label={`Take over ${r.customer_name ?? 'this job'}`}
                            className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
                          >
                            <Hand size={13} /> Take over
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {jobId && takeoverFor === key && !isLocked && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <label htmlFor={`reason-${key}`} className="sr-only">
                        Reason for taking over
                      </label>
                      <input
                        id={`reason-${key}`}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        maxLength={500}
                        placeholder="Why are you taking this over?"
                        className="focus-ring min-w-[200px] flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void confirmTakeover(jobId)}
                        className="focus-ring rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
                      >
                        {busy ? 'Saving…' : 'Confirm takeover'}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </DashboardLayout>
  );
}
