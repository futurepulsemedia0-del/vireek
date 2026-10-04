import { ArrowDown, ArrowRight } from 'lucide-react';
import { Fragment } from 'react';
import type { ChainState, ChainStep } from '@/lib/outcomeNetwork';

const STATE_STYLE: Record<ChainState, string> = {
  done: 'border-border bg-bg-tertiary text-text-primary',
  pending: 'border-dashed border-border bg-bg-secondary text-text-secondary',
  good: 'border-success-500/40 bg-success-500/10 text-success-500',
  bad: 'border-danger/40 bg-danger/10 text-danger',
};

/** Problem → Symptoms → Diagnosis → Technician → Part → Action → Cost → Outcome → Callback → Customer result */
export function OutcomeChain({ steps }: { steps: ChainStep[] }) {
  return (
    <ol className="flex flex-col gap-1.5 md:flex-row md:flex-wrap md:items-stretch" aria-label="Outcome chain">
      {steps.map((s, i) => (
        <Fragment key={s.id}>
          <li className={`min-w-[120px] flex-1 rounded-xl border px-3 py-2 ${STATE_STYLE[s.state]}`}>
            <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">{s.label}</p>
            <p className="mt-0.5 text-sm font-semibold leading-snug">{s.value}</p>
          </li>
          {i < steps.length - 1 && (
            <li aria-hidden="true" className="flex items-center justify-center text-text-secondary">
              <ArrowRight className="hidden h-4 w-4 md:block" />
              <ArrowDown className="h-4 w-4 md:hidden" />
            </li>
          )}
        </Fragment>
      ))}
    </ol>
  );
}
