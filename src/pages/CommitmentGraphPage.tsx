/**
 * Commitment Graph — /dashboard/commitments
 * Every promise extracted from calls, quotes, job notes, and SMS —
 * linked to owner, deadline, customer, job, and outcome.
 */

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Loader2, AlertTriangle, Check, X, HelpCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { fetchCommitments, fetchOverdueCommitments, fetchTrustScores, resolveCommitment, type Commitment, type TrustScore } from '@/lib/commitments';

const SOURCE_LABELS: Record<Commitment['source_type'], string> = {
  call: 'Call', sms: 'SMS', quote: 'Quote', job_note: 'Job note', manual: 'Manually logged',
};

export function CommitmentGraphPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState<Commitment[]>([]);
  const [overdue, setOverdue] = useState<Commitment[]>([]);
  const [trust, setTrust] = useState<TrustScore[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [o, od, t] = await Promise.all([fetchCommitments('open'), fetchOverdueCommitments(), fetchTrustScores(user.id)]);
      setOpen(o); setOverdue(od); setTrust(t);
    } catch {
      toast('Could not load the commitment graph.', 'error');
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => { void load(); }, [load]);

  const handleResolve = async (id: string, status: 'kept' | 'broken' | 'unclear') => {
    try {
      await resolveCommitment(id, status);
      setOpen((prev) => prev.filter((c) => c.id !== id));
      setOverdue((prev) => prev.filter((c) => c.id !== id));
      toast('Updated.', 'success');
    } catch {
      toast('Could not update this commitment.', 'error');
    }
  };

  if (loading) {
    return <DashboardLayout activeLabel="Commitment Graph"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="Commitment Graph">
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="text-cta" size={20} />
          <p className="text-sm font-semibold text-text-primary">Commitment Graph</p>
        </div>

        {trust.length > 0 && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="mb-3 text-sm font-semibold text-text-primary">Trust score by owner</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {trust.map((t) => (
                <div key={t.owner_team_member_id ?? 'unassigned'} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <p className="font-medium text-text-primary">{t.owner_name}</p>
                  <p className="text-xs text-text-secondary">
                    {t.trust_pct === null ? 'No resolved commitments yet' : `${t.trust_pct}% kept (${t.kept_count}/${t.total_resolved})`}
                    {t.open_overdue > 0 && <span className="ml-2 text-error-500">{t.open_overdue} overdue</span>}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {overdue.length > 0 && (
          <div className="rounded-2xl border border-error-500/40 bg-error-500/10 p-5">
            <div className="mb-3 flex items-center gap-2"><AlertTriangle size={16} className="text-error-500" /><p className="text-sm font-semibold text-text-primary">Overdue ({overdue.length})</p></div>
            <div className="space-y-2">
              {overdue.map((c) => <CommitmentRow key={c.id} c={c} onResolve={handleResolve} />)}
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Open commitments ({open.length})</p>
          {open.length === 0 ? (
            <p className="text-sm text-text-secondary">Nothing open right now.</p>
          ) : (
            <div className="space-y-2">
              {open.map((c) => <CommitmentRow key={c.id} c={c} onResolve={handleResolve} />)}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}

function CommitmentRow({ c, onResolve }: { c: Commitment; onResolve: (id: string, status: 'kept' | 'broken' | 'unclear') => void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="text-text-primary">{c.commitment_text}</p>
        <p className="mt-1 text-xs text-text-secondary">
          {SOURCE_LABELS[c.source_type]} · {c.owner_name ?? 'Unknown owner'} · {c.customer_name ?? 'Unknown customer'}
          {c.deadline_at && ` · Due ${new Date(c.deadline_at).toLocaleString()}`}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        <button onClick={() => onResolve(c.id, 'kept')} className="focus-ring rounded-lg bg-success-500/15 p-2 text-success-500" title="Kept"><Check size={14} /></button>
        <button onClick={() => onResolve(c.id, 'broken')} className="focus-ring rounded-lg bg-error-500/15 p-2 text-error-500" title="Broken"><X size={14} /></button>
        <button onClick={() => onResolve(c.id, 'unclear')} className="focus-ring rounded-lg bg-bg-tertiary p-2 text-text-secondary" title="Unclear"><HelpCircle size={14} /></button>
      </div>
    </div>
  );
}
