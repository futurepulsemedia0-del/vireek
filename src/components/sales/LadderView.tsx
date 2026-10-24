import { Check, ShieldCheck, Star } from 'lucide-react';
import { TIER_META } from '@/lib/estimates';
import { describeTerm, monthlyForTerm, money, moneyExact, type LadderEntry, type PaymentTerm } from '@/lib/inHomeSales';

export type PaymentMode = 'total' | 'monthly';

interface LadderViewProps {
  ladder: LadderEntry[];
  selectedId: string | null;
  onSelect: (optionId: string) => void;
  mode: PaymentMode;
  term: PaymentTerm;
  depositCents: number;
  locked?: boolean;
}

/** Tablet-first Good / Better / Best cards. One tap selects; the price toggles between total and monthly. */
export function LadderView({ ladder, selectedId, onSelect, mode, term, depositCents, locked = false }: LadderViewProps) {
  const cheapest = ladder[0];
  return (
    <div role="radiogroup" aria-label="Choose an option" className="grid gap-4 md:grid-cols-3">
      {ladder.map((entry) => {
        const { option } = entry;
        const meta = TIER_META[option.tier];
        const selected = option.id === selectedId;
        const monthly = mode === 'monthly' ? monthlyForTerm(entry.totalCents, depositCents, term) : null;
        const showMonthly = mode === 'monthly' && monthly !== null;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={locked}
            onClick={() => onSelect(option.id)}
            className={`focus-ring relative flex min-h-[220px] flex-col rounded-2xl border-2 bg-bg-secondary p-5 text-left transition-all disabled:cursor-default ${
              selected ? 'border-accent ring-4 ring-accent/15' : `${meta.ringClass} hover:border-accent/50`
            }`}
          >
            {entry.recommended && (
              <span className="absolute -top-3 left-5 inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1 text-xs font-semibold text-white">
                <Star size={12} aria-hidden="true" /> Recommended
              </span>
            )}
            <span className={`text-xs font-semibold uppercase tracking-wide ${meta.accentClass}`}>{meta.label}</span>
            <h3 className="mt-1 text-xl font-bold text-text-primary">{option.name || meta.defaultName}</h3>
            {option.summary && <p className="mt-1 text-sm text-text-secondary">{option.summary}</p>}

            <div className="mt-4">
              {showMonthly ? (
                <>
                  <p className="text-3xl font-bold text-text-primary">
                    {moneyExact(monthly)}
                    <span className="text-base font-medium text-text-secondary"> /mo</span>
                  </p>
                  <p className="text-xs text-text-secondary">
                    {describeTerm(term)} · {money(entry.totalCents)} total
                  </p>
                </>
              ) : (
                <>
                  <p className="text-3xl font-bold text-text-primary">{money(entry.totalCents)}</p>
                  <p className="text-xs text-text-secondary">
                    {entry.taxCents > 0 ? `Includes ${money(entry.taxCents)} tax` : 'Tax included where applicable'}
                  </p>
                </>
              )}
              {entry.upgradeGapCents > 0 && cheapest && (
                <p className="mt-1 text-xs font-medium text-accent">
                  +{money(entry.upgradeGapCents)} vs {TIER_META[cheapest.option.tier].label}
                </p>
              )}
            </div>

            {option.highlights.length > 0 && (
              <ul className="mt-4 space-y-1.5 text-sm text-text-primary">
                {option.highlights.map((h) => (
                  <li key={h} className="flex items-start gap-2">
                    <Check size={16} className="mt-0.5 shrink-0 text-success-500" aria-hidden="true" />
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            )}
            {option.warranty_label && (
              <p className="mt-auto flex items-center gap-1.5 pt-4 text-sm font-medium text-text-primary">
                <ShieldCheck size={16} className="text-success-500" aria-hidden="true" /> {option.warranty_label}
              </p>
            )}
            {selected && <span className="sr-only">Selected</span>}
          </button>
        );
      })}
    </div>
  );
}
