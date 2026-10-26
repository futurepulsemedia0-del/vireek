import { Save } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { NumbersErrors, NumbersForm } from '@/lib/valuation';

interface Props {
  form: NumbersForm;
  errors: NumbersErrors;
  dirty: boolean;
  saving: boolean;
  onChange: (field: keyof NumbersForm, value: string) => void;
  onSave: () => void;
  onReset: () => void;
}

export function NumbersPanel({ form, errors, dirty, saving, onChange, onSave, onReset }: Props) {
  const field = (key: keyof NumbersForm, label: string, helperText: string, opts: { required?: boolean } = {}) => (
    <Input
      label={label}
      inputMode="decimal"
      autoComplete="off"
      value={form[key]}
      onChange={(e) => onChange(key, e.target.value)}
      error={errors[key]}
      helperText={helperText}
      required={opts.required}
    />
  );

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(e) => { e.preventDefault(); onSave(); }}
      aria-label="Business numbers"
    >
      <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
        <h2 className="text-base font-bold text-text-primary">Earnings and revenue</h2>
        <p className="mb-4 text-sm text-text-secondary">Use the last 12 months. Owner earnings means net profit plus owner pay, owner perks and one-time costs.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {field('owner_earnings', 'Annual owner earnings ($)', 'Also called SDE. This drives the estimate.')}
          {field('annual_revenue', 'Annual revenue ($)', 'Optional. Used for the revenue cross-check.')}
          {field('recurring_revenue_pct', 'Recurring revenue (%)', 'Maintenance plans, memberships, contracts.')}
          {field('top_customer_pct', 'Largest customer or source (% of revenue)', 'Builders, property managers, referral partners.')}
          {field('revenue_growth_pct', 'Revenue growth, last year (%)', 'Use a negative number if revenue fell.')}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
        <h2 className="text-base font-bold text-text-primary">Balance sheet</h2>
        <p className="mb-4 text-sm text-text-secondary">Optional. Turns the business value into an estimate of what you would take home.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {field('cash_on_hand', 'Cash on hand ($)', 'Money that stays with the seller in most deals.')}
          {field('total_debt', 'Total debt ($)', 'Loans, lines of credit, vehicle and equipment financing.')}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
        <h2 className="text-base font-bold text-text-primary">Multiple band and timing</h2>
        <p className="mb-4 text-sm text-text-secondary">
          Small service businesses often trade at roughly 2 to 3.5 times owner earnings. These are assumptions, so change them to match what brokers tell you.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          {field('multiple_low', 'Low multiple (x)', 'For a business a buyer sees as risky.', { required: true })}
          {field('multiple_high', 'High multiple (x)', 'For a clean, transferable business.', { required: true })}
          <Input
            label="Target exit date"
            type="date"
            value={form.target_exit_date}
            onChange={(e) => onChange('target_exit_date', e.target.value)}
            error={errors.target_exit_date}
            helperText="Optional."
          />
        </div>
      </section>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onReset} disabled={!dirty || saving}>Discard changes</Button>
        <Button type="submit" size="sm" disabled={!dirty || saving}>
          <Save size={16} aria-hidden="true" /> {saving ? 'Saving…' : 'Save numbers'}
        </Button>
      </div>
    </form>
  );
}
