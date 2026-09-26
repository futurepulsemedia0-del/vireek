// src/pages/CompoundingFlywheelPage.tsx
//
// Full Compounding Intelligence Flywheel console: the compounding score
// trend, the promotion log (knowledge -> action), and a manual "run now".

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Sparkles, RefreshCcw, ArrowRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase } from '@/lib/supabase';
import { SOURCE_TYPE_LABELS, compoundingScoreLabel, compoundingScoreColor, formatRelativeTime, FlywheelSourceType } from '@/lib/compoundingFlywheel';

interface Snapshot {
  id: string;
  snapshot_date: string;
  total_actions_logged: number;
  total_active_lessons: number;
  avg_lesson_confidence: number;
  promotions_created: number;
  promotions_acted_on: number;
  compounding_score: number;
}

interface Promotion {
  id: string;
  source_type: FlywheelSourceType;
  source_key: string | null;
  detail: string | null;
  next_best_action_id: string | null;
  created_at: string;
}

export function CompoundingFlywheelPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [{ data: snapData }, { data: promoData }] = await Promise.all([
      supabase.from('flywheel_snapshots').select('*').order('snapshot_date', { ascending: false }).limit(12),
      supabase.from('flywheel_promotions').select('*').order('created_at', { ascending: false }).limit(30),
    ]);
    setSnapshots((snapData as Snapshot[]) ?? []);
    setPromotions((promoData as Promotion[]) ?? []);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleRunNow = async () => {
    if (!user) return;
    setRunning(true);
    const { data, error } = await supabase.functions.invoke('flywheel-engine', { body: { single_user_id: user.id } });
    setRunning(false);
    if (error || data?.error) {
      toast(data?.error || 'Could not run the flywheel', 'error');
      return;
    }
    toast(`Flywheel ran — ${data?.totalPromotions ?? 0} new promotion(s)`, 'success');
    fetchAll();
  };

  const latest = snapshots[0];
  const score = latest?.compounding_score ?? 50;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Sparkles size={20} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Compounding Intelligence Flywheel</h1>
              <p className="mt-1 text-sm text-text-secondary">Every confirmed lesson and every recurring, confirmed threat gets turned into a real action — so the business keeps getting smarter and more automated on its own.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleRunNow}
            disabled={running}
            className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
          >
            <RefreshCcw size={14} className={running ? 'animate-spin' : ''} /> {running ? 'Running…' : 'Run flywheel now'}
          </button>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className={`text-xl font-bold ${compoundingScoreColor(score)}`}>{score}</p>
                <p className="text-xs text-text-secondary">{compoundingScoreLabel(score)}</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{latest?.total_active_lessons ?? 0}</p>
                <p className="text-xs text-text-secondary">Active lessons</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-accent">{latest?.avg_lesson_confidence?.toFixed(0) ?? 0}%</p>
                <p className="text-xs text-text-secondary">Avg lesson confidence</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-success-500">{promotions.length}</p>
                <p className="text-xs text-text-secondary">Lessons → actions</p>
              </div>
            </div>

            {snapshots.length > 1 && (
              <div className="mb-6 rounded-2xl border border-border bg-bg-secondary p-4">
                <p className="mb-3 text-xs font-medium text-text-secondary">Score trend (most recent first)</p>
                <div className="flex items-end gap-1.5">
                  {[...snapshots].reverse().map((s) => (
                    <div key={s.id} className="flex flex-1 flex-col items-center gap-1">
                      <div className="w-full rounded-t bg-accent/70" style={{ height: `${Math.max(6, s.compounding_score)}px` }} title={`${s.snapshot_date}: ${s.compounding_score}`} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <p className="mb-3 text-sm font-semibold text-text-primary">Knowledge that became action</p>
            {promotions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                <p className="text-sm text-text-secondary">No promotions yet — the flywheel needs more confirmed lessons and outcomes before it has something to act on.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {promotions.map((p) => (
                  <motion.div key={p.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-border bg-bg-secondary p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium text-text-secondary">{SOURCE_TYPE_LABELS[p.source_type]}</span>
                      <span className="text-[11px] text-text-secondary">{formatRelativeTime(p.created_at)}</span>
                    </div>
                    <p className="mt-2 text-sm text-text-primary">{p.detail}</p>
                    {p.next_best_action_id && (
                      <a href="/dashboard" className="focus-ring mt-2 flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                        View in today's actions <ArrowRight size={12} />
                      </a>
                    )}
                  </motion.div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
