import { ArrowRight, TrendingUp } from 'lucide-react';
import { describeSuggestion, findPlan, type UpgradeSuggestion } from '@/lib/usageLimits';

interface UpgradeSuggestionNoticeProps {
  suggestion: UpgradeSuggestion;
  onAction: () => void;
  className?: string;
}

/** Renders nothing unless the pure `suggestUpgrade` rule says the next plan is worth suggesting (no nagging). */
export function UpgradeSuggestionNotice({ suggestion, onAction, className = '' }: UpgradeSuggestionNoticeProps) {
  const copy = describeSuggestion(suggestion);
  const target = findPlan(suggestion.targetPlanId);
  if (!copy || !target) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col gap-3 rounded-2xl border border-accent/30 bg-accent/10 p-4 sm:flex-row sm:items-center sm:justify-between ${className}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <TrendingUp size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">{copy.title}</p>
          <p className="mt-0.5 text-xs text-text-secondary">{copy.body}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onAction}
        className="focus-ring flex shrink-0 items-center justify-center gap-1.5 self-start whitespace-nowrap rounded-xl bg-cta px-4 py-2 text-sm font-semibold text-white transition-all duration-150 hover:brightness-110 active:brightness-95 sm:self-center"
      >
        See {target.name}
        <ArrowRight size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
