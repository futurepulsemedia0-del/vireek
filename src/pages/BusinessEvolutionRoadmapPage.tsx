/**
 * Business Evolution Roadmap — /dashboard/roadmap
 *
 * Turns one 12-month goal into a trackable quarterly roadmap across the
 * seven levers that determine whether growth is actually buildable:
 * organizational capability, capacity, data & systems, process maturity,
 * technician skill, cash buffer, and customer mix.
 *
 * Data layer: src/lib/businessRoadmap.ts
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Compass, Loader2, Plus, RefreshCw, Target, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  addCustomMilestone,
  DIMENSION_LABELS,
  DimensionScore,
  deleteMilestone,
  fetchActiveGoal,
  fetchDimensionScores,
  fetchMilestones,
  RoadmapDimension,
  RoadmapGoal,
  RoadmapMilestone,
  setActiveGoal,
  STATUS_COLORS,
  STATUS_LABELS,
  MilestoneStatus,
  updateMilestoneStatus,
} from '@/lib/businessRoadmap';

const DIMENSIONS = Object.keys(DIMENSION_LABELS) as RoadmapDimension[];
const STATUSES: MilestoneStatus[] = ['not_started', 'in_progress', 'done', 'at_risk', 'blocked'];

function scoreTone(score: number): string {
  if (score >= 80) return 'text-success-500';
  if (score >= 50) return 'text-warning-500';
  return 'text-danger';
}

export function BusinessEvolutionRoadmapPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [goal, setGoal] = useState<RoadmapGoal | null>(null);
  const [milestones, setMilestones] = useState<RoadmapMilestone[]>([]);
  const [scores, setScores] = useState<DimensionScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [quarter, setQuarter] = useState<1 | 2 | 3 | 4>(1);
  const [goalTitle, setGoalTitle] = useState('');
  const [goalMetric, setGoalMetric] = useState('');
  const [savingGoal, setSavingGoal] = useState(false);
  const [newMilestoneText, setNewMilestoneText] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const g = await fetchActiveGoal();
      setGoal(g);
      if (g) {
        const [m, s] = await Promise.all([fetchMilestones(g.id), fetchDimensionScores(user.id)]);
        setMilestones(m);
        setScores(s);
      } else {
        setMilestones([]);
        setScores([]);
      }
    } catch {
      toast('Could not load the roadmap.', 'error');
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => { void load(); }, [load]);

  const overallScore = useMemo(() => {
    if (scores.length === 0) return 0;
    return Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length);
  }, [scores]);

  const scoreByDimension = useMemo(() => {
    const map: Partial<Record<RoadmapDimension, DimensionScore>> = {};
    scores.forEach((s) => { map[s.dimension] = s; });
    return map;
  }, [scores]);

  const milestonesByDimension = useMemo(() => {
    const map: Record<string, RoadmapMilestone[]> = {};
    DIMENSIONS.forEach((d) => { map[d] = []; });
    milestones.filter((m) => m.quarter === quarter).forEach((m) => { map[m.dimension]?.push(m); });
    return map;
  }, [milestones, quarter]);

  const handleCreateGoal = async () => {
    if (!goalTitle.trim()) return;
    setSavingGoal(true);
    try {
      await setActiveGoal(goalTitle.trim(), goalMetric.trim() || undefined, 12);
      setGoalTitle('');
      setGoalMetric('');
      toast('Roadmap created for your goal.', 'success');
      await load();
    } catch {
      toast('Could not create the roadmap.', 'error');
    } finally {
      setSavingGoal(false);
    }
  };

  const handleStatusChange = async (id: string, status: MilestoneStatus) => {
    setMilestones((prev) => prev.map((m) => (m.id === id ? { ...m, status } : m)));
    try {
      await updateMilestoneStatus(id, status);
      if (user) setScores(await fetchDimensionScores(user.id));
    } catch {
      toast('Could not update that milestone.', 'error');
      await load();
    }
  };

  const handleAddMilestone = async (dimension: RoadmapDimension) => {
    const text = (newMilestoneText[dimension] ?? '').trim();
    if (!text || !goal || !user) return;
    try {
      await addCustomMilestone(goal.id, user.id, dimension, quarter, text);
      setNewMilestoneText((prev) => ({ ...prev, [dimension]: '' }));
      await load();
    } catch {
      toast('Could not add that milestone.', 'error');
    }
  };

  const handleDelete = async (id: string) => {
    setMilestones((prev) => prev.filter((m) => m.id !== id));
    try {
      await deleteMilestone(id);
    } catch {
      toast('Could not remove that milestone.', 'error');
      await load();
    }
  };

  if (loading) {
    return (
      <DashboardLayout activeLabel="Evolution Roadmap">
        <div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Evolution Roadmap">
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Compass size={18} /> Business Evolution Roadmap
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              What has to be built — organizationally, operationally, financially — to actually reach your 12-month goal.
            </p>
          </div>
          {goal && (
            <button
              type="button"
              onClick={() => void load()}
              className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary"
            >
              <RefreshCw size={13} /> Refresh
            </button>
          )}
        </div>

        {!goal ? (
          <div className="rounded-2xl border border-dashed border-border p-6">
            <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary"><Target size={16} /> Set your 12-month goal</p>
            <div className="space-y-2">
              <input
                value={goalTitle}
                onChange={(e) => setGoalTitle(e.target.value)}
                placeholder='e.g. "Reach $2M revenue in 12 months"'
                className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
              />
              <input
                value={goalMetric}
                onChange={(e) => setGoalMetric(e.target.value)}
                placeholder="Target metric (optional) — e.g. 40% recurring revenue"
                className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
              />
              <button
                type="button"
                onClick={() => void handleCreateGoal()}
                disabled={savingGoal || !goalTitle.trim()}
                className="focus-ring rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                {savingGoal ? 'Building roadmap…' : 'Build my roadmap'}
              </button>
            </div>
            <p className="mt-3 text-xs text-text-secondary">
              This seeds a 4-quarter roadmap across 7 dimensions — every milestone is yours to edit, complete, or delete afterward.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-4">
              <div className={`text-4xl font-bold ${scoreTone(overallScore)}`}>{overallScore}</div>
              <div>
                <p className="text-sm font-medium text-text-primary">{goal.title}</p>
                <p className="text-xs text-text-secondary">
                  {goal.target_metric ? `${goal.target_metric} · ` : ''}{goal.horizon_months}-month horizon · roadmap readiness score
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              {([1, 2, 3, 4] as const).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setQuarter(q)}
                  className={`focus-ring rounded-xl px-4 py-2 text-sm font-medium ${quarter === q ? 'bg-cta text-white' : 'border border-border text-text-secondary hover:text-text-primary'}`}
                >
                  Q{q}
                </button>
              ))}
            </div>

            <div className="space-y-4">
              {DIMENSIONS.map((dim) => {
                const items = milestonesByDimension[dim] ?? [];
                const s = scoreByDimension[dim];
                return (
                  <div key={dim} className="rounded-2xl border border-border bg-bg-secondary p-4">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-text-primary">{DIMENSION_LABELS[dim]}</p>
                      {s && <span className={`text-xs font-medium ${scoreTone(s.score)}`}>{s.score} · {s.done_count}/{s.total_count} done{s.at_risk_count > 0 ? ` · ${s.at_risk_count} overdue` : ''}</span>}
                    </div>

                    {items.length === 0 ? (
                      <p className="mb-2 text-xs text-text-secondary">No milestones in this quarter yet.</p>
                    ) : (
                      <div className="mb-3 space-y-2">
                        {items.map((m) => (
                          <motion.div key={m.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-border bg-bg-primary p-3">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="text-sm text-text-primary">{m.title}</p>
                                {m.description && <p className="mt-0.5 text-xs text-text-secondary">{m.description}</p>}
                                {m.success_metric && <p className="mt-1 text-[11px] text-text-secondary/70">Success: {m.success_metric}</p>}
                              </div>
                              <button onClick={() => void handleDelete(m.id)} className="focus-ring shrink-0 rounded-lg p-1.5 text-text-secondary hover:text-error-500" title="Remove">
                                <Trash2 size={13} />
                              </button>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1">
                              {STATUSES.map((st) => (
                                <button
                                  key={st}
                                  type="button"
                                  onClick={() => void handleStatusChange(m.id, st)}
                                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${m.status === st ? STATUS_COLORS[st] : 'text-text-secondary hover:bg-bg-tertiary'}`}
                                >
                                  {STATUS_LABELS[st]}
                                </button>
                              ))}
                            </div>
                          </motion.div>
                        ))}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <input
                        value={newMilestoneText[dim] ?? ''}
                        onChange={(e) => setNewMilestoneText((prev) => ({ ...prev, [dim]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') void handleAddMilestone(dim); }}
                        placeholder={`Add a Q${quarter} milestone…`}
                        className="w-full rounded-xl border border-border bg-bg-primary px-3 py-1.5 text-xs text-text-primary"
                      />
                      <button onClick={() => void handleAddMilestone(dim)} className="focus-ring shrink-0 rounded-xl border border-border p-1.5 text-text-secondary hover:text-text-primary">
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
