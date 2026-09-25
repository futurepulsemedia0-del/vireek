/**
 * Decision Debt System — /dashboard/decision-debt
 *
 * Identifies stalled or abandoned decisions and actions, then turns
 * the delay into a running dollar figure and operational-severity
 * score — so "we'll get to it" has a visible price tag. See
 * src/lib/decisionDebt.ts for the accrual math.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Check, ChevronDown, Hourglass, Loader2, Plus, Trash2, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  CATEGORY_LABELS,
  computeAccrual,
  createDebtItem,
  DebtCategory,
  DebtStatus,
  DecisionDebtItem,
  deleteDebtItem,
  fetchDebtItems,
  formatDollars,
  OperationalSeverity,
  SEVERITY_COLORS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  summarizePortfolio,
  updateDebtStatus,
} from '@/lib/decisionDebt';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';

// ============================================================
// NEW ITEM FORM
// ============================================================

function NewDebtItemForm({ userId, onSaved }: { userId: string; onSaved: () => void }) {
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<DebtCategory>('custom');
  const [severity, setSeverity] = useState<OperationalSeverity>('medium');
  const [dailyCost, setDailyCost] = useState('');
  const [needBy, setNeedBy] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!title.trim()) return toast('Give this stalled decision a title', 'error');
    setSaving(true);
    try {
      await createDebtItem(
        {
          title,
          description,
          category,
          operational_severity: severity,
          daily_financial_cost: Number(dailyCost) || 0,
          decision_needed_by: needBy || null,
          linked_decision_id: null,
        },
        userId
      );
      toast('Debt item logged', 'success');
      setTitle('');
      setDescription('');
      setCategory('custom');
      setSeverity('medium');
      setDailyCost('');
      setNeedBy('');
      onSaved();
    } catch {
      toast('Could not save this item', 'error');
    }
    setSaving(false);
  };

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4">
      <input className={inputClass} placeholder="What decision or action has stalled? (e.g. \"Finalize overtime discount policy\")" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea className={inputClass} rows={2} placeholder="What's actually blocked because this hasn't been decided? (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Category</label>
          <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value as DebtCategory)}>
            {(Object.keys(CATEGORY_LABELS) as DebtCategory[]).map((c) => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Operational severity</label>
          <select className={inputClass} value={severity} onChange={(e) => setSeverity(e.target.value as OperationalSeverity)}>
            {(Object.keys(SEVERITY_LABELS) as OperationalSeverity[]).map((s) => (
              <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Cost per day ($)</label>
          <input className={inputClass} type="number" min="0" step="1" placeholder="0" value={dailyCost} onChange={(e) => setDailyCost(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Needed by (optional)</label>
          <input className={inputClass} type="date" value={needBy} onChange={(e) => setNeedBy(e.target.value)} />
        </div>
      </div>

      <button
        type="button"
        disabled={saving}
        onClick={() => void handleSave()}
        className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-60"
      >
        {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Log it
      </button>
    </div>
  );
}

// ============================================================
// ITEM CARD
// ============================================================

function DebtItemCard({ item, onChanged }: { item: DecisionDebtItem; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const accrual = useMemo(() => computeAccrual(item), [item]);
  const closed = item.status === 'resolved' || item.status === 'abandoned';

  const setStatus = async (status: DebtStatus) => {
    await updateDebtStatus(item.id, status);
    onChanged();
  };

  return (
    <div className={`rounded-2xl border p-3 ${accrual.isOverdue ? 'border-danger/40 bg-danger/5' : 'border-border bg-bg-secondary'}`}>
      <button type="button" onClick={() => setExpanded((v) => !v)} className="focus-ring flex w-full items-start justify-between gap-3 text-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-text-primary">{item.title}</span>
            {accrual.isOverdue && (
              <span className="flex items-center gap-0.5 rounded-full bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">
                <AlertTriangle size={10} /> {accrual.daysOverdue}d overdue
              </span>
            )}
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${SEVERITY_COLORS[item.operational_severity]}`}>
              {SEVERITY_LABELS[item.operational_severity]}
            </span>
            <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
              {CATEGORY_LABELS[item.category]}
            </span>
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            {accrual.daysOutstanding} days outstanding{closed ? ' (closed)' : ''} · {STATUS_LABELS[item.status]}
          </p>
        </div>
        <div className="shrink-0 text-end">
          <p className={`text-sm font-semibold ${closed ? 'text-text-secondary' : 'text-danger'}`}>{formatDollars(accrual.accruedFinancialDebt)}</p>
          <ChevronDown size={14} className={`ms-auto mt-1 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {expanded && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {item.description && <p className="text-xs text-text-secondary">{item.description}</p>}
          <p className="text-xs text-text-secondary">
            Identified {new Date(item.identified_at).toLocaleDateString()}
            {item.decision_needed_by && ` · needed by ${new Date(`${item.decision_needed_by}T00:00:00`).toLocaleDateString()}`}
          </p>
          {item.resolution_notes && <p className="text-xs italic text-text-secondary">"{item.resolution_notes}"</p>}

          {!closed && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {item.status === 'open' && (
                <button type="button" onClick={() => void setStatus('in_progress')} className="focus-ring rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium text-text-primary">
                  Mark in progress
                </button>
              )}
              <button type="button" onClick={() => void setStatus('resolved')} className="focus-ring flex items-center gap-1 rounded-full bg-success-500/10 px-2.5 py-1 text-[11px] font-medium text-success-500">
                <Check size={11} /> Resolved
              </button>
              <button type="button" onClick={() => void setStatus('abandoned')} className="focus-ring rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium text-text-secondary">
                Abandon
              </button>
            </div>
          )}

          <button type="button" onClick={() => setPendingDelete(true)} className="focus-ring flex items-center gap-1 pt-1 text-xs text-text-secondary hover:text-danger">
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete}
        title="Delete this debt item?"
        description={`"${item.title}" will be removed permanently.`}
        confirmLabel="Yes, delete it"
        onConfirm={() => void deleteDebtItem(item.id).then(() => { setPendingDelete(false); onChanged(); })}
        onCancel={() => setPendingDelete(false)}
      />
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function DecisionDebtPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<DecisionDebtItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<'outstanding' | 'all'>('outstanding');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await fetchDebtItems());
    } catch {
      /* empty state covers it */
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => summarizePortfolio(items), [items]);
  const visible = useMemo(() => {
    const list = filter === 'outstanding' ? items.filter((i) => i.status === 'open' || i.status === 'in_progress') : items;
    return [...list].sort((a, b) => computeAccrual(b).accruedFinancialDebt - computeAccrual(a).accruedFinancialDebt);
  }, [items, filter]);

  return (
    <DashboardLayout activeLabel="Decision Debt">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Hourglass size={18} /> Decision Debt System
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Every stalled decision or abandoned action keeps costing you, quietly. Log it here and watch the price of waiting add up.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white"
          >
            {showForm ? <X size={13} /> : <Plus size={13} />} {showForm ? 'Close' : 'Log stalled item'}
          </button>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">Total debt (financial)</p>
            <p className="text-lg font-semibold text-danger">{formatDollars(summary.totalAccruedFinancialDebt)}</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">Operational debt score</p>
            <p className="text-lg font-semibold text-text-primary">{summary.totalAccruedOperationalDebt.toLocaleString('en-US')}</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">Outstanding items</p>
            <p className="text-lg font-semibold text-text-primary">{summary.totalOutstandingItems}</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">Overdue</p>
            <p className={`text-lg font-semibold ${summary.overdueCount ? 'text-danger' : 'text-text-primary'}`}>{summary.overdueCount}</p>
          </div>
        </div>

        {showForm && user && (
          <div className="mb-5">
            <NewDebtItemForm userId={user.id} onSaved={() => { setShowForm(false); void load(); }} />
          </div>
        )}

        <div className="mb-3 flex gap-1.5">
          <button
            type="button"
            onClick={() => setFilter('outstanding')}
            className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${filter === 'outstanding' ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
          >
            Outstanding
          </button>
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${filter === 'all' ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
          >
            All
          </button>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />)}
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center">
            <Hourglass className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">
              No stalled decisions logged. Next time something keeps getting pushed to "next week," log it here and let the cost of waiting speak for itself.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map((item) => (
              <motion.div key={item.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <DebtItemCard item={item} onChanged={() => void load()} />
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
