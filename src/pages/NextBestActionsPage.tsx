import { useCallback, useEffect, useState } from 'react';
import { Target, RefreshCw, CircleCheck as CheckCircle, X, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  CATEGORY_META, fetchTodayActions, generateNextBestActions, updateActionStatus, type NextBestAction,
} from '@/lib/nextBestActions';

export function NextBestActionsPage() {
  const { toast } = useToast();
  const [actions, setActions] = useState<NextBestAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchTodayActions();
      setActions(rows);
      if (rows.length === 0) {
        // Nothing generated for today yet — run it once automatically.
        setRefreshing(true);
        const { actions: fresh } = await generateNextBestActions();
        setActions(fresh);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load next best actions.', 'error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const { actions: fresh, generated } = await generateNextBestActions();
      setActions(fresh);
      toast(generated > 0 ? `Ranked ${generated} action(s) for today.` : 'Nothing urgent right now — you\u2019re clear.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not refresh.', 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const resolve = async (id: string, status: 'done' | 'dismissed') => {
    setActions((prev) => prev.filter((a) => a.id !== id));
    try {
      await updateActionStatus(id, status);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update this action.', 'error');
      load();
    }
  };

  const open = actions.filter((a) => a.status === 'open');

  return (
    <DashboardLayout activeLabel="Next Best Actions">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Target size={24} /></span>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Next Best Actions</h1>
            <p className="text-sm text-text-secondary">Today's highest-impact revenue and operational moves, ranked automatically.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="focus-ring flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Ranking…' : 'Refresh'}
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : open.length === 0 ? (
        <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
          <p className="text-sm text-text-secondary">Nothing urgent right now — every estimate, invoice, customer and day of capacity looks healthy.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {open.map((a) => (
            <div key={a.id} className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${CATEGORY_META[a.category].className}`}>
                      {CATEGORY_META[a.category].label}
                    </span>
                    {a.amount_label && <span className="text-xs font-semibold text-text-primary">{a.amount_label}</span>}
                    <span className="text-xs text-text-secondary">Priority {a.priority_score}</span>
                  </div>
                  <h3 className="mt-1.5 text-sm font-semibold text-text-primary">{a.title}</h3>
                  <p className="mt-1 text-sm text-text-secondary">{a.reasoning}</p>
                  <p className="mt-1.5 text-xs font-medium text-accent">→ {a.recommended_action}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  {a.cta_href && (
                    <Link to={a.cta_href} className="focus-ring flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white">
                      Open <ArrowRight size={12} />
                    </Link>
                  )}
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => resolve(a.id, 'done')} title="Mark done" className="focus-ring rounded-lg border border-border p-1.5 text-text-secondary hover:text-success-500">
                      <CheckCircle size={14} />
                    </button>
                    <button type="button" onClick={() => resolve(a.id, 'dismissed')} title="Dismiss" className="focus-ring rounded-lg border border-border p-1.5 text-text-secondary hover:text-danger-500">
                      <X size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
}
