import { motion } from 'framer-motion';

// ============================================================
// Base skeleton primitive
// ============================================================

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

// ============================================================
// Skeleton for a SectionCard-style block
// (mirrors the shape used across BusinessProfilePage, Dashboard, etc.)
// ============================================================

interface SkeletonCardProps {
  /** Number of skeleton "field" rows to render inside the card. */
  rows?: number;
  /** Whether to show a leading icon-sized square, like SectionCard's icon slot. */
  withIcon?: boolean;
  className?: string;
}

export function SkeletonCard({ rows = 2, withIcon = true, className = '' }: SkeletonCardProps) {
  return (
    <div
      className={`rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark ${className}`}
    >
      <div className="flex items-start gap-3">
        {withIcon && <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />}
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
      </div>
      <div className="mt-4 space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

// ============================================================
// A page-level list of skeleton cards
// Usage: <SkeletonCardList count={4} />
// ============================================================

interface SkeletonCardListProps {
  count?: number;
  rows?: number;
  className?: string;
}

export function SkeletonCardList({ count = 4, rows = 2, className = '' }: SkeletonCardListProps) {
  return (
    <div className={`space-y-6 ${className}`}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} rows={rows} />
      ))}
    </div>
  );
}

// ============================================================
// Skeleton for table/list rows (e.g. Calls, Jobs, Leads tables)
// ============================================================

interface SkeletonRowProps {
  columns?: number;
  className?: string;
}

export function SkeletonRow({ columns = 4, className = '' }: SkeletonRowProps) {
  return (
    <div className={`flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0 ${className}`}>
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton key={i} className={`h-4 ${i === 0 ? 'w-1/4' : 'flex-1'}`} />
      ))}
    </div>
  );
}

interface SkeletonTableProps {
  rows?: number;
  columns?: number;
  className?: string;
}

export function SkeletonTable({ rows = 6, columns = 4, className = '' }: SkeletonTableProps) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} columns={columns} />
      ))}
    </div>
  );
}

// ============================================================
// Skeleton for small stat/metric cards (e.g. dashboard KPI tiles)
// ============================================================

interface SkeletonStatCardProps {
  className?: string;
}

export function SkeletonStatCard({ className = '' }: SkeletonStatCardProps) {
  return (
    <div className={`rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark ${className}`}>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-7 w-16" />
      <Skeleton className="mt-2 h-3 w-32" />
    </div>
  );
}

interface SkeletonStatGridProps {
  count?: number;
  className?: string;
}

export function SkeletonStatGrid({ count = 4, className = '' }: SkeletonStatGridProps) {
  return (
    <div className={`grid grid-cols-2 gap-4 md:grid-cols-4 ${className}`}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonStatCard key={i} />
      ))}
    </div>
  );
}

// ============================================================
// Optional fade-in wrapper — use once real content replaces skeletons
// so the swap doesn't feel abrupt.
// ============================================================

export function FadeIn({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
