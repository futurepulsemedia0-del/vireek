import type { ReactNode } from 'react';

interface KpiStatCardProps {
  label: string;
  value: string | number;
  hint?: string;
  /** Usually a <DeltaBadge />; null/undefined when comparison is off. */
  badge?: ReactNode;
  /** True while a refetch is in flight: keeps the last numbers visible but dimmed. */
  loading?: boolean;
}

/** Stat tile with an optional comparison badge, used by the Marketing overview. */
export function KpiStatCard({ label, value, hint, badge, loading = false }: KpiStatCardProps) {
  return (
    <div
      aria-busy={loading || undefined}
      className={`rounded-xl border border-border bg-bg-secondary p-5 transition-opacity ${loading ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-text-secondary">{label}</p>
        {badge}
      </div>
      <p className="mt-2 text-2xl font-bold tabular-nums text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary/70">{hint}</p>}
    </div>
  );
}

export function KpiStatCardSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-5" aria-hidden="true">
      <div className="h-4 w-28 animate-pulse rounded bg-bg-tertiary" />
      <div className="mt-3 h-7 w-16 animate-pulse rounded bg-bg-tertiary" />
      <div className="mt-2 h-3 w-32 animate-pulse rounded bg-bg-tertiary" />
    </div>
  );
}
