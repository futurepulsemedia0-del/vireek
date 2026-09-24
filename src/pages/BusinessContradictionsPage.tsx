/**
 * Business Contradiction Detector — /dashboard/contradictions
 * Surfaces decisions that look reasonable in isolation but quietly
 * contradict each other across growth, pricing, marketing, branches,
 * and technicians.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertOctagon, RefreshCw, Check, X, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { fetchContradictions, runDetection, updateContradictionStatus, TYPE_LABELS, type Contradiction } from '@/lib/contradictions';

const SEVERITY_STYLES: Record<Contradiction['severity'], string> = {
  high: 'border-error-500/40 bg-error-500/10 text-error-500',
  medium: 'border-warning-500/40 bg-warning-500/10 text-warning-500',
  low: 'border-border bg-bg-tertiary text-text-secondary',
};

export function BusinessContradictionsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [items, setItems] = useState<Contradiction[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await fetchContradictions('open'));
    } catch {
      toast('Could not load contradictions.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const handleRun = async () => {
    if (!user) return;
    setRunning(true);
    try {
      const count = await runDetection(user.id);
      toast(`Detection complete — ${count} open item(s).`, 'success');
      await load();
    } catch {
      toast('Detection failed.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const handleAction = async (id: string, status: 'acknowledged' | 'dismissed') => {
    try {
      await updateContradictionStatus(id, status);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch {
      toast('Could not update this item.', 'error');
    }
  };

  return (
    <DashboardLayout activeLabel="Business Contradictions">
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertOctagon className="text-warning-500" size={20} />
            <p className="text-sm font-semibold text-text-primary">Business Contradiction Detector</p>
          </div>
          <button onClick={handleRun} disabled={running} className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {running ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} Run detection
          </button>
        </div>

        {loading ? (
          <div className="flex h-40 items-center justify-center"><Loader2 className="animate-spin" /></div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-sm text-text-secondary">
            No contradictions detected. Run detection to check the latest data.
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <div key={item.id} className={`rounded-2xl border p-4 ${SEVERITY_STYLES[item.severity]}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{TYPE_LABELS[item.contradiction_type]}</p>
                    <p className="mt-1 text-sm font-semibold text-text-primary">{item.title}</p>
                    <p className="mt-1 text-sm text-text-secondary">{item.detail}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button onClick={() => handleAction(item.id, 'acknowledged')} className="focus-ring rounded-lg bg-success-500/15 p-2 text-success-500" title="Acknowledge">
                      <Check size={14} />
                    </button>
                    <button onClick={() => handleAction(item.id, 'dismissed')} className="focus-ring rounded-lg bg-bg-tertiary p-2 text-text-secondary" title="Dismiss">
                      <X size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
