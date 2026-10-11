import { useTaxClasses } from '@/hooks/useTaxClasses';

interface Props {
  value: string | null | undefined;
  onChange: (code: string | undefined) => void;
  className?: string;
}

/** Per-line tax class picker. Empty value = "General" (taxable, same as before this feature). */
export function TaxClassSelect({ value, onChange, className = '' }: Props) {
  const { classes, loading } = useTaxClasses();
  if (!loading && classes.length === 0) return null;

  return (
    <select
      aria-label="Tax class"
      title="Tax class"
      value={value ?? ''}
      disabled={loading}
      onChange={(e) => onChange(e.target.value || undefined)}
      className={`focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary ${className}`}
    >
      <option value="">General</option>
      {classes
        .filter((c) => c.code !== 'general')
        .map((c) => (
          <option key={c.id} value={c.code}>
            {c.name}
          </option>
        ))}
    </select>
  );
}
