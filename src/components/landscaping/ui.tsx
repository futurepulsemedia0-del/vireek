import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';

export const cents = (n: number) => (n / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });

/** Local calendar date as YYYY-MM-DD (not UTC: a crew in Chicago at 8pm is still “today”). */
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
export const dayLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

export const dollarsToCents = (v: string): number => Math.max(0, Math.round(Number(v || 0) * 100));
export const centsToDollars = (c: number): string => (c / 100).toFixed(2);

/** Loading / error / empty / content wrapper so every panel shows all four states the same way. */
export function PanelState({
  loading,
  error,
  empty,
  emptyTitle,
  emptyDescription,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyTitle: string;
  emptyDescription?: string;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (loading && empty) return <div aria-busy="true" aria-live="polite"><SkeletonCard rows={3} /></div>;
  if (error && empty) return <EmptyState variant="load-failed" title="Could not load this section" description={error} onRetry={onRetry} />;
  return (
    <>
      {error && (
        <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" aria-hidden="true" />{error}</span>
          <Button size="xs" variant="secondary" onClick={onRetry}>Retry</Button>
        </div>
      )}
      {empty ? <EmptyState title={emptyTitle} description={emptyDescription} compact /> : children}
    </>
  );
}

export function Section({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-text-primary">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-text-secondary">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </Card>
  );
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
