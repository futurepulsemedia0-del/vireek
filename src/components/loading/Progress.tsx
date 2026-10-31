import './loading.css';

interface ProgressProps {
  /** Real percentage 0..100. null/undefined = indeterminate. Never invent a value. */
  value?: number | null;
  /** Accessible name, e.g. "Uploading invoices". */
  label: string;
  /** Show the percentage next to the bar (determinate only). */
  showValue?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function Progress({ value, label, showValue = false, size = 'md', className = '' }: ProgressProps) {
  const determinate = typeof value === 'number' && Number.isFinite(value);
  const pct = determinate ? Math.min(100, Math.max(0, Math.round(value))) : 0;
  return (
    <div className={`flex items-center gap-3 ${className}`.trim()}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? pct : undefined}
        aria-valuetext={determinate ? `${pct}%` : undefined}
        className={`vrk-progress__track w-full ${size === 'sm' ? 'h-1' : 'h-1.5'}`}
      >
        <div
          className={determinate ? 'vrk-fill' : 'vrk-fill vrk-fill--ind vrk-anim'}
          style={determinate ? { transform: `scaleX(${pct / 100})` } : undefined}
        />
      </div>
      {determinate && showValue && (
        <span aria-hidden="true" className="w-10 shrink-0 text-end text-xs tabular-nums text-text-secondary">
          {pct}%
        </span>
      )}
    </div>
  );
}
