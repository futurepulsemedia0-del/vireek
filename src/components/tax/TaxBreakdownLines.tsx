import { formatRate, type TaxBreakdownLine } from '@/lib/salesTax';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

interface Props {
  breakdown: TaxBreakdownLine[] | null | undefined;
  taxCents: number;
  taxPercent: number;
  taxExempt?: boolean;
  className?: string;
}

/**
 * Tax as separate invoice lines (one per jurisdiction). Falls back to a single
 * "Sales tax (x%)" line for documents created before itemised tax existed.
 */
export function TaxBreakdownLines({ breakdown, taxCents, taxPercent, taxExempt = false, className = '' }: Props) {
  const lines = breakdown ?? [];

  if (lines.length === 0 && taxCents <= 0 && !taxExempt) return null;

  return (
    <div className={`space-y-1 text-sm ${className}`} data-testid="tax-breakdown">
      {lines.length > 0 ? (
        lines.map((b, i) => (
          <div key={`${b.level}-${b.name}-${i}`} className="flex items-center justify-between text-text-secondary">
            <span>
              {b.name} <span className="text-xs">({formatRate(b.rate_percent)})</span>
            </span>
            <span>{money(b.tax_cents)}</span>
          </div>
        ))
      ) : taxCents > 0 ? (
        <div className="flex items-center justify-between text-text-secondary">
          <span>
            Sales tax <span className="text-xs">({formatRate(Number(taxPercent.toFixed(4)))})</span>
          </span>
          <span>{money(taxCents)}</span>
        </div>
      ) : null}
      {taxExempt && (
        <div className="flex items-center justify-between text-text-secondary">
          <span>Sales tax — exempt (certificate on file)</span>
          <span>{money(0)}</span>
        </div>
      )}
    </div>
  );
}
