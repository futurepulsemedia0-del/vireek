import {
  ALL_DAYS,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
  technicianLabel,
  workingDaysOf,
  type TechnicianLite,
} from '@/lib/timeOff';

function describeDays(days: readonly number[]): string {
  if (days.length === ALL_DAYS.length) return 'Every day';
  if (days.length === 0) return 'No working days, never dispatched';
  if (days.join() === '1,2,3,4,5') return 'Weekdays only';
  return days.map((d) => WEEKDAY_SHORT[d]).join(', ');
}

interface WeeklyAvailabilityProps {
  technicians: TechnicianLite[];
  weekly: Record<string, number[]>;
  savingId: string | null;
  onToggle: (technicianId: string, day: number) => void;
}

export function WeeklyAvailability({ technicians, weekly, savingId, onToggle }: WeeklyAvailabilityProps) {
  return (
    <section aria-label="Weekly availability" className="rounded-2xl border border-border bg-bg-secondary p-4">
      <h2 className="text-base font-semibold text-text-primary">Weekly availability</h2>
      <p className="mb-4 mt-1 text-sm text-text-secondary">
        Which days each technician normally works. Dispatch and auto-assign skip technicians on days they are off. Until you change it, everyone works every
        day.
      </p>
      <ul className="divide-y divide-border">
        {technicians.map((t) => {
          const days = workingDaysOf(t.id, weekly);
          const name = technicianLabel(t);
          const saving = savingId === t.id;
          return (
            <li key={t.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-text-primary">{name}</p>
                <p className="text-xs text-text-secondary" aria-live="polite">
                  {saving ? 'Saving…' : describeDays(days)}
                </p>
              </div>
              <div role="group" aria-label={`Working days for ${name}`} className="grid grid-cols-7 gap-1.5 sm:flex">
                {ALL_DAYS.map((d) => {
                  const on = days.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      aria-label={`${name} works ${WEEKDAY_NAMES[d]}s`}
                      disabled={saving}
                      onClick={() => onToggle(t.id, d)}
                      className={`focus-ring min-h-[40px] rounded-lg border text-xs font-semibold transition-colors disabled:opacity-60 sm:min-w-[44px] ${
                        on ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {WEEKDAY_SHORT[d]}
                    </button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
