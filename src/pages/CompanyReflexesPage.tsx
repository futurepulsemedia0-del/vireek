/**
 * Company Reflexes Builder — /dashboard/reflexes
 *
 * "If X happens, here's exactly how we respond" — turned into a standing,
 * always-on reflex: event -> context -> policy -> action -> measurement -> learning.
 *
 * Data layer: src/lib/companyReflexes.ts
 */

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, Loader2, Plus, ThumbsDown, ThumbsUp, Trash2, Zap } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  ACTION_LABELS,
  ConditionOperator,
  createReflex,
  ETA_DELAY_FIELDS,
  fetchPendingActions,
  fetchReflexes,
  fetchReflexStats,
  fetchRecentExecutions,
  giveFeedback,
  OPERATOR_LABELS,
  QueueItem,
  Reflex,
  ReflexActionType,
  ReflexExecution,
  ReflexStats,
  ReflexStepInput,
  ReflexTriggerEvent,
  resolveAction,
  setReflexActive,
  TRIGGER_EVENT_LABELS,
} from '@/lib/companyReflexes';

const EMPTY_STEP: ReflexStepInput = { condition_field: '', condition_operator: 'gt', condition_value: '', action_type: 'notify_customer_sms' };

export function CompanyReflexesPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [reflexes, setReflexes] = useState<Reflex[]>([]);
  const [stats, setStats] = useState<ReflexStats[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [executions, setExecutions] = useState<ReflexExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBuilder, setShowBuilder] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [triggerEvent, setTriggerEvent] = useState<ReflexTriggerEvent>('eta_delay');
  const [steps, setSteps] = useState<ReflexStepInput[]>([{ ...EMPTY_STEP }]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [r, s, q, e] = await Promise.all([fetchReflexes(), fetchReflexStats(user.id), fetchPendingActions(), fetchRecentExecutions(20)]);
      setReflexes(r); setStats(s); setQueue(q); setExecutions(e);
    } catch {
      toast('Could not load your reflexes.', 'error');
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => { void load(); }, [load]);

  const updateStep = (i: number, patch: Partial<ReflexStepInput>) => {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };

  const handleSave = async () => {
    if (!name.trim() || steps.length === 0) return;
    setSaving(true);
    try {
      await createReflex(name.trim(), triggerEvent, description.trim(), steps);
      setName(''); setDescription(''); setSteps([{ ...EMPTY_STEP }]);
      setShowBuilder(false);
      toast('Reflex created — it will fire automatically from now on.', 'success');
      await load();
    } catch {
      toast('Could not save this reflex.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (r: Reflex) => {
    setReflexes((prev) => prev.map((x) => (x.id === r.id ? { ...x, is_active: !x.is_active } : x)));
    try {
      await setReflexActive(r.id, !r.is_active);
    } catch {
      toast('Could not update that reflex.', 'error');
      await load();
    }
  };

  const handleResolve = async (id: string, status: 'sent' | 'acknowledged' | 'dismissed') => {
    setQueue((prev) => prev.filter((q) => q.id !== id));
    try {
      await resolveAction(id, status);
    } catch {
      toast('Could not update that action.', 'error');
      await load();
    }
  };

  const handleFeedback = async (id: string, feedback: 'good' | 'bad') => {
    setExecutions((prev) => prev.map((e) => (e.id === id ? { ...e, feedback } : e)));
    try {
      await giveFeedback(id, feedback);
    } catch {
      toast('Could not save your feedback.', 'error');
    }
  };

  if (loading) {
    return <DashboardLayout activeLabel="Company Reflexes"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="Company Reflexes">
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary"><Zap size={18} /> Company Reflexes</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Describe how the company should react once — the reflex fires automatically every time after that.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowBuilder((v) => !v)}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl bg-cta px-3 py-2 text-xs font-medium text-white"
          >
            <Plus size={14} /> New reflex
          </button>
        </div>

        {showBuilder && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border bg-bg-secondary p-4">
            <div className="space-y-2">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder='Reflex name — e.g. "ETA delay escalation"' className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
              <select value={triggerEvent} onChange={(e) => setTriggerEvent(e.target.value as ReflexTriggerEvent)} className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
                {(Object.keys(TRIGGER_EVENT_LABELS) as ReflexTriggerEvent[]).map((t) => <option key={t} value={t}>{TRIGGER_EVENT_LABELS[t]}</option>)}
              </select>

              <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Steps — each runs independently when its condition is true</p>
              {triggerEvent === 'eta_delay' && (
                <p className="text-[11px] text-text-secondary">Available fields for this event: {ETA_DELAY_FIELDS.join(', ')}</p>
              )}

              {steps.map((step, i) => (
                <div key={i} className="grid grid-cols-1 gap-2 rounded-xl border border-border bg-bg-primary p-3 sm:grid-cols-12 sm:items-center">
                  <input
                    value={step.condition_field ?? ''}
                    onChange={(e) => updateStep(i, { condition_field: e.target.value })}
                    placeholder="field (e.g. delay_minutes)"
                    className="rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-xs text-text-primary sm:col-span-3"
                  />
                  <select
                    value={step.condition_operator}
                    onChange={(e) => updateStep(i, { condition_operator: e.target.value as ConditionOperator })}
                    className="rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-xs text-text-primary sm:col-span-3"
                  >
                    {(Object.keys(OPERATOR_LABELS) as ConditionOperator[]).map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
                  </select>
                  <input
                    value={step.condition_value ?? ''}
                    onChange={(e) => updateStep(i, { condition_value: e.target.value })}
                    placeholder="value (e.g. 20)"
                    disabled={step.condition_operator === 'is_true' || step.condition_operator === 'is_false'}
                    className="rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-xs text-text-primary disabled:opacity-30 sm:col-span-2"
                  />
                  <select
                    value={step.action_type}
                    onChange={(e) => updateStep(i, { action_type: e.target.value as ReflexActionType })}
                    className="rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-xs text-text-primary sm:col-span-3"
                  >
                    {(Object.keys(ACTION_LABELS) as ReflexActionType[]).map((a) => <option key={a} value={a}>{ACTION_LABELS[a]}</option>)}
                  </select>
                  <button onClick={() => setSteps((prev) => prev.filter((_, idx) => idx !== i))} className="focus-ring text-text-secondary hover:text-error-500 sm:col-span-1">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}

              <button onClick={() => setSteps((prev) => [...prev, { ...EMPTY_STEP }])} className="focus-ring flex items-center gap-1 text-xs font-medium text-cta">
                <Plus size={13} /> Add another step
              </button>

              <div className="flex justify-end pt-2">
                <button onClick={() => void handleSave()} disabled={saving || !name.trim()} className="focus-ring rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
                  {saving ? 'Saving…' : 'Save reflex'}
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {queue.length > 0 && (
          <div className="rounded-2xl border border-warning-500/40 bg-warning-500/10 p-4">
            <p className="mb-3 text-sm font-semibold text-text-primary">Open actions ({queue.length})</p>
            <div className="space-y-2">
              {queue.map((q) => (
                <div key={q.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="text-text-primary">{ACTION_LABELS[q.action_type]}{q.entity_label ? ` — ${q.entity_label}` : ''}</p>
                    <p className="text-xs text-text-secondary">{new Date(q.created_at).toLocaleString()}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button onClick={() => void handleResolve(q.id, 'acknowledged')} className="focus-ring rounded-lg bg-success-500/15 px-2 py-1 text-xs text-success-500">Done</button>
                    <button onClick={() => void handleResolve(q.id, 'dismissed')} className="focus-ring rounded-lg bg-bg-tertiary px-2 py-1 text-xs text-text-secondary">Dismiss</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-border bg-bg-secondary p-4">
          <p className="mb-3 text-sm font-semibold text-text-primary">Your reflexes ({reflexes.length})</p>
          {reflexes.length === 0 ? (
            <p className="text-sm text-text-secondary">No reflexes yet — build your first one above.</p>
          ) : (
            <div className="space-y-2">
              {reflexes.map((r) => {
                const s = stats.find((x) => x.reflex_id === r.id);
                return (
                  <div key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-text-primary">{r.name}</p>
                      <p className="text-xs text-text-secondary">
                        {TRIGGER_EVENT_LABELS[r.trigger_event]}
                        {s && ` · fired ${s.fire_count}× · ${s.good_count} good / ${s.bad_count} bad`}
                      </p>
                    </div>
                    <button
                      onClick={() => void handleToggleActive(r)}
                      className={`focus-ring shrink-0 rounded-full px-3 py-1 text-xs font-medium ${r.is_active ? 'bg-success-500/15 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}
                    >
                      {r.is_active ? 'Active' : 'Paused'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-bg-secondary p-4">
          <p className="mb-3 text-sm font-semibold text-text-primary">Recent firings</p>
          {executions.length === 0 ? (
            <p className="text-sm text-text-secondary">Nothing has fired yet.</p>
          ) : (
            <div className="space-y-2">
              {executions.map((e) => (
                <div key={e.id} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-text-primary">{e.entity_label ?? e.trigger_event} — {e.steps_fired.length} action{e.steps_fired.length === 1 ? '' : 's'}</p>
                      <p className="text-xs text-text-secondary">{new Date(e.triggered_at).toLocaleString()}</p>
                      <p className="mt-1 text-[11px] text-text-secondary/70">{e.steps_fired.map((sf) => ACTION_LABELS[sf.action_type]).join(', ')}</p>
                    </div>
                    {e.feedback ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-text-secondary"><CheckCircle2 size={13} /> {e.feedback === 'good' ? 'Marked good' : 'Marked bad'}</span>
                    ) : (
                      <div className="flex shrink-0 gap-1">
                        <button onClick={() => void handleFeedback(e.id, 'good')} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-success-500" title="This was the right call"><ThumbsUp size={14} /></button>
                        <button onClick={() => void handleFeedback(e.id, 'bad')} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-error-500" title="This was wrong"><ThumbsDown size={14} /></button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
