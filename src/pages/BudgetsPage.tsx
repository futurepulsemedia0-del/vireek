/**
 * Budgets — /dashboard/budgets
 * Monthly budgets per expense category, compared against the posted general
 * ledger (Accounting). Shows variance, a trailing trend, and raises in-app
 * notifications the first time a category nears or exceeds its budget.
 * View needs can_view_billing; editing needs owner or can_edit_business_profile.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  Lock,
  Pencil,
  Plus,
  Trash2,
  Wallet,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FadeIn, SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { ensureChartOfAccounts, fetchChartOfAccounts, formatCents, type ChartOfAccount } from '@/lib/accounting';
import {
  STATUS_LABEL,
  alertRows,
  centsToDollarsInput,
  copyBudgetsFromPreviousMonth,
  deleteBudget,
  dollarsToCents,
  fetchBudgetTrend,
  fetchBudgetVariance,
  monthLabel,
  monthStart,
  shiftMonth,
  summarizeBudgets,
  syncBudgetAlerts,
  upsertBudget,
  type BudgetStatus,
  type BudgetTrendPoint,
  type BudgetVarianceRow,
} from '@/lib/budgets';

const MAX_MONTHS_AHEAD = 12;

const BAR_COLOR: Record<BudgetStatus, string> = {
  on_track: 'bg-success-500',
  warning: 'bg-warning-500',
  over: 'bg-danger',
  unbudgeted: 'bg-text-secondary',
};
const BADGE_COLOR: Record<BudgetStatus, string> = {
  on_track: 'bg-success-500/10 text-success-500',
  warning: 'bg-warning-500/10 text-warning-500',
  over: 'bg-danger/10 text-danger',
  unbudgeted: 'bg-bg-tertiary text-text-secondary',
};

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary disabled:opacity-60';

interface EditorState {
  budgetId: string | null;
  accountId: string;
  amount: string;
  warnAt: string;
  notes: string;
}

const EMPTY_EDITOR: EditorState = { budgetId: null, accountId: '', amount: '', warnAt: '80', notes: '' };

function StatusBadge({ status }: { status: BudgetStatus }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${BADGE_COLOR[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function UsageBar({ row }: { row: BudgetVarianceRow }) {
  if (row.status === 'unbudgeted') return <span className="text-xs text-text-secondary">—</span>;
  const pct = row.pct_used ?? (row.actual_cents > 0 ? 100 : 0);
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-label={`${row.account_name} budget used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(Math.round(pct), 100)}
        className="h-2 w-full min-w-[72px] overflow-hidden rounded-full bg-bg-tertiary"
      >
        <div className={`h-full rounded-full ${BAR_COLOR[row.status]}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-text-secondary">
        {row.pct_used === null ? '—' : `${Math.round(row.pct_used)}%`}
      </span>
    </div>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'bad' }) {
  return (
    <Card className="p-4 sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums sm:text-2xl ${tone === 'bad' ? 'text-danger' : tone === 'good' ? 'text-success-500' : 'text-text-primary'}`}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </Card>
  );
}

function TrendChart({ points }: { points: BudgetTrendPoint[] }) {
  const max = Math.max(1, ...points.flatMap((p) => [p.budget_cents, p.actual_cents]));
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Budget vs actual — last {points.length} months</h2>
        <div className="flex items-center gap-3 text-xs text-text-secondary">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-border" /> Budget</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-accent" /> Actual</span>
        </div>
      </div>
      <div className="flex h-32 items-end gap-2 sm:gap-4" role="img" aria-label="Monthly budget versus actual spend">
        {points.map((p) => (
          <div key={p.period_month} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <div
              className="flex h-24 w-full items-end justify-center gap-1"
              title={`${monthLabel(p.period_month)}: budget ${formatCents(p.budget_cents)}, actual ${formatCents(p.actual_cents)}`}
            >
              <div className="w-1/2 max-w-[20px] rounded-t bg-border" style={{ height: `${(p.budget_cents / max) * 100}%` }} />
              <div
                className={`w-1/2 max-w-[20px] rounded-t ${p.budget_cents > 0 && p.actual_cents > p.budget_cents ? 'bg-danger' : 'bg-accent'}`}
                style={{ height: `${(p.actual_cents / max) * 100}%` }}
              />
            </div>
            <span className="truncate text-[11px] text-text-secondary">{monthLabel(p.period_month, 'short').split(' ')[0]}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function BudgetsPage() {
  const navigate = useNavigate();
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canView = isOwner || permissions.can_view_billing;
  const canEdit = isOwner || (permissions.can_view_billing && permissions.can_edit_business_profile);

  const currentMonth = useMemo(() => monthStart(), []);
  const maxMonth = useMemo(() => shiftMonth(currentMonth, MAX_MONTHS_AHEAD), [currentMonth]);
  const [month, setMonth] = useState(currentMonth);
  const [rows, setRows] = useState<BudgetVarianceRow[]>([]);
  const [trend, setTrend] = useState<BudgetTrendPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<ChartOfAccount[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<BudgetVarianceRow | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!user || !canView) return;
    const id = ++requestId.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const [v, t] = await Promise.all([fetchBudgetVariance(month), fetchBudgetTrend(month, 6)]);
      if (id !== requestId.current) return; // a newer month was requested
      setRows(v);
      setTrend(t);
      if (month === currentMonth) void syncBudgetAlerts(month);
    } catch {
      if (id === requestId.current) setLoadFailed(true);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [user, canView, month, currentMonth]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (editor) editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [editor]);

  const summary = useMemo(() => summarizeBudgets(rows), [rows]);
  const alerts = useMemo(() => alertRows(rows), [rows]);
  const budgetedRows = rows.filter((r) => r.status !== 'unbudgeted');
  const unbudgetedRows = rows.filter((r) => r.status === 'unbudgeted');
  const budgetedIds = useMemo(() => new Set(rows.filter((r) => r.status !== 'unbudgeted').map((r) => r.account_id)), [rows]);

  const openEditor = useCallback(
    async (state: EditorState) => {
      setEditorError(null);
      setEditor(state);
      if (accounts.length > 0) return;
      try {
        await ensureChartOfAccounts();
        setAccounts(await fetchChartOfAccounts());
      } catch {
        toast('Could not load expense categories. Please try again.', 'error');
        setEditor(null);
      }
    },
    [accounts.length, toast],
  );

  const expenseAccounts = useMemo(
    () => accounts.filter((a) => a.type === 'expense' && (a.id === editor?.accountId || !budgetedIds.has(a.id))),
    [accounts, budgetedIds, editor?.accountId],
  );

  const handleSave = async () => {
    if (!editor) return;
    const cents = dollarsToCents(editor.amount);
    const warn = Number(editor.warnAt);
    if (!editor.accountId) return setEditorError('Choose a category.');
    if (cents === null) return setEditorError('Enter a valid amount, like 1500 or 1,500.50.');
    if (!Number.isInteger(warn) || warn < 1 || warn > 100) return setEditorError('Warning threshold must be a whole number from 1 to 100.');
    setBusy(true);
    setEditorError(null);
    try {
      await upsertBudget({ month, accountId: editor.accountId, amountCents: cents, warnAtPct: warn, notes: editor.notes });
      toast('Budget saved.', 'success');
      setEditor(null);
      await load();
    } catch (e) {
      setEditorError(e instanceof Error ? e.message : 'Could not save the budget.');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    setBusy(true);
    try {
      const n = await copyBudgetsFromPreviousMonth(month);
      toast(n > 0 ? `Copied ${n} ${n === 1 ? 'budget' : 'budgets'} from ${monthLabel(shiftMonth(month, -1))}.` : `Nothing new to copy from ${monthLabel(shiftMonth(month, -1))}.`, n > 0 ? 'success' : 'info');
      if (n > 0) await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not copy budgets.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting?.budget_id) return;
    try {
      await deleteBudget(deleting.budget_id);
      toast('Budget removed.', 'success');
      setDeleting(null);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the budget.', 'error');
      setDeleting(null);
    }
  };

  const editRow = (r: BudgetVarianceRow) =>
    openEditor({
      budgetId: r.budget_id,
      accountId: r.account_id,
      amount: r.budget_id ? centsToDollarsInput(r.budget_cents) : '',
      warnAt: String(r.warn_at_pct),
      notes: r.notes ?? '',
    });

  if (!canView) {
    return (
      <DashboardLayout activeLabel="Budgets">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner for the "View Billing" permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  const prevLabel = monthLabel(shiftMonth(month, -1));
  const remainingTone = summary.remainingCents < 0 ? 'bad' : summary.budgetCents > 0 ? 'good' : undefined;

  return (
    <DashboardLayout activeLabel="Budgets">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary hover:text-text-primary"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Wallet size={22} className="text-accent" /> Budgets
            </h1>
            <p className="text-sm text-text-secondary">Plan spend by category and track it against your books in real time.</p>
          </div>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={handleCopy} disabled={busy || loading}>
              <CopyPlus size={14} /> Copy {monthLabel(shiftMonth(month, -1), 'short').split(' ')[0]}
            </Button>
            <Button size="sm" onClick={() => openEditor({ ...EMPTY_EDITOR })} disabled={busy || loading}>
              <Plus size={14} /> Add budget
            </Button>
          </div>
        )}
      </div>

      <div className="mb-6 flex items-center justify-between gap-2 rounded-2xl border border-border bg-bg-secondary p-2">
        <button
          type="button"
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          onClick={() => setMonth(shiftMonth(month, -1))}
          aria-label="Previous month"
        >
          <ChevronLeft size={18} />
        </button>
        <div className="flex flex-col items-center sm:flex-row sm:gap-3">
          <span className="text-base font-semibold text-text-primary" aria-live="polite">{monthLabel(month)}</span>
          {month !== currentMonth && (
            <button type="button" className="focus-ring rounded-lg px-2 py-0.5 text-xs font-semibold text-accent hover:underline" onClick={() => setMonth(currentMonth)}>
              Back to this month
            </button>
          )}
        </div>
        <button
          type="button"
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:pointer-events-none disabled:opacity-40"
          onClick={() => setMonth(shiftMonth(month, 1))}
          disabled={month >= maxMonth}
          aria-label="Next month"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {editor && (
        <div ref={editorRef}>
          <Card className="mb-6 p-4 sm:p-5">
            <h2 className="mb-4 text-sm font-semibold text-text-primary">
              {editor.budgetId ? 'Edit budget' : 'New budget'} · {monthLabel(month)}
            </h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="budget-category" className="mb-1.5 block text-sm font-medium text-text-primary">Category</label>
                <select
                  id="budget-category"
                  className={selectClass}
                  value={editor.accountId}
                  disabled={!!editor.budgetId || (accounts.length === 0 && !editor.accountId)}
                  onChange={(e) => setEditor({ ...editor, accountId: e.target.value })}
                >
                  <option value="">{accounts.length === 0 && !editor.accountId ? 'Loading categories…' : 'Select a category'}</option>
                  {expenseAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
                </select>
              </div>
              <Input
                label="Monthly budget ($)"
                inputMode="decimal"
                placeholder="1500.00"
                value={editor.amount}
                onChange={(e) => setEditor({ ...editor, amount: e.target.value })}
              />
              <Input
                label="Warn me at (%)"
                inputMode="numeric"
                helperText="Alert when spend reaches this share of the budget."
                value={editor.warnAt}
                onChange={(e) => setEditor({ ...editor, warnAt: e.target.value })}
              />
              <div className="sm:col-span-3">
                <Input
                  label="Notes (optional)"
                  maxLength={500}
                  value={editor.notes}
                  onChange={(e) => setEditor({ ...editor, notes: e.target.value })}
                />
              </div>
            </div>
            {editorError && <p role="alert" className="mt-3 text-sm text-danger">{editorError}</p>}
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" size="sm" onClick={() => setEditor(null)} disabled={busy}>Cancel</Button>
              <Button size="sm" onClick={handleSave} disabled={busy}>{busy ? 'Saving…' : 'Save budget'}</Button>
            </div>
          </Card>
        </div>
      )}

      {loading ? (
        <div className="space-y-6">
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={2} rows={3} />
        </div>
      ) : loadFailed ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load budgets" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title={`No budgets for ${monthLabel(month)}`}
          description={canEdit ? 'Set a monthly budget per expense category to see how spending compares to your plan.' : 'Your account owner has not set budgets for this month.'}
          action={canEdit ? { label: 'Add your first budget', onClick: () => void openEditor({ ...EMPTY_EDITOR }) } : undefined}
          secondaryAction={canEdit ? { label: `Copy from ${prevLabel}`, onClick: () => void handleCopy() } : undefined}
        />
      ) : (
        <FadeIn>
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <Kpi label="Budgeted" value={formatCents(summary.budgetCents)} hint={`${budgetedRows.length} ${budgetedRows.length === 1 ? 'category' : 'categories'}`} />
              <Kpi label="Spent" value={formatCents(summary.actualCents)} hint={summary.unbudgetedCents > 0 ? `${formatCents(summary.unbudgetedCents)} unbudgeted` : 'From posted ledger entries'} />
              <Kpi
                label={summary.remainingCents < 0 ? 'Over by' : 'Remaining'}
                value={formatCents(Math.abs(summary.remainingCents))}
                tone={remainingTone}
                hint="Budgeted categories only"
              />
              <Kpi
                label="Used"
                value={summary.pctUsed === null ? '—' : `${summary.pctUsed}%`}
                tone={summary.overCount > 0 ? 'bad' : undefined}
                hint={summary.overCount + summary.warningCount > 0 ? `${summary.overCount} over · ${summary.warningCount} nearing` : 'All on track'}
              />
            </div>

            {alerts.length > 0 && (
              <div role="alert" className="rounded-2xl border border-warning-500/40 bg-warning-500/10 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <AlertTriangle size={16} className="text-warning-500" /> Needs attention
                </p>
                <ul className="mt-2 space-y-1 text-sm text-text-primary">
                  {alerts.map((r) => (
                    <li key={r.account_id}>
                      <span className="font-medium">{r.account_name}</span>
                      {r.status === 'over'
                        ? ` is over by ${formatCents(Math.abs(r.variance_cents))} (${formatCents(r.actual_cents)} of ${formatCents(r.budget_cents)}).`
                        : ` has used ${Math.round(r.pct_used ?? 0)}% of its budget (${formatCents(r.variance_cents)} left).`}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {budgetedRows.length > 0 && (
              <Card className="overflow-hidden !p-0">
                <div className="hidden md:block">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Budget versus actual by category for {monthLabel(month)}</caption>
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
                        <th scope="col" className="px-5 py-3 font-semibold">Category</th>
                        <th scope="col" className="px-3 py-3 text-right font-semibold">Budget</th>
                        <th scope="col" className="px-3 py-3 text-right font-semibold">Actual</th>
                        <th scope="col" className="px-3 py-3 text-right font-semibold">Variance</th>
                        <th scope="col" className="w-48 px-3 py-3 font-semibold">Used</th>
                        <th scope="col" className="px-3 py-3 font-semibold">Status</th>
                        {canEdit && <th scope="col" className="px-5 py-3"><span className="sr-only">Actions</span></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {budgetedRows.map((r) => (
                        <tr key={r.account_id} className="border-b border-border/60 last:border-0">
                          <td className="px-5 py-3">
                            <p className="font-medium text-text-primary">{r.account_name}</p>
                            <p className="text-xs text-text-secondary">{r.account_code}{r.notes ? ` · ${r.notes}` : ''}</p>
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">{formatCents(r.budget_cents)}</td>
                          <td className="px-3 py-3 text-right tabular-nums">{formatCents(r.actual_cents)}</td>
                          <td className={`px-3 py-3 text-right font-medium tabular-nums ${r.variance_cents < 0 ? 'text-danger' : 'text-text-primary'}`}>
                            {r.variance_cents < 0 ? '−' : ''}{formatCents(Math.abs(r.variance_cents))}
                          </td>
                          <td className="px-3 py-3"><UsageBar row={r} /></td>
                          <td className="px-3 py-3"><StatusBadge status={r.status} /></td>
                          {canEdit && (
                            <td className="px-5 py-3">
                              <div className="flex justify-end gap-1">
                                <button type="button" className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary" aria-label={`Edit ${r.account_name} budget`} onClick={() => void editRow(r)}>
                                  <Pencil size={15} />
                                </button>
                                <button type="button" className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary hover:text-danger" aria-label={`Remove ${r.account_name} budget`} onClick={() => setDeleting(r)}>
                                  <Trash2 size={15} />
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <ul className="divide-y divide-border/60 md:hidden">
                  {budgetedRows.map((r) => (
                    <li key={r.account_id} className="space-y-3 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-text-primary">{r.account_name}</p>
                          <p className="text-xs text-text-secondary">{r.account_code}</p>
                        </div>
                        <StatusBadge status={r.status} />
                      </div>
                      <UsageBar row={r} />
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div><p className="text-text-secondary">Budget</p><p className="font-semibold tabular-nums text-text-primary">{formatCents(r.budget_cents)}</p></div>
                        <div><p className="text-text-secondary">Actual</p><p className="font-semibold tabular-nums text-text-primary">{formatCents(r.actual_cents)}</p></div>
                        <div>
                          <p className="text-text-secondary">{r.variance_cents < 0 ? 'Over by' : 'Left'}</p>
                          <p className={`font-semibold tabular-nums ${r.variance_cents < 0 ? 'text-danger' : 'text-text-primary'}`}>{formatCents(Math.abs(r.variance_cents))}</p>
                        </div>
                      </div>
                      {canEdit && (
                        <div className="flex gap-2">
                          <Button variant="secondary" size="sm" className="flex-1" onClick={() => void editRow(r)}><Pencil size={14} /> Edit</Button>
                          <Button variant="ghost" size="sm" onClick={() => setDeleting(r)} aria-label={`Remove ${r.account_name} budget`}><Trash2 size={14} /></Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {unbudgetedRows.length > 0 && (
              <Card className="p-4 sm:p-5">
                <h2 className="text-sm font-semibold text-text-primary">Spending without a budget</h2>
                <p className="mt-0.5 text-xs text-text-secondary">These categories have posted expenses in {monthLabel(month)} but no budget.</p>
                <ul className="mt-3 divide-y divide-border/60">
                  {unbudgetedRows.map((r) => (
                    <li key={r.account_id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">{r.account_name}</p>
                        <p className="text-xs text-text-secondary">{r.account_code}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-sm font-semibold tabular-nums text-text-primary">{formatCents(r.actual_cents)}</span>
                        {canEdit && (
                          <Button variant="secondary" size="sm" onClick={() => void editRow(r)}>Set budget</Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {trend.length > 0 && <TrendChart points={trend} />}
          </div>
        </FadeIn>
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Remove this budget?"
        description={deleting ? `The ${deleting.account_name} budget for ${monthLabel(month)} will be removed. Your ledger and past spending are not affected.` : ''}
        confirmLabel="Yes, remove it"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </DashboardLayout>
  );
}
