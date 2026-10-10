import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/Skeleton';

/** Card shell shared by every section of the job detail page. */
export function JobSection({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          {Icon && <Icon size={15} className="text-text-secondary" aria-hidden="true" />}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function SectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function SectionError({ message = 'Could not load this section.', onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
      <span>{message}</span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function Row({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary p-3 ${className}`}>
      {children}
    </div>
  );
}

export function Pill({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${className}`}>
      {children}
    </span>
  );
}

/** State of one independently-loaded section of the page. */
export interface SectionState<T> {
  data: T;
  loading: boolean;
  error: boolean;
  reload: () => void;
}
