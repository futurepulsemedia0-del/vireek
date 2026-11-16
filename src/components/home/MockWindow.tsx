import type { ReactNode } from 'react';
import { exampleChip } from './sectionStyles';

/** Row style shared by every code-built product mockup. */
export const mockRow =
  'flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-secondary px-3 py-2';

/** Neutral status pill used inside mockups. */
export const mockChip =
  'inline-flex items-center rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-[0.6875rem] font-semibold text-text-primary';

interface MockWindowProps {
  title: string;
  /** Visible "Example" label, already translated. */
  exampleLabel: string;
  /** Accessible description prefix, already translated. */
  ariaLabel: string;
  children: ReactNode;
}

/**
 * A product-UI illustration built from markup (no images, no layout shift).
 * Always labelled as an example and always filled with made-up data.
 */
export function MockWindow({ title, exampleLabel, ariaLabel, children }: MockWindowProps) {
  return (
    <div
      role="img"
      aria-label={`${ariaLabel}: ${title}`}
      className="overflow-hidden rounded-xl border border-border bg-bg-primary text-start shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-tertiary px-3 py-2.5">
        <span className="text-xs font-semibold text-text-primary">{title}</span>
        <span className={exampleChip}>{exampleLabel}</span>
      </div>
      <div className="space-y-2 p-3 text-xs text-text-secondary" aria-hidden="true">
        {children}
      </div>
    </div>
  );
}
