import { useEffect, useMemo, useState } from 'react';
import { Clock } from 'lucide-react';
import {
  formatLength,
  formatWindowDay,
  formatWindowRange,
  type OfferedWindow,
} from '@/lib/arrivalWindows';

interface ArrivalWindowPickerProps {
  /** length in minutes -> windows, from loadArrivalWindowOffers() */
  offers: Record<number, OfferedWindow[]>;
  lengths: number[];
  value: OfferedWindow | null;
  onChange: (window: OfferedWindow | null) => void;
  /** How many days to show before "Show more days". */
  initialDays?: number;
}

export function ArrivalWindowPicker({ offers, lengths, value, onChange, initialDays = 5 }: ArrivalWindowPickerProps) {
  // Default to the tightest window that has any availability: customers prefer short windows.
  const firstAvailable = lengths.find((l) => (offers[l] ?? []).length > 0) ?? lengths[0];
  const [length, setLength] = useState<number>(value?.lengthMinutes ?? firstAvailable);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (value && value.lengthMinutes !== length) onChange(null);
  }, [length]); // eslint-disable-line react-hooks/exhaustive-deps

  const days = useMemo(() => {
    const groups = new Map<string, OfferedWindow[]>();
    for (const w of offers[length] ?? []) {
      const key = formatWindowDay(w.start);
      groups.set(key, [...(groups.get(key) ?? []), w]);
    }
    return [...groups.entries()];
  }, [offers, length]);

  const visibleDays = showAll ? days : days.slice(0, initialDays);

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <Clock size={13} aria-hidden /> Arrival window
        </p>
        <div role="radiogroup" aria-label="Window length" className="flex flex-wrap gap-2">
          {lengths.map((l) => {
            const count = (offers[l] ?? []).length;
            const active = l === length;
            return (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={count === 0}
                onClick={() => setLength(l)}
                className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  active ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:border-accent/40'
                }`}
              >
                {formatLength(l)}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-text-secondary">
          Our technician arrives at some point inside the window you pick. Once your visit is assigned we narrow it
          and text you the tighter time.
        </p>
      </div>

      {days.length === 0 ? (
        <p className="rounded-xl border border-border bg-bg-primary p-4 text-sm text-text-secondary">
          No {formatLength(length)} windows are open right now. Try a longer window.
        </p>
      ) : (
        <div className="space-y-4">
          {visibleDays.map(([day, windows]) => (
            <div key={day}>
              <p className="mb-2 text-xs font-semibold text-text-primary">{day}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {windows.map((w) => {
                  const selected = value !== null && value.start.getTime() === w.start.getTime() && value.lengthMinutes === w.lengthMinutes;
                  return (
                    <button
                      key={w.start.toISOString()}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onChange(w)}
                      className={`focus-ring rounded-xl border px-3 py-2.5 text-xs font-medium transition-colors ${
                        selected ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-primary hover:border-accent/40 hover:text-accent'
                      }`}
                    >
                      {formatWindowRange(w)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {!showAll && days.length > initialDays && (
            <button type="button" onClick={() => setShowAll(true)} className="focus-ring text-xs font-medium text-accent hover:underline">
              Show more days
            </button>
          )}
        </div>
      )}
    </div>
  );
}
