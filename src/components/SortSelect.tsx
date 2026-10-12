import { ArrowDown, ArrowUp } from 'lucide-react';
import type { SortDir, ViewSort } from '@/lib/viewSort';

export interface SortOption {
  key: string;
  label: string;
  /** Direction used when this key is first picked (dates usually want 'desc'). */
  defaultDir?: SortDir;
}

interface SortSelectProps {
  value: ViewSort | null;
  options: readonly SortOption[];
  onChange: (next: ViewSort | null) => void;
}

/** Compact "sort by" control: key select + asc/desc toggle. `null` = the page's natural order. */
export function SortSelect({ value, options, onChange }: SortSelectProps) {
  const handleKey = (key: string) => {
    if (!key) return onChange(null);
    const opt = options.find((o) => o.key === key);
    onChange({ key, dir: value?.key === key ? value.dir : (opt?.defaultDir ?? 'asc') });
  };

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={value?.key ?? ''}
        onChange={(e) => handleKey(e.target.value)}
        aria-label="Sort by"
        className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary"
      >
        <option value="">Default order</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!value}
        onClick={() => value && onChange({ key: value.key, dir: value.dir === 'asc' ? 'desc' : 'asc' })}
        aria-label={value?.dir === 'desc' ? 'Sorted descending, switch to ascending' : 'Sorted ascending, switch to descending'}
        className="focus-ring rounded-xl border border-border bg-bg-secondary p-2.5 text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
      >
        {value?.dir === 'desc' ? <ArrowDown size={15} /> : <ArrowUp size={15} />}
      </button>
    </div>
  );
}
