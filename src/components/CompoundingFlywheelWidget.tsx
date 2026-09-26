// src/components/CompoundingFlywheelWidget.tsx
//
// Compact widget for the Analytics dashboard — the "is the business
// getting smarter" gauge, mirroring BusinessImmuneSystem's widget shape.

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Sparkles, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { compoundingScoreLabel, compoundingScoreColor } from '@/lib/compoundingFlywheel';

interface Snapshot {
  compounding_score: number;
  total_active_lessons: number;
  promotions_created: number;
}

export function CompoundingFlywheelWidget() {
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from('flywheel_snapshots')
        .select('compounding_score, total_active_lessons, promotions_created')
        .order('snapshot_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      setSnapshot((data as Snapshot) ?? null);
      setLoading(false);
    })();
  }, [user]);

  if (loading) {
    return <div className="h-32 animate-pulse rounded-2xl bg-bg-tertiary" />;
  }

  const score = snapshot?.compounding_score ?? 50;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Sparkles size={20} />
          </span>
          <div>
            <p className="text-sm font-semibold text-text-primary">Compounding Intelligence Flywheel</p>
            <p className="text-xs text-text-secondary">
              {snapshot
                ? `${snapshot.total_active_lessons} active lesson${snapshot.total_active_lessons === 1 ? '' : 's'}, ${snapshot.promotions_created} promoted to action recently.`
                : 'No snapshot yet — the flywheel hasn\'t run for this account.'}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className={`text-2xl font-bold ${compoundingScoreColor(score)}`}>{score}</p>
          <p className="text-[11px] text-text-secondary">{compoundingScoreLabel(score)}</p>
        </div>
      </div>

      <Link to="/dashboard/flywheel" className="focus-ring mt-4 flex items-center gap-1 text-xs font-medium text-accent hover:underline">
        Open the Flywheel <ArrowRight size={12} />
      </Link>
    </motion.div>
  );
}
