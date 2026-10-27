import { formatUsd } from '@/lib/tipping';
import type { ReceiptLine } from '@/lib/paymentPricing';

interface Props {
  lines: ReceiptLine[];
  totalCents: number;
  totalLabel?: string;
  className?: string;
}

/** Itemised amounts exactly as they were (or will be) charged: invoice, fee, refunded fee, tip, total. */
export function PricingBreakdown({ lines, totalCents, totalLabel = 'Total', className = '' }: Props) {
  return (
    <dl className={`space-y-1 text-sm ${className}`}>
      {lines.map((line) => (
        <div key={line.key} className={`flex justify-between gap-3 ${line.cents < 0 ? 'text-success' : 'text-text-secondary'}`}>
          <dt>{line.label}</dt>
          <dd className="shrink-0 tabular-nums">{line.cents < 0 ? `−${formatUsd(-line.cents)}` : formatUsd(line.cents)}</dd>
        </div>
      ))}
      <div className="flex justify-between gap-3 border-t border-border-primary pt-2 text-base font-bold text-text-primary">
        <dt>{totalLabel}</dt>
        <dd className="shrink-0 tabular-nums">{formatUsd(totalCents)}</dd>
      </div>
    </dl>
  );
}
