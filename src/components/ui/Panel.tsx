import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

/**
 * Static container for the dashboard. 1px hairline border, no shadow, 8–12px radius.
 * Shadows are reserved for popovers/menus/modals (see docs/design/dashboard-principles.md).
 * Use <Card> only for marketing/interactive tiles; use <Panel> for dashboard content.
 */
interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Section title rendered in the panel header (sentence case, already translated). */
  title?: ReactNode;
  /** Right-aligned header content: a link, a segmented control, a count. */
  actions?: ReactNode;
  /** Remove body padding for tables/lists that run edge to edge. */
  flush?: boolean;
  as?: 'section' | 'div' | 'aside';
}

export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel(
  { title, actions, flush = false, as: Tag = 'section', className = '', children, ...rest },
  ref,
) {
  return (
    <Tag
      ref={ref as never}
      className={`rounded-lg border border-border bg-bg-secondary ${className}`}
      {...rest}
    >
      {(title || actions) && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-4">
          {title && <h2 className="text-[13px] font-medium text-text-primary">{title}</h2>}
          {actions && <div className="flex items-center gap-2 text-xs text-text-secondary">{actions}</div>}
        </header>
      )}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </Tag>
  );
});
