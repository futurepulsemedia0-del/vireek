import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';

export interface ColumnOption {
  key: string;
  label: string;
}

interface ColumnPickerProps {
  options: readonly ColumnOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}

/** Dropdown of checkboxes for choosing which optional table columns are visible. */
export function ColumnPicker({ options, selected, onChange }: ColumnPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (key: string) => {
    const next = selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
    // Keep the canonical column order regardless of click order.
    onChange(options.map((o) => o.key).filter((k) => next.includes(k)));
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        className="focus-ring flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary"
      >
        <SlidersHorizontal size={15} /> Columns
      </button>
      {open && (
        <div role="group" aria-label="Visible columns" className="absolute right-0 top-full z-20 mt-2 w-48 rounded-xl border border-border bg-bg-secondary p-2 shadow-card-hover dark:shadow-card-hover-dark">
          {options.map((o) => (
            <label key={o.key} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text-primary hover:bg-bg-tertiary">
              <input type="checkbox" checked={selected.includes(o.key)} onChange={() => toggle(o.key)} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
