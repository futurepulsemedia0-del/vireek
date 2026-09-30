import { toggleInArray, type TagOption } from '@/lib/capacityLiquidity';

interface TagToggleGroupProps {
  label: string;
  options: TagOption[];
  value: string[];
  onChange: (next: string[]) => void;
  helperText?: string;
}

/** Multi-select pill group. Shared by the capability profile and job requirements. */
export function TagToggleGroup({ label, options, value, onChange, helperText }: TagToggleGroupProps) {
  return (
    <div role="group" aria-label={label}>
      <p className="mb-2 text-sm font-medium text-text-primary">{label}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const active = value.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(toggleInArray(value, o.value))}
              className={`focus-ring rounded-full border px-3 py-1.5 text-sm transition-colors ${
                active
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-text-secondary hover:border-accent/40'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {helperText && <p className="mt-1.5 text-xs text-text-secondary">{helperText}</p>}
    </div>
  );
}
