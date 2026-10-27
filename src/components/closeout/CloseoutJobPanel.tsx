import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, ShieldAlert, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  STEP_LABELS, STATUS_LABELS, deadlineRisk, fetchCloseoutSettings, fetchJobCloseout, openCloseoutCase,
  preApprovalBlockers, todayIso, DEFAULT_SETTINGS, type CloseoutCase, type CloseoutSettings, type CloseoutStep,
} from '@/lib/installCloseout';
import { RiskBadge, deadlineText } from '@/components/closeout/CloseoutBoard';

/** Compact closeout summary for a job. Renders nothing for technicians (office/owner only). */
export function CloseoutJobPanel({ job }: { job: { id: string; job_status: string } }) {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const allowed = isOwner || permissions.can_view_all_jobs;
  const [state, setState] = useState<{ case: CloseoutCase | null; steps: CloseoutStep[] } | null>(null);
  const [settings, setSettings] = useState<CloseoutSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([fetchJobCloseout(job.id), fetchCloseoutSettings()]);
      setState(s); setSettings(st);
    } catch { setDenied(true); }
  }, [job.id]);
  useEffect(() => { if (allowed) void load(); }, [allowed, load]);

  if (!allowed || denied) return null;
  if (!state) return null;

  const today = todayIso();
  const blockers = preApprovalBlockers(state.steps.map((s) => ({ ...s, program_name: s.closeout_programs?.name ?? null })));
  const notStarted = !['en_route', 'in_progress', 'completed'].includes(job.job_status);

  if (!state.case) {
    return (
      <section className="rounded-2xl border border-border bg-bg-secondary p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><ClipboardCheck size={16} />Install closeout</h3>
        <p className="mt-1 text-xs text-text-secondary">Track the permit, inspection, warranty, rebate and customer documents for this install.</p>
        <button type="button" disabled={busy}
          className="focus-ring mt-3 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-text-primary hover:bg-bg-tertiary disabled:opacity-50"
          onClick={async () => {
            setBusy(true);
            try { await openCloseoutCase(job.id); toast('Closeout opened.', 'success'); await load(); }
            catch (e) { toast(e instanceof Error ? e.message : 'Could not open the closeout.', 'error'); }
            finally { setBusy(false); }
          }}>
          {busy && <Loader2 size={13} className="animate-spin" />}Open closeout for this job
        </button>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><ClipboardCheck size={16} />Install closeout</h3>
        <Link to={`/dashboard/install-closeout?case=${state.case.id}`} className="focus-ring text-xs font-semibold text-accent underline">Open checklist</Link>
      </div>
      {blockers.length > 0 && notStarted && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger" role="alert">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          Do not start this job: pre-approval is required first — {blockers.join(', ')}. The system will block the status change.
        </p>
      )}
      <ul className="mt-2 space-y-1">
        {state.steps.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate text-text-primary">{STEP_LABELS[s.step_key]} <span className="text-text-secondary">· {STATUS_LABELS[s.status]} · {deadlineText(s.deadline_on, today)}</span></span>
            <RiskBadge risk={deadlineRisk(s, today, settings)} />
          </li>
        ))}
      </ul>
    </section>
  );
}
