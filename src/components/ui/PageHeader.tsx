import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  /** One line of context: date range, location, "Updated 2 min ago". Never a marketing tagline. */
  context?: ReactNode;
  /** The single primary action for the page (a <Button variant="primary">). */
  primaryAction?: ReactNode;
  /** Secondary controls: date range, density toggle, saved views. */
  controls?: ReactNode;
  className?: string;
}

/** Quiet page header: title + context left, controls and ONE primary action right. */
export function PageHeader({ title, context, primaryAction, controls, className = '' }: PageHeaderProps) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-4 ${className}`}>
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold tracking-tight text-text-primary">{title}</h1>
        {context && <p className="mt-0.5 text-xs text-text-secondary">{context}</p>}
      </div>
      {(controls || primaryAction) && (
        <div className="flex flex-wrap items-center gap-2">
          {controls}
          {primaryAction}
        </div>
      )}
    </div>
  );
}
