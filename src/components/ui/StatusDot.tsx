export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'live';

const DOT: Record<StatusTone, string> = {
  neutral: 'bg-text-muted',
  success: 'bg-success-500',
  warning: 'bg-warning-500',
  danger: 'bg-danger',
  // "live" = copper, reserved for live/urgent states. Falls back to the CTA fill token.
  live: 'bg-cta',
};

interface StatusDotProps {
  tone?: StatusTone;
  /** Visible text. Colour is never the only carrier of meaning. */
  label: string;
  className?: string;
}

/** 6px dot + text label. Replaces pill badges in tables and lists. */
export function StatusDot({ tone = 'neutral', label, className = '' }: StatusDotProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs text-text-secondary ${className}`}>
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${DOT[tone]}`} />
      {label}
    </span>
  );
}
