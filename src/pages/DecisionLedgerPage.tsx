/**
 * Decision Ledger — /dashboard/decision-ledger
 *
 * Full record of every decision's life cycle: Recommendation + Evidence
 * -> Approval -> Action -> real measured Outcome. See
 * src/lib/decisionLedger.ts for the stage-transition calls and math.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, ChevronDown, Loader2, Plus, ScrollText, Trash2, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  approveLedgerEntry,
  CATEGORY_LABELS,
  computeOutcomeAccuracy,
  createLedgerEntry,
  DecisionLedgerEntry,
  deleteLedgerEntry,
  fetchLedgerEntries,
  formatDollars,
  LedgerCategory,
  recordLedgerAction,
  recordLedgerOutcome,
  rejectLedgerEntry,
  STATUS_COLORS,
  STATUS_LABELS,
  summarizeLedger,
} from '@/lib/decisionLedger';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';

// ============================================================
// NEW ENTRY FORM
// ============================================================

function NewEntryForm({ userId, onSaved }: { userId: string; onSaved: () => void }) {
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<LedgerCategory>('operations');
  const [recommendation, setRecommendation] = useState('');
  const [evidenceText, setEvidenceText] = useState('');
  const [confidence, setConfidence] = useState('');
  const [expectedImpact, setExpectedImpact] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!title.trim() || !recommendation.trim()) return toast('Title and recommendation are required', 'error');
    setSaving(true);
    try {
      const evidence = evidenceText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => ({ label: line, value: '' }));
      await createLedgerEntry(
        {
          title,
          category,
          source: 'manual',
          recommendation,
          evidence,
          confidence_score: confidence ? Number(confidence) : null,
          expected_impact: expectedImpact ? Number(expectedImpact) : null,
          linked_decision_id: null,
        },
        userId
      );
      toast('Decision logged to the ledger', 'success');
      setTitle('');
      setRecommendation('');
      setEvidenceText('');
      setConfidence('');
      setExpectedImpact('');
      onSaved();
    } catch {
      toast('Could not save this entry', 'error');
    }
    setSaving(false);
  };

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4">
      <input className={inputClass} placeholder="Decision title (e.g. \"Raise emergency-call surcharge 12%\")" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea className={inputClass} rows={2} placeholder="What is being recommended, exactly?" value={recommendation} onChange={(e) => setRecommendation(e.target.value)} />
      <textarea className={inputClass} rows={2} placeholder={'Supporting evidence, one item per line (e.g. "Avg response time up 18% this month")'} value={evidenceText} onChange={(e) => setEvidenceText(e.target.value)} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Category</label>
          <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value as LedgerCategory)}>
            {(Object.keys(CATEGORY_LABELS) as LedgerCategory[]).map((c) => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Confidence % (optional)</label>
          <input className={inputClass} type="number" min="0" max="100" placeholder="0-100" value={confidence} onChange={(e) => setConfidence(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Expected impact $ (optional)</label>
          <input className={inputClass} type="number" step="1" placeholder="0" value={expectedImpact} onChange={(e) => setExpectedImpact(e.target.value)} />
        </div>
      </div>

      <button
        type="button"
        disabled={saving}
        onClick={() => void handleSave()}
        className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-60"
      >
        {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Log to ledger
      </button>
    </div>
  );
}

// ============================================================
// ENTRY CARD
// ============================================================

function EntryCard({ entry, currentMemberId, onChanged }: { entry: DecisionLedgerEntry; currentMemberId: string | null; onChanged: () => void }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [notes, setNotes] = useState('');
  const [actionText, setActionText] = useState('');
  const [outcomeValue, setOutcomeValue] = useState('');
  const [busy, setBusy] = useState(false);
  const accuracy = useMemo(() => computeOutcomeAccuracy(entry), [entry]);

  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    try {
      await fn();
      toast(okMsg, 'success');
      onChanged();
    } catch {
      toast('Could not update this entry', 'error');
    }
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="focus-ring flex w-full items-start justify-between gap-3 text-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-text-primary">{entry.title}</span>
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_COLORS[entry.status]}`}>{STATUS_LABELS[entry.status]}</span>
            <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">{CATEGORY_LABELS[entry.category]}</span>
          </div>
          <p className="mt-1 line-clamp-1 text-xs text-text-secondary">{entry.recommendation}</p>
        </div>
        <div className="shrink-0 text-end">
          {entry.expected_impact !== null && <p className="text-sm font-semibold text-text-primary">{formatDollars(entry.expected_impact)}</p>}
          <ChevronDown size={14} className={`ms-auto mt-1 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <p className="text-xs text-text-secondary">{entry.recommendation}</p>

          {entry.evidence.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-text-secondary">Evidence</p>
              <ul className="list-inside list-disc space-y-0.5 text-xs text-text-secondary">
                {entry.evidence.map((ev, i) => <li key={i}>{ev.label}{ev.value ? `: ${ev.value}` : ''}</li>)}
              </ul>
            </div>
          )}

          {entry.status === 'recommended' && (
            <div className="space-y-2 rounded-xl bg-bg-tertiary p-2.5">
              <textarea className={inputClass} rows={2} placeholder="Approval / rejection notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
              <div className="flex flex-wrap gap-1.5">
                <button type="button" disabled={busy} onClick={() => void run(() => approveLedgerEntry(entry.id, currentMemberId, notes), 'Approved')} className="focus-ring flex items-center gap-1 rounded-full bg-success-500/10 px-2.5 py-1 text-[11px] font-medium text-success-500 disabled:opacity-60">
                  <Check size={11} /> Approve
                </button>
                <button type="button" disabled={busy} onClick={() => void run(() => rejectLedgerEntry(entry.id, notes), 'Rejected')} className="focus-ring rounded-full bg-bg-secondary px-2.5 py-1 text-[11px] font-medium text-text-secondary">
                  Reject
                </button>
              </div>
            </div>
          )}

          {entry.status === 'approved' && (
            <div className="space-y-2 rounded-xl bg-bg-tertiary p-2.5">
              <textarea className={inputClass} rows={2} placeholder="What action was actually taken?" value={actionText} onChange={(e) => setActionText(e.target.value)} />
              <button type="button" disabled={busy || !actionText.trim()} onClick={() => void run(() => recordLedgerAction(entry.id, actionText, currentMemberId), 'Action recorded')} className="focus-ring rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-60">
                Record action taken
              </button>
            </div>
          )}

          {entry.status === 'action_taken' && (
            <div className="space-y-2 rounded-xl bg-bg-tertiary p-2.5">
              <input className={inputClass} type="number" step="1" placeholder="Actual measured outcome ($)" value={outcomeValue} onChange={(e) => setOutcomeValue(e.target.value)} />
              <textarea className={inputClass} rows={2} placeholder="Outcome notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
              <button type="button" disabled={busy || !outcomeValue} onClick={() => void run(() => recordLedgerOutcome(entry.id, Number(outcomeValue), notes), 'Outcome recorded')} className="focus-ring rounded-full bg-success-500/10 px-2.5 py-1 text-[11px] font-medium text-success-500 disabled:opacity-60">
                Record real outcome
              </button>
            </div>
          )}

          {entry.status === 'outcome_recorded' && accuracy.hasOutcome && (
            <div className="rounded-xl bg-bg-tertiary p-2.5 text-xs">
              <p className="text-text-primary">
                Actual: <span className="font-semibold">{formatDollars(entry.actual_outcome_value ?? 0)}</span>
                {entry.expected_impact !== null && accuracy.variance !== null && (
                  <span className={accuracy.wasAccurate ? 'text-success-500' : 'text-danger'}>
                    {' '}({accuracy.variance >= 0 ? '+' : ''}{formatDollars(accuracy.variance)} vs expected)
                  </span>
                )}
              </p>
              {entry.outcome_notes && <p className="mt-1 italic text-text-secondary">"{entry.outcome_notes}"</p>}
            </div>
          )}

          <div>
            <p className="mb-1 text-[11px] font-medium text-text-secondary">Timeline</p>
            <ul className="space-y-1 text-xs text-text-secondary">
              {entry.timeline.map((ev, i) => (
                <li key={i}>
                  <span className="text-text-primary">{STATUS_LABELS[ev.stage] ?? ev.stage}</span> — {new Date(ev.at).toLocaleString()}
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
        title="Delete this ledger entry?"
        description={`"${entry.title}" and its full history will be removed permanently.`}
        confirmLabel="Yes, delete it"
        onConfirm={() => void deleteLedgerEntry(entry.id).then(() => { setPendingDelete(false); onChanged(); })}
        onCancel={() => setPendingDelete(false)}
      />
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function DecisionLedgerPage() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<DecisionLedgerEntry[]>([]);
  const [currentMemberId, setCurrentMemberId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<'open' | 'all'>('open');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await fetchLedgerEntries());
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

  const summary = useMemo(() => summarizeLedger(entries), [entries]);
  const visible = useMemo(
    () => (filter === 'open' ? entries.filter((e) => e.status !== 'rejected' && e.status !== 'outcome_recorded' && e.status !== 'expired') : entries),
    [entries, filter]
  );

  return (
    <DashboardLayout activeLabel="Decision Ledger">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <ScrollText size={18} /> Decision Ledger
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              The full record of every decision: recommendation and evidence, who approved it, what action was taken, and what actually happened.
            </p>
          </div>
          <button type="button" onClick={() => setShowForm((v) => !v)} className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white">
            {showForm ? <X size={13} /> : <Plus size={13} />} {showForm ? 'Close' : 'Log decision'}
          </button>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">Awaiting approval</p>
            <p className="text-lg font-semibold text-warning-500">{summary.awaitingApproval}</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">Awaiting outcome</p>
            <p className="text-lg font-semibold text-text-primary">{summary.awaitingAction + summary.awaitingOutcome}</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">Outcomes recorded</p>
            <p className="text-lg font-semibold text-text-primary">{summary.outcomeRecorded}</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">Avg. forecast accuracy</p>
            <p className="text-lg font-semibold text-text-primary">{summary.avgAccuracyPct !== null ? `${Math.round(summary.avgAccuracyPct)}%` : '—'}</p>
          </div>
        </div>

        {showForm && user && (
          <div className="mb-5">
            <NewEntryForm userId={user.id} onSaved={() => { setShowForm(false); void load(); }} />
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
            <ScrollText className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">
              No decisions logged yet. Every recommendation, approval, action and real outcome you log here builds a permanent, auditable record.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map((entry) => (
              <motion.div key={entry.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <EntryCard entry={entry} currentMemberId={currentMemberId} onChanged={() => void load()} />
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
