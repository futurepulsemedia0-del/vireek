import { useMemo, useState } from 'react';
import { Plus, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonStatGrid, SkeletonTable } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatMoney } from '@/lib/currency';
import { createExpense, deleteExpense, fetchExpenses } from '@/lib/vehicleManagementApi';
import {
  EXPENSE_TYPES, formatMiles, humanize, parseExpenseForm, summarizeExpenses, toDateOnly,
  type ExpenseFormValues, type FieldErrors, type VehicleExpense, type Vehicle,
} from '@/lib/vehicleManagement';
import { ErrorState, Section, SelectField, Stat, formatDate, useLoader } from './shared';

interface Props {
  vehicle: Vehicle;
  ownerId: string;
  /** Called after a change that can alter the vehicle (odometer bump). */
  onChanged: () => void;
}

const emptyForm = (): ExpenseFormValues => ({ expense_type: 'fuel', amount: '', expense_date: toDateOnly(new Date()), odometer_miles: '', downtime_hours: '', notes: '' });

export function ExpensesTab({ vehicle, ownerId, onChanged }: Props) {
  const { toast } = useToast();
  const { currency } = useCurrency();
  const money = (n: number) => formatMoney(n, currency);
  const expenses = useLoader(() => fetchExpenses(vehicle.id), vehicle.id);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ExpenseFormValues>(emptyForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<VehicleExpense | null>(null);

  const rows = expenses.data ?? [];
  const summary = useMemo(() => summarizeExpenses(rows, new Date(), 90), [rows]);
  const fixedMonthly = vehicle.monthly_payment_cost + vehicle.monthly_insurance_cost;
  const set = (k: keyof ExpenseFormValues) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = parseExpenseForm(form, vehicle.odometer_miles, new Date());
    if (!result.ok) { setErrors(result.errors); return; }
    setSaving(true);
    try {
      await createExpense(ownerId, vehicle.id, result.value);
      toast('Expense logged.', 'success');
      setForm(emptyForm()); setErrors({}); setShowForm(false);
      void expenses.reload();
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not log the expense.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const breakdown = EXPENSE_TYPES.filter((t) => summary.byType[t] > 0);

  return (
    <div className="space-y-4">
      {expenses.loading && !expenses.data ? (
        <><SkeletonStatGrid count={3} /><SkeletonTable rows={4} columns={4} /></>
      ) : expenses.error && !expenses.data ? (
        <ErrorState message={expenses.error} onRetry={expenses.reload} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat label="Spend (last 90 days)" value={money(summary.total)} hint={breakdown.length ? breakdown.map((t) => `${humanize(t)} ${money(summary.byType[t])}`).join(' · ') : undefined} />
            <Stat label="Cost per mile" value={summary.costPerMile != null ? money(summary.costPerMile) : '—'} hint={summary.milesInWindow != null ? `Across ${formatMiles(summary.milesInWindow)}` : 'Log odometer readings to calculate'} />
            <Stat label="Fixed cost / month" value={money(fixedMonthly)} hint="Payment + insurance" />
          </div>

          {showForm && (
            <Section title="Log an expense">
              <form onSubmit={submit} noValidate className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <SelectField label="Type" value={form.expense_type} onChange={set('expense_type')} error={errors.expense_type}>
                    {EXPENSE_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
                  </SelectField>
                  <Input label={`Amount (${currency})`} required type="number" inputMode="decimal" min="0" step="0.01" value={form.amount} onChange={set('amount')} error={errors.amount} />
                  <Input label="Date" required type="date" value={form.expense_date} onChange={set('expense_date')} error={errors.expense_date} />
                  <Input label="Odometer (mi)" type="number" inputMode="numeric" min="0" value={form.odometer_miles} onChange={set('odometer_miles')} error={errors.odometer_miles} />
                  {form.expense_type === 'downtime' && <Input label="Downtime (hours)" type="number" inputMode="decimal" min="0" step="0.5" value={form.downtime_hours} onChange={set('downtime_hours')} error={errors.downtime_hours} />}
                </div>
                <Textarea label="Notes (optional)" rows={2} value={form.notes} onChange={set('notes')} error={errors.notes} maxLength={500} />
                <div className="flex justify-end gap-3">
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setShowForm(false); setErrors({}); }} disabled={saving}>Cancel</Button>
                  <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Log expense'}</Button>
                </div>
              </form>
            </Section>
          )}

          <Section title="Expense log" action={!showForm ? <Button size="sm" onClick={() => setShowForm(true)}><Plus size={16} /> Log expense</Button> : undefined}>
            {rows.length === 0 ? (
              <EmptyState icon={Receipt} title="No expenses logged" description="Track fuel, repairs and downtime to see what this vehicle really costs." action={showForm ? undefined : { label: 'Log expense', onClick: () => setShowForm(true) }} />
            ) : (
              <ul className="divide-y divide-border">
                {rows.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{humanize(x.expense_type)} <span className="font-normal text-text-secondary">· {formatDate(x.expense_date)}</span></p>
                      <p className="text-xs text-text-secondary">
                        {[x.odometer_miles != null ? formatMiles(x.odometer_miles) : null, x.downtime_hours != null ? `${x.downtime_hours} h down` : null].filter(Boolean).join(' · ')}
                      </p>
                      {x.notes && <p className="mt-1 break-words text-xs text-text-secondary">{x.notes}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-text-primary">{money(x.amount)}</span>
                      <Button size="sm" variant="ghost" onClick={() => setPendingDelete(x)} aria-label={`Delete ${humanize(x.expense_type)} expense from ${formatDate(x.expense_date)}`}>Delete</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this expense?"
        description={pendingDelete ? `${humanize(pendingDelete.expense_type)} · ${money(pendingDelete.amount)} on ${formatDate(pendingDelete.expense_date)} will be removed from ${vehicle.label}'s costs.` : ''}
        confirmLabel="Delete expense"
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (!target) return;
          try {
            await deleteExpense(target.id);
            toast('Expense deleted.', 'success');
            void expenses.reload();
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Could not delete the expense.', 'error');
          }
        }}
      />
    </div>
  );
}
