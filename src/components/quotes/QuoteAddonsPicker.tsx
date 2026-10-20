import { formatCents } from '@/lib/quotes';
import { addonLineCents, addonTotals } from '@/lib/quoteAddons';
import type { PublicQuoteAddon } from '@/lib/quoteAddons';

export function QuoteAddonsPicker({
  addons,
  selectedIds,
  onToggle,
  taxPercent,
  disabled = false,
}: {
  addons: PublicQuoteAddon[];
  selectedIds: readonly string[];
  onToggle: (id: string) => void;
  taxPercent: number;
  disabled?: boolean;
}) {
  if (addons.length === 0) return null;

  const selected = new Set(selectedIds);
  const totals = addonTotals(addons, selectedIds, taxPercent);

  return (
    <section aria-labelledby="quote-addons-heading" className="mt-6">
      <h2 id="quote-addons-heading" className="text-sm font-semibold text-text-primary">
        Optional add-ons
      </h2>
      <p className="mt-0.5 text-xs text-text-secondary">Tick anything you'd like included — your total updates instantly.</p>

      <ul className="mt-3 space-y-2">
        {addons.map((addon) => {
          const checked = selected.has(addon.id);
          const line = addonLineCents(addon);
          return (
            <li key={addon.id}>
              <label
                className={`flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
                  checked ? 'border-accent/50 bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/30'
                } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggle(addon.id)}
                  className="focus-ring mt-0.5 h-4 w-4 shrink-0 accent-accent"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-text-primary">
                    {addon.name}
                    {addon.quantity > 1 && <span className="font-normal text-text-secondary"> × {addon.quantity}</span>}
                  </span>
                  {addon.description && (
                    <span className="mt-0.5 block text-xs leading-relaxed text-text-secondary">{addon.description}</span>
                  )}
                </span>
                <span className="shrink-0 text-sm font-semibold text-text-primary">+{formatCents(line)}</span>
              </label>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-right text-xs text-text-secondary" aria-live="polite" data-testid="addons-summary">
        {totals.count === 0
          ? 'No add-ons selected'
          : `${totals.count} add-on${totals.count === 1 ? '' : 's'} selected: +${formatCents(totals.totalCents)}${
              totals.taxCents > 0 ? ' incl. tax' : ''
            }`}
      </p>
    </section>
  );
}
