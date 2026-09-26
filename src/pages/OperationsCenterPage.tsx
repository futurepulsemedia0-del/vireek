/**
 * Autonomous Operations Center — /dashboard/operations-center
 *
 * End-to-end problem management: Detection -> Root Cause -> Action +
 * Owner -> Execution -> real Outcome. See src/lib/operationsCenter.ts
 * for the stage-transition calls and MTTR math.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Loader2, Plus, Radar, RotateCcw, Trash2, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  assignActionOwner,
  CATEGORY_LABELS,
  computeResolutionHours,
  createOpsProblem,
  deleteOpsProblem,
  fetchOpsProblems,
  OpsCategory,
  OperationalSeverity,
  OpsProblem,
  OUTCOME_LABELS,
  OpsOutcomeStatus,
  recordOutcome,
  recordRootCause,
  reopenProblem,
  SEVERITY_COLORS,
  SEVERITY_LABELS,
  startExecution,
  STATUS_COLORS,
  STATUS_LABELS,
  summarizeOpsCenter,
} from '@/lib/operationsCenter';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';

// ============================================================
// NEW PROBLEM FORM
// ============================================================

function NewProblemForm({ userId, onSaved }: { userId: string; onSaved: () => void }) {
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<OpsCategory>('custom');
  const [severity, setSeverity] = useState<OperationalSeverity>('medium');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!title.trim()) return toast('Give this problem a title', 'error');
    setSaving(true);
    try {
      await createOpsProblem({ title, description, category, severity, source: 'manual', linked_ledger_entry_id: null }, userId);
      toast('Problem logged to the Operations Center', 'success');
      setTitle('');
      setDescription('');
      setCategory('custom');
      setSeverity('medium');
      onSaved();
    } catch {
      toast('Could not save this problem', 'error');
    }
    setSaving(false);
  };

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4">
      <input className={inputClass} placeholder='What went wrong? (e.g. "Dispatch delays spiking in North zone")' value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea className={inputClass} rows={2} placeholder="What was observed? (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Category</label>
          <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value as OpsCategory)}>
            {(Object.keys(CATEGORY_LABELS) as OpsCategory[]).map((c) => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Severity</label>
          <select className={inputClass} value={severity} onChange={(e) => setSeverity(e.target.value as OperationalSeverity)}>
            {(Object.keys(SEVERITY_LABELS) as OperationalSeverity[]).map((s) => (
              <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>
            ))}
          </select>
        </div>
      </div>
      <button
        type="button"
        disabled={saving}
        onClick={() => void handleSave()}
        className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-60"
      >
        {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Log problem
      </button>
    </div>
  );
}

// ============================================================
// PROBLEM CARD
// ============================================================

function ProblemCard({ problem, currentMemberId, onChanged }: { problem: OpsProblem; currentMemberId: string | null; onChanged: () => void }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [rootCause, setRootCause] = useState('');
  const [actionPlan, setActionPlan] = useState('');
  const [outcomeStatus, setOutcomeStatus] = useState<OpsOutcomeStatus>('resolved');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const resolutionHours = useMemo(() => computeResolutionHours(problem), [problem]);

  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    try {
      await fn();
      toast(okMsg, 'success');
      onChanged();
    } catch {
      toast('Could not update this problem', 'error');
    }
    setBusy(false);
  };

  return (
    <div className={`rounded-2xl border p-3 ${problem.status === 'reopened' ? 'border-danger/40 bg-danger/5' : 'border-border bg-bg-secondary'}`}>
      <button type="button" onClick={() => setExpanded((v) => !v)} className="focus-ring flex w-full items-start justify-between gap-3 text-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-text-primary">{problem.title}</span>
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_COLORS[problem.status]}`}>{STATUS_LABELS[problem.status]}</span>
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${SEVERITY_COLORS[problem.severity]}`}>{SEVERITY_LABELS[problem.severity]}</span>
            <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">{CATEGORY_LABELS[problem.category]}</span>
          </div>
          {problem.description && <p className="mt-1 line-clamp-1 text-xs text-text-secondary">{problem.description}</p>}
        </div>
        <div className="shrink-0 text-end">
          {resolutionHours !== null && <p className="text-xs font-medium text-text-secondary">{Math.round(resolutionHours)}h to resolve</p>}
          <ChevronDown size={14} className={`ms-auto mt-1 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {problem.root_cause && <p className="text-xs text-text-secondary"><span className="text-text-primary">Root cause:</span> {problem.root_cause}</p>}
          {problem.action_plan && <p className="text-xs text-text-secondary"><span className="text-text-primary">Action:</span> {problem.action_plan}</p>}

          {problem.status === 'detected' && (
            <div className="space-y-2 rounded-xl bg-bg-tertiary p-2.5">
              <textarea className={inputClass} rows={2} placeholder="What is the root cause?" value={rootCause} onChange={(e) => setRootCause(e.target.value)} />
              <button type="button" disabled={busy || !rootCause.trim()} onClick={() => void run(() => recordRootCause(problem.id, rootCause, 'custom'), 'Root cause recorded')} className="focus-ring rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-60">
                Record root cause
              </button>
            </div>
          )}

          {problem.status === 'root_cause_identified' && (
            <div className="space-y-2 rounded-xl bg-bg-tertiary p-2.5">
              <textarea className={inputClass} rows={2} placeholder="What action will fix this, and who owns it?" value={actionPlan} onChange={(e) => setActionPlan(e.target.value)} />
              <button type="button" disabled={busy || !actionPlan.trim()} onClick={() => void run(() => assignActionOwner(problem.id, actionPlan, currentMemberId), 'Action assigned')} className="focus-ring rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-60">
                Assign action &amp; owner
              </button>
            </div>
          )}

          {problem.status === 'action_assigned' && (
            <button type="button" disabled={busy} onClick={() => void run(() => startExecution(problem.id), 'Execution started')} className="focus-ring rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-60">
              Start execution
            </button>
          )}

          {problem.status === 'in_execution' && (
            <div className="space-y-2 rounded-xl bg-bg-tertiary p-2.5">
              <select className={inputClass} value={outcomeStatus} onChange={(e) => setOutcomeStatus(e.target.value as OpsOutcomeStatus)}>
                {(Object.keys(OUTCOME_LABELS) as OpsOutcomeStatus[]).map((o) => (
                  <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>
                ))}
              </select>
              <textarea className={inputClass} rows={2} placeholder="Outcome notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
              <button type="button" disabled={busy} onClick={() => void run(() => recordOutcome(problem.id, outcomeStatus, notes), 'Outcome recorded')} className="focus-ring rounded-full bg-success-500/10 px-2.5 py-1 text-[11px] font-medium text-success-500 disabled:opacity-60">
                Record real outcome
              </button>
            </div>
          )}

          {problem.status === 'resolved' && (
            <div className="space-y-2">
              {problem.outcome_notes && <p className="text-xs italic text-text-secondary">"{problem.outcome_notes}"</p>}
              <button type="button" disabled={busy} onClick={() => void run(() => reopenProblem(problem.id, 'Recurred after resolution'), 'Reopened')} className="focus-ring flex items-center gap-1 rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium text-text-secondary">
                <RotateCcw size={11} /> Reopen (recurred)
              </button>
            </div>
          )}

          <div>
            <p className="mb-1 text-[11px] font-medium text-text-secondary">Timeline</p>
            <ul className="space-y-1 text-xs text-text-secondary">
              {problem.timeline.map((ev, i) => (
                <li key={i}>
                  <span className="text-text-primary">{STATUS_LABELS[ev.stage as keyof typeof STATUS_LABELS] ?? ev.stage}</span> — {new Date(ev.at).toLocaleString()}
                  {ev.note ? ` · "${ev.note}"` : ''}
                </li>
              ))}
            </ul>
          </div>

          <button type="button" onClick={() => setPendingDelete(true)} className="focus-ring flex items-center gap-1 pt-1 text-xs text-text-secondary hover:text-danger">
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete}
        title="Delete this problem?"
        description={`"${problem.title}" and its full history will be removed permanently.`}
        confirmLabel="Yes, delete it"
        onConfirm={() => void deleteOpsProblem(problem.id).then(() => { setPendingDelete(false); onChanged(); })}
        onCancel={() => setPendingDelete(false)}
      />
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function OperationsCenterPage() {
  const { user } = useAuth();
  const [problems, setProblems] = useState<OpsProblem[]>([]);
  const [currentMemberId, setCurrentMemberId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<'open' | 'all'>('open');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProblems(await fetchOpsProblems());
      if (user) {
        const { data: mine } = await supabase.from('team_members').select('id').eq('member_email', user.email ?? '').maybeSingle();
        setCurrentMemberId((mine as { id: string } | null)?.id ?? null);
      }
    } catch {
      /* empty state covers it */
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => summarizeOpsCenter(problems), [problems]);
  const visible = useMemo(() => (filter === 'open' ? problems.filter((p) => p.status !== 'resolved') : problems), [problems, filter]);

  return (
    <DashboardLayout activeLabel="Operations Center">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Radar size={18} /> Autonomous Operations Center
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Every problem, owned end-to-end: root cause, action, owner, execution, and the real outcome — with automatic reopen if it recurs.
            </p>
          </div>
          <button type="button" onClick={() => setShowForm((v) => !v)} className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white">
            {showForm ? <X size={13} /> : <Plus size={13} />} {showForm ? 'Close' : 'Log problem'}
          </button>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">Critical / high open</p>
            <p className="text-lg font-semibold text-danger">{summary.openBySeverity.critical + summary.openBySeverity.high}</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">In execution</p>
            <p className="text-lg font-semibold text-text-primary">{summary.inExecution}</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">Avg. resolution time</p>
            <p className="text-lg font-semibold text-text-primary">{summary.avgResolutionHours !== null ? `${Math.round(summary.avgResolutionHours)}h` : '—'}</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">Recurred</p>
            <p className={`text-lg font-semibold ${summary.reopenedCount ? 'text-danger' : 'text-text-primary'}`}>{summary.reopenedCount}</p>
          </div>
        </div>

        {showForm && user && (
          <div className="mb-5">
            <NewProblemForm userId={user.id} onSaved={() => { setShowForm(false); void load(); }} />
          </div>
        )}

        <div className="mb-3 flex gap-1.5">
          <button type="button" onClick={() => setFilter('open')} className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${filter === 'open' ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>
            Open
          </button>
          <button type="button" onClick={() => setFilter('all')} className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${filter === 'all' ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>
            All
          </button>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />)}
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center">
            <Radar className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">
              No problems logged. When something breaks, log it here and drive it from root cause to a real, verified outcome.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map((problem) => (
              <motion.div key={problem.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <ProblemCard problem={problem} currentMemberId={currentMemberId} onChanged={() => void load()} />
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
