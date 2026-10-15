import { useState } from 'react';
import { Coins, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { BILLING_FREQUENCY_LABELS } from '@/lib/contracts';
import {
  PRICE_KIND_LABELS,
  annualizedValueCents,
  applyPriceChange,
  formatDate,
  formatMoney,
  formatPct,
  toDateKey,
  type PriceChangeKind,
} from '@/lib/serviceAgreement';
import { FormActions, KeyValue, Panel, Pill, SelectField, StatTile, dollarsToCents, type TabProps } from './AgreementUi';
import { useAgreementActions } from './useAgreementActions';

const KIND_OPTIONS: PriceChangeKind[] = ['escalation', 'amendment', 'renewal', 'discount'];

export function PricingTab({ data, derived, canManage, canSeeMoney, ownerId, reload }: TabProps) {
  const { busy, run } = useAgreementActions(reload);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<PriceChangeKind>('escalation');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(toDateKey(new Date()));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!canSeeMoney) {
    return <EmptyState icon={Coins} title="Pricing is restricted" description="Ask the account owner for billing access to see agreement pricing and margin." />;
  }

  const { contract } = data;
  const { escalation, reprice } = derived;
  const annual = annualizedValueCents(contract);
  const period = BILLING_FREQUENCY_LABELS[contract.billing_frequency].toLowerCase();

  const close = () => {
    setOpen(false);
    setError(null);
    setAmount('');
    setReason('');
  };

  const startWith = (cents: number | null, k: PriceChangeKind, why: string) => {
    setKind(k);
    setAmount(cents === null ? '' : String(cents / 100));
    setReason(why);
    setDate(toDateKey(new Date()));
    setOpen(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cents = dollarsToCents(amount);
    if (cents === undefined || cents === null) return setError('Enter the new fee as a positive dollar amount.');
    if (cents === contract.contract_value_cents) return setError('That is the current fee — enter a different amount.');
    if (!date) return setError('Choose the effective date.');
    setError(null);
    const ok = await run(
      () => applyPriceChange({ ownerId, contractId: contract.id, kind, previousCents: contract.contract_value_cents, newCents: cents, effectiveDate: date, reason }),
      'Price updated and recorded.'
    );
    if (ok) close();
  };

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={`Fee per ${period.replace('ly', '').replace('annua', 'year')}`} value={formatMoney(contract.contract_value_cents)} icon={Coins} />
        <StatTile label="Annualised value" value={annual === null ? 'One-time' : formatMoney(annual)} icon={TrendingUp} />
        <StatTile label="Escalation" value={escalation.kind === 'none' ? 'None' : escalation.kind === 'cpi' ? 'CPI-linked' : formatPct(escalation.percent, 1)} icon={TrendingUp} tone="text-warning-500" />
        <StatTile label="Next escalation" value={escalation.nextDate ? formatDate(escalation.nextDate) : '—'} icon={TrendingUp} tone="text-warning-500" />
      </div>

      <Panel
        title="Pricing"
        description="Fee, billing cadence and the contractual price-escalation rule. Every change is kept in the history below and in the audit log."
        action={
          canManage ? (
            <Button size="sm" onClick={() => startWith(null, 'amendment', '')} disabled={open}>
              Change price
            </Button>
          ) : undefined
        }
      >
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <KeyValue label="Billing" value={BILLING_FREQUENCY_LABELS[contract.billing_frequency]} />
          <KeyValue label="Escalation rule" value={escalation.kind === 'none' ? 'None' : escalation.kind === 'cpi' ? 'Linked to CPI' : `Fixed ${formatPct(escalation.percent, 1)}`} />
          <KeyValue label="Projected fee after escalation" value={escalation.projectedCents !== null ? `${formatMoney(escalation.projectedCents)} (+${formatMoney(escalation.deltaCents)})` : '—'} />
          <KeyValue label="Escalation in" value={escalation.daysAway === null ? '—' : escalation.daysAway < 0 ? `${-escalation.daysAway} days overdue` : `${escalation.daysAway} days`} />
        </dl>

        {canManage && escalation.projectedCents !== null && escalation.daysAway !== null && escalation.daysAway <= 90 && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-bg-primary p-3">
            <p className="flex-1 text-sm text-text-primary">
              Contract escalation of {formatPct(escalation.percent, 1)} is due {formatDate(escalation.nextDate)}: {formatMoney(contract.contract_value_cents)} → {formatMoney(escalation.projectedCents)}.
            </p>
            <Button size="sm" variant="secondary" onClick={() => startWith(escalation.projectedCents, 'escalation', `Contractual ${formatPct(escalation.percent, 1)} escalation`)} disabled={open}>
              Apply escalation
            </Button>
          </div>
        )}

        {reprice && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-warning-500/30 bg-warning-500/10 p-3">
            <p className="flex-1 text-sm text-text-primary">
              Actual cost-to-serve is above plan. To reach a {reprice.targetMarginPct}% margin, price at {formatMoney(reprice.suggestedFeeCents)} per {period.replace('ly', '')} (+{formatPct(reprice.increasePct, 1)}) at renewal.
            </p>
            {canManage && (
              <Button size="sm" variant="secondary" onClick={() => startWith(reprice.suggestedFeeCents, 'amendment', `Repriced to reach ${reprice.targetMarginPct}% margin`)} disabled={open}>
                Use suggestion
              </Button>
            )}
          </div>
        )}

        {open && (
          <form onSubmit={submit} className="mt-4 grid gap-3 rounded-lg border border-border bg-bg-primary p-4 sm:grid-cols-2">
            <SelectField label="Type of change" value={kind} onChange={setKind} options={KIND_OPTIONS.map((k) => ({ value: k, label: PRICE_KIND_LABELS[k] }))} />
            <Input label={`New fee per ${period.replace('ly', '')} ($)`} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} helperText={`Current: ${formatMoney(contract.contract_value_cents)}`} />
            <Input label="Effective date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
            <Input label="Reason" maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
            {error && <p className="text-sm text-danger sm:col-span-2" role="alert">{error}</p>}
            <div className="sm:col-span-2">
              <FormActions busy={busy} onCancel={close} submitLabel="Apply price" />
            </div>
          </form>
        )}
      </Panel>

      <Panel title="Price history" description="Append-only record of every fee change.">
        {data.priceChanges.length === 0 ? (
          <EmptyState icon={Coins} title="No price history yet" description="The first fee and every later change are recorded automatically." />
        ) : (
          <ul className="divide-y divide-border">
            {data.priceChanges.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">
                    {c.previous_cents === null ? formatMoney(c.new_cents) : `${formatMoney(c.previous_cents)} → ${formatMoney(c.new_cents)}`}
                    {c.previous_cents !== null && c.previous_cents > 0 && (
                      <span className={`ml-2 text-xs ${c.new_cents >= c.previous_cents ? 'text-success-500' : 'text-danger'}`}>
                        {c.new_cents >= c.previous_cents ? '+' : ''}
                        {formatPct(((c.new_cents - c.previous_cents) / c.previous_cents) * 100, 1)}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-text-secondary">
                    Effective {formatDate(c.effective_date)}
                    {c.reason ? ` · ${c.reason}` : ''}
                  </p>
                </div>
                <Pill className="bg-bg-tertiary text-text-secondary">{PRICE_KIND_LABELS[c.kind]}</Pill>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
