import { useCurrency } from '@/contexts/CurrencyContext';
import { CURRENCIES, CurrencyCode } from '@/lib/currency';

/**
 * Small dropdown for picking a display currency on pricing sections.
 * This only changes how prices are RENDERED — checkout still runs in USD
 * unless Stripe's Adaptive Pricing (or per-currency Payment Links) is set up.
 */
export function CurrencySwitcher({ className = '' }: { className?: string }) {
  const { currency, setCurrency } = useCurrency();

  return (
    <select
      aria-label="Select currency"
      value={currency}
      onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
      className={`rounded-full border border-border bg-bg-secondary px-4 py-2 text-sm font-semibold text-text-primary focus:outline-none focus:ring-2 focus:ring-accent ${className}`}
    >
      {Object.values(CURRENCIES).map((c) => (
        <option key={c.code} value={c.code}>
          {c.code} — {c.name}
        </option>
      ))}
    </select>
  );
}
