import { Check } from 'lucide-react';
import { STEPS, type StepId } from './types';

interface StepperProps {
  currentId: StepId;
  completedSteps: StepId[];
}

export function Stepper({ currentId, completedSteps }: StepperProps) {
  const currentIndex = STEPS.findIndex((s) => s.id === currentId);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Step {currentIndex + 1} of {STEPS.length}
        </span>
        <span className="text-xs font-medium text-accent">{STEPS[currentIndex]?.label}</span>
      </div>

      <div className="mb-6 h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300 ease-out"
          style={{ width: `${((currentIndex + 1) / STEPS.length) * 100}%` }}
        />
      </div>

      <div className="hidden items-center justify-center gap-1.5 overflow-x-auto pb-1 sm:flex">
        {STEPS.map((s, i) => {
          const done = completedSteps.includes(s.id) && i !== currentIndex;
          const active = i === currentIndex;
          return (
            <div key={s.id} className="flex items-center gap-1.5" title={s.label}>
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-all ${
                  active
                    ? 'bg-accent text-white ring-4 ring-accent/20'
                    : done
                      ? 'bg-success-500 text-white'
                      : 'bg-bg-tertiary text-text-secondary'
                }`}
              >
                {done ? <Check size={12} /> : i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div className={`h-0.5 w-4 rounded-full transition-colors ${done ? 'bg-success-500' : 'bg-bg-tertiary'}`} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
