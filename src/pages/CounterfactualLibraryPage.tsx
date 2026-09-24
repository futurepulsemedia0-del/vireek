/**
 * Business Counterfactual Library — /dashboard/counterfactuals
 * Stores "what if" analyses for real decisions: technician dispatch,
 * quote financing, and job reschedules — learned from this business's
 * own history, not generic rules.
 */

import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Loader2, Sparkles } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  analyzeQuoteFinancing,
  analyzeReschedule,
  analyzeTechnicianDispatch,
  fetchCounterfactuals,
  fetchUnanalyzedAssignments,
  fetchUnanalyzedDeclinedQuotes,
  fetchUnanalyzedScheduleChanges,
  type Counterfactual,
  type PendingAssignment,
  type PendingQuote,
  type PendingScheduleChange,
} from '@/lib/counterfactuals';

const CONFIDENCE_STYLES: Record<Counterfactual['confidence'], string> = {
  high: 'bg-success-500/15 text-success-500',
  medium: 'bg-warning-500/15 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

export function CounterfactualLibraryPage() {
  const { toast } = useToast();
  const [library, setLibrary] = useState<Counterfactual[]>([]);
  const [pendingAssignments, setPendingAssignments] = useState<PendingAssignment[]>([]);
  const [pendingSchedules, setPendingSchedules] = useState<PendingScheduleChange[]>([]);
  const [pendingQuotes, setPendingQuotes] = useState<PendingQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [lib, pa, ps, pq] = await Promise.all([
        fetchCounterfactuals(),
        fetchUnanalyzedAssignments(),
        fetchUnanalyzedScheduleChanges(),
        fetchUnanalyzedDeclinedQuotes(),
      ]);
      setLibrary(lib); setPendingAssignments(pa); setPendingSchedules(ps); setPendingQuotes(pq);
    } catch {
      toast('Could not load the counterfactual library.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const run = async (id: string, fn: () => Promise<void>) => {
    setAnalyzingId(id);
    try {
      await fn();
      toast('Analysis added to the library.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Analysis failed.', 'error');
    } finally {
      setAnalyzingId(null);
    }
  };

  if (loading) {
    return <DashboardLayout activeLabel="Counterfactual Library"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="Counterfactual Library">
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-2">
          <GitBranch className="text-cta" size={20} />
          <p className="text-sm font-semibold text-text-primary">Business Counterfactual Library</p>
        </div>

        {(pendingAssignments.length > 0 || pendingSchedules.length > 0 || pendingQuotes.length > 0) && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="mb-3 text-sm font-semibold text-text-primary">Pending decisions ready to analyze</p>
            <div className="space-y-2">
              {pendingAssignments.map((a) => (
                <div key={a.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <span>Technician dispatched for a {a.service_type ?? 'service'} job</span>
                  <button disabled={analyzingId === a.id} onClick={() => run(a.id, () => analyzeTechnicianDispatch(a.id))}
                    className="focus-ring flex items-center gap-1 rounded-lg bg-cta/15 px-3 py-1.5 text-xs font-medium text-cta disabled:opacity-50">
                    <Sparkles size={12} /> Analyze
                  </button>
                </div>
              ))}
              {pendingSchedules.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <span>Job moved from {new Date(s.previous_scheduled_datetime).toLocaleString()} → {new Date(s.new_scheduled_datetime).toLocaleString()}</span>
                  <button disabled={analyzingId === s.id} onClick={() => run(s.id, () => analyzeReschedule(s.id))}
                    className="focus-ring flex items-center gap-1 rounded-lg bg-cta/15 px-3 py-1.5 text-xs font-medium text-cta disabled:opacity-50">
                    <Sparkles size={12} /> Analyze
                  </button>
                </div>
              ))}
              {pendingQuotes.map((q) => (
                <div key={q.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <span>Quote declined without a payment plan — {q.customer_name}</span>
                  <button disabled={analyzingId === q.id} onClick={() => run(q.id, () => analyzeQuoteFinancing(q.id))}
                    className="focus-ring flex items-center gap-1 rounded-lg bg-cta/15 px-3 py-1.5 text-xs font-medium text-cta disabled:opacity-50">
                    <Sparkles size={12} /> Analyze
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-3">
          {library.length === 0 && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-sm text-text-secondary">
              No counterfactuals yet. Analyze a pending decision above once you have some history.
            </div>
          )}
          {library.map((item) => (
            <div key={item.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold text-text-primary">{item.question}</p>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${CONFIDENCE_STYLES[item.confidence]}`}>{item.confidence} confidence</span>
              </div>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-bg-primary p-3 text-xs text-text-secondary">{JSON.stringify(item.estimated_impact, null, 2)}</pre>
            </div>
          ))}
        </div>
      </div>
    </DashboardLayout>
  );
}
