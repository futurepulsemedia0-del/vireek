import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';
import type { DateRangeController } from '@/hooks/useDateRange';
import { PRESET_LABELS, toISODate, validateCustomRange, type RangePreset } from '@/lib/dateRange';

const QUICK_PRESETS: Exclude<RangePreset, 'custom'>[] = ['today', '7d', '30d', '90d', 'mtd', 'qtd'];

interface DateRangeFilterProps {
  controller: DateRangeController;
  /** Hide the "Compare to previous period" toggle (e.g. a page with no comparable KPIs). */
  hideCompare?: boolean;
  className?: string;
}

/**
 * Preset + custom date-range picker with a compare-to-previous-period toggle.
 * All state lives in the URL via useDateRange; this component only renders it.
 */
export function DateRangeFilter({
  controller,
  hideCompare = false,
  className = '',
}: DateRangeFilterProps) {
  const { selection, range, setPreset, setCustom, setCompare } = controller;
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const errorId = useId();
  const todayStr = toISODate(new Date());

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const toggle = () => {
    if (!open) {
      // Seed the custom inputs from the active range each time the panel opens.
      setFrom(toISODate(range.start));
      setTo(toISODate(range.end));
      setError(null);
    }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open, close]);

  const applyCustom = () => {
    const check = validateCustomRange(from, to);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setCustom(check.from, check.to);
    close(true);
  };

  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${className}`}>
      <div ref={rootRef} className="relative">
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          className="focus-ring flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:border-accent/40"
        >
          <Calendar size={16} className="text-text-secondary" aria-hidden="true" />
          <span>{PRESET_LABELS[selection.preset]}</span>
          <span className="hidden text-text-secondary sm:inline">· {range.label}</span>
          <ChevronDown size={16} className="text-text-secondary" aria-hidden="true" />
        </button>

        {open && (
          <div
            id={panelId}
            role="dialog"
            aria-label="Select date range"
            className="absolute left-0 z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-bg-secondary p-3 shadow-card-hover dark:shadow-card-hover-dark sm:left-auto sm:right-0"
          >
            <div className="grid grid-cols-2 gap-1.5">
              {QUICK_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={selection.preset === p}
                  onClick={() => {
                    setPreset(p);
                    close(true);
                  }}
                  className={`focus-ring rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    selection.preset === p
                      ? 'bg-accent/10 font-medium text-accent'
                      : 'text-text-primary hover:bg-bg-tertiary'
                  }`}
                >
                  {PRESET_LABELS[p]}
                </button>
              ))}
            </div>

            <div className="my-3 border-t border-border" />

            <p className="text-xs font-medium text-text-secondary">Custom range</p>
            <div className="mt-2 grid gap-2">
              <label className="grid gap-1 text-xs text-text-secondary">
                Start date
                <input
                  type="date"
                  max={todayStr}
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    setError(null);
                  }}
                  aria-invalid={!!error}
                  aria-describedby={error ? errorId : undefined}
                  className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                />
              </label>
              <label className="grid gap-1 text-xs text-text-secondary">
                End date
                <input
                  type="date"
                  max={todayStr}
                  value={to}
                  onChange={(e) => {
                    setTo(e.target.value);
                    setError(null);
                  }}
                  aria-invalid={!!error}
                  aria-describedby={error ? errorId : undefined}
                  className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                />
              </label>
              {error && (
                <p id={errorId} role="alert" className="text-xs text-danger">
                  {error}
                </p>
              )}
              <button
                type="button"
                onClick={applyCustom}
                className="focus-ring w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                Apply
              </button>
            </div>
          </div>
        )}
      </div>

      {!hideCompare && (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={selection.compare}
            onChange={(e) => setCompare(e.target.checked)}
            className="accent-accent"
          />
          <span>
            Compare to previous period
            {selection.compare && (
              <span className="hidden text-text-secondary/70 md:inline"> ({range.prevLabel})</span>
            )}
          </span>
        </label>
      )}
    </div>
  );
}
