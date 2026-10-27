import { useEffect, useState } from 'react';
import { fetchJobPricingLedger, type PricingLedger } from '@/lib/paymentPricingApi';
import { bpsToPercent } from '@/lib/paymentPricing';
import { formatCents } from '@/lib/inPersonPayments';

const REFUND_REASONS: Record<string, string> = {
  debit_card: 'paid with a debit card',
  prepaid_card: 'paid with a prepaid card',
  unknown_funding: 'card type could not be confirmed',
  not_card: 'not paid by card',
  invalid_mode: 'fee setting changed',
};

/**
 * Card fees and cash discounts that were applied to this job, so the office and the technician can explain
 * every line of a customer's receipt. Renders nothing when there are none (and nothing if it can't load: it
 * is supplementary and must never get in the way of taking a payment).
 */
export function JobPricingLedger({ jobId, refreshKey }: { jobId: string; refreshKey?: number }) {
  const [ledger, setLedger] = useState<PricingLedger | null>(null);

  useEffect(() => {
    let alive = true;
    fetchJobPricingLedger(jobId)
      .then((l) => alive && setLedger(l))
      .catch(() => alive && setLedger(null));
    return () => {
      alive = false;
    };
  }, [jobId, refreshKey]);

  const discounts = ledger?.discounts.filter((d) => !d.reversed) ?? [];
  const fees = ledger?.fees ?? [];
  if (discounts.length === 0 && fees.length === 0) return null;

  return (
    <div className="mt-3 rounded-md bg-bg-primary p-2" aria-label="Fees and discounts">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">Fees &amp; discounts</h3>
      <ul className="space-y-1 text-xs text-text-secondary">
        {discounts.map((d) => (
          <li key={d.id} className="flex justify-between gap-3">
            <span>Cash discount ({bpsToPercent(d.discount_bps)}%)</span>
            <span className="tabular-nums text-success">−{formatCents(d.amount_cents)}</span>
          </li>
        ))}
        {fees.map((f) => {
          const kept = f.fee_cents - f.refunded_cents;
          return (
            <li key={f.payment_request_id} className="flex justify-between gap-3">
              <span>
                {f.label || 'Card fee'}
                {f.refunded_cents > 0 && <> · refunded ({REFUND_REASONS[f.refund_reason ?? ''] ?? 'refunded'})</>}
              </span>
              <span className="tabular-nums">{formatCents(kept)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
