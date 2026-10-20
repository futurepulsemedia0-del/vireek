import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import { supabase, type Job } from '@/lib/supabase';
import { useToast } from '@/contexts/ToastContext';
import { rankJob, recordManualDecision, type RankResult, type RankedTechnician, type RulesBundle } from '@/lib/dispatchRulesApi';

const OUTCOME_STYLE: Record<string, string> = {
  pass: 'text-success-500',
  bonus: 'text-success-500',
  fail: 'text-danger',
  penalty: 'text-warning-500',
  neutral: 'text-text-secondary',
};
const OUTCOME_MARK: Record<string, string> = { pass: '✓', bonus: '+', fail: '✕', penalty: '−', neutral: '·' };

/** Presentational: one technician row with an expandable factor-by-factor explanation. */
export function RankedRow({ row, action }: { row: RankedTechnician; action?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`rounded-xl border p-3 ${row.eligible ? 'border-border bg-bg-primary' : 'border-danger/30 bg-danger/5'}`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${row.eligible ? 'bg-accent/10 text-accent' : 'bg-danger/10 text-danger'}`}>
          {row.rank ?? '✕'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <p className="truncate text-sm font-semibold text-text-primary">{row.technician_name}</p>
            <span className="text-xs tabular-nums text-text-secondary">{row.score} pts</span>
          </div>
          <p className="mt-0.5 text-xs text-text-secondary">{row.summary}</p>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="focus-ring mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-accent"
          >
            Why <ChevronDown size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {open && (
            <ul className="mt-2 space-y-1 border-l border-border pl-3">
              {row.factors.map((f) => (
                <li key={f.rule_id} className="flex gap-2 text-xs">
                  <span className={`w-3 shrink-0 text-center font-bold ${OUTCOME_STYLE[f.outcome]}`}>{OUTCOME_MARK[f.outcome]}</span>
                  <span className="min-w-0 flex-1 text-text-secondary">
                    <span className="font-medium text-text-primary">{f.label}:</span> {f.detail}
                  </span>
                  {f.points !== 0 && <span className={`shrink-0 tabular-nums ${OUTCOME_STYLE[f.outcome]}`}>{f.points > 0 ? '+' : ''}{f.points}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        {action}
      </div>
    </li>
  );
}

export function RankingList({ ranking, renderAction }: { ranking: RankResult; renderAction?: (row: RankedTechnician) => ReactNode }) {
  if (ranking.ranked.length === 0) return <p className="text-xs text-text-secondary">No dispatch-enabled technicians on the team.</p>;
  return (
    <ul className="space-y-2">
      {ranking.ranked.map((r) => (
        <RankedRow key={r.technician_id} row={r} action={renderAction?.(r)} />
      ))}
    </ul>
  );
}

interface Props {
  job: Job;
  bundle: RulesBundle | null;
  ownerId: string | null | undefined;
  busy: boolean;
  /** The board's own assign handler — keeps every existing gate (first-time-fix, compliance, time off, capacity). */
  onAssign: (job: Job, technicianId: string) => Promise<void>;
}

export function DispatchRulesPanel({ job, bundle, ownerId, busy, onAssign }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<RankedTechnician | null>(null);
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);

  const ranking = useMemo(() => (bundle?.hasRules ? rankJob(job as unknown as Record<string, unknown>, bundle) : null), [bundle, job]);
  if (!bundle || !ranking || !ownerId) return null;

  const best = ranking.best;
  const closeCall = ranking.margin !== null && ranking.margin < 3;

  const confirm = async (row: RankedTechnician) => {
    setWorking(true);
    try {
      await onAssign(job, row.technician_id);
      // The board handler reports its own errors; only log a decision if the assignment really landed.
      const { data } = await supabase.from('jobs').select('assigned_technician_id').eq('id', job.id).maybeSingle();
      if (data?.assigned_technician_id === row.technician_id) {
        await recordManualDecision(ownerId, { jobId: job.id, technicianId: row.technician_id, ranking, reason });
      }
      setPending(null);
      setReason('');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not record the decision', 'error');
    } finally {
      setWorking(false);
    }
  };

  const action = (row: RankedTechnician) => {
    const isTop = best?.technician_id === row.technician_id;
    return (
      <button
        type="button"
        disabled={busy || working}
        onClick={() => (isTop ? void confirm(row) : setPending(row))}
        className={`focus-ring shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${isTop ? 'bg-accent text-white' : 'border border-border text-text-secondary hover:border-accent/40 hover:text-accent'}`}
      >
        {isTop ? 'Assign' : row.eligible ? 'Override' : 'Override anyway'}
      </button>
    );
  };

  return (
    <div className="mt-3 rounded-xl border border-border/70 bg-bg-secondary">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="focus-ring flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-text-secondary"
      >
        <SlidersHorizontal size={12} className="text-accent" />
        <span className="flex-1 truncate">
          Rules engine:{' '}
          {best ? (
            <span className="text-text-primary">
              {best.technician_name}
              {closeCall && <span className="ml-1 text-warning-500">(close call)</span>}
            </span>
          ) : (
            <span className="text-danger">no technician satisfies your rules</span>
          )}
        </span>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="space-y-2 px-3 pb-3">
          <RankingList ranking={ranking} renderAction={action} />
          {pending && (
            <div role="group" aria-label="Confirm override" className="rounded-xl border border-warning-500/30 bg-warning-500/10 p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
                <ShieldAlert size={13} className="text-warning-500" />
                {pending.eligible ? `Override the engine and assign ${pending.technician_name}?` : `${pending.technician_name} breaks your rules. Assign anyway?`}
              </p>
              {!pending.eligible && <p className="mt-1 text-xs text-text-secondary">{pending.blocked_by.join('; ')}</p>}
              <label className="mt-2 block text-xs text-text-secondary" htmlFor={`ovr-${job.id}`}>
                Reason (saved to the decision log{pending.eligible ? ', optional' : ''})
              </label>
              <input
                id={`ovr-${job.id}`}
                value={reason}
                maxLength={300}
                onChange={(e) => setReason(e.target.value)}
                className="focus-ring mt-1 w-full rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-xs text-text-primary"
              />
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => { setPending(null); setReason(''); }} className="focus-ring rounded-lg px-2.5 py-1 text-xs text-text-secondary">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={working || busy || (!pending.eligible && reason.trim().length < 3)}
                  onClick={() => void confirm(pending)}
                  className="focus-ring rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                >
                  {working ? 'Assigning…' : 'Confirm override'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
