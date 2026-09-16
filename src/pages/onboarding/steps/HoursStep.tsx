import { Check, Clock } from 'lucide-react';
import { StepShell } from '../StepShell';
import { DAYS_OF_WEEK, DAY_LABELS, type StepProps } from '../types';

export function HoursStep({ data, update, onBack, onNext, onSkip, saving }: StepProps) {
  const toggleDay = (day: string) => {
    const next = { ...data.hours };
    if (next[day]) {
      delete next[day];
    } else {
      next[day] = { open: '08:00', close: '17:00' };
    }
    update({ hours: next });
  };

  const updateHours = (day: string, field: 'open' | 'close', value: string) => {
    update({ hours: { ...data.hours, [day]: { ...data.hours[day], [field]: value } } });
  };

  return (
    <StepShell
      stepKey="hours"
      icon={Clock}
      title="When are you open?"
      description="Sarah will know when to book jobs and when to take messages."
      onBack={onBack}
      onNext={onNext}
      onSkip={onSkip}
      saving={saving}
    >
      <div className="space-y-2">
        {DAYS_OF_WEEK.map((day) => {
          const isActive = !!data.hours[day];
          return (
            <div key={day} className={`rounded-xl border p-3 transition-colors ${isActive ? 'border-accent/30 bg-accent/5' : 'border-border bg-bg-primary'}`}>
              <div className="flex items-center justify-between gap-3">
                <button type="button" onClick={() => toggleDay(day)} className="flex items-center gap-3">
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-md border transition-all ${
                      isActive ? 'border-accent bg-accent text-white' : 'border-border bg-bg-secondary'
                    }`}
                  >
                    {isActive && <Check size={12} />}
                  </span>
                  <span className="text-sm font-medium text-text-primary">{DAY_LABELS[day]}</span>
                </button>
                {isActive && (
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      value={data.hours[day].open}
                      onChange={(e) => updateHours(day, 'open', e.target.value)}
                      className="focus-ring rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-sm text-text-primary"
                    />
                    <span className="text-xs text-text-secondary">to</span>
                    <input
                      type="time"
                      value={data.hours[day].close}
                      onChange={(e) => updateHours(day, 'close', e.target.value)}
                      className="focus-ring rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-sm text-text-primary"
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </StepShell>
  );
}
