import type { ReactNode } from 'react';

interface EmptyNoteProps {
  /** One useful sentence, already translated. */
  children: ReactNode;
  /** One action at most. */
  action?: { label: string; onClick: () => void };
  className?: string;
}

/** Quiet, left-aligned empty state: one sentence and (optionally) one action. No icon, no dashed box. */
export function EmptyNote({ children, action, className = '' }: EmptyNoteProps) {
  return (
    <div className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3 text-[13px] text-text-secondary ${className}`}>
      <p>{children}</p>
      {action && (
        <button type="button" onClick={action.onClick} className="focus-ring rounded text-[13px] font-medium text-accent hover:underline">
          {action.label}
        </button>
      )}
    </div>
  );
}
