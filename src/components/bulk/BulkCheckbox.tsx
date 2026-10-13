import { useEffect, useRef } from 'react';
import type { CheckState } from '@/lib/bulk/selection';

interface BulkCheckboxProps {
  state: CheckState;
  label: string;
  /** shiftKey is forwarded so callers can do range selection. */
  onToggle: (shiftKey: boolean) => void;
  className?: string;
}

/**
 * Row / header checkbox. Clicks never bubble (rows are clickable and open
 * drawers), shift-click is captured, and the hit area is enlarged for touch.
 */
export function BulkCheckbox({ state, label, onToggle, className = '' }: BulkCheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);

  return (
    <span
      className={`-m-2 inline-flex select-none p-2 ${className}`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault(); // stop the browser's text-range selection on shift-click
      }}
    >
      <input
        ref={ref}
        type="checkbox"
        aria-label={label}
        checked={state === 'all'}
        onChange={() => undefined}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(e.shiftKey);
        }}
        className="focus-ring h-4 w-4 cursor-pointer rounded border-border accent-[var(--color-accent,#2563eb)]"
      />
    </span>
  );
}
