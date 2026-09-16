import { CalendarDays } from 'lucide-react';
import { StepShell } from '../StepShell';
import { CALENDAR_PROVIDER_OPTIONS, type StepProps } from '../types';

export function CalendarStep({ data, update, onBack, onNext, onSkip, saving }: StepProps) {
  return (
    <StepShell
      stepKey="calendar"
      icon={CalendarDays}
      title="Keep bookings off double-booked calendars"
      description="Pick the calendar Sarah should check before offering a time slot. You can finish connecting it from Integrations after launch."
      onBack={onBack}
      onNext={onNext}
      onSkip={onSkip}
      saving={saving}
    >
      <div className="grid gap-3">
        {CALENDAR_PROVIDER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => update({ calendarProvider: opt.value })}
            className={`rounded-xl border p-4 text-left transition-all ${
              data.calendarProvider === opt.value ? 'border-accent bg-accent/5' : 'border-border bg-bg-primary hover:border-accent/30'
            }`}
          >
            <p className="text-sm font-semibold text-text-primary">{opt.label}</p>
          </button>
        ))}
      </div>
      {data.calendarProvider !== 'none' && (
        <p className="mt-4 rounded-xl bg-accent/5 p-3 text-xs text-text-secondary">
          Noted. After launch, open <span className="font-medium text-text-primary">Settings → Integrations</span> to finish
          connecting {CALENDAR_PROVIDER_OPTIONS.find((o) => o.value === data.calendarProvider)?.label} — that's where the
          secure sign-in happens.
        </p>
      )}
    </StepShell>
  );
}
