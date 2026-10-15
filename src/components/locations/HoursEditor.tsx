import { WEEKDAYS, type BusinessHours, type DayHours, type WeekdayKey } from '@/lib/locations';

const TIME_FIELD =
  'focus-ring min-h-[40px] rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary disabled:opacity-40';

/** Weekly opening-hours editor. Same-day hours only (close must be after open) — validated in lib/locations. */
export function HoursEditor({
  value,
  onChange,
  error,
  disabled,
}: {
  value: BusinessHours;
  onChange: (next: BusinessHours) => void;
  error?: string;
  disabled?: boolean;
}) {
  const patch = (key: WeekdayKey, change: Partial<DayHours>) => onChange({ ...value, [key]: { ...value[key], ...change } });

  const copyMondayToWeekdays = () => {
    const mon = value.mon;
    onChange({ ...value, tue: { ...mon }, wed: { ...mon }, thu: { ...mon }, fri: { ...mon } });
  };

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">Opening hours</legend>
      <ul className="space-y-2">
        {WEEKDAYS.map(({ key, label, short }) => {
          const d = value[key];
          return (
            <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-bg-primary px-3 py-2">
              <span className="w-12 text-sm font-medium text-text-primary" aria-hidden="true">{short}</span>
              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  checked={!d.closed}
                  onChange={(e) => patch(key, { closed: !e.target.checked })}
                  aria-label={`${label} open`}
                  className="h-4 w-4 accent-accent"
                />
                {d.closed ? 'Closed' : 'Open'}
              </label>
              <div className="ml-auto flex items-center gap-2">
                <input
                  type="time"
                  value={d.open}
                  disabled={d.closed}
                  onChange={(e) => patch(key, { open: e.target.value })}
                  aria-label={`${label} opens`}
                  className={TIME_FIELD}
                />
                <span className="text-text-secondary" aria-hidden="true">–</span>
                <input
                  type="time"
                  value={d.close}
                  disabled={d.closed}
                  onChange={(e) => patch(key, { close: e.target.value })}
                  aria-label={`${label} closes`}
                  className={TIME_FIELD}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={copyMondayToWeekdays}
        className="focus-ring mt-2 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:underline"
      >
        Copy Monday to Tue–Fri
      </button>
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}
