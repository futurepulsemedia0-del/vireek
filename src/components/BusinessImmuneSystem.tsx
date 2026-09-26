// src/components/BusinessImmuneSystem.tsx
//
// Compact "health" widget for the Analytics dashboard, mirroring the
// existing ServiceRecoveryIntelligence widget's shape and placement.

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Siren, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { supabase, BusinessImmuneSignal } from '@/lib/supabase';
import { isOpenImmuneSignal, severityLabel, immuneHealthScore, CATEGORY_LABELS } from '@/lib/businessImmuneSystem';

export function BusinessImmuneSystem() {
  const { user } = useAuth();
  const [signals, setSignals] = useState<BusinessImmuneSignal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from('business_immune_signals')
        .select('*')
        .in('status', ['active', 'acknowledged', 'contained'])
        .order('severity_score', { ascending: false })
        .limit(50);
      setSignals((data as BusinessImmuneSignal[]) ?? []);
      setLoading(false);
    })();
  }, [user]);

  if (loading) {
    return <div className="h-32 animate-pulse rounded-2xl bg-bg-tertiary" />;
  }

  const active = signals.filter((s) => isOpenImmuneSignal(s.status));
  const health = immuneHealthScore(active);
  const critical = active.filter((s) => severityLabel(s.severity_score) === 'critical').length;
  const byCategory = active.reduce<Record<string, number>>((acc, s) => {
    acc[s.category] = (acc[s.category] ?? 0) + 1;
    return acc;
  }, {});

  const healthColor = health >= 80 ? 'text-success-500' : health >= 50 ? 'text-warning-500' : 'text-danger';
  const iconBg = health >= 80 ? 'bg-success-500/10 text-success-500' : health >= 50 ? 'bg-warning-500/10 text-warning-500' : 'bg-danger/10 text-danger';

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${iconBg}`}>
            <Siren size={20} />
          </span>
          <div>
            <p className="text-sm font-semibold text-text-primary">Business Immune System</p>
            <p className="text-xs text-text-secondary">
              {active.length === 0 ? 'No active threats — business is healthy.' : `${active.length} active threat${active.length === 1 ? '' : 's'}${critical ? `, ${critical} critical` : ''}.`}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className={`text-2xl font-bold ${healthColor}`}>{health}</p>
          <p className="text-[11px] text-text-secondary">Health score</p>
        </div>
      </div>

      {active.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {Object.entries(byCategory).map(([cat, count]) => (
            <span key={cat} className="rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium text-text-secondary">
              {CATEGORY_LABELS[cat as keyof typeof CATEGORY_LABELS] ?? cat} · {count}
            </span>
          ))}
        </div>
      )}

      <Link to="/dashboard/immune-system" className="focus-ring mt-4 flex items-center gap-1 text-xs font-medium text-accent hover:underline">
        Open Business Immune System <ArrowRight size={12} />
      </Link>
    </motion.div>
  );
}
