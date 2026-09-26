/**
 * Market Intelligence Mesh — /dashboard/market-intelligence
 * Deterministic synthesis of regional demand, industry benchmarks and
 * weather signals into trends, opportunities, risks and demand shifts.
 */

import { useCallback, useEffect, useState } from 'react';
import { Network, Loader2, TrendingUp, TrendingDown, Sparkles, CloudLightning, X, ArrowRightCircle } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { acknowledgeSignal, dismissSignal, fetchMarketSignals, promoteToDecision, type MarketSignal, type SignalType } from '@/lib/marketIntelligence';

const TYPE_STYLE: Record<SignalType, { icon: typeof TrendingUp; className: string }> = {
  demand_shift: { icon: TrendingUp, className: 'text-cta' },
  opportunity: { icon: Sparkles, className: 'text-success-500' },
  risk: { icon: TrendingDown, className: 'text-error-500' },
  trend: { icon: CloudLightning, className: 'text-warning-500' },
};

export function MarketIntelligencePage() {
  const { toast } = useToast();
  const [signals, setSignals] = useState<MarketSignal[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSignals(await fetchMarketSignals('active'));
    } catch {
      toast('Could not load market intelligence.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const handleDismiss = async (id: string) => {
    try { await dismissSignal(id); toast('Dismissed.', 'success'); void load(); }
    catch { toast('Could not dismiss.', 'error'); }
  };

  const handleAcknowledge = async (id: string) => {
    try { await acknowledgeSignal(id); toast('Acknowledged.', 'success'); void load(); }
    catch { toast('Could not acknowledge.', 'error'); }
  };

  const handlePromote = async (id: string) => {
    try { await promoteToDecision(id); toast('Sent to Decision Engine.', 'success'); void load(); }
    catch { toast('Could not promote to a decision.', 'error'); }
  };

  if (loading) {
    return <DashboardLayout activeLabel="Market Intelligence"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="Market Intelligence">
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-2">
          <Network className="text-cta" size={20} />
          <p className="text-sm font-semibold text-text-primary">Market Intelligence Mesh</p>
        </div>

        {signals.length === 0 ? (
          <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-sm text-text-secondary">
            No active market signals right now. This page fills in as regional demand, industry benchmarks and weather data are synthesized.
          </div>
        ) : (
          <div className="space-y-2">
            {signals.map((s) => {
              const { icon: Icon, className } = TYPE_STYLE[s.signal_type];
              return (
                <div key={s.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <Icon size={18} className={`mt-0.5 shrink-0 ${className}`} />
                      <div>
                        <p className="text-sm font-semibold text-text-primary">{s.title}</p>
                        <p className="mt-1 text-sm text-text-secondary">{s.narrative}</p>
                        <p className="mt-2 text-xs text-text-secondary">
                          {s.domain} · {s.signal_type.replace('_', ' ')} · {s.confidence_score}% confidence
                        </p>
                      </div>
                    </div>
                    <button onClick={() => handleDismiss(s.id)} className="focus-ring shrink-0 rounded-lg bg-bg-tertiary p-1.5 text-text-secondary">
                      <X size={14} />
                    </button>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => handlePromote(s.id)} className="focus-ring flex items-center gap-1.5 rounded-lg bg-cta px-3 py-1.5 text-xs font-medium text-white">
                      <ArrowRightCircle size={13} /> Send to Decision Engine
                    </button>
                    <button onClick={() => handleAcknowledge(s.id)} className="focus-ring rounded-lg bg-bg-tertiary px-3 py-1.5 text-xs font-medium text-text-secondary">
                      Acknowledge
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
