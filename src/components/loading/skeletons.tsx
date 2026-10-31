import type { CSSProperties } from 'react';
import './loading.css';

/**
 * Layout-matching skeleton family. Every shape has FIXED heights so swapping to real
 * content causes no layout shift: pass `className` (height/width) to match your page.
 * Decorative: the owning <LoadingBoundary> supplies the status text.
 */
interface BlockProps {
  className?: string;
  /** Stagger index (80ms per step). */
  index?: number;
}

export function SkeletonBlock({ className = '', index = 0 }: BlockProps) {
  return (
    <div
      aria-hidden="true"
      className={`vrk-skel rounded-md bg-bg-tertiary ${className}`.trim()}
      style={{ '--vrk-i': index } as CSSProperties}
    />
  );
}

const shell = 'rounded-2xl border border-border bg-bg-secondary';

export function CardSkeleton({ rows = 2, className = '' }: { rows?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={`${shell} p-6 ${className}`.trim()}>
      <div className="flex items-start gap-3">
        <SkeletonBlock className="h-10 w-10 shrink-0 rounded-xl" />
        <div className="flex-1 space-y-2">
          <SkeletonBlock index={1} className="h-4 w-40" />
          <SkeletonBlock index={2} className="h-3 w-64 max-w-full" />
        </div>
      </div>
      <div className="mt-4 space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <SkeletonBlock key={i} index={i + 3} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

export function KpiSkeleton({ className = '' }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`${shell} p-5 ${className}`.trim()}>
      <SkeletonBlock className="h-3 w-24" />
      <SkeletonBlock index={1} className="mt-3 h-8 w-32" />
      <SkeletonBlock index={2} className="mt-3 h-3 w-20" />
    </div>
  );
}

const BAR_HEIGHTS = [45, 70, 55, 85, 60, 95, 50, 75, 65, 90, 58, 80] as const;

export function ChartSkeleton({ className = 'h-64' }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`${shell} flex items-end gap-2 p-5 ${className}`.trim()}>
      {BAR_HEIGHTS.map((h, i) => (
        <div key={i} className="flex h-full flex-1 items-end">
          <div className="w-full" style={{ height: `${h}%` }}>
            <SkeletonBlock index={i} className="h-full w-full rounded-t-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ListRowSkeleton({ count = 5, className = '' }: { count?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={`divide-y divide-border ${shell} ${className}`.trim()}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <SkeletonBlock index={i} className="h-9 w-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <SkeletonBlock index={i + 1} className="h-3.5 w-1/3" />
            <SkeletonBlock index={i + 2} className="h-3 w-2/3" />
          </div>
          <SkeletonBlock index={i + 1} className="h-6 w-16 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 4, className = '' }: { rows?: number; cols?: number; className?: string }) {
  const grid: CSSProperties = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };
  return (
    <div aria-hidden="true" className={`overflow-hidden ${shell} ${className}`.trim()}>
      <div className="grid gap-4 border-b border-border bg-bg-tertiary/50 px-4 py-3" style={grid}>
        {Array.from({ length: cols }, (_, c) => (
          <SkeletonBlock key={c} index={c} className="h-3 w-20" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="grid gap-4 border-b border-border px-4 py-3.5 last:border-b-0" style={grid}>
          {Array.from({ length: cols }, (_, c) => (
            <SkeletonBlock key={c} index={r + c} className="h-4 w-4/5" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function FormSkeleton({ fields = 4, className = '' }: { fields?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={`${shell} space-y-5 p-6 ${className}`.trim()}>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="space-y-2">
          <SkeletonBlock index={i} className="h-3 w-28" />
          <SkeletonBlock index={i + 1} className="h-11 w-full rounded-xl" />
        </div>
      ))}
      <SkeletonBlock index={fields} className="h-11 w-32 rounded-xl" />
    </div>
  );
}

/** Alternating caller / Sarah lines. `self-start`/`self-end` are RTL-safe. */
export function TranscriptSkeleton({ turns = 5, className = '' }: { turns?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={`flex flex-col gap-3 ${shell} p-5 ${className}`.trim()}>
      {Array.from({ length: turns }, (_, i) => (
        <div key={i} className={`flex w-3/4 max-w-full flex-col gap-1.5 ${i % 2 ? 'self-end' : 'self-start'}`}>
          <SkeletonBlock index={i} className="h-3 w-16" />
          <SkeletonBlock index={i + 1} className="h-10 w-full rounded-xl" />
        </div>
      ))}
    </div>
  );
}
